package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/gorilla/websocket"
)

// ole32 é novo aqui -- user32/kernel32/shell32 já declarados em
// activity_windows.go/input_windows.go (mesmo pacote).
var ole32 = syscall.NewLazyDLL("ole32.dll")

var (
	procSHBrowseForFolderW   = shell32.NewProc("SHBrowseForFolderW")
	procSHGetPathFromIDListW = shell32.NewProc("SHGetPathFromIDListW")
	procCoInitializeEx       = ole32.NewProc("CoInitializeEx")
	procCoUninitialize       = ole32.NewProc("CoUninitialize")
	procCoTaskMemFree        = ole32.NewProc("CoTaskMemFree")
	// procSetForegroundWindow/procSetWindowPos (user32, já declarado em
	// activity_windows.go) -- ver browseCallbackProc abaixo pro motivo.
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procSetWindowPos        = user32.NewProc("SetWindowPos")
)

const (
	coinitApartmentThreaded = 0x2
	bifReturnOnlyFSDirs     = 0x0001 // só pastas de sistema de arquivos de verdade (nunca "Rede"/"Lixeira" etc.)
	bifNewDialogStyle       = 0x0040 // dialog redimensionável moderno -- exige COM inicializado na thread (ver browseRemoteFolder)
	bifEditBox              = 0x0010 // campo de texto no dialog -- deixa colar/digitar um caminho direto, sem navegar pasta por pasta

	bffmInitialized = 1 // BFFM_INITIALIZED -- mensagem que o callback recebe assim que o dialog termina de montar, com o HWND de verdade

	swpNoMove = 0x0002
	swpNoSize = 0x0001
)

// hwndTopmost é (HWND)-1 (HWND_TOPMOST) -- valor -1 reinterpretado como
// uintptr sem sinal, mesmo bit pattern que o Win32 espera. const (não var):
// ^uintptr(0) é expressão constante em Go, achado 🔵 do code-reviewer.
const hwndTopmost = ^uintptr(0)

// browseTopmostReassertDuration/Interval: achado 🟡 do code-reviewer -- um
// único SetWindowPos na montagem perde a corrida se a janela que já
// estava em primeiro plano (ex: o diálogo de lock do incidente real) se
// auto-reafirmar HWND_TOPMOST de tempos em tempos (comum em telas de
// lock/kiosk, de propósito, pra resistir a ser coberta) -- o dialog pode
// ficar aberto minutos esperando o operador escolher a pasta. Reforça por
// um tempo curto logo no início (quando a corrida é mais provável), nunca
// pra sempre -- não existe pra "vencer" uma janela LEGITIMAMENTE mais
// importante que apareça depois (ex: um UAC real). var, não const --
// mesmo motivo de blockInputWorkerTimeout/localInputLockFailsafe
// (input_windows.go): teste encurta pra não ficar lento de verdade.
var (
	browseTopmostReassertDuration = 3 * time.Second
	browseTopmostReassertInterval = 300 * time.Millisecond
)

