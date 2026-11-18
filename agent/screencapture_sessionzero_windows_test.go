package main

import (
	"errors"
	"testing"
)

// withSessionZeroDXGIStub mocka newSessionZeroDXGIScreenCapturerFn pra testar
// newSessionZeroCapturerWithGDIBounds sem desktop/D3D11 real -- mesmo padrão
// de withDXGIStub (screencapture_backend_windows_test.go).
func withSessionZeroDXGIStub(t *testing.T, fn func() (screenCapturer, error)) {
	t.Helper()
	original := newSessionZeroDXGIScreenCapturerFn
	newSessionZeroDXGIScreenCapturerFn = fn
	t.Cleanup(func() { newSessionZeroDXGIScreenCapturerFn = original })
}

func TestNewSessionZeroCapturer_DXGIFailsFallsBackToGDI(t *testing.T) {
	withSessionZeroDXGIStub(t, func() (screenCapturer, error) {
		return nil, errors.New("sessiondesktop: OpenInputDesktop falhou")
	})

	cap, backend := newSessionZeroCapturerWithGDIBounds(func() (int, int) { return 1920, 1080 })
	if backend != "session-zero-gdi" {
		t.Errorf("backend = %q, want session-zero-gdi", backend)
	}
	if _, ok := cap.(sessionZeroScreenCapturer); !ok {
		t.Errorf("capturer = %T, want sessionZeroScreenCapturer", cap)
	}
}

func TestNewSessionZeroCapturer_BoundsMatchUsesDXGI(t *testing.T) {
	fake := &fakeDXGICapturer{w: 1920, h: 1080}
	withSessionZeroDXGIStub(t, func() (screenCapturer, error) { return fake, nil })

	cap, backend := newSessionZeroCapturerWithGDIBounds(func() (int, int) { return 1920, 1080 })
	if backend != "session-zero-dxgi" {
		t.Errorf("backend = %q, want session-zero-dxgi", backend)
	}
	if cap != screenCapturer(fake) {
		t.Error("esperava que o capturer devolvido fosse o fake DXGI")
	}
	if fake.closed {
		t.Error("não deveria fechar o capturer DXGI quando ele é o escolhido")
	}
}

// TestNewSessionZeroCapturer_BoundsMismatchFallsBackToGDI cobre o mesmo
// risco documentado em newScreenCapturerWithGDIBounds: se o DXGI enxergar
// uma tela de tamanho diferente do GDI, cai pro GDI em vez de deixar
// captura e clique discordando do tamanho real.
func TestNewSessionZeroCapturer_BoundsMismatchFallsBackToGDI(t *testing.T) {
	fake := &fakeDXGICapturer{w: 1024, h: 768}
	withSessionZeroDXGIStub(t, func() (screenCapturer, error) { return fake, nil })

	cap, backend := newSessionZeroCapturerWithGDIBounds(func() (int, int) { return 1920, 1080 })
	if backend != "session-zero-gdi" {
		t.Errorf("backend = %q, want session-zero-gdi (bounds mismatch deveria forçar fallback)", backend)
	}
	if _, ok := cap.(sessionZeroScreenCapturer); !ok {
		t.Errorf("capturer = %T, want sessionZeroScreenCapturer", cap)
	}
	if !fake.closed {
		t.Error("esperava que o capturer DXGI rejeitado fosse fechado (Close), evitando vazamento de recurso")
	}
}

// sessionZeroDXGITestMocks substitui as 4 indireções que
// newSessionZeroDXGIScreenCapturer encadeia (ensureInteractiveWindowStationFn/
// openInputDesktopFn/setThreadDesktopFn/newDXGIScreenCapturerFn) por sucesso
// por padrão, com um spy de chamadas a closeDesktopFn -- usado pelos 4
// testes abaixo pra isolar qual passo falha sem repetir o boilerplate de
// mock 4 vezes.
func sessionZeroDXGITestMocks(t *testing.T) (closeDesktopCalls *[]uintptr) {
	t.Helper()
	originalEnsure := ensureInteractiveWindowStationFn
	originalOpenDesktop := openInputDesktopFn
	originalSetDesktop := setThreadDesktopFn
	originalCloseDesktop := closeDesktopFn
	originalDXGI := newDXGIScreenCapturerFn
	t.Cleanup(func() {
		ensureInteractiveWindowStationFn = originalEnsure
		openInputDesktopFn = originalOpenDesktop
		setThreadDesktopFn = originalSetDesktop
		closeDesktopFn = originalCloseDesktop
		newDXGIScreenCapturerFn = originalDXGI
	})

	ensureInteractiveWindowStationFn = func() error { return nil }
	openInputDesktopFn = func() (uintptr, error) { return 0xD35, nil }
	setThreadDesktopFn = func(uintptr) error { return nil }
	newDXGIScreenCapturerFn = func() (screenCapturer, error) { return &fakeDXGICapturer{w: 1920, h: 1080}, nil }

	calls := []uintptr{}
	closeDesktopFn = func(h uintptr) { calls = append(calls, h) }
	return &calls
}

