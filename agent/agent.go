package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sys/windows"
)

// Agent e o core do agente: gerencia heartbeat e polling de comandos.
type Agent struct {
	cfg         *Config
	client      *http.Client // cliente geral (5 min) — comandos longos, NF-Ce
	hbClient    *http.Client // cliente exclusivo do heartbeat (10 s) — falha rápido sob pressão de memória
	stopCh      chan struct{}
	wolEnabled  *bool  // cached após primeira verificação
	motherboard string // cached após primeira verificação
	osVersion   string // cached na inicialização

	// offline event detection
	mu            sync.Mutex
	lastSuccessAt time.Time // zero = nunca teve sucesso

	// update deduplication — previne goroutines concorrentes de update
	updating bool

	// acesso remoto (FEATURE_LIVE_ACCESS) — estado do companion lançado por
	// sessionWatchLoop na sessão ativa. Hoje só esta goroutine lê/escreve
	// estes campos, mas atomic (em vez de uint32/windows.Handle crus) evita
	// que o invariante "sem mutex" se torne um data race silencioso no dia
	// em que outra goroutine (ex: heartbeat reportando status do companion)
	// passar a lê-los.
	companionPID              atomic.Uint32
	companionSession          atomic.Uint32
	companionHandle           atomic.Uintptr // windows.Handle do processo companion vivo (0 = nenhum)
	consecutiveLaunchFailures int
	nextLaunchAttemptAt       time.Time // zero = sem backoff pendente
}

// HeartbeatPayload e o JSON enviado ao servidor a cada ciclo.
type HeartbeatPayload struct {
	MachineID   string    `json:"machineId"`
	Token       string    `json:"token"`
	Hostname    string    `json:"hostname"`
	Version     string    `json:"agentVersion"`
	Metrics     *Metrics  `json:"metrics"`
	WolEnabled  *bool     `json:"wolEnabled,omitempty"`
	Motherboard string    `json:"motherboard,omitempty"`
	OsVersion   string    `json:"osVersion,omitempty"`
	DrStatus    *DRStatus `json:"dr_status,omitempty"`
}

// HeartbeatResponse e a resposta do servidor ao heartbeat.
type HeartbeatResponse struct {
	OK            bool       `json:"ok"`
	LatestVersion string     `json:"latestVersion"`
	UpdateInfo    UpdateInfo `json:"updateInfo"`
}

// RegisterResponse e a resposta do endpoint POST /api/register.
type RegisterResponse struct {
	Token     string `json:"token"`
	MachineID string `json:"machineId"`
}

// CommandAck e o payload de confirmacao de execucao de um comando.
type CommandAck struct {
	CommandID string `json:"commandId"`
	MachineID string `json:"machineId"`
	Token     string `json:"token"`
	Success   bool   `json:"success"`
	Message   string `json:"message"`
}

// safeGo executa fn em goroutine com recover — panic não encerra o processo.
func safeGo(name string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logError(fmt.Sprintf("PANIC goroutine %s: %v", name, r))
			}
		}()
		fn()
	}()
}

