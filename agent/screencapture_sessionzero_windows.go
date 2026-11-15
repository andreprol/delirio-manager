package main

// screencapture_sessionzero_windows.go: sessionZeroScreenCapturer implementa
// screenCapturer (screencapture_backend_windows.go) pro modo session-zero
// (serviço capturando direto, sem companion, ver sessiondesktop_windows.go).
//
// Usa SEMPRE GDI (captureScreenJPEGFn/screenDimensions, screencapture_windows.go
// /gdi_windows.go), nunca DXGI -- GetDC(0)/BitBlt (GDI) captura o que QUALQUER
// thread anexada à desktop ativa consegue ver, exatamente o mecanismo que
// withActiveDesktop torna possível; DXGI Desktop Duplication amarra numa
// SESSÃO/adapter de GPU específica, comportamento contra tela de login/UAC
// (secure desktop) não documentado nem testado -- GDI é a escolha
// conservadora e compreendida pra este caso de uso específico.

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
