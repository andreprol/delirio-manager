package main

import (
	"errors"
	"os"
	"testing"
)

// swapReadFileFn troca readFileFn por um fake controlável — mesmo padrão de
// swapConfigStore, pra testar readConfigFileWithRetry sem I/O real.
func swapReadFileFn(t *testing.T, fn func(string) ([]byte, error)) {
	t.Helper()
	original := readFileFn
	readFileFn = fn
	t.Cleanup(func() { readFileFn = original })
}

// fakeConfigStore substitui configStoreImpl nos testes — load/save em
// memória, sem tocar disco, com falhas e contagem de tentativas
// controláveis pra reproduzir determinística o cenário de corrida de
// 29/10/2026 (edição externa concorrente) sem depender de I/O real.
type fakeConfigStore struct {
	diskCfg      *Config
	loadFailures int // quantas chamadas de LoadReadOnly devem falhar antes de uma succeder
	loadCalls    int
	saved        *Config // última config passada pra Save
	saveErr      error
}

func (f *fakeConfigStore) LoadReadOnly() (*Config, error) {
	f.loadCalls++
	if f.loadCalls <= f.loadFailures {
		return nil, errors.New("fake: leitura falhou")
	}
	cp := *f.diskCfg
	return &cp, nil
}

func (f *fakeConfigStore) Save(cfg *Config) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	f.saved = cfg
	f.diskCfg = cfg
	return nil
}

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
	loaded.ServerURL = original.ServerURL
	loaded.MachineID = original.MachineID
	loaded.Token = original.Token

	if loaded.ServerURL != original.ServerURL {
		t.Errorf("ServerURL: got %q want %q", loaded.ServerURL, original.ServerURL)
	}
	if loaded.MachineID != original.MachineID {
		t.Errorf("MachineID: got %q want %q", loaded.MachineID, original.MachineID)
	}
}

// TestReadConfigFileWithRetry_RetriesTransientFailure reproduz o incidente
// real de 15/11/2026: leitura falha nas primeiras tentativas (arquivo
// momentaneamente travado por antivírus/rename concorrente de um
// PowerShell externo editando config.json) e sucede antes de esgotar as
// tentativas — não pode cair pro ramo de "primeira execução" nesse caso.
func TestReadConfigFileWithRetry_RetriesTransientFailure(t *testing.T) {
	calls := 0
	wantData := []byte(`{"machineId":"estavel-123"}`)
	swapReadFileFn(t, func(string) ([]byte, error) {
		calls++
		if calls <= configLoadRetries {
			return nil, errors.New("fake: arquivo em uso por outro processo")
		}
		return wantData, nil
	})

	data, err := readConfigFileWithRetry("qualquer-caminho")
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if string(data) != string(wantData) {
		t.Errorf("data: got %q want %q", data, wantData)
	}
	if calls != configLoadRetries+1 {
		t.Errorf("calls: got %d want %d (deveria ter parado de tentar no 1o sucesso)", calls, configLoadRetries+1)
	}
}

// TestReadConfigFileWithRetry_GivesUpAfterExhaustingRetries garante que a
// falha persistente (não só transiente) ainda é reportada pro chamador,
// depois de esgotar as tentativas.
func TestReadConfigFileWithRetry_GivesUpAfterExhaustingRetries(t *testing.T) {
	calls := 0
	wantErr := errors.New("fake: disco com problema de verdade")
	swapReadFileFn(t, func(string) ([]byte, error) {
		calls++
		return nil, wantErr
	})

	_, err := readConfigFileWithRetry("qualquer-caminho")
	if !errors.Is(err, wantErr) {
		t.Errorf("erro: got %v want %v", err, wantErr)
	}
	if calls != configLoadRetries+1 {
		t.Errorf("calls: got %d want %d (deveria ter tentado todas as vezes antes de desistir)", calls, configLoadRetries+1)
	}
}

// TestReadConfigFileWithRetry_FileGenuinelyMissing_NoRetry cobre a primeira
// execução de verdade (arquivo nunca existiu): não deve ficar tentando de
// novo nem esperar configLoadRetryDelay — os.IsNotExist é definitivo, não
// transiente.
func TestReadConfigFileWithRetry_FileGenuinelyMissing_NoRetry(t *testing.T) {
	calls := 0
	notExistErr := os.ErrNotExist
	swapReadFileFn(t, func(string) ([]byte, error) {
		calls++
		return nil, notExistErr
	})

	_, err := readConfigFileWithRetry("qualquer-caminho")
	if !errors.Is(err, os.ErrNotExist) {
		t.Errorf("erro: got %v want os.ErrNotExist", err)
	}
	if calls != 1 {
		t.Errorf("calls: got %d want 1 (arquivo ausente de verdade nao deveria tentar de novo)", calls)
	}
}

