package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Command representa um comando recebido do servidor.
type Command struct {
	ID     string          `json:"id"`
	Type   string          `json:"type"`
	Params json.RawMessage `json:"params"`
}

// CommandResponse e a resposta do endpoint GET /api/commands/:machineId
type CommandResponse struct {
	Commands []Command `json:"commands"`
}

// WoLParams contem os parametros do comando wake-on-lan.
type WoLParams struct {
	MAC       string `json:"mac"`
	Broadcast string `json:"broadcast"`
}

// executeCommand despacha o comando para o handler registrado.
func (a *Agent) executeCommand(cmd Command) (string, error) {
	handler, ok := a.commandHandlers()[cmd.Type]
	if !ok {
		return "", fmt.Errorf("tipo de comando desconhecido: %q", cmd.Type)
	}
	return handler(cmd)
}

// commandHandlers retorna o mapa de tipo → handler. Handlers que precisam do
// Agent são métodos ligados; os demais são funções standalone.
func (a *Agent) commandHandlers() map[string]func(Command) (string, error) {
	return map[string]func(Command) (string, error){
		"reboot":                 handleReboot,
		"shutdown":               handleShutdown,
		"cancel-shutdown":        handleCancelShutdown,
		"wol":                    handleWoL,
		"uninstall":              handleUninstall,
		"update":                 a.handleUpdate,
		"aloha-scan":             handleAlohaScan,
		"aloha-list-nfce-months": handleAlohaListNFCeMonths,
		"aloha-index-nfce-day":   handleAlohaIndexNFCeDay,
		"aloha-find-nfce":        handleAlohaFindNFCe,
		"dr-setup":               a.handleDRSetup,
		"dr-backup-now":          handleDRBackupNow,
		"dr-status":              handleDRStatus,
		"run_powershell":         handleRunPowershell,
		"get_agent_log":          handleGetAgentLog,
	}
}

// ── Comandos de sistema ───────────────────────────────────────────────────────

func handleReboot(cmd Command) (string, error) {
	logInfo(fmt.Sprintf("Comando REBOOT recebido (ID: %s). Reinicio em 30s.", cmd.ID))
	if err := runShutdown("/r", 30); err != nil {
		return "", fmt.Errorf("reboot falhou: %w", err)
	}
	return "Reboot agendado em 30 segundos.", nil
}

func handleShutdown(cmd Command) (string, error) {
	logInfo(fmt.Sprintf("Comando SHUTDOWN recebido (ID: %s). Desligamento em 30s.", cmd.ID))
	if err := runShutdown("/s", 30); err != nil {
		return "", fmt.Errorf("shutdown falhou: %w", err)
	}
	return "Shutdown agendado em 30 segundos.", nil
}

func handleCancelShutdown(_ Command) (string, error) {
	if err := exec.Command("shutdown", "/a").Run(); err != nil {
		return "", fmt.Errorf("cancelar shutdown falhou: %w", err)
	}
	logInfo("Shutdown/reboot cancelado.")
	return "Shutdown cancelado.", nil
}

func handleUninstall(cmd Command) (string, error) {
	logInfo(fmt.Sprintf("Comando UNINSTALL recebido (ID: %s). Desinstalando agente...", cmd.ID))
	go func() {
		time.Sleep(2 * time.Second) // aguarda ACK ser enviado antes de encerrar
		exePath, _ := os.Executable()
		installDir := filepath.Dir(exePath)
		_ = uninstallService()
		// Deleta a pasta apos o processo encerrar (processo atual segura o exe)
		exec.Command("cmd", "/c", //nolint:errcheck
			fmt.Sprintf(`timeout /t 4 /nobreak >nul && rmdir /s /q "%s"`, installDir),
		).Start() //nolint:errcheck
		os.Exit(0)
	}()
	return "Desinstalando agente. Maquina sera removida em instantes.", nil
}

// ── Atualização ───────────────────────────────────────────────────────────────

