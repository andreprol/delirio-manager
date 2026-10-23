package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

type wtsSessionState uint32

const (
	wtsStateActive       wtsSessionState = 0
	wtsStateConnected    wtsSessionState = 1
	wtsStateDisconnected wtsSessionState = 4
)

type sessionInfo struct {
	ID    uint32
	State wtsSessionState
}

// pickActiveSession escolhe a sessão WTS_ACTIVE (usuário efetivamente
// logado e com desktop visível) numa lista de sessões. Sem sessão ativa
// (ex: tela de login, máquina travada), retorna ok=false — não lança o
// companion nesse caso.
func pickActiveSession(sessions []sessionInfo) (uint32, bool) {
	for _, s := range sessions {
		if s.State == wtsStateActive {
			return s.ID, true
		}
	}
	return 0, false
}

//nolint:unused // ligado pela Task 5 (enumerateSessions chama WTSEnumerateSessionsW de verdade)
var (
	wtsapi32                  = syscall.NewLazyDLL("wtsapi32.dll")
	procWTSEnumerateSessionsW = wtsapi32.NewProc("WTSEnumerateSessionsW")
	procWTSFreeMemory         = wtsapi32.NewProc("WTSFreeMemory")
)

//nolint:unused // ligado pela Task 5 (campo raw devolvido por WTSEnumerateSessionsW)
type wtsSessionInfoRaw struct {
	SessionID      uint32
	WinStationName *uint16
	State          uint32
}

// enumerateSessions chama WTSEnumerateSessionsW de verdade — não testável
// em CI (exige contexto SYSTEM real). Verificar manualmente. Ainda não é
// chamada por nada: a Task 5 liga o fio (chama enumerateSessions e passa
// o resultado pra pickActiveSession).
//
//nolint:unused // ligado pela Task 5
func enumerateSessions() ([]sessionInfo, error) {
	// pSessionInfo é declarado como ponteiro real (não uintptr) pro Windows
	// escrever o endereço retornado diretamente nele — isso evita o
	// round-trip uintptr->unsafe.Pointer que o `go vet` (unsafeptr) rejeita
	// como "possible misuse of unsafe.Pointer".
	var pSessionInfo *wtsSessionInfoRaw
	var count uint32

	ret, _, err := procWTSEnumerateSessionsW.Call(
		0, // WTS_CURRENT_SERVER_HANDLE
		0, 1,
		uintptr(unsafe.Pointer(&pSessionInfo)),
		uintptr(unsafe.Pointer(&count)),
	)
	if ret == 0 {
		return nil, fmt.Errorf("WTSEnumerateSessionsW falhou: %w", err)
	}
	defer procWTSFreeMemory.Call(uintptr(unsafe.Pointer(pSessionInfo))) //nolint:errcheck

	rawSlice := unsafe.Slice(pSessionInfo, count)
	sessions := make([]sessionInfo, 0, count)
	for _, raw := range rawSlice {
		sessions = append(sessions, sessionInfo{ID: raw.SessionID, State: wtsSessionState(raw.State)})
	}
	return sessions, nil
}
