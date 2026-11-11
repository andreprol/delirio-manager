package main

// Este arquivo mocka injectMouseMoveFn/injectMouseButtonFn (vars globais
// mutáveis, mesmo padrão de captureScreenJPEGFn/startLiveSessionFn em
// outros arquivos do pacote) — nenhum teste deste pacote usa t.Parallel()
// hoje; não adicionar enquanto mocks dessas vars existirem, ou corrompe
// outros testes silenciosamente.

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestParseInputMessage(t *testing.T) {
	data := []byte(`{"type":"mousemove","x":100,"y":200}`)
	msg, err := parseInputMessage(data)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if msg.Type != "mousemove" || msg.X != 100 || msg.Y != 200 {
		t.Errorf("msg = %+v", msg)
	}
}

func TestParseInputMessageInvalid(t *testing.T) {
	_, err := parseInputMessage([]byte("não é json"))
	if err == nil {
		t.Fatal("esperava erro pra JSON inválido")
	}
}

// TestHandleLiveSessionInputIgnoresNonNormalMode cobre a correção 1 (defesa
// em profundidade): mesmo recebendo uma mensagem de input válida, se o mode
// local da sessão não for "normal" (shadow, string vazia, ou qualquer outro
// valor inesperado), handleLiveSessionInput nunca deve chamar as funções de
// injeção. Mocka injectMouseMoveFn/injectMouseButtonFn (mesmo padrão de
// captureScreenJPEGFn/startLiveSessionFn já usado no projeto) pra observar
// esse side-effect sem tocar SendInput de verdade.
func TestHandleLiveSessionInputIgnoresNonNormalMode(t *testing.T) {
	originalMove := injectMouseMoveFn
	originalButton := injectMouseButtonFn
	defer func() {
		injectMouseMoveFn = originalMove
		injectMouseButtonFn = originalButton
	}()

	modes := []string{"shadow", "", "Normal", "normal "}
	for _, mode := range modes {
		t.Run(fmt.Sprintf("mode=%q", mode), func(t *testing.T) {
			moveCalled := false
			buttonCalled := false
			injectMouseMoveFn = func(x, y int32) error { moveCalled = true; return nil }
			injectMouseButtonFn = func(button string, down bool) error { buttonCalled = true; return nil }

			handleLiveSessionInput([]byte(`{"type":"mousemove","x":1,"y":2}`), mode, "s1", nil)
			handleLiveSessionInput([]byte(`{"type":"mousedown","button":"left"}`), mode, "s1", nil)

			if moveCalled {
				t.Errorf("mode=%q: injectMouseMoveFn não deveria ter sido chamada", mode)
			}
			if buttonCalled {
				t.Errorf("mode=%q: injectMouseButtonFn não deveria ter sido chamada", mode)
			}
		})
	}
}

// TestHandleLiveSessionInputNormalModeInjects garante que o caminho feliz
// (mode="normal") de fato dispara a injeção correspondente ao tipo da
// mensagem — complementa o teste acima, que só prova o bloqueio.
func TestHandleLiveSessionInputNormalModeInjects(t *testing.T) {
	originalMove := injectMouseMoveFn
	originalButton := injectMouseButtonFn
	defer func() {
		injectMouseMoveFn = originalMove
		injectMouseButtonFn = originalButton
	}()

	t.Run("mousemove", func(t *testing.T) {
		var gotX, gotY int32
		called := false
		injectMouseMoveFn = func(x, y int32) error { called = true; gotX, gotY = x, y; return nil }
		injectMouseButtonFn = func(button string, down bool) error {
			t.Fatal("não deveria chamar injectMouseButtonFn pra mousemove")
			return nil
		}

		handleLiveSessionInput([]byte(`{"type":"mousemove","x":10,"y":20}`), liveSessionNormalMode, "s1", nil)

		if !called {
			t.Fatal("esperava injectMouseMoveFn chamada em mode normal")
		}
		if gotX != 10 || gotY != 20 {
			t.Errorf("injectMouseMoveFn recebeu x=%d y=%d, want x=10 y=20", gotX, gotY)
		}
	})

	t.Run("mousedown e mouseup", func(t *testing.T) {
		var gotButton string
		var gotDown bool
		callCount := 0
		injectMouseMoveFn = func(x, y int32) error {
			t.Fatal("não deveria chamar injectMouseMoveFn pra mousedown/mouseup")
			return nil
		}
		injectMouseButtonFn = func(button string, down bool) error {
			callCount++
			gotButton, gotDown = button, down
			return nil
		}

		handleLiveSessionInput([]byte(`{"type":"mousedown","button":"left"}`), liveSessionNormalMode, "s1", nil)
		if gotButton != "left" || !gotDown {
			t.Errorf("mousedown: button=%q down=%v, want left/true", gotButton, gotDown)
		}

		handleLiveSessionInput([]byte(`{"type":"mouseup","button":"right"}`), liveSessionNormalMode, "s1", nil)
		if gotButton != "right" || gotDown {
			t.Errorf("mouseup: button=%q down=%v, want right/false", gotButton, gotDown)
		}

		if callCount != 2 {
			t.Errorf("injectMouseButtonFn chamada %d vez(es), want 2", callCount)
		}
	})

	t.Run("JSON inválido não chama nenhuma injeção", func(t *testing.T) {
		injectMouseMoveFn = func(x, y int32) error {
			t.Fatal("não deveria chamar injectMouseMoveFn pra JSON inválido")
			return nil
		}
		injectMouseButtonFn = func(button string, down bool) error {
			t.Fatal("não deveria chamar injectMouseButtonFn pra JSON inválido")
			return nil
		}
		handleLiveSessionInput([]byte("não é json"), liveSessionNormalMode, "s1", nil)
	})
}

