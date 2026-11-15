package main

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

// sessiondesktop_windows.go dá ao PRÓPRIO SERVIÇO (não só ao companion
// lançado dentro da sessão interativa do usuário) acesso direto à desktop
// Win32 ATIVA no momento -- "Winlogon" (tela de login/bloqueio/UAC),
// "Default" (depois do usuário logar) ou "Screen-saver". Motivo: hoje o
// acesso remoto só funciona com uma sessão Windows interativa de pé
// (sessionWatchTick, agent.go, só lança o companion com WTS_ACTIVE ou
// Disconnected reconectável, ver session_windows.go) -- login/lock/UAC/boot
// não tem nenhuma dessas, tela preta pro operador (item 1 da pendência
// "acesso remoto não pode depender do Windows de pé", 14/11/2026).
//
// Mecanismo: o serviço já roda como LocalSystem (ver main.go,
// ServiceStartName) -- essa conta tem permissão nativa (documentada pela
// própria Microsoft, "Window Stations and Desktops") pra se associar à
// window station interativa "WinSta0" e abrir qualquer desktop dela,
// incluindo "Winlogon". Um serviço comum (conta de serviço normal, sem
// privilégio SYSTEM) NÃO conseguiria fazer o mesmo -- essa é
// especificamente a permissão que falta pra um processo "ver" a tela de
// login sem companion. Com a thread chamadora anexada (SetThreadDesktop),
// o BitBlt/GetDIBits (GDI, screencapture_windows.go) e o SendInput
// (input_windows.go) que JÁ EXISTEM funcionam sem nenhuma mudança neles
// próprios -- só muda QUEM está rodando esse código (o serviço, via
// withActiveDesktopFn) e QUAL desktop a thread está anexada no momento.
//
// user32/kernel32 já declarados em activity_windows.go (mesmo pacote).
var (
	procOpenWindowStationW        = user32.NewProc("OpenWindowStationW")
	procSetProcessWindowStation   = user32.NewProc("SetProcessWindowStation")
	procCloseWindowStation        = user32.NewProc("CloseWindowStation")
	procOpenInputDesktop          = user32.NewProc("OpenInputDesktop")
	procSetThreadDesktop          = user32.NewProc("SetThreadDesktop")
	procCloseDesktop              = user32.NewProc("CloseDesktop")
	procGetUserObjectInformationW = user32.NewProc("GetUserObjectInformationW")
)

// Flags de acesso Win32 pra window station/desktop -- somados explicitamente
// (em vez de um único "ALL_ACCESS" mágico) pra deixar claro o que cada
// permissão cobre e evitar erro de memorização de constante.
const (
	winstaEnumDesktops      = 0x0001
	winstaReadAttributes    = 0x0002
	winstaAccessClipboard   = 0x0004
	winstaCreateDesktop     = 0x0008
	winstaWriteAttributes   = 0x0010
	winstaAccessGlobalAtoms = 0x0020
	winstaExitWindows       = 0x0040
	winstaEnumerate         = 0x0100
	winstaReadScreen        = 0x0200
	winstaAllAccess         = winstaEnumDesktops | winstaReadAttributes | winstaAccessClipboard |
		winstaCreateDesktop | winstaWriteAttributes | winstaAccessGlobalAtoms |
		winstaExitWindows | winstaEnumerate | winstaReadScreen

	desktopReadObjects     = 0x0001
	desktopCreateWindow    = 0x0002
	desktopCreateMenu      = 0x0004
	desktopHookControl     = 0x0008
	desktopJournalRecord   = 0x0010
	desktopJournalPlayback = 0x0020
	desktopEnumerate       = 0x0040
	desktopWriteObjects    = 0x0080
	desktopSwitchDesktop   = 0x0100
	desktopAllAccess       = desktopReadObjects | desktopCreateWindow | desktopCreateMenu |
		desktopHookControl | desktopJournalRecord | desktopJournalPlayback |
		desktopEnumerate | desktopWriteObjects | desktopSwitchDesktop

	// uoiName (UOI_NAME): índice pedido a GetUserObjectInformationW pra
	// devolver o NOME da desktop (ex: "Winlogon"), usado só em
	// activeDesktopName (diagnóstico/log).
	uoiName = 2
)

