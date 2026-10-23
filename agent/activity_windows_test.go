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

func TestBasenameFromPath(t *testing.T) {
	cases := map[string]string{
		`C:\Program Files\DelirioAgent\delirio-agent.exe`: "delirio-agent.exe",
		`C:/Program Files/Google/Chrome/chrome.exe`:        "chrome.exe",
		"notepad.exe":                                      "notepad.exe", // sem separador
	}
	for input, want := range cases {
		got := basenameFromPath(input)
		if got != want {
			t.Errorf("basenameFromPath(%q) = %q, want %q", input, got, want)
		}
	}
}
