package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// newTestAgent cria um Agent minimo para testes de executeCommand.
// Nao inicializa http.Client nem canais — apenas o campo cfg e necessario
// para os caminhos que testamos (validacao de params, tipo desconhecido).
func newTestAgent(serverURL string) *Agent {
	return &Agent{
		cfg: &Config{
			ServerURL:    serverURL,
			MachineID:    "test-uuid-1234",
			Token:        "tok-test",
			IntervalSecs: 30,
			PollSecs:     10,
		},
	}
}

// mustJSON serializa v para json.RawMessage ou falha o teste.
func mustJSON(t *testing.T, v interface{}) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("mustJSON: %v", err)
	}
	return b
}

// ── tipo desconhecido ─────────────────────────────────────────────────────────

func TestExecuteCommand_UnknownType(t *testing.T) {
	a := newTestAgent("https://dt.example.com")
	_, err := a.executeCommand(Command{ID: "c-001", Type: "tipo-inexistente", Params: []byte("{}")})
	if err == nil {
		t.Fatal("esperava erro para tipo desconhecido")
	}
	if !strings.Contains(err.Error(), "tipo-inexistente") {
		t.Errorf("mensagem de erro deve citar o tipo, obteve: %v", err)
	}
}

// ── wol ───────────────────────────────────────────────────────────────────────

func TestExecuteCommand_WoL_InvalidJSON(t *testing.T) {
	a := newTestAgent("https://dt.example.com")
	_, err := a.executeCommand(Command{
		ID:     "c-002",
		Type:   "wol",
		Params: json.RawMessage(`not-json`),
	})
	if err == nil {
		t.Fatal("esperava erro para params WoL invalidos")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "invalido") {
		t.Errorf("mensagem de erro deve mencionar invalido, obteve: %v", err)
	}
}

func TestExecuteCommand_WoL_ValidParams(t *testing.T) {
	a := newTestAgent("https://dt.example.com")
	result, err := a.executeCommand(Command{
		ID:   "c-003",
		Type: "wol",
		Params: mustJSON(t, WoLParams{
			MAC:       "AA:BB:CC:DD:EE:FF",
			Broadcast: "127.0.0.1", // loopback — nao envia de verdade
		}),
	})
	if err != nil {
		t.Fatalf("WoL com params validos falhou: %v", err)
	}
	if !strings.Contains(result, "AA:BB:CC:DD:EE:FF") {
		t.Errorf("resultado deve citar o MAC, obteve: %q", result)
	}
}

func TestExecuteCommand_WoL_ValidMAC_UsesLocalBroadcast(t *testing.T) {
	// Broadcast vazio → usa localBroadcast(). Deve funcionar (nao lança erro).
	a := newTestAgent("https://dt.example.com")
	_, err := a.executeCommand(Command{
		ID:   "c-004",
		Type: "wol",
		Params: mustJSON(t, WoLParams{
			MAC:       "AA:BB:CC:DD:EE:FF",
			Broadcast: "", // vazio → localBroadcast()
		}),
	})
	// Pode falhar se nao ha interface de rede — apenas log, nao bloqueia CI
	if err != nil {
		t.Logf("WoL com broadcast vazio: %v (aceitavel em CI sem rede)", err)
	}
}

func TestExecuteCommand_WoL_InvalidMAC(t *testing.T) {
	a := newTestAgent("https://dt.example.com")
	_, err := a.executeCommand(Command{
		ID:   "c-005",
		Type: "wol",
		Params: mustJSON(t, WoLParams{
			MAC:       "ZZ:INVALID:MAC",
			Broadcast: "127.0.0.1",
		}),
	})
	if err == nil {
		t.Error("esperava erro para MAC invalido")
	}
}

// ── update ────────────────────────────────────────────────────────────────────

func TestExecuteCommand_Update_InvalidJSON(t *testing.T) {
	a := newTestAgent("https://dt.example.com")
	_, err := a.executeCommand(Command{
		ID:     "c-006",
		Type:   "update",
		Params: json.RawMessage(`not-json`),
	})
	if err == nil {
		t.Fatal("esperava erro para params de update invalidos")
	}
}

