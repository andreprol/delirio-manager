package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
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
		// config.json corrompido — tenta recuperar do .tmp (backup pré-rename atômico)
		if tmpData, _ := os.ReadFile(configPath() + ".tmp"); len(tmpData) > 0 {
			tmpCfg := defaultConfig()
			if json.Unmarshal(tmpData, tmpCfg) == nil && tmpCfg.MachineID != "" {
				logWarn("config.json corrompido — recuperado do backup .tmp")
				_ = saveConfig(tmpCfg)
				return tmpCfg, nil
			}
		}
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

// saveConfig grava atomicamente (write tmp → rename) para evitar
// config.json truncado/corrompido em caso de crash durante a escrita.
func saveConfig(cfg *Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := configPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, configPath())
}

func generateUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant RFC 4122
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func defaultConfig() *Config {
	return &Config{
		ServerURL:    "https://dt-manager.brazilsouth.cloudapp.azure.com",
		MachineID:    generateUUID(),
		Token:        "",
		IntervalSecs: 30,
		PollSecs:     10,
	}
}
