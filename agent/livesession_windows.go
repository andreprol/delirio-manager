package main

import (
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const liveSessionFPS = 10

func liveSessionFrameIntervalMs() int {
	return 1000 / liveSessionFPS
}

type liveSessionHandle struct {
	stopCh chan struct{}
}

var (
	liveSessionsMu sync.Mutex
	liveSessions   = map[string]*liveSessionHandle{}
)

// startLiveSession conecta no WebSocket /live do servidor como companion e
// começa a transmitir frames de tela em loop, até stopLiveSession ser
// chamado ou a conexão cair. Devolve false se sessionID já estava ativo
// (start duplicado ignorado) — o chamador (handleCompanionPipeMessage) usa
// esse retorno, não um pre-check separado, pra decidir Error vs sucesso no
// ACK: um pre-check via isLiveSessionActive teria uma janela de
// check-then-act real (a pipe aceita conexões concorrentes de qualquer
// processo do mesmo usuário, ver pipeSecurityDescriptor) entre o check e
// esta chamada, fazendo o ACK mentir sobre o que de fato aconteceu. Não
// testável em CI de ponta a ponta (exige desktop real + servidor real) —
// verificar manualmente.
func startLiveSession(sessionID, mode, companionToken, serverURL string) bool {
	liveSessionsMu.Lock()
	if _, exists := liveSessions[sessionID]; exists {
		liveSessionsMu.Unlock()
		logWarn(fmt.Sprintf("companion: sessão %s já está ativa, ignorando start duplicado", sessionID))
		return false
	}
	handle := &liveSessionHandle{stopCh: make(chan struct{})}
	liveSessions[sessionID] = handle
	liveSessionsMu.Unlock()

	wsURL := buildLiveWebSocketURL(serverURL, sessionID, companionToken)

	safeGo("liveSession-"+sessionID, func() {
		runLiveSessionLoop(sessionID, wsURL, mode, handle.stopCh)
		// IMPORTANTE (correção de concorrência): só remove do mapa se a
		// entrada ainda for ESTE handle específico, não qualquer coisa que
		// esteja sob esta sessionID no momento. Sem essa checagem de
		// identidade, uma corrida entre stop+start rápidos pra mesma
		// sessionID faria esta goroutine antiga deletar a entrada de uma
		// sessão NOVA (já re-registrada), deixando-a invisível no mapa —
		// stopLiveSession subsequente não encontraria nada pra parar, e o
		// stopCh da sessão nova nunca seria fechado (goroutine leak
		// permanente).
		liveSessionsMu.Lock()
		if liveSessions[sessionID] == handle {
			delete(liveSessions, sessionID)
		}
		liveSessionsMu.Unlock()
	})
	return true
}

func stopLiveSession(sessionID string) {
	liveSessionsMu.Lock()
	defer liveSessionsMu.Unlock()
	if handle, exists := liveSessions[sessionID]; exists {
		close(handle.stopCh)
		delete(liveSessions, sessionID)
	}
}

// isLiveSessionActive reporta se sessionID já tem um streaming em
// andamento. Consulta pura, sem efeito colateral — hoje sem consumidor de
// produção (o case "start-live-session" de handleCompanionPipeMessage usou
// isto como pre-check numa versão anterior, mas isso tinha uma janela real
// de check-then-act; foi substituído pelo retorno de startLiveSession, que
// decide sob o mesmo lock sem essa janela). Mantida como utilitário de
// consulta — útil pra um futuro comando de status, por exemplo — só o
// teste TestIsLiveSessionActive a exercita por ora.
func isLiveSessionActive(sessionID string) bool {
	liveSessionsMu.Lock()
	defer liveSessionsMu.Unlock()
	_, exists := liveSessions[sessionID]
	return exists
}

func buildLiveWebSocketURL(serverURL, sessionID, companionToken string) string {
	wsBase := strings.Replace(serverURL, "https://", "wss://", 1)
	wsBase = strings.Replace(wsBase, "http://", "ws://", 1)
	q := url.Values{}
	q.Set("sessionId", sessionID)
	q.Set("role", "companion")
	q.Set("token", companionToken)
	return wsBase + "/live?" + q.Encode()
}

// redactLiveSessionURL troca o valor do parâmetro "token" por "REDACTED"
// pra uso em log — a URL completa carrega o companionToken em texto claro
// na query string, e logError/logWarn persistem em companion.log em disco
// (224 máquinas); nunca logar a URL crua.
func redactLiveSessionURL(wsURL string) string {
	parsed, err := url.Parse(wsURL)
	if err != nil {
		return "<url inválida>"
	}
	q := parsed.Query()
	if q.Get("token") != "" {
		q.Set("token", "REDACTED")
		parsed.RawQuery = q.Encode()
	}
	return parsed.String()
}

// liveSessionWriteTimeout limita quanto tempo uma escrita de frame pode
// bloquear. Sem deadline, uma rede degradada (cabo solto, NAT morto) faz
// WriteMessage bloquear por timeouts de TCP na ordem de minutos — e como o
// select do loop só observa stopCh entre iterações, um write pendente
// impede stopLiveSession de encerrar a sessão prontamente mesmo após o
// canal já ter sido fechado.
const liveSessionWriteTimeout = 2 * time.Second

func runLiveSessionLoop(sessionID, wsURL, mode string, stopCh <-chan struct{}) {
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		logError(fmt.Sprintf("companion: falha ao conectar em %s: %v", redactLiveSessionURL(wsURL), err))
		return
	}
	defer conn.Close()

	// Normal mode: lê mensagens de input numa goroutine separada e injeta
	// via SendInput. Shadow: o servidor nunca repassa input pra cá, mas o
	// companion não assume isso — só processa se algo chegar. safeGo (não
	// `go` puro) porque handleLiveSessionInput vai processar dado vindo
	// direto da rede (Task 12/SendInput) — panic ali não pode derrubar o
	// processo do agent inteiro.
	safeGo("liveSession-reader-"+sessionID, func() { readLiveSessionInput(conn) })

	ticker := time.NewTicker(time.Duration(liveSessionFrameIntervalMs()) * time.Millisecond)
	defer ticker.Stop()

	captureFailures := 0
	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			if !sendLiveSessionFrame(conn, sessionID, &captureFailures) {
				return
			}
		}
	}
}

