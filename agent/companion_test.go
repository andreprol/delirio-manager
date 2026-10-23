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