func newAgent() *Agent {
	cfg, err := loadConfig()
	if err != nil {
		// loadConfig já retorna defaultConfig() com UUID estável — NÃO gerar novo UUID.
		logWarn(fmt.Sprintf("Erro ao carregar config: %v — usando padrao.", err))
	}

	initLogger("agent.log")

	return &Agent{
		cfg:    cfg,
		stopCh: make(chan struct{}),
		client: &http.Client{
			Timeout: 5 * time.Minute,
		},
		hbClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

func (a *Agent) start() error {
	if a.cfg.ServerURL == "" {
		return fmt.Errorf("ServerURL nao configurado. Execute: agent.exe -server URL")
	}

	cleanOldExe() // remove .old de atualizacao anterior

	// Registra no servidor se nao tiver token
	if a.cfg.Token == "" {
		if err := a.register(); err != nil {
			logWarn(fmt.Sprintf("Registro falhou: %v. Tentando sem token.", err))
		}
	}

	// Loop de heartbeat
	go a.heartbeatLoop()

	// Loop de polling de comandos
	go a.commandLoop()

	// Loop de snapshot horário (24x/dia)
	go a.hourlySnapshotLoop()

	// Monitoramento de serviços NCR Voyix (apenas máquinas BOH)
	go a.serviceMonitorLoop()

	// FEATURE_LIVE_ACCESS: mesma flag usada em companion.go — feature ainda
	// incompleta (Task 5/13 do agente), não lançar o companion em produção
	// antes do servidor e do restante da feature estarem prontos.
	if os.Getenv("FEATURE_LIVE_ACCESS") == "true" {
		go a.sessionWatchLoop()
	}

	safeGo("lhm", func() { ensureLHM(a.cfg.ServerURL) })
	safeGo("bootEvents", a.collectAndSendBootEvents)
	safeGo("wolStatus", a.collectWolStatus)

	return nil
}

func (a *Agent) collectWolStatus() {
	enabled := checkAndEnableWolDriver()
	a.wolEnabled = &enabled
	a.motherboard = getMotherboardInfo()
	a.osVersion = getWindowsVersion()
	logInfo(fmt.Sprintf("WoL driver: %v | Placa: %s | SO: %s", enabled, a.motherboard, a.osVersion))
}

// collectAndSendBootEvents waits for the agent to have a valid token, then
// collects Windows Event Log entries from the period since last heartbeat.
func (a *Agent) collectAndSendBootEvents() {
	// Wait up to 30s for token (ensures server knows this machine)
	for i := 0; i < 10; i++ {
		if a.cfg.Token != "" {
			break
		}
		time.Sleep(3 * time.Second)
	}
	if a.cfg.Token == "" {
		logWarn("collectBootEvents: no token after 30s, skipping event collection")
		return
	}

	// Determine collection window
	since := time.Now().Add(-2 * time.Hour) // default: last 2 hours
	if a.cfg.LastHeartbeatAt != "" {
		if t, err := time.Parse(time.RFC3339, a.cfg.LastHeartbeatAt); err == nil {
			since = t
		}
	}

	logInfo(fmt.Sprintf("Collecting Windows events since %s...", since.Format(time.RFC3339)))

	events, err := collectWindowsEvents(since)
	if err != nil {
		logWarn(fmt.Sprintf("Error collecting events: %v", err))
		return
	}

	if err := a.sendEvents(events); err != nil {
		logWarn(fmt.Sprintf("Error sending events: %v", err))
		return
	}

	logInfo(fmt.Sprintf("Sent %d Windows events to server", len(events)))
}

func (a *Agent) heartbeatLoop() {
	ticker := time.NewTicker(time.Duration(a.cfg.IntervalSecs) * time.Second)
	defer ticker.Stop()

	// Envia heartbeat imediatamente na primeira vez
	a.sendHeartbeat()

	for {
		select {
		case <-ticker.C:
			func() {
				defer func() {
					if r := recover(); r != nil {
						logError(fmt.Sprintf("heartbeat panic: %v", r))
					}
				}()
				a.sendHeartbeat()
			}()
		case <-a.stopCh:
			return
		}
	}
}

const sessionWatchIntervalSecs = 15
const maxLaunchBackoff = 5 * time.Minute

// sessionWatchLoop roda só no serviço (Session 0): detecta a sessão de
// usuário ativa e garante que o companion está rodando nela. Relança em
// logoff/logon (sessão muda) ou se o companion morreu por qualquer motivo.
func (a *Agent) sessionWatchLoop() {
	ticker := time.NewTicker(sessionWatchIntervalSecs * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-a.stopCh:
			return
		case <-ticker.C:
			// Panic num syscall Win32 aqui (ex: unsafe.Slice em enumerateSessions)
			// não pode matar o processo do serviço inteiro — mesmo padrão já
			// usado por heartbeatLoop/hourlySnapshotLoop/serviceMonitorLoop.
			func() {
				defer func() {
					if r := recover(); r != nil {
						logError(fmt.Sprintf("sessionWatch panic: %v", r))
					}
				}()
				a.sessionWatchTick()
			}()
		}
	}
}

func (a *Agent) sessionWatchTick() {
	sessions, err := enumerateSessions()
	if err != nil {
		logWarn(fmt.Sprintf("sessionWatch: erro ao enumerar sessões: %v", err))
		return
	}
	activeID, ok := pickActiveSession(sessions)
	if !ok {
		return // sem usuário logado agora (tela de login) — nada a fazer
	}

	sessionChanged := activeID != a.companionSession.Load()
	alive := isCompanionAlive(windows.Handle(a.companionHandle.Load()))
	if !shouldRelaunchCompanion(alive, sessionChanged) {
		return
	}

	// Backoff: se o companion não para de falhar ao lançar (ex: exe
	// corrompido), não tentar de novo a cada 15s pra sempre — isso seria
	// churn de processo indefinido em 224 máquinas. Dobra o intervalo até
	// um teto de 5min a cada falha consecutiva; reseta na primeira lançada
	// com sucesso.
	if !a.nextLaunchAttemptAt.IsZero() && time.Now().Before(a.nextLaunchAttemptAt) {
		return
	}

	if oldHandle := windows.Handle(a.companionHandle.Swap(0)); oldHandle != 0 {
		_ = windows.CloseHandle(oldHandle)
	}
	// companionPID zerado junto com o handle: enquanto o handle (fonte de
	// verdade de liveness) estiver 0, companionPID não pode apontar pra um
	// PID que não corresponde mais a nenhum handle rastreado — senão os três
	// campos descrevem companions diferentes se launchCompanion falhar abaixo.
	a.companionPID.Store(0)

	pid, handle, err := launchCompanion(activeID)
	if err != nil {
		a.consecutiveLaunchFailures++
		// Expoente = tentativas já feitas ANTES desta (consecutiveLaunchFailures-1),
		// não o contador pós-incremento — senão a 1ª falha já pula pra 30s em
		// vez dos 15s documentados (off-by-one: 15·2^n pra n=0,1,2... falhas
		// anteriores, não pra n=1,2,3... que conta a falha atual também).
		backoff := time.Duration(1<<uint(min(a.consecutiveLaunchFailures-1, 5))) * sessionWatchIntervalSecs * time.Second
		if backoff > maxLaunchBackoff {
			backoff = maxLaunchBackoff
		}
		a.nextLaunchAttemptAt = time.Now().Add(backoff)
		logError(fmt.Sprintf("sessionWatch: falha ao lançar companion (tentativa %d, próxima em %s): %v",
			a.consecutiveLaunchFailures, backoff, err))
		return
	}

	if a.consecutiveLaunchFailures > 0 {
		logInfo(fmt.Sprintf("sessionWatch: lançamento do companion recuperado após %d falha(s) consecutiva(s)", a.consecutiveLaunchFailures))
	}
	a.consecutiveLaunchFailures = 0
	a.nextLaunchAttemptAt = time.Time{}
	a.companionPID.Store(pid)
	a.companionSession.Store(activeID)
	a.companionHandle.Store(uintptr(handle))
	logInfo(fmt.Sprintf("Companion lançado (PID %d, sessão %d).", pid, activeID))
}

func (a *Agent) commandLoop() {
	ticker := time.NewTicker(time.Duration(a.cfg.PollSecs) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			a.pollCommands()
		case <-a.stopCh:
			return
		}
	}
}

