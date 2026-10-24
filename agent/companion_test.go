package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseCompanionFlags(t *testing.T) {
	args := []string{"--companion"}
	if !isCompanionMode(args) {
		t.Fatal("esperava isCompanionMode(true) com --companion presente")
	}
	if isCompanionMode([]string{"--install"}) {
		t.Fatal("esperava isCompanionMode(false) sem --companion")
	}
}

func TestBuildActivityPayload(t *testing.T) {
	payload := buildActivityPayload("Vagas - LinkedIn", "chrome.exe")
	if payload.WindowTitle != "Vagas - LinkedIn" {
		t.Errorf("WindowTitle = %q", payload.WindowTitle)
	}
	if payload.ProcessName != "chrome.exe" {
		t.Errorf("ProcessName = %q", payload.ProcessName)
	}
}

func TestSendActivityPayload_Success(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotContentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cfg := &Config{ServerURL: srv.URL, Token: "tok-123"}
	err := sendActivityPayload(srv.Client(), cfg, buildActivityPayload("t", "p.exe"))
	if err != nil {
		t.Fatalf("sendActivityPayload() erro inesperado: %v", err)
	}
	if gotMethod != "POST" {
		t.Errorf("Method = %q, want POST", gotMethod)
	}
	if gotPath != "/api/activity" {
		t.Errorf("Path = %q, want /api/activity", gotPath)
	}
	if gotAuth != "Bearer tok-123" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer tok-123")
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotContentType)
	}
}

func TestSendActivityPayload_StatusError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	cfg := &Config{ServerURL: srv.URL, Token: "tok-123"}
	err := sendActivityPayload(srv.Client(), cfg, buildActivityPayload("t", "p.exe"))
	if err == nil {
		t.Fatal("esperava erro com status 401, veio nil")
	}
}

func TestHandleCompanionPipeMessage(t *testing.T) {
	original := captureScreenJPEGFn
	defer func() { captureScreenJPEGFn = original }()
	captureScreenJPEGFn = func(quality int) ([]byte, error) {
		return []byte("fake-jpeg"), nil
	}

	resp := handleCompanionPipeMessage(pipeMessage{Type: "capture-screenshot", RequestID: "req-1"})
	if resp.Error != "" {
		t.Fatalf("erro inesperado: %s", resp.Error)
	}
	if resp.ResultJPEGBase64 == "" {
		t.Fatal("esperava resultJpegBase64 preenchido")
	}
}

func TestHandleCompanionPipeMessageUnknownType(t *testing.T) {
	resp := handleCompanionPipeMessage(pipeMessage{Type: "tipo-desconhecido", RequestID: "req-2"})
	if resp.Error == "" {
		t.Fatal("esperava erro pra tipo de mensagem desconhecido")
	}
}

// TestHandleCompanionPipeMessageCaptureError confirma que uma falha de
// captureScreenJPEGFn vira Error preenchido (não ResultJPEGBase64vazio
// mascarado como sucesso) — o contrato de que handleCaptureScreenshot
// (commands.go) depende do outro lado da pipe.
func TestHandleCompanionPipeMessageCaptureError(t *testing.T) {
	original := captureScreenJPEGFn
	defer func() { captureScreenJPEGFn = original }()
	captureScreenJPEGFn = func(quality int) ([]byte, error) {
		return nil, fmt.Errorf("falha simulada de captura")
	}

	resp := handleCompanionPipeMessage(pipeMessage{Type: "capture-screenshot", RequestID: "req-3"})
	if resp.Error == "" {
		t.Fatal("esperava Error preenchido quando captureScreenJPEGFn falha")
	}
	if resp.ResultJPEGBase64 != "" {
		t.Errorf("esperava ResultJPEGBase64 vazio no caminho de erro, obteve %q", resp.ResultJPEGBase64)
	}
}

// TestCompanionPipeLoop_CaptureScreenshotEndToEnd sobe um listener real
// (listenPipe + handleCompanionPipeMessage, como companionPipeLoop faz) e
// chama requestScreenshotFromCompanionFn (cliente real, commands.go) do
// outro lado — a única diferença de produção é captureScreenJPEGFn mockado
// (sem GDI/desktop real em CI). Exercita o fio ponta a ponta que é o
// objetivo desta task, em vez de só o handler isolado.
func TestCompanionPipeLoop_CaptureScreenshotEndToEnd(t *testing.T) {
	original := captureScreenJPEGFn
	defer func() { captureScreenJPEGFn = original }()
	captureScreenJPEGFn = func(quality int) ([]byte, error) {
		return []byte("fake-jpeg-e2e"), nil
	}

	stopCh := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		listenPipe(handleCompanionPipeMessage, stopCh)
	}()
	defer func() {
		close(stopCh)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("listenPipe não encerrou após stopCh fechado")
		}
	}()

	jpegBytes, err := requestScreenshotFromCompanionFn()
	if err != nil {
		t.Fatalf("requestScreenshotFromCompanionFn: %v", err)
	}
	if !bytes.Equal(jpegBytes, []byte("fake-jpeg-e2e")) {
		t.Errorf("jpegBytes = %q, want %q", jpegBytes, "fake-jpeg-e2e")
	}
}