// isSessionZeroFn: indireção testável de isSessionZero (livesession_windows.go)
// -- permite testar withActiveDesktopIfSessionZero sem depender do mapa
// liveSessions de verdade.
var isSessionZeroFn = isSessionZero

// interactiveWindowStationOnce/interactiveWindowStationErr: achado 🟠 do
// code-reviewer -- a versão anterior (atomic.Bool + CompareAndSwap) só
// evitava uma 2ª goroutine REFAZER o trabalho, mas não a impedia de seguir
// em frente IMEDIATAMENTE assumindo sucesso enquanto a 1ª ainda estava no
// meio do OpenWindowStationW/SetProcessWindowStation (ou tinha acabado de
// falhar e ainda não tinha resetado o guard) -- uma corrida real entre
// captura de frame e injeção de teclado, por exemplo, podia fazer a 2ª
// chamar OpenInputDesktop antes da window station estar de fato associada.
// sync.Once bloqueia de VERDADE quem chega durante a 1ª execução (só
// libera depois que ela termina, sucesso ou falha) -- e, diferente do
// guard anterior, o resultado (inclusive uma falha) fica fixo pelo resto
// da vida do processo: não há retry. Isso é aceitável aqui porque a causa
// de uma falha (GPO bloqueando acesso a WinSta0, por exemplo) é uma
// condição ESTÁTICA da máquina, não transitória -- tentar nos mesmos
// moldes a cada mousemove só multiplicaria o custo do syscall sem chance
// real de um resultado diferente.
// interactiveWindowStationOnce é *sync.Once (ponteiro, não valor) só pra
// permitir reatribuição em teste (um *novo* sync.Once, nunca copiando o
// valor de um já existente -- copiar um sync.Once "usado" é UB e o linter
// copylocks acusaria na hora) -- produção nunca reatribui, só chama Do.
var (
	interactiveWindowStationOnce = &sync.Once{}
	interactiveWindowStationErr  error
)

// ensureInteractiveWindowStationFn: indireção testável -- mesmo padrão de
// setForegroundWindowFn/setWindowPosTopmostFn (folderpicker_windows.go).
var ensureInteractiveWindowStationFn = ensureInteractiveWindowStation

// ensureInteractiveWindowStation associa o PROCESSO (não a thread) à window
// station interativa "WinSta0" -- pré-requisito pra OpenInputDesktop
// funcionar (sem isso, o serviço está numa window station NÃO-interativa
// própria, como qualquer serviço Windows comum, e OpenInputDesktop falharia
// na hora). Roda só 1x na vida do processo (sync.Once) -- chamadas
// seguintes (sucesso OU falha) devolvem o mesmo resultado na hora, sem
// refazer os syscalls.
func ensureInteractiveWindowStation() error {
	interactiveWindowStationOnce.Do(func() {
		interactiveWindowStationErr = openAndSetInteractiveWindowStation()
	})
	return interactiveWindowStationErr
}

// openWindowStationFn/setProcessWindowStationFn/closeWindowStationFn:
// indireção testável das 3 chamadas Win32 de openAndSetInteractiveWindowStation
// -- achado 🟡 do code-reviewer (rodada de verificação): sem isso, nenhum
// teste exercitava o `sync.Once` de verdade (serialização, cache do erro
// entre chamadas) -- todo teste mockava a função INTEIRA
// (ensureInteractiveWindowStationFn), pulando a própria lógica que o
// `sync.Once` existe pra garantir. Mesmo padrão de
// openInputDesktopFn/setThreadDesktopFn/closeDesktopFn, logo abaixo.
var (
	openWindowStationFn = func() (uintptr, error) {
		nameUTF16, err := syscall.UTF16PtrFromString("WinSta0")
		if err != nil {
			return 0, fmt.Errorf("nome da window station inválido: %w", err)
		}
		h, _, callErr := procOpenWindowStationW.Call(uintptr(unsafe.Pointer(nameUTF16)), 0, uintptr(winstaAllAccess))
		if h == 0 {
			return 0, fmt.Errorf("OpenWindowStationW(WinSta0) falhou: %w", callErr)
		}
		return h, nil
	}
	setProcessWindowStationFn = func(h uintptr) error {
		ok, _, callErr := procSetProcessWindowStation.Call(h)
		if ok == 0 {
			return fmt.Errorf("SetProcessWindowStation falhou: %w", callErr)
		}
		return nil
	}
	closeWindowStationFn = func(h uintptr) {
		procCloseWindowStation.Call(h) //nolint:errcheck // best-effort, mesmo padrão de closeDesktopFn
	}
)

