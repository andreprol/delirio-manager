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

// Vars/const/func abaixo são consumidos pela Task 3 do plano (wiring em
// activityReportLoop, hoje stub em companion.go) — ainda não há chamador
// nesta task, então ficam marcados //nolint:unused até a próxima task ligar
// o fio. Não testável em CI de outra forma (ver doc de captureForegroundWindow).
//
//nolint:unused
var (
	user32                         = syscall.NewLazyDLL("user32.dll")
	procGetForegroundWindow        = user32.NewProc("GetForegroundWindow")
	procGetWindowTextW             = user32.NewProc("GetWindowTextW")
	procGetWindowThreadProcessId   = user32.NewProc("GetWindowThreadProcessId")
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess                = kernel32.NewProc("OpenProcess")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
	procCloseHandle                = kernel32.NewProc("CloseHandle")
)

//nolint:unused
const (
	processQueryLimitedInformation = 0x1000
)

// captureForegroundWindow lê a janela em foco agora — título + nome do
// processo. Não testável em CI (precisa de sessão desktop interativa real);
// verificar manualmente rodando o companion numa máquina Windows de teste.
//
//nolint:unused
func captureForegroundWindow() (windowTitle string, processName string, err error) {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return "", "", fmt.Errorf("nenhuma janela em foco")
	}

	buf := make([]uint16, 512)
	_, _, _ = procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf))) //nolint:errcheck
	windowTitle = syscall.UTF16ToString(buf)

	var pid uint32
	_, _, _ = procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid))) //nolint:errcheck
	if pid == 0 {
		return windowTitle, "", fmt.Errorf("pid não encontrado pra janela em foco")
	}

	hProcess, _, _ := procOpenProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if hProcess == 0 {
		return windowTitle, "", fmt.Errorf("OpenProcess falhou pro pid %d", pid)
	}
	defer func() { _, _, _ = procCloseHandle.Call(hProcess) }() //nolint:errcheck

	pathBuf := make([]uint16, 512)
	pathLen := uint32(len(pathBuf))
	ret, _, _ := procQueryFullProcessImageNameW.Call(
		hProcess, 0, uintptr(unsafe.Pointer(&pathBuf[0])), uintptr(unsafe.Pointer(&pathLen)),
	)
	if ret == 0 {
		return windowTitle, "", fmt.Errorf("QueryFullProcessImageName falhou pro pid %d", pid)
	}
	fullPath := syscall.UTF16ToString(pathBuf[:pathLen])
	parts := strings.Split(strings.ReplaceAll(fullPath, "/", "\\"), "\\")
	processName = parts[len(parts)-1]

	return windowTitle, processName, nil
}
