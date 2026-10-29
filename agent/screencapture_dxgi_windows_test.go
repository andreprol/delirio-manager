package main

import (
	"errors"
	"image"
	"testing"
	"time"

	"github.com/kirides/go-d3d/outputduplication"
)

// fakeOutputDuplicator implementa outputDuplicator sem D3D11/DXGI real —
// permite testar dxgiScreenCapturer.CaptureJPEG/recreateDuplicator com os
// cenários de borda que motivaram esta migração (ErrNoImageYet, erro real,
// resolução mudando), sem GPU/desktop real (mesmo padrão de
// fakeFrameWriter/fakeScreenCapturer em livesession_windows_test.go).
type fakeOutputDuplicator struct {
	getImageErr error // se não-nil, GetImage devolve este erro sem tocar img
	getImageFn  func(img *image.RGBA) // se não-nil, roda antes de devolver getImageErr — permite "pintar" o buffer
	bounds      image.Rectangle
	getBoundsErr error
	released    bool
}

func (f *fakeOutputDuplicator) GetImage(img *image.RGBA, timeoutMs uint) error {
	if f.getImageFn != nil {
		f.getImageFn(img)
	}
	return f.getImageErr
}

func (f *fakeOutputDuplicator) GetBounds() (image.Rectangle, error) {
	return f.bounds, f.getBoundsErr
}

func (f *fakeOutputDuplicator) Release() { f.released = true }

// newTestDXGICapturer monta um dxgiScreenCapturer sem passar por
// newDXGIScreenCapturer (que chamaria D3D11CreateDevice de verdade) — só o
// necessário pra exercitar CaptureJPEG/recreateDuplicator/Bounds, que são a
// parte testável sem hardware real. device/deviceCtx ficam nil de propósito
// (não testável em CI — ver captureScreenJPEG/screencapture_windows.go pra
// o mesmo limite já aceito no GDI); recreateDuplicator nestes testes nunca
// chega a usá-los porque newDuplicatorFn é injetado, não o
// outputduplication.NewIDXGIOutputDuplication real.
func newTestDXGICapturer(ddup outputDuplicator, bounds image.Rectangle) *dxgiScreenCapturer {
	return &dxgiScreenCapturer{
		ddup:   ddup,
		bounds: bounds,
		imgBuf: image.NewRGBA(bounds),
	}
}

func TestDXGICaptureJPEG_Success(t *testing.T) {
	fake := &fakeOutputDuplicator{
		bounds: image.Rect(0, 0, 4, 4),
		getImageFn: func(img *image.RGBA) {
			// pinta 1 pixel vermelho só pra confirmar que o buffer real foi usado
			img.Set(0, 0, image.White)
		},
	}
	c := newTestDXGICapturer(fake, fake.bounds)

	jpegBytes, err := c.CaptureJPEG(70)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if len(jpegBytes) == 0 {
		t.Error("esperava JPEG não-vazio")
	}
	// JPEG começa sempre com o marker SOI 0xFFD8
	if jpegBytes[0] != 0xFF || jpegBytes[1] != 0xD8 {
		t.Errorf("saída não parece JPEG válido: primeiros bytes %x", jpegBytes[:2])
	}
}

// TestDXGICaptureJPEG_NoImageYetReusesLastFrame cobre o caminho mais comum
// em produção (desktop estático, sem mudança desde o frame anterior, DEPOIS
// de já ter chegado 1 frame real) — não é erro real, o imgBuf anterior é
// reusado e encodado normalmente.
func TestDXGICaptureJPEG_NoImageYetReusesLastFrame(t *testing.T) {
	fake := &fakeOutputDuplicator{
		bounds:      image.Rect(0, 0, 4, 4),
		getImageErr: outputduplication.ErrNoImageYet,
	}
	c := newTestDXGICapturer(fake, fake.bounds)
	c.gotFirstFrame = true // simula sessão já com pelo menos 1 frame real capturado antes

	jpegBytes, err := c.CaptureJPEG(70)
	if err != nil {
		t.Fatalf("ErrNoImageYet não deveria propagar como erro: %v", err)
	}
	if len(jpegBytes) == 0 {
		t.Error("esperava JPEG não-vazio (reusando o frame anterior)")
	}
	if fake.released {
		t.Error("ErrNoImageYet não deveria liberar/recriar o duplicator")
	}
}

