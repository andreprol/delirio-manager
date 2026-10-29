package main

import (
	"fmt"
	"runtime"
	"sync"
)

// gdi_windows.go concentra o GDI compartilhado entre captura de tela
// (screencapture_windows.go) e injeção de mouse (input_windows.go) — as
// duas precisam saber o tamanho real da tela pra funcionar juntas (o
// dashboard escala cliques em cima do frame JPEG recebido; se as duas
// usassem fontes de dimensão diferentes, cliques ficariam desalinhados
// mesmo com o vídeo funcionando). Antes de 29/10/2026 cada arquivo tinha
// sua própria cópia de GetDC+GetDeviceCaps+checagem de zero — unificado
// aqui depois da revisão de código apontar a duplicação.
var (
	procGetDC         = user32.NewProc("GetDC")
	procReleaseDC     = user32.NewProc("ReleaseDC")
	procGetDeviceCaps = gdi32.NewProc("GetDeviceCaps")
)

const (
	horzRes = 8  // GetDeviceCaps: largura em pixels do HDC (nem sempre bate com SM_CXSCREEN)
	vertRes = 10 // GetDeviceCaps: altura em pixels do HDC
)

var (
	screenDimMu     sync.Mutex
	screenDimCached bool
	screenDimW      uintptr
	screenDimH      uintptr
)

// screenDimensions devolve o tamanho (largura, altura) da tela primária,
// via GetDeviceCaps do HDC real (GetDC(0)) — não GetSystemMetrics(SM_CXSCREEN/
// SM_CYSCREEN). Achado 29/10/2026 na Daniela-Esc: essa máquina tem 2 placas
// de vídeo (NVIDIA dedicada antiga + Intel integrada) e GetSystemMetrics
// divergia de outra API do Windows ([System.Windows.Forms.Screen]::
// PrimaryScreen.Bounds, 1024x768 contra 1920x1080) — sintoma de que o HDC
// "primário" de verdade não é necessariamente o que GetSystemMetrics
// descreve em máquina com GPU dupla/múltiplos adaptadores. GetDeviceCaps
// chamado no PRÓPRIO hdcScreen garante que a dimensão usada sempre bate com
// o que aquele HDC especificamente suporta — CreateCompatibleBitmap/
// GetDIBits (captura) e a normalização 0-65535 do SendInput (clique) usam
// essa mesma fonte agora, em vez de uma terceira API que pode divergir.
//
// Resultado cacheado (1x por processo) — GetDC/GetDeviceCaps são syscalls
// reais, caros demais pra rodar a cada frame de captura (10/s) ou a cada
// evento de mousemove relayed pelo dashboard (pode ser dezenas/s num
// arrasto contínuo). Resolução de tela mudar DURANTE uma sessão ativa de
// Acesso Remoto é raríssimo; se acontecer, só reflete depois de um restart
// do serviço — mesma limitação já aceita no projeto pra featureLiveAccess/
// pollSecs (mudança de config só pega efeito após Restart-Service).
func screenDimensions() (width, height uintptr, err error) {
	screenDimMu.Lock()
	defer screenDimMu.Unlock()
	if screenDimCached {
		return screenDimW, screenDimH, nil
	}

	// GetLastError/SetLastError são estado por THREAD do SO, não por
	// goroutine — mesmo cuidado de captureScreenJPEG (ver clearLastError em
	// screencapture_windows.go): sem fixar a goroutine na M atual, o erro
	// relatado por GetDC pode valer pra uma thread diferente da que fez a
	// chamada.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hdcScreen, _, lastErr := procGetDC.Call(0)
	if hdcScreen == 0 {
		return 0, 0, fmt.Errorf("GetDC falhou: %w", lastErr)
	}
	defer procReleaseDC.Call(0, hdcScreen) //nolint:errcheck

	w, _, _ := procGetDeviceCaps.Call(hdcScreen, horzRes)
	h, _, _ := procGetDeviceCaps.Call(hdcScreen, vertRes)
	if w == 0 || h == 0 {
		return 0, 0, fmt.Errorf("GetDeviceCaps retornou tela com dimensão zero")
	}

	screenDimW, screenDimH, screenDimCached = w, h, true
	return w, h, nil
}
