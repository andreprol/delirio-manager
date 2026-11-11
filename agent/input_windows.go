package main

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
	"unicode/utf16"
	"unsafe"
)

// inputMessage é o protocolo de input recebido do dashboard via WS
// (role=dashboard → servidor → aqui, só em sessão mode=normal — o
// servidor garante isso, ver liveSessionRelay.routeMessage no plano do
// server). Tipos: "mousemove", "mousedown", "mouseup", "keydown", "keyup",
// "lock-local-input", "unlock-local-input", "clipboard-paste",
// "file-transfer".
type inputMessage struct {
	Type        string `json:"type"`
	X           int32  `json:"x,omitempty"`
	Y           int32  `json:"y,omitempty"`
	Button      string `json:"button,omitempty"`      // "left" | "right"
	KeyCode     uint16 `json:"keyCode,omitempty"`     // virtual-key code
	Text        string `json:"text,omitempty"`        // clipboard-paste: texto a colar
	DownloadURL string `json:"downloadUrl,omitempty"` // file-transfer: SAS de leitura do blob
	FileName    string `json:"fileName,omitempty"`    // file-transfer: nome final do arquivo
	DestDir     string `json:"destDir,omitempty"`     // file-transfer: diretorio de destino (sem o nome do arquivo)
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

// injectMouseMoveFn, injectMouseButtonFn e injectKeyboardFn apontam pra
// implementação real — indireção que permite mockar a injeção em teste
// (handleLiveSessionInput) sem chamar SendInput de verdade, mesmo padrão já
// usado em captureScreenJPEGFn/startLiveSessionFn no projeto.
var (
	injectMouseMoveFn      = injectMouseMove
	injectMouseButtonFn    = injectMouseButton
	injectKeyboardFn       = injectKeyboard
	injectClipboardPasteFn = injectClipboardPaste
)

// handleLiveSessionInput processa 1 mensagem de input recebida pela conexão
// WS da liveSession. Defesa em profundidade: o servidor já não deveria
// repassar input pra uma sessão Shadow (liveSessionRelay.routeMessage), mas
// o companion não confia só nisso pra algo desta sensibilidade — controlar
// o mouse do usuário sem ele saber seria uma violação grave do desenho
// Normal/Shadow da feature. O log (ERROR, sinal de bug no servidor ou de
// alguém testando o protocolo manualmente) acontece 1x por conexão em
// readLiveSessionInput, não aqui — mode é fixo pra conexão inteira.
//
// w (frameWriter) é a MESMA conexão WS (embrulhada em safeConn, ver
// wsconn_windows.go), repassada só pra poder chegar até
// applyFileTransferFn — o único case do dispatch que escreve de volta na
// conexão (progresso/done/erro de download), concorrente com os frames de
// vídeo do loop principal. Todos os outros tipos de mensagem a ignoram.
func handleLiveSessionInput(data []byte, mode string, sessionID string, w frameWriter) {
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
	dispatchLiveSessionInput(msg, sessionID, w)
}

// dispatchLiveSessionInput é o switch de verdade — extraído de
// handleLiveSessionInput (que fica só com mode-check + parse) só pra
// reduzir a complexidade ciclomática de cada função (linter cyclop, max 10
// por função). Cada case chama uma função que já absorve o "if err" +
// log (applyMouseMove/applyMouseButton/applyKeyboardInput/
// applyLocalInputLock) — sem isso, 8 cases + 5 "if err" inline no mesmo
// corpo passam do limite (confirmado: 14 ao acrescentar keydown/keyup
// inline, antes da extração). Só os eventos de mouse/teclado (que não
// precisam de sessionID/w) ficam aqui; lock/unlock/clipboard/file-transfer
// foram pra dispatchSessionControlInput — o case "file-transfer" sozinho
// levou esta função de 10 pra 11 (linter cyclop), por isso a extração.
func dispatchLiveSessionInput(msg inputMessage, sessionID string, w frameWriter) {
	switch msg.Type {
	case "mousemove":
		applyMouseMove(msg)
	case "mousedown":
		applyMouseButton(msg, true)
	case "mouseup":
		applyMouseButton(msg, false)
	case "keydown":
		applyKeyboardInput(msg, true)
	case "keyup":
		applyKeyboardInput(msg, false)
	default:
		dispatchSessionControlInput(msg, sessionID, w)
	}
}

// dispatchSessionControlInput cobre os tipos de mensagem "de sessão"
// (lock/unlock de input local, clipboard-paste, file-transfer) — extraído
// do switch de dispatchLiveSessionInput só pra manter a complexidade
// ciclomática de cada função dentro do limite do linter (cyclop, max 10),
// depois que adicionar o case "file-transfer" ali estourou o limite. w é
// repassado só pro case "file-transfer" (applyFileTransferFn), que precisa
// escrever progresso de volta na conexão — os demais cases não precisam
// dele. O default aqui é o mesmo "tipo não suportado" de antes, só movido.
func dispatchSessionControlInput(msg inputMessage, sessionID string, w frameWriter) {
	switch msg.Type {
	case "lock-local-input":
		applyLocalInputLock(sessionID, true)
	case "unlock-local-input":
		applyLocalInputLock(sessionID, false)
	case "clipboard-paste":
		applyClipboardPaste(msg)
	case "file-transfer":
		applyFileTransferFn(msg, sessionID, w)
	default:
		logWarn(fmt.Sprintf("companion: tipo de input não suportado ainda: %s", msg.Type))
	}
}

// applyMouseMove chama injectMouseMoveFn e loga o resultado — extraído do
// switch de dispatchLiveSessionInput só pra reduzir a complexidade
// ciclomática da função (linter cyclop, max 10 por função), mesmo padrão
// já usado por applyLocalInputLock.
func applyMouseMove(msg inputMessage) {
	if err := injectMouseMoveFn(msg.X, msg.Y); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao injetar mousemove: %v", err))
	}
}

