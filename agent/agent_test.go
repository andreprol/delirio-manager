package main

import (
	"fmt"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// TestCompanionBackoffEscalatesAcrossQuickDeaths é um teste de regressão
// direto pro bug encontrado na revisão final cross-cutting deste plano:
// recordCompanionLaunched resetava consecutiveLaunchFailures a cada
// CreateProcessAsUser bem-sucedido, não depois do companion sobreviver
// companionMinHealthyUptime — num ciclo "lança, morre rápido, lança de
// novo", o contador oscilava 0→1→0→1... pra sempre, e o backoff nunca
// escalava além de 15s (confirmado isolado antes do fix: 6 ciclos deram
// "tentativa 1, próxima em 15s" todas as vezes).
//
// Dirige as peças puras do estado (companionDiedQuickly/applyLaunchBackoff/
// recordCompanionLaunched) direto, sem chamar sessionWatchTick inteiro —
// essa função depende de enumerateSessions/isCompanionAlive/launchCompanion
// (syscalls Win32 reais, não testáveis em CI), mas a lógica de backoff em
// si é pura e não devia precisar deles pra ser verificada.
func TestCompanionBackoffEscalatesAcrossQuickDeaths(t *testing.T) {
	a := &Agent{}

	wantBackoffSecs := []int{15, 30, 60}
	for cycle, wantSecs := range wantBackoffSecs {
		// "Lança" com sucesso — recordCompanionLaunched NÃO deve resetar
		// o contador de falhas (ele só reseta depois de companionMinHealthyUptime
		// de uptime real, via resetBackoffIfCompanionHealthy).
		a.recordCompanionLaunched(1, 100, windows.Handle(1), windows.Handle(2))

		// Simula o companion morrendo rápido (companionLaunchedAt no
		// passado, dentro da janela de companionMinHealthyUptime).
		a.companionLaunchedAt = time.Now().Add(-1 * time.Second)

		if !a.companionDiedQuickly(false /* alive */, false /* sessionChanged */) {
			t.Fatalf("ciclo %d: companionDiedQuickly = false, want true", cycle)
		}
		a.applyLaunchBackoff(fmt.Errorf("morte simulada no ciclo %d", cycle))

		wantBackoff := time.Duration(wantSecs) * time.Second
		gotBackoff := time.Until(a.nextLaunchAttemptAt)
		// Tolerância de 1s pro tempo de execução do teste em si.
		if gotBackoff < wantBackoff-time.Second || gotBackoff > wantBackoff+time.Second {
			t.Errorf("ciclo %d: backoff ≈ %v, want ≈%v (consecutiveLaunchFailures=%d) — backoff não escalou, bug reintroduzido",
				cycle, gotBackoff.Round(time.Second), wantBackoff, a.consecutiveLaunchFailures)
		}

		// Simula o backoff expirando, pra liberar o próximo ciclo.
		a.nextLaunchAttemptAt = time.Time{}
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
