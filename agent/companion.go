package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
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

// ActivityPayload é o corpo JSON de POST /api/activity.
type ActivityPayload struct {
	WindowTitle string `json:"windowTitle"`
	ProcessName string `json:"processName"`
}

func buildActivityPayload(windowTitle, processName string) ActivityPayload {
	return ActivityPayload{WindowTitle: windowTitle, ProcessName: processName}
}

const activityReportIntervalSecs = 4

// activityReportLoop reporta a janela em foco pro servidor a cada ~4s
// (ver spec: "3-5s"). Erros de captura ou de rede não derrubam o loop —
// só pula o ciclo e tenta de novo no próximo tick.
func activityReportLoop(cfg *Config, stopCh <-chan struct{}) {
	ticker := time.NewTicker(activityReportIntervalSecs * time.Second)
	defer ticker.Stop()
	client := &http.Client{Timeout: 10 * time.Second}

	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			title, proc, err := captureForegroundWindow()
			if err != nil {
				continue // sem janela em foco (ex: tela de login) — tenta de novo no próximo tick
			}
			payload := buildActivityPayload(title, proc)
			if err := sendActivityPayload(client, cfg, payload); err != nil {
				logWarn(fmt.Sprintf("companion: erro ao reportar atividade: %v", err))
			}
		}
	}
}

func sendActivityPayload(client *http.Client, cfg *Config, payload ActivityPayload) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", cfg.ServerURL+"/api/activity", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("servidor retornou status %d", resp.StatusCode)
	}
	return nil
}

// companionPipeLoop é stub — implementação nas próximas tasks.
func companionPipeLoop(cfg *Config, stopCh <-chan struct{}) {
	<-stopCh
}