// TestHandleLiveSessionInputKeyboard cobre o dispatch de keydown/keyup —
// mesmo padrão de TestHandleLiveSessionInputNormalModeInjects pra mouse,
// mas pro caminho de teclado que faltava (companion ignorava com
// "tipo de input não suportado ainda" até esta correção).
func TestHandleLiveSessionInputKeyboard(t *testing.T) {
	original := injectKeyboardFn
	defer func() { injectKeyboardFn = original }()

	t.Run("keydown chama injectKeyboardFn(keyCode, true)", func(t *testing.T) {
		var gotCode uint16
		var gotDown bool
		called := false
		injectKeyboardFn = func(keyCode uint16, down bool) error {
			called, gotCode, gotDown = true, keyCode, down
			return nil
		}
		handleLiveSessionInput([]byte(`{"type":"keydown","keyCode":65}`), liveSessionNormalMode, "s1", nil)
		if !called || gotCode != 65 || !gotDown {
			t.Errorf("called=%v keyCode=%d down=%v, want true/65/true", called, gotCode, gotDown)
		}
	})

	t.Run("keyup chama injectKeyboardFn(keyCode, false)", func(t *testing.T) {
		var gotDown bool
		called := false
		injectKeyboardFn = func(keyCode uint16, down bool) error {
			called, gotDown = true, down
			return nil
		}
		handleLiveSessionInput([]byte(`{"type":"keyup","keyCode":65}`), liveSessionNormalMode, "s1", nil)
		if !called || gotDown {
			t.Errorf("called=%v down=%v, want true/false", called, gotDown)
		}
	})

	t.Run("mode shadow não injeta teclado", func(t *testing.T) {
		called := false
		injectKeyboardFn = func(keyCode uint16, down bool) error { called = true; return nil }
		handleLiveSessionInput([]byte(`{"type":"keydown","keyCode":65}`), "shadow", "s1", nil)
		if called {
			t.Error("injectKeyboardFn não deveria ter sido chamada em mode shadow")
		}
	})
}

// TestDispatchLiveSessionInputFileTransfer cobre o novo case
// "file-transfer" do dispatch: delega pra applyFileTransferFn (indireção
// mockável, mesmo padrão de injectMouseMoveFn etc.) repassando msg,
// sessionID e w sem alteração.
func TestDispatchLiveSessionInputFileTransfer(t *testing.T) {
	original := applyFileTransferFn
	defer func() { applyFileTransferFn = original }()

	var gotMsg inputMessage
	var gotSession string
	called := false
	applyFileTransferFn = func(msg inputMessage, sessionID string, w frameWriter) {
		called = true
		gotMsg = msg
		gotSession = sessionID
	}

	msg := inputMessage{Type: "file-transfer", DownloadURL: "https://x/y?sas", FileName: "a.txt", DestDir: `C:\Users\Loja\Desktop`}
	dispatchLiveSessionInput(msg, "session-1", nil)

	if !called {
		t.Fatal("esperava applyFileTransferFn chamado")
	}
	if gotMsg.FileName != "a.txt" || gotSession != "session-1" {
		t.Errorf("msg/sessionID incorretos: %+v / %s", gotMsg, gotSession)
	}
}

// TestInjectKeyboardInvalidKeyCode cobre o fail-safe de keyCode=0 (campo
// omitido/ausente na mensagem JSON, já que KeyCode usa omitempty) — evita
// mandar SendInput com VK inválido.
func TestInjectKeyboardInvalidKeyCode(t *testing.T) {
	if err := injectKeyboard(0, true); err == nil {
		t.Error("esperava erro pra keyCode 0")
	}
}

// TestInputKeybdSizeMatchesInput garante que inputKeybd (usado pra eventos
// de teclado) tem o MESMO tamanho total de input (usado pra mouse) — os
// dois espelham a união INPUT do Win32, cujo tamanho é o do maior membro
// (MOUSEINPUT); SendInput exige esse cbSize mesmo pra um evento KEYBDINPUT,
// que sozinho ocupa menos bytes. Perder o padding de inputKeybd faria
// SendInput falhar silenciosamente em runtime (ERROR_INVALID_PARAMETER),
// nunca detectado em CI (SendInput não é chamado nos outros testes).
func TestInputKeybdSizeMatchesInput(t *testing.T) {
	wantSize := unsafe.Sizeof(input{})
	gotSize := unsafe.Sizeof(inputKeybd{})
	if gotSize != wantSize {
		t.Errorf("unsafe.Sizeof(inputKeybd{}) = %d, want %d (igual a input{})", gotSize, wantSize)
	}
}