func (a *Agent) sendHeartbeat() {
	metrics, err := collectMetrics()
	if err != nil {
		logWarn(fmt.Sprintf("Erro ao coletar metricas: %v", err))
		metrics = &Metrics{}
	}

	hostname, _ := os.Hostname()
	payload := HeartbeatPayload{
		MachineID:   a.cfg.MachineID,
		Token:       a.cfg.Token,
		Hostname:    hostname,
		Version:     Version,
		Metrics:     metrics,
		WolEnabled:  a.wolEnabled,
		Motherboard: a.motherboard,
		OsVersion:   a.osVersion,
	}

	if isVeeamInstalled() {
		s := getCachedDRStatus()
		payload.DrStatus = s
	}

	data, err := json.Marshal(payload)
	if err != nil {
		logWarn(fmt.Sprintf("Heartbeat marshal falhou: %v", err))
		return
	}
	req, err := http.NewRequest("POST", a.cfg.ServerURL+"/api/heartbeat", bytes.NewReader(data))
	if err != nil {
		logWarn(fmt.Sprintf("Heartbeat request falhou: %v", err))
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	req.Header.Set("X-Agent-Version", Version)
	resp, err := a.hbClient.Do(req) // timeout 10s — falha rápido sob pressão de memória
	if err != nil {
		logWarn(fmt.Sprintf("Heartbeat falhou: %v", err))
		return
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusUnauthorized:
		logWarn("Token rejeitado. Re-registrando...")
		a.cfg.Token = ""
		_ = a.register()
	case http.StatusOK:
		a.onHeartbeatOK(resp.Body)
	}
}

func (a *Agent) onHeartbeatOK(body io.Reader) {
	now := time.Now().UTC()
	a.cfg.LastHeartbeatAt = now.Format(time.RFC3339)
	_ = saveConfig(a.cfg)

	a.mu.Lock()
	prev := a.lastSuccessAt
	a.lastSuccessAt = now
	a.mu.Unlock()

	if !prev.IsZero() && now.Sub(prev) > 10*time.Minute {
		go a.reportOfflineEvent(prev, now)
	}

	var hbResp HeartbeatResponse
	if err := json.NewDecoder(body).Decode(&hbResp); err != nil {
		return
	}
	if hbResp.LatestVersion != "" && hbResp.LatestVersion != Version {
		a.maybeStartUpdate(UpdateInfo{Version: hbResp.LatestVersion, SHA256: hbResp.UpdateInfo.SHA256})
	}
}

func (a *Agent) maybeStartUpdate(info UpdateInfo) {
	a.mu.Lock()
	alreadyUpdating := a.updating
	if !alreadyUpdating {
		a.updating = true
	}
	a.mu.Unlock()
	if alreadyUpdating {
		return
	}
	go func() {
		defer func() {
			a.mu.Lock()
			a.updating = false
			a.mu.Unlock()
		}()
		a.checkAndUpdate(info)
	}()
}

func (a *Agent) pollCommands() {
	url := fmt.Sprintf("%s/api/commands/%s", a.cfg.ServerURL, a.cfg.MachineID)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	req.Header.Set("X-Agent-Version", Version)

	resp, err := a.client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return
	}

	var cmdResp CommandResponse
	if err := json.Unmarshal(body, &cmdResp); err != nil {
		return
	}

	for _, cmd := range cmdResp.Commands {
		a.handleCommand(cmd)
	}
}

