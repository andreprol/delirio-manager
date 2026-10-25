package main

import (
	"fmt"
	"os"
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

// createCompanionJobObject cria um Job Object sem nome com
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE — qualquer processo atribuído a ele
// (via AssignProcessToJobObject em launchCompanion) morre junto quando o
// handle do job é fechado. Como o handle só existe na tabela de handles do
// próprio SERVIÇO, fechar — explicitamente (terminateCompanion, a cada
// relançamento/stop), ou implicitamente quando o processo do serviço
// termina de QUALQUER forma (crash, kill externo, SCM matando por timeout)
// — mata o companion junto, sem depender de nenhum código de cleanup
// rodar antes.
//
// Um job NOVO é criado a cada chamada de launchCompanion (não 1 job
// reusado pra vida inteira do serviço) de propósito: a documentação da
// Microsoft pra CreateJobObject diz que um job fica "sem sessão" até o
// PRIMEIRO AssignProcessToJobObject, e passa a ficar associado à sessão
// desse primeiro processo — reusar o mesmo job entre relançamentos em
// SESSÕES DIFERENTES (logoff/logon pra outro usuário) arriscaria o
// AssignProcessToJobObject do companion novo falhar por mismatch de
// sessão com o companion antigo que já usou esse job. Um job por geração
// de companion evita essa ambiguidade — current.Session nunca é
// reaproveitada.
//
// Backstop estrutural: terminateCompanion (agent.go) continua sendo o
// caminho RÁPIDO e deliberado pras transições conhecidas (logoff/logon,
// stop, self-update, uninstall) — o Job Object existe pros caminhos que
// esse código não cobre. Ver finding da 2ª revisão final cross-cutting
// deste plano: sem isso, um companion órfão (serviço morto sem passar por
// nenhum caminho de cleanup) ficava detendo a pipe pra sempre, e o
// companion novo nunca mais conseguia nascer de verdade.
func createCompanionJobObject() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("CreateJobObject falhou: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return 0, fmt.Errorf("SetInformationJobObject falhou: %w", err)
	}
	return job, nil
}

