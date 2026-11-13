// winkeyhook é um binário standalone, SEM relação com o agent/serviço do
// Delirio Manager (fleet de ~130 lojas) -- roda só na máquina do operador,
// disparado pelo Dashboard (Electron) enquanto uma janela de sessão ao
// vivo em modo Normal está em foco (ver dashboard/electron/main.js).
//
// Instala um hook de teclado de baixo nível (WH_KEYBOARD_LL) pra
// interceptar a tecla Windows e os combos Win+R/E/D ANTES do Explorer (ou
// qualquer outro app local) processá-los -- é por isso que precisa ser um
// hook de verdade, não só RegisterHotKey/globalShortcut do Electron:
// testado ao vivo (12/11/2026) que o Windows já reserva Win+R/Win+L pra
// si mesmo, recusando RegisterHotKey pra essas combinações. Um hook de
// baixo nível roda ANTES dessa reserva ser consultada.
//
// Protocolo com o processo pai (Electron, via stdout): 1 linha "ready"
// quando o hook está instalado, depois 1 linha por evento relevante
// ("win-tap", "win+r", "win+e", "win+d" -- ver hookstate.go). Processo
// morre (TerminateProcess ou saída normal) quando a janela perde o foco --
// o Windows desinstala o hook automaticamente quando o processo que o
// instalou termina, não precisa de handshake de shutdown.
//
// Modo adicional (one-shot, ver clipboardwrite.go): chamado com
// --write-clipboard-file <caminho>, escreve esse arquivo no clipboard do
// Windows (CF_HDROP) e sai na hora -- não instala hook nenhum nesse caso.
// Usado pelo fluxo Ctrl+C remoto->local do Acesso Remoto (copiar um
// arquivo da loja deixa ele pronto pro operador colar, Ctrl+V, em
// QUALQUER app local).
package main

import (
	"bufio"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	procSetWindowsHookExW   = user32.NewProc("SetWindowsHookExW")
	procCallNextHookEx      = user32.NewProc("CallNextHookEx")
	procUnhookWindowsHookEx = user32.NewProc("UnhookWindowsHookEx")
	procGetMessageW         = user32.NewProc("GetMessageW")
	procTranslateMessage    = user32.NewProc("TranslateMessage")
	procDispatchMessageW    = user32.NewProc("DispatchMessageW")
)

const (
	whKeyboardLL = 13

	wmKeyDown    = 0x0100
	wmKeyUp      = 0x0101
	wmSysKeyDown = 0x0104 // Win sozinho chega como SYSKEYDOWN, não KEYDOWN
	wmSysKeyUp   = 0x0105
)

// kbdllhookstruct espelha KBDLLHOOKSTRUCT do Win32 -- layout tem que bater
// exatamente (mesmo cuidado de sempre, ver mouseInput/keybdInput em
// agent/input_windows.go). Go já insere o mesmo padding antes de
// DwExtraInfo (alinhamento de 8 bytes por conter um uintptr), sem precisar
// de campo manual.
type kbdllhookstruct struct {
	VkCode      uint32
	ScanCode    uint32
	Flags       uint32
	Time        uint32
	DwExtraInfo uintptr
}

// win32Msg espelha só os campos de MSG que o loop de mensagens usa.
type win32Msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	X, Y    int32
}

var state HookState

var stdout = bufio.NewWriter(os.Stdout)

// reportEvent manda 1 linha pro processo pai e força a saída na hora --
// sem Flush, o buffer padrão do bufio só escreve ao enchar ou ao sair,
// deixando o Electron esperando por um evento que já aconteceu.
func reportEvent(event string) {
	if event == "" {
		return
	}
	fmt.Fprintln(stdout, event)
	stdout.Flush()
}

// keyboardProc é o HOOKPROC de verdade, chamado pelo Windows pra TODA
// tecla do sistema enquanto o hook está instalado -- tem que decidir rápido
// (o SO tem um timeout pra hooks de baixo nível que não respondem, ver
// LowLevelHooksTimeout). nCode/wParam/lParam chegam como uintptr (não os
// tipos C nativos) porque syscall.NewCallback só aceita essa forma -- os
// valores batem exatamente com o que o Win32 manda, só o tipo Go que
// muda.
func keyboardProc(nCode, wParam, lParam uintptr) uintptr {
	code := int32(nCode)
	if code >= 0 {
		switch wParam {
		case wmKeyDown, wmSysKeyDown, wmKeyUp, wmSysKeyUp:
			kbd := (*kbdllhookstruct)(unsafe.Pointer(lParam))
			isKeyUp := wParam == wmKeyUp || wParam == wmSysKeyUp
			suppress, event := state.Handle(kbd.VkCode, isKeyUp)
			reportEvent(event)
			if suppress {
				return 1
			}
		}
	}
	// hhk (1º argumento) é ignorado pelo Windows em versões atuais (doc
	// oficial) -- 0 é seguro, mesmo idioma usado na maioria dos exemplos
	// de referência de WH_KEYBOARD_LL.
	ret, _, _ := procCallNextHookEx.Call(0, nCode, wParam, lParam)
	return ret
}

func main() {
	// Modo one-shot "escreve este arquivo no clipboard do Windows" --
	// disparado pelo Electron (dashboard/electron/main.js, IPC
	// clipboard-write-file) via child_process.execFile, SEPARADO do
	// processo persistente do hook de teclado abaixo: sobe, escreve, sai.
	// Reusa o MESMO binário (nada a ver com teclado) só porque já é o
	// único lugar deste projeto com um 2º binário Go nativo standalone na
	// máquina do operador -- mais barato que criar um 3º módulo só pra
	// isto. Ver clipboardwrite.go.
	if filePath, ok := writeClipboardFileArg(os.Args[1:]); ok {
		if err := writeClipboardFile(filePath); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	// SetWindowsHookEx(WH_KEYBOARD_LL) entrega callbacks só pra thread que
	// instalou o hook, via o loop de mensagens DESSA MESMA thread -- sem
	// travar a goroutine numa OS thread fixa, o scheduler do Go poderia
	// migrá-la antes do loop (abaixo) rodar, e o hook nunca receberia
	// nada (mesmo cuidado de startBlockInputWorker, agent/input_windows.go).
	runtime.LockOSThread()

	callback := syscall.NewCallback(keyboardProc)
	hook, _, err := procSetWindowsHookExW.Call(uintptr(whKeyboardLL), callback, 0, 0)
	if hook == 0 {
		fmt.Fprintf(os.Stderr, "SetWindowsHookExW falhou: %v\n", err)
		os.Exit(1)
	}
	defer procUnhookWindowsHookEx.Call(hook) //nolint:errcheck // best-effort: processo está saindo, Windows desinstala o hook de qualquer jeito

	fmt.Fprintln(stdout, "ready")
	stdout.Flush()

	var m win32Msg
	for {
		ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(ret) <= 0 { // 0 = WM_QUIT, -1 = erro -- os dois encerram o loop
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))  //nolint:errcheck // loop padrao de mensagens, retorno nao e usado em nenhum exemplo de referencia
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m))) //nolint:errcheck // idem
	}
}