// applyMouseButton chama injectMouseButtonFn e loga o resultado — mesmo
// motivo de applyMouseMove (mousedown quando down=true, mouseup quando
// down=false).
func applyMouseButton(msg inputMessage, down bool) {
	if err := injectMouseButtonFn(msg.Button, down); err != nil {
		verb := "mouseup"
		if down {
			verb = "mousedown"
		}
		logWarn(fmt.Sprintf("companion: falha ao injetar %s: %v", verb, err))
	}
}

// applyKeyboardInput chama injectKeyboardFn e loga o resultado — mesmo
// motivo de applyMouseMove (keydown quando down=true, keyup quando
// down=false).
func applyKeyboardInput(msg inputMessage, down bool) {
	if err := injectKeyboardFn(msg.KeyCode, down); err != nil {
		verb := "keyup"
		if down {
			verb = "keydown"
		}
		logWarn(fmt.Sprintf("companion: falha ao injetar %s: %v", verb, err))
	}
}

// applyClipboardPaste chama injectClipboardPasteFn e loga o resultado —
// mesmo motivo de applyMouseMove/applyKeyboardInput (extração pra não
// estourar a complexidade ciclomática de dispatchLiveSessionInput).
func applyClipboardPaste(msg inputMessage) {
	if err := injectClipboardPasteFn(msg.Text); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao colar via clipboard: %v", err))
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
	return sendInputRaw(unsafe.Pointer(&in), unsafe.Sizeof(in))
}

func sendInputRaw(ptr unsafe.Pointer, size uintptr) error {
	ret, _, err := procSendInput.Call(1, uintptr(ptr), size)
	if ret == 0 {
		return fmt.Errorf("SendInput falhou: %w", err)
	}
	return nil
}

const (
	inputKeyboard  = 1      // Win32 INPUT_KEYBOARD
	keyEventFKeyUp = 0x0002 // Win32 KEYEVENTF_KEYUP — ausente = key down
)

