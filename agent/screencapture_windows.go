package main

import (
	"bytes"
	"encoding/binary"
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
	srcCopy = 0x00CC0020
	// CAPTUREBLT (0x40000000) foi tentado 17/11/2026 pra resolver pixels
	// pretos na desktop "Winlogon" (commit 3f1d74c) -- REVERTIDO no mesmo
	// dia: achado AO VIVO que a flag quebrava a captura NORMAL (usuário já
	// logado, companion, AUXILIAR-ASS) também, produzindo tela preta numa
	// sessão que sempre funcionou antes. Regressão real num driver
	// específico, não resolveu o problema original (Winlogon continuou
	// preto mesmo com a flag). Nunca reativar sem investigar por que esse
	// driver reage mal a ela -- ver
	// feedback/project_delirio_acesso_remoto_session_zero na memória.
	biRGB        = 0
	biBitfields  = 3
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
// bitmapInfo reserva espaço DEPOIS do bitmapInfoHeader pra GetDIBits
// escrever ali na CONSULTA (1º passo de readBitmapAsImage) — nesse momento
// ainda não sabemos o formato nativo do bitmap, então o driver pode
// escrever uma tabela de cores (8bpp paletizado, até 256 RGBQUAD = 1024
// bytes) ou BI_BITFIELDS (3 máscaras de cor), mesmo que o código REJEITE
// alguns desses formatos logo em seguida. Achado 🔴 CRÍTICO da revisão de
// código (29/10/2026): um bitmapInfoHeader "nu" (só os 40 bytes do header,
// na pilha do Go) é buffer overflow real nesse cenário, porque GetDIBits
// assume que recebeu um BITMAPINFO completo e escreve ali mesmo, após o
// header que ele enxerga — o overflow acontece ANTES de qualquer checagem
// nossa poder rejeitar o formato. Tipo no escopo do arquivo (não mais local
// a readBitmapAsImage) pra resolveBitfieldsMasks poder recebê-lo por
// ponteiro.
type bitmapInfo struct {
	header     bitmapInfoHeader
	colorTable [256]uint32 // espaço de segurança pra RGBQUAD/máscaras que a consulta pode escrever
}

// resolveBitfieldsMasks valida a combinação bitCount/Compression do bitmap
// nativo (reportado pela consulta em readBitmapAsImage) e, se for
// BI_BITFIELDS, extrai as 3 máscaras de cor (R/G/B, sem alpha — convenção
// do próprio GetDIBits, ocupam os 3 primeiros uint32 de bmi.colorTable) —
// extraído de readBitmapAsImage só por causa do limite de complexidade
// ciclomática do linter (cyclop, max 10), mesmo padrão já usado neste
// projeto. Achado ao vivo 17/11/2026 (sessão session-zero na desktop
// "Winlogon", ver sessiondesktop_windows.go): GetDIBits reporta o bitmap
// nativo dessa desktop com Compression=BI_BITFIELDS (3), não BI_RGB — a
// tela normal (companion, usuário logado) nunca bateu nesse formato, só a
// tela de login/lock. Erro explícito "compressão 3 não suportada" deixava
// a sessão "Conectada" pra sempre sem nenhum frame (captura falha
// silenciosa pro operador, só visível no agent.log). BI_BITFIELDS só faz
// sentido pra 32bpp aqui (16bpp com bitfields teria caído no erro de bpp
// em readBitmapAsImage, e 24bpp é sempre BI_RGB por definição do formato).
//
// 2ª rodada ao vivo 17/11/2026 (mesma AUXILIAR-ASS, já com o fix acima em
// produção): a desktop "Winlogon" reporta Compression=BI_BITFIELDS na
// consulta, MAS as 3 máscaras em bmi.colorTable vêm ZERADAS — o driver não
// as preenche na consulta, apesar da documentação da Microsoft dizer que
// deveria ("GetDIBits... returns... 3 DWORD color masks" junto da
// consulta). Sem segunda opção confiável pra decodificar um BI_BITFIELDS
// sem máscara real, useRGBFallback sinaliza pro chamador forçar
// Compression=BI_RGB no 2º GetDIBits (pede conversão ao driver, em vez de
// tentar ler o formato nativo) — só pra ESTE caso específico (máscara
// inválida sob BI_BITFIELDS), nunca pro caminho BI_RGB nativo nem quando
// as máscaras vêm válidas, então não reintroduz a falha de conversão
// forçada já documentada em Daniela-Esc (driver NVIDIA antigo, 29/10/2026,
// ver comentário no topo de readBitmapAsImage).
func resolveBitfieldsMasks(bmi *bitmapInfo, bitCount uint16) (rMask, gMask, bMask uint32, useRGBFallback bool, err error) {
	switch bmi.header.Compression {
	case biRGB:
		return 0, 0, 0, false, nil // fluxo de sempre, decodificado por bgraToRGBA/bgr24ToRGBA.
	case biBitfields:
		if bitCount != 32 {
			return 0, 0, 0, false, fmt.Errorf("GetDIBits: BI_BITFIELDS com %d bpp não suportado (só 32 bpp)", bitCount)
		}
		rMask, gMask, bMask = bmi.colorTable[0], bmi.colorTable[1], bmi.colorTable[2]
		if err := validateBitfieldsMasks(rMask, gMask, bMask); err != nil {
			return 0, 0, 0, true, nil
		}
		return rMask, gMask, bMask, false, nil
	default:
		// RLE4/RLE8/JPEG/PNG (valores 1/2/4/5) não fazem sentido pra
		// captura de tela via BitBlt+GetDIBits — falhar explícito é melhor
		// que decodificar lixo.
		return 0, 0, 0, false, fmt.Errorf("GetDIBits: compressão %d não suportada (só BI_RGB/BI_BITFIELDS)", bmi.header.Compression)
	}
}

// validateBitfieldsMasks rejeita qualquer máscara BI_BITFIELDS não-contígua,
// zerada, ou sobreposta com outro canal — extraído de resolveBitfieldsMasks
// só por limite de complexidade ciclomática do linter (cyclop, max 10).
// Achado 🟡 do code-reviewer: sem validar, um driver fora do padrão
// decodificaria cor ERRADA em silêncio — exatamente o cenário que este
// arquivo já rejeita explicitamente noutro lugar ("falhar explícito é
// melhor que decodificar lixo"). Um driver dentro do padrão nunca cai
// aqui; só existe pra nunca confiar cegamente nos 3 DWORDs que o driver
// escreveu.
func validateBitfieldsMasks(rMask, gMask, bMask uint32) error {
	if !isContiguousMask(rMask) || !isContiguousMask(gMask) || !isContiguousMask(bMask) {
		return fmt.Errorf("GetDIBits: BI_BITFIELDS com máscara de cor não-contígua (r=%#x g=%#x b=%#x)", rMask, gMask, bMask)
	}
	if rMask&gMask != 0 || rMask&bMask != 0 || gMask&bMask != 0 {
		return fmt.Errorf("GetDIBits: BI_BITFIELDS com máscaras de cor sobrepostas (r=%#x g=%#x b=%#x)", rMask, gMask, bMask)
	}
	return nil
}

// isContiguousMask confirma que mask é um único bloco de bits 1 contíguos
// (ex: 0x00FF0000) — toda máscara de cor BI_BITFIELDS válida é assim; bits
// espalhados (0xB0, por exemplo) indicariam um driver fora do padrão ou um
// bug na origem do dado, e decodificar isso sem checar devolveria uma cor
// errada sem nenhum erro visível.
func isContiguousMask(mask uint32) bool {
	if mask == 0 {
		return false
	}
	shift, width := bitFieldShiftAndWidth(mask)
	return mask == ((uint32(1)<<width)-1)<<shift
}

func readBitmapAsImage(hdcMem, hBitmap, width, height uintptr) (*image.RGBA, error) {
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
	bitfieldsRMask, bitfieldsGMask, bitfieldsBMask, useRGBFallback, err := resolveBitfieldsMasks(&bmi, bitCount)
	if err != nil {
		return nil, err
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
	// effectiveCompression é o formato que REALMENTE pedimos no 2º passo --
	// achado 🟠 do code-reviewer: decodeCapturedBitmap usava
	// bmi.header.Compression lido DEPOIS do 2º GetDIBits, mas este mesmo
	// arquivo já documentou (comentário acima, sobre Height) que o GDI
	// pode reescrever campos do header entre as duas chamadas -- se isso
	// acontecer com Compression também, o fallback (abaixo) voltaria a
	// cair no decoder de BI_BITFIELDS com as MESMAS máscaras zeradas que
	// causaram o fallback, produzindo frame preto sólido sem erro nenhum.
	// Guardar o valor pedido ANTES da chamada e nunca reler o campo depois
	// elimina essa ambiguidade.
	effectiveCompression := bmi.header.Compression
	if useRGBFallback {
		// Máscaras inválidas (ver resolveBitfieldsMasks) -- pede ao driver
		// pra CONVERTER pra BI_RGB 32bpp no 2º passo em vez de decodificar
		// um BI_BITFIELDS sem máscara de verdade. Achado 🟡 do
		// code-reviewer: logar aqui é a ÚNICA telemetria que sobrevive
		// desse caminho -- sem isso, "capturando ok só que com fallback"
		// fica indistinguível de "capturando ok no formato nativo" no
		// agent.log, justo no cenário (tela de login) que motivou toda
		// essa investigação.
		logWarn(fmt.Sprintf("captura: BI_BITFIELDS com máscaras de cor inválidas (r=%#x g=%#x b=%#x) -- forçando conversão pra BI_RGB 32bpp", bitfieldsRMask, bitfieldsGMask, bitfieldsBMask))
		bmi.header.Compression = biRGB
		effectiveCompression = biRGB
	}
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

	return decodeCapturedBitmap(buf, int(width), int(height), stride, bitCount, effectiveCompression, bitfieldsRMask, bitfieldsGMask, bitfieldsBMask), nil
}

// decodeCapturedBitmap escolhe o decoder certo pro buffer já preenchido
// pelo 2º GetDIBits — extraído de readBitmapAsImage só por limite de
// complexidade ciclomática do linter (cyclop, max 10).
func decodeCapturedBitmap(buf []byte, width, height, stride int, bitCount uint16, compression uint32, rMask, gMask, bMask uint32) *image.RGBA {
	if compression == biBitfields {
		return bitfields32ToRGBA(buf, width, height, rMask, gMask, bMask)
	}
	if bitCount == 32 {
		return bgraToRGBA(buf, width, height)
	}
	return bgr24ToRGBA(buf, stride, width, height) // 24 — já validado acima, só sobra este caso
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

// bitFieldShiftAndWidth devolve o shift (quantos bits até o 1º bit setado,
// vindo do LSB) e a largura em bits (quantos bits setados, sempre
// contíguos numa máscara BI_BITFIELDS válida) de uma máscara de canal —
// usado pra extrair e normalizar o canal pra 0-255 sem assumir 8 bits fixos
// (um driver pode reportar canal de 5/6/10 bits, não só o caso comum de 8).
func bitFieldShiftAndWidth(mask uint32) (shift, width uint32) {
	if mask == 0 {
		return 0, 0
	}
	for mask&1 == 0 {
		mask >>= 1
		shift++
	}
	for mask&1 == 1 {
		width++
		mask >>= 1
	}
	return shift, width
}

// bitfields32ToRGBA converte um buffer 32bpp BI_BITFIELDS (ordem/largura de
// canal definida pelas 3 máscaras devolvidas por GetDIBits, não BGRA fixo
// como bgraToRGBA assume) pra um *image.RGBA. Achado ao vivo 17/11/2026 na
// desktop "Winlogon" (sessiondesktop_windows.go, modo session-zero) — ver
// comentário em readBitmapAsImage. BI_BITFIELDS clássico só define 3
// máscaras (R/G/B, sem alpha) — opaco sempre, mesma convenção de
// bgr24ToRGBA pra canal alpha ausente.
func bitfields32ToRGBA(buf []byte, width, height int, rMask, gMask, bMask uint32) *image.RGBA {
	rShift, rBits := bitFieldShiftAndWidth(rMask)
	gShift, gBits := bitFieldShiftAndWidth(gMask)
	bShift, bBits := bitFieldShiftAndWidth(bMask)
	scale := func(raw, bits uint32) byte {
		if bits == 0 {
			return 0
		}
		maxVal := uint64(1)<<bits - 1
		// uint64 no cálculo intermediário (achado 🔵 do code-reviewer):
		// raw*255 em uint32 poderia estourar pra bits largos o bastante
		// (>~24), mesmo com resolveBitfieldsMasks já validando
		// contiguidade/sobreposição das máscaras.
		return byte(uint64(raw) * 255 / maxVal)
	}
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < width*height; i++ {
		pixel := binary.LittleEndian.Uint32(buf[i*4 : i*4+4])
		r := scale((pixel&rMask)>>rShift, rBits)
		g := scale((pixel&gMask)>>gShift, gBits)
		b := scale((pixel&bMask)>>bShift, bBits)
		pi := i * 4
		img.Pix[pi], img.Pix[pi+1], img.Pix[pi+2], img.Pix[pi+3] = r, g, b, 255
	}
	return img
}
