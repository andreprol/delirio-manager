package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// Config contem todas as configuracoes do agente.
type Config struct {
	ServerURL       string `json:"serverUrl"`
	MachineID       string `json:"machineId"`
	Token           string `json:"token"`
	IntervalSecs    int    `json:"intervalSecs"`
	PollSecs        int    `json:"pollSecs"`
	LastHeartbeatAt string `json:"lastHeartbeatAt"` // RFC3339, empty = first run

	// FeatureLiveAccess liga/desliga Acesso Remoto (Normal/Shadow) NESTE
	// agente — lido do config.json em vez de env var do processo (era
	// os.Getenv("FEATURE_LIVE_ACCESS") até este campo existir). Motivo da
	// troca: env var do serviço Windows não tem mecanismo de rollout pras
	// 224 máquinas (nenhum instalador/script seta isso), e nem propaga pro
	// processo companion sozinha (CreateProcessAsUser não herda o ambiente
	// do serviço) — exigia injectFeatureFlagIntoEnvBlock (removido,
	// session_windows.go) só pra replicar o valor. config.json já é lido
	// por ambos os processos (serviço via loadConfig, companion via
	// loadConfigReadOnly) direto do disco, então os dois sempre concordam
	// sem nenhuma propagação manual. Default false (zero value) — rollout
	// é opt-in por máquina, igual o comportamento atual.
	FeatureLiveAccess bool `json:"featureLiveAccess"`
}

// loadConfigReadOnly lê e decodifica config.json sem nenhum efeito colateral
// de escrita (loadConfig faz migração de UUID, recuperação de backup .tmp,
// etc. — todos escrevem no arquivo). Usado pelo companion, que é um
// processo separado do serviço e nunca deve competir com ele escrevendo o
// mesmo config.json; nesse ponto o serviço já terminou seu próprio boot
// (é ele quem lança o companion), então a migração já rodou há muito tempo.
func loadConfigReadOnly() (*Config, error) {
	cfg := defaultConfig()
	data, err := os.ReadFile(configPath())
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
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

	// Auto-migra machineId baseado em hostname (pré-v1.5.18) para UUID v4.
	// Ocorre silenciosamente no próximo restart/update — sem intervenção manual.
	if !isUUIDv4(cfg.MachineID) {
		logWarn(fmt.Sprintf("machineId não-UUID detectado (%s) — migrando para UUID v4", cfg.MachineID))
		cfg.MachineID = generateUUID()
		cfg.Token = ""
		_ = saveConfig(cfg)
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

// configStore isola o I/O de disco de saveConfigPreservingDiskEdits —
// permite um fake em memória nos testes pra reproduzir determinística o
// cenário que causou o incidente de 29/10/2026 (edição externa chegando
// bem entre a releitura e a gravação), sem depender de I/O real nem de
// timing de corrida de verdade.
type configStore interface {
	LoadReadOnly() (*Config, error)
	Save(cfg *Config) error
}

type fileConfigStore struct{}

func (fileConfigStore) LoadReadOnly() (*Config, error) { return loadConfigReadOnly() }
func (fileConfigStore) Save(cfg *Config) error         { return saveConfig(cfg) }

// configStoreImpl é var (não const) pra ser substituível em teste — mesmo
// padrão de captureScreenJPEGFn/startLiveSessionFn já usado neste pacote.
var configStoreImpl configStore = fileConfigStore{}

// diskReadRetries/diskReadRetryDelay cobrem o caso comum de releitura
// colidir com o os.Rename atômico de OUTRO processo escrevendo o mesmo
// config.json nesse instante (ex: o PowerShell externo do rollout) — é
// transiente por natureza, uma pequena espera resolve na enorme maioria
// das vezes sem precisar desistir e cair pro snapshot em memória.
const (
	diskReadRetries    = 2
	diskReadRetryDelay = 50 * time.Millisecond
)

func loadFreshConfigWithRetry() (*Config, error) {
	var lastErr error
	for attempt := 0; attempt <= diskReadRetries; attempt++ {
		fresh, err := configStoreImpl.LoadReadOnly()
		if err == nil {
			return fresh, nil
		}
		lastErr = err
		if attempt < diskReadRetries {
			time.Sleep(diskReadRetryDelay)
		}
	}
	return nil, lastErr
}

// saveConfigPreservingDiskEdits salva só os campos que apply muda, por cima
// do config.json ATUAL do disco (relido na hora) — não do fallback (cfg,
// snapshot em memória carregado 1x no boot do processo). Sem isto, toda
// chamada periódica a saveConfig(a.cfg) (ex: onHeartbeatOK, a cada
// ~30s) regrava a struct INTEIRA com valores potencialmente obsoletos,
// apagando qualquer edição externa feita nesse meio tempo — ex:
// pollSecs/featureLiveAccess via POST /api/machines/:id/run, o mecanismo
// usado em todo rollout em massa deste projeto (26/10 featureLiveAccess,
// 29/10 pollSecs). Achado 29/10/2026: rollout de pollSecs reiniciava o
// serviço certo, mas o heartbeat da instância ANTIGA às vezes regravava
// pollSecs:10 por cima da escrita externa um instante antes do kill,
// fazendo a instância NOVA reler o valor já clobado — a mudança parecia
// nunca ter acontecido, sem nenhum erro reportado em lugar nenhum (achado
// repetido aqui, agora com log: antes a falha de releitura E de gravação
// eram descartadas em silêncio igual o bug original que isto conserta).
//
// Se a releitura falhar mesmo após retry, cai pro snapshot em memória
// (fallback) — igual o comportamento de antes desta função existir, só que
// agora avisado via logWarn em vez de silencioso.
func saveConfigPreservingDiskEdits(fallback *Config, apply func(fresh *Config)) error {
	cfg, err := loadFreshConfigWithRetry()
	if err != nil {
		logWarn(fmt.Sprintf("saveConfigPreservingDiskEdits: releitura do disco falhou (%v) — usando snapshot em memória, pode sobrescrever edição externa concorrente", err))
		cfg = fallback
	}
	apply(cfg)
	if err := configStoreImpl.Save(cfg); err != nil {
		logError(fmt.Sprintf("saveConfigPreservingDiskEdits: gravação falhou: %v", err))
		return err
	}
	return nil
}

var uuidV4Re = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// isUUIDv4 verifica se s tem formato UUID v4 lowercase.
func isUUIDv4(s string) bool {
	return uuidV4Re.MatchString(s)
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
