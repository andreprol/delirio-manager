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

	// FeatureSessionZeroCapture liga/desliga o modo "session-zero" do Acesso
	// Remoto NESTE agente: quando não existe sessão Windows interativa
	// (tela de login, tela de bloqueio, UAC, boot em andamento) — sem
	// isso, start-live-session falha de cara (sessionWatchTick nunca lança
	// o companion sem WTS_ACTIVE/Disconnected reconectável, ver
	// session_windows.go). Com a flag ligada, o PRÓPRIO serviço (já roda
	// como LocalSystem) anexa a thread chamadora à desktop ATIVA no
	// momento (Winlogon/Default/Screen-saver, via OpenInputDesktop+
	// SetThreadDesktop, ver sessiondesktop_windows.go) e assume
	// captura/injeção direto, sem companion. Mesmo padrão de rollout de
	// FeatureLiveAccess (opt-in por máquina, default false, testar 1
	// canário antes de qualquer rollout maior).
	FeatureSessionZeroCapture bool `json:"featureSessionZeroCapture"`
}

// loadConfigReadOnly lê e decodifica config.json sem nenhum efeito colateral
// de escrita (loadConfig faz migração de UUID, recuperação de backup .tmp,
// etc. — todos escrevem no arquivo). Usado pelo companion, que é um
// processo separado do serviço e nunca deve competir com ele escrevendo o
// mesmo config.json; nesse ponto o serviço já terminou seu próprio boot
// (é ele quem lança o companion), então a migração já rodou há muito tempo.
func loadConfigReadOnly() (*Config, error) {
	cfg := defaultConfig()
	// readConfigFileWithRetry (nao os.ReadFile direto): o companion esta
	// sujeito a mesma colisao transiente que motivou o retry em loadConfig
	// (rename atomico externo/lock de antivirus) -- achado MEDIO do
	// code-reviewer, 15/11/2026. Sem efeito colateral de escrita aqui (essa
	// e a garantia que a doc desta funcao promete), so a leitura ganha
	// resiliencia.
	data, err := readConfigFileWithRetry(configPath())
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

// configLoadRetries/configLoadRetryDelay cobrem o boot do serviço colidindo
// com uma escrita externa concorrente no MESMO config.json — achado real de
// 15/11/2026 (incidente session-zero): loadConfig não tinha NENHUM retry na
// leitura inicial, ao contrário de loadFreshConfigWithRetry (usado só pelos
// saves periódicos). Um PowerShell externo editando config.json (rollout de
// feature flag via /api/machines/:id/run) bem na janela entre o
// Move-Item/rename e o antivírus liberar o lock do arquivo, seguido de
// Restart-Service, fazia o processo novo encontrar o arquivo momentaneamente
// ilegível, tratar isso como "primeira execução" (ramo abaixo) e gerar
// machineId+token NOVOS do zero, descartando tanto a identidade quanto a
// edição externa que acabara de chegar — sem erro nenhum visível, silencioso.
// 5 tentativas x 200ms (1s no pior caso) é imperceptível num boot normal mas
// cobre folgado o lock transiente de antivírus/rename concorrente.
const (
	configLoadRetries    = 5
	configLoadRetryDelay = 200 * time.Millisecond
)

// readFileFn: indireção testável de os.ReadFile, mesmo padrão de
// startLiveSessionFn/configStoreImpl já usado neste pacote — var global
// mutável trocada em teste (swapReadFileFn, config_test.go) sem mutex,
// seguro só porque nenhum teste deste pacote usa t.Parallel() (mesma
// ressalva já documentada pra configStoreImpl/swapConfigStore).
var readFileFn = os.ReadFile

// readConfigFileWithRetry tenta ler path até configLoadRetries+1 vezes,
// esperando configLoadRetryDelay entre tentativas — exceto quando o arquivo
// genuinamente não existe (os.IsNotExist), caso em que não há por que
// esperar: não é uma colisão transiente, é mesmo a primeira execução.
func readConfigFileWithRetry(path string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt <= configLoadRetries; attempt++ {
		data, err := readFileFn(path)
		if err == nil {
			return data, nil
		}
		if os.IsNotExist(err) {
			return nil, err
		}
		lastErr = err
		if attempt < configLoadRetries {
			time.Sleep(configLoadRetryDelay)
		}
	}
	return nil, lastErr
}

// handleConfigReadFailure trata o ramo de "readConfigFileWithRetry falhou"
// de loadConfig — extraído só pra reduzir a complexidade ciclomática de
// loadConfig (linter cyclop, max 10 por função), mesmo padrão já usado por
// applyLocalInputLock/dispatchLiveSessionInput neste pacote. Ver os
// comentários originais (antes desta extração) sobre o porquê de cada ramo:
// os.IsNotExist é primeira execução de verdade (persiste default); qualquer
// outro erro é falha transiente que esgotou o retry — achado CRÍTICO do
// code-reviewer, 15/11/2026, NUNCA deve persistir uma identidade nova por
// cima do config.json real só porque ele ficou ilegível por mais tempo que
// o retry cobre (disco com problema, lock mais longo que 1s, etc.).
func handleConfigReadFailure(cfg *Config, err error) (*Config, error) {
	if os.IsNotExist(err) {
		if saveErr := saveConfig(cfg); saveErr != nil {
			logWarn(fmt.Sprintf("loadConfig: falha ao persistir config padrao na primeira execucao: %v", saveErr))
		}
		return cfg, nil
	}
	logWarn(fmt.Sprintf("loadConfig: leitura de config.json falhou mesmo apos %d tentativas (%v) -- NAO sobrescrevendo o arquivo, seguindo em memoria com identidade efemera", configLoadRetries, err))
	return cfg, err
}

func loadConfig() (*Config, error) {
	cfg := defaultConfig()

	data, err := readConfigFileWithRetry(configPath())
	if err != nil {
		return handleConfigReadFailure(cfg, err)
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
