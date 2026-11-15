package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// withFakeLiveCompanion simula "existe um companion vivo agora" pro
// chamador (hasLiveCompanion, agent.go) -- os testes de start/stop-live-
// session que esperam o caminho de sempre (pipe pro companion) precisam
// disso desde que handleStartLiveSession/handleStopLiveSession passaram a
// checar a.hasLiveCompanion() pra decidir entre esse caminho e o modo
// session-zero (achado do item 1, 14/11/2026).
func withFakeLiveCompanion(t *testing.T) {
	t.Helper()
	original := isCompanionAliveFn
	isCompanionAliveFn = func(windows.Handle) bool { return true }
	t.Cleanup(func() { isCompanionAliveFn = original })
}

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

// Regressão do finding 🔴 do code-reviewer (01/11/2026): depois do fix de
// runCommandWithDeadline (agent.go), commandLoop não serializa mais
// handlers — um dr-setup "abandonado" por timeout ainda roda de verdade em
// background. Sem este guard, um 2º dr-setup disparado pelo operador
// reagindo ao timeout correria concorrente com o 1º, escrevendo no MESMO
// instalador Veeam no disco.
func TestHandleDRSetup_ReentrancyGuard(t *testing.T) {
	a := newTestAgent("https://dt.example.com")
	a.drSetupInProgress.Store(true) // simula setup já em andamento
	defer a.drSetupInProgress.Store(false)

	_, err := a.handleDRSetup(Command{
		ID:     "c-dr-guard",
		Type:   "dr-setup",
		Params: mustJSON(t, map[string]string{"azure_account": "x", "sas_token": "y"}),
	})
	if err == nil {
		t.Fatal("esperava erro — dr-setup já em andamento")
	}
	if !strings.Contains(err.Error(), "andamento") {
		t.Errorf("mensagem deve citar 'andamento', obteve: %v", err)
	}
}

func TestHandleDRSetup_ReentrancyGuard_ReleasedOnEarlyReturn(t *testing.T) {
	a := newTestAgent("https://dt.example.com")
	// Params sem credenciais -> retorna erro de validação ANTES de
	// installVeeam — guard tem que ser liberado (defer) mesmo nesse caminho.
	_, err := a.handleDRSetup(Command{
		ID:     "c-dr-1",
		Type:   "dr-setup",
		Params: mustJSON(t, map[string]string{}),
	})
	if err == nil {
		t.Fatal("esperava erro de credenciais ausentes")
	}
	if a.drSetupInProgress.Load() {
		t.Fatal("guard deveria ter sido liberado pelo defer mesmo com erro de validação")
	}
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
	setFeatureLiveAccessEnabled(true)
	t.Cleanup(func() { setFeatureLiveAccessEnabled(false) })
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
	setFeatureLiveAccessEnabled(true)
	t.Cleanup(func() { setFeatureLiveAccessEnabled(false) })
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
	setFeatureLiveAccessEnabled(true)
	t.Cleanup(func() { setFeatureLiveAccessEnabled(false) })
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
	// Explícito (não "sem setFeatureLiveAccessEnabled"): um teste anterior
	// no mesmo pacote pode ter deixado a flag ligada (featureLiveAccessFlag
	// é var de pacote, não isolada por teste como t.Setenv seria) — sem
	// isso este teste dependeria da ordem de execução dos outros.
	setFeatureLiveAccessEnabled(false)
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
	setFeatureLiveAccessEnabled(true)
	t.Cleanup(func() { setFeatureLiveAccessEnabled(false) })
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
	setFeatureLiveAccessEnabled(true)
	t.Cleanup(func() { setFeatureLiveAccessEnabled(false) })
	withFakeLiveCompanion(t)
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
	setFeatureLiveAccessEnabled(true)
	t.Cleanup(func() { setFeatureLiveAccessEnabled(false) })
	withFakeLiveCompanion(t)
	original := sendPipeRequestFn
	defer func() { sendPipeRequestFn = original }()

	var gotMsg pipeMessage
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		gotMsg = msg
		return pipeMessage{RequestID: msg.RequestID}, nil
	}

	a := newTestAgent("https://exemplo.test")
	cmd := Command{ID: "cmd-2", Type: "stop-live-session", Params: json.RawMessage(`{"sessionId":"s1"}`)}
	_, err := a.handleStopLiveSession(cmd)
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

	a := newTestAgent("https://exemplo.test")
	cmd := Command{ID: "cmd-2", Type: "stop-live-session", Params: json.RawMessage(`{}`)}
	_, err := a.handleStopLiveSession(cmd)
	if err == nil {
		t.Fatal("esperava erro com sessionId ausente")
	}
}

