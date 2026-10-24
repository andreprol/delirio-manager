package main

import "testing"

func TestLiveSessionFrameIntervalMs(t *testing.T) {
	// ~10fps conforme spec (sessão ao vivo fluida) = 100ms entre frames
	if ms := liveSessionFrameIntervalMs(); ms != 100 {
		t.Errorf("liveSessionFrameIntervalMs() = %d, want 100", ms)
	}
}
