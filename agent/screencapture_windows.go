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

const defaultJPEGQuality = 70 //nolint:unused // ligado pela Task 7 (fio que chama captureScreenJPEG)

// user32 já é declarado em activity_windows.go (mesmo pacote) — reusado aqui
// pra procGetDC/procReleaseDC/procGetSystemMetrics.
//
//nolint:unused // ligado pela Task 7 (captureScreenJPEG ainda não é chamada por nada)
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

//nolint:unused // ligado pela Task 7
const (
	smCxScreen   = 0
	smCyScreen   = 1
	srcCopy      = 0x00CC0020
	biRGB        = 0
	dibRGBColors = 0
)

//nolint:unused // ligado pela Task 7 (layout usado por GetDIBits em captureScreenJPEG)
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
// Ainda não é chamada por nada: a Task 7 liga o fio.
//
//nolint:unused // ligado pela Task 7
func captureScreenJPEG(quality int) ([]byte, error) {
	quality = clampJPEGQuality(quality)

	width, _, _ := procGetSystemMetrics.Call(smCxScreen)
	height, _, _ := procGetSystemMetrics.Call(smCyScreen)
	if width == 0 || height == 0 {
		return nil, fmt.Errorf("GetSystemMetrics retornou tela com dimensão zero")
	}

	hdcScreen, _, _ := procGetDC.Call(0)
	if hdcScreen == 0 {
		return nil, fmt.Errorf("GetDC falhou")
	}
	defer procReleaseDC.Call(0, hdcScreen) //nolint:errcheck

	hdcMem, _, _ := procCreateCompatibleDC.Call(hdcScreen)
	if hdcMem == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC falhou")
	}
	defer procDeleteDC.Call(hdcMem) //nolint:errcheck

	hBitmap, _, _ := procCreateCompatibleBitmap.Call(hdcScreen, width, height)
	if hBitmap == 0 {
		return nil, fmt.Errorf("CreateCompatibleBitmap falhou")
	}
	defer procDeleteObject.Call(hBitmap) //nolint:errcheck

	procSelectObject.Call(hdcMem, hBitmap) //nolint:errcheck
	ret, _, _ := procBitBlt.Call(hdcMem, 0, 0, width, height, hdcScreen, 0, 0, srcCopy)
	if ret == 0 {
		return nil, fmt.Errorf("BitBlt falhou")
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
	ret, _, _ = procGetDIBits.Call(
		hdcMem, hBitmap, 0, uintptr(height),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bi)), dibRGBColors,
	)
	if ret == 0 {
		return nil, fmt.Errorf("GetDIBits falhou")
	}

	img := image.NewRGBA(image.Rect(0, 0, int(width), int(height)))
	for i := 0; i < int(width*height); i++ {
		b, g, r, a := buf[i*4], buf[i*4+1], buf[i*4+2], buf[i*4+3]
		img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = r, g, b, a
	}

	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("jpeg.Encode: %w", err)
	}
	return out.Bytes(), nil
}
