package main

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
	"unsafe"
)

// inputMessage é o protocolo de input recebido do dashboard via WS
// (role=dashboard → servidor → aqui, só em sessão mode=normal — o
// servidor garante isso, ver liveSessionRelay.routeMessage no plano do
// server). Tipos: "mousemove", "mousedown", "mouseup", "keydown", "keyup",
// "lock-local-input", "unlock-local-input".
type inputMessage struct {
	Type    string `json:"type"`
	X       int32  `json:"x,omitempty"`
	Y       int32  `json:"y,omitempty"`
	Button  string `json:"button,omitempty"`  // "left" | "right"
	KeyCode uint16 `json:"keyCode,omitempty"` // virtual-key code
}

func parseInputMessage(data []byte) (inputMessage, error) {
	var msg inputMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return msg, fmt.Errorf("parseInputMessage: %w", err)
	}
	return msg, nil
}

// liveSessionNormalMode é o valor exato de mode que habilita injeção de
// input — mesma string literal que o servidor usa em
// liveSessionRelay.routeMessage ("normal", minúsculo). Qualquer outro
// valor (inclusive "shadow" ou string vazia/inesperada) é fail-closed:
// não injeta.
const liveSessionNormalMode = "normal"

// injectMouseMoveFn e injectMouseButtonFn apontam pra implementação real —
// indireção que permite mockar a injeção em teste (handleLiveSessionInput)
// sem chamar SendInput de verdade, mesmo padrão já usado em
// captureScreenJPEGFn/startLiveSessionFn no projeto.
var (
	injectMouseMoveFn   = injectMouseMove
	injectMouseButtonFn = injectMouseButton
)

// handleLiveSessionInput processa 1 mensagem de input recebida pela conexão
// WS da liveSession. Defesa em profundidade: o servidor já não deveria
// repassar input pra uma sessão Shadow (liveSessionRelay.routeMessage), mas
// o companion não confia só nisso pra algo desta sensibilidade — controlar
// o mouse do usuário sem ele saber seria uma violação grave do desenho
// Normal/Shadow da feature. O log (ERROR, sinal de bug no servidor ou de
// alguém testando o protocolo manualmente) acontece 1x por conexão em
// readLiveSessionInput, não aqui — mode é fixo pra conexão inteira.
func handleLiveSessionInput(data []byte, mode string, sessionID string) {
	if mode != liveSessionNormalMode {
		// Já logado 1x por readLiveSessionInput (mode é fixo pra conexão
		// inteira, ver comentário lá) — aqui só recusa, sem logar de novo
		// por mensagem, senão uma sessão não-normal inundaria companion.log
		// na taxa de mensagens da WS.
		return
	}
	msg, err := parseInputMessage(data)
	if err != nil {
		logWarn(fmt.Sprintf("companion: input inválido recebido: %v", err))
		return
	}
	dispatchLiveSessionInput(msg, sessionID)
}

// dispatchLiveSessionInput é o switch de verdade — extraído de
// handleLiveSessionInput (que fica só com mode-check + parse) só pra
// reduzir a complexidade ciclomática de cada função (linter cyclop, max 10
// por função; 6 cases + validação de JSON numa função só passava do
// limite).
func dispatchLiveSessionInput(msg inputMessage, sessionID string) {
	switch msg.Type {
	case "mousemove":
		if err := injectMouseMoveFn(msg.X, msg.Y); err != nil {
			logWarn(fmt.Sprintf("companion: falha ao injetar mousemove: %v", err))
		}
	case "mousedown":
		if err := injectMouseButtonFn(msg.Button, true); err != nil {
			logWarn(fmt.Sprintf("companion: falha ao injetar mousedown: %v", err))
		}
	case "mouseup":
		if err := injectMouseButtonFn(msg.Button, false); err != nil {
			logWarn(fmt.Sprintf("companion: falha ao injetar mouseup: %v", err))
		}
	case "lock-local-input":
		applyLocalInputLock(sessionID, true)
	case "unlock-local-input":
		applyLocalInputLock(sessionID, false)
	default:
		logWarn(fmt.Sprintf("companion: tipo de input não suportado ainda: %s", msg.Type))
	}
}

// applyLocalInputLock chama setLocalInputLockedFn e loga o resultado —
// extraído do switch de handleLiveSessionInput só pra reduzir a
// complexidade ciclomática da função (linter cyclop, max 10 por função).
func applyLocalInputLock(sessionID string, locked bool) {
	verbo, acao := "bloquear", "bloqueado"
	if !locked {
		verbo, acao = "liberar", "liberado"
	}
	if err := setLocalInputLockedFn(sessionID, locked); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao %s input local (sessão %s): %v", verbo, sessionID, err))
		return
	}
	logInfo(fmt.Sprintf("companion: input local %s (sessão %s)", acao, sessionID))
}