// TestDXGICaptureJPEG_NoImageYetBeforeFirstFrameReturnsError cobre a 1ª
// chamada da sessão vindo ErrNoImageYet (desktop já estático desde o
// início) — achado da revisão de código desta migração: sem o gating por
// gotFirstFrame, isto reusaria o imgBuf ainda zerado (preto) alocado no
// construtor, mascarando uma tela preta como sucesso — exatamente a classe
// de bug que motivou a migração inteira (Daniela-Esc).
func TestDXGICaptureJPEG_NoImageYetBeforeFirstFrameReturnsError(t *testing.T) {
	fake := &fakeOutputDuplicator{
		bounds:      image.Rect(0, 0, 4, 4),
		getImageErr: outputduplication.ErrNoImageYet,
	}
	c := newTestDXGICapturer(fake, fake.bounds)

	_, err := c.CaptureJPEG(70)
	if err == nil {
		t.Fatal("esperava erro: ainda não chegou nenhum frame real nesta sessão, não devia devolver o buffer preto do construtor como se fosse sucesso")
	}
}

// TestDXGICaptureJPEG_RealErrorTriggersRecreate cobre o caminho de erro
// real (ex.: resolução mudou, DXGI_ERROR_ACCESS_LOST) — a chamada atual
// retorna erro (frame perdido, absorvido como falha transitória por
// sendLiveSessionFrame), e o duplicator antigo é liberado antes de tentar
// recriar.
func TestDXGICaptureJPEG_RealErrorTriggersRecreate(t *testing.T) {
	oldDdup := &fakeOutputDuplicator{
		bounds:      image.Rect(0, 0, 4, 4),
		getImageErr: errors.New("DXGI_ERROR_ACCESS_LOST"),
	}
	c := newTestDXGICapturer(oldDdup, oldDdup.bounds)

	newDdup := &fakeOutputDuplicator{bounds: image.Rect(0, 0, 8, 8)}
	c.newDuplicatorFn = func() (outputDuplicator, error) { return newDdup, nil }

	_, err := c.CaptureJPEG(70)
	if err == nil {
		t.Fatal("esperava erro na chamada onde a captura real falhou (frame perdido)")
	}
	if !oldDdup.released {
		t.Error("duplicator antigo deveria ter sido liberado (Release) antes de recriar")
	}
	if c.ddup != outputDuplicator(newDdup) {
		t.Error("esperava que o duplicator novo tivesse sido instalado em c.ddup")
	}
	if c.bounds != newDdup.bounds {
		t.Errorf("bounds = %v, want %v (deveria ter acompanhado a resolução nova)", c.bounds, newDdup.bounds)
	}
	if c.imgBuf.Bounds() != newDdup.bounds {
		t.Errorf("imgBuf não foi realocado pro tamanho novo: %v", c.imgBuf.Bounds())
	}

	// Próxima captura já usa o duplicator novo, recuperado.
	jpegBytes, err := c.CaptureJPEG(70)
	if err != nil {
		t.Fatalf("esperava recuperação na próxima captura: %v", err)
	}
	if len(jpegBytes) == 0 {
		t.Error("esperava JPEG não-vazio depois da recuperação")
	}
}

