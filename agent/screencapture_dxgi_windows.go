package main

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"runtime"
	"time"

	"github.com/kirides/go-d3d/d3d11"
	"github.com/kirides/go-d3d/outputduplication"
)

// screencapture_dxgi_windows.go — captura de tela via DXGI Desktop
// Duplication API (github.com/kirides/go-d3d), achado 29/10/2026 depois de
// 3 fixes incrementais no GDI clássico (v1.6.3/1.6.5/1.6.6) não resolverem
// o GetDIBits falhando num driver NVIDIA antigo (Daniela-Esc, GPU dupla).
// DXGI é a mesma API que o AnyDesk usa (já instalado nessa mesma máquina,
// funciona sem problema) — desenhada especificamente pra captura de tela
// contínua, não um reaproveitamento de API de desenho genérica como GDI.
//
// outputDuplicator isola o subconjunto de *outputduplication.OutputDuplicator
// que usamos — permite testar CaptureJPEG/recreateDuplicator com um fake,
// sem D3D11/DXGI real (mesmo padrão de frameWriter/messageReader em
// livesession_windows.go).
type outputDuplicator interface {
	GetImage(img *image.RGBA, timeoutMs uint) error
	GetBounds() (image.Rectangle, error)
	Release()
}

// dxgiCaptureTimeoutMs é o timeout do AcquireNextFrame (dentro de GetImage),
// NÃO o intervalo entre frames enviados — esse já é governado pelo
// time.Ticker de runLiveSessionLoop (liveSessionFrameIntervalMs, 100ms a
// 10fps). É DELIBERADAMENTE pequeno (bem menor que os 100ms do ticker):
// o exemplo oficial da lib (examples/mjpegstream) usa um timeout de 999ms
// porque o loop DELE é só governado pelo próprio GetImage bloqueando até
// ter frame novo — no nosso caso, se usássemos um timeout parecido, uma
// tela ESTÁTICA (sem mudança, caso comum) faria GetImage bloquear quase
// 1s por tentativa, atrasando o próximo tick do ticker e derrubando a
// cadência real de 10fps pra ~1fps. Um timeout curto aqui garante que
// ErrNoImageYet (tela estática) retorna rápido, deixando o ticker — não o
// timeout do DXGI — ser quem de fato governa o fps.
const dxgiCaptureTimeoutMs = 16

// dxgiRecreateMinInterval evita martelar D3D11CreateDevice/EnumOutputs a
// 10Hz se o driver ficar num estado permanentemente ruim (ex.: resolução
// mudando repetidamente, ou a causa real do ACCESS_LOST persistir) — achado
// da revisão de código desta migração (risco de busy-loop sem throttle,
// mesma categoria de cautela que motivou o throttle de log em
// sendLiveSessionFrame).
const dxgiRecreateMinInterval = 1 * time.Second

type dxgiScreenCapturer struct {
	device    *d3d11.ID3D11Device
	deviceCtx *d3d11.ID3D11DeviceContext
	ddup      outputDuplicator
	bounds    image.Rectangle
	imgBuf    *image.RGBA

	// newDuplicatorFn cria uma nova duplication reusando device/deviceCtx —
	// extraído de recreateDuplicator (em vez de chamar
	// outputduplication.NewIDXGIOutputDuplication direto) só pra permitir
	// testar o throttle/fluxo de recriação com um fake, sem D3D11/DXGI real
	// (mesmo padrão de newDXGIScreenCapturerFn em
	// screencapture_backend_windows.go). Setado em newDXGIScreenCapturer.
	newDuplicatorFn func() (outputDuplicator, error)

	// gotFirstFrame marca se já chegou pelo menos 1 frame real desde que
	// este capturer foi criado — achado da revisão de código desta migração:
	// sem isso, um ErrNoImageYet na 1ª chamada (desktop estático logo no
	// início da sessão) reusaria imgBuf ainda zerado (preto) do construtor,
	// uma tela preta disfarçada de "sucesso" — exatamente a classe de bug
	// que motivou toda esta migração (Daniela-Esc). Ver CaptureJPEG.
	gotFirstFrame bool

	// closed faz Close() idempotente — achado da revisão: sem isso, uma 2ª
	// chamada a Close() (ex.: defer duplicado por engano numa edição futura)
	// re-liberaria os mesmos objetos COM (undefined behavior/crash).
	closed bool

	lastRecreateAttempt time.Time
	lastRecreateErr     error
}