// browseCallbackProc é o BFFCALLBACK do Win32 (bi.lpfn) -- recebe o HWND
// de verdade do dialog assim que ele termina de montar (BFFM_INITIALIZED).
//
// Achado real AO VIVO (14/11/2026, André testando numa loja de verdade):
// sem isto, SHBrowseForFolderW abre o dialog, mas ele nasce atrás de
// QUALQUER janela que já estivesse em primeiro plano na tela remota (no
// caso real, um diálogo de login travado, "Aloha Configuration Center
// Lock") -- invisível pro operador no vídeo da sessão, nenhum clique
// alcança, companion fica preso na chamada síncrona esperando um clique
// que nunca chega ("fica pensando" pro operador, sem erro nenhum). Um
// processo sem foco próprio (o companion roda via CreateProcessAsUser,
// nunca recebeu input "de verdade" do ponto de vista da heurística de
// foreground-lock do Windows) não consegue roubar o foco de outro
// processo só com SetForegroundWindow -- por isso SetWindowPos com
// HWND_TOPMOST também, que não depende dessa permissão: garante o
// dialog VISÍVEL (no topo do z-order) mesmo se SetForegroundWindow
// falhar silenciosamente.
func browseCallbackProc(hwnd uintptr, uMsg uint32, lParam, lpData uintptr) uintptr {
	if uMsg == bffmInitialized {
		setForegroundWindowFn(hwnd)
		setWindowPosTopmostFn(hwnd)
		// Achado 🟠 do code-reviewer: capturar browseDialogDone AQUI (POR
		// VALOR, antes do safeGo) -- não dentro da goroutine spawnada, que
		// só leria a var de pacote quando de fato executasse, sem garantia
		// de ordem contra uma 2ª chamada de browseRemoteFolder reatribuindo
		// browseDialogDone nesse meio-tempo (a goroutine da 1ª chamada
		// passaria a observar o canal da 2ª, nunca veria o close da sua
		// própria chamada). Esta leitura aqui é síncrona dentro da MESMA
		// chamada de SHBrowseForFolderW que a disparou -- browseDialogDone
		// já foi atribuído antes dessa chamada começar (browseRemoteFolder),
		// então é garantidamente o canal certo pra ESTA invocação.
		done := browseDialogDone
		safeGo("browse-remote-folder-topmost-reassert", func() { reassertTopmostFor(hwnd, done) })
	}
	return 0
}

// browseDialogDone: achado 🟡 do code-reviewer -- reassertTopmostFor
// (abaixo) rodava um timer CEGO, sem saber se o dialog já tinha sido
// fechado pelo operador. HWNDs do Win32 vêm de uma tabela pequena (16
// bits) e podem ser RECICLADOS pra uma janela completamente diferente em
// poucos segundos -- continuar chamando setWindowPosTopmostFn no hwnd
// antigo depois do dialog fechar arriscava forçar uma janela SEM RELAÇÃO
// nenhuma pro topo do z-order da tela remota, a mesma classe de confusão
// visual que esta feature existe pra evitar (versão invertida do
// incidente original). browseRemoteFolder fecha este canal assim que
// SHBrowseForFolderW retorna (dialog já fechado, de um jeito ou de
// outro) -- reassertTopmostFor para na hora, nunca espera o resto da
// duration. Var de pacote (não parâmetro passado pelo Win32) porque o
// callback C só aceita os 4 parâmetros fixos do BFFCALLBACK -- só 1
// dialog por vez faz sentido pra esta feature (1 operador, 1 sessão ao
// vivo por máquina), então um singleton é aceitável.
var browseDialogDone chan struct{}

// browseRemoteFolderInProgress serializa browseRemoteFolder -- ver
// comentário de uso em browseRemoteFolder (achado 🟡 do code-reviewer).
// 0 = livre, 1 = já tem um dialog aberto.
var browseRemoteFolderInProgress int32

// reassertTopmostFor repete setWindowPosTopmostFn a cada
// browseTopmostReassertInterval, até browseTopmostReassertDuration passar
// OU done fechar (o que vier primeiro) -- ver comentários das 2 vars
// acima pro motivo de cada limite. Roda numa goroutine própria (safeGo)
// pra não bloquear o callback nem a chamada síncrona de
// SHBrowseForFolderW. done nil (só acontece em teste isolado de
// browseCallbackProc, nunca em produção) nunca fica "pronto" num select,
// efeito prático = só o limite de duration vale.
func reassertTopmostFor(hwnd uintptr, done <-chan struct{}) {
	ticker := time.NewTicker(browseTopmostReassertInterval)
	defer ticker.Stop()
	deadline := time.Now().Add(browseTopmostReassertDuration)
	// Checa o deadline no FOR, não só dentro do select -- um
	// browseTopmostReassertDuration zero/já vencido tem que sair na hora,
	// sem esperar o 1º tick do ticker (que só dispararia depois de
	// browseTopmostReassertInterval inteiro).
	for time.Now().Before(deadline) {
		select {
		case <-done:
			return
		case <-ticker.C:
			setWindowPosTopmostFn(hwnd)
		}
	}
}