// openAndSetInteractiveWindowStation faz o trabalho de verdade de
// ensureInteractiveWindowStation -- extraído só pra separar "roda 1x"
// (sync.Once, acima) de "o que roda" (aqui), mais fácil de ler.
func openAndSetInteractiveWindowStation() error {
	h, err := openWindowStationFn()
	if err != nil {
		return fmt.Errorf("sessiondesktop: %w", err)
	}
	if err := setProcessWindowStationFn(h); err != nil {
		// achado 🔴 do code-reviewer: h (obtido com sucesso acima) nunca
		// era fechado neste caminho de erro -- com sync.Once isto só
		// aconteceria 1x na vida do processo agora (antes, o guard por
		// atomic.Bool permitia retry indefinido, vazando 1 handle por
		// tentativa), mas ainda vazava exatamente 1 handle de verdade.
		closeWindowStationFn(h)
		return fmt.Errorf("sessiondesktop: %w", err)
	}
	return nil
}

// openInputDesktopFn/setThreadDesktopFn/closeDesktopFn: indireção testável
// das 3 chamadas Win32 que withActiveDesktop encadeia -- permite testar a
// LÓGICA (ordem das chamadas, propagação de erro, que fn só roda depois de
// SetThreadDesktop ter sucesso, que o handle sempre fecha) sem nenhum
// desktop real, mesmo padrão de injectMouseMoveFn/blockInputSyscallDirectFn
// (input_windows.go).
var (
	openInputDesktopFn = func() (uintptr, error) {
		h, _, callErr := procOpenInputDesktop.Call(0, 0, uintptr(desktopAllAccess))
		if h == 0 {
			return 0, fmt.Errorf("OpenInputDesktop falhou: %w", callErr)
		}
		return h, nil
	}
	setThreadDesktopFn = func(h uintptr) error {
		ok, _, callErr := procSetThreadDesktop.Call(h)
		if ok == 0 {
			return fmt.Errorf("SetThreadDesktop falhou: %w", callErr)
		}
		return nil
	}
	closeDesktopFn = func(h uintptr) {
		procCloseDesktop.Call(h) //nolint:errcheck // best-effort, mesmo padrão de procCoTaskMemFree (folderpicker_windows.go)
	}
)

// withActiveDesktopFn: indireção testável de withActiveDesktop (mesmo
// padrão desta família de arquivos -- browseRemoteFolderFn,
// captureScreenJPEGFn etc).
var withActiveDesktopFn = withActiveDesktop

