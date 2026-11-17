package main

import "testing"

func TestClampJPEGQuality(t *testing.T) {
	if q := clampJPEGQuality(0); q != 1 {
		t.Errorf("clampJPEGQuality(0) = %d, want 1", q)
	}
	if q := clampJPEGQuality(200); q != 100 {
		t.Errorf("clampJPEGQuality(200) = %d, want 100", q)
	}
	if q := clampJPEGQuality(70); q != 70 {
		t.Errorf("clampJPEGQuality(70) = %d, want 70", q)
	}
}

func TestBGRAToRGBA(t *testing.T) {
	// 2 pixels: 1 vermelho puro (BGRA no buffer) + 1 verde puro.
	buf := []byte{
		0, 0, 255, 255, // B=0 G=0 R=255 A=255 -> vermelho
		0, 255, 0, 128, // B=0 G=255 R=0 A=128 -> verde, alpha parcial
	}
	img := bgraToRGBA(buf, 2, 1)

	want := []byte{255, 0, 0, 255, 0, 255, 0, 128}
	if len(img.Pix) != len(want) {
		t.Fatalf("len(img.Pix) = %d, want %d", len(img.Pix), len(want))
	}
	for i, w := range want {
		if img.Pix[i] != w {
			t.Errorf("img.Pix[%d] = %d, want %d", i, img.Pix[i], w)
		}
	}
}

func TestBGR24ToRGBA(t *testing.T) {
	// 3 pixels numa linha só: vermelho, verde, azul (3 bytes/pixel, BGR),
	// stride=12 (3 pixels * 3 bytes = 9, arredondado pra múltiplo de 4) —
	// o byte de padding no fim da linha (índice 9-11) não deve vazar pro
	// pixel seguinte nem para a imagem decodificada.
	stride := 12
	buf := make([]byte, stride) // 1 linha só, já zerada = padding
	copy(buf, []byte{
		0, 0, 255, // B=0 G=0 R=255 -> vermelho
		0, 255, 0, // B=0 G=255 R=0 -> verde
		255, 0, 0, // B=255 G=0 R=0 -> azul
	})

	img := bgr24ToRGBA(buf, stride, 3, 1)

	want := []byte{
		255, 0, 0, 255, // vermelho opaco
		0, 255, 0, 255, // verde opaco
		0, 0, 255, 255, // azul opaco
	}
	if len(img.Pix) != len(want) {
		t.Fatalf("len(img.Pix) = %d, want %d", len(img.Pix), len(want))
	}
	for i, w := range want {
		if img.Pix[i] != w {
			t.Errorf("img.Pix[%d] = %d, want %d", i, img.Pix[i], w)
		}
	}
}

func TestBitFieldShiftAndWidth(t *testing.T) {
	cases := []struct {
		name        string
		mask        uint32
		wantShift   uint32
		wantWidth   uint32
	}{
		{"zero", 0, 0, 0},
		{"vermelho padrão 32bpp (bits 16-23)", 0x00FF0000, 16, 8},
		{"azul padrão 32bpp (bits 0-7)", 0x000000FF, 0, 8},
		{"canal estreito, não no LSB (ex: 565 verde deslocado)", 0x000007E0, 5, 6},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			shift, width := bitFieldShiftAndWidth(c.mask)
			if shift != c.wantShift || width != c.wantWidth {
				t.Errorf("bitFieldShiftAndWidth(%#x) = (%d, %d), want (%d, %d)", c.mask, shift, width, c.wantShift, c.wantWidth)
			}
		})
	}
}

func TestIsContiguousMask(t *testing.T) {
	cases := []struct {
		name string
		mask uint32
		want bool
	}{
		{"zero não é máscara válida", 0, false},
		{"padrão 32bpp contíguo", 0x00FF0000, true},
		{"bits espalhados (driver fora do padrão)", 0xB0, false},
		{"máscara inteira (32 bits, caso degenerado mas contíguo)", 0xFFFFFFFF, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isContiguousMask(c.mask); got != c.want {
				t.Errorf("isContiguousMask(%#x) = %v, want %v", c.mask, got, c.want)
			}
		})
	}
}

func TestValidateBitfieldsMasks(t *testing.T) {
	// achado real 17/11/2026 (desktop "Winlogon") -- caso que motivou o fix
	// inteiro: máscaras padrão R/G/B de 32bpp, ordem BGRA-equivalente.
	if err := validateBitfieldsMasks(0x00FF0000, 0x0000FF00, 0x000000FF); err != nil {
		t.Errorf("máscaras padrão válidas rejeitadas: %v", err)
	}
	if err := validateBitfieldsMasks(0xB0, 0x0000FF00, 0x000000FF); err == nil {
		t.Error("máscara não-contígua deveria ser rejeitada")
	}
	if err := validateBitfieldsMasks(0x00FFFF00, 0x0000FF00, 0x000000FF); err == nil {
		t.Error("máscaras sobrepostas (R e G compartilham bits) deveriam ser rejeitadas")
	}
	if err := validateBitfieldsMasks(0, 0x0000FF00, 0x000000FF); err == nil {
		t.Error("máscara zerada deveria ser rejeitada")
	}
}

