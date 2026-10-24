package main

import (
	"net/url"
	"strings"
	"testing"
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