// TestClampInt32 cobre o fix de overflow: sem clamp, x=100000 com
// screenW=1920 faria x*65536/screenW overflowar int32 e virar negativo
// (normX=-1060590 em vez de ~65501) — confirmado isolado antes deste
// teste existir. clampInt32 evita isso limitando x/y aos bounds da tela
// ANTES da conta de normalização.
func TestClampInt32(t *testing.T) {
	cases := []struct {
		name            string
		v, lo, hi, want int32
	}{
		{"dentro do range", 500, 0, 1919, 500},
		{"abaixo do mínimo", -10, 0, 1919, 0},
		{"acima do máximo (causaria overflow sem clamp)", 100000, 0, 1919, 1919},
	}
	for _, c := range cases {
		if got := clampInt32(c.v, c.lo, c.hi); got != c.want {
			t.Errorf("%s: clampInt32(%d, %d, %d) = %d, want %d", c.name, c.v, c.lo, c.hi, got, c.want)
		}
	}
}

// TestInjectMouseButtonUnknownButton cobre o único branch de
// injectMouseMove/injectMouseButton testável em CI sem desktop real: o
// default (botão desconhecido) retorna erro ANTES de montar o struct
// input ou chamar sendInputStruct/SendInput — fail-safe, nenhum efeito
// colateral com entrada inválida.
func TestInjectMouseButtonUnknownButton(t *testing.T) {
	if err := injectMouseButton("middle", true); err == nil {
		t.Error("esperava erro pra botão desconhecido \"middle\"")
	}
	if err := injectMouseButton("", false); err == nil {
		t.Error("esperava erro pra botão vazio")
	}
}

// TestHandleLiveSessionInputClipboardPaste cobre o dispatch de
// clipboard-paste — mesmo padrão de TestHandleLiveSessionInputKeyboard.
func TestHandleLiveSessionInputClipboardPaste(t *testing.T) {
	original := injectClipboardPasteFn
	defer func() { injectClipboardPasteFn = original }()

	t.Run("mode normal: chama injectClipboardPasteFn com o texto", func(t *testing.T) {
		var gotText string
		called := false
		injectClipboardPasteFn = func(text string) error { called, gotText = true, text; return nil }

		handleLiveSessionInput([]byte(`{"type":"clipboard-paste","text":"shutdown /s /t 300"}`), liveSessionNormalMode, "s1", nil)

		if !called || gotText != "shutdown /s /t 300" {
			t.Errorf("called=%v text=%q, want true/\"shutdown /s /t 300\"", called, gotText)
		}
	})

	t.Run("mode shadow: não chama injectClipboardPasteFn", func(t *testing.T) {
		called := false
		injectClipboardPasteFn = func(text string) error { called = true; return nil }

		handleLiveSessionInput([]byte(`{"type":"clipboard-paste","text":"x"}`), "shadow", "s1", nil)

		if called {
			t.Error("injectClipboardPasteFn não deveria ter sido chamada em mode shadow")
		}
	})
}

// TestInjectClipboardPasteValidation cobre os fail-safes de
// injectClipboardPaste que não chamam syscall nenhuma (texto vazio ou longo
// demais) — testável em CI sem desktop interativo real, mesmo padrão de
// TestInjectKeyboardInvalidKeyCode/TestInjectMouseButtonUnknownButton.
func TestInjectClipboardPasteValidation(t *testing.T) {
	if err := injectClipboardPaste(""); err == nil {
		t.Error("esperava erro pra texto vazio")
	}
	tooLong := make([]byte, clipboardPasteMaxChars+1)
	for i := range tooLong {
		tooLong[i] = 'a'
	}
	if err := injectClipboardPaste(string(tooLong)); err == nil {
		t.Error("esperava erro pra texto maior que clipboardPasteMaxChars")
	}
}

// resetLocalInputLockState limpa localInputLockedBy/localInputLockTimer
// entre testes — os testes de lock manipulam esse estado global direto
// (mesmo padrão de TestIsLiveSessionActive em livesession_windows_test.go),
// sem t.Parallel() (ver comentário no topo do arquivo).
func resetLocalInputLockState(t *testing.T) {
	t.Helper()
	localInputLockMu.Lock()
	stopLocalInputLockTimerLocked()
	localInputLockedBy = ""
	localInputLockMu.Unlock()
}

// TestHandleLiveSessionInputLockLocalInput cobre o dispatch de
// lock-local-input/unlock-local-input em handleLiveSessionInput: só chama
// setLocalInputLockedFn em mode normal (mesma defesa em profundidade dos
// outros tipos de mensagem), com o bool certo e o sessionID certo.
func TestHandleLiveSessionInputLockLocalInput(t *testing.T) {
	resetLocalInputLockState(t)
	original := setLocalInputLockedFn
	defer func() { setLocalInputLockedFn = original; resetLocalInputLockState(t) }()

	t.Run("mode normal: lock chama setLocalInputLockedFn(sessionID, true)", func(t *testing.T) {
		var gotSessionID string
		var gotLocked bool
		called := false
		setLocalInputLockedFn = func(sessionID string, locked bool) error {
			called, gotSessionID, gotLocked = true, sessionID, locked
			return nil
		}
		handleLiveSessionInput([]byte(`{"type":"lock-local-input"}`), liveSessionNormalMode, "s-abc", nil)
		if !called || gotSessionID != "s-abc" || !gotLocked {
			t.Errorf("called=%v sessionID=%q locked=%v, want true/s-abc/true", called, gotSessionID, gotLocked)
		}
	})

	t.Run("mode normal: unlock chama setLocalInputLockedFn(sessionID, false)", func(t *testing.T) {
		var gotLocked bool
		called := false
		setLocalInputLockedFn = func(sessionID string, locked bool) error {
			called, gotLocked = true, locked
			return nil
		}
		handleLiveSessionInput([]byte(`{"type":"unlock-local-input"}`), liveSessionNormalMode, "s-abc", nil)
		if !called || gotLocked {
			t.Errorf("called=%v locked=%v, want true/false", called, gotLocked)
		}
	})

	t.Run("mode shadow: nem lock nem unlock chamam setLocalInputLockedFn", func(t *testing.T) {
		called := false
		setLocalInputLockedFn = func(sessionID string, locked bool) error { called = true; return nil }
		handleLiveSessionInput([]byte(`{"type":"lock-local-input"}`), "shadow", "s-abc", nil)
		handleLiveSessionInput([]byte(`{"type":"unlock-local-input"}`), "shadow", "s-abc", nil)
		if called {
			t.Error("setLocalInputLockedFn não deveria ter sido chamada em mode shadow")
		}
	})
}

