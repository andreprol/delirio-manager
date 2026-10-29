package main

import (
	"errors"
	"testing"
)

// fakeDXGICapturer implementa screenCapturer sem D3D11/DXGI real — permite
// testar newScreenCapturer isoladamente (mesmo padrão de fakeScreenCapturer
// em livesession_windows_test.go). captureFn, se setado, substitui o
// comportamento padrão sempre-sucesso — usado pra testar os caminhos de
// retry/fallback de captureOneScreenshotJPEG.
type fakeDXGICapturer struct {
	w, h      int
	closed    bool
	captureFn func(quality int) ([]byte, error)
}

func (f *fakeDXGICapturer) CaptureJPEG(quality int) ([]byte, error) {
	if f.captureFn != nil {
		return f.captureFn(quality)
	}
	return []byte("frame"), nil
}
func (f *fakeDXGICapturer) Bounds() (int, int) { return f.w, f.h }
func (f *fakeDXGICapturer) Close()             { f.closed = true }

func withDXGIStub(t *testing.T, fn func() (screenCapturer, error)) {
	t.Helper()
	original := newDXGIScreenCapturerFn
	newDXGIScreenCapturerFn = fn
	t.Cleanup(func() { newDXGIScreenCapturerFn = original })
}

func TestNewScreenCapturer_DXGIFailsFallsBackToGDI(t *testing.T) {
	withDXGIStub(t, func() (screenCapturer, error) {
		return nil, errors.New("sem D3D11 compatível")
	})

	cap, backend := newScreenCapturerWithGDIBounds(func() (int, int) { return 1920, 1080 })
	if backend != "gdi" {
		t.Errorf("backend = %q, want gdi", backend)
	}
	if _, ok := cap.(gdiScreenCapturer); !ok {
		t.Errorf("capturer = %T, want gdiScreenCapturer", cap)
	}
}

func TestNewScreenCapturer_BoundsMatchUsesDXGI(t *testing.T) {
	fake := &fakeDXGICapturer{w: 1920, h: 1080}
	withDXGIStub(t, func() (screenCapturer, error) { return fake, nil })

	cap, backend := newScreenCapturerWithGDIBounds(func() (int, int) { return 1920, 1080 })
	if backend != "dxgi" {
		t.Errorf("backend = %q, want dxgi", backend)
	}
	if cap != screenCapturer(fake) {
		t.Error("esperava que o capturer devolvido fosse o fake DXGI")
	}
	if fake.closed {
		t.Error("não deveria fechar o capturer DXGI quando ele é o escolhido")
	}
}

// TestNewScreenCapturer_BoundsMismatchFallsBackToGDI cobre o risco mais
// delicado desta migração (ver screencapture_backend_windows.go): se o DXGI
// enxerga uma tela de tamanho diferente do GDI (ex.: pegou o output errado
// numa máquina com GPU dupla), cai pro GDI em vez de deixar captura e
// clique discordando do tamanho real.
func TestNewScreenCapturer_BoundsMismatchFallsBackToGDI(t *testing.T) {
	fake := &fakeDXGICapturer{w: 1024, h: 768}
	withDXGIStub(t, func() (screenCapturer, error) { return fake, nil })

	cap, backend := newScreenCapturerWithGDIBounds(func() (int, int) { return 1920, 1080 })
	if backend != "gdi" {
		t.Errorf("backend = %q, want gdi (bounds mismatch deveria forçar fallback)", backend)
	}
	if _, ok := cap.(gdiScreenCapturer); !ok {
		t.Errorf("capturer = %T, want gdiScreenCapturer", cap)
	}
	if !fake.closed {
		t.Error("esperava que o capturer DXGI rejeitado fosse fechado (Close), evitando vazamento de recurso")
	}
}

func TestCaptureOneScreenshotJPEG_ClosesCapturer(t *testing.T) {
	fake := &fakeDXGICapturer{w: 1920, h: 1080}
	withDXGIStub(t, func() (screenCapturer, error) { return fake, nil })

	originalFn := newScreenCapturerFn
	newScreenCapturerFn = func() (screenCapturer, string) { return fake, "dxgi" }
	t.Cleanup(func() { newScreenCapturerFn = originalFn })

	jpegBytes, err := captureOneScreenshotJPEG(70)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if string(jpegBytes) != "frame" {
		t.Errorf("jpegBytes = %q, want %q", jpegBytes, "frame")
	}
	if !fake.closed {
		t.Error("captureOneScreenshotJPEG deveria fechar o capturer efêmero após o uso")
	}
}