func TestHandleStartLiveSessionFeatureDisabled(t *testing.T) {
	setFeatureLiveAccessEnabled(false)
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
	setFeatureLiveAccessEnabled(false)
	original := sendPipeRequestFn
	defer func() { sendPipeRequestFn = original }()
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		t.Fatal("não deveria chamar a pipe com a flag desabilitada")
		return pipeMessage{}, nil
	}

	a := newTestAgent("https://exemplo.test")
	cmd := Command{ID: "cmd-2", Type: "stop-live-session", Params: json.RawMessage(`{"sessionId":"s1"}`)}
	_, err := a.handleStopLiveSession(cmd)
	if err == nil {
		t.Fatal("esperava erro com FEATURE_LIVE_ACCESS desabilitada")
	}
}

// ── modo session-zero (item 1, 14/11/2026 -- acesso sem sessão interativa) ───

// TestHandleStartLiveSessionSessionZeroEnabled: sem companion vivo
// (hasLiveCompanion=false, default de newTestAgent/isCompanionAliveFn real
// com handle 0) e FEATURE_SESSION0_CAPTURE ligada -- o SERVIÇO assume
// direto via startLiveSessionFn(sessionZero=true), nunca passa pela pipe.
func TestHandleStartLiveSessionSessionZeroEnabled(t *testing.T) {
	setFeatureLiveAccessEnabled(true)
	t.Cleanup(func() { setFeatureLiveAccessEnabled(false) })
	setFeatureSessionZeroCaptureEnabled(true)
	t.Cleanup(func() { setFeatureSessionZeroCaptureEnabled(false) })

	origPipe := sendPipeRequestFn
	t.Cleanup(func() { sendPipeRequestFn = origPipe })
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		t.Fatal("não deveria chamar a pipe -- sem companion, devia ir direto pro modo session-zero")
		return pipeMessage{}, nil
	}

	origStart := startLiveSessionFn
	t.Cleanup(func() { startLiveSessionFn = origStart })
	var gotSessionID, gotServerURL string
	var gotSessionZero bool
	startLiveSessionFn = func(sessionID, mode, companionToken, serverURL string, sessionZero bool) bool {
		gotSessionID, gotServerURL, gotSessionZero = sessionID, serverURL, sessionZero
		return true
	}

	a := newTestAgent("https://exemplo.test")
	cmd := Command{ID: "cmd-1", Type: "start-live-session", Params: json.RawMessage(`{"sessionId":"s1","mode":"normal"}`)}
	msg, err := a.handleStartLiveSession(cmd)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if gotSessionID != "s1" || gotServerURL != "https://exemplo.test" {
		t.Errorf("startLiveSessionFn recebeu sessionID=%q serverURL=%q, want s1/https://exemplo.test", gotSessionID, gotServerURL)
	}
	if !gotSessionZero {
		t.Error("esperava sessionZero=true (sem companion vivo)")
	}
	if !strings.Contains(msg, "session-zero") {
		t.Errorf("mensagem de sucesso deveria mencionar session-zero, veio %q", msg)
	}
}

// TestHandleStartLiveSessionSessionZeroDisabled: sem companion vivo e
// FEATURE_SESSION0_CAPTURE desligada (default) -- erro claro, nem pipe nem
// startLiveSessionFn chamados. Esse é o comportamento de hoje (antes desta
// feature, start-live-session sem companion simplesmente travaria/falharia
// na pipe) -- a flag precisa estar EXPLICITAMENTE ligada pra mudar isso.
func TestHandleStartLiveSessionSessionZeroDisabled(t *testing.T) {
	setFeatureLiveAccessEnabled(true)
	t.Cleanup(func() { setFeatureLiveAccessEnabled(false) })
	// featureSessionZeroCaptureEnabled fica no default (false) de propósito.

	origPipe := sendPipeRequestFn
	t.Cleanup(func() { sendPipeRequestFn = origPipe })
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		t.Fatal("não deveria chamar a pipe -- sem companion")
		return pipeMessage{}, nil
	}
	origStart := startLiveSessionFn
	t.Cleanup(func() { startLiveSessionFn = origStart })
	startLiveSessionFn = func(sessionID, mode, companionToken, serverURL string, sessionZero bool) bool {
		t.Fatal("não deveria chamar startLiveSessionFn -- FEATURE_SESSION0_CAPTURE desligada")
		return false
	}

	a := newTestAgent("https://exemplo.test")
	cmd := Command{ID: "cmd-1", Type: "start-live-session", Params: json.RawMessage(`{"sessionId":"s1"}`)}
	_, err := a.handleStartLiveSession(cmd)
	if err == nil {
		t.Fatal("esperava erro -- sem companion e sem FEATURE_SESSION0_CAPTURE")
	}
	if !strings.Contains(err.Error(), "FEATURE_SESSION0_CAPTURE") {
		t.Errorf("erro deveria mencionar FEATURE_SESSION0_CAPTURE, veio %q", err.Error())
	}
}

