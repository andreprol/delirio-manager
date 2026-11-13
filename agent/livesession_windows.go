package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

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
		runLiveSessionWithReconnect(sessionID, wsURL, mode, handle.stopCh)
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

// sessionInfoMsg é o protocolo de volta pro dashboard (companion → relay →
// dashboard), mandado 1x no início da sessão — mesmo canal de texto já
// usado pelo status de transferência de arquivo (ver
// filetransfer_windows.go, fileTransferStatus). RemoteUser é o username
// REAL da sessão interativa onde o companion roda.
type sessionInfoMsg struct {
	Type       string `json:"type"` // "session-info"
	RemoteUser string `json:"remoteUser"`
}

var (
	advapi32         = syscall.NewLazyDLL("advapi32.dll")
	procGetUserNameW = advapi32.NewProc("GetUserNameW")
)

// maxUserNameChars: UNLEN+1 (256+1), o limite documentado da Win32 API pra
// nome de usuário — buffer fixo, sem retry: generoso o bastante pra nunca
// precisar de 2ª chamada na prática.
const maxUserNameChars = 257

// currentUserNameFn é a indireção testável de currentUserName — mesmo
// padrão de injectMouseMoveFn/startLiveSessionFn no projeto.
var currentUserNameFn = currentUserName

// currentUserName devolve o username real do processo chamador —
// CreateProcessAsUser (session_windows.go) garante que o companion roda SOB
// a sessão interativa do usuário da loja, então "quem sou eu" já é a
// resposta certa, sem precisar de WTSQuerySessionInformation nem de token
// de outro processo.
func currentUserName() (string, error) {
	buf := make([]uint16, maxUserNameChars)
	size := uint32(len(buf))
	ret, _, err := procGetUserNameW.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if ret == 0 {
		return "", fmt.Errorf("GetUserNameW falhou: %w", err)
	}
	// size, depois da chamada, inclui o terminador nulo — size-1 é o
	// tamanho real da string.
	return syscall.UTF16ToString(buf[:size-1]), nil
}

// sendSessionInfo busca o username local e manda o session-info — qualquer
// falha (GetUserNameW, serialização, escrita no WS) só loga, nunca impede
// a sessão de vídeo/input de seguir funcionando (ver comentário no
// chamador, runLiveSessionLoop).
func sendSessionInfo(w frameWriter, sessionID string) {
	username, err := currentUserNameFn()
	if err != nil {
		logWarn(fmt.Sprintf("companion: falha ao obter username local (sessão %s): %v", sessionID, err))
		return
	}
	b, err := json.Marshal(sessionInfoMsg{Type: "session-info", RemoteUser: username})
	if err != nil {
		logWarn(fmt.Sprintf("companion: falha ao serializar session-info (sessão %s): %v", sessionID, err))
		return
	}
	deadline := time.Now().Add(liveSessionWriteTimeout)
	if err := w.WriteMessageWithDeadline(websocket.TextMessage, b, deadline); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao mandar session-info (sessão %s): %v", sessionID, err))
	}
}

// liveSessionDialer: cópia do websocket.DefaultDialer com NetDialContext
// resiliente a DNS local quebrado (ver resilient_dns.go) — achado em
// produção (01/11/2026, KIONE-ESC): "falha ao conectar em wss://...: dial
// tcp: lookup dt-manager...: no such host" era EXATAMENTE este Dial, com o
// DNS do roteador da loja não resolvendo o hostname do servidor mesmo com a
// rede geral da máquina saudável.
var liveSessionDialer = &websocket.Dialer{
	Proxy:            websocket.DefaultDialer.Proxy,
	HandshakeTimeout: websocket.DefaultDialer.HandshakeTimeout,
	NetDialContext:   resilientDialContext,
}

// liveSessionReconnectInitialDelay/liveSessionReconnectMaxDelay/
// liveSessionReconnectMaxAttempts controlam o backoff de reconexão do
// companion quando a sessão cai de forma INESPERADA (erro de rede/escrita),
// nunca quando foi stop explícito (ver runLiveSessionWithReconnect). Teto
// de tentativas existe pro caso em que o SERVIDOR já desistiu da sessão de
// vez (o grace period dele expirou, ver liveSessionRelay.js) — sem isso, o
// companion tentaria reconectar pra sempre contra uma sessão que não existe
// mais. var, não const, só pra testes encurtarem (mesmo padrão já usado por
// blockInputWorkerTimeout/localInputLockFailsafe em input_windows.go).
var (
	liveSessionReconnectInitialDelay = 1 * time.Second
	liveSessionReconnectMaxDelay     = 8 * time.Second
	liveSessionReconnectMaxAttempts  = 6
)

// runLiveSessionLoopFn é a indireção testável de runLiveSessionLoop —
// permite testar o loop de reconexão (runLiveSessionWithReconnect) sem
// discar um WebSocket de verdade, mesmo padrão de injectMouseMoveFn
// (input_windows.go).
var runLiveSessionLoopFn = runLiveSessionLoop