const (
	inputMouse           = 0
	mouseEventFMove      = 0x0001
	mouseEventFLeftDown  = 0x0002
	mouseEventFLeftUp    = 0x0004
	mouseEventFRightDown = 0x0008
	mouseEventFRightUp   = 0x0010
	mouseEventFAbsolute  = 0x8000
)

// mouseInput espelha o struct MOUSEINPUT do Win32 — layout tem que bater
// exatamente (campos e ordem; Go já insere o mesmo padding implícito que o
// C faria antes de DwExtraInfo, por alinhamento natural de uintptr, sem
// precisar de campo de padding manual aqui).
type mouseInput struct {
	Dx, Dy      int32
	MouseData   uint32
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

// input espelha o struct INPUT do Win32 (união de MOUSEINPUT/KEYBDINPUT/
// HARDWAREINPUT — só Mi é usado aqui, teclado fica pra depois). O campo de
// padding explícito documenta a intenção, ainda que o Go já insira esse
// mesmo byte de alinhamento automaticamente (mouseInput exige alinhamento
// de 8 bytes por conter um uintptr).
type input struct {
	Type uint32
	_    uint32
	Mi   mouseInput
}

// user32 já é declarado em activity_windows.go (mesmo pacote) — reusado
// aqui pra procSendInput.
var procSendInput = user32.NewProc("SendInput")

func clampInt32(v, lo, hi int32) int32 {
	return max(lo, min(v, hi))
}

func injectMouseMove(x, y int32) error {
	// Coordenadas absolutas normalizadas (0-65535) — ver doc MOUSEINPUT.
	// screenDimensions (gdi_windows.go) é a MESMA fonte que captureScreenJPEG
	// usa pra capturar o frame — essencial que as duas concordem, já que o
	// dashboard escala o clique em cima do frame JPEG recebido; uma fonte
	// diferente aqui (ex: GetSystemMetrics) poderia divergir em máquina com
	// GPU dupla (achado 29/10/2026, Daniela-Esc) e clicar no lugar errado
	// mesmo com o vídeo funcionando.
	screenW, screenH, err := screenDimensions()
	if err != nil {
		return fmt.Errorf("injectMouseMove: %w", err)
	}
	// x/y vêm do dashboard via WS→servidor→pipe, sem validação em nenhum
	// ponto do caminho. Clampar ANTES da conta em int64 — fazer a conta em
	// int32 com x/y fora de [-32768,32767] overflowa (ex: x=100000,
	// screenW=1920 → normX negativo: o sinal inverte silenciosamente, sem
	// erro Go, e o cursor pularia pra ESQUERDA em vez de ser limitado à
	// direita da tela).
	x = clampInt32(x, 0, int32(screenW)-1)
	y = clampInt32(y, 0, int32(screenH)-1)
	normX := int32(int64(x) * 65536 / int64(screenW))
	normY := int32(int64(y) * 65536 / int64(screenH))

	in := input{
		Type: inputMouse,
		Mi: mouseInput{
			Dx: normX, Dy: normY,
			DwFlags: mouseEventFMove | mouseEventFAbsolute,
		},
	}
	return sendInputStruct(in)
}

func injectMouseButton(button string, down bool) error {
	var flag uint32
	switch {
	case button == "left" && down:
		flag = mouseEventFLeftDown
	case button == "left" && !down:
		flag = mouseEventFLeftUp
	case button == "right" && down:
		flag = mouseEventFRightDown
	case button == "right" && !down:
		flag = mouseEventFRightUp
	default:
		return fmt.Errorf("botão desconhecido: %s", button)
	}
	in := input{Type: inputMouse, Mi: mouseInput{DwFlags: flag}}
	return sendInputStruct(in)
}

func sendInputStruct(in input) error {
	ret, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
	if ret == 0 {
		return fmt.Errorf("SendInput falhou: %w", err)
	}
	return nil
}

// procBlockInput bloqueia (ou libera) TODO input físico de mouse/teclado do
// usuário local — usado pelo lock-local-input do modo Normal, pra evitar o
// usuário da loja brigar pelo cursor com o operador remoto. Só funciona
// chamado pela thread com desktop interativo associado (winsta0\default,
// ver launchCompanion em session_windows.go) — é por isso que o lock vive
// aqui, no companion, nunca no serviço (que roda sem desktop interativo e
// receberia ERROR_ACCESS_DENIED do próprio Windows).
var procBlockInput = user32.NewProc("BlockInput")

// blockInputFn é a indireção testável de blockInputSyscall — mesmo padrão
// de injectMouseMoveFn/injectMouseButtonFn neste arquivo.
var blockInputFn = blockInputSyscall

func blockInputSyscall(block bool) error {
	var arg uintptr
	if block {
		arg = 1
	}
	ret, _, err := procBlockInput.Call(arg)
	if ret == 0 {
		return fmt.Errorf("BlockInput(%v) falhou: %w", block, err)
	}
	return nil
}

// localInputLockFailsafe é o teto de duração de um lock, independente de
// unlock explícito ou do fim da sessão — 2ª camada de defesa (a 1ª é
// releaseLocalInputLockForSession, chamada pelo defer de
// runLiveSessionLoop no fim da sessão). Cobre o cenário em que o dashboard
// do operador cai sem avisar — rede, crash do app Electron — mas o
// companion e a conexão /live continuam saudáveis: sem este teto, o
// usuário da loja ficaria travado até alguém encerrar a sessão manualmente
// (o servidor também tenta mandar unlock nesse caso, ver
// liveSessionRelay.js, mas esta é a rede de segurança se isso falhar). É
// var, não const, só pra TestLocalInputLockFailsafeAutoReleases poder
// encurtar.
var localInputLockFailsafe = 10 * time.Minute

var (
	localInputLockMu    sync.Mutex
	localInputLockedBy  string // sessionID dono do lock atual; "" se nenhum
	localInputLockTimer *time.Timer
)

// setLocalInputLockedFn é a indireção testável de setLocalInputLocked.
var setLocalInputLockedFn = setLocalInputLocked

// setLocalInputLocked trava/libera o input físico local a pedido explícito
// de sessionID (via lock-local-input/unlock-local-input, em
// handleLiveSessionInput). unlock só tem efeito se vier da MESMA sessão que
// travou — uma sessão B pedindo unlock nunca libera o lock de uma sessão A
// ainda ativa. Lock duplicado da mesma sessão é no-op (BlockInput não é
// documentado como cumulativo no Windows, evitar depender disso).
//
// Se uma sessão B pede lock enquanto uma sessão A DIFERENTE ainda é a dona
// (ex: reconexão rápida criando sessionID novo antes do defer de teardown
// da sessão antiga ter rodado — 2 sessões Normal sobrepostas pra mesma
// máquina), a posse é TRANSFERIDA pra B, não recusada: recusar deixaria B
// sem nunca conseguir destravar depois (seu próprio unlock seria "sessão
// não-dona", vira no-op, igual ao de uma sessão B comum — travaria o input
// físico até o failsafe de 10min, pior do que aceitar a transferência).
// Achado 🟠 do code-reviewer: essa transferência era silenciosa (nenhum
// log) — agora emite WARN, porque 2 sessões Normal sobrepostas pra mesma
// máquina é sempre anômalo e vale aparecer em companion.log.
func setLocalInputLocked(sessionID string, locked bool) error {
	localInputLockMu.Lock()
	defer localInputLockMu.Unlock()

	if locked {
		if localInputLockedBy == sessionID {
			return nil
		}
		if localInputLockedBy != "" {
			logWarn(fmt.Sprintf("companion: lock de input local transferido da sessão %s pra %s sem unlock explícito — 2 sessões Normal sobrepostas pra esta máquina?", localInputLockedBy, sessionID))
		}
		if err := blockInputFn(true); err != nil {
			return err
		}
		localInputLockedBy = sessionID
		resetLocalInputLockTimerLocked(sessionID)
		return nil
	}

	if localInputLockedBy != sessionID {
		return nil
	}
	if err := blockInputFn(false); err != nil {
		return err
	}
	localInputLockedBy = ""
	stopLocalInputLockTimerLocked()
	return nil
}

// releaseLocalInputLockForSession libera o lock SE ele ainda pertencer a
// sessionID — chamada pelo defer de runLiveSessionLoop (fim de sessão, por
// qualquer motivo: stop explícito, queda de conexão, falha de escrita de
// frame) e pelo próprio timer de failsafe. Ao contrário de
// setLocalInputLocked, nunca propaga erro pro chamador: quem chama aqui é
// sempre limpeza automática, não um comando explícito do operador — só loga.
func releaseLocalInputLockForSession(sessionID string) {
	localInputLockMu.Lock()
	defer localInputLockMu.Unlock()
	if localInputLockedBy != sessionID {
		return
	}
	if err := blockInputFn(false); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao liberar input local (sessão %s): %v", sessionID, err))
	}
	localInputLockedBy = ""
	stopLocalInputLockTimerLocked()
}

// resetLocalInputLockTimerLocked/stopLocalInputLockTimerLocked exigem
// localInputLockMu já tomado pelo chamador (sufixo Locked, mesmo padrão de
// nomenclatura usado no resto do pacote pra funções não-reentrantes).
func resetLocalInputLockTimerLocked(sessionID string) {
	stopLocalInputLockTimerLocked()
	localInputLockTimer = time.AfterFunc(localInputLockFailsafe, func() {
		logWarn(fmt.Sprintf("companion: lock de input local da sessão %s expirou após %s sem unlock — liberando por segurança", sessionID, localInputLockFailsafe))
		releaseLocalInputLockForSession(sessionID)
	})
}

func stopLocalInputLockTimerLocked() {
	if localInputLockTimer != nil {
		localInputLockTimer.Stop()
		localInputLockTimer = nil
	}
}
