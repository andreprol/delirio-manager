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

func TestPickReconnectableSession(t *testing.T) {
	t.Run("escolhe sessão Disconnected não-zero com WinStationName vazio (era o console)", func(t *testing.T) {
		sessions := []sessionInfo{
			{ID: 0, State: wtsStateDisconnected, WinStationName: ""},
			{ID: 1, State: wtsStateDisconnected, WinStationName: ""},
		}
		id, ok := pickReconnectableSession(sessions)
		if !ok || id != 1 {
			t.Fatalf("pickReconnectableSession = (%d, %v), want (1, true)", id, ok)
		}
	})

	// Regressão direta do finding 🔴 CRÍTICO do code-reviewer (31/10/2026):
	// sessão RDP abandonada sem logoff mantém WinStationName ("RDP-Tcp#N")
	// mesmo Disconnected — nunca pode ser puxada pro console físico da loja.
	t.Run("NUNCA escolhe sessão Disconnected com WinStationName não-vazio (RDP abandonado)", func(t *testing.T) {
		sessions := []sessionInfo{{ID: 3, State: wtsStateDisconnected, WinStationName: "RDP-Tcp#2"}}
		_, ok := pickReconnectableSession(sessions)
		if ok {
			t.Fatal("esperava ok=false — sessão com WinStationName não-vazio é RDP/remota, nunca candidata ao console")
		}
	})

	// Finding 🟠 ALTO do code-reviewer: Connected não foi validado ao vivo
	// (pode ser handshake de RDP conectando) — só Disconnected é candidato.
	t.Run("ignora sessão Connected (não validado, só Disconnected é candidato)", func(t *testing.T) {
		sessions := []sessionInfo{{ID: 2, State: wtsStateConnected, WinStationName: ""}}
		_, ok := pickReconnectableSession(sessions)
		if ok {
			t.Fatal("esperava ok=false — wtsStateConnected não é candidato a reconexão")
		}
	})

	t.Run("nunca escolhe sessão 0 (Services)", func(t *testing.T) {
		sessions := []sessionInfo{{ID: 0, State: wtsStateDisconnected, WinStationName: ""}}
		_, ok := pickReconnectableSession(sessions)
		if ok {
			t.Fatal("esperava ok=false — sessão 0 (Services) nunca é candidata a reconexão")
		}
	})

	t.Run("ignora sessão Active (já coberta por pickActiveSession)", func(t *testing.T) {
		sessions := []sessionInfo{{ID: 1, State: wtsStateActive, WinStationName: "Console"}}
		_, ok := pickReconnectableSession(sessions)
		if ok {
			t.Fatal("esperava ok=false — sessão Active não é candidata a RECONEXÃO")
		}
	})

	t.Run("sem sessões", func(t *testing.T) {
		_, ok := pickReconnectableSession(nil)
		if ok {
			t.Fatal("esperava ok=false com lista vazia")
		}
	})
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
