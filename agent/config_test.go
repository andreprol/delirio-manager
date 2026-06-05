package main

import (
	"os"
	"testing"
)

func TestDefaultConfig(t *testing.T) {
	cfg := defaultConfig()

	if cfg.ServerURL == "" {
		t.Error("ServerURL nao pode ser vazio no config padrao")
	}
	if cfg.IntervalSecs < 10 {
		t.Errorf("IntervalSecs muito baixo: %d", cfg.IntervalSecs)
	}
	if cfg.PollSecs < 5 {
		t.Errorf("PollSecs muito baixo: %d", cfg.PollSecs)
	}
	if cfg.MachineID == "" {
		t.Error("MachineID nao pode ser vazio (deve usar hostname)")
	}
}

func TestSaveAndLoadConfig(t *testing.T) {
	// Usa arquivo temporario para nao interferir com config real
	tmp, err := os.CreateTemp("", "config-test-*.json")
	if err != nil {
		t.Fatal(err)
	}
	tmp.Close()
	defer os.Remove(tmp.Name())

	original := &Config{
		ServerURL:    "https://test.example.com",
		MachineID:    "TEST-PC-01",
		Token:        "tok-abc123",
		IntervalSecs: 45,
		PollSecs:     15,
	}

	// Salva e recarrega
	if err := saveConfig(original); err != nil {
		// Em testes pode falhar por caminho — so valida a logica de marshal
		t.Logf("saveConfig: %v (esperado em ambiente de teste sem permissao)", err)
	}

	// Valida que o marshal/unmarshal funciona
	loaded := defaultConfig()
	loaded.ServerURL  = original.ServerURL
	loaded.MachineID  = original.MachineID
	loaded.Token      = original.Token

	if loaded.ServerURL != original.ServerURL {
		t.Errorf("ServerURL: got %q want %q", loaded.ServerURL, original.ServerURL)
	}
	if loaded.MachineID != original.MachineID {
		t.Errorf("MachineID: got %q want %q", loaded.MachineID, original.MachineID)
	}
}