// TestNewSessionZeroDXGIScreenCapturer_DesktopFailurePropagatesError
// confirma que uma falha em openInputDesktopFn vira erro pro chamador (que
// cai pro GDI, ver newSessionZeroCapturerWithGDIBounds) em vez de travar
// ou retornar um capturer inválido -- demais mocks ficam no sucesso padrão
// de sessionZeroDXGITestMocks, só openInputDesktopFn falha.
func TestNewSessionZeroDXGIScreenCapturer_DesktopFailurePropagatesError(t *testing.T) {
	closeCalls := sessionZeroDXGITestMocks(t)
	openInputDesktopFn = func() (uintptr, error) { return 0, errors.New("OpenInputDesktop falhou") }

	cap, err := newSessionZeroDXGIScreenCapturer()
	if err == nil {
		t.Fatal("esperava erro quando openInputDesktopFn falha")
	}
	if cap != nil {
		t.Errorf("capturer = %v, want nil quando a construção falha", cap)
	}
	if len(*closeCalls) != 0 {
		t.Errorf("closeDesktopFn chamado %d vez(es), want 0 (nenhuma desktop foi aberta ainda)", len(*closeCalls))
	}
}

// TestNewSessionZeroDXGIScreenCapturer_EnsureWindowStationFailurePropagatesError
// cobre o 1º passo da cadeia (achado 🟠 do code-reviewer: só o passo
// openInputDesktopFn tinha teste antes) -- se o processo nem consegue se
// associar à window station interativa, nenhum dos passos seguintes deve
// rodar.
func TestNewSessionZeroDXGIScreenCapturer_EnsureWindowStationFailurePropagatesError(t *testing.T) {
	sessionZeroDXGITestMocks(t)
	ensureInteractiveWindowStationFn = func() error { return errors.New("SetProcessWindowStation falhou") }

	cap, err := newSessionZeroDXGIScreenCapturer()
	if err == nil {
		t.Fatal("esperava erro quando ensureInteractiveWindowStationFn falha")
	}
	if cap != nil {
		t.Errorf("capturer = %v, want nil quando a construção falha", cap)
	}
}

// TestNewSessionZeroDXGIScreenCapturer_SetThreadDesktopFailureClosesDesktop
// cobre o 2º passo (achado 🟠 do code-reviewer) -- a desktop JÁ FOI aberta
// quando SetThreadDesktop falha, então tem que ser fechada antes de
// devolver o erro, senão vaza o handle.
func TestNewSessionZeroDXGIScreenCapturer_SetThreadDesktopFailureClosesDesktop(t *testing.T) {
	closeCalls := sessionZeroDXGITestMocks(t)
	setThreadDesktopFn = func(uintptr) error { return errors.New("SetThreadDesktop falhou") }

	cap, err := newSessionZeroDXGIScreenCapturer()
	if err == nil {
		t.Fatal("esperava erro quando setThreadDesktopFn falha")
	}
	if cap != nil {
		t.Errorf("capturer = %v, want nil quando a construção falha", cap)
	}
	if len(*closeCalls) != 1 || (*closeCalls)[0] != 0xD35 {
		t.Errorf("closeDesktopFn chamadas = %v, want [0xD35] (a desktop aberta antes do SetThreadDesktop falhar)", *closeCalls)
	}
}

// TestNewSessionZeroDXGIScreenCapturer_DXGICreationFailureClosesDesktop
// cobre o 3º passo, exatamente o ramo perguntado na revisão (item 1): a
// desktop JÁ foi anexada quando newDXGIScreenCapturerFn falha, tem que
// fechar mesmo assim.
func TestNewSessionZeroDXGIScreenCapturer_DXGICreationFailureClosesDesktop(t *testing.T) {
	closeCalls := sessionZeroDXGITestMocks(t)
	newDXGIScreenCapturerFn = func() (screenCapturer, error) { return nil, errors.New("sem D3D11 compatível") }

	cap, err := newSessionZeroDXGIScreenCapturer()
	if err == nil {
		t.Fatal("esperava erro quando newDXGIScreenCapturerFn falha")
	}
	if cap != nil {
		t.Errorf("capturer = %v, want nil quando a construção falha", cap)
	}
	if len(*closeCalls) != 1 || (*closeCalls)[0] != 0xD35 {
		t.Errorf("closeDesktopFn chamadas = %v, want [0xD35] (a desktop anexada antes do DXGI falhar)", *closeCalls)
	}
}

// TestSessionZeroDXGIScreenCapturer_CloseClosesDXGIAndDesktop confirma o
// Close() REAL (achado 🟠 do code-reviewer: os outros testes substituem
// newSessionZeroDXGIScreenCapturerFn por inteiro, nunca exercitando o Close
// de verdade) -- dxgi.Close() e closeDesktopFn(desktop) são chamados
// exatamente 1x cada, na construção bem-sucedida.
func TestSessionZeroDXGIScreenCapturer_CloseClosesDXGIAndDesktop(t *testing.T) {
	closeCalls := sessionZeroDXGITestMocks(t)
	fake := &fakeDXGICapturer{w: 1920, h: 1080}
	newDXGIScreenCapturerFn = func() (screenCapturer, error) { return fake, nil }

	cap, err := newSessionZeroDXGIScreenCapturer()
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	cap.Close()

	if !fake.closed {
		t.Error("esperava que dxgi.Close() fosse chamado")
	}
	if len(*closeCalls) != 1 || (*closeCalls)[0] != 0xD35 {
		t.Errorf("closeDesktopFn chamadas = %v, want [0xD35]", *closeCalls)
	}
}