// TestSetLocalInputLocked cobre a regra central: unlock só tem efeito se
// vier da MESMA sessão que travou — essencial pra uma sessão nova (depois
// de stop+start rápidos, por exemplo) não conseguir liberar o lock de uma
// sessão anterior que, por algum bug, ainda não tenha limpo o seu.
func TestSetLocalInputLocked(t *testing.T) {
	resetLocalInputLockState(t)
	original := blockInputFn
	defer func() { blockInputFn = original; resetLocalInputLockState(t) }()

	var calls []bool
	blockInputFn = func(block bool) error { calls = append(calls, block); return nil }

	if err := setLocalInputLocked("a", true); err != nil {
		t.Fatalf("lock inesperadamente falhou: %v", err)
	}
	if localInputLockedBy != "a" {
		t.Fatalf("localInputLockedBy = %q, want a", localInputLockedBy)
	}

	// Lock duplicado da mesma sessão: no-op, não chama BlockInput de novo.
	if err := setLocalInputLocked("a", true); err != nil {
		t.Fatalf("lock duplicado não deveria falhar: %v", err)
	}
	if len(calls) != 1 {
		t.Errorf("blockInputFn chamada %d vez(es) após lock duplicado, want 1", len(calls))
	}

	// Sessão B pedindo unlock não libera o lock da sessão A.
	if err := setLocalInputLocked("b", false); err != nil {
		t.Fatalf("unlock de sessão não-dona não deveria retornar erro: %v", err)
	}
	if localInputLockedBy != "a" {
		t.Errorf("localInputLockedBy = %q após unlock de sessão não-dona, want ainda a", localInputLockedBy)
	}
	if len(calls) != 1 {
		t.Errorf("blockInputFn chamada %d vez(es) após unlock de sessão não-dona, want ainda 1", len(calls))
	}

	// Sessão B pedindo LOCK (não unlock) enquanto A ainda é dona: transfere
	// a posse pra B (não recusa) — ver comentário de setLocalInputLocked
	// sobre por que recusar seria pior (B nunca conseguiria destravar).
	if err := setLocalInputLocked("b", true); err != nil {
		t.Fatalf("lock por sessão B enquanto A é dona não deveria falhar: %v", err)
	}
	if localInputLockedBy != "b" {
		t.Errorf("localInputLockedBy = %q após B pedir lock, want b (posse transferida)", localInputLockedBy)
	}
	if len(calls) != 2 {
		t.Errorf("blockInputFn chamada %d vez(es) após transferência B, want 2 (true de A + true de B)", len(calls))
	}

	// Agora B é quem consegue destravar (é a dona de verdade).
	if err := setLocalInputLocked("b", false); err != nil {
		t.Fatalf("unlock pela sessão B (agora dona) falhou: %v", err)
	}
	if localInputLockedBy != "" {
		t.Errorf("localInputLockedBy = %q após B destravar, want vazio", localInputLockedBy)
	}

	// Reconstrói o estado pro resto do teste (lock por A de novo).
	calls = nil
	if err := setLocalInputLocked("a", true); err != nil {
		t.Fatalf("setup: lock por a falhou: %v", err)
	}

	// A sessão dona libera normalmente.
	if err := setLocalInputLocked("a", false); err != nil {
		t.Fatalf("unlock pela sessão dona falhou: %v", err)
	}
	if localInputLockedBy != "" {
		t.Errorf("localInputLockedBy = %q após unlock pela dona, want vazio", localInputLockedBy)
	}
	if len(calls) != 2 || calls[0] != true || calls[1] != false {
		t.Errorf("blockInputFn chamadas = %v, want [true false]", calls)
	}
}