// newDXGIScreenCapturer cria o device D3D11 + a duplication, mantidos vivos
// pelo resto do ciclo de vida do capturer (ver Close) — ao contrário do GDI
// (captureScreenJPEG), que recria todo o contexto a cada chamada.
//
// LockOSThread aqui, 1x pro ciclo de vida INTEIRO (não por frame, diferente
// do padrão LockOSThread-por-chamada que clearLastError/captureScreenJPEG
// usam no GDI) — D3D11/DXGI esperam rodar numa thread fixa (mesmo padrão do
// exemplo oficial da lib). Quem chama newDXGIScreenCapturer DEVE ser a MESMA
// goroutine que depois chama CaptureJPEG/Close — nunca espalhar entre
// goroutines, quebra essa premissa sem nenhum erro Go (mesma classe de bug
// sutil já vista com GetLastError no GDI). Hoje só runLiveSessionLoop (via
// newScreenCapturerFn) e captureOneScreenshotJPEG chamam isto, cada um
// dentro de uma única goroutine dedicada — ver livesession_windows.go e
// screencapture_backend_windows.go.
func newDXGIScreenCapturer() (*dxgiScreenCapturer, error) {
	runtime.LockOSThread()

	device, deviceCtx, err := d3d11.NewD3D11Device()
	if err != nil {
		runtime.UnlockOSThread()
		return nil, fmt.Errorf("d3d11.NewD3D11Device: %w", err)
	}
	// cleanup libera o que já foi criado até aqui e destrava a thread —
	// usado em todo caminho de erro abaixo. Extraído na revisão de código
	// desta migração: os 3 caminhos de erro repetiam o mesmo bloco
	// verbatim, risco real de uma edição futura esquecer de liberar 1 deles.
	cleanup := func(d outputDuplicator) {
		if d != nil {
			d.Release()
		}
		deviceCtx.Release()
		device.Release()
		runtime.UnlockOSThread()
	}

	// output index 0 = monitor primário — mesma limitação já aceita pro
	// GDI (captureScreenJPEG), não é regressão desta migração.
	realDdup, err := outputduplication.NewIDXGIOutputDuplication(device, deviceCtx, 0)
	if err != nil {
		cleanup(nil)
		return nil, fmt.Errorf("outputduplication.NewIDXGIOutputDuplication: %w", err)
	}

	bounds, err := realDdup.GetBounds()
	if err != nil {
		cleanup(realDdup)
		return nil, fmt.Errorf("ddup.GetBounds: %w", err)
	}
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		cleanup(realDdup)
		return nil, fmt.Errorf("outputduplication: bounds inválidos %v", bounds)
	}

	c := &dxgiScreenCapturer{
		device:    device,
		deviceCtx: deviceCtx,
		ddup:      realDdup, // só atribuído à interface depois de confirmado não-nil — evita o typed-nil-in-interface clássico de Go
		bounds:    bounds,
		imgBuf:    image.NewRGBA(bounds),
	}
	c.newDuplicatorFn = func() (outputDuplicator, error) {
		// nunca "return outputduplication.NewIDXGIOutputDuplication(...)" direto:
		// no erro ela devolve um *OutputDuplicator nil tipado, que embrulhado
		// na interface outputDuplicator viraria um não-nil com valor nil
		// (typed-nil-in-interface) — mesmo cuidado de newDXGIScreenCapturerReal.
		d, err := outputduplication.NewIDXGIOutputDuplication(c.device, c.deviceCtx, 0)
		if err != nil {
			return nil, err
		}
		return d, nil
	}
	return c, nil
}

func (c *dxgiScreenCapturer) CaptureJPEG(quality int) ([]byte, error) {
	err := c.ddup.GetImage(c.imgBuf, dxgiCaptureTimeoutMs)
	switch {
	case err == nil:
		c.gotFirstFrame = true

	case errors.Is(err, outputduplication.ErrNoImageYet) && c.gotFirstFrame:
		// Desktop estático (nenhuma mudança desde o frame anterior) — não é
		// erro real, imgBuf já tem o último frame válido, reusa.

	case errors.Is(err, outputduplication.ErrNoImageYet):
		// Ainda não chegou NENHUM frame de verdade nesta sessão — reusar
		// agora devolveria o buffer zerado (preto) alocado no construtor,
		// uma tela preta disfarçada de sucesso (achado da revisão de código
		// desta migração — exatamente a classe de bug que motivou toda a
		// migração). Tratar como falha transitória explícita, já absorvida
		// por sendLiveSessionFrame (mesmo tratamento de qualquer outra
		// falha de captura).
		return nil, fmt.Errorf("captura DXGI: ainda sem nenhum frame desde o início da sessão (%w)", err)

	default:
		// Erro real — tipicamente resolução mudou (DXGI_ERROR_ACCESS_LOST)
		// ou o driver entrou num estado ruim. Recria o duplicator pro
		// PRÓXIMO frame; esta chamada em si retorna erro (frame
		// perdido), já absorvido como falha transitória por
		// sendLiveSessionFrame (livesession_windows.go) — mesmo
		// tratamento de qualquer outra falha de captura, sem lógica
		// especial necessária ali.
		if rerr := c.recreateDuplicator(); rerr != nil {
			return nil, fmt.Errorf("captura DXGI falhou (%v) e recriar o duplicator também falhou: %w", err, rerr)
		}
		// Mensagem deliberadamente neutra (não afirma "recriado agora"):
		// dentro do throttle (dxgiRecreateMinInterval), recreateDuplicator
		// pode devolver nil sem ter tentado nada de novo — só reusou
		// c.lastRecreateErr cacheado de uma tentativa anterior. Achado da
		// revisão de código desta migração (passada 2): uma mensagem
		// afirmando "recriado" nesse caso enganaria diagnóstico de frota.
		return nil, fmt.Errorf("captura DXGI falhou, tentando recuperar pro próximo frame: %w", err)
	}

	var out bytes.Buffer
	if err := jpeg.Encode(&out, c.imgBuf, &jpeg.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("jpeg.Encode: %w", err)
	}
	return out.Bytes(), nil
}