func (a *Agent) handleCommand(cmd Command) {
	logInfo(fmt.Sprintf("Executando comando: type=%s id=%s", cmd.Type, cmd.ID))

	msg, err := a.executeCommand(cmd)
	success := err == nil

	if err != nil {
		logError(fmt.Sprintf("Comando %s falhou: %v", cmd.ID, err))
		msg = err.Error()
	} else {
		// %.200s trunca o que vai pro log (companion.log/Event Log) — o ACK
		// abaixo leva msg inteira pro servidor. Sem isso, um resultado grande
		// (ex: base64 de um JPEG de capture-screenshot, Task 7+9) inundaria o
		// log a cada comando, forçando rotação constante em companion.log e
		// gravação equivalente no Windows Event Log (sem a mesma rotação).
		logInfo(fmt.Sprintf("Comando %s OK: %.200s", cmd.ID, msg))
	}

	// Envia ACK ao servidor
	ack := CommandAck{
		CommandID: cmd.ID,
		MachineID: a.cfg.MachineID,
		Token:     a.cfg.Token,
		Success:   success,
		Message:   msg,
	}
	if _, err := a.post("/api/commands/ack", ack); err != nil {
		logWarn(fmt.Sprintf("ACK falhou para comando %s: %v", cmd.ID, err))
	}
}