// runLiveSessionWithReconnect chama runLiveSessionLoopFn repetidamente
// enquanto a sessão cair de forma INESPERADA, com backoff exponencial, até
// um teto de tentativas ou até stopCh fechar (stop explícito — nunca tenta
// de novo nesse caso, só nesse). Espelha o grace period que o servidor dá
// antes de matar a sessão de vez (liveSessionRelay.js, achado real
// 13/11/2026): sem isso dos dois lados, uma queda de rede breve (Wi-Fi da
// loja, blip de NAT) sempre exigia fechar e reabrir a janela manualmente no
// dashboard, mesmo a conexão voltando sozinha segundos depois — o servidor
// já apagava a sessão na hora, e o companion nunca tentava de novo.
//
// Cada chamada a runLiveSessionLoopFn redisca do zero (novo capturer de
// tela, novo session-info) — mesmo fluxo de uma conexão nova, só repetido.
// stopCh é checado ANTES e DEPOIS do delay de backoff: antes, pra nunca
// reconectar depois de um stop explícito que chegou enquanto a última
// tentativa ainda rodava; depois, pra um stop chegar durante a espera não
// disparar mais uma tentativa inútil.
func runLiveSessionWithReconnect(sessionID, wsURL, mode string, stopCh <-chan struct{}) {
	delay := liveSessionReconnectInitialDelay
	retries := 0
	for {
		runLiveSessionLoopFn(sessionID, wsURL, mode, stopCh)

		select {
		case <-stopCh:
			return // stop explícito -- nunca tenta de novo
		default:
		}

		if retries >= liveSessionReconnectMaxAttempts {
			logWarn(fmt.Sprintf("companion: sessão %s não reconectou após %d tentativa(s), desistindo", sessionID, retries))
			return
		}
		retries++

		logWarn(fmt.Sprintf("companion: sessão %s caiu inesperadamente, tentando reconectar em %s (tentativa %d/%d)", sessionID, delay, retries, liveSessionReconnectMaxAttempts))

		select {
		case <-stopCh:
			return
		case <-time.After(delay):
		}

		delay = min(delay*2, liveSessionReconnectMaxDelay)
	}
}

func runLiveSessionLoop(sessionID, wsURL, mode string, stopCh <-chan struct{}) {
	conn, _, err := liveSessionDialer.Dial(wsURL, nil)
	if err != nil {
		logError(fmt.Sprintf("companion: falha ao conectar em %s: %v", redactLiveSessionURL(wsURL), err))
		return
	}
	// readerDone + a ordem dos 3 defers abaixo garantem que, quando esta
	// função retornar, a goroutine leitora já tenha terminado de VERDADE
	// antes do lock de input local ser liberado — achado 🟠 do
	// code-reviewer: sem essa sincronização, defer conn.Close() e defer
	// releaseLocalInputLockForSession(sessionID) corriam em paralelo com a
	// goroutine leitora, e uma mensagem "lock-local-input" já em trânsito
	// podia ser processada (travando de novo) DEPOIS do release rodar —
	// sem mais ninguém pra liberar de novo, só o failsafe de 10min
	// (input_windows.go) resolveria. Defers executam em LIFO (registrado
	// por último roda primeiro), então a ordem de REGISTRO abaixo —
	// release, wait, close — produz a ordem de EXECUÇÃO que queremos:
	// 1) conn.Close() (destrava qualquer ReadMessage bloqueado), depois
	// 2) readerDone.Wait() (espera a goroutine leitora sair do loop de
	// vez, inclusive terminar de processar qualquer mensagem que já tinha
	// lido antes do close), só então 3) releaseLocalInputLockForSession —
	// nenhuma chamada a handleLiveSessionInput desta sessão pode mais
	// acontecer depois disso.
	var readerDone sync.WaitGroup
	readerDone.Add(1)
	defer releaseLocalInputLockForSession(sessionID)
	defer readerDone.Wait()
	defer conn.Close()

	// writer embrulha conn num safeConn (wsconn_windows.go) — a partir da
	// transferência de arquivo, DUAS goroutines escrevem na mesma conexão:
	// esta função (frames de vídeo, no loop do ticker abaixo) e a goroutine
	// de download disparada por applyFileTransfer (progresso/done/erro),
	// via readLiveSessionInput → handleLiveSessionInput →
	// dispatchLiveSessionInput. gorilla/websocket não permite 2 escritores
	// concorrentes na mesma conexão — daí o wrapper, usado nos dois pontos
	// abaixo (sendLiveSessionFrame e readLiveSessionInput) em vez do conn
	// crú.
	writer := newSafeConn(conn)

	// Manda o username real da sessão interativa 1x, logo no início —
	// achado real em produção (12/11/2026): o dashboard usava um fallback
	// literal ("Loja") pro destino default de transferência de arquivo, que
	// quase nunca batia com o usuário de verdade logado em cada loja. Fire-
	// and-forget (mesmo padrão de sendFileTransferStatus): falha aqui só
	// loga, nunca impede a sessão de vídeo/input de funcionar.
	sendSessionInfo(writer, sessionID)

	// Normal mode: lê mensagens de input numa goroutine separada e injeta
	// via SendInput. Shadow: o servidor nunca repassa input pra cá, mas o
	// companion não assume isso — só processa se algo chegar. safeGo (não
	// `go` puro) porque handleLiveSessionInput vai processar dado vindo
	// direto da rede (Task 12/SendInput) — panic ali não pode derrubar o
	// processo do agent inteiro.
	safeGo("liveSession-reader-"+sessionID, func() {
		defer readerDone.Done()
		readLiveSessionInput(conn, mode, sessionID, writer)
	})

	// 1 capturer por sessão inteira (não por frame) — DXGI mantém
	// device/duplication vivos entre frames, só AcquireNextFrame+cópia por
	// tick, em vez de recriar todo o contexto de captura 10x/s como o GDI
	// fazia. Close() garantido mesmo se a sessão terminar por stopCh ou por
	// falha de escrita (return dentro do loop abaixo).
	capturer, backend := newScreenCapturerFn()
	defer capturer.Close()
	logInfo(fmt.Sprintf("companion: sessão %s usando backend de captura %s", sessionID, backend))

	ticker := time.NewTicker(time.Duration(liveSessionFrameIntervalMs()) * time.Millisecond)
	defer ticker.Stop()

	captureFailures := 0
	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			if !sendLiveSessionFrame(writer, sessionID, capturer, &captureFailures) {
				return
			}
		}
	}
}