// setForegroundWindowFn/setWindowPosTopmostFn indirecionam as 2 chamadas
// Win32 de browseCallbackProc -- permite testar a LÓGICA (só dispara em
// BFFM_INITIALIZED, nunca noutra mensagem) sem HWND real nenhum, mesmo
// padrão já usado em injectMouseMoveFn/blockInputSyscallDirectFn
// (input_windows.go).
var (
	setForegroundWindowFn = func(hwnd uintptr) { procSetForegroundWindow.Call(hwnd) } //nolint:errcheck // best-effort, ver setWindowPosTopmostFn como garantia real
	setWindowPosTopmostFn = func(hwnd uintptr) {
		procSetWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize) //nolint:errcheck // best-effort: se isto falhar, o dialog ainda funciona, só pode ficar atrás de outra janela
	}
)

// browseCallbackProcAddr: syscall.NewCallback aloca de um pool FINITO de
// callbacks (documentado no pacote syscall) e as entradas nunca são
// liberadas -- calcular isto 1x (var de pacote) em vez de dentro de
// browseRemoteFolder evita esgotar esse pool num agent de vida longa que
// pode abrir o dialog centenas de vezes ao longo de semanas de uptime.
var browseCallbackProcAddr = syscall.NewCallback(browseCallbackProc)

// browseInfoW espelha BROWSEINFOW do Win32 -- layout tem que bater
// EXATAMENTE (mesmo cuidado de sempre, ver kbdllhookstruct em
// winkeyhook/main.go e mouseInput/keybdInput em input_windows.go). Go já
// insere o mesmo padding que o C antes de lpfn (alinhamento de 8 bytes por
// conter um uintptr), sem precisar de campo manual.
type browseInfoW struct {
	hwndOwner      uintptr
	pidlRoot       uintptr
	pszDisplayName uintptr
	lpszTitle      uintptr
	ulFlags        uint32
	lpfn           uintptr
	lParam         uintptr
	iImage         int32
}

// browseRemoteFolderFn indireciona browseRemoteFolder -- permite mockar em
// teste (chamar SHBrowseForFolderW de verdade abre um dialog MODAL de
// verdade na tela, travando o processo de teste esperando um clique
// humano que nunca vem). Mesmo padrão já usado em
// injectMouseMoveFn/blockInputSyscallDirectFn (input_windows.go).
var browseRemoteFolderFn = browseRemoteFolder

