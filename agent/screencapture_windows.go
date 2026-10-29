package main

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"runtime"
	"syscall"
	"unsafe"
)

func clampJPEGQuality(q int) int {
	if q < 1 {
		return 1
	}
	if q > 100 {
		return 100
	}
	return q
}

const defaultJPEGQuality = 70

// captureScreenJPEGFn permite mock em teste — produção chama captureScreenJPEG de verdade.
var captureScreenJPEGFn = captureScreenJPEG

// user32 e kernel32 já são declarados em activity_windows.go (mesmo
// pacote) — reusados aqui pra procSetLastError. procGetDC/procReleaseDC/
// procGetDeviceCaps ficam em gdi_windows.go (compartilhados com
// input_windows.go via screenDimensions()).
var (
	gdi32                      = syscall.NewLazyDLL("gdi32.dll")
	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procGetDIBits              = gdi32.NewProc("GetDIBits")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procSetLastError           = kernel32.NewProc("SetLastError")
)

// clearLastError zera o último erro da thread ANTES de uma chamada GDI que
// pode falhar sem chamar SetLastError internamente (GetDIBits é o caso
// documentado que motivou isto — achado 29/10/2026: falha real na
// Daniela-Esc reportada como "GetDIBits falhou: A operação foi concluída
// com êxito", porque o valor de GetLastError() que sobrou era de uma
// chamada ANTERIOR bem-sucedida, não da própria GetDIBits). Sem isto, toda
// mensagem de erro daqui é ambígua entre "a API não setou nada" e "sobrou
// lixo de outra chamada" — com isto, um erro 0 depois do reset significa
// garantidamente "a API falhou sem reportar motivo", informação real por si
// só (aponta pra driver de vídeo/overlay de hardware em vez de bug de
// parâmetro, que normalmente SETAM um código).
func clearLastError() {
	procSetLastError.Call(0) //nolint:errcheck
}

const (
	srcCopy      = 0x00CC0020
	biRGB        = 0
	dibRGBColors = 0
)

// bitmapInfoHeader é o layout usado por GetDIBits em captureScreenJPEG.
type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

// captureScreenJPEG tira 1 print da tela inteira e devolve como JPEG.
//
// Limitação conhecida/aceita pro escopo atual: GetDC(0)/GetDeviceCaps (ver
// screenDimensions em gdi_windows.go) captura só o monitor PRIMÁRIO, não a
// área virtual de múltiplos monitores — aceitável pros PCs físicos de
// loja, majoritariamente single-monitor. Suporte multi-monitor fica pra
// uma task futura caso necessário.
//
// Não testável em CI (precisa de desktop real) — verificar manualmente.
func captureScreenJPEG(quality int) ([]byte, error) {
	// GetLastError/SetLastError são estado por THREAD do SO, não por
	// goroutine — sem fixar esta goroutine na M atual, o runtime do Go pode
	// migrá-la pra outra thread entre um clearLastError() e a chamada GDI
	// que ele deveria limpar (ex.: no safepoint do make([]byte, ...) logo
	// antes de GetDIBits), fazendo o reset valer pra thread errada. Sem
	// isto, os clearLastError() abaixo (achado 29/10/2026, captura falhando
	// na Daniela-Esc com erro mentiroso "concluída com êxito") voltam a
	// poder ler lixo de outra goroutine de forma rara e silenciosa — exatamente
	// a ambiguidade que eles existem pra eliminar.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	quality = clampJPEGQuality(quality)

	width, height, err := screenDimensions()
	if err != nil {
		return nil, fmt.Errorf("screenDimensions: %w", err)
	}

	hdcScreen, _, lastErr := procGetDC.Call(0)
	if hdcScreen == 0 {
		return nil, fmt.Errorf("GetDC falhou: %w", lastErr)
	}
	defer procReleaseDC.Call(0, hdcScreen) //nolint:errcheck

	hdcMem, _, lastErr := procCreateCompatibleDC.Call(hdcScreen)
	if hdcMem == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC falhou: %w", lastErr)
	}
	defer procDeleteDC.Call(hdcMem) //nolint:errcheck

	hBitmap, _, lastErr := procCreateCompatibleBitmap.Call(hdcScreen, width, height)
	if hBitmap == 0 {
		return nil, fmt.Errorf("CreateCompatibleBitmap falhou: %w", lastErr)
	}
	// hOld é o bitmap monocromático 1x1 default que já estava selecionado em
	// hdcMem. hBitmap precisa ser DESSELECIONADO (restaurando hOld) antes de
	// ser deletado — DeleteObject num objeto ainda selecionado num DC é um
	// caso não suportado pelo GDI (a Microsoft documenta restaurar o bitmap
	// antigo antes de deletar o novo em todo exemplo de captura de tela) e
	// pode falhar silenciosamente, vazando o handle GDI a cada captura. Por
	// isso o defer da restauração é registrado DEPOIS do defer de
	// DeleteObject: LIFO garante que a restauração roda PRIMEIRO.
	hOld, _, _ := procSelectObject.Call(hdcMem, hBitmap)
	defer procDeleteObject.Call(hBitmap)      //nolint:errcheck
	defer procSelectObject.Call(hdcMem, hOld) //nolint:errcheck

	clearLastError()
	ret, _, lastErr := procBitBlt.Call(hdcMem, 0, 0, width, height, hdcScreen, 0, 0, srcCopy)
	if ret == 0 {
		return nil, fmt.Errorf("BitBlt falhou (tela %dx%d): %w", width, height, lastErr)
	}

	bi := bitmapInfoHeader{
		Size:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		Width:       int32(width),
		Height:      -int32(height), // negativo = top-down (sem precisar inverter linhas)
		Planes:      1,
		BitCount:    32,
		Compression: biRGB,
	}
	buf := make([]byte, width*height*4)
	clearLastError()
	ret, _, lastErr = procGetDIBits.Call(
		hdcMem, hBitmap, 0, uintptr(height),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bi)), dibRGBColors,
	)
	if ret == 0 {
		// Achado 29/10/2026 (Daniela-Esc): GetDIBits pode retornar 0 sem
		// chamar SetLastError, e sem o clearLastError() acima isso aparecia
		// como "operação concluída com êxito" — lixo de uma chamada anterior
		// bem-sucedida, não o motivo real da falha. Com o reset, um erro 0
		// aqui significa garantidamente que a própria GetDIBits não reportou
		// motivo (aponta pra driver de vídeo/overlay de hardware em vez de
		// parâmetro errado, que normalmente SETA um código de erro de
		// verdade). width/height/bitcount no texto ajudam a próxima
		// investigação sem precisar reler este arquivo.
		return nil, fmt.Errorf("GetDIBits falhou (tela %dx%d, %d bpp): %w", width, height, bi.BitCount, lastErr)
	}

	img := bgraToRGBA(buf, int(width), int(height))

	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("jpeg.Encode: %w", err)
	}
	return out.Bytes(), nil
}

// bgraToRGBA converte um buffer BGRA (ordem de bytes que GetDIBits devolve
// pra bitmaps BI_RGB de 32bpp no Windows) pra um *image.RGBA — separado de
// captureScreenJPEG pra ser testável sem depender de GDI/desktop real.
func bgraToRGBA(buf []byte, width, height int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < width*height; i++ {
		b, g, r, a := buf[i*4], buf[i*4+1], buf[i*4+2], buf[i*4+3]
		img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = r, g, b, a
	}
	return img
}