// launchCompanion lança delirio-agent.exe --companion na sessão sessionID,
// usando o token do usuário logado nela (WTSQueryUserToken + DuplicateTokenEx
// + CreateProcessAsUser — o padrão Session-0-isolation de qualquer serviço
// que precisa de um processo auxiliar na sessão interativa do usuário).
// O processo herda o token do próprio usuário (não SYSTEM, sem elevação) e
// aparece normalmente no Gerenciador de Tarefas.
//
// Devolve também o handle do processo (aberto, não fechado aqui) e o handle
// do Job Object recém-criado pra ele (idem) — o chamador (sessionWatchLoop)
// é quem decide quando fechar ambos, porque precisa do handle do processo
// vivo pra checar liveness depois via isCompanionAlive (ver comentário lá:
// reabrir por PID seria vulnerável a reuso de PID pelo Windows) e do handle
// do job vivo pra matar o companion via terminateCompanion mais tarde.
//
// Não testável em CI — exige contexto SYSTEM real com SeTcbPrivilege e uma
// sessão desktop real. Verificar manualmente numa VM/PC de teste: logar,
// confirmar que o serviço lança o companion e que delirio-agent.exe aparece
// 2x no Gerenciador de Tarefas (serviço + companion), o companion sem
// privilégio elevado.
func launchCompanion(sessionID uint32) (companionPID uint32, companionHandle windows.Handle, companionJob windows.Handle, err error) {
	var userToken windows.Token
	if err := windows.WTSQueryUserToken(sessionID, &userToken); err != nil {
		return 0, 0, 0, fmt.Errorf("WTSQueryUserToken falhou pra sessão %d: %w", sessionID, err)
	}
	defer userToken.Close() //nolint:errcheck

	var primaryToken windows.Token
	if err := windows.DuplicateTokenEx(
		userToken, tokenAccessForCreateProcessAsUser, nil,
		windows.SecurityImpersonation, windows.TokenPrimary, &primaryToken,
	); err != nil {
		return 0, 0, 0, fmt.Errorf("DuplicateTokenEx falhou: %w", err)
	}
	defer primaryToken.Close() //nolint:errcheck

	// Bloco de ambiente do USUÁRIO da sessão (não do SYSTEM que lança o
	// processo — sem isso o companion herdaria %APPDATA%/%USERPROFILE% do
	// contexto errado; documentado pela Microsoft como o jeito correto de
	// popular lpEnvironment em CreateProcessAsUser). FEATURE_LIVE_ACCESS não
	// precisa mais ser injetada aqui — o companion lê featureLiveAccess
	// direto do config.json dele (mesmo arquivo que o serviço usa), não do
	// ambiente do processo.
	var envBlock *uint16
	if err := windows.CreateEnvironmentBlock(&envBlock, primaryToken, false); err != nil {
		return 0, 0, 0, fmt.Errorf("CreateEnvironmentBlock falhou: %w", err)
	}
	defer windows.DestroyEnvironmentBlock(envBlock) //nolint:errcheck

	exePath, err := os.Executable()
	if err != nil {
		return 0, 0, 0, fmt.Errorf("os.Executable: %w", err)
	}
	cmdLine := fmt.Sprintf(`"%s" --companion`, exePath)
	cmdLineUTF16, err := windows.UTF16PtrFromString(cmdLine)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("UTF16PtrFromString(cmdLine): %w", err)
	}
	desktopUTF16, err := windows.UTF16PtrFromString(`winsta0\default`)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("UTF16PtrFromString(desktop): %w", err)
	}

	// Job novo pra esta geração do companion (ver doc de
	// createCompanionJobObject pro porquê de não reusar 1 job entre
	// gerações). Criado antes do CreateProcessAsUser pra podermos atribuir
	// o processo a ele ainda suspenso, sem nenhuma janela de execução fora
	// do guarda-chuva de kill-on-close.
	job, err := createCompanionJobObject()
	if err != nil {
		return 0, 0, 0, fmt.Errorf("createCompanionJobObject: %w", err)
	}

	si := windows.StartupInfo{Desktop: desktopUTF16}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation

	// CREATE_SUSPENDED: nasce suspenso pra poder entrar no Job Object ANTES
	// de rodar uma única instrução — sem isso haveria uma janela (por menor
	// que seja) em que o companion já está executando mas ainda não está
	// sob o guarda-chuva de kill-on-close do job.
	const createFlags = windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_NO_WINDOW | windows.CREATE_SUSPENDED
	if err := windows.CreateProcessAsUser(
		primaryToken, nil, cmdLineUTF16, nil, nil, false,
		createFlags, envBlock, nil, &si, &pi,
	); err != nil {
		_ = windows.CloseHandle(job)
		return 0, 0, 0, fmt.Errorf("CreateProcessAsUser falhou: %w", err)
	}
	defer windows.CloseHandle(pi.Thread) //nolint:errcheck

	// assignToJobAndResume já fecha job (e o processo, via TerminateProcess)
	// internamente se qualquer passo falhar — devolve effectiveJob=0 nesse
	// caso, nada mais pra limpar aqui.
	effectiveJob, err := assignToJobAndResume(job, pi)
	if err != nil {
		return 0, 0, 0, err
	}

	return pi.ProcessId, pi.Process, effectiveJob, nil
}

// assignToJobAndResume atribui o processo recém-criado (ainda suspenso) ao
// Job Object e resume a thread principal. Extraído de launchCompanion só
// pra manter a complexidade ciclomática dela dentro do limite do projeto
// (cyclop, max 10).
//
// Devolve effectiveJob=0 (não job) quando AssignProcessToJobObject falha —
// nesse caso job existe mas está VAZIO (o companion nunca entrou nele), e
// devolver job mesmo assim faria o chamador achar, erroneamente, que tem um
// backstop funcionando. Fecha o handle do job inútil aqui mesmo (não é
// fatal pro companion em si, que segue rodando sem o backstop — só perde a
// garantia de cleanup automático em caminhos de saída não previstos; por
// isso loga ERROR, não devolve erro).
func assignToJobAndResume(job windows.Handle, pi windows.ProcessInformation) (effectiveJob windows.Handle, err error) {
	if err := windows.AssignProcessToJobObject(job, pi.Process); err != nil {
		logError(fmt.Sprintf("launchCompanion: AssignProcessToJobObject falhou (companion roda sem o backstop de cleanup): %v", err))
		_ = windows.CloseHandle(job)
		job = 0
	}
	if _, err := windows.ResumeThread(pi.Thread); err != nil {
		// Suspenso pra sempre seria peor que não ter companion nenhum —
		// mata e devolve erro, pro watcher tentar de novo com backoff.
		_ = windows.TerminateProcess(pi.Process, 1)
		_ = windows.CloseHandle(pi.Process)
		if job != 0 {
			_ = windows.CloseHandle(job)
		}
		return 0, fmt.Errorf("ResumeThread falhou: %w", err)
	}
	return job, nil
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
