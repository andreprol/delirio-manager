package main

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"
)

var friendlyProcessNames = map[string]string{
	"chrome.exe":  "Google Chrome",
	"msedge.exe":  "Microsoft Edge",
	"firefox.exe": "Firefox",
	"excel.exe":   "Excel",
	"winword.exe": "Word",
	"outlook.exe": "Outlook",
}

// friendlyProcessName traduz o nome técnico do executável pra um nome
// legível na UI do dashboard (ver spec: "log traduzido pra linguagem
// comum"). Sem mapeamento conhecido, devolve o nome original sem alteração.
func friendlyProcessName(exeName string) string {
	key := strings.ToLower(exeName)
	if friendly, ok := friendlyProcessNames[key]; ok {
		return friendly
	}
	return exeName
}

// basenameFromPath extrai o nome do arquivo de um path completo do Windows
// (aceita tanto \ quanto / como separador). Separado de
// captureForegroundWindow pra ser testável sem depender de sessão desktop.
func basenameFromPath(fullPath string) string {
	normalized := strings.ReplaceAll(fullPath, "/", "\\")
	parts := strings.Split(normalized, "\\")
	return parts[len(parts)-1]
}

var (
	user32                         = syscall.NewLazyDLL("user32.dll")
	procGetForegroundWindow        = user32.NewProc("GetForegroundWindow")
	procSendMessageTimeoutW        = user32.NewProc("SendMessageTimeoutW")
	procGetWindowThreadProcessId   = user32.NewProc("GetWindowThreadProcessId")
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess                = kernel32.NewProc("OpenProcess")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
	procCloseHandle                = kernel32.NewProc("CloseHandle")
)

const (
	processQueryLimitedInformation = 0x1000
	maxWindowTitleChars            = 512
	maxPathChars                   = 512

	// WM_GETTEXT via SendMessageTimeoutW (não GetWindowTextW direto): essa
	// chamada é, por baixo, um SendMessage síncrono pro processo DONO da
	// janela — se esse processo estiver travado ("Não está respondendo"),
	// GetWindowTextW trava o chamador indefinidamente junto. Como esta
	// função roda num loop de poucos segundos (Task 3), um app travado em
	// qualquer uma das 224 máquinas pararia o report de atividade pra
	// sempre naquela máquina. SendMessageTimeoutW com SMTO_ABORTIFHUNG
	// desiste depois de windowTextTimeoutMs em vez de travar.
	wmGetText           = 0x000D
	smtoAbortIfHung     = 0x0002
	windowTextTimeoutMs = 200
)

// captureForegroundWindow lê a janela em foco agora — título + nome do
// processo. Não testável em CI (precisa de sessão desktop interativa real);
// verificar manualmente rodando o companion numa máquina Windows de teste.
func captureForegroundWindow() (windowTitle string, processName string, err error) {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return "", "", fmt.Errorf("nenhuma janela em foco")
	}

	buf := make([]uint16, maxWindowTitleChars)
	var result uintptr
	ret, _, lastErr := procSendMessageTimeoutW.Call(
		hwnd, wmGetText, uintptr(len(buf)), uintptr(unsafe.Pointer(&buf[0])),
		smtoAbortIfHung, windowTextTimeoutMs, uintptr(unsafe.Pointer(&result)),
	)
	if ret == 0 {
		// Timeout (janela travada) ou erro — segue sem título em vez de travar
		// o loop de report de atividade inteiro por causa de 1 app travado.
		// lastErr logado (não transformado em err de retorno) pra distinguir
		// timeout de outra falha do SendMessageTimeoutW em produção.
		logWarn(fmt.Sprintf("captureForegroundWindow: SendMessageTimeoutW falhou/expirou: %v", lastErr))
		windowTitle = ""
	} else {
		windowTitle = syscall.UTF16ToString(buf)
	}

	var pid uint32
	_, _, _ = procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid))) //nolint:errcheck
	if pid == 0 {
		return windowTitle, "", fmt.Errorf("pid não encontrado pra janela em foco")
	}

	hProcess, _, lastErr := procOpenProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if hProcess == 0 {
		return windowTitle, "", fmt.Errorf("OpenProcess falhou pro pid %d: %w", pid, lastErr)
	}
	defer func() { _, _, _ = procCloseHandle.Call(hProcess) }() //nolint:errcheck

	pathBuf := make([]uint16, maxPathChars)
	pathLen := uint32(len(pathBuf))
	ret, _, lastErr = procQueryFullProcessImageNameW.Call(
		hProcess, 0, uintptr(unsafe.Pointer(&pathBuf[0])), uintptr(unsafe.Pointer(&pathLen)),
	)
	if ret == 0 {
		return windowTitle, "", fmt.Errorf("QueryFullProcessImageName falhou pro pid %d: %w", pid, lastErr)
	}
	fullPath := syscall.UTF16ToString(pathBuf[:pathLen])
	processName = basenameFromPath(fullPath)

	return windowTitle, processName, nil
}