func TestExecuteCommand_Update_EmptyVersion(t *testing.T) {
	a := newTestAgent("https://dt.example.com")
	_, err := a.executeCommand(Command{
		ID:     "c-007",
		Type:   "update",
		Params: mustJSON(t, map[string]string{"version": "", "sha256": "abc"}),
	})
	if err == nil {
		t.Fatal("esperava erro para version vazia em update")
	}
}

// ── aloha-index-nfce-day ──────────────────────────────────────────────────────

func TestExecuteCommand_AlohaIndexNFCeDay_MissingParams(t *testing.T) {
	a := newTestAgent("https://dt.example.com")

	t.Run("month e day ausentes", func(t *testing.T) {
		_, err := a.executeCommand(Command{
			ID:     "c-008",
			Type:   "aloha-index-nfce-day",
			Params: mustJSON(t, map[string]string{}),
		})
		if err == nil {
			t.Error("esperava erro para month/day ausentes")
		}
	})

	t.Run("JSON invalido", func(t *testing.T) {
		_, err := a.executeCommand(Command{
			ID:     "c-009",
			Type:   "aloha-index-nfce-day",
			Params: json.RawMessage(`not-json`),
		})
		if err == nil {
			t.Error("esperava erro para JSON invalido")
		}
	})
}

// ── aloha-find-nfce ───────────────────────────────────────────────────────────

func TestExecuteCommand_AlohaFindNFCe_MissingDate(t *testing.T) {
	a := newTestAgent("https://dt.example.com")
	_, err := a.executeCommand(Command{
		ID:     "c-010",
		Type:   "aloha-find-nfce",
		Params: mustJSON(t, map[string]interface{}{"date": ""}),
	})
	if err == nil {
		t.Error("esperava erro para date vazia em aloha-find-nfce")
	}
}

func TestExecuteCommand_AlohaFindNFCe_InvalidJSON(t *testing.T) {
	a := newTestAgent("https://dt.example.com")
	_, err := a.executeCommand(Command{
		ID:     "c-011",
		Type:   "aloha-find-nfce",
		Params: json.RawMessage(`{invalid`),
	})
	if err == nil {
		t.Error("esperava erro para JSON invalido em aloha-find-nfce")
	}
}

// ── dr-setup ──────────────────────────────────────────────────────────────────

func TestExecuteCommand_DrSetup_MissingCreds(t *testing.T) {
	a := newTestAgent("https://dt.example.com")

	t.Run("azure_account ausente", func(t *testing.T) {
		_, err := a.executeCommand(Command{
			ID:     "c-012",
			Type:   "dr-setup",
			Params: mustJSON(t, map[string]string{"sas_token": "sas-abc"}),
		})
		if err == nil {
			t.Error("esperava erro para azure_account ausente")
		}
	})

	t.Run("sas_token ausente", func(t *testing.T) {
		_, err := a.executeCommand(Command{
			ID:     "c-013",
			Type:   "dr-setup",
			Params: mustJSON(t, map[string]string{"azure_account": "storageacc"}),
		})
		if err == nil {
			t.Error("esperava erro para sas_token ausente")
		}
	})

	t.Run("JSON invalido", func(t *testing.T) {
		_, err := a.executeCommand(Command{
			ID:     "c-014",
			Type:   "dr-setup",
			Params: json.RawMessage(`{bad`),
		})
		if err == nil {
			t.Error("esperava erro para JSON invalido em dr-setup")
		}
	})
}

// ── run_powershell ────────────────────────────────────────────────────────────

