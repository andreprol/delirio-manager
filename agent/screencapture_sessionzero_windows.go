package main

import (
	"fmt"
	"runtime"
)

// screencapture_sessionzero_windows.go: sessionZeroScreenCapturer (GDI) e
// sessionZeroDXGIScreenCapturer (DXGI) implementam screenCapturer
// (screencapture_backend_windows.go) pro modo session-zero (serviço
// capturando direto, sem companion, ver sessiondesktop_windows.go).
//
// Histórico: até 17/11/2026 usava SEMPRE GDI de propósito -- DXGI Desktop
// Duplication amarra numa SESSÃO/adapter de GPU específica, comportamento
// contra tela de login/UAC (secure desktop) não documentado nem testado.
// Confirmado ao vivo nesse dia (AUXILIAR-ASS, Delirio Manager): GDI
// capturava sem erro (depois de 2 fixes reais de BI_BITFIELDS, ver
// screencapture_windows.go) mas devolvia PIXELS PRETOS de verdade na
// desktop "Winlogon" — hipótese mais provável: a tela de login moderna
// (Windows 11) é composta via DWM/hardware, fora do caminho clássico que
// BitBlt consegue ler. André pediu tentar DXGI mesmo sabendo do risco
// (pode ser bloqueio deliberado da Microsoft contra captura de tela segura,
// não bug nosso) -- ver selectLiveSessionCapturer.

type sessionZeroScreenCapturer struct{}

func (sessionZeroScreenCapturer) CaptureJPEG(quality int) (data []byte, err error) {
	err = withActiveDesktopFn(func() error {
		data, err = captureScreenJPEGFn(quality)
		return err
	})
	return data, err
}

func (sessionZeroScreenCapturer) Bounds() (width, height int) {
	var w, h uintptr
	err := withActiveDesktopFn(func() error {
		var innerErr error
		w, h, innerErr = screenDimensions()
		return innerErr
	})
	if err != nil {
		return 0, 0
	}
	return int(w), int(h)
}

func (sessionZeroScreenCapturer) Close() {}

// sessionZeroDXGIScreenCapturer tenta DXGI Desktop Duplication na desktop
// ativa no momento (Winlogon/Default/Screen-saver) -- diferente de
// sessionZeroScreenCapturer (GDI), que reanexa a thread chamadora a cada
// CaptureJPEG (withActiveDesktopFn), DXGI/D3D11 exigem a MESMA thread do SO
// pro ciclo de vida INTEIRO do device/duplicator (ver comentário de
// runtime.LockOSThread em newDXGIScreenCapturer, screencapture_dxgi_windows.go)
// -- por isso a desktop é anexada e a thread travada 1 VEZ na construção,
// nunca por frame.
type sessionZeroDXGIScreenCapturer struct {
	desktop uintptr
	dxgi    screenCapturer
}

// newSessionZeroDXGIScreenCapturerFn: indireção testável, mesmo padrão de
// newDXGIScreenCapturerFn (screencapture_backend_windows.go).
var newSessionZeroDXGIScreenCapturerFn = newSessionZeroDXGIScreenCapturer

// newSessionZeroDXGIScreenCapturer anexa a thread chamadora à desktop ativa
// 1x (OpenInputDesktop+SetThreadDesktop, mesmas chamadas de
// withActiveDesktop) ANTES de criar o device D3D11/duplicator -- a ordem
// importa: sem travar a thread (LockOSThread) antes do SetThreadDesktop, o
// scheduler do Go poderia migrar a goroutine pra outra thread entre o
// SetThreadDesktop e a criação do device DXGI logo em seguida, criando o
// device numa thread que nunca foi anexada à desktop certa.
func newSessionZeroDXGIScreenCapturer() (screenCapturer, error) {
	if err := ensureInteractiveWindowStationFn(); err != nil {
		return nil, err
	}
	runtime.LockOSThread()
	// cleanup libera o que já foi aberto até aqui e destrava a thread --
	// extraído (achado 🟡 do code-reviewer) pra não repetir
	// closeDesktopFn+UnlockOSThread em cada caminho de erro: o próprio
	// newDXGIScreenCapturer (screencapture_dxgi_windows.go) já teve um bug
	// real motivado por esse exato padrão de cleanup duplicado.
	cleanup := func(desktop uintptr) {
		if desktop != 0 {
			closeDesktopFn(desktop)
		}
		runtime.UnlockOSThread()
	}
	desktop, err := openInputDesktopFn()
	if err != nil {
		cleanup(0)
		return nil, fmt.Errorf("sessiondesktop: %w", err)
	}
	if err := setThreadDesktopFn(desktop); err != nil {
		cleanup(desktop)
		return nil, fmt.Errorf("sessiondesktop: %w", err)
	}
	dxgi, err := newDXGIScreenCapturerFn()
	if err != nil {
		cleanup(desktop)
		return nil, err
	}
	return &sessionZeroDXGIScreenCapturer{desktop: desktop, dxgi: dxgi}, nil
}

