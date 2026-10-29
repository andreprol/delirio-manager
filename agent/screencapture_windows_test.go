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
