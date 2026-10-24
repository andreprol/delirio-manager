package main

import (
	"fmt"
	"testing"
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

			handleLiveSessionInput([]byte(`{"type":"mousemove","x":1,"y":2}`), mode)
			handleLiveSessionInput([]byte(`{"type":"mousedown","button":"left"}`), mode)

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

		handleLiveSessionInput([]byte(`{"type":"mousemove","x":10,"y":20}`), liveSessionNormalMode)

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

		handleLiveSessionInput([]byte(`{"type":"mousedown","button":"left"}`), liveSessionNormalMode)
		if gotButton != "left" || !gotDown {
			t.Errorf("mousedown: button=%q down=%v, want left/true", gotButton, gotDown)
		}

		handleLiveSessionInput([]byte(`{"type":"mouseup","button":"right"}`), liveSessionNormalMode)
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
		handleLiveSessionInput([]byte("não é json"), liveSessionNormalMode)
	})
}