func TestExecuteCommand_RunPowershell_MissingScript(t *testing.T) {
	a := newTestAgent("https://dt.example.com")

	t.Run("script ausente", func(t *testing.T) {
		_, err := a.executeCommand(Command{
			ID:     "c-ps-001",
			Type:   "run_powershell",
			Params: mustJSON(t, map[string]string{}),
		})
		if err == nil {
			t.Fatal("esperava erro para script ausente")
		}
		if !strings.Contains(err.Error(), "script") {
			t.Errorf("mensagem deve citar 'script', obteve: %v", err)
		}
	})

	t.Run("script vazio", func(t *testing.T) {
		_, err := a.executeCommand(Command{
			ID:     "c-ps-002",
			Type:   "run_powershell",
			Params: mustJSON(t, map[string]string{"script": "   "}),
		})
		if err == nil {
			t.Fatal("esperava erro para script vazio")
		}
	})

	t.Run("JSON invalido", func(t *testing.T) {
		_, err := a.executeCommand(Command{
			ID:     "c-ps-003",
			Type:   "run_powershell",
			Params: json.RawMessage(`{bad`),
		})
		if err == nil {
			t.Fatal("esperava erro para JSON invalido")
		}
	})
}

func TestExecuteCommand_RunPowershell_HappyPath(t *testing.T) {
	a := newTestAgent("https://dt.example.com")
	result, err := a.executeCommand(Command{
		ID:     "c-ps-004",
		Type:   "run_powershell",
		Params: mustJSON(t, map[string]string{"script": "Write-Output 'hello-dm'"}),
	})
	if err != nil {
		t.Fatalf("script simples falhou: %v", err)
	}
	if !strings.Contains(result, "hello-dm") {
		t.Errorf("output deve conter 'hello-dm', obteve: %q", result)
	}
}

func TestExecuteCommand_RunPowershell_Stderr(t *testing.T) {
	// CombinedOutput captura stderr junto com stdout
	a := newTestAgent("https://dt.example.com")
	result, _ := a.executeCommand(Command{
		ID:     "c-ps-005",
		Type:   "run_powershell",
		Params: mustJSON(t, map[string]string{"script": "Write-Output 'ok'; Write-Error 'fail'"}),
	})
	if !strings.Contains(result, "ok") {
		t.Errorf("output deve conter 'ok', obteve: %q", result)
	}
}

func TestExecuteCommand_RunPowershell_ExitCode(t *testing.T) {
	// Script que sai com exit code != 0 deve retornar erro
	a := newTestAgent("https://dt.example.com")
	_, err := a.executeCommand(Command{
		ID:     "c-ps-006",
		Type:   "run_powershell",
		Params: mustJSON(t, map[string]string{"script": "exit 1"}),
	})
	if err == nil {
		t.Fatal("esperava erro para script que sai com exit 1")
	}
}

// ── cancel-shutdown ───────────────────────────────────────────────────────────

func TestExecuteCommand_CancelShutdown_NoActiveShutdown(t *testing.T) {
	// "shutdown /a" falha se nao ha shutdown pendente — esperamos erro
	a := newTestAgent("https://dt.example.com")
	_, err := a.executeCommand(Command{
		ID:     "c-015",
		Type:   "cancel-shutdown",
		Params: json.RawMessage(`{}`),
	})
	// Em CI nao ha shutdown pendente — erro e esperado. So verifica que nao panica.
	_ = err
	t.Log("cancel-shutdown sem shutdown ativo:", err)
}

// ── capture-screenshot ────────────────────────────────────────────────────────

func TestHandleCaptureScreenshot(t *testing.T) {
	t.Setenv("FEATURE_LIVE_ACCESS", "true")
	original := requestScreenshotFromCompanionFn
	defer func() { requestScreenshotFromCompanionFn = original }()

	requestScreenshotFromCompanionFn = func() ([]byte, error) {
		return []byte("fake-jpeg-bytes"), nil
	}

	cmd := Command{ID: "cmd-1", Type: "capture-screenshot", Params: json.RawMessage(`{"activityLogId":42}`)}
	result, err := handleCaptureScreenshot(cmd)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	want := base64.StdEncoding.EncodeToString([]byte("fake-jpeg-bytes"))
	if result != want {
		t.Errorf("esperava base64 %q, obteve %q", want, result)
	}
}