// TestSetLocalInputLockedBlockInputFails cobre a dependência externa real
// desta FSM: a syscall BlockInput falhando (ex: ERROR_ACCESS_DENIED sem
// desktop interativo — cenário real já visto neste projeto, serviço vs.
// companion). Falha ao LOCK não deve registrar posse nenhuma (estado fica
// como se nada tivesse acontecido); falha ao UNLOCK deve manter o estado
// como ainda travado (não finge que destravou se a chamada real falhou) —
// comportamento DIFERENTE de releaseLocalInputLockForSession de propósito
// (essa sempre limpa o estado mesmo em erro, ver seu teste e comentário).
func TestSetLocalInputLockedBlockInputFails(t *testing.T) {
	resetLocalInputLockState(t)
	original := blockInputFn
	defer func() { blockInputFn = original; resetLocalInputLockState(t) }()

	wantErr := fmt.Errorf("BlockInput falhou: ERROR_ACCESS_DENIED")
	blockInputFn = func(block bool) error { return wantErr }

	if err := setLocalInputLocked("a", true); err == nil {
		t.Fatal("esperava erro quando blockInputFn falha no lock")
	}
	if localInputLockedBy != "" {
		t.Errorf("localInputLockedBy = %q após lock falhar, want vazio (nenhuma posse registrada)", localInputLockedBy)
	}

	// Trava de verdade (blockInputFn volta a funcionar) pra testar a falha
	// no UNLOCK isoladamente.
	blockInputFn = func(block bool) error { return nil }
	if err := setLocalInputLocked("a", true); err != nil {
		t.Fatalf("setup: lock falhou: %v", err)
	}

	blockInputFn = func(block bool) error { return wantErr }
	if err := setLocalInputLocked("a", false); err == nil {
		t.Fatal("esperava erro quando blockInputFn falha no unlock")
	}
	if localInputLockedBy != "a" {
		t.Errorf("localInputLockedBy = %q após unlock falhar, want ainda a (não fingir que destravou)", localInputLockedBy)
	}
}

// TestSetLocalInputLockedNoResponseIsPessimistic cobre o 2º achado 🟠 da 2ª
// rodada de code-review: um erro errBlockInputNoResponse (pedido ENTREGUE ao
// worker, mas sem resposta a tempo) NÃO prova que a syscall BlockInput
// falhou — só que o worker não respondeu a tempo (ver blockInputSyscall).
// Diferente de TestSetLocalInputLockedBlockInputFails (erro síncrono real,
// onde não registrar posse está correto), aqui o lock precisa registrar
// posse + armar o failsafe mesmo retornando erro pro chamador — senão um
// BlockInput(true) que teve sucesso tardio (só lento) deixaria o input
// travado no Windows sem dono nem rede de segurança, o mesmo sintoma do
// incidente ASSBOH por outra via. Espelha a mesma lógica pro unlock: esse
// erro aí deve limpar o estado (como releaseLocalInputLockForSession já faz
// incondicionalmente), não exigir um 2º unlock que pode nunca vir.
func TestSetLocalInputLockedNoResponseIsPessimistic(t *testing.T) {
	resetLocalInputLockState(t)
	original := blockInputFn
	defer func() { blockInputFn = original; resetLocalInputLockState(t) }()

	noResponseErr := fmt.Errorf("blockInputSyscall: %w em 5s", errBlockInputNoResponse)

	blockInputFn = func(block bool) error { return noResponseErr }
	if err := setLocalInputLocked("a", true); err == nil {
		t.Fatal("esperava erro (sem resposta) propagado pro chamador")
	}
	if localInputLockedBy != "a" {
		t.Errorf("localInputLockedBy = %q após errBlockInputNoResponse no lock, want a (pessimista: registra posse mesmo com erro)", localInputLockedBy)
	}
	if localInputLockTimer == nil {
		t.Error("failsafe não armado após errBlockInputNoResponse no lock — input ficaria travado sem rede de segurança se o BlockInput(true) real tiver tido sucesso tardio")
	}

	if err := setLocalInputLocked("a", false); err == nil {
		t.Fatal("esperava erro (sem resposta) propagado pro chamador no unlock")
	}
	if localInputLockedBy != "" {
		t.Errorf("localInputLockedBy = %q após errBlockInputNoResponse no unlock, want vazio (pessimista: trata como destravado mesmo com erro)", localInputLockedBy)
	}
	if localInputLockTimer != nil {
		t.Error("failsafe ainda armado após errBlockInputNoResponse no unlock, want parado")
	}
}

// TestSetLocalInputLockedNotSentIsNotPessimistic cobre o 🔴 CRÍTICO da 3ª
// rodada de code-review: errBlockInputNotSent (pedido NUNCA chegou a ser
// entregue ao worker — nada foi disparado em nome desta chamada) é
// diferente de errBlockInputNoResponse e NÃO deve receber o tratamento
// pessimista — não há syscall em voo nenhuma que possa "ter sucesso tardio"
// pra esta chamada especificamente. Sem esta distinção, uma chamada que
// nunca chegou a sair do canal (ex.: unlock do failsafe disparado enquanto
// o worker ainda processa um lock anterior lento) poderia limpar/desarmar
// o estado pessimista que protege essa OUTRA chamada ainda em voo — ver
// TestBlockInputConcurrentCallsDontCorruptStateWhenWorkerBusy pro cenário
// de concorrência real que expôs isto.
func TestSetLocalInputLockedNotSentIsNotPessimistic(t *testing.T) {
	resetLocalInputLockState(t)
	original := blockInputFn
	defer func() { blockInputFn = original; resetLocalInputLockState(t) }()

	notSentErr := fmt.Errorf("blockInputSyscall: %w em 5s (worker ocupado)", errBlockInputNotSent)
	blockInputFn = func(block bool) error { return notSentErr }

	if err := setLocalInputLocked("a", true); err == nil {
		t.Fatal("esperava erro propagado")
	}
	if localInputLockedBy != "" {
		t.Errorf("localInputLockedBy = %q após errBlockInputNotSent no lock, want vazio (nada foi disparado de verdade, não é pessimista)", localInputLockedBy)
	}
	if localInputLockTimer != nil {
		t.Error("failsafe não deveria estar armado após errBlockInputNotSent no lock")
	}
}

