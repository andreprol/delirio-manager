package main

// Este arquivo mocka injectMouseMoveFn/injectMouseButtonFn (vars globais
// mutáveis, mesmo padrão de captureScreenJPEGFn/startLiveSessionFn em
// outros arquivos do pacote) — nenhum teste deste pacote usa t.Parallel()
// hoje; não adicionar enquanto mocks dessas vars existirem, ou corrompe
// outros testes silenciosamente.

import (
	"fmt"
	"testing"
	"time"
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

			handleLiveSessionInput([]byte(`{"type":"mousemove","x":1,"y":2}`), mode, "s1")
			handleLiveSessionInput([]byte(`{"type":"mousedown","button":"left"}`), mode, "s1")

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

		handleLiveSessionInput([]byte(`{"type":"mousemove","x":10,"y":20}`), liveSessionNormalMode, "s1")

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

		handleLiveSessionInput([]byte(`{"type":"mousedown","button":"left"}`), liveSessionNormalMode, "s1")
		if gotButton != "left" || !gotDown {
			t.Errorf("mousedown: button=%q down=%v, want left/true", gotButton, gotDown)
		}

		handleLiveSessionInput([]byte(`{"type":"mouseup","button":"right"}`), liveSessionNormalMode, "s1")
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
		handleLiveSessionInput([]byte("não é json"), liveSessionNormalMode, "s1")
	})
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
		handleLiveSessionInput([]byte(`{"type":"lock-local-input"}`), liveSessionNormalMode, "s-abc")
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
		handleLiveSessionInput([]byte(`{"type":"unlock-local-input"}`), liveSessionNormalMode, "s-abc")
		if !called || gotLocked {
			t.Errorf("called=%v locked=%v, want true/false", called, gotLocked)
		}
	})

	t.Run("mode shadow: nem lock nem unlock chamam setLocalInputLockedFn", func(t *testing.T) {
		called := false
		setLocalInputLockedFn = func(sessionID string, locked bool) error { called = true; return nil }
		handleLiveSessionInput([]byte(`{"type":"lock-local-input"}`), "shadow", "s-abc")
		handleLiveSessionInput([]byte(`{"type":"unlock-local-input"}`), "shadow", "s-abc")
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
// chamar isto de novo pra esta sessão (ela já terminou).
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
