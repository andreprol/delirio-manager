package main

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
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

// user32 já é declarado em activity_windows.go (mesmo pacote) — reusado aqui
// pra procGetDC/procReleaseDC/procGetSystemMetrics.
var (
	gdi32                      = syscall.NewLazyDLL("gdi32.dll")
	procGetDC                  = user32.NewProc("GetDC")
	procReleaseDC              = user32.NewProc("ReleaseDC")
	procGetSystemMetrics       = user32.NewProc("GetSystemMetrics")
	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procGetDIBits              = gdi32.NewProc("GetDIBits")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
)

const (
	smCxScreen   = 0
	smCyScreen   = 1
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
// Limitação conhecida/aceita pro escopo atual: GetSystemMetrics com
// SM_CXSCREEN/SM_CYSCREEN captura só o monitor PRIMÁRIO, não a área
// virtual de múltiplos monitores — aceitável pros PCs físicos de loja,
// majoritariamente single-monitor. Suporte multi-monitor fica pra uma
// task futura caso necessário.
//
// Não testável em CI (precisa de desktop real) — verificar manualmente.
func captureScreenJPEG(quality int) ([]byte, error) {
	quality = clampJPEGQuality(quality)

	width, _, _ := procGetSystemMetrics.Call(smCxScreen)
	height, _, _ := procGetSystemMetrics.Call(smCyScreen)
	if width == 0 || height == 0 {
		return nil, fmt.Errorf("GetSystemMetrics retornou tela com dimensão zero")
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

	ret, _, lastErr := procBitBlt.Call(hdcMem, 0, 0, width, height, hdcScreen, 0, 0, srcCopy)
	if ret == 0 {
		return nil, fmt.Errorf("BitBlt falhou: %w", lastErr)
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
	ret, _, lastErr = procGetDIBits.Call(
		hdcMem, hBitmap, 0, uintptr(height),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bi)), dibRGBColors,
	)
	if ret == 0 {
		return nil, fmt.Errorf("GetDIBits falhou: %w", lastErr)
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
