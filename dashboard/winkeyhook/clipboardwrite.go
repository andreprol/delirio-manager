package main

// Escreve um arquivo de verdade no clipboard do Windows (CF_HDROP, mesmo
// formato que "Copiar" no Explorer usa) -- é o que deixa um Ctrl+V em
// QUALQUER app local (Explorer de verdade incluso, fora do Delirio
// Manager) colar o arquivo, sem precisar de interceptação nenhuma do lado
// de colar. Espelho de getClipboardFilePath (agent/input_windows.go, que
// LÊ o clipboard REMOTO) -- aqui é o lado oposto, ESCREVE no clipboard
// LOCAL do operador, ver dashboard/src/components/LiveSessionWindow.jsx.
//
// Binário separado do agent (go.mod distinto, ver comentário no topo de
// main.go) -- não dá pra importar o setClipboardText/openClipboardWithRetry
// de lá, por isso os mesmos padrões Win32 (GlobalAlloc/GlobalLock/
// SetClipboardData, retry de OpenClipboard, liberar hMem nos 2 branches de
// erro) são duplicados aqui, deliberadamente.

import (
	"fmt"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

const writeClipboardFileFlag = "--write-clipboard-file"

// writeClipboardFileArg procura a flag one-shot nos argumentos da CLI --
// só ativa quando a flag E o valor seguinte (o caminho) estão presentes;
// sem isso, main() segue pro modo normal (hook de teclado persistente).
func writeClipboardFileArg(args []string) (string, bool) {
	for i, a := range args {
		if a == writeClipboardFileFlag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

const (
	cfHDrop      = 15     // CF_HDROP
	gmemMoveable = 0x0002 // GMEM_MOVEABLE
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")

var (
	procOpenClipboard    = user32.NewProc("OpenClipboard")
	procCloseClipboard   = user32.NewProc("CloseClipboard")
	procEmptyClipboard   = user32.NewProc("EmptyClipboard")
	procSetClipboardData = user32.NewProc("SetClipboardData")
	procGlobalAlloc      = kernel32.NewProc("GlobalAlloc")
	procGlobalLock       = kernel32.NewProc("GlobalLock")
	procGlobalUnlock     = kernel32.NewProc("GlobalUnlock")
	procGlobalFree       = kernel32.NewProc("GlobalFree")
)

// openClipboardRetries/openClipboardRetryDelay: mesma tolerância a
// contenção transitória já usada em agent/input_windows.go
// (openClipboardWithRetry) -- outro processo com o clipboard aberto no
// instante exato é comum no Windows, não deveria falhar a cópia inteira na
// 1ª tentativa.
const (
	openClipboardRetries    = 5
	openClipboardRetryDelay = 20 * time.Millisecond
)

func openClipboardWithRetry() error {
	var lastErr error
	for i := 0; i < openClipboardRetries; i++ {
		ret, _, err := procOpenClipboard.Call(0)
		if ret != 0 {
			return nil
		}
		lastErr = err
		time.Sleep(openClipboardRetryDelay)
	}
	return fmt.Errorf("OpenClipboard falhou após %d tentativas: %w", openClipboardRetries, lastErr)
}

// dropFiles espelha DROPFILES do Win32 -- layout tem que bater exatamente
// (DWORD pFiles; POINT pt; BOOL fNC; BOOL fWide;), todos campos de 4 bytes
// já alinhados, sem padding implícito.
type dropFiles struct {
	PFiles uint32
	Pt     struct{ X, Y int32 }
	FNC    int32
	FWide  int32
}

// writeClipboardFile grava filePath no clipboard do Windows como CF_HDROP.
// Mesmo cuidado de agent/input_windows.go (setClipboardText) de liberar
// hMem nos 2 branches de erro depois de GlobalAlloc ter tido sucesso
// (achado 🟠 do code-reviewer naquela feature, reaplicado aqui de
// propósito -- mesma classe de bug, mesmo fix).
func writeClipboardFile(filePath string) error {
	if filePath == "" {
		return fmt.Errorf("writeClipboardFile: caminho vazio")
	}

	utf16Path := utf16.Encode([]rune(filePath))
	utf16Path = append(utf16Path, 0, 0) // terminador DUPLO exigido pelo formato de lista do DROPFILES

	headerSize := unsafe.Sizeof(dropFiles{})
	byteSize := headerSize + uintptr(len(utf16Path))*2

	if err := openClipboardWithRetry(); err != nil {
		return err
	}
	defer procCloseClipboard.Call() //nolint:errcheck

	if ret, _, err := procEmptyClipboard.Call(); ret == 0 {
		return fmt.Errorf("EmptyClipboard falhou: %w", err)
	}

	hMem, _, err := procGlobalAlloc.Call(gmemMoveable, byteSize)
	if hMem == 0 {
		return fmt.Errorf("GlobalAlloc falhou: %w", err)
	}
	ptr, _, err := procGlobalLock.Call(hMem)
	if ptr == 0 {
		// hMem já foi alocado com sucesso e SetClipboardData nunca vai rodar
		// pra assumir a posse -- sem este GlobalFree, vaza (mesmo achado 🟠
		// de setClipboardText, agent/input_windows.go).
		procGlobalFree.Call(hMem) //nolint:errcheck
		return fmt.Errorf("GlobalLock falhou: %w", err)
	}

	hdr := (*dropFiles)(unsafe.Pointer(ptr))
	hdr.PFiles = uint32(headerSize)
	hdr.FWide = 1 // nomes de arquivo em UTF-16

	// Mesmo cuidado de govet/unsafeptr de setClipboardText -- ptr vem de
	// GlobalAlloc/GlobalLock (memória HGLOBAL do Windows, não gerenciada
	// pelo GC do Go), usado na mesma linha/bloco, sem guardar em struct.
	dst := unsafe.Slice((*uint16)(unsafe.Pointer(ptr+headerSize)), len(utf16Path)) //nolint:govet
	copy(dst, utf16Path)
	procGlobalUnlock.Call(hMem) //nolint:errcheck // best-effort: GlobalUnlock "falhar" aqui (handle já destravado) não muda o fluxo

	// SetClipboardData assume dono do hMem SE TER SUCESSO (contrato Win32)
	// -- em falha o chamador continua dono e tem que liberar, senão vaza.
	if ret, _, err := procSetClipboardData.Call(cfHDrop, hMem); ret == 0 {
		procGlobalFree.Call(hMem) //nolint:errcheck
		return fmt.Errorf("SetClipboardData falhou: %w", err)
	}
	return nil
}