// messageReader é o subconjunto de *websocket.Conn que readLiveSessionInput
// precisa — extraído (mesmo padrão de frameWriter/sendLiveSessionFrame
// neste arquivo) pra permitir testar o throttle de log de 1x-por-conexão
// com um fake de N mensagens, sem WebSocket real.
type messageReader interface {
	ReadMessage() (messageType int, p []byte, err error)
}

// readLiveSessionInput lê mensagens da conexão até ela cair (erro de rede
// ou conn.Close() chamado pelo defer de runLiveSessionLoop ao encerrar).
// mode é repassado pra handleLiveSessionInput como defesa em profundidade:
// o companion só injeta input se, pelo seu próprio conhecimento local do
// mode desta sessão, ele for "normal" — não confia só na garantia do
// servidor (liveSessionRelay.routeMessage) de nunca repassar input numa
// sessão Shadow. w é a mesma conexão (embrulhada em safeConn por
// runLiveSessionLoop) repassada até handleLiveSessionInput/
// dispatchLiveSessionInput só pra alimentar applyFileTransferFn — o case
// "file-transfer" precisa escrever progresso de volta na conexão.
func readLiveSessionInput(conn messageReader, mode string, sessionID string, w frameWriter) {
	if mode != liveSessionNormalMode {
		// mode é fixo pra vida inteira da conexão — se for != normal, vai
		// recusar TODA mensagem até a conexão cair. Loga 1x aqui, não a
		// cada mensagem dentro do loop (handleLiveSessionInput também
		// recusa, em silêncio, por já ter sido logado aqui).
		logError(fmt.Sprintf("companion: sessão não-normal (mode=%q) — input desabilitado nesta conexão", mode))
	}
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		handleLiveSessionInput(data, mode, sessionID, w)
	}
}

// frameWriter é o subconjunto de *safeConn que sendLiveSessionFrame
// precisa — extraído pra permitir testar a lógica de contagem de falhas/
// throttle de log/recuperação (a parte rica desta função) com um fake, sem
// discar um WebSocket real. 1 método só (não SetWriteDeadline+WriteMessage
// separados) — ver comentário de safeConn.WriteMessageWithDeadline
// (wsconn_windows.go) pro bug real que a junção dos dois corrige.
type frameWriter interface {
	WriteMessageWithDeadline(messageType int, data []byte, deadline time.Time) error
}

// sendLiveSessionFrame captura e envia um frame. Retorna false quando o
// loop de runLiveSessionLoop deve encerrar a sessão (falha de escrita —
// conexão provavelmente morta); falha de captura é só pulada (true), já
// que é tipicamente transitória — inclusive cobre DXGI recriando o
// duplicator depois de resolução mudar (ver recreateDuplicator em
// screencapture_dxgi_windows.go): essa falha passa por aqui igual qualquer
// outra, sem precisar de tratamento especial nesta função.
func sendLiveSessionFrame(conn frameWriter, sessionID string, capturer screenCapturer, captureFailures *int) bool {
	frame, err := capturer.CaptureJPEG(defaultJPEGQuality)
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
	deadline := time.Now().Add(liveSessionWriteTimeout)
	if err := conn.WriteMessageWithDeadline(websocket.BinaryMessage, frame, deadline); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao enviar frame, encerrando sessão %s: %v", sessionID, err))
		return false
	}
	return true
}

// handleLiveSessionInput está implementado em input_windows.go (Task 12 —
// injeção via SendInput, só mode Normal).