func TestHandleCaptureScreenshotCompanionError(t *testing.T) {
	t.Setenv("FEATURE_LIVE_ACCESS", "true")
	original := requestScreenshotFromCompanionFn
	defer func() { requestScreenshotFromCompanionFn = original }()

	requestScreenshotFromCompanionFn = func() ([]byte, error) {
		return nil, fmt.Errorf("companion não respondeu")
	}

	cmd := Command{ID: "cmd-1", Type: "capture-screenshot", Params: json.RawMessage(`{}`)}
	_, err := handleCaptureScreenshot(cmd)
	if err == nil {
		t.Fatal("esperava erro quando companion falha")
	}
}

func TestHandleCaptureScreenshotEmptyPayload(t *testing.T) {
	t.Setenv("FEATURE_LIVE_ACCESS", "true")
	original := requestScreenshotFromCompanionFn
	defer func() { requestScreenshotFromCompanionFn = original }()

	requestScreenshotFromCompanionFn = func() ([]byte, error) {
		return nil, nil // companion sem erro, mas sem frame — não pode ser sucesso
	}

	cmd := Command{ID: "cmd-1", Type: "capture-screenshot", Params: json.RawMessage(`{}`)}
	_, err := handleCaptureScreenshot(cmd)
	if err == nil {
		t.Fatal("esperava erro com payload vazio (nil, nil), veio sucesso")
	}
}

func TestHandleCaptureScreenshotFeatureDisabled(t *testing.T) {
	// Explícito (não "sem t.Setenv"): quem roda os testes pode ter
	// FEATURE_LIVE_ACCESS=true no ambiente real (ex: dev/staging, onde a
	// feature está sendo testada de propósito) — sem isso o teste passaria
	// por acidente lá e falharia aqui, dependendo de onde roda.
	t.Setenv("FEATURE_LIVE_ACCESS", "false")
	original := requestScreenshotFromCompanionFn
	defer func() { requestScreenshotFromCompanionFn = original }()
	requestScreenshotFromCompanionFn = func() ([]byte, error) {
		t.Fatal("não deveria chamar requestScreenshotFromCompanionFn com a flag desabilitada")
		return nil, nil
	}

	cmd := Command{ID: "cmd-1", Type: "capture-screenshot", Params: json.RawMessage(`{}`)}
	_, err := handleCaptureScreenshot(cmd)
	if err == nil {
		t.Fatal("esperava erro com FEATURE_LIVE_ACCESS desabilitada")
	}
}

func TestExecuteCommand_CaptureScreenshot_Registered(t *testing.T) {
	t.Setenv("FEATURE_LIVE_ACCESS", "true")
	original := requestScreenshotFromCompanionFn
	defer func() { requestScreenshotFromCompanionFn = original }()

	requestScreenshotFromCompanionFn = func() ([]byte, error) {
		return []byte("fake-jpeg-bytes"), nil
	}

	a := newTestAgent("https://dt.example.com")
	_, err := a.executeCommand(Command{ID: "cmd-1", Type: "capture-screenshot", Params: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatalf("capture-screenshot deve estar registrado no mapa de handlers: %v", err)
	}
}

// ── start-live-session / stop-live-session ───────────────────────────────────

func TestHandleStartLiveSession(t *testing.T) {
	t.Setenv("FEATURE_LIVE_ACCESS", "true")
	original := sendPipeRequestFn
	defer func() { sendPipeRequestFn = original }()

	var gotMsg pipeMessage
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		gotMsg = msg
		return pipeMessage{RequestID: msg.RequestID}, nil
	}

	a := newTestAgent("https://exemplo.test")

	params := `{"sessionId":"s1","mode":"shadow","companionToken":"tok-abc"}`
	cmd := Command{ID: "cmd-1", Type: "start-live-session", Params: json.RawMessage(params)}
	_, err := a.handleStartLiveSession(cmd)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if gotMsg.SessionID != "s1" || gotMsg.Mode != "shadow" || gotMsg.CompanionToken != "tok-abc" {
		t.Errorf("mensagem repassada pro companion incompleta: %+v", gotMsg)
	}
	// pipeMessage não tem campo ServerURL (removido — companion usa cfg
	// local, nunca o da mensagem; ver comentário de handleStartLiveSession).
}

