package main

import "testing"

func TestPickActiveSession(t *testing.T) {
	sessions := []sessionInfo{
		{ID: 0, State: wtsStateDisconnected},
		{ID: 1, State: wtsStateActive},
		{ID: 2, State: wtsStateConnected},
	}
	id, ok := pickActiveSession(sessions)
	if !ok || id != 1 {
		t.Fatalf("pickActiveSession = (%d, %v), want (1, true)", id, ok)
	}
}

func TestPickActiveSessionNoneActive(t *testing.T) {
	sessions := []sessionInfo{
		{ID: 0, State: wtsStateDisconnected},
	}
	_, ok := pickActiveSession(sessions)
	if ok {
		t.Fatal("esperava ok=false quando nenhuma sessão está ativa")
	}
}
