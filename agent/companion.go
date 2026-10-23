package main

import (
	"fmt"
)

// isCompanionMode detecta a flag --companion nos args brutos (chamado antes
// do flag.Parse() principal em main.go, que não reconhece essa flag).
func isCompanionMode(args []string) bool {
	for _, a := range args {
		if a == "--companion" {
			return true
		}
	}
	return false
}

// runCompanion é o entry point do modo companion — roda na sessão
// interativa do usuário (lançado pelo serviço via CreateProcessAsUser),
// nunca no serviço (Session 0). Lê o mesmo config.json do serviço.
func runCompanion() error {
	initLogger("companion.log")

	cfg, err := loadConfigReadOnly()
	if err != nil {
		logWarn(fmt.Sprintf("companion: erro ao carregar config: %v — usando padrão.", err))
	}
	if cfg.ServerURL == "" || cfg.Token == "" {
		// Processo roda sem console (CreateProcessAsUser + CREATE_NO_WINDOW,
		// task futura) — log.Fatalf em main.go escreveria só no stderr, que
		// se perde sem console. Loga aqui, onde já temos companion.log
		// garantido pelo initLogger acima, antes de devolver o erro.
		err := fmt.Errorf("companion: ServerURL/Token ausentes — serviço ainda não registrou")
		logError(err.Error())
		return err
	}

	logInfo("Companion iniciado.")

	// stopCh ainda não é observado por este select — nenhuma task implementou
	// shutdown gracioso via pipe ainda. Até lá, o processo só encerra morto
	// externamente pelo serviço (TerminateProcess). Quando start/stop-live-
	// session (companionPipeLoop) ganhar um sinal de "encerrar", trocar este
	// select{} por `select { case <-stopCh: return nil }` pra sair de fato.
	stopCh := make(chan struct{})
	go activityReportLoop(cfg, stopCh)
	go companionPipeLoop(cfg, stopCh)

	select {} // bloqueia forever — processo companion vive até ser morto pelo serviço
}

// activityReportLoop é stub — implementação nas próximas tasks.
func activityReportLoop(cfg *Config, stopCh <-chan struct{}) {
	<-stopCh
}

// companionPipeLoop é stub — implementação nas próximas tasks.
func companionPipeLoop(cfg *Config, stopCh <-chan struct{}) {
	<-stopCh
}