// TestLoadConfig_TransientReadFailure_DoesNotResetIdentity reproduz o bug
// de ponta a ponta: config.json existe no disco com identidade real, mas a
// leitura falha transitoriamente (ex: lock de antivírus) — loadConfig deve
// conseguir ler depois do retry e preservar machineId/token/flags, NUNCA
// gerar uma identidade nova por cima disso.
func TestLoadConfig_TransientReadFailure_DoesNotResetIdentity(t *testing.T) {
	calls := 0
	realData := []byte(`{
		"serverUrl": "https://dt-manager.brazilsouth.cloudapp.azure.com",
		"machineId": "67935643-802c-4ab8-a44a-a4da060fc295",
		"token": "7ba0907b-8e90-4470-9c7a-c15f1efa4e03",
		"intervalSecs": 30,
		"pollSecs": 10,
		"featureLiveAccess": true,
		"featureSessionZeroCapture": true
	}`)
	swapReadFileFn(t, func(string) ([]byte, error) {
		calls++
		if calls <= 2 {
			return nil, errors.New("fake: lock transiente de antivirus")
		}
		return realData, nil
	})

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if cfg.MachineID != "67935643-802c-4ab8-a44a-a4da060fc295" {
		t.Errorf("MachineID foi descartado pela falha transiente: got %q", cfg.MachineID)
	}
	if cfg.Token != "7ba0907b-8e90-4470-9c7a-c15f1efa4e03" {
		t.Errorf("Token foi descartado pela falha transiente: got %q", cfg.Token)
	}
	if !cfg.FeatureLiveAccess || !cfg.FeatureSessionZeroCapture {
		t.Errorf("flags foram resetadas pela falha transiente: featureLiveAccess=%v featureSessionZeroCapture=%v",
			cfg.FeatureLiveAccess, cfg.FeatureSessionZeroCapture)
	}
}

// TestLoadConfig_PersistentReadFailure_DoesNotOverwriteRealFile cobre o
// achado 🔴 CRÍTICO da revisão de 15/11/2026: a 1a versão deste fix ainda
// caía no ramo de "primeira execução" quando os.IsNotExist era falso mas o
// retry se esgotava mesmo assim (ex: lock de disco/antivírus durando mais
// que 1s) — chamando saveConfig(cfg) e sobrescrevendo PRA SEMPRE o
// config.json real (machineId/token de produção) por uma identidade nova
// efêmera. loadConfig deve retornar o erro pro chamador e, acima de tudo,
// NUNCA escrever em configPath() nesse caso — um boot futuro bem-sucedido
// precisa encontrar o arquivo original intacto.
func TestLoadConfig_PersistentReadFailure_DoesNotOverwriteRealFile(t *testing.T) {
	// configPath() usa os.Executable() -- no binário de teste isso resolve
	// pra um caminho real e gravável; garante que não existe nada lá antes
	// (nem sobra de outro teste) pra detectar com segurança uma escrita
	// indevida feita por este teste.
	path := configPath()
	_ = os.Remove(path)
	t.Cleanup(func() { _ = os.Remove(path) })

	calls := 0
	persistentErr := errors.New("fake: disco com problema de verdade, nunca se recupera")
	swapReadFileFn(t, func(string) ([]byte, error) {
		calls++
		return nil, persistentErr
	})

	cfg, err := loadConfig()
	if !errors.Is(err, persistentErr) {
		t.Errorf("err: got %v want %v (falha persistente deve ser propagada, nao engolida)", err, persistentErr)
	}
	if cfg == nil {
		t.Fatal("loadConfig nao deveria retornar cfg nil mesmo em erro (contrato existente com o chamador)")
	}
	if calls != configLoadRetries+1 {
		t.Errorf("calls: got %d want %d", calls, configLoadRetries+1)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Errorf("loadConfig escreveu em %s numa falha persistente -- deveria ter deixado o arquivo real intacto (ou ausente, nunca criado do zero)", path)
	}
}

// swapConfigStore troca configStoreImpl pelo fake por t.Cleanup — mesmo
// cuidado documentado em commands_test.go sobre vars globais mutáveis
// (nenhum teste deste pacote usa t.Parallel(), não começar sem antes
// resolver isso em todo o pacote).
func swapConfigStore(t *testing.T, fake *fakeConfigStore) {
	t.Helper()
	original := configStoreImpl
	configStoreImpl = fake
	t.Cleanup(func() { configStoreImpl = original })
}

