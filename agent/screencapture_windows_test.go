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
