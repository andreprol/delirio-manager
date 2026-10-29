package main

import (
	"errors"
	"fmt"
	"time"
)

// screencapture_backend_windows.go concentra a decisão de QUAL mecanismo de
// captura de tela usar — DXGI Desktop Duplication (screencapture_dxgi_windows.go)
// como preferido, GDI clássico (screencapture_windows.go) como fallback.
//
// Achado 29/10/2026: GDI (BitBlt+GetDIBits) falha silenciosamente num driver
// NVIDIA antigo (Daniela-Esc, GPU dupla) mesmo depois de 3 fixes incrementais
// (v1.6.3/1.6.5/1.6.6), cada um revisado e cada revisão achando um bug real
// adicional. Decisão do André: migrar pra DXGI (mesma API que o AnyDesk usa,
// já instalado nas mesmas máquinas e funcionando "de cara"), com GDI mantido
// como fallback automático — nenhuma máquina que já funciona hoje pode
// regredir, mesmo que DXGI falhe ou seja incompatível nalgum hardware.
type screenCapturer interface {
	CaptureJPEG(quality int) ([]byte, error)
	// Bounds devolve o tamanho real da tela que este capturer está
	// transmitindo — usado só pela checagem de newScreenCapturer (abaixo),
	// nunca por injectMouseMove (que continua em screenDimensions() direto,
	// ver comentário em newScreenCapturer).
	Bounds() (width, height int)
	Close()
}

// gdiScreenCapturer embrulha o GDI existente (captureScreenJPEG,
// screencapture_windows.go) na interface screenCapturer — sem nenhuma
// mudança de comportamento, só adaptação. GDI é stateless (cria e destrói
// todo o contexto a cada chamada), então Close() não tem nada a liberar.
type gdiScreenCapturer struct{}

func (gdiScreenCapturer) CaptureJPEG(quality int) ([]byte, error) {
	return captureScreenJPEGFn(quality)
}

func (gdiScreenCapturer) Bounds() (width, height int) {
	w, h, err := screenDimensions()
	if err != nil {
		return 0, 0
	}
	return int(w), int(h)
}

func (gdiScreenCapturer) Close() {}

// newDXGIScreenCapturerFn é var (não função fixa) pra ser mockável em teste
// e pra permitir trocar a implementação em 2 passos (ver ordem de execução
// do plano desta migração): começa apontando pro stub abaixo (sempre
// falha — todo mundo cai pro GDI, zero mudança de comportamento real),
// screencapture_dxgi_windows.go troca pra implementação de verdade.
//
// Assinatura devolve screenCapturer (interface), não *dxgiScreenCapturer
// (ponteiro concreto) — propositalmente, pra nunca correr o risco clássico
// de Go de devolver uma interface não-nil contendo um ponteiro nil quando
// newDXGIScreenCapturer() falha (erra != nil mas o *dxgiScreenCapturer typed
// nil ainda tornaria a interface != nil pro chamador).
var newDXGIScreenCapturerFn = newDXGIScreenCapturerStub

func newDXGIScreenCapturerStub() (screenCapturer, error) {
	return nil, errors.New("captura DXGI ainda não implementada neste build")
}

// newScreenCapturer escolhe o backend de captura: tenta DXGI primeiro, cai
// pro GDI em qualquer falha (criação ou bounds mismatch) — nunca propaga
// erro pro chamador, o pior caso sempre converge pro GDI já validado em
// produção. backend (retorno) é só pra log/observabilidade (ver
// runLiveSessionLoop) — saber, nas 130 máquinas, quantas usam DXGI de
// verdade vs. caem pro fallback.
func newScreenCapturer() (capturer screenCapturer, backend string) {
	return newScreenCapturerWithGDIBounds((gdiScreenCapturer{}).Bounds)
}