// recreateDuplicator libera a duplication atual e recria, reusando o MESMO
// device/deviceCtx (não recriar o device inteiro — só a duplication precisa
// ser refeita quando a resolução muda ou a sessão de duplicação é perdida).
// Realoca imgBuf se os bounds mudaram.
func (c *dxgiScreenCapturer) recreateDuplicator() error {
	now := time.Now()
	if !c.lastRecreateAttempt.IsZero() && now.Sub(c.lastRecreateAttempt) < dxgiRecreateMinInterval {
		return c.lastRecreateErr
	}
	c.lastRecreateAttempt = now

	// Só libera o duplicator ANTIGO depois que o NOVO está pronto e
	// confirmado (GetBounds ok) — nunca deixa c.ddup num estado nil no meio
	// do caminho. Achado CRÍTICO da revisão de código desta migração: a
	// versão anterior zerava c.ddup aqui, antes de newDuplicatorFn/GetBounds
	// serem chamados; se qualquer um deles falhasse, a função retornava com
	// c.ddup == nil, e a PRÓXIMA CaptureJPEG chamava GetImage numa interface
	// nil → panic. O panic ocorria dentro da goroutine de
	// runLiveSessionLoop ANTES do cleanup que remove a sessão do mapa
	// liveSessions, deixando o sessionId travado "já ativa" até reiniciar
	// o serviço (ver agent.go/livesession_windows.go).
	newDdup, err := c.newDuplicatorFn()
	if err != nil {
		c.lastRecreateErr = fmt.Errorf("outputduplication.NewIDXGIOutputDuplication: %w", err)
		return c.lastRecreateErr
	}

	bounds, err := newDdup.GetBounds()
	if err != nil {
		newDdup.Release()
		c.lastRecreateErr = fmt.Errorf("ddup.GetBounds: %w", err)
		return c.lastRecreateErr
	}

	if c.ddup != nil {
		c.ddup.Release()
	}
	c.ddup = newDdup
	if bounds != c.bounds {
		c.bounds = bounds
		c.imgBuf = image.NewRGBA(bounds)
	}
	c.lastRecreateErr = nil
	return nil
}

func (c *dxgiScreenCapturer) Bounds() (width, height int) {
	return c.bounds.Dx(), c.bounds.Dy()
}

// Close libera device/deviceCtx/ddup e destrava a thread (ver
// newDXGIScreenCapturer) — precisa ser chamado pela MESMA goroutine que
// criou o capturer.
func (c *dxgiScreenCapturer) Close() {
	if c.closed {
		return
	}
	c.closed = true
	if c.ddup != nil {
		c.ddup.Release()
		c.ddup = nil
	}
	if c.deviceCtx != nil {
		c.deviceCtx.Release()
		c.deviceCtx = nil
	}
	if c.device != nil {
		c.device.Release()
		c.device = nil
	}
	runtime.UnlockOSThread()
}

// newDXGIScreenCapturerReal adapta newDXGIScreenCapturer (que devolve
// *dxgiScreenCapturer, o tipo concreto) pra screenCapturer (interface) —
// só retorna a interface DEPOIS de confirmar err == nil, pra nunca devolver
// uma interface não-nil contendo um ponteiro concreto nil (mesmo cuidado já
// documentado em screencapture_backend_windows.go sobre newDXGIScreenCapturerFn).
func newDXGIScreenCapturerReal() (screenCapturer, error) {
	c, err := newDXGIScreenCapturer()
	if err != nil {
		return nil, err
	}
	return c, nil
}

func init() {
	newDXGIScreenCapturerFn = newDXGIScreenCapturerReal
}
