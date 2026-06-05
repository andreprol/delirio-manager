package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Config contem todas as configuracoes do agente.
type Config struct {
	ServerURL       string `json:"serverUrl"`
	MachineID       string `json:"machineId"`
	Token           string `json:"token"`
	IntervalSecs    int    `json:"intervalSecs"`
	PollSecs        int    `json:"pollSecs"`
	LastHeartbeatAt string `json:"lastHeartbeatAt"` // RFC3339, empty = first run
}

// configPath retorna o caminho do config.json no mesmo diretorio do .exe
func configPath() string {
	exe, err := os.Executable()
	if err != nil {
		return "config.json"
	}
	return filepath.Join(filepath.Dir(exe), "config.json")
}

func loadConfig() (*Config, error) {
	cfg := defaultConfig()

	data, err := os.ReadFile(configPath())
	if err != nil {
		// Primeira execucao: salva config padrao
		_ = saveConfig(cfg)
		return cfg, nil
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return cfg, err
	}

	// Garante valores minimos
	if cfg.IntervalSecs < 10 {
		cfg.IntervalSecs = 30
	}
	if cfg.PollSecs < 5 {
		cfg.PollSecs = 10
	}

	return cfg, nil
}

func saveConfig(cfg *Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(), data, 0600)
}

func defaultConfig() *Config {
	hostname, _ := os.Hostname()
	return &Config{
		ServerURL:    "https://dt-manager.brazilsouth.cloudapp.azure.com",
		MachineID:    hostname,
		Token:        "",
		IntervalSecs: 30,
		PollSecs:     10,
	}
}
