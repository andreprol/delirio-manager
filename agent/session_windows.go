package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
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

	// Teto de sanidade: WTSEnumerateSessionsW nunca devolve milhares de
	// sessões numa máquina real (cada uma é um login RDP/console ativo).
	// Sem este check, um count implausível (corrupção de ABI, bug de driver)
	// faria unsafe.Slice/make tentar alocar/iterar um array gigante e
	// panicar, derrubando o processo companion inteiro na máquina.
	const maxPlausibleSessions = 4096
	if count > maxPlausibleSessions {
		return nil, fmt.Errorf("WTSEnumerateSessionsW devolveu count implausível: %d", count)
	}

	rawSlice := unsafe.Slice(pSessionInfo, count)
	sessions := make([]sessionInfo, 0, count)
	for _, raw := range rawSlice {
		sessions = append(sessions, sessionInfo{ID: raw.SessionID, State: wtsSessionState(raw.State)})
	}
	return sessions, nil
}

// shouldRelaunchCompanion decide se o companion precisa ser (re)lançado:
// se não está vivo, ou se a sessão ativa mudou desde o último lançamento
// (logoff/logon — o companion antigo ficou órfão numa sessão que já não
// é mais a ativa).
func shouldRelaunchCompanion(companionAlive bool, sessionChanged bool) bool {
	return !companionAlive || sessionChanged
}

// tokenAccessForCreateProcessAsUser é o conjunto de direitos que o token
// primário duplicado precisa ter pra CreateProcessAsUser funcionar.
// TOKEN_QUERY, TOKEN_DUPLICATE e TOKEN_ASSIGN_PRIMARY são os 3 documentados
// pela Microsoft como exigidos no parâmetro hToken de CreateProcessAsUser —
// faltar TOKEN_ASSIGN_PRIMARY em particular é a causa clássica de
// CreateProcessAsUserW falhar com ERROR_PRIVILEGE_NOT_HELD/ACCESS_DENIED.
// TOKEN_ADJUST_DEFAULT e TOKEN_ADJUST_SESSIONID são superset defensivo (não
// estritamente necessários pra este fluxo, que não chama SetTokenInformation
// pra ajustar sessão/DACL manualmente — WTSQueryUserToken já amarra o token
// à sessão certa), mantidos por serem inofensivos e comuns em exemplos
// equivalentes. Cada direito é nomeado explicitamente em vez de usar
// MAXIMUM_ALLOWED (que dependeria do ACL do token de origem).
const tokenAccessForCreateProcessAsUser = windows.TOKEN_QUERY |
	windows.TOKEN_ASSIGN_PRIMARY |
	windows.TOKEN_DUPLICATE |
	windows.TOKEN_ADJUST_DEFAULT |
	windows.TOKEN_ADJUST_SESSIONID

// injectFeatureFlagIntoEnvBlock devolve uma CÓPIA do bloco de ambiente no
// formato que CreateEnvironmentBlock/CreateProcessAsUser esperam (sequência
// de strings UTF16 cada uma terminada em \0, bloco inteiro terminado em \0
// duplo) com key=value adicionado — ou sobrescrito, se key já existisse
// (comparação case-insensitive, como o Windows trata nomes de variável de
// ambiente). Existe pra garantir que o companion veja EXATAMENTE o valor
// de FEATURE_LIVE_ACCESS que o SERVIÇO vê, em vez de depender de onde a
// flag foi configurada no sistema (HKLM\Environment, visível a todo
// processo, vs HKCU do usuário da sessão, que é a fonte real do bloco
// devolvido por CreateEnvironmentBlock) — sem isso, a flag podia estar
// ligada só no ambiente do serviço e nunca chegar ao companion, deixando
// metade da feature ativa (sessionWatchLoop lança o companion) e a outra
// metade inativa (activityReportLoop gated pela mesma flag, mas lida
// localmente dentro do companion via os.Getenv), sem nenhum erro visível.
func injectFeatureFlagIntoEnvBlock(block *uint16, key, value string) (*uint16, error) {
	var entries []string
	start := 0
	for i := 0; ; i++ {
		c := *(*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(block)) + uintptr(i)*2))
		if c != 0 {
			continue
		}
		if i == start {
			break // string vazia (dois \0 seguidos) = fim do bloco
		}
		entries = append(entries, windows.UTF16ToString(unsafe.Slice(block, i)[start:i]))
		start = i + 1
	}

	prefix := strings.ToUpper(key) + "="
	filtered := entries[:0]
	for _, e := range entries {
		if !strings.HasPrefix(strings.ToUpper(e), prefix) {
			filtered = append(filtered, e)
		}
	}
	filtered = append(filtered, key+"="+value)

	var buf []uint16
	for _, e := range filtered {
		u, err := windows.UTF16FromString(e)
		if err != nil {
			return nil, fmt.Errorf("UTF16FromString(%q): %w", e, err)
		}
		buf = append(buf, u...) // já inclui o \0 final de cada entrada
	}
	buf = append(buf, 0) // \0 duplo (fim do bloco inteiro)

	return &buf[0], nil
}

