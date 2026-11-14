package main

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

// waitForWrite espera applyBrowseRemoteFolder (roda numa goroutine própria
// via safeGo) terminar de escrever a resposta -- mesmo motivo de
// applyListRemoteDir (filetransfer_windows.go): não pode bloquear a
// goroutine leitora de mouse/teclado, então o resultado chega
// assincronamente. Devolve o payload já lido via snapshot() (mutex) --
// achado 🟡 do code-reviewer: ler w.lastData cru DEPOIS deste loop ainda
// seria uma 2ª leitura desprotegida da mesma memória que a goroutine
// escreveu, mesmo com o polling já tendo visto writes>0.
func waitForWrite(t *testing.T, w *fakeFrameWriter) []byte {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if writes, data := w.snapshot(); writes > 0 {
			return data
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timeout esperando a resposta assíncrona de applyBrowseRemoteFolder")
	return nil
}

// TestApplyBrowseRemoteFolderSuccess: browseRemoteFolderFn mockado (a
// chamada real abre um dialog MODAL de verdade, travando o teste esperando
// um clique humano que nunca vem) devolve um caminho -- confirma que o
// JSON de resposta tem o tipo/path/requestId certos.
func TestApplyBrowseRemoteFolderSuccess(t *testing.T) {
	original := browseRemoteFolderFn
	defer func() { browseRemoteFolderFn = original }()
	browseRemoteFolderFn = func() (string, bool, error) {
		return `C:\Users\Loja\Documents`, false, nil
	}

	w := &fakeFrameWriter{}
	applyBrowseRemoteFolder(inputMessage{RequestID: 42}, "session-1", w)
	data := waitForWrite(t, w)

	var result remoteFolderPickResult
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("json inválido: %v", err)
	}
	if result.Type != "remote-folder-picked" || result.Path != `C:\Users\Loja\Documents` || result.RequestID != 42 {
		t.Fatalf("got %+v, want type=remote-folder-picked path=C:\\Users\\Loja\\Documents requestId=42", result)
	}
}

// TestApplyBrowseRemoteFolderCancelled: usuário fechou/cancelou o dialog
// (SHBrowseForFolderW devolve PIDL nulo) -- não é erro, tipo próprio
// "remote-folder-pick-cancelled" sem Message nenhuma.
func TestApplyBrowseRemoteFolderCancelled(t *testing.T) {
	original := browseRemoteFolderFn
	defer func() { browseRemoteFolderFn = original }()
	browseRemoteFolderFn = func() (string, bool, error) {
		return "", true, nil
	}

	w := &fakeFrameWriter{}
	applyBrowseRemoteFolder(inputMessage{RequestID: 7}, "session-1", w)
	data := waitForWrite(t, w)

	var result remoteFolderPickResult
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("json inválido: %v", err)
	}
	if result.Type != "remote-folder-pick-cancelled" || result.Path != "" || result.RequestID != 7 {
		t.Fatalf("got %+v, want type=remote-folder-pick-cancelled path=\"\" requestId=7", result)
	}
}

// TestApplyBrowseRemoteFolderError: falha real de Win32 (ex: COM não
// inicializou, SHGetPathFromIDListW recusou o PIDL) -- tipo
// "remote-folder-pick-error" com a mensagem, nunca confundido com
// cancelamento do usuário.
func TestApplyBrowseRemoteFolderError(t *testing.T) {
	original := browseRemoteFolderFn
	defer func() { browseRemoteFolderFn = original }()
	browseRemoteFolderFn = func() (string, bool, error) {
		return "", false, errors.New("SHBrowseForFolderW indisponível")
	}

	w := &fakeFrameWriter{}
	applyBrowseRemoteFolder(inputMessage{RequestID: 1}, "session-1", w)
	data := waitForWrite(t, w)

	var result remoteFolderPickResult
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("json inválido: %v", err)
	}
	if result.Type != "remote-folder-pick-error" || result.Message != "SHBrowseForFolderW indisponível" || result.RequestID != 1 {
		t.Fatalf("got %+v, want type=remote-folder-pick-error message=\"SHBrowseForFolderW indisponível\" requestId=1", result)
	}
}

// TestSendRemoteFolderPickResultNilWriter: w==nil (sessão já encerrou antes
// da resposta chegar) nunca deve entrar em pânico -- mesmo guard que
// sendRemoteDirListing/sendFileTransferStatus já têm.
func TestSendRemoteFolderPickResultNilWriter(t *testing.T) {
	sendRemoteFolderPickResult(nil, remoteFolderPickResult{Type: "remote-folder-picked", Path: `C:\x`})
}
