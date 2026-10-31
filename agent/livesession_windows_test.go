package main

import (
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestLiveSessionFrameIntervalMs(t *testing.T) {
	// ~10fps conforme spec (sessão ao vivo fluida) = 100ms entre frames
	if ms := liveSessionFrameIntervalMs(); ms != 100 {
		t.Errorf("liveSessionFrameIntervalMs() = %d, want 100", ms)
	}
}

func TestBuildLiveWebSocketURL(t *testing.T) {
	cases := []struct {
		name       string
		serverURL  string
		wantPrefix string
	}{
		{"https vira wss", "https://dt.example.com", "wss://dt.example.com/live?"},
		{"http vira ws", "http://dt.example.com", "ws://dt.example.com/live?"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := buildLiveWebSocketURL(c.serverURL, "s1", "tok-abc")
			if !strings.HasPrefix(got, c.wantPrefix) {
				t.Errorf("buildLiveWebSocketURL(%q, ...) = %q, want prefixo %q", c.serverURL, got, c.wantPrefix)
			}
			parsed, err := url.Parse(got)
			if err != nil {
				t.Fatalf("URL gerada inválida: %v", err)
			}
			q := parsed.Query()
			if q.Get("sessionId") != "s1" {
				t.Errorf("sessionId = %q, want s1", q.Get("sessionId"))
			}
			if q.Get("role") != "companion" {
				t.Errorf("role = %q, want companion", q.Get("role"))
			}
			if q.Get("token") != "tok-abc" {
				t.Errorf("token = %q, want tok-abc", q.Get("token"))
			}
		})
	}
}

func TestRedactLiveSessionURL(t *testing.T) {
	wsURL := buildLiveWebSocketURL("https://dt.example.com", "s1", "segredo-nao-pode-aparecer")
	redacted := redactLiveSessionURL(wsURL)

	if strings.Contains(redacted, "segredo-nao-pode-aparecer") {
		t.Errorf("redactLiveSessionURL não mascarou o token: %q", redacted)
	}
	if !strings.Contains(redacted, "token=REDACTED") {
		t.Errorf("redactLiveSessionURL = %q, esperava token=REDACTED", redacted)
	}
	if !strings.Contains(redacted, "sessionId=s1") {
		t.Errorf("redactLiveSessionURL não deveria mascarar campos além de token: %q", redacted)
	}

	if got := redactLiveSessionURL("://url-invalida-de-proposito"); got != "<url inválida>" {
		t.Errorf("redactLiveSessionURL(url inválida) = %q, want <url inválida>", got)
	}
}

// TestIsLiveSessionActive manipula liveSessions direto (sob o mesmo mutex
// de produção) pra testar a leitura sem depender de startLiveSession real
// (que discaria um WebSocket de verdade). Limpa o estado global ao final
// pra não vazar pra outros testes deste pacote.
func TestIsLiveSessionActive(t *testing.T) {
	const sid = "s-test-isactive"
	liveSessionsMu.Lock()
	delete(liveSessions, sid) // garante estado limpo antes de começar
	liveSessionsMu.Unlock()
	defer func() {
		liveSessionsMu.Lock()
		delete(liveSessions, sid)
		liveSessionsMu.Unlock()
	}()

	if isLiveSessionActive(sid) {
		t.Fatal("esperava false antes de qualquer sessão registrada")
	}

	liveSessionsMu.Lock()
	liveSessions[sid] = &liveSessionHandle{stopCh: make(chan struct{})}
	liveSessionsMu.Unlock()

	if !isLiveSessionActive(sid) {
		t.Fatal("esperava true com sessão registrada")
	}
}

// fakeFrameWriter implementa frameWriter sem WebSocket real — permite
// testar a lógica de contagem de falhas/throttle de log/recuperação de
// sendLiveSessionFrame (a parte com estado desta função) isoladamente.
type fakeFrameWriter struct {
	writeErr error
	writes   int
}

func (f *fakeFrameWriter) SetWriteDeadline(time.Time) error { return nil }

func (f *fakeFrameWriter) WriteMessage(messageType int, data []byte) error {
	f.writes++
	return f.writeErr
}

// fakeMessageReader implementa messageReader sem WebSocket real — devolve
// cada mensagem de `messages` em sequência e, depois da última, um erro
// (simula a conexão caindo, igual readLiveSessionInput espera pra sair do
// loop).
type fakeMessageReader struct {
	messages [][]byte
	i        int
}

func (r *fakeMessageReader) ReadMessage() (int, []byte, error) {
	if r.i >= len(r.messages) {
		return 0, nil, fmt.Errorf("fakeMessageReader: sem mais mensagens")
	}
	msg := r.messages[r.i]
	r.i++
	return 0, msg, nil
}