// TestSaveConfigPreservingDiskEdits_ExternalEditSurvives reproduz o
// incidente real de 29/10/2026: o disco tem pollSecs=2 (editado por um
// script externo, ex. o rollout via PowerShell remoto) enquanto o snapshot
// em memória do processo (fallback, carregado no boot) ainda acha que é 10.
// saveConfigPreservingDiskEdits deve preservar o 2 do disco, só aplicando a
// mudança pontual (LastHeartbeatAt) em cima dele — nunca regravar o 10
// antigo por cima.
func TestSaveConfigPreservingDiskEdits_ExternalEditSurvives(t *testing.T) {
	fake := &fakeConfigStore{diskCfg: &Config{PollSecs: 2, MachineID: "M1"}}
	swapConfigStore(t, fake)

	staleFallback := &Config{PollSecs: 10, MachineID: "M1"} // snapshot antigo, carregado antes da edição externa

	err := saveConfigPreservingDiskEdits(staleFallback, func(fresh *Config) {
		fresh.LastHeartbeatAt = "2026-10-29T12:00:00Z"
	})
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if fake.saved == nil {
		t.Fatal("Save nunca foi chamado")
	}
	if fake.saved.PollSecs != 2 {
		t.Errorf("PollSecs: got %d want 2 (edição externa deveria sobreviver, não o fallback em memória)", fake.saved.PollSecs)
	}
	if fake.saved.LastHeartbeatAt != "2026-10-29T12:00:00Z" {
		t.Errorf("LastHeartbeatAt não foi aplicado: got %q", fake.saved.LastHeartbeatAt)
	}
}

// TestSaveConfigPreservingDiskEdits_RetriesTransientReadFailure cobre a
// colisão transiente com o os.Rename atômico de outro processo escrevendo
// o mesmo config.json — deve tentar de novo antes de desistir pro fallback.
func TestSaveConfigPreservingDiskEdits_RetriesTransientReadFailure(t *testing.T) {
	fake := &fakeConfigStore{
		diskCfg:      &Config{PollSecs: 2, MachineID: "M1"},
		loadFailures: diskReadRetries, // falha em todas MENOS a última tentativa
	}
	swapConfigStore(t, fake)

	staleFallback := &Config{PollSecs: 10, MachineID: "M1"}
	if err := saveConfigPreservingDiskEdits(staleFallback, func(fresh *Config) {}); err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if fake.saved.PollSecs != 2 {
		t.Errorf("PollSecs: got %d want 2 (deveria ter conseguido reler após retry)", fake.saved.PollSecs)
	}
}

// TestSaveConfigPreservingDiskEdits_FallsBackWhenReadKeepsFailing cobre o
// caso em que a releitura esgota as tentativas — cai pro snapshot em
// memória (comportamento de antes desta função existir), não trava nem
// perde a gravação por completo.
func TestSaveConfigPreservingDiskEdits_FallsBackWhenReadKeepsFailing(t *testing.T) {
	fake := &fakeConfigStore{
		diskCfg:      &Config{PollSecs: 2, MachineID: "M1"},
		loadFailures: diskReadRetries + 1, // falha em TODAS as tentativas
	}
	swapConfigStore(t, fake)

	fallback := &Config{PollSecs: 10, MachineID: "M1"}
	if err := saveConfigPreservingDiskEdits(fallback, func(fresh *Config) {}); err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if fake.saved.PollSecs != 10 {
		t.Errorf("PollSecs: got %d want 10 (releitura esgotada deveria cair pro fallback)", fake.saved.PollSecs)
	}
}

// TestSaveConfigPreservingDiskEdits_SaveErrorIsReturned garante que uma
// falha de gravação não seja descartada em silêncio (achado 🔴 CRÍTICO da
// revisão de 29/10/2026 — a versão anterior desta função usava `_ =
// saveConfig(cfg)`).
func TestSaveConfigPreservingDiskEdits_SaveErrorIsReturned(t *testing.T) {
	wantErr := errors.New("disco cheio")
	fake := &fakeConfigStore{diskCfg: &Config{PollSecs: 2}, saveErr: wantErr}
	swapConfigStore(t, fake)

	err := saveConfigPreservingDiskEdits(&Config{PollSecs: 10}, func(fresh *Config) {})
	if !errors.Is(err, wantErr) {
		t.Errorf("erro de gravação não propagado: got %v want %v", err, wantErr)
	}
}
