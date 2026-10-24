package main

import (
	"testing"

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
// que injectFeatureFlagIntoEnvBlock produziu, nas asserções do teste. Chama
// a MESMA parseEnvBlockEntries que a produção usa (não uma cópia do loop
// de parsing) — só decodifica pra string pra facilitar a asserção.
// TestParseEnvBlockEntries, abaixo, testa o parser em si de forma
// independente, então usá-lo aqui pra verificar injectFeatureFlagIntoEnvBlock
// não é circular.
func parseTestEnvBlock(block *uint16) []string {
	var entries []string
	for _, raw := range parseEnvBlockEntries(block) {
		entries = append(entries, windows.UTF16ToString(raw))
	}
	return entries
}

// TestParseEnvBlockEntries testa o parser em si (usado tanto por produção
// quanto pelo teste acima), isoladamente, cobrindo os edge cases que
// motivaram extraí-lo: bloco vazio, valor contendo "=", e uma chave que é
// prefixo de outra (não deve colidir — a comparação de prefixo em
// injectFeatureFlagIntoEnvBlock inclui o "=" justamente pra evitar isso).
func TestParseEnvBlockEntries(t *testing.T) {
	t.Run("bloco vazio", func(t *testing.T) {
		block := buildTestEnvBlock(t)
		got := parseEnvBlockEntries(block)
		if len(got) != 0 {
			t.Errorf("got = %v, want vazio", got)
		}
	})

	t.Run("valor contendo sinal de igual", func(t *testing.T) {
		block := buildTestEnvBlock(t, `SOME_PATH=C:\a=b\c`)
		got := parseEnvBlockEntries(block)
		if len(got) != 1 || windows.UTF16ToString(got[0]) != `SOME_PATH=C:\a=b\c` {
			t.Errorf("got = %v, want [%q]", got, `SOME_PATH=C:\a=b\c`)
		}
	})

	t.Run("chave prefixo de outra não colide", func(t *testing.T) {
		block := buildTestEnvBlock(t, "FEATURE_LIVE_ACCESS=true", "FEATURE_LIVE_ACCESS_X=outra-coisa")
		got := parseEnvBlockEntries(block)
		if len(got) != 2 {
			t.Fatalf("got %d entradas, want 2", len(got))
		}
		if windows.UTF16ToString(got[0]) != "FEATURE_LIVE_ACCESS=true" || windows.UTF16ToString(got[1]) != "FEATURE_LIVE_ACCESS_X=outra-coisa" {
			t.Errorf("got = %v", got)
		}
	})
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

	t.Run("não colide com chave que é prefixo de outra", func(t *testing.T) {
		block := buildTestEnvBlock(t, "FEATURE_LIVE_ACCESS_X=outra-coisa")
		patched, err := injectFeatureFlagIntoEnvBlock(block, "FEATURE_LIVE_ACCESS", "true")
		if err != nil {
			t.Fatalf("erro inesperado: %v", err)
		}
		got := parseTestEnvBlock(patched)
		want := []string{"FEATURE_LIVE_ACCESS_X=outra-coisa", "FEATURE_LIVE_ACCESS=true"}
		if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
			t.Errorf("got = %v, want %v (FEATURE_LIVE_ACCESS_X não deveria ser removida)", got, want)
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
