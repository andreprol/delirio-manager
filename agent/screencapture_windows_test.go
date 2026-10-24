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
