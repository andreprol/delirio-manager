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

	img, err := readBitmapAsImage(hdcMem, hBitmap, width, height)
	if err != nil {
		return nil, err
	}

	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("jpeg.Encode: %w", err)
	}
	return out.Bytes(), nil
}

// readBitmapAsImage extrai os pixels de hBitmap (já com o conteúdo da tela
// copiado via BitBlt em hdcMem) como *image.RGBA, via GetDIBits em 2
// passos — separado de captureScreenJPEG só por tamanho de função
// (cyclop), mas também isola a parte que mais mudou nesta investigação.
//
// 1º passo: CONSULTA o formato nativo do bitmap (lpvBits=NULL, BitCount
// começa em 0) — a técnica de 2 passos documentada pela Microsoft pra
// GetDIBits, em vez de FORÇAR BitCount=32/BI_RGB de cara e pedir ao driver
// pra converter.
//
// Achado 29/10/2026 (Daniela-Esc, driver NVIDIA GT 730 de 2018): mesmo
// depois de corrigir thread/GetLastError (v1.6.3) e trocar GetSystemMetrics
// por GetDeviceCaps do HDC real (v1.6.5), GetDIBits continuava falhando
// IDÊNTICO pedindo conversão forçada pra 32bpp — GetDeviceCaps devolveu a
// MESMA dimensão que GetSystemMetrics já devolvia, então a teoria de "HDC
// errado" não explicava nada; o padrão (falha sem setar erro, mesmo com
// thread fixa) aponta pra um driver que não suporta essa conversão
// específica de formato, não um parâmetro nosso errado. Perguntar o
// formato NATIVO primeiro e usar ESSE no pedido real evita depender do
// driver saber converter.
func readBitmapAsImage(hdcMem, hBitmap, width, height uintptr) (*image.RGBA, error) {
	// bitmapInfo reserva espaço DEPOIS do bitmapInfoHeader pra GetDIBits
	// escrever ali na CONSULTA (1º passo, abaixo) — nesse momento ainda não
	// sabemos o formato nativo do bitmap, então o driver pode escrever uma
	// tabela de cores (8bpp paletizado, até 256 RGBQUAD = 1024 bytes) ou
	// BI_BITFIELDS (3 máscaras de cor), mesmo que o código REJEITE esses
	// formatos logo em seguida. Achado 🔴 CRÍTICO da revisão de código: um
	// bitmapInfoHeader "nu" (só os 40 bytes do header, na pilha do Go) é
	// buffer overflow real nesse cenário, porque GetDIBits assume que
	// recebeu um BITMAPINFO completo e escreve ali mesmo, após o header
	// que ele enxerga — o overflow acontece ANTES de qualquer checagem
	// nossa poder rejeitar o formato.
	type bitmapInfo struct {
		header     bitmapInfoHeader
		colorTable [256]uint32 // espaço de segurança pra RGBQUAD/máscaras que a consulta pode escrever — não decodificado, só formatos 24/32bpp BI_RGB são aceitos abaixo
	}
	var bmi bitmapInfo
	bmi.header = bitmapInfoHeader{
		Size:   uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		Width:  int32(width),
		Height: -int32(height), // negativo = top-down (sem precisar inverter linhas)
		Planes: 1,
		// BitCount fica 0 de propósito — é o sinal pro GetDIBits preencher
		// de volta com o bpp nativo do bitmap, em vez de converter pra um
		// valor que pedimos.
	}
	clearLastError()
	ret, _, lastErr := procGetDIBits.Call(
		hdcMem, hBitmap, 0, uintptr(height),
		0, uintptr(unsafe.Pointer(&bmi)), dibRGBColors,
	)
	if ret == 0 || bmi.header.BitCount == 0 {
		return nil, fmt.Errorf("GetDIBits (consulta de formato, tela %dx%d): %w", width, height, lastErr)
	}

	bitCount := bmi.header.BitCount
	if bitCount != 32 && bitCount != 24 {
		// Formatos além de 24/32bpp são raros em hardware pós-2010 (16bpp
		// 555/565 têm layout de bits distinto, não um simples reorder de
		// bytes; 8bpp paletizado exigiria decodificar a colorTable) —
		// falhar com uma mensagem clara é melhor que um bgrXToRGBA que
		// decodifica a imagem errada em silêncio.
		return nil, fmt.Errorf("GetDIBits: formato de cor %d bpp não suportado (só 24/32 bpp)", bitCount)
	}
	if bmi.header.Compression != biRGB {
		// BI_BITFIELDS (3) usaria 3 máscaras de cor pra decodificar os
		// canais — bgraToRGBA/bgr24ToRGBA assumem ordem BGR(A) fixa, então
		// aceitar BI_BITFIELDS sem ler as máscaras reais decodificaria
		// cores trocadas em silêncio num driver com máscaras não-padrão
		// (achado 🟡 da revisão: aceitar sem usar as máscaras é pior que
		// não aceitar). RLE4/RLE8 também não fazem sentido pra captura de
		// tela. Falhar explícito é melhor que decodificar lixo.
		return nil, fmt.Errorf("GetDIBits: compressão %d não suportada (só BI_RGB)", bmi.header.Compression)
	}

	// Linhas de bitmap no Windows são alinhadas em múltiplos de 4 bytes —
	// só importa de verdade em 24bpp (width*4 já é sempre múltiplo de 4).
	stride := (int(width)*int(bitCount/8) + 3) &^ 3

	// Reusa bmi (BitCount/Compression já vieram certos do driver na
	// consulta acima) — MAS Height precisa ser forçado nativamente aqui,
	// não só na struct original: achado 🟠 da revisão de código — a
	// consulta (1º passo) pode ter sobrescrito Height com o valor que o
	// driver reportou pro bitmap nativo (tipicamente positivo/bottom-up
	// numa DDB), silenciosamente substituindo o -height (top-down) que
	// pedimos. Sem forçar de novo aqui, o 2º passo herdaria esse valor e a
	// imagem sairia de cabeça para baixo, sem nenhum erro.
	bmi.header.Height = -int32(height)
	buf := make([]byte, stride*int(height))
	clearLastError()
	ret, _, lastErr = procGetDIBits.Call(
		hdcMem, hBitmap, 0, uintptr(height),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bmi)), dibRGBColors,
	)
	if ret == 0 {
		// Mesmo achado de sempre, agora com o formato NATIVO já confirmado
		// pela consulta acima — um erro 0 aqui não é mais ambíguo com
		// "driver não sabe converter pro formato que pedimos".
		return nil, fmt.Errorf("GetDIBits falhou (tela %dx%d, %d bpp): %w", width, height, bitCount, lastErr)
	}

	switch bitCount {
	case 32:
		return bgraToRGBA(buf, int(width), int(height)), nil
	default: // 24 — já validado acima, só sobra este caso
		return bgr24ToRGBA(buf, stride, int(width), int(height)), nil
	}
}