func (a *Agent) handleUpdate(cmd Command) (string, error) {
	var params struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
	}
	if err := json.Unmarshal(cmd.Params, &params); err != nil || params.Version == "" {
		return "", fmt.Errorf("params de update invalidos")
	}
	logInfo(fmt.Sprintf("Comando UPDATE: versao alvo %s", params.Version))
	// Goroutine para enviar ACK antes de encerrar o processo
	go a.checkAndUpdate(UpdateInfo{Version: params.Version, SHA256: params.SHA256})
	return fmt.Sprintf("Iniciando atualizacao para v%s", params.Version), nil
}

// ── Wake-on-LAN ───────────────────────────────────────────────────────────────

func handleWoL(cmd Command) (string, error) {
	var params WoLParams
	if err := json.Unmarshal(cmd.Params, &params); err != nil {
		return "", fmt.Errorf("params WoL invalidos: %w", err)
	}
	if params.Broadcast == "" {
		params.Broadcast = localBroadcast()
	}
	logInfo(fmt.Sprintf("Comando WOL: MAC=%s broadcast=%s", params.MAC, params.Broadcast))
	if err := sendMagicPacket(params.MAC, params.Broadcast); err != nil {
		return "", fmt.Errorf("WoL falhou: %w", err)
	}
	return fmt.Sprintf("Magic packet enviado para %s", params.MAC), nil
}

// ── Aloha / NF-Ce ─────────────────────────────────────────────────────────────

func handleAlohaScan(cmd Command) (string, error) {
	logInfo(fmt.Sprintf("Comando ALOHA-SCAN recebido (ID: %s). Escaneando C:\\Bootdrv...", cmd.ID))
	data, err := json.Marshal(scanAloha())
	if err != nil {
		return "", fmt.Errorf("erro ao serializar scan Aloha: %w", err)
	}
	return string(data), nil
}

func handleAlohaListNFCeMonths(_ Command) (string, error) {
	logInfo("Comando ALOHA-LIST-NFCE-MONTHS recebido")
	data, err := json.Marshal(listNFCeMonths())
	if err != nil {
		return "", fmt.Errorf("erro ao serializar meses NF-Ce: %w", err)
	}
	return string(data), nil
}

func handleAlohaIndexNFCeDay(cmd Command) (string, error) {
	var params struct {
		Month string `json:"month"` // "YYYY-MM"
		Day   string `json:"day"`   // "01"
	}
	if err := json.Unmarshal(cmd.Params, &params); err != nil {
		return "", fmt.Errorf("params aloha-index-nfce-day invalidos: %w", err)
	}
	if params.Month == "" || params.Day == "" {
		return "", fmt.Errorf("month e day obrigatorios")
	}
	logInfo(fmt.Sprintf("Comando ALOHA-INDEX-NFCE-DAY: month=%s day=%s", params.Month, params.Day))
	s, err := nfceRecordToJSON(indexNFCeDay(params.Month, params.Day))
	if err != nil {
		return "", fmt.Errorf("erro ao serializar index NF-Ce: %w", err)
	}
	return s, nil
}

func handleAlohaFindNFCe(cmd Command) (string, error) {
	var params FindNFCeParams
	if err := json.Unmarshal(cmd.Params, &params); err != nil {
		return "", fmt.Errorf("params aloha-find-nfce invalidos: %w", err)
	}
	if params.Date == "" {
		return "", fmt.Errorf("aloha-find-nfce: date obrigatorio")
	}
	logInfo(fmt.Sprintf("Comando ALOHA-FIND-NFCE: date=%s total=%.2f", params.Date, params.Total))
	data, err := json.Marshal(findNFCeForOrder(params))
	if err != nil {
		return "", fmt.Errorf("erro ao serializar resultado find-nfce: %w", err)
	}
	return string(data), nil
}

// ── Disaster Recovery ─────────────────────────────────────────────────────────