// TestSetLocalInputLockedGenericErrorIsNotPessimistic confirma que a
// distinção acima é mesmo por tipo de erro (errors.Is errBlockInputNoResponse),
// não por "qualquer erro": um erro comum, com texto parecido mas sem o wrap
// de nenhum dos dois sentinels, continua seguindo a regra antiga (não
// registra posse no lock, não limpa no unlock) — TestSetLocalInputLockedBlockInputFails
// já cobre isso com um erro genérico; este teste fecha a lacuna específica
// de "erro com texto parecido mas sem sentinel nenhum" não ser confundido
// com nenhum dos dois casos de timeout.
func TestSetLocalInputLockedGenericErrorIsNotPessimistic(t *testing.T) {
	resetLocalInputLockState(t)
	original := blockInputFn
	defer func() { blockInputFn = original; resetLocalInputLockState(t) }()

	lookalike := fmt.Errorf("blockInputSyscall: worker recebeu o pedido mas não respondeu em 5s (sem sentinel nenhum)")
	blockInputFn = func(block bool) error { return lookalike }

	if err := setLocalInputLocked("a", true); err == nil {
		t.Fatal("esperava erro propagado")
	}
	if localInputLockedBy != "" {
		t.Errorf("localInputLockedBy = %q, want vazio (erro sem sentinel não deve ser tratado como pessimista)", localInputLockedBy)
	}
}

// TestReleaseLocalInputLockForSession cobre a função usada pelo defer de
// runLiveSessionLoop e pelo timer de failsafe — só libera se a sessão
// ainda for a dona do lock; nunca propaga erro.
func TestReleaseLocalInputLockForSession(t *testing.T) {
	resetLocalInputLockState(t)
	original := blockInputFn
	defer func() { blockInputFn = original; resetLocalInputLockState(t) }()

	calls := 0
	blockInputFn = func(block bool) error { calls++; return nil }

	// Sem lock nenhum: no-op.
	releaseLocalInputLockForSession("a")
	if calls != 0 {
		t.Errorf("blockInputFn chamada %d vez(es) sem lock ativo, want 0", calls)
	}

	if err := setLocalInputLocked("a", true); err != nil {
		t.Fatalf("setup: lock falhou: %v", err)
	}
	calls = 0

	// Sessão B não é dona: no-op, lock de A continua.
	releaseLocalInputLockForSession("b")
	if calls != 0 {
		t.Errorf("blockInputFn chamada %d vez(es) por sessão não-dona, want 0", calls)
	}
	if localInputLockedBy != "a" {
		t.Errorf("localInputLockedBy = %q, want ainda a", localInputLockedBy)
	}

	// Sessão A é dona: libera de verdade.
	releaseLocalInputLockForSession("a")
	if calls != 1 {
		t.Errorf("blockInputFn chamada %d vez(es) pela sessão dona, want 1", calls)
	}
	if localInputLockedBy != "" {
		t.Errorf("localInputLockedBy = %q após release pela dona, want vazio", localInputLockedBy)
	}
}

// TestReleaseLocalInputLockForSessionBlockInputFails confirma a assimetria
// deliberada com setLocalInputLocked: aqui (caminho de limpeza automática —
// fim de sessão, failsafe) o estado é limpo mesmo se a syscall falhar, só
// loga. Insistir no estado "ainda travado" não ajudaria — ninguém vai
// chamar isto de novo pra esta sessão (ela já terminou). EXCETO
// errBlockInputNotSent, onde insistir ajuda sim — ver
// TestReleaseLocalInputLockForSessionNotSentRearmsFailsafe logo abaixo.
func TestReleaseLocalInputLockForSessionBlockInputFails(t *testing.T) {
	resetLocalInputLockState(t)
	originalFn := blockInputFn
	defer func() { blockInputFn = originalFn; resetLocalInputLockState(t) }()

	blockInputFn = func(block bool) error { return nil }
	if err := setLocalInputLocked("a", true); err != nil {
		t.Fatalf("setup: lock falhou: %v", err)
	}

	blockInputFn = func(block bool) error { return fmt.Errorf("BlockInput falhou de verdade") }
	releaseLocalInputLockForSession("a")

	if localInputLockedBy != "" {
		t.Errorf("localInputLockedBy = %q após release com blockInputFn falhando, want vazio (limpa mesmo em erro)", localInputLockedBy)
	}
}

