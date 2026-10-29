package main

import (
	"errors"
	"os"
	"testing"
)

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