// newScreenCapturerWithGDIBounds recebe a função de bounds do GDI como
// parâmetro (em vez de chamar gdiScreenCapturer{}.Bounds()/screenDimensions()
// direto) só pra permitir testar o caminho de bounds-mismatch com um valor
// controlado, sem tocar em gdi_windows.go (screenDimensions() não é
// mockável lá, e não deveria virar var só por causa deste teste — é código
// de produção real, compartilhado com input_windows.go).
func newScreenCapturerWithGDIBounds(gdiBounds func() (int, int)) (capturer screenCapturer, backend string) {
	dxgiCap, err := newDXGIScreenCapturerFn()
	if err != nil {
		logWarn(fmt.Sprintf("captura: DXGI indisponível (%v) — usando GDI", err))
		return gdiScreenCapturer{}, "gdi"
	}

	// Checagem de bounds ANTES de devolver o capturer pro chamador — nunca
	// depois de já ter transmitido frames. injectMouseMove (input_windows.go)
	// continua normalizando cliques contra screenDimensions() (GDI) sem
	// nenhuma mudança; se o DXGI estiver enxergando uma tela de tamanho
	// diferente (ex.: pegou o output errado numa máquina com GPU dupla —
	// risco documentado no plano desta migração), o dashboard escalaria o
	// clique contra a dimensão errada e reintroduziria exatamente a classe
	// de bug (captura e clique discordando do tamanho real) que esta sessão
	// inteira de investigação já tratou no GDI. Cair pro GDI aqui garante
	// que captura e clique sempre concordam, porque GDI nunca pode divergir
	// de si mesmo.
	dxgiW, dxgiH := dxgiCap.Bounds()
	gdiW, gdiH := gdiBounds()
	if dxgiW != gdiW || dxgiH != gdiH {
		logWarn(fmt.Sprintf(
			"captura: DXGI reporta %dx%d mas a tela real (GDI) é %dx%d — usando GDI pra não desalinhar cliques",
			dxgiW, dxgiH, gdiW, gdiH))
		dxgiCap.Close()
		return gdiScreenCapturer{}, "gdi"
	}

	return dxgiCap, "dxgi"
}

// newScreenCapturerFn é var (mesmo padrão de captureScreenJPEGFn/
// startLiveSessionFn) pra ser mockável em teste.
var newScreenCapturerFn = newScreenCapturer

// captureOneScreenshotRetries/captureOneScreenshotRetryDelay: achado da
// revisão de código desta migração (passada 2) — um capturer DXGI recém-
// criado pode não ter nenhum frame pronto dentro do timeout curto
// (dxgiCaptureTimeoutMs, tunado pro ticker de 100ms da sessão viva, não pro
// comando avulso de 1 chamada só), e CaptureJPEG recusa de propósito
// devolver o buffer preto do construtor enquanto isso (ver gotFirstFrame em
// screencapture_dxgi_windows.go). Sem retry, um comando que SEMPRE
// funcionou sincronamente com GDI passaria a falhar de vez em quando com
// DXGI num desktop estático — regressão real pro operador que pede
// "capturar tela agora".
const captureOneScreenshotRetries = 5
const captureOneScreenshotRetryDelay = 20 * time.Millisecond

// captureOneScreenshotJPEG tira 1 screenshot avulso (comando
// "capture-screenshot", sem sessão ao vivo associada) — cria um capturer
// efêmero, usa 1x, fecha. Separado de runLiveSessionLoop (que cria 1
// capturer persistente por sessão inteira, ver livesession_windows.go)
// porque screenshot avulso não tem o conceito de "sessão": é uma única
// captura disparada por comando, sem estado a reaproveitar entre chamadas.
//
// Repete algumas vezes antes de desistir (ver constantes acima) e, se ainda
// assim o DXGI falhar, cai pro GDI direto só pra esta chamada — garante que
// este comando específico nunca regride vs. o comportamento 100% GDI de
// antes desta migração, mesmo que o DXGI esteja instável numa máquina.
func captureOneScreenshotJPEG(quality int) ([]byte, error) {
	capturer, backend := newScreenCapturerFn()
	defer capturer.Close()

	var lastErr error
	for i := 0; i < captureOneScreenshotRetries; i++ {
		jpegBytes, err := capturer.CaptureJPEG(quality)
		if err == nil {
			return jpegBytes, nil
		}
		lastErr = err
		if i < captureOneScreenshotRetries-1 {
			time.Sleep(captureOneScreenshotRetryDelay)
		}
	}

	if backend == "gdi" {
		// já era o fallback — recapturar de novo não ajudaria.
		return nil, lastErr
	}
	logWarn(fmt.Sprintf("captura avulsa: DXGI falhou %d vezes (%v) — tentando GDI direto", captureOneScreenshotRetries, lastErr))
	jpegBytes, err := (gdiScreenCapturer{}).CaptureJPEG(quality)
	if err != nil {
		return nil, err
	}
	return jpegBytes, nil
}