func TestHandleStopLiveSession(t *testing.T) {
	t.Setenv("FEATURE_LIVE_ACCESS", "true")
	original := sendPipeRequestFn
	defer func() { sendPipeRequestFn = original }()

	var gotMsg pipeMessage
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		gotMsg = msg
		return pipeMessage{RequestID: msg.RequestID}, nil
	}

	cmd := Command{ID: "cmd-2", Type: "stop-live-session", Params: json.RawMessage(`{"sessionId":"s1"}`)}
	_, err := handleStopLiveSession(cmd)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if gotMsg.Type != "stop-live-session" {
		t.Errorf("tipo repassado = %q, want stop-live-session", gotMsg.Type)
	}
	if gotMsg.SessionID != "s1" {
		t.Errorf("SessionID repassado = %q, want %q", gotMsg.SessionID, "s1")
	}
}

func TestHandleStartLiveSessionRequiresSessionID(t *testing.T) {
	original := sendPipeRequestFn
	defer func() { sendPipeRequestFn = original }()
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		t.Fatal("não deveria chamar a pipe sem sessionId")
		return pipeMessage{}, nil
	}

	a := newTestAgent("https://exemplo.test")
	cmd := Command{ID: "cmd-1", Type: "start-live-session", Params: json.RawMessage(`{"mode":"shadow"}`)}
	_, err := a.handleStartLiveSession(cmd)
	if err == nil {
		t.Fatal("esperava erro com sessionId ausente")
	}
}

func TestHandleStopLiveSessionRequiresSessionID(t *testing.T) {
	original := sendPipeRequestFn
	defer func() { sendPipeRequestFn = original }()
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		t.Fatal("não deveria chamar a pipe sem sessionId")
		return pipeMessage{}, nil
	}

	cmd := Command{ID: "cmd-2", Type: "stop-live-session", Params: json.RawMessage(`{}`)}
	_, err := handleStopLiveSession(cmd)
	if err == nil {
		t.Fatal("esperava erro com sessionId ausente")
	}
}

func TestHandleStartLiveSessionFeatureDisabled(t *testing.T) {
	t.Setenv("FEATURE_LIVE_ACCESS", "false") // explícito — ver comentário em TestHandleCaptureScreenshotFeatureDisabled
	original := sendPipeRequestFn
	defer func() { sendPipeRequestFn = original }()
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		t.Fatal("não deveria chamar a pipe com a flag desabilitada")
		return pipeMessage{}, nil
	}

	a := newTestAgent("https://exemplo.test")
	cmd := Command{ID: "cmd-1", Type: "start-live-session", Params: json.RawMessage(`{"sessionId":"s1"}`)}
	_, err := a.handleStartLiveSession(cmd)
	if err == nil {
		t.Fatal("esperava erro com FEATURE_LIVE_ACCESS desabilitada")
	}
}

func TestHandleStopLiveSessionFeatureDisabled(t *testing.T) {
	t.Setenv("FEATURE_LIVE_ACCESS", "false") // explícito — ver comentário em TestHandleCaptureScreenshotFeatureDisabled
	original := sendPipeRequestFn
	defer func() { sendPipeRequestFn = original }()
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		t.Fatal("não deveria chamar a pipe com a flag desabilitada")
		return pipeMessage{}, nil
	}

	cmd := Command{ID: "cmd-2", Type: "stop-live-session", Params: json.RawMessage(`{"sessionId":"s1"}`)}
	_, err := handleStopLiveSession(cmd)
	if err == nil {
		t.Fatal("esperava erro com FEATURE_LIVE_ACCESS desabilitada")
	}
}