// withActiveDesktop roda fn com a thread chamadora ANEXADA à desktop ATIVA
// no momento ("Winlogon" = login/lock/UAC, "Default" = depois de logado,
// "Screen-saver" = protetor de tela) -- usado só em modo session-zero (ver
// isSessionZero/liveSessionHandle.sessionZero, livesession_windows.go),
// nunca no companion.
//
// runtime.LockOSThread é obrigatório: SetThreadDesktop é por-THREAD do SO,
// não por goroutine -- sem fixar a goroutine na mesma thread do SO até fn
// terminar, o scheduler do Go poderia migrá-la pra outra thread entre
// SetThreadDesktop e a chamada BitBlt/SendInput de verdade dentro de fn,
// silenciosamente voltando a mirar a desktop ERRADA (a que aquela outra
// thread do SO ainda tinha associada, nunca reanexada) -- mesma classe de
// cuidado já documentada em browseRemoteFolder (folderpicker_windows.go)
// pro requisito de COM por-thread do SHBrowseForFolderW.
//
// Reanexa a cada chamada (não guarda o handle entre capturas/injeções) de
// propósito -- qual desktop está ativa pode MUDAR no meio de uma sessão
// (ex: o usuário loga enquanto o operador olha a tela de login), e o custo
// de 3 syscalls extra por frame/evento é desprezível frente ao uso real
// (tela de login/UAC, não um jogo a 60fps).
func withActiveDesktop(fn func() error) error {
	if err := ensureInteractiveWindowStationFn(); err != nil {
		return err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	desktop, err := openInputDesktopFn()
	if err != nil {
		return fmt.Errorf("sessiondesktop: %w", err)
	}
	defer closeDesktopFn(desktop)

	if err := setThreadDesktopFn(desktop); err != nil {
		return fmt.Errorf("sessiondesktop: %w", err)
	}
	return fn()
}

// withActiveDesktopIfSessionZero roda fn diretamente quando ESTA sessão
// (sessionID) está rodando dentro do companion -- zero overhead, zero
// mudança de comportamento, idêntico a antes desta feature existir. Só
// quando o SERVIÇO está capturando/injetando direto pra ESTA sessão (sem
// companion) é que reanexa a thread chamadora à desktop ativa antes de
// rodar fn. Usado por applyMouseMove/applyMouseButton/applyKeyboardInput
// (input_windows.go).
//
// Consulta isSessionZeroFn (por sessionID, ver liveSessionHandle em
// livesession_windows.go) EM VEZ de um flag global -- achado 🟠 do
// code-reviewer: um bool de PACOTE colidia entre 2 sessionIDs rodando
// concorrentemente no mesmo processo (ex: overlap breve entre o stop de
// uma sessão antiga e o start de uma nova durante um reconnect) -- a
// sessão que terminasse primeiro desligava o flag global enquanto a outra
// ainda rodava, fazendo ela parar de reanexar a desktop silenciosamente.
func withActiveDesktopIfSessionZero(sessionID string, fn func() error) error {
	if !isSessionZeroFn(sessionID) {
		return fn()
	}
	return withActiveDesktopFn(fn)
}

// activeDesktopName devolve o nome da desktop ativa no momento (ex:
// "Winlogon", "Default", "Screen-saver") -- só pra diagnóstico/log (achado
// prático: saber QUAL desktop foi capturada de fato ajuda a confirmar em
// campo que o mecanismo pegou a tela certa, mesmo padrão de propósito do
// comentário de largura/altura/bpp em screencapture_windows.go). Nunca
// usado pra decisão de fluxo -- withActiveDesktop não depende do NOME,
// só de "qual quer que seja a desktop ativa agora".
func activeDesktopName() (string, error) {
	if err := ensureInteractiveWindowStationFn(); err != nil {
		return "", err
	}
	desktop, err := openInputDesktopFn()
	if err != nil {
		return "", fmt.Errorf("sessiondesktop: %w", err)
	}
	defer closeDesktopFn(desktop)

	var needed uint32
	procGetUserObjectInformationW.Call(desktop, uoiName, 0, 0, uintptr(unsafe.Pointer(&needed))) //nolint:errcheck // 1ª chamada só descobre o tamanho, falha nela é esperada
	if needed == 0 {
		return "", errors.New("sessiondesktop: GetUserObjectInformationW não devolveu tamanho do nome")
	}
	buf := make([]uint16, needed/2+1)
	ok, _, callErr := procGetUserObjectInformationW.Call(desktop, uoiName, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)*2), uintptr(unsafe.Pointer(&needed)))
	if ok == 0 {
		return "", fmt.Errorf("sessiondesktop: GetUserObjectInformationW falhou: %w", callErr)
	}
	return syscall.UTF16ToString(buf), nil
}