// TestCaptureOneScreenshotJPEG_RetriesBeforeSucceeding cobre o achado da
// revisão de código desta migração (passada 2): um capturer DXGI recém-
// criado pode não ter nenhum frame pronto ainda (timeout curto, tunado pro
// ticker da sessão viva, não pro comando avulso) — precisa tentar de novo
// antes de desistir, não falhar na 1ª tentativa.
func TestCaptureOneScreenshotJPEG_RetriesBeforeSucceeding(t *testing.T) {
	attempts := 0
	fake := &fakeDXGICapturer{captureFn: func(quality int) ([]byte, error) {
		attempts++
		if attempts < 3 {
			return nil, errors.New("captura DXGI: ainda sem nenhum frame desde o início da sessão")
		}
		return []byte("frame-ok"), nil
	}}
	originalFn := newScreenCapturerFn
	newScreenCapturerFn = func() (screenCapturer, string) { return fake, "dxgi" }
	t.Cleanup(func() { newScreenCapturerFn = originalFn })

	jpegBytes, err := captureOneScreenshotJPEG(70)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if string(jpegBytes) != "frame-ok" {
		t.Errorf("jpegBytes = %q, want %q", jpegBytes, "frame-ok")
	}
	if attempts != 3 {
		t.Errorf("attempts = %d, want 3 (2 falhas + 1 sucesso)", attempts)
	}
}

// TestCaptureOneScreenshotJPEG_FallsBackToGDIWhenDXGIExhausted cobre o
// ALTO achado na revisão de código desta migração (passada 2): se o DXGI
// falhar em TODAS as tentativas, o comando avulso tem que cair pro GDI em
// vez de devolver erro — nunca pode regredir vs. o comportamento 100% GDI
// de antes desta migração.
func TestCaptureOneScreenshotJPEG_FallsBackToGDIWhenDXGIExhausted(t *testing.T) {
	fake := &fakeDXGICapturer{captureFn: func(quality int) ([]byte, error) {
		return nil, errors.New("falha persistente simulada de captura DXGI")
	}}
	originalFn := newScreenCapturerFn
	newScreenCapturerFn = func() (screenCapturer, string) { return fake, "dxgi" }
	t.Cleanup(func() { newScreenCapturerFn = originalFn })

	originalGDI := captureScreenJPEGFn
	captureScreenJPEGFn = func(quality int) ([]byte, error) { return []byte("frame-gdi"), nil }
	t.Cleanup(func() { captureScreenJPEGFn = originalGDI })

	jpegBytes, err := captureOneScreenshotJPEG(70)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if string(jpegBytes) != "frame-gdi" {
		t.Errorf("jpegBytes = %q, want %q (esperava fallback pro GDI)", jpegBytes, "frame-gdi")
	}
}

// TestCaptureOneScreenshotJPEG_NoRedundantGDIFallbackWhenAlreadyGDI
// confirma que, quando o capturer escolhido JÁ era o GDI (newScreenCapturer
// já tinha caído pro fallback antes de chegar aqui), uma falha não tenta
// "cair pro GDI" de novo — seria o mesmo caminho repetido, sem sentido.
func TestCaptureOneScreenshotJPEG_NoRedundantGDIFallbackWhenAlreadyGDI(t *testing.T) {
	originalFn := newScreenCapturerFn
	newScreenCapturerFn = func() (screenCapturer, string) { return gdiScreenCapturer{}, "gdi" }
	t.Cleanup(func() { newScreenCapturerFn = originalFn })

	originalGDI := captureScreenJPEGFn
	gdiCalls := 0
	captureScreenJPEGFn = func(quality int) ([]byte, error) {
		gdiCalls++
		return nil, errors.New("falha simulada de captura GDI")
	}
	t.Cleanup(func() { captureScreenJPEGFn = originalGDI })

	_, err := captureOneScreenshotJPEG(70)
	if err == nil {
		t.Fatal("esperava erro (GDI falhou e já era o backend escolhido, sem fallback possível)")
	}
	if gdiCalls != captureOneScreenshotRetries {
		t.Errorf("gdiCalls = %d, want %d (só os retries, sem tentativa extra de fallback)", gdiCalls, captureOneScreenshotRetries)
	}
}
