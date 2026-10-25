package main

import (
	"testing"
)

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

func TestShouldRelaunchCompanion(t *testing.T) {
	cases := []struct {
		name           string
		companionAlive bool
		sessionChanged bool
		want           bool
	}{
		{"companion morto, sessão igual", false, false, true},
		{"companion vivo, sessão igual", true, false, false},
		{"companion vivo, sessão mudou (logoff/logon)", true, true, true},
		{"companion morto, sessão mudou", false, true, true},
	}
	for _, c := range cases {
		got := shouldRelaunchCompanion(c.companionAlive, c.sessionChanged)
		if got != c.want {
			t.Errorf("%s: shouldRelaunchCompanion(%v, %v) = %v, want %v",
				c.name, c.companionAlive, c.sessionChanged, got, c.want)
		}
	}
}