// TestReleaseLocalInputLockForSessionNotSentRearmsFailsafe cobre o achado 🟠
// do code-reviewer, 4ª rodada: releaseLocalInputLockForSession (chamada pelo
// failsafe e pelo fim de sessão) tratava QUALQUER erro de blockInputFn,
// inclusive errBlockInputNotSent, como "destravou com sucesso" — limpando
// localInputLockedBy e parando o failsafe incondicionalmente. Mas
// errBlockInputNotSent significa que nada foi disparado pra esta chamada
// (worker ocupado com outro pedido) — o BlockInput físico provavelmente
// CONTINUA travado de verdade, nunca tentamos destravar. Diferente de
// TestReleaseLocalInputLockForSessionBlockInputFails (erro síncrono real ou
// errBlockInputNoResponse, onde limpar é a política certa): aqui limpar
// fingiria que destravou e tiraria a única rede de segurança que resta —
// o fix rearma o failsafe em vez de limpar, pra tentar de novo mais tarde.
func TestReleaseLocalInputLockForSessionNotSentRearmsFailsafe(t *testing.T) {
	resetLocalInputLockState(t)
	originalFn := blockInputFn
	defer func() { blockInputFn = originalFn; resetLocalInputLockState(t) }()

	blockInputFn = func(block bool) error { return nil }
	if err := setLocalInputLocked("a", true); err != nil {
		t.Fatalf("setup: lock falhou: %v", err)
	}

	notSentErr := fmt.Errorf("blockInputSyscall: %w em 5s (worker ocupado)", errBlockInputNotSent)
	blockInputFn = func(block bool) error { return notSentErr }
	releaseLocalInputLockForSession("a")

	if localInputLockedBy != "a" {
		t.Errorf("localInputLockedBy = %q após release com errBlockInputNotSent, want ainda a (BlockInput físico provavelmente ainda travado, não fingir que destravou)", localInputLockedBy)
	}
	if localInputLockTimer == nil {
		t.Error("failsafe não rearmado após errBlockInputNotSent — sem isso, nunca mais tenta destravar de novo")
	}
}

