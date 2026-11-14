package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
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
)

const (
	coinitApartmentThreaded = 0x2
	bifReturnOnlyFSDirs     = 0x0001 // só pastas de sistema de arquivos de verdade (nunca "Rede"/"Lixeira" etc.)
	bifNewDialogStyle       = 0x0040 // dialog redimensionável moderno -- exige COM inicializado na thread (ver browseRemoteFolder)
	bifEditBox              = 0x0010 // campo de texto no dialog -- deixa colar/digitar um caminho direto, sem navegar pasta por pasta
)

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
	}

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