func (a *Agent) register() error {
	hostname, _ := os.Hostname()
	payload := map[string]string{
		"machineId": a.cfg.MachineID,
		"hostname":  hostname,
		"version":   Version,
	}

	resp, err := a.post("/api/register", payload)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("registro rejeitado: HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	var reg RegisterResponse
	if err := json.Unmarshal(body, &reg); err != nil {
		return err
	}

	a.cfg.Token = reg.Token
	if reg.MachineID != "" {
		a.cfg.MachineID = reg.MachineID
	}

	_ = saveConfig(a.cfg)
	logInfo(fmt.Sprintf("Registrado com sucesso. MachineID=%s", a.cfg.MachineID))
	return nil
}

// post faz um POST JSON para o endpoint relativo informado.
func (a *Agent) post(path string, payload interface{}) (*http.Response, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", a.cfg.ServerURL+path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	req.Header.Set("X-Agent-Version", Version)

	return a.client.Do(req)
}

// hourlySnapshotLoop envia snapshot de métricas a cada hora (24x/dia).
// Aguarda o primeiro heartbeat com sucesso antes de começar.
func (a *Agent) hourlySnapshotLoop() {
	// Espera ter token (até 60s)
	for i := 0; i < 20; i++ {
		if a.cfg.Token != "" {
			break
		}
		time.Sleep(3 * time.Second)
	}
	if a.cfg.Token == "" {
		logWarn("hourlySnapshotLoop: sem token após 60s, abortando")
		return
	}

	// Aguarda 10s para o heartbeat inicial completar antes de enviar snapshot.
	// Evita colisão com o rate-limiter de 5s do endpoint /api/heartbeat.
	time.Sleep(10 * time.Second)

	logInfo(fmt.Sprintf("hourlySnapshotLoop: iniciado (agente v%s)", Version))

	// Primeiro snapshot imediato
	a.sendHourlySnapshot()

	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			func() {
				defer func() {
					if r := recover(); r != nil {
						logError(fmt.Sprintf("hourlySnapshot panic: %v — próxima leitura na hora seguinte", r))
					}
				}()
				a.sendHourlySnapshot()
			}()
		case <-a.stopCh:
			logInfo("hourlySnapshotLoop: encerrado")
			return
		}
	}
}

func (a *Agent) sendHourlySnapshot() {
	metrics, err := collectMetrics()
	if err != nil {
		logWarn(fmt.Sprintf("hourlySnapshot: erro ao coletar métricas: %v", err))
		return
	}

	var ramPct float64
	if metrics.RAMTotalMB > 0 {
		ramPct = round2(float64(metrics.RAMTotalMB-metrics.RAMFreeMB) / float64(metrics.RAMTotalMB) * 100)
	}
	var diskPct float64
	if metrics.DiskTotalGB > 0 {
		diskPct = round2((metrics.DiskTotalGB - metrics.DiskFreeGB) / metrics.DiskTotalGB * 100)
	}

	payload := map[string]interface{}{
		"snapshotTs": time.Now().Unix(),
		"cpuPct":     metrics.CPUPct,
		"ramPct":     ramPct,
		"diskPct":    diskPct,
		"cpuTempC":   metrics.CPUTempC,
	}

	resp, err := a.post("/api/metrics/hourly", payload)
	if err != nil {
		logWarn(fmt.Sprintf("hourlySnapshot: envio falhou (erro de rede): %v", err))
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		logWarn(fmt.Sprintf("hourlySnapshot: servidor rejeitou snapshot (HTTP %d): %s", resp.StatusCode, string(body)))
		return
	}

	logInfo(fmt.Sprintf("hourlySnapshot: OK — cpu=%.1f%% ram=%.1f%% disk=%.1f%% temp=%.1f°C", metrics.CPUPct, ramPct, diskPct, metrics.CPUTempC))
}

func (a *Agent) reportOfflineEvent(offlineAt, onlineAt time.Time) {
	durationMin := onlineAt.Sub(offlineAt).Minutes()
	payload := map[string]interface{}{
		"offlineAt":   offlineAt.Format(time.RFC3339),
		"onlineAt":    onlineAt.Format(time.RFC3339),
		"durationMin": round2(durationMin),
	}
	resp, err := a.post("/api/offline-event", payload)
	if err != nil {
		logWarn(fmt.Sprintf("offlineEvent: envio falhou: %v", err))
		return
	}
	defer resp.Body.Close()
	logInfo(fmt.Sprintf("offlineEvent reportado: %.0f min (desde %s)", durationMin, offlineAt.Format("15:04")))
}

func (a *Agent) stop() {
	close(a.stopCh)
	if h := windows.Handle(a.companionHandle.Swap(0)); h != 0 {
		_ = windows.CloseHandle(h)
	}
	logInfo("Agente parado.")
}