// keybdInput espelha o struct KEYBDINPUT do Win32.
type keybdInput struct {
	WVk         uint16
	WScan       uint16
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

// inputKeybd espelha INPUT com o membro Ki ativo. A união real do Win32
// (MOUSEINPUT/KEYBDINPUT/HARDWAREINPUT) tem o tamanho do MAIOR membro —
// MOUSEINPUT, 32 bytes (ver mouseInput/input acima) — e o parâmetro cbSize
// de SendInput exige esse tamanho de união mesmo pra um evento de teclado,
// cujo KEYBDINPUT sozinho ocupa só 24 bytes. Sem o padding explícito abaixo
// (8 bytes, fechando em 40 = mesmo unsafe.Sizeof(input{})), cbSize ficaria
// menor que o esperado e SendInput falharia com ERROR_INVALID_PARAMETER.
type inputKeybd struct {
	Type uint32
	_    uint32
	Ki   keybdInput
	_    [8]byte
}

// injectKeyboard não seta KEYEVENTF_EXTENDEDKEY — achado 🟡 do
// code-reviewer: VKs "estendidos" no Win32 real (setas, Insert/Delete/
// Home/End/PgUp/PgDn, Ctrl/Alt direitos, Enter/"/" do numpad) chegam com
// wVk correto (o navegador já distingue esses casos no keyCode), então a
// maioria dos apps que só leem WM_KEYDOWN.wParam funciona bem — mas um app
// ou hook de baixo nível que olha o bit de scan code estendido (lParam
// bit 24) pode confundir Numpad Enter com Enter normal, ou Ctrl/Alt
// direito com o esquerdo. Não corrigido agora (precisa mapear a lista de
// VKs estendidos e testar contra hardware real de loja antes de mexer) —
// documentado aqui pra não virar "atalho X não funciona" sem explicação.
func injectKeyboard(keyCode uint16, down bool) error {
	if keyCode == 0 {
		return fmt.Errorf("injectKeyboard: keyCode inválido (0)")
	}
	var flags uint32
	if !down {
		flags = keyEventFKeyUp
	}
	in := inputKeybd{
		Type: inputKeyboard,
		Ki:   keybdInput{WVk: keyCode, DwFlags: flags},
	}
	return sendInputRaw(unsafe.Pointer(&in), unsafe.Sizeof(in))
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

// clipboardPasteMaxChars limita o tamanho do texto colado — nada no caminho
// dashboard→servidor→companion valida tamanho antes daqui (mesma cautela de
// clampInt32 pra x/y em injectMouseMove). 32K chars é generoso pra comando/
// texto de suporte, sem permitir payload gigante inflar a memória global
// alocada abaixo.
const clipboardPasteMaxChars = 32 * 1024

const (
	cfUnicodeText = 13     // CF_UNICODETEXT
	gmemMoveable  = 0x0002 // GMEM_MOVEABLE
	vkControl     = 0x11   // VK_CONTROL
	vkV           = 0x56   // 'V'
)

// user32/kernel32 já declarados em activity_windows.go (mesmo pacote) —
// reusados aqui pros procs de clipboard.
var (
	procOpenClipboard    = user32.NewProc("OpenClipboard")
	procCloseClipboard   = user32.NewProc("CloseClipboard")
	procEmptyClipboard   = user32.NewProc("EmptyClipboard")
	procSetClipboardData = user32.NewProc("SetClipboardData")
	procGlobalAlloc      = kernel32.NewProc("GlobalAlloc")
	procGlobalLock       = kernel32.NewProc("GlobalLock")
	procGlobalUnlock     = kernel32.NewProc("GlobalUnlock")
	procGlobalFree       = kernel32.NewProc("GlobalFree")
)

// openClipboardRetries/openClipboardRetryDelay cobrem contenção transitória
// do clipboard — comum no Windows (outro processo com OpenClipboard aberto
// no instante exato), achado 🟡 do code-reviewer: sem retry, a 1ª falha
// desistia na hora sem dar nenhuma segunda chance.
const (
	openClipboardRetries    = 5
	openClipboardRetryDelay = 20 * time.Millisecond
)

// injectClipboardPaste grava `text` na área de transferência da sessão
// interativa e simula Ctrl+V, numa chamada só — o operador aperta Ctrl+V UMA
// vez no SEU teclado (dashboard intercepta, lê o clipboard LOCAL dele via
// Electron, manda o texto aqui) em vez de duas (uma pra setar o clipboard
// remoto, outra pra colar de verdade).
func injectClipboardPaste(text string) error {
	if text == "" {
		return fmt.Errorf("injectClipboardPaste: texto vazio")
	}
	if len(text) > clipboardPasteMaxChars {
		return fmt.Errorf("injectClipboardPaste: texto excede %d chars (%d)", clipboardPasteMaxChars, len(text))
	}
	if err := setClipboardText(text); err != nil {
		return fmt.Errorf("injectClipboardPaste: %w", err)
	}
	return sendPasteKeystroke()
}

// setClipboardText só funciona chamada pela thread com desktop interativo
// associado (winsta0\default) — mesmo motivo de procBlockInput logo acima,
// por isso vive no companion, nunca no serviço. UTF-16 com terminador nulo,
// formato que CF_UNICODETEXT exige.
func setClipboardText(text string) error {
	if err := openClipboardWithRetry(); err != nil {
		return err
	}
	defer procCloseClipboard.Call() //nolint:errcheck

	if ret, _, err := procEmptyClipboard.Call(); ret == 0 {
		return fmt.Errorf("EmptyClipboard falhou: %w", err)
	}

	utf16Text := utf16.Encode([]rune(text))
	utf16Text = append(utf16Text, 0) // terminador nulo exigido por CF_UNICODETEXT
	byteSize := uintptr(len(utf16Text)) * 2

	hMem, _, err := procGlobalAlloc.Call(gmemMoveable, byteSize)
	if hMem == 0 {
		return fmt.Errorf("GlobalAlloc falhou: %w", err)
	}
	ptr, _, err := procGlobalLock.Call(hMem)
	if ptr == 0 {
		// hMem já foi alocado com sucesso e SetClipboardData nunca vai rodar
		// pra assumir a posse — sem este GlobalFree, cada tentativa que falha
		// aqui vaza até clipboardPasteMaxChars*2 bytes de memória HGLOBAL (🟠
		// achado real do code-reviewer, não hipotético).
		procGlobalFree.Call(hMem) //nolint:errcheck // best-effort: já estamos no caminho de erro, nada a fazer se o free também falhar
		return fmt.Errorf("GlobalLock falhou: %w", err)
	}
	// go vet (unsafeptr) só reconhece como seguro um uintptr→unsafe.Pointer
	// vindo de syscall.Syscall/Syscall6 cru — LazyProc.Call (usado aqui, igual
	// ao resto do arquivo) devolve uintptr "normal", então o linter não
	// consegue provar a conversão sozinho. Seguro de verdade porque ptr
	// aponta pra memória HGLOBAL do Windows (GlobalAlloc/GlobalLock), nunca
	// memória gerenciada pelo GC do Go — não há risco de mover/coletar entre
	// a chamada e o uso, usado na mesma linha/bloco, sem guardar em struct.
	dst := unsafe.Slice((*uint16)(unsafe.Pointer(ptr)), len(utf16Text)) //nolint:govet
	copy(dst, utf16Text)
	procGlobalUnlock.Call(hMem) //nolint:errcheck // best-effort: GlobalUnlock "falhar" aqui (handle já destravado) não muda o fluxo

	// SetClipboardData assume dono do hMem SE TER SUCESSO (contrato Win32) —
	// em falha o chamador continua dono e tem que liberar, senão vaza (mesmo
	// achado 🟠 do GlobalLock acima, aqui no outro branch de erro).
	if ret, _, err := procSetClipboardData.Call(cfUnicodeText, hMem); ret == 0 {
		procGlobalFree.Call(hMem) //nolint:errcheck // best-effort, já no caminho de erro
		return fmt.Errorf("SetClipboardData falhou: %w", err)
	}
	return nil
}

// openClipboardWithRetry tenta abrir o clipboard algumas vezes antes de
// desistir — contenção transitória (outro processo com o clipboard aberto
// no instante exato) é comum no Windows, não deveria falhar a colagem inteira
// na 1ª tentativa.
func openClipboardWithRetry() error {
	var lastErr error
	for i := 0; i < openClipboardRetries; i++ {
		ret, _, err := procOpenClipboard.Call(0)
		if ret != 0 {
			return nil
		}
		lastErr = err
		time.Sleep(openClipboardRetryDelay)
	}
	return fmt.Errorf("OpenClipboard falhou após %d tentativas: %w", openClipboardRetries, lastErr)
}

// sendPasteKeystroke reusa injectKeyboard (já usado pro teclado normal da
// sessão) pra simular Ctrl+V — ordem down/down/up/up, mesmo padrão de
// qualquer atalho com modificador.
func sendPasteKeystroke() error {
	if err := injectKeyboard(vkControl, true); err != nil {
		return fmt.Errorf("sendPasteKeystroke: ctrl down: %w", err)
	}
	if err := injectKeyboard(vkV, true); err != nil {
		return fmt.Errorf("sendPasteKeystroke: v down: %w", err)
	}
	if err := injectKeyboard(vkV, false); err != nil {
		return fmt.Errorf("sendPasteKeystroke: v up: %w", err)
	}
	if err := injectKeyboard(vkControl, false); err != nil {
		return fmt.Errorf("sendPasteKeystroke: ctrl up: %w", err)
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