// launchCompanion lança delirio-agent.exe --companion na sessão sessionID,
// usando o token do usuário logado nela (WTSQueryUserToken + DuplicateTokenEx
// + CreateProcessAsUser — o padrão Session-0-isolation de qualquer serviço
// que precisa de um processo auxiliar na sessão interativa do usuário).
// O processo herda o token do próprio usuário (não SYSTEM, sem elevação) e
// aparece normalmente no Gerenciador de Tarefas.
//
// Devolve também o handle do processo (aberto, não fechado aqui) — o
// chamador (sessionWatchLoop) é quem decide quando fechar, porque precisa
// dele vivo pra checar liveness depois via isCompanionAlive (ver comentário
// lá: reabrir por PID seria vulnerável a reuso de PID pelo Windows).
//
// Não testável em CI — exige contexto SYSTEM real com SeTcbPrivilege e uma
// sessão desktop real. Verificar manualmente numa VM/PC de teste: logar,
// confirmar que o serviço lança o companion e que delirio-agent.exe aparece
// 2x no Gerenciador de Tarefas (serviço + companion), o companion sem
// privilégio elevado.
func launchCompanion(sessionID uint32) (companionPID uint32, companionHandle windows.Handle, err error) {
	var userToken windows.Token
	if err := windows.WTSQueryUserToken(sessionID, &userToken); err != nil {
		return 0, 0, fmt.Errorf("WTSQueryUserToken falhou pra sessão %d: %w", sessionID, err)
	}
	defer userToken.Close() //nolint:errcheck

	var primaryToken windows.Token
	if err := windows.DuplicateTokenEx(
		userToken, tokenAccessForCreateProcessAsUser, nil,
		windows.SecurityImpersonation, windows.TokenPrimary, &primaryToken,
	); err != nil {
		return 0, 0, fmt.Errorf("DuplicateTokenEx falhou: %w", err)
	}
	defer primaryToken.Close() //nolint:errcheck

	// Bloco de ambiente do USUÁRIO da sessão (não do SYSTEM que lança o
	// processo) — sem isso o companion herdaria %APPDATA%/%USERPROFILE% do
	// contexto errado. Documentado pela Microsoft como o jeito correto de
	// popular lpEnvironment em CreateProcessAsUser.
	var envBlock *uint16
	if err := windows.CreateEnvironmentBlock(&envBlock, primaryToken, false); err != nil {
		return 0, 0, fmt.Errorf("CreateEnvironmentBlock falhou: %w", err)
	}
	defer windows.DestroyEnvironmentBlock(envBlock) //nolint:errcheck

	// FEATURE_LIVE_ACCESS injetada explicitamente com o valor que o SERVIÇO
	// vê (os.Getenv), não deixada pro bloco de ambiente do usuário — ver
	// injectFeatureFlagIntoEnvBlock pro porquê (finding da revisão final
	// cross-cutting: sem isso, a flag podia estar ligada só no processo do
	// serviço e nunca chegar ao companion, ativando metade da feature sem
	// erro nenhum).
	patchedEnvBlock, err := injectFeatureFlagIntoEnvBlock(envBlock, "FEATURE_LIVE_ACCESS", os.Getenv("FEATURE_LIVE_ACCESS"))
	if err != nil {
		return 0, 0, fmt.Errorf("injectFeatureFlagIntoEnvBlock falhou: %w", err)
	}

	exePath, err := os.Executable()
	if err != nil {
		return 0, 0, fmt.Errorf("os.Executable: %w", err)
	}
	cmdLine := fmt.Sprintf(`"%s" --companion`, exePath)
	cmdLineUTF16, err := windows.UTF16PtrFromString(cmdLine)
	if err != nil {
		return 0, 0, fmt.Errorf("UTF16PtrFromString(cmdLine): %w", err)
	}
	desktopUTF16, err := windows.UTF16PtrFromString(`winsta0\default`)
	if err != nil {
		return 0, 0, fmt.Errorf("UTF16PtrFromString(desktop): %w", err)
	}

	si := windows.StartupInfo{Desktop: desktopUTF16}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation

	const createUnicodeEnvironment = windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_NO_WINDOW
	if err := windows.CreateProcessAsUser(
		primaryToken, nil, cmdLineUTF16, nil, nil, false,
		createUnicodeEnvironment, patchedEnvBlock, nil, &si, &pi,
	); err != nil {
		return 0, 0, fmt.Errorf("CreateProcessAsUser falhou: %w", err)
	}
	defer windows.CloseHandle(pi.Thread) //nolint:errcheck

	return pi.ProcessId, pi.Process, nil
}

const stillActive = 259 // STILL_ACTIVE — valor de exit code enquanto o processo roda

// isCompanionAlive confere se o processo do handle dado ainda está rodando.
// Recebe o handle aberto por launchCompanion (mantido vivo pelo chamador)
// em vez de reabrir por PID: reabrir por PID é vulnerável a reuso de PID
// pelo Windows (o companion morre, outro processo não relacionado nasce com
// o mesmo PID, e processIsAlive(pid) voltaria "vivo" falso, quebrando a
// auto-cura do watcher silenciosamente).
func isCompanionAlive(handle windows.Handle) bool {
	if handle == 0 {
		return false
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(handle, &exitCode); err != nil {
		return false
	}
	return exitCode == stillActive
}