// readLiveSessionInput lê mensagens da conexão até ela cair (erro de rede
// ou conn.Close() chamado pelo defer de runLiveSessionLoop ao encerrar).
func readLiveSessionInput(conn *websocket.Conn) {
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		handleLiveSessionInput(data)
	}
}

// frameWriter é o subconjunto de *websocket.Conn que sendLiveSessionFrame
// precisa — extraído pra permitir testar a lógica de contagem de falhas/
// throttle de log/recuperação (a parte rica desta função) com um fake, sem
// discar um WebSocket real.
type frameWriter interface {
	SetWriteDeadline(time.Time) error
	WriteMessage(messageType int, data []byte) error
}

// sendLiveSessionFrame captura e envia um frame. Retorna false quando o
// loop de runLiveSessionLoop deve encerrar a sessão (falha de escrita —
// conexão provavelmente morta); falha de captura é só pulada (true), já
// que é tipicamente transitória.
func sendLiveSessionFrame(conn frameWriter, sessionID string, captureFailures *int) bool {
	frame, err := captureScreenJPEGFn(defaultJPEGQuality)
	if err != nil {
		*captureFailures++
		// Loga só a 1ª falha consecutiva — evita inundar companion.log a
		// 10Hz se a captura começar a falhar de forma persistente (ex.:
		// permissão revogada).
		if *captureFailures == 1 {
			logWarn(fmt.Sprintf("companion: falha ao capturar frame (sessão %s): %v", sessionID, err))
		}
		return true
	}
	if *captureFailures > 0 {
		logInfo(fmt.Sprintf("companion: captura de frame recuperada após %d falha(s) consecutiva(s) (sessão %s)", *captureFailures, sessionID))
		*captureFailures = 0
	}
	if err := conn.SetWriteDeadline(time.Now().Add(liveSessionWriteTimeout)); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao definir write deadline (sessão %s): %v", sessionID, err))
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao enviar frame, encerrando sessão %s: %v", sessionID, err))
		return false
	}
	return true
}

// handleLiveSessionInput ainda não faz nada — a Task 12 implementa a
// injeção via SendInput (só mode Normal).
func handleLiveSessionInput(data []byte) {
	// Implementado na Task 12 (SendInput).
}