// browseRemoteFolder abre o dialog nativo "Procurar pasta" do Windows NA
// TELA do usuário interativo da loja -- mesma sessão que o companion já
// captura (GDI/DXGI) e injeta mouse/teclado, então o dialog aparece no
// vídeo da sessão ao vivo e é clicável pelo mesmo controle remoto que já
// existe (não precisa de nada novo nesse sentido). Pedido explícito do
// André (14/11/2026): o botão "📂 Procurar pasta" só existia do lado
// LOCAL; o lado remoto tinha só um campo de texto editável sem dialog
// nenhum -- "o botão está sem função". Os comentários antigos deste
// projeto diziam que um dialog nativo remoto era impossível (sem Explorer
// rodando DENTRO da sessão pra loja clicar) -- isso está errado pro caso
// de uso real: quem clicaria no dialog é o OPERADOR, através do mesmo
// mouse/teclado injetado que já controla o resto da sessão Normal, não a
// loja.
//
// Roda dedicada numa goroutine com runtime.LockOSThread() -- diferente do
// worker de BlockInput (persistente, lock numa mensagem e unlock
// SEPARADO, precisa da MESMA thread nas duas pontas, ver
// startBlockInputWorker em input_windows.go), aqui é só 1 chamada
// bloqueante (abre, espera o usuário, retorna) -- trava a thread só
// durante ESTA chamada e destrava no fim, sem precisar de worker de vida
// longa nem canal. Travar é necessário porque SHBrowseForFolderW com
// BIF_NEWDIALOGSTYLE exige COM inicializado (CoInitializeEx) NA MESMA
// thread que faz a chamada (documentado pela Microsoft) -- sem
// LockOSThread, o scheduler do Go poderia migrar a goroutine pra outra
// thread do SO entre as duas chamadas, quebrando essa garantia.
func browseRemoteFolder() (path string, cancelled bool, err error) {
	// browseRemoteFolderInProgress: achado 🟡 do code-reviewer -- nada
	// impedia 2 chamadas concorrentes (2 cliques rápidos no botão, ou uma
	// mensagem duplicada/replay numa reconexão do WS -- o guard contra
	// duplo-clique é só client-side, no dashboard). 2 chamadas em paralelo
	// reatribuiriam browseDialogDone uma por cima da outra, fazendo a
	// goroutine de reassert da 1ª passar a observar o canal da 2ª (mesmo
	// risco que o achado de "leitura tardia" já corrigido acima, só que a
	// nível de chamada inteira, não só da goroutine). CompareAndSwap
	// recusa a 2ª chamada na hora, em vez de deixar as duas pisarem no
	// mesmo estado de pacote.
	if !atomic.CompareAndSwapInt32(&browseRemoteFolderInProgress, 0, 1) {
		return "", false, errors.New("browseRemoteFolder: já existe um seletor de pasta aberto nesta máquina -- feche o anterior antes de abrir outro")
	}
	defer atomic.StoreInt32(&browseRemoteFolderInProgress, 0)

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hr, _, _ := procCoInitializeEx.Call(0, coinitApartmentThreaded)
	// S_OK (0) ou S_FALSE (1, já inicializado nesta thread por outra lib)
	// contam como sucesso -- qualquer valor negativo (ex: RPC_E_CHANGED_MODE)
	// seria falha real, extremamente improvável numa thread nova dedicada.
	comInitialized := int32(hr) >= 0
	if !comInitialized {
		// Achado 🟡 do code-reviewer: seguir em frente mesmo sem COM fazia
		// SHBrowseForFolderW (com BIF_NEWDIALOGSTYLE, que EXIGE COM
		// inicializado nesta thread) falhar silenciosamente -- a falha virava
		// pidl==0, indistinguível de "usuário cancelou", escondendo o erro
		// real atrás de um falso "cancelamento".
		return "", false, fmt.Errorf("browseRemoteFolder: CoInitializeEx falhou (hr=%#x)", uint32(hr))
	}
	defer procCoUninitialize.Call() //nolint:errcheck // best-effort, goroutine terminando de qualquer jeito

	displayNameBuf := make([]uint16, maxPathChars)
	titlePtr, titleErr := syscall.UTF16PtrFromString("Selecione a pasta")
	if titleErr != nil {
		return "", false, fmt.Errorf("browseRemoteFolder: título inválido: %w", titleErr)
	}

	bi := browseInfoW{
		pszDisplayName: uintptr(unsafe.Pointer(&displayNameBuf[0])),
		lpszTitle:      uintptr(unsafe.Pointer(titlePtr)),
		ulFlags:        bifReturnOnlyFSDirs | bifNewDialogStyle | bifEditBox,
		lpfn:           browseCallbackProcAddr,
	}

	// browseDialogDone: fecha assim que SHBrowseForFolderW retornar (dialog
	// já fechado, por bem ou por mal) -- sinaliza reassertTopmostFor
	// (browseCallbackProc) a parar na hora, em vez de continuar forçando
	// topmost num HWND que pode já ter sido reciclado pra outra janela.
	// Ver comentário da var pra detalhe completo.
	browseDialogDone = make(chan struct{})
	defer close(browseDialogDone)

	pidl, _, _ := procSHBrowseForFolderW.Call(uintptr(unsafe.Pointer(&bi)))
	// 🔴 achado CRÍTICO do code-reviewer: pszDisplayName/lpszTitle viraram
	// uintptr ANTES desta chamada (não inline no .Call()), então
	// displayNameBuf/titlePtr já estavam "mortos" pro GC do Go assim que
	// `bi` foi montado -- o compilador só reconhece e protege a conversão
	// unsafe.Pointer→uintptr quando ela aparece INLINE no argumento de
	// Call() (é por isso que `&bi` aqui e `&pathBuf[0]` abaixo, feitos
	// assim, já são seguros). SHBrowseForFolderW só ESCREVE nesses buffers
	// enquanto o dialog modal fica aberto esperando o operador escolher
	// (pode levar minutos) -- um GC rodando nesse intervalo podia coletar/
	// reaproveitar a memória antes do Win32 escrever nela, corrompendo
	// memória de verdade. KeepAlive garante que os dois sobrevivam até
	// aqui, depois da chamada já ter terminado.
	runtime.KeepAlive(displayNameBuf)
	runtime.KeepAlive(titlePtr)
	if pidl == 0 {
		return "", true, nil // usuário cancelou ou fechou o dialog -- não é erro
	}
	// CoTaskMemFree: o PIDL é alocado pelo shell com o task allocator do
	// COM -- quem recebe tem que liberar (documentado pela Microsoft),
	// senão vaza memória a cada seleção.
	defer procCoTaskMemFree.Call(pidl) //nolint:errcheck // best-effort, sem retorno útil a checar

	pathBuf := make([]uint16, maxPathChars)
	ok, _, _ := procSHGetPathFromIDListW.Call(pidl, uintptr(unsafe.Pointer(&pathBuf[0])))
	if ok == 0 {
		return "", false, errors.New("SHGetPathFromIDListW falhou -- pasta selecionada não é um caminho de sistema de arquivos válido")
	}
	return syscall.UTF16ToString(pathBuf), false, nil
}

