package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

// executeCommand processa um comando recebido do servidor.
// E um metodo do Agent para ter acesso ao cfg e ao updater.
func (a *Agent) executeCommand(cmd Command) (string, error) {
	switch cmd.Type {

	case "reboot":
		logInfo(fmt.Sprintf("Comando REBOOT recebido (ID: %s). Reinicio em 30s.", cmd.ID))
		if err := runShutdown("/r", 30); err != nil {
			return "", fmt.Errorf("reboot falhou: %w", err)
		}
		return "Reboot agendado em 30 segundos.", nil

	case "shutdown":
		logInfo(fmt.Sprintf("Comando SHUTDOWN recebido (ID: %s). Desligamento em 30s.", cmd.ID))
		if err := runShutdown("/s", 30); err != nil {
			return "", fmt.Errorf("shutdown falhou: %w", err)
		}
		return "Shutdown agendado em 30 segundos.", nil

	case "cancel-shutdown":
		c := exec.Command("shutdown", "/a")
		if err := c.Run(); err != nil {
			return "", fmt.Errorf("cancelar shutdown falhou: %w", err)
		}
		logInfo("Shutdown/reboot cancelado.")
		return "Shutdown cancelado.", nil

	case "wol":
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

	case "uninstall":
		logInfo(fmt.Sprintf("Comando UNINSTALL recebido (ID: %s). Desinstalando agente...", cmd.ID))
		go func() {
			time.Sleep(2 * time.Second) // aguarda ACK ser enviado antes de encerrar
			exePath, _ := os.Executable()
			installDir := filepath.Dir(exePath)
			_ = uninstallService()
			// Deleta a pasta apos o processo encerrar (processo atual segura o exe)
			exec.Command("cmd", "/c",
				fmt.Sprintf(`timeout /t 4 /nobreak >nul && rmdir /s /q "%s"`, installDir),
			).Start()
			os.Exit(0)
		}()
		return "Desinstalando agente. Maquina sera removida em instantes.", nil

	case "update":
		var params struct {
			Version string `json:"version"`
			SHA256  string `json:"sha256"`
		}
		if err := json.Unmarshal(cmd.Params, &params); err != nil || params.Version == "" {
			return "", fmt.Errorf("params de update invalidos")
		}
		logInfo(fmt.Sprintf("Comando UPDATE: versao alvo %s", params.Version))
		// Executa em goroutine para enviar ACK antes de encerrar o processo
		go a.checkAndUpdate(UpdateInfo{
			Version: params.Version,
			SHA256:  params.SHA256,
		})
		return fmt.Sprintf("Iniciando atualizacao para v%s", params.Version), nil

	case "aloha-scan":
		logInfo(fmt.Sprintf("Comando ALOHA-SCAN recebido (ID: %s). Escaneando C:\\Bootdrv...", cmd.ID))
		scan := scanAloha()
		data, err := json.Marshal(scan)
		if err != nil {
			return "", fmt.Errorf("erro ao serializar scan Aloha: %w", err)
		}
		return string(data), nil

	case "aloha-index-nfce-day":
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
		result := indexNFCeDay(params.Month, params.Day)
		s, err := nfceRecordToJSON(result)
		if err != nil {
			return "", fmt.Errorf("erro ao serializar index NF-Ce: %w", err)
		}
		return s, nil

	default:
		return "", fmt.Errorf("tipo de comando desconhecido: %q", cmd.Type)
	}
}

func runShutdown(flag string, delaySecs int) error {
	args := []string{flag, "/t", fmt.Sprintf("%d", delaySecs), "/c", "Delirio Manager: manutencao remota"}
	return exec.Command("shutdown", args...).Run()
}