// TestLocalInputLockFailsafeAutoReleases cobre a 2ª camada de defesa: se
// ninguém mandar unlock-local-input (ex: dashboard do operador caiu sem
// avisar e o aviso automático do servidor também não chegou), o lock se
// libera sozinho depois de localInputLockFailsafe. Encurta o teto pra não
// deixar o teste lento — var, não const, existe só pra isto.
func TestLocalInputLockFailsafeAutoReleases(t *testing.T) {
	resetLocalInputLockState(t)
	originalFailsafe := localInputLockFailsafe
	originalFn := blockInputFn
	defer func() {
		localInputLockFailsafe = originalFailsafe
		blockInputFn = originalFn
		resetLocalInputLockState(t)
	}()

	localInputLockFailsafe = 20 * time.Millisecond
	var calls []bool
	blockInputFn = func(block bool) error { calls = append(calls, block); return nil }

	if err := setLocalInputLocked("s-failsafe", true); err != nil {
		t.Fatalf("lock inesperadamente falhou: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		localInputLockMu.Lock()
		owner := localInputLockedBy
		localInputLockMu.Unlock()
		if owner == "" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	localInputLockMu.Lock()
	owner := localInputLockedBy
	localInputLockMu.Unlock()
	if owner != "" {
		t.Fatalf("esperava lock liberado pelo failsafe, ainda travado por %q", owner)
	}
	if len(calls) != 2 || calls[0] != true || calls[1] != false {
		t.Errorf("blockInputFn chamadas = %v, want [true false]", calls)
	}
}

// TestBlockInputWorkerSameOSThread prova a correção real do incidente da
// ASSBOH em 11/11/2026 (companion.log: 3 tentativas seguidas de
// "BlockInput(false) falhou: operação concluída com êxito", input local
// travado até reinício manual do serviço). A causa era BlockInput(true) e
// BlockInput(false) rodando em OS threads diferentes — API Win32 amarra o
// bloqueio à thread chamadora, não ao processo. Aqui, substituímos só o
// passo final (blockInputSyscallDirectFn) por uma função que registra
// windows.GetCurrentThreadId(), sem tocar a syscall real — e exercitamos o
// worker/canal de verdade (blockInputSyscall, startBlockInputWorker),
// provando que toda chamada cai sempre na mesma OS thread.
//
// Achado 🟡 do code-reviewer: com poucas chamadas e pouca contenção, o
// scheduler do Go pode por coincidência manter a goroutine do worker na
// mesma OS thread mesmo SEM runtime.LockOSThread() — o teste passaria "por
// sorte" mesmo que uma edição futura removesse a trava de thread por
// engano. Mitigado aqui com: (1) GOMAXPROCS forçado pra pelo menos 4 (dá ao
// scheduler Ms de sobra pra migrar a goroutine, se nada a impedir), (2)
// muitas goroutines concorrentes de verdade ocupando essas Ms com trabalho
// de CPU durante o teste (pressão real de agendamento, não só 2 chamadas
// sequenciais), (3) muitas idas e vindas lock/unlock, cada uma disparada de
// uma goroutine nova (igual ao cenário real: dispatch de mensagem e timer
// de failsafe são goroutines diferentes a cada vez).
func TestBlockInputWorkerSameOSThread(t *testing.T) {
	originalDirect := blockInputSyscallDirectFn
	defer func() { blockInputSyscallDirectFn = originalDirect }()

	originalGOMAXPROCS := runtime.GOMAXPROCS(0)
	if originalGOMAXPROCS < 4 {
		runtime.GOMAXPROCS(4)
	}
	defer runtime.GOMAXPROCS(originalGOMAXPROCS)

	type call struct {
		block    bool
		threadID uint32
	}
	const rounds = 30
	callsCh := make(chan call, rounds*2)
	blockInputSyscallDirectFn = func(block bool) error {
		callsCh <- call{block: block, threadID: windows.GetCurrentThreadId()}
		return nil
	}

	startBlockInputWorker()

	// Pressão real de agendamento: várias goroutines CPU-bound concorrentes,
	// rodando enquanto os lock/unlock acontecem, pra incentivar o scheduler a
	// espalhar goroutines entre Ms — sem isto, numa máquina ociosa o
	// scheduler pode não ter motivo nenhum pra migrar a goroutine do worker,
	// mesmo sem LockOSThread.
	stopBusy := make(chan struct{})
	var busyWG sync.WaitGroup
	for i := 0; i < runtime.GOMAXPROCS(0)*2; i++ {
		busyWG.Add(1)
		go func() {
			defer busyWG.Done()
			x := 0
			for {
				select {
				case <-stopBusy:
					return
				default:
					x++ // trabalho de CPU puro, sem syscalls/bloqueio
				}
			}
		}()
	}

	// Cada lock e cada unlock sai de uma goroutine NOVA — mesmo cenário do
	// bug real (dispatch de mensagem vs. timer de failsafe, nunca a mesma
	// goroutine do caller anterior) — mas um round de cada vez (espera a
	// goroutine terminar antes de abrir a próxima), senão true/false de
	// rounds diferentes se embaralham sem ordem definida no canal.
	for i := 0; i < rounds; i++ {
		lockDone := make(chan struct{})
		go func() {
			defer close(lockDone)
			if err := blockInputSyscall(true); err != nil {
				t.Errorf("lock inesperadamente falhou: %v", err)
			}
		}()
		<-lockDone

		unlockDone := make(chan struct{})
		go func() {
			defer close(unlockDone)
			if err := blockInputSyscall(false); err != nil {
				t.Errorf("unlock inesperadamente falhou: %v", err)
			}
		}()
		<-unlockDone
	}
	close(stopBusy)
	busyWG.Wait()

	close(callsCh)
	var firstThreadID uint32
	n := 0
	for c := range callsCh {
		n++
		if c.threadID == 0 {
			t.Fatalf("threadID zerado na chamada #%d (block=%v)", n, c.block)
		}
		if firstThreadID == 0 {
			firstThreadID = c.threadID
			continue
		}
		if c.threadID != firstThreadID {
			t.Fatalf("chamada #%d (block=%v) rodou na thread %d, want %d (mesma de todas as outras) — regressão do bug ASSBOH 11/11", n, c.block, c.threadID, firstThreadID)
		}
	}
	if n != rounds*2 {
		t.Fatalf("recebi %d chamadas, want %d (rounds*2)", n, rounds*2)
	}
}

// TestBlockInputConcurrentCallsDontCorruptStateWhenWorkerBusy cobre o 🔴
// CRÍTICO da 3ª rodada de code-review, reproduzindo o cenário real (não
// mockado) que distingue os dois sentinels: uma chamada #1 cuja syscall
// real fica presa/lenta no worker (simulada aqui via blockInputSyscallDirectFn
// bloqueante) — igual a um BlockInput real demorando — e uma chamada #2
// concorrente que chega ENQUANTO o worker ainda está ocupado com a #1.
//
// A #2 nunca sai do canal (o worker só processa um pedido de cada vez) —
// deve estourar o 1º select de blockInputSyscall (errBlockInputNotSent), já
// que nada foi disparado em nome dela. A #1, cuja syscall real está em
// voo, deve estourar o 2º select (errBlockInputNoResponse) quando o caller
// desiste. Sem a distinção dos dois sentinels (ver achado 🔴), as duas
// receberiam o mesmo erro e setLocalInputLocked aplicaria a mesma lógica
// pessimista nas duas — permitindo que a #2 (nada em voo) desarme o estado
// que protege a #1 (sucesso tardio real possível).
func TestBlockInputConcurrentCallsDontCorruptStateWhenWorkerBusy(t *testing.T) {
	originalDirect := blockInputSyscallDirectFn
	originalTimeout := blockInputWorkerTimeout
	defer func() {
		blockInputSyscallDirectFn = originalDirect
		blockInputWorkerTimeout = originalTimeout
	}()

	blockInputWorkerTimeout = 50 * time.Millisecond

	releaseFirstCall := make(chan struct{})
	firstCallStarted := make(chan struct{})
	blockInputSyscallDirectFn = func(block bool) error {
		close(firstCallStarted)
		<-releaseFirstCall // só libera depois que o teste já observou o comportamento da #2
		return nil
	}

	startBlockInputWorker()

	firstCallErrCh := make(chan error, 1)
	go func() { firstCallErrCh <- blockInputSyscall(true) }()
	<-firstCallStarted // garante que a #1 já está DENTRO da syscall real (worker ocupado) antes de disparar a #2

	err2 := blockInputSyscall(false)
	if !errors.Is(err2, errBlockInputNotSent) {
		t.Errorf("chamada #2 (worker ocupado com a #1) = %v, want errBlockInputNotSent", err2)
	}
	if errors.Is(err2, errBlockInputNoResponse) {
		t.Error("chamada #2 não deveria ser errBlockInputNoResponse — nunca foi entregue ao worker, nada em voo")
	}

	err1 := <-firstCallErrCh
	if !errors.Is(err1, errBlockInputNoResponse) {
		t.Errorf("chamada #1 (syscall real presa no worker) = %v, want errBlockInputNoResponse", err1)
	}
	if errors.Is(err1, errBlockInputNotSent) {
		t.Error("chamada #1 não deveria ser errBlockInputNotSent — ela FOI entregue ao worker")
	}

	close(releaseFirstCall)
}
