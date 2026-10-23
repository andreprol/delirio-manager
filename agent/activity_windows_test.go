package main

import "testing"

func TestFriendlyProcessName(t *testing.T) {
	cases := map[string]string{
		"chrome.exe":  "Google Chrome",
		"CHROME.EXE":  "Google Chrome",
		"EXCEL.EXE":   "Excel",
		"notepad.exe": "notepad.exe", // sem mapeamento conhecido: devolve o original
	}
	for input, want := range cases {
		got := friendlyProcessName(input)
		if got != want {
			t.Errorf("friendlyProcessName(%q) = %q, want %q", input, got, want)
		}
	}
}
