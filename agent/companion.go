package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
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

	// Instância única garantida por companionPipeLoop (não por um probe
	// separado aqui): se já existir outra instância servindo a pipe,
	// winio.ListenPipe falha (FILE_CREATE na 1ª instância) e
	// companionPipeLoop encerra o processo. Um probe prévio seria só
	// check-then-act redundante — winio.ListenPipe JÁ É a checagem atômica
	// de instância única que importa.
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
	// shutdown gracioso via pipe ainda. Até lá, o processo encerra de 3
	// formas: (1) morto externamente pelo serviço via terminateCompanion
	// (agent.go/updater.go — TerminateProcess de verdade, não só
	// CloseHandle), (2) morto pelo Job Object (kill-on-close) se o serviço
	// morrer sem passar por (1), ou (3) sozinho, via os.Exit em
	// companionPipeLoop, se não conseguir abrir a pipe (ver listenPipe,
	// pipe_windows.go). Quando start/stop-live-session (companionPipeLoop)
	// ganhar um sinal de "encerrar" normal, trocar este select{} por
	// `select { case <-stopCh: return nil }` pra sair de fato.
	stopCh := make(chan struct{})
	// FEATURE_LIVE_ACCESS: mesma flag do server (ver server/app.js) — feature
	// ainda incompleta (Task 3/13 do agente), nunca reportar atividade pro
	// servidor antes dele ter a rota /api/activity habilitada, senão as 224
	// máquinas martelam 404 a cada 4s indefinidamente.
	if featureLiveAccessEnabled() {
		go activityReportLoop(cfg, stopCh)
	}
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
	// Timeout menor que o intervalo do ticker: se uma request atrasasse mais
	// que activityReportIntervalSecs, a cadência real divergiria em silêncio
	// do "~4s" documentado acima (o time.Ticker descarta ticks em atraso em
	// vez de empilhar, então não há corrida — só relatório atrasado sem log).
	client := &http.Client{Timeout: 3 * time.Second}
	consecutiveFailures := 0

	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			title, proc, err := captureForegroundWindow()
			if err != nil {
				continue // sem janela em foco (ex: tela de login) — tenta de novo no próximo tick
			}
			payload := buildActivityPayload(title, friendlyProcessName(proc))
			if err := sendActivityPayload(client, cfg, payload); err != nil {
				consecutiveFailures++
				// Loga só a 1ª falha — se o servidor cair, evita ~21.600
				// linhas/dia (e outras tantas no Windows Event Log, que não
				// tem a mesma rotação de companion.log) repetindo o mesmo erro.
				if consecutiveFailures == 1 {
					logWarn(fmt.Sprintf("companion: erro ao reportar atividade: %v", err))
				}
				continue
			}
			if consecutiveFailures > 0 {
				logInfo(fmt.Sprintf("companion: report de atividade recuperado após %d falha(s) consecutiva(s)", consecutiveFailures))
				consecutiveFailures = 0
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
	// Drena o body antes de fechar — sem isso o http.Transport não devolve a
	// conexão pro pool keep-alive, forçando handshake TCP/TLS novo a cada
	// tick (relevante a 1 req/4s por máquina em 224 máquinas).
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("servidor retornou status %d", resp.StatusCode)
	}
	return nil
}

// companionPipeLoop roda no companion: abre a pipe local e despacha cada
// mensagem recebida do serviço pra handleCompanionPipeMessage. Fecha cfg
// sobre o handler (closure) porque listenPipe exige func(pipeMessage)
// pipeMessage — cfg não cabe na assinatura do protocolo da pipe.
func companionPipeLoop(cfg *Config, stopCh <-chan struct{}) {
	err := listenPipe(func(msg pipeMessage) pipeMessage {
		return handleCompanionPipeMessage(msg, cfg)
	}, stopCh)
	if err != nil {
		// Fatal: sem pipe aberta este companion não atende nenhum comando
		// (nenhum capture-screenshot/start-live-session chega) e pode estar
		// competindo por uma pipe que um órfão da sessão anterior ainda
		// detém (ver garantia de instância única em runCompanion). Sai e
		// deixa sessionWatchLoop (serviço) relançar com backoff, em vez de
		// ficar vivo pra sempre em select{} sem funcionar.
		logError(fmt.Sprintf("companion: listenPipe falhou, encerrando processo: %v", err))
		os.Exit(1)
	}
}