// bgraToRGBA converte um buffer BGRA (ordem de bytes que GetDIBits devolve
// pra bitmaps BI_RGB de 32bpp no Windows) pra um *image.RGBA — separado de
// captureScreenJPEG pra ser testável sem depender de GDI/desktop real.
// width*4 já é sempre múltiplo de 4, então aqui stride == width*4 sempre
// (diferente de bgr24ToRGBA, que precisa de stride explícito).
func bgraToRGBA(buf []byte, width, height int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < width*height; i++ {
		b, g, r, a := buf[i*4], buf[i*4+1], buf[i*4+2], buf[i*4+3]
		img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = r, g, b, a
	}
	return img
}

// bgr24ToRGBA converte um buffer BGR 24bpp (3 bytes/pixel, sem canal alpha
// — devolvido por GetDIBits quando o bitmap nativo do driver não é 32bpp,
// achado 29/10/2026 investigando o driver NVIDIA antigo da Daniela-Esc)
// pra um *image.RGBA opaco. stride é a largura de cada linha EM BYTES já
// alinhada a 4 (ver captureScreenJPEG) — pode ser maior que width*3, daí
// não dar pra reusar bgraToRGBA nem indexar width*3 direto.
func bgr24ToRGBA(buf []byte, stride, width, height int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		row := buf[y*stride:]
		for x := 0; x < width; x++ {
			b, g, r := row[x*3], row[x*3+1], row[x*3+2]
			pi := (y*width + x) * 4
			img.Pix[pi], img.Pix[pi+1], img.Pix[pi+2], img.Pix[pi+3] = r, g, b, 255
		}
	}
	return img
}
