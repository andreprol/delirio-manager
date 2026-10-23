package main

import "testing"

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