func TestBitfields32ToRGBA(t *testing.T) {
	// Máscaras padrão 32bpp (equivalente ao layout BGRA que bgraToRGBA já
	// assume fixo) -- mesmo pixel vermelho+verde do TestBGRAToRGBA, agora
	// decodificado via máscara em vez de offset de byte fixo, confirmando
	// que os dois caminhos concordam no caso comum.
	rMask, gMask, bMask := uint32(0x00FF0000), uint32(0x0000FF00), uint32(0x000000FF)
	// Constrói os 2 pixels em little-endian explícito (byte 0 = LSB) pra não
	// depender de como bgraToRGBA enumera bytes -- vermelho puro (R=255) e
	// verde puro (G=255), alpha fora das 3 máscaras (sempre opaco aqui).
	pixel := func(r, g, b byte) []byte {
		return []byte{b, g, r, 0} // little-endian: byte0=bits0-7(B), byte1=bits8-15(G), byte2=bits16-23(R)
	}
	buf := append(append([]byte{}, pixel(255, 0, 0)...), pixel(0, 255, 0)...)

	img := bitfields32ToRGBA(buf, 2, 1, rMask, gMask, bMask)
	want := []byte{255, 0, 0, 255, 0, 255, 0, 255}
	if len(img.Pix) != len(want) {
		t.Fatalf("len(img.Pix) = %d, want %d", len(img.Pix), len(want))
	}
	for i, w := range want {
		if img.Pix[i] != w {
			t.Errorf("img.Pix[%d] = %d, want %d", i, img.Pix[i], w)
		}
	}
}

func TestBitfields32ToRGBANonStandardChannelOrder(t *testing.T) {
	// Confirma que a decodificação respeita a POSIÇÃO real das máscaras, não
	// um layout BGRA fixo -- aqui R fica nos bits baixos (oposto do caso
	// comum), e um pixel com esse canal setado só decodifica certo se o
	// código de fato usar rMask em vez de assumir offset fixo.
	rMask, gMask, bMask := uint32(0x000000FF), uint32(0x0000FF00), uint32(0x00FF0000)
	buf := []byte{255, 0, 0, 0} // little-endian: byte0 (bits0-7, = rMask) = 255
	img := bitfields32ToRGBA(buf, 1, 1, rMask, gMask, bMask)
	want := []byte{255, 0, 0, 255} // R=255, G=0, B=0, opaco
	for i, w := range want {
		if img.Pix[i] != w {
			t.Errorf("img.Pix[%d] = %d, want %d", i, img.Pix[i], w)
		}
	}
}

func TestResolveBitfieldsMasks(t *testing.T) {
	biRGBHeader := bitmapInfo{header: bitmapInfoHeader{Compression: biRGB}}
	r, g, b, err := resolveBitfieldsMasks(&biRGBHeader, 32)
	if err != nil || r != 0 || g != 0 || b != 0 {
		t.Errorf("BI_RGB deveria passar direto sem máscaras, got (%#x,%#x,%#x,%v)", r, g, b, err)
	}

	bitfieldsHeader := bitmapInfo{header: bitmapInfoHeader{Compression: biBitfields}}
	bitfieldsHeader.colorTable[0] = 0x00FF0000
	bitfieldsHeader.colorTable[1] = 0x0000FF00
	bitfieldsHeader.colorTable[2] = 0x000000FF
	r, g, b, err = resolveBitfieldsMasks(&bitfieldsHeader, 32)
	if err != nil || r != 0x00FF0000 || g != 0x0000FF00 || b != 0x000000FF {
		t.Errorf("BI_BITFIELDS 32bpp válido deveria extrair as máscaras, got (%#x,%#x,%#x,%v)", r, g, b, err)
	}

	_, _, _, err = resolveBitfieldsMasks(&bitfieldsHeader, 16)
	if err == nil {
		t.Error("BI_BITFIELDS com 16bpp deveria ser rejeitado (só 32bpp suportado)")
	}

	rleHeader := bitmapInfo{header: bitmapInfoHeader{Compression: 1}} // BI_RLE8
	_, _, _, err = resolveBitfieldsMasks(&rleHeader, 32)
	if err == nil {
		t.Error("compressão desconhecida/RLE deveria ser rejeitada")
	}
}

func TestBGR24ToRGBAMultiRowRespectsStride(t *testing.T) {
	// 2 linhas de 1 pixel cada, stride=4 (3 bytes de pixel + 1 de padding)
	// — se bgr24ToRGBA indexasse width*3 em vez de stride, a 2ª linha
	// leria o byte de padding da 1ª linha em vez do pixel real.
	stride := 4
	buf := []byte{
		0, 0, 255, 0xAA, // linha 0: vermelho + padding (lixo, não deve ser lido)
		0, 255, 0, 0xBB, // linha 1: verde + padding
	}

	img := bgr24ToRGBA(buf, stride, 1, 2)

	want := []byte{
		255, 0, 0, 255, // linha 0: vermelho
		0, 255, 0, 255, // linha 1: verde
	}
	if len(img.Pix) != len(want) {
		t.Fatalf("len(img.Pix) = %d, want %d", len(img.Pix), len(want))
	}
	for i, w := range want {
		if img.Pix[i] != w {
			t.Errorf("img.Pix[%d] = %d, want %d", i, img.Pix[i], w)
		}
	}
}