func (a *Agent) handleDRSetup(cmd Command) (string, error) {
	var creds DrCreds
	if err := json.Unmarshal(cmd.Params, &creds); err != nil {
		return "", fmt.Errorf("params dr-setup inválidos: %w", err)
	}
	if creds.AzureAccount == "" || creds.SASToken == "" {
		return "", fmt.Errorf("dr-setup: azure_account e sas_token obrigatórios")
	}
	logInfo(fmt.Sprintf("DR-SETUP recebido (cmd %s). Instalando Veeam...", cmd.ID))
	if err := installVeeam(a.cfg.ServerURL); err != nil {
		invalidateDRCache()
		return "", fmt.Errorf("installVeeam: %w", err)
	}
	logInfo("DR-SETUP: Veeam instalado. Configurando job...")
	if err := configureJob(creds); err != nil {
		invalidateDRCache()
		return "", fmt.Errorf("configureJob: %w", err)
	}
	invalidateDRCache()
	s := readStatus()
	drStatusCache = &s
	result, _ := json.Marshal(map[string]interface{}{
		"veeam_version": s.VeeamVersion,
		"setup_ok":      true,
	})
	return string(result), nil
}

func handleDRBackupNow(cmd Command) (string, error) {
	logInfo(fmt.Sprintf("DR-BACKUP-NOW recebido (cmd %s)", cmd.ID))
	if err := triggerBackupNow(); err != nil {
		return "", fmt.Errorf("triggerBackupNow: %w", err)
	}
	invalidateDRCache()
	return `{"job_started":true}`, nil
}

func handleDRStatus(cmd Command) (string, error) {
	logInfo(fmt.Sprintf("DR-STATUS recebido (cmd %s)", cmd.ID))
	invalidateDRCache()
	s := readStatus()
	drStatusCache = &s
	data, err := json.Marshal(s)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ── Execução remota ───────────────────────────────────────────────────────────

func handleRunPowershell(cmd Command) (string, error) {
	var params struct {
		Script string `json:"script"`
	}
	if err := json.Unmarshal(cmd.Params, &params); err != nil || strings.TrimSpace(params.Script) == "" {
		return "", fmt.Errorf("run_powershell: parametro 'script' obrigatorio")
	}
	logInfo(fmt.Sprintf("Comando RUN_POWERSHELL recebido (ID: %s). Script: %.80s", cmd.ID, params.Script))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx,
		"powershell.exe", "-NonInteractive", "-NoProfile", "-Command", params.Script,
	).CombinedOutput()
	output := strings.TrimSpace(string(out))
	if len(output) > 8000 {
		output = output[:8000] + "\n[truncado]"
	}
	if err != nil {
		return output, fmt.Errorf("powershell saiu com erro: %w", err)
	}
	return output, nil
}

func handleGetAgentLog(cmd Command) (string, error) {
	var params struct {
		Lines int `json:"lines"`
	}
	_ = json.Unmarshal(cmd.Params, &params)
	if params.Lines <= 0 || params.Lines > 500 {
		params.Lines = 100
	}
	logInfo(fmt.Sprintf("Comando GET_AGENT_LOG recebido (ID: %s). Últimas %d linhas.", cmd.ID, params.Lines))
	if logFilePath == "" {
		return "", fmt.Errorf("get_agent_log: logger não inicializado")
	}
	raw, err := os.ReadFile(logFilePath)
	if err != nil {
		return "", fmt.Errorf("get_agent_log: %w", err)
	}
	logLines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(logLines) > params.Lines {
		logLines = logLines[len(logLines)-params.Lines:]
	}
	return strings.Join(logLines, "\n"), nil
}

// ── Utilitários ───────────────────────────────────────────────────────────────

func runShutdown(flag string, delaySecs int) error {
	args := []string{flag, "/t", fmt.Sprintf("%d", delaySecs), "/c", "Delirio Manager: manutencao remota"}
	return exec.Command("shutdown", args...).Run()
}
