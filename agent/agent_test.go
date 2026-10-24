package main

import (
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// TestSessionWatchTick_BackoffEscalatesAcrossQuickDeaths é um teste de
// regressão direto pro bug encontrado na revisão final cross-cutting deste
// plano: recordCompanionLaunched resetava consecutiveLaunchFailures a cada
// CreateProcessAsUser bem-sucedido, não depois do companion sobreviver
// companionMinHealthyUptime — num ciclo "lança, morre rápido, lança de
// novo", o contador oscilava 0→1→0→1... pra sempre, e o backoff nunca
// escalava além de 15s (confirmado isolado antes do fix: 6 ciclos deram
// "tentativa 1, próxima em 15s" todas as vezes).
//
// Dirige sessionWatchTick de verdade (não as peças de estado isoladas) via
// enumerateSessionsFn/isCompanionAliveFn/launchCompanionFn/terminateCompanionFn
// mockados — achado 🟡 da 5ª rodada de revisão: a versão anterior deste
// teste chamava companionDiedQuickly/applyLaunchBackoff/recordCompanionLaunched
// direto, o que deixaria passar sem nenhum teste falhar: (a) tirar a chamada
// de resetBackoffIfCompanionHealthy de sessionWatchTick; (b) inverter a
// ordem das checagens de backoff/morte rápida; (c) a sequência
// saudável→reset→nova morte rápida não voltar a 15s. Cobre as 3 agora.
func TestSessionWatchTick_BackoffEscalatesAcrossQuickDeaths(t *testing.T) {
	origEnum, origAlive, origLaunch := enumerateSessionsFn, isCompanionAliveFn, launchCompanionFn
	defer func() { enumerateSessionsFn, isCompanionAliveFn, launchCompanionFn = origEnum, origAlive, origLaunch }()

	enumerateSessionsFn = func() ([]sessionInfo, error) {
		return []sessionInfo{{ID: 1, State: wtsStateActive}}, nil
	}
	launchCompanionFn = func(sessionID uint32) (uint32, windows.Handle, windows.Handle, error) {
		return 100, windows.Handle(1), windows.Handle(2), nil
	}
	alive := false
	isCompanionAliveFn = func(windows.Handle) bool { return alive }

	a := &Agent{terminateCompanionFn: func() {}} // no-op: nunca chama Win32 de verdade

	wantBackoffSecs := []int{15, 30, 60}
	for cycle, wantSecs := range wantBackoffSecs {
		alive = false
		a.nextLaunchAttemptAt = time.Time{} // libera o ciclo (simula o backoff anterior já ter expirado)

		a.sessionWatchTick() // tick 1: companion não está vivo → relança
		if a.companionLaunchedAt.IsZero() {
			t.Fatalf("ciclo %d: companionLaunchedAt zero após tick de lançamento", cycle)
		}

		a.sessionWatchTick() // tick 2: ainda não vivo, dentro de companionMinHealthyUptime → morte rápida

		wantBackoff := time.Duration(wantSecs) * time.Second
		gotBackoff := time.Until(a.nextLaunchAttemptAt)
		// Tolerância de 1s pro tempo de execução do teste em si.
		if gotBackoff < wantBackoff-time.Second || gotBackoff > wantBackoff+time.Second {
			t.Errorf("ciclo %d: backoff ≈ %v, want ≈%v (consecutiveLaunchFailures=%d) — backoff não escalou, bug reintroduzido",
				cycle, gotBackoff.Round(time.Second), wantBackoff, a.consecutiveLaunchFailures)
		}
		if !a.companionLaunchedAt.IsZero() {
			t.Errorf("ciclo %d: companionLaunchedAt não foi zerado após morte rápida contada — próximo tick contaria a mesma morte 2x", cycle)
		}
	}

	// Companion fica saudável por >= companionMinHealthyUptime: deve resetar.
	alive = false
	a.nextLaunchAttemptAt = time.Time{}
	a.sessionWatchTick() // relança (companionLaunchedAt estava zerado pela última morte rápida)
	if a.companionLaunchedAt.IsZero() {
		t.Fatal("esperava companion lançado antes do teste de reset")
	}
	a.companionLaunchedAt = time.Now().Add(-companionMinHealthyUptime - time.Second)
	alive = true
	a.sessionWatchTick() // vivo, mesma sessão, saudável há tempo suficiente → reset
	if a.consecutiveLaunchFailures != 0 {
		t.Fatalf("esperava consecutiveLaunchFailures == 0 após companion saudável, got %d", a.consecutiveLaunchFailures)
	}

	// Nova morte rápida DEPOIS do reset: o companion saudável morrendo não é
	// "morte rápida" (sobreviveu companionMinHealthyUptime) — relança direto,
	// e só a PRÓXIMA morte (agora sim rápida) deve contar como falha. O
	// backoff precisa voltar a ~15s, não continuar escalando de 60s.
	alive = false
	a.sessionWatchTick() // companion (antigo, saudável) morreu → relança direto, sem contar falha
	if a.consecutiveLaunchFailures != 0 {
		t.Fatalf("relançamento de companion que foi saudável não deveria contar como falha, got consecutiveLaunchFailures=%d", a.consecutiveLaunchFailures)
	}
	a.sessionWatchTick() // morte rápida do companion recém-relançado → agora sim conta
	gotBackoff := time.Until(a.nextLaunchAttemptAt)
	want := 15 * time.Second
	if gotBackoff < want-time.Second || gotBackoff > want+time.Second {
		t.Errorf("backoff pós-reset ≈ %v, want ≈15s — reset não voltou a escalada ao início", gotBackoff.Round(time.Second))
	}
}

// TestResetBackoffIfCompanionHealthy confirma que o backoff só reseta
// depois do companion ficar vivo, na sessão certa, por pelo menos
// companionMinHealthyUptime — não no instante em que nasce.
func TestResetBackoffIfCompanionHealthy(t *testing.T) {
	t.Run("reseta quando saudável há tempo suficiente", func(t *testing.T) {
		a := &Agent{consecutiveLaunchFailures: 3, nextLaunchAttemptAt: time.Now().Add(time.Minute)}
		a.companionLaunchedAt = time.Now().Add(-companionMinHealthyUptime - time.Second)

		a.resetBackoffIfCompanionHealthy(true, false)

		if a.consecutiveLaunchFailures != 0 {
			t.Errorf("consecutiveLaunchFailures = %d, want 0", a.consecutiveLaunchFailures)
		}
		if !a.nextLaunchAttemptAt.IsZero() {
			t.Errorf("nextLaunchAttemptAt = %v, want zero", a.nextLaunchAttemptAt)
		}
	})

	t.Run("não reseta se ainda não passou companionMinHealthyUptime", func(t *testing.T) {
		a := &Agent{consecutiveLaunchFailures: 3}
		a.companionLaunchedAt = time.Now() // recém-lançado

		a.resetBackoffIfCompanionHealthy(true, false)

		if a.consecutiveLaunchFailures != 3 {
			t.Errorf("consecutiveLaunchFailures = %d, want 3 (não deveria resetar ainda)", a.consecutiveLaunchFailures)
		}
	})

	t.Run("não reseta se não está vivo", func(t *testing.T) {
		a := &Agent{consecutiveLaunchFailures: 3}
		a.companionLaunchedAt = time.Now().Add(-companionMinHealthyUptime - time.Second)

		a.resetBackoffIfCompanionHealthy(false, false)

		if a.consecutiveLaunchFailures != 3 {
			t.Errorf("consecutiveLaunchFailures = %d, want 3 (companion não está vivo)", a.consecutiveLaunchFailures)
		}
	})

	t.Run("não reseta se a sessão mudou", func(t *testing.T) {
		a := &Agent{consecutiveLaunchFailures: 3}
		a.companionLaunchedAt = time.Now().Add(-companionMinHealthyUptime - time.Second)

		a.resetBackoffIfCompanionHealthy(true, true)

		if a.consecutiveLaunchFailures != 3 {
			t.Errorf("consecutiveLaunchFailures = %d, want 3 (sessão mudou)", a.consecutiveLaunchFailures)
		}
	})
}
