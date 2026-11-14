package main

import (
	"encoding/json"
	"errors"
	"sync/atomic"
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

// TestBrowseCallbackProcForcesForegroundOnInitialized: bug real achado AO
// VIVO (14/11/2026) -- sem forçar o dialog pra frente, ele nascia atrás de
// qualquer janela já em primeiro plano na tela remota (no caso real, um
// diálogo de login travado), invisível pro operador no vídeo da sessão.
func TestBrowseCallbackProcForcesForegroundOnInitialized(t *testing.T) {
	originalFg := setForegroundWindowFn
	originalPos := setWindowPosTopmostFn
	originalDone := browseDialogDone
	defer func() {
		setForegroundWindowFn = originalFg
		setWindowPosTopmostFn = originalPos
		browseDialogDone = originalDone
	}()
	// browseCallbackProc também dispara reassertTopmostFor numa goroutine
	// própria (safeGo) -- achado 🟠 do code-reviewer: zerar
	// browseTopmostReassertDuration (tentativa anterior) não garantia
	// NADA, porque a goroutine só lê essa var quando de fato executa, sem
	// ordem garantida com o defer deste teste restaurando os mocks logo
	// em seguida -- corrida real, podia vazar pro teste seguinte. Um
	// browseDialogDone JÁ FECHADO resolve de verdade: o `select` dentro
	// de reassertTopmostFor sempre acha o case `<-done` pronto na
	// PRIMEIRA iteração (ticker.C nunca dispara tão rápido), retorna
	// antes de qualquer chamada adicional a setWindowPosTopmostFn,
	// deterministicamente, sem depender de timing nenhum.
	closedDone := make(chan struct{})
	close(closedDone)
	browseDialogDone = closedDone

	var gotFgHwnd, gotPosHwnd uintptr
	fgCalled, posCalled := false, false
	setForegroundWindowFn = func(hwnd uintptr) { fgCalled = true; gotFgHwnd = hwnd }
	setWindowPosTopmostFn = func(hwnd uintptr) { posCalled = true; gotPosHwnd = hwnd }

	const fakeHwnd = 0x1234
	ret := browseCallbackProc(fakeHwnd, bffmInitialized, 0, 0)

	if !fgCalled || !posCalled {
		t.Fatalf("esperava os 2 chamados em BFFM_INITIALIZED: fgCalled=%v posCalled=%v", fgCalled, posCalled)
	}
	if gotFgHwnd != fakeHwnd || gotPosHwnd != fakeHwnd {
		t.Errorf("hwnd incorreto: fg=%#x pos=%#x, want %#x", gotFgHwnd, gotPosHwnd, uintptr(fakeHwnd))
	}
	if ret != 0 {
		t.Errorf("retorno = %d, want 0", ret)
	}
}

// TestBrowseCallbackProcIgnoresOtherMessages: qualquer mensagem que NÃO
// seja BFFM_INITIALIZED (ex: BFFM_SELCHANGED=2, disparada toda vez que o
// usuário clica numa pasta diferente dentro do dialog) não deve forçar
// foreground/topmost de novo -- só a montagem inicial precisa disso.
func TestBrowseCallbackProcIgnoresOtherMessages(t *testing.T) {
	originalFg := setForegroundWindowFn
	originalPos := setWindowPosTopmostFn
	defer func() { setForegroundWindowFn = originalFg; setWindowPosTopmostFn = originalPos }()

	called := false
	setForegroundWindowFn = func(hwnd uintptr) { called = true }
	setWindowPosTopmostFn = func(hwnd uintptr) { called = true }

	const bffmSelChanged = 2
	browseCallbackProc(0x1234, bffmSelChanged, 0, 0)

	if called {
		t.Error("esperava nenhuma chamada fora de BFFM_INITIALIZED")
	}
}

// TestReassertTopmostForCallsRepeatedlyUntilDuration: achado 🟡 do
// code-reviewer -- um único SetWindowPos na montagem perde a corrida se a
// janela já em primeiro plano (ex: um diálogo de lock que se
// auto-reafirma topmost de tempos em tempos) voltar a cobrir o dialog
// minutos depois. reassertTopmostFor precisa chamar de novo mais de uma
// vez, não só na borda de entrada.
func TestReassertTopmostForCallsRepeatedlyUntilDuration(t *testing.T) {
	originalDuration := browseTopmostReassertDuration
	originalInterval := browseTopmostReassertInterval
	originalPos := setWindowPosTopmostFn
	defer func() {
		browseTopmostReassertDuration = originalDuration
		browseTopmostReassertInterval = originalInterval
		setWindowPosTopmostFn = originalPos
	}()
	browseTopmostReassertDuration = 25 * time.Millisecond
	browseTopmostReassertInterval = 5 * time.Millisecond

	calls := 0
	var gotHwnd uintptr
	setWindowPosTopmostFn = func(hwnd uintptr) { calls++; gotHwnd = hwnd }

	const fakeHwnd = 0x1234
	reassertTopmostFor(fakeHwnd, nil) // done nil -- isola o limite de duration, sem interferência do canal

	if calls < 3 {
		t.Fatalf("calls = %d, want pelo menos 3 (duration/interval = 25ms/5ms)", calls)
	}
	if gotHwnd != fakeHwnd {
		t.Errorf("hwnd incorreto: %#x, want %#x", gotHwnd, uintptr(fakeHwnd))
	}
}

// TestReassertTopmostForZeroDurationReturnsImmediately: duration=0 não
// deve chamar setWindowPosTopmostFn nenhuma vez (limite de tempo, mesmo
// sem nenhum done fechado).
func TestReassertTopmostForZeroDurationReturnsImmediately(t *testing.T) {
	originalDuration := browseTopmostReassertDuration
	originalPos := setWindowPosTopmostFn
	defer func() {
		browseTopmostReassertDuration = originalDuration
		setWindowPosTopmostFn = originalPos
	}()
	browseTopmostReassertDuration = 0

	called := false
	setWindowPosTopmostFn = func(hwnd uintptr) { called = true }

	reassertTopmostFor(0x1234, nil)

	if called {
		t.Error("duration=0 não deveria chamar setWindowPosTopmostFn")
	}
}

// TestBrowseRemoteFolderRejectsConcurrentCall: achado 🟡 do code-reviewer
// -- nada impedia 2 chamadas concorrentes (2 cliques rápidos, ou mensagem
// duplicada/replay numa reconexão do WS -- o guard contra duplo-clique é
// só client-side). Simula "já tem um dialog em andamento" setando o guard
// antes de chamar, sem precisar abrir um dialog real de verdade (que
// travaria o teste esperando um clique humano que nunca vem).
func TestBrowseRemoteFolderRejectsConcurrentCall(t *testing.T) {
	original := atomic.LoadInt32(&browseRemoteFolderInProgress)
	defer atomic.StoreInt32(&browseRemoteFolderInProgress, original)
	atomic.StoreInt32(&browseRemoteFolderInProgress, 1) // simula outra chamada já em andamento

	_, cancelled, err := browseRemoteFolder()

	if err == nil {
		t.Fatal("esperava erro -- já tem um seletor de pasta em andamento")
	}
	if cancelled {
		t.Error("recusa por concorrência não é cancelamento do usuário -- tipos diferentes de resposta pro dashboard")
	}
	// A chamada recusada nunca chegou a ADQUIRIR o guard (CompareAndSwap
	// falhou), então o defer que libera ele nunca roda -- não pode soltar
	// o guard que pertence à OUTRA chamada "em andamento".
	if atomic.LoadInt32(&browseRemoteFolderInProgress) != 1 {
		t.Error("guard foi liberado por uma chamada que nunca o adquiriu")
	}
}
