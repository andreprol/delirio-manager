package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)


// Agent e o core do agente: gerencia heartbeat e polling de comandos.
type Agent struct {
	cfg         *Config
	client      *http.Client
	stopCh      chan struct{}
	wolEnabled  *bool  // cached após primeira verificação
	motherboard string // cached após primeira verificação
}

// HeartbeatPayload e o JSON enviado ao servidor a cada ciclo.
type HeartbeatPayload struct {
	MachineID   string   `json:"machineId"`
	Token       string   `json:"token"`
	Hostname    string   `json:"hostname"`
	Version     string   `json:"agentVersion"`
	Metrics     *Metrics `json:"metrics"`
	WolEnabled  *bool    `json:"wolEnabled,omitempty"`
	Motherboard string   `json:"motherboard,omitempty"`
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

func newAgent() *Agent {
	cfg, err := loadConfig()
	if err != nil {
		logWarn(fmt.Sprintf("Erro ao carregar config: %v — usando padrao.", err))
		cfg = defaultConfig()
	}

	initLogger()

	return &Agent{
		cfg:    cfg,
		stopCh: make(chan struct{}),
		client: &http.Client{
			Timeout: 15 * time.Second,
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

	go ensureLHM(a.cfg.ServerURL) // installs and starts LHM for CPU temperature

	go a.collectAndSendBootEvents()

	go a.collectWolStatus()

	return nil
}

func (a *Agent) collectWolStatus() {
	enabled := checkAndEnableWolDriver()
	a.wolEnabled = &enabled
	a.motherboard = getMotherboardInfo()
	logInfo(fmt.Sprintf("WoL driver: %v | Placa: %s", enabled, a.motherboard))
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
			a.sendHeartbeat()
		case <-a.stopCh:
			return
		}
	}
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
	}

	resp, err := a.post("/api/heartbeat", payload)
	if err != nil {
		logWarn(fmt.Sprintf("Heartbeat falhou: %v", err))
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		logWarn("Token rejeitado. Re-registrando...")
		a.cfg.Token = ""
		_ = a.register()
		return
	}

	// Save successful heartbeat timestamp for boot event collection
	if resp.StatusCode == http.StatusOK {
		a.cfg.LastHeartbeatAt = time.Now().UTC().Format(time.RFC3339)
		_ = saveConfig(a.cfg)
	}

	// Verifica se servidor indica nova versao disponivel
	if resp.StatusCode == http.StatusOK {
		var hbResp HeartbeatResponse
		if err := json.NewDecoder(resp.Body).Decode(&hbResp); err == nil {
			if hbResp.LatestVersion != "" && hbResp.LatestVersion != Version {
				go a.checkAndUpdate(UpdateInfo{
					Version: hbResp.LatestVersion,
					SHA256:  hbResp.UpdateInfo.SHA256,
				})
			}
		}
	}
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
		go a.handleCommand(cmd)
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
		logInfo(fmt.Sprintf("Comando %s OK: %s", cmd.ID, msg))
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

func (a *Agent) stop() {
	close(a.stopCh)
	logInfo("Agente parado.")
}
