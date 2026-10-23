package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