// TestDXGIRecreateDuplicator_ThrottlesRepeatedFailures cobre o risco de
// busy-loop (achado da revisão de código desta migração): se recreateDuplicator
// falhar, uma tentativa seguinte DENTRO do intervalo de throttle não deve
// chamar newDuplicatorFn de novo — só depois do intervalo passar.
func TestDXGIRecreateDuplicator_ThrottlesRepeatedFailures(t *testing.T) {
	oldDdup := &fakeOutputDuplicator{bounds: image.Rect(0, 0, 4, 4)}
	c := newTestDXGICapturer(oldDdup, oldDdup.bounds)

	calls := 0
	c.newDuplicatorFn = func() (outputDuplicator, error) {
		calls++
		return nil, errors.New("falha simulada de recriação")
	}

	if err := c.recreateDuplicator(); err == nil {
		t.Fatal("esperava erro na 1ª tentativa de recriação")
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1 após a 1ª tentativa", calls)
	}

	// 2ª chamada imediata (dentro do throttle) não deveria tentar de novo.
	if err := c.recreateDuplicator(); err == nil {
		t.Fatal("esperava erro (reaproveitado) na 2ª tentativa dentro do throttle")
	}
	if calls != 1 {
		t.Errorf("calls = %d, want continuar 1 (throttled) — recreateDuplicator martelou sem esperar", calls)
	}

	// Passado o intervalo de throttle, tenta de novo.
	c.lastRecreateAttempt = time.Now().Add(-dxgiRecreateMinInterval - time.Millisecond)
	if err := c.recreateDuplicator(); err == nil {
		t.Fatal("esperava erro na 3ª tentativa (throttle expirado)")
	}
	if calls != 2 {
		t.Errorf("calls = %d, want 2 depois do throttle expirar", calls)
	}
}

// TestDXGICaptureJPEG_RecreateFailureDoesNotPanicOnNextCapture é o teste de
// regressão pro CRÍTICO achado na revisão de código desta migração:
// recreateDuplicator falhando não deve deixar c.ddup nil — a PRÓXIMA
// CaptureJPEG tinha que rodar GetImage numa interface nil, causando panic
// (nil pointer dereference) dentro da goroutine de runLiveSessionLoop, que
// pulava o cleanup de liveSessions e travava o sessionId "já ativa" pra
// sempre. Aqui: duplicator antigo quebrado, newDuplicatorFn falha, e a
// próxima captura tem que devolver erro — nunca panicar.
func TestDXGICaptureJPEG_RecreateFailureDoesNotPanicOnNextCapture(t *testing.T) {
	oldDdup := &fakeOutputDuplicator{
		bounds:      image.Rect(0, 0, 4, 4),
		getImageErr: errors.New("DXGI_ERROR_ACCESS_LOST"),
	}
	c := newTestDXGICapturer(oldDdup, oldDdup.bounds)
	c.newDuplicatorFn = func() (outputDuplicator, error) {
		return nil, errors.New("falha simulada de recriação")
	}

	// 1ª chamada: GetImage falha, recreateDuplicator tenta e também falha.
	if _, err := c.CaptureJPEG(70); err == nil {
		t.Fatal("esperava erro na 1ª captura (GetImage falhou e recriar também falhou)")
	}

	// 2ª chamada, mesma sessão: NÃO pode panicar. c.ddup tem que continuar
	// sendo o duplicator antigo (ainda quebrado, mas não-nil).
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("CaptureJPEG panicou na 2ª chamada depois de recreateDuplicator falhar: %v", r)
		}
	}()
	if _, err := c.CaptureJPEG(70); err == nil {
		t.Fatal("esperava erro na 2ª captura (duplicator antigo continua quebrado)")
	}
}

func TestDXGIBounds(t *testing.T) {
	c := newTestDXGICapturer(&fakeOutputDuplicator{}, image.Rect(0, 0, 1920, 1080))
	w, h := c.Bounds()
	if w != 1920 || h != 1080 {
		t.Errorf("Bounds() = (%d, %d), want (1920, 1080)", w, h)
	}
}

func TestDXGIClose_ReleasesDuplicator(t *testing.T) {
	fake := &fakeOutputDuplicator{bounds: image.Rect(0, 0, 4, 4)}
	c := newTestDXGICapturer(fake, fake.bounds)

	c.Close()

	if !fake.released {
		t.Error("Close() deveria liberar o duplicator (Release)")
	}
	if c.ddup != nil {
		t.Error("Close() deveria deixar c.ddup nil")
	}
}
