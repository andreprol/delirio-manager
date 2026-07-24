package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Serviços NCR Voyix a monitorar em máquinas BOH.
var ncrServices = []string{
	"NCR Voyix Takeout and Delivery",
	"NCR Voyix Takeout Service Monitor",
}

type serviceStatusPayload struct {
	Services []serviceStatusEntry `json:"services"`
}

type serviceStatusEntry struct {
	Name          string  `json:"name"`
	Status        string  `json:"status"` // "running" | "stopped"
	LastRestartAt *string `json:"lastRestartAt,omitempty"`
	LastRestartOk *bool   `json:"lastRestartOk,omitempty"`
}

type svcState int

const (
	svcRunning  svcState = iota // STATE: 4 RUNNING
	svcPending                  // START_PENDING ou STOP_PENDING — não reiniciar
	svcStopped                  // parado ou desconhecido
)

func isBOHMachine() bool {
	hostname, err := os.Hostname()
	if err != nil {
		return false
	}
	return strings.HasSuffix(strings.ToUpper(hostname), "BOH")
}

// queryServiceState executa sc.exe query uma vez e classifica o estado.
// Usa contains simples para evitar dependência de espaçamento ou locale.
func queryServiceState(name string) svcState {
	out, err := exec.Command("sc.exe", "query", name).Output()
	if err != nil {
		return svcStopped
	}
	o := string(out)
	if strings.Contains(o, "RUNNING") {
		return svcRunning
	}
	if strings.Contains(o, "PENDING") {
		return svcPending
	}
	return svcStopped
}

// restartService tenta iniciar o serviço via sc.exe start.
func restartService(name string) error {
	out, err := exec.Command("sc.exe", "start", name).CombinedOutput()
	if err != nil {
		return fmt.Errorf("sc start: %v — %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// sleepOrStop aguarda d ou encerra se stopCh for fechado. Retorna false se encerrado.
func sleepOrStop(d time.Duration, stopCh <-chan struct{}) bool {
	select {
	case <-time.After(d):
		return true
	case <-stopCh:
		return false
	}
}

// waitForServiceMonitorReady aguarda token (até 60s) + delay de startup.
// Retorna false se o agente for encerrado durante a espera.
func (a *Agent) waitForServiceMonitorReady() bool {
	for i := 0; i < 20; i++ {
		if a.cfg.Token != "" {
			break
		}
		if !sleepOrStop(3*time.Second, a.stopCh) {
			return false
		}
	}
	if a.cfg.Token == "" {
		logWarn("serviceMonitorLoop: sem token após 60s, abortando")
		return false
	}
	return sleepOrStop(20*time.Second, a.stopCh)
}

// serviceMonitorLoop monitora os serviços NCR Voyix a cada 60s.
// Executado apenas em máquinas cujo hostname termina com "BOH".
func (a *Agent) serviceMonitorLoop() {
	if !isBOHMachine() {
		return
	}
	if !a.waitForServiceMonitorReady() {
		return
	}

	hostname, _ := os.Hostname()
	logInfo(fmt.Sprintf("serviceMonitorLoop: iniciado em %s (agente v%s)", hostname, Version))

	// Check imediato no boot
	a.checkNCRServices()

	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			func() {
				defer func() {
					if r := recover(); r != nil {
						logError(fmt.Sprintf("serviceMonitor panic: %v", r))
					}
				}()
				a.checkNCRServices()
			}()
		case <-a.stopCh:
			logInfo("serviceMonitorLoop: encerrado")
			return
		}
	}
}

func (a *Agent) checkNCRServices() {
	entries := make([]serviceStatusEntry, 0, len(ncrServices))

	for _, svc := range ncrServices {
		entry := checkService(svc)
		entries = append(entries, entry)
	}

	a.reportServiceStatus(entries)
}

func checkService(name string) serviceStatusEntry {
	entry := serviceStatusEntry{Name: name}

	switch queryServiceState(name) {
	case svcRunning:
		entry.Status = "running"

	case svcPending:
		// Serviço em transição (START_PENDING / STOP_PENDING) — não reiniciar agora
		entry.Status = "running"
		logInfo(fmt.Sprintf("serviceMonitor: '%s' em transição (PENDING) — aguardando próximo ciclo", name))

	default: // svcStopped
		entry.Status = "stopped"
		logWarn(fmt.Sprintf("serviceMonitor: '%s' parado — tentando reiniciar", name))

		now := time.Now().UTC().Format(time.RFC3339)
		entry.LastRestartAt = &now

		err := restartService(name)
		ok := err == nil
		entry.LastRestartOk = &ok

		if err != nil {
			logError(fmt.Sprintf("serviceMonitor: falha ao reiniciar '%s': %v", name, err))
		} else {
			logInfo(fmt.Sprintf("serviceMonitor: '%s' reiniciado — aguardando 5s para confirmar", name))
			time.Sleep(5 * time.Second)
			if queryServiceState(name) == svcRunning {
				entry.Status = "running"
			}
		}
	}

	return entry
}

func (a *Agent) reportServiceStatus(entries []serviceStatusEntry) {
	resp, err := a.post("/api/machines/"+a.cfg.MachineID+"/service-status", serviceStatusPayload{Services: entries})
	if err != nil {
		logWarn(fmt.Sprintf("serviceMonitor: report falhou: %v", err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		logWarn(fmt.Sprintf("serviceMonitor: servidor rejeitou status (HTTP %d)", resp.StatusCode))
	}
}
