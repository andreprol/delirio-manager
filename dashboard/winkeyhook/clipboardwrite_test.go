package main

import (
	"syscall"
	"testing"
	"unicode/utf16"
	"unsafe"
)

func TestWriteClipboardFileArg(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		wantPath string
		wantOk   bool
	}{
		{"flag com caminho", []string{"--write-clipboard-file", `C:\x\a.txt`}, `C:\x\a.txt`, true},
		{"flag no meio de outros args", []string{"--foo", "--write-clipboard-file", `D:\b.txt`}, `D:\b.txt`, true},
		{"sem a flag", []string{"--foo", "bar"}, "", false},
		{"flag sem valor seguinte (último arg)", []string{"--write-clipboard-file"}, "", false},
		{"sem argumento nenhum", nil, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path, ok := writeClipboardFileArg(c.args)
			if path != c.wantPath || ok != c.wantOk {
				t.Errorf("writeClipboardFileArg(%v) = (%q, %v), want (%q, %v)", c.args, path, ok, c.wantPath, c.wantOk)
			}
		})
	}
}

func TestWriteClipboardFileValidation(t *testing.T) {
	if err := writeClipboardFile(""); err == nil {
		t.Error("esperava erro pra caminho vazio")
	}
}

// TestWriteClipboardFileRoundTrip escreve de verdade no clipboard do host
// de teste e lê de volta via Win32 puro (réplica mínima de leitura, mesma
// lógica que agent/input_windows.go usa de verdade pro lado remoto --
// módulos Go separados, não dá pra importar um do outro) -- confirma que o
// CF_HDROP escrito é válido e contém exatamente o caminho esperado.
func TestWriteClipboardFileRoundTrip(t *testing.T) {
	wantPath := `C:\Users\Teste\arquivo-round-trip.txt`
	if err := writeClipboardFile(wantPath); err != nil {
		t.Fatalf("writeClipboardFile falhou: %v", err)
	}

	gotPath, err := testReadClipboardHDrop()
	if err != nil {
		t.Fatalf("falha ao ler de volta: %v", err)
	}
	if gotPath != wantPath {
		t.Errorf("path = %q, want %q", gotPath, wantPath)
	}
}

var (
	testShell32          = syscall.NewLazyDLL("shell32.dll")
	testProcGetClipData  = user32.NewProc("GetClipboardData")
	testProcDragQueryFileW = testShell32.NewProc("DragQueryFileW")
)

func testReadClipboardHDrop() (string, error) {
	if err := openClipboardWithRetry(); err != nil {
		return "", err
	}
	defer procCloseClipboard.Call() //nolint:errcheck

	hDrop, _, _ := testProcGetClipData.Call(cfHDrop)
	if hDrop == 0 {
		return "", nil
	}
	length, _, _ := testProcDragQueryFileW.Call(hDrop, 0, 0, 0)
	if length == 0 {
		return "", nil
	}
	buf := make([]uint16, length+1)
	testProcDragQueryFileW.Call(hDrop, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf))) //nolint:errcheck // já validamos length acima
	for i, c := range buf {
		if c == 0 {
			buf = buf[:i]
			break
		}
	}
	return string(utf16.Decode(buf)), nil
}