// TestReadLiveSessionInputNonNormalModeConsumesAllMessages confirma que,
// em mode != normal, readLiveSessionInput ainda consome TODAS as mensagens
// até a conexão cair (o loop não trava/sai antes do tempo) e nenhuma delas
// chega a injectMouseMoveFn/injectMouseButtonFn — defesa em profundidade
// (ver handleLiveSessionInput) continua valendo mensagem a mensagem, não
// só na primeira. Não assere a contagem exata de logError (exigiria tornar
// logError mockável globalmente, mudança maior demais pra justificar só
// por este teste) — cobre o comportamento observável do loop/dispatch.
func TestReadLiveSessionInputNonNormalModeConsumesAllMessages(t *testing.T) {
	originalMove, originalButton := injectMouseMoveFn, injectMouseButtonFn
	defer func() { injectMouseMoveFn, injectMouseButtonFn = originalMove, originalButton }()

	calls := 0
	injectMouseMoveFn = func(x, y int32) error { calls++; return nil }
	injectMouseButtonFn = func(button string, down bool) error { calls++; return nil }

	reader := &fakeMessageReader{messages: [][]byte{
		[]byte(`{"type":"mousemove","x":1,"y":1}`),
		[]byte(`{"type":"mousedown","button":"left"}`),
		[]byte(`{"type":"mousemove","x":2,"y":2}`),
	}}
	readLiveSessionInput(reader, "shadow", "s1")

	if reader.i != len(reader.messages) {
		t.Errorf("mensagens consumidas = %d, want %d (loop deveria ler todas antes de sair por erro)", reader.i, len(reader.messages))
	}
	if calls != 0 {
		t.Errorf("injectMouseMoveFn/injectMouseButtonFn chamadas %d vez(es) em mode shadow, want 0", calls)
	}
}

// fakeScreenCapturer implementa screenCapturer sem GDI/DXGI real — permite
// testar sendLiveSessionFrame/runLiveSessionLoop isoladamente, mesmo padrão
// de fakeFrameWriter/fakeMessageReader neste arquivo.
type fakeScreenCapturer struct {
	captureFn func(quality int) ([]byte, error)
	closed    bool
}

func (f *fakeScreenCapturer) CaptureJPEG(quality int) ([]byte, error) { return f.captureFn(quality) }
func (f *fakeScreenCapturer) Bounds() (int, int)                      { return 1920, 1080 }
func (f *fakeScreenCapturer) Close()                                  { f.closed = true }

func TestSendLiveSessionFrame(t *testing.T) {
	t.Run("sucesso simples", func(t *testing.T) {
		cap := &fakeScreenCapturer{captureFn: func(q int) ([]byte, error) { return []byte("frame"), nil }}
		w := &fakeFrameWriter{}
		failures := 0
		if !sendLiveSessionFrame(w, "s1", cap, &failures) {
			t.Fatal("esperava true no caminho de sucesso")
		}
		if w.writes != 1 {
			t.Errorf("writes = %d, want 1", w.writes)
		}
		if failures != 0 {
			t.Errorf("failures = %d, want 0", failures)
		}
	})

	t.Run("falha de captura não derruba a sessão", func(t *testing.T) {
		cap := &fakeScreenCapturer{captureFn: func(q int) ([]byte, error) { return nil, fmt.Errorf("falha de captura") }}
		w := &fakeFrameWriter{}
		failures := 0
		if !sendLiveSessionFrame(w, "s1", cap, &failures) {
			t.Fatal("falha de captura não deveria encerrar a sessão")
		}
		if failures != 1 {
			t.Errorf("failures = %d, want 1", failures)
		}
		if w.writes != 0 {
			t.Errorf("writes = %d, want 0 (não deveria escrever sem frame capturado)", w.writes)
		}
	})

	t.Run("recupera após falhas consecutivas", func(t *testing.T) {
		callCount := 0
		cap := &fakeScreenCapturer{captureFn: func(q int) ([]byte, error) {
			callCount++
			if callCount <= 2 {
				return nil, fmt.Errorf("falha transitória")
			}
			return []byte("frame"), nil
		}}
		w := &fakeFrameWriter{}
		failures := 0
		sendLiveSessionFrame(w, "s1", cap, &failures)
		sendLiveSessionFrame(w, "s1", cap, &failures)
		if failures != 2 {
			t.Fatalf("failures = %d, want 2 antes da recuperação", failures)
		}
		if !sendLiveSessionFrame(w, "s1", cap, &failures) {
			t.Fatal("esperava true na recuperação")
		}
		if failures != 0 {
			t.Errorf("failures = %d, want 0 após recuperação", failures)
		}
	})

	t.Run("falha de escrita encerra a sessão", func(t *testing.T) {
		cap := &fakeScreenCapturer{captureFn: func(q int) ([]byte, error) { return []byte("frame"), nil }}
		w := &fakeFrameWriter{writeErr: fmt.Errorf("conexão morta")}
		failures := 0
		if sendLiveSessionFrame(w, "s1", cap, &failures) {
			t.Fatal("falha de escrita deveria encerrar a sessão (false)")
		}
	})
}
