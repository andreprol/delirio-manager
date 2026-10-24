package main

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// buildTestEnvBlock monta um bloco de ambiente (formato CreateEnvironmentBlock:
// strings UTF16 terminadas em \0, bloco inteiro terminado em \0 duplo) a
// partir de entradas "KEY=VALUE" — simula o que CreateEnvironmentBlock
// devolveria, sem precisar de um token Windows real.
func buildTestEnvBlock(t *testing.T, entries ...string) *uint16 {
	t.Helper()
	var buf []uint16
	for _, e := range entries {
		u, err := windows.UTF16FromString(e)
		if err != nil {
			t.Fatalf("UTF16FromString(%q): %v", e, err)
		}
		buf = append(buf, u...)
	}
	buf = append(buf, 0)
	return &buf[0]
}

// parseTestEnvBlock desfaz buildTestEnvBlock — usado só pra ler de volta o
// que injectFeatureFlagIntoEnvBlock produziu, nas asserções do teste.
func parseTestEnvBlock(block *uint16) []string {
	var entries []string
	start := 0
	for i := 0; ; i++ {
		c := *(*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(block)) + uintptr(i)*2))
		if c != 0 {
			continue
		}
		if i == start {
			break
		}
		entries = append(entries, windows.UTF16ToString(unsafe.Slice(block, i)[start:i]))
		start = i + 1
	}
	return entries
}

func TestInjectFeatureFlagIntoEnvBlock(t *testing.T) {
	t.Run("sobrescreve valor existente sem duplicar nem afetar outras entradas", func(t *testing.T) {
		block := buildTestEnvBlock(t, `PATH=C:\x`, "FEATURE_LIVE_ACCESS=false", `TEMP=C:\temp`)
		patched, err := injectFeatureFlagIntoEnvBlock(block, "FEATURE_LIVE_ACCESS", "true")
		if err != nil {
			t.Fatalf("erro inesperado: %v", err)
		}
		// injectFeatureFlagIntoEnvBlock filtra a entrada antiga e reanexa a
		// nova no FIM da lista — ordem de variável de ambiente não importa
		// pro Windows (lookup é por chave), então a posição final esperada
		// aqui reflete o comportamento real da função, não uma ordem
		// "preservada" que ela nunca prometeu.
		got := parseTestEnvBlock(patched)
		want := []string{`PATH=C:\x`, `TEMP=C:\temp`, "FEATURE_LIVE_ACCESS=true"}
		if len(got) != len(want) {
			t.Fatalf("got = %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("entrada[%d] = %q, want %q", i, got[i], want[i])
			}
		}
	})

	t.Run("case-insensitive: KEY minúsculo existente também é sobrescrito", func(t *testing.T) {
		block := buildTestEnvBlock(t, "feature_live_access=false")
		patched, err := injectFeatureFlagIntoEnvBlock(block, "FEATURE_LIVE_ACCESS", "true")
		if err != nil {
			t.Fatalf("erro inesperado: %v", err)
		}
		got := parseTestEnvBlock(patched)
		if len(got) != 1 || got[0] != "FEATURE_LIVE_ACCESS=true" {
			t.Errorf("got = %v, want [\"FEATURE_LIVE_ACCESS=true\"] (case-insensitive, sem duplicar)", got)
		}
	})

	t.Run("adiciona quando a key não existia", func(t *testing.T) {
		block := buildTestEnvBlock(t, `PATH=C:\x`)
		patched, err := injectFeatureFlagIntoEnvBlock(block, "FEATURE_LIVE_ACCESS", "true")
		if err != nil {
			t.Fatalf("erro inesperado: %v", err)
		}
		got := parseTestEnvBlock(patched)
		want := []string{`PATH=C:\x`, "FEATURE_LIVE_ACCESS=true"}
		if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
			t.Errorf("got = %v, want %v", got, want)
		}
	})
}

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