// handleCompanionPipeMessage despacha mensagens recebidas do serviço via
// pipe. Testável isoladamente (não depende do listener de pipe em si).
//
// cfg é o config do COMPANION, carregado localmente por runCompanion via
// loadConfigReadOnly — nunca msg.ServerURL. A pipe aceita conexões
// concorrentes de qualquer processo rodando sob o mesmo SID do usuário
// (ver pipeSecurityDescriptor), não só do serviço; confiar em ServerURL
// vindo da mensagem deixaria um processo local não relacionado instruir o
// companion a transmitir a tela do usuário (10fps, mode Normal/Shadow) pra
// um servidor arbitrário — exfiltração completa, não só ruído/DoS local.
// cfg.ServerURL garante que o companion só conecta no servidor real,
// mesmo que o resto da mensagem tenha vindo de um processo não confiável.
func handleCompanionPipeMessage(msg pipeMessage, cfg *Config) pipeMessage {
	switch msg.Type {
	case "capture-screenshot":
		jpegBytes, err := captureScreenJPEGFn(defaultJPEGQuality)
		if err != nil {
			return pipeMessage{RequestID: msg.RequestID, Error: err.Error()}
		}
		return pipeMessage{
			RequestID:        msg.RequestID,
			ResultJPEGBase64: base64.StdEncoding.EncodeToString(jpegBytes),
		}
	case "start-live-session":
		if msg.SessionID == "" {
			// A pipe é uma fronteira de confiança própria — o ACL (ver
			// pipeSecurityDescriptor) permite qualquer processo do mesmo
			// usuário conectar, não só o serviço. Não confiar ciegamente no
			// que chega, mesmo padrão já validado em commands.go pro lado
			// do serviço (handleStartLiveSession/handleStopLiveSession).
			return pipeMessage{RequestID: msg.RequestID, Error: "start-live-session: sessionId obrigatório e ausente"}
		}
		logInfo(fmt.Sprintf("companion: start-live-session recebido (sessão %s, mode %s)", msg.SessionID, msg.Mode))
		// startLiveSessionFn devolve o resultado real (não um pre-check
		// separado via isLiveSessionActive) — um pre-check teria uma janela
		// de check-then-act real entre ele e esta chamada (pipe aceita
		// conexões concorrentes), fazendo o ACK mentir sobre duplicata.
		// cfg.ServerURL (local), nunca msg.ServerURL — ver comentário da
		// função sobre por quê.
		if !startLiveSessionFn(msg.SessionID, msg.Mode, msg.CompanionToken, cfg.ServerURL) {
			return pipeMessage{RequestID: msg.RequestID, Error: fmt.Sprintf("sessão %s já está ativa", msg.SessionID)}
		}
		return pipeMessage{RequestID: msg.RequestID}
	case "stop-live-session":
		if msg.SessionID == "" {
			return pipeMessage{RequestID: msg.RequestID, Error: "stop-live-session: sessionId obrigatório e ausente"}
		}
		logInfo(fmt.Sprintf("companion: stop-live-session recebido (sessão %s)", msg.SessionID))
		stopLiveSessionFn(msg.SessionID)
		return pipeMessage{RequestID: msg.RequestID}
	default:
		return pipeMessage{RequestID: msg.RequestID, Error: fmt.Sprintf("tipo de mensagem desconhecido: %s", msg.Type)}
	}
}

// startLiveSessionFn e stopLiveSessionFn apontam pra implementação real em
// livesession_windows.go (conexão WebSocket /live + loop de frames). Vars
// (não funções fixas) pra serem mockáveis em teste, mesmo padrão já usado
// neste pacote (captureScreenJPEGFn) e em commands.go/pipe_windows.go
// (requestScreenshotFromCompanionFn/sendPipeRequestFn).
//
// Var global mutável, mesmo cuidado das outras: nenhum teste deste pacote
// usa t.Parallel() hoje; não adicionar enquanto mocks destas vars existirem,
// ou corrompe outros testes silenciosamente.
var startLiveSessionFn = startLiveSession // bool: false = duplicado, ignorado
var stopLiveSessionFn = stopLiveSession