// TestHandleStartLiveSessionSessionZeroDuplicate: startLiveSessionFn
// devolvendo false (sessão já ativa) tem que virar erro, mesmo
// comportamento do caminho via pipe (TestHandleCompanionPipeMessage_
// StartLiveSessionDuplicate, companion_test.go).
func TestHandleStartLiveSessionSessionZeroDuplicate(t *testing.T) {
	setFeatureLiveAccessEnabled(true)
	t.Cleanup(func() { setFeatureLiveAccessEnabled(false) })
	setFeatureSessionZeroCaptureEnabled(true)
	t.Cleanup(func() { setFeatureSessionZeroCaptureEnabled(false) })

	origStart := startLiveSessionFn
	t.Cleanup(func() { startLiveSessionFn = origStart })
	startLiveSessionFn = func(sessionID, mode, companionToken, serverURL string, sessionZero bool) bool {
		return false
	}

	a := newTestAgent("https://exemplo.test")
	cmd := Command{ID: "cmd-1", Type: "start-live-session", Params: json.RawMessage(`{"sessionId":"s1"}`)}
	_, err := a.handleStartLiveSession(cmd)
	if err == nil {
		t.Fatal("esperava erro quando startLiveSessionFn devolve false")
	}
}

// TestHandleStopLiveSessionSessionZero: sem companion vivo -- chama
// stopLiveSessionFn DIRETO (local, mapa liveSessions em
// livesession_windows.go), nunca a pipe.
// TestHandleStopLiveSessionSessionZero: a decisão de parar local (em vez de
// via pipe) agora vem de isLiveSessionActive(sessionID) -- consultando o
// registro gravado NO START (liveSessionHandle, livesession_windows.go),
// não mais a.hasLiveCompanion() (achado 🔴 CRÍTICO do code-reviewer: essa
// releitura podia divergir do estado no momento do start, ver comentário
// em handleStopLiveSession). Simula isso registrando "s1" direto no mapa
// liveSessions, mesmo padrão de TestIsLiveSessionActive
// (livesession_windows_test.go).
func TestHandleStopLiveSessionSessionZero(t *testing.T) {
	setFeatureLiveAccessEnabled(true)
	t.Cleanup(func() { setFeatureLiveAccessEnabled(false) })

	const sid = "s1"
	liveSessionsMu.Lock()
	liveSessions[sid] = &liveSessionHandle{stopCh: make(chan struct{}), sessionZero: true}
	liveSessionsMu.Unlock()
	t.Cleanup(func() {
		liveSessionsMu.Lock()
		delete(liveSessions, sid)
		liveSessionsMu.Unlock()
	})

	origPipe := sendPipeRequestFn
	t.Cleanup(func() { sendPipeRequestFn = origPipe })
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		t.Fatal("não deveria chamar a pipe -- sessão registrada localmente (session-zero)")
		return pipeMessage{}, nil
	}

	origStop := stopLiveSessionFn
	t.Cleanup(func() { stopLiveSessionFn = origStop })
	var gotSessionID string
	stopLiveSessionFn = func(sessionID string) { gotSessionID = sessionID }

	a := newTestAgent("https://exemplo.test")
	cmd := Command{ID: "cmd-2", Type: "stop-live-session", Params: json.RawMessage(`{"sessionId":"s1"}`)}
	_, err := a.handleStopLiveSession(cmd)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if gotSessionID != "s1" {
		t.Errorf("stopLiveSessionFn recebeu sessionID=%q, want s1", gotSessionID)
	}
}

// TestHandleStopLiveSessionCompanionAliveButNotLocallyRegistered: achado
// 🔴 CRÍTICO do code-reviewer, cenário espelhado -- se a sessionID pedida
// não está registrada localmente (foi iniciada via companion de verdade,
// nunca por este serviço), o stop tem que ir pela pipe, não importa o
// estado atual do companion -- isLiveSessionActive só reflete sessões que
// ESTE processo (serviço) iniciou localmente.
func TestHandleStopLiveSessionCompanionAliveButNotLocallyRegistered(t *testing.T) {
	setFeatureLiveAccessEnabled(true)
	t.Cleanup(func() { setFeatureLiveAccessEnabled(false) })

	origPipe := sendPipeRequestFn
	t.Cleanup(func() { sendPipeRequestFn = origPipe })
	var pipeCalled bool
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		pipeCalled = true
		return pipeMessage{RequestID: msg.RequestID}, nil
	}

	a := newTestAgent("https://exemplo.test")
	cmd := Command{ID: "cmd-2", Type: "stop-live-session", Params: json.RawMessage(`{"sessionId":"s-nao-registrada"}`)}
	_, err := a.handleStopLiveSession(cmd)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if !pipeCalled {
		t.Fatal("deveria ter ido pela pipe -- sessão não registrada localmente")
	}
}