// remoteFolderPickResult é o protocolo de volta pro dashboard em resposta a
// "browse-remote-folder" -- mesmo canal de texto que remoteDirListing/
// fileTransferStatus (filetransfer_windows.go).
type remoteFolderPickResult struct {
	Type      string `json:"type"` // "remote-folder-picked" | "remote-folder-pick-cancelled" | "remote-folder-pick-error"
	Path      string `json:"path,omitempty"`
	Message   string `json:"message,omitempty"` // só em "remote-folder-pick-error"
	RequestID int64  `json:"requestId,omitempty"`
}

func sendRemoteFolderPickResult(w frameWriter, result remoteFolderPickResult) {
	if w == nil {
		return
	}
	b, err := json.Marshal(result)
	if err != nil {
		logWarn(fmt.Sprintf("companion: falha ao serializar resultado do seletor de pasta: %v", err))
		return
	}
	deadline := time.Now().Add(liveSessionWriteTimeout)
	if err := w.WriteMessageWithDeadline(websocket.TextMessage, b, deadline); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao mandar resultado do seletor de pasta: %v", err))
	}
}

// applyBrowseRemoteFolderFn indirecona applyBrowseRemoteFolder -- mesmo
// padrão de applyListRemoteDirFn (filetransfer_windows.go), pro teste de
// roteamento do dispatch (dispatchSessionControlInput) poder mockar sem
// disparar o dialog de verdade.
var applyBrowseRemoteFolderFn = applyBrowseRemoteFolder

// applyBrowseRemoteFolder roda numa goroutine própria (safeGo) -- mesmo
// motivo de applyListRemoteDir: o dialog fica esperando o usuário por
// tempo indefinido, não pode bloquear a goroutine leitora de mouse/
// teclado da sessão. Ecoa msg.RequestID na resposta, mesma correlação já
// usada por list-remote-dir/clipboard-get-file.
func applyBrowseRemoteFolder(msg inputMessage, sessionID string, w frameWriter) {
	safeGo("browse-remote-folder-"+sessionID, func() {
		path, cancelled, err := browseRemoteFolderFn()
		if err != nil {
			sendRemoteFolderPickResult(w, remoteFolderPickResult{Type: "remote-folder-pick-error", Message: err.Error(), RequestID: msg.RequestID})
			return
		}
		if cancelled {
			sendRemoteFolderPickResult(w, remoteFolderPickResult{Type: "remote-folder-pick-cancelled", RequestID: msg.RequestID})
			return
		}
		sendRemoteFolderPickResult(w, remoteFolderPickResult{Type: "remote-folder-picked", Path: path, RequestID: msg.RequestID})
	})
}