func (c *sessionZeroDXGIScreenCapturer) CaptureJPEG(quality int) ([]byte, error) {
	return c.dxgi.CaptureJPEG(quality)
}

func (c *sessionZeroDXGIScreenCapturer) Bounds() (width, height int) {
	return c.dxgi.Bounds()
}

// Close libera o duplicator/device (dxgi.Close, que já chama
// runtime.UnlockOSThread 1x internamente -- ver newDXGIScreenCapturer) e só
// DEPOIS fecha a desktop e destrava a thread que ESTE capturer travou --
// ordem inversa da construção, 2 Lock/2 Unlock no total (1 nosso + 1 do
// DXGI), nunca travado/destravado fora de par.
func (c *sessionZeroDXGIScreenCapturer) Close() {
	c.dxgi.Close()
	closeDesktopFn(c.desktop)
	runtime.UnlockOSThread()
}

// newSessionZeroCapturer tenta DXGI primeiro, cai pro GDI (sessionZeroScreenCapturer,
// já validado em produção) em qualquer falha de criação ou bounds mismatch
// -- mesmo padrão/mesma razão de newScreenCapturerWithGDIBounds
// (screencapture_backend_windows.go), aplicado à desktop ativa do
// session-zero em vez da sessão interativa normal. Nunca propaga erro pro
// chamador.
func newSessionZeroCapturer() (capturer screenCapturer, backend string) {
	return newSessionZeroCapturerWithGDIBounds((sessionZeroScreenCapturer{}).Bounds)
}

// newSessionZeroCapturerWithGDIBounds recebe a função de bounds do GDI como
// parâmetro (em vez de chamar sessionZeroScreenCapturer{}.Bounds() direto)
// só pra permitir testar o caminho de bounds-mismatch com um valor
// controlado, sem depender de desktop/GDI real -- mesmo motivo de
// newScreenCapturerWithGDIBounds (screencapture_backend_windows.go).
func newSessionZeroCapturerWithGDIBounds(gdiBounds func() (int, int)) (capturer screenCapturer, backend string) {
	// Mede o GDI ANTES de tentar criar o DXGI (achado 🟡 do code-reviewer):
	// gdiBounds (sessionZeroScreenCapturer.Bounds) faz seu PRÓPRIO
	// OpenInputDesktop+SetThreadDesktop+LockOSThread (withActiveDesktopFn) --
	// reanexar a desktop na MESMA thread enquanto um device D3D11 do DXGI já
	// está vivo (criado logo abaixo) não tem comportamento documentado nem
	// testado, risco da mesma classe que motivou esta feature toda. Medir
	// antes evita a sobreposição por completo.
	gdiW, gdiH := gdiBounds()

	dxgiCap, err := newSessionZeroDXGIScreenCapturerFn()
	if err != nil {
		logWarn(fmt.Sprintf("captura session-zero: DXGI indisponível (%v) — usando GDI", err))
		return sessionZeroScreenCapturer{}, "session-zero-gdi"
	}
	dxgiW, dxgiH := dxgiCap.Bounds()
	if dxgiW != gdiW || dxgiH != gdiH {
		logWarn(fmt.Sprintf(
			"captura session-zero: DXGI reporta %dx%d mas a tela real (GDI) é %dx%d — usando GDI pra não desalinhar cliques",
			dxgiW, dxgiH, gdiW, gdiH))
		dxgiCap.Close()
		return sessionZeroScreenCapturer{}, "session-zero-gdi"
	}
	return dxgiCap, "session-zero-dxgi"
}

// newSessionZeroCapturerFn: indireção testável, mesmo padrão de
// newScreenCapturerFn (screencapture_backend_windows.go).
var newSessionZeroCapturerFn = newSessionZeroCapturer
