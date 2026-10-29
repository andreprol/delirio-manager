package main

import (
	"encoding/json"
	"fmt"
	"unsafe"
)

// inputMessage é o protocolo de input recebido do dashboard via WS
// (role=dashboard → servidor → aqui, só em sessão mode=normal — o
// servidor garante isso, ver liveSessionRelay.routeMessage no plano do
// server). Tipos: "mousemove", "mousedown", "mouseup", "keydown", "keyup".
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
func handleLiveSessionInput(data []byte, mode string) {
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
	default:
		logWarn(fmt.Sprintf("companion: tipo de input não suportado ainda: %s", msg.Type))
	}
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
