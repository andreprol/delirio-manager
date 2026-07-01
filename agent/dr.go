//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	veeamInstallerName = "VeeamAgentWindows.exe"
	veeamSvcName       = "VeeamEndpointBackupSvc"
	veeamPSModulePath  = `C:\Program Files\Veeam\Endpoint Backup\Veeam.Endpoint.Backup.PowerShell.dll`
	veeamLogDir        = `C:\ProgramData\Veeam\Endpoint\Log`
	drJobName          = "BMR-DM"
	drRepoName         = "AzureBlob-DM"
)

// DrCreds holds Azure Blob credentials received in the dr-setup command params.
type DrCreds struct {
	AzureAccount string `json:"azure_account"`
	SASToken     string `json:"sas_token"`
	ScheduleHour int    `json:"schedule_hour"`
}

// DRStatus is the dr_status field sent inside every heartbeat.
type DRStatus struct {
	Setup        string  `json:"setup"`
	LastBackupAt string  `json:"last_backup_at,omitempty"`
	LastBackupOk bool    `json:"last_backup_ok"`
	IsRunning    bool    `json:"is_running"`
	StorageGB    float64 `json:"storage_gb,omitempty"`
	DurationMin  int     `json:"duration_min,omitempty"`
	ErrorMsg     string  `json:"error_msg,omitempty"`
	VeeamVersion string  `json:"veeam_version,omitempty"`
}

var drStatusCache *DRStatus

func runPS(script string) (string, error) {
	var out, errOut bytes.Buffer
	cmd := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%w — stderr: %s", err, strings.TrimSpace(errOut.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

func isVeeamInstalled() bool {
	out, err := runPS(fmt.Sprintf(
		`(Get-Service -Name "%s" -ErrorAction SilentlyContinue) -ne $null`, veeamSvcName,
	))
	return err == nil && out == "True"
}

func getVeeamVersion() string {
	out, err := runPS(`(Get-ItemProperty "HKLM:\SOFTWARE\Veeam\Veeam Endpoint Backup" -ErrorAction SilentlyContinue).ProductVersion`)
	if err != nil {
		return ""
	}
	return out
}

// installVeeam downloads VeeamAgentWindows.exe from the DM server and installs it silently.
func installVeeam(serverURL string) error {
	if isVeeamInstalled() {
		logInfo("DR: Veeam ja instalado, pulando download.")
		return nil
	}

	logInfo("DR: baixando instalador Veeam do servidor...")
	resp, err := http.Get(serverURL + "/downloads/" + veeamInstallerName)
	if err != nil {
		return fmt.Errorf("download VeeamAgentWindows.exe: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download VeeamAgentWindows.exe: HTTP %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("ler instalador Veeam: %w", err)
	}

	tmpPath := filepath.Join(os.TempDir(), veeamInstallerName)
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("salvar instalador Veeam: %w", err)
	}
	defer os.Remove(tmpPath)

	logInfo("DR: instalando Veeam Agent (modo silencioso)...")
	cmd := exec.Command(tmpPath, "/silent", "/norestart")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("instalacao Veeam falhou: %w — output: %s", err, string(out))
	}

	// Aguarda servico subir (ate 3 minutos)
	for i := 0; i < 36; i++ {
		time.Sleep(5 * time.Second)
		if isVeeamInstalled() {
			logInfo(fmt.Sprintf("DR: Veeam instalado com sucesso. Versao: %s", getVeeamVersion()))
			return nil
		}
	}
	return fmt.Errorf("servico Veeam nao subiu em 3 minutos apos instalacao")
}

// configureJob creates an Azure Blob repo and backup job in Veeam via PowerShell.
func configureJob(creds DrCreds) error {
	hostname, _ := os.Hostname()
	container := strings.ToLower(hostname)
	endpoint := fmt.Sprintf("https://%s.blob.core.windows.net", creds.AzureAccount)
	scheduleHour := creds.ScheduleHour
	if scheduleHour < 0 || scheduleHour > 23 {
		scheduleHour = 23
	}

	script := fmt.Sprintf(`
$ErrorActionPreference = 'Stop'

$modulePath = '%s'
if (-not (Test-Path $modulePath)) {
    throw "Modulo Veeam PS nao encontrado em: $modulePath"
}
Import-Module $modulePath -Force

# Remove repo e job anteriores (idempotente)
try { Get-VBRBackupRepository -Name '%s' -ErrorAction SilentlyContinue | Remove-VBRBackupRepository -Confirm:$false } catch {}
try { Get-VBRJob -Name '%s' -ErrorAction SilentlyContinue | Remove-VBRJob -Confirm:$false } catch {}

# Cria credencial Azure Blob via SAS
$connStr = "BlobEndpoint=%s;SharedAccessSignature=%s"
$azAccount = New-VBRAzureStorageAccount -ConnectionString $connStr -Name '%s'

# Cria repositorio no container nomeado pelo hostname
$repo = Add-VBRAzureObjectStorageRepository -Name '%s' -AzureStorageAccount $azAccount -Container '%s'

# Cria job de backup bare metal
$job = Add-VBRComputerBackupJob -Name '%s' -BackupType EntireComputer -StorageType ObjectStorage -Repository $repo -RestorePointsToKeep 7

# Agenda para o horario configurado
$schedOpts = New-VBRJobScheduleOptions
$schedOpts.Type = 'Daily'
$schedOpts.DailyOptions.TimeLocal = [datetime]::Today.AddHours(%d)
$schedOpts.DailyOptions.Type = 'Everyday'
Set-VBRJobScheduleOptions -Job $job -Options $schedOpts
Enable-VBRJobSchedule -Job $job

Write-Output "configured"
`,
		veeamPSModulePath,
		drRepoName, drJobName,
		endpoint, creds.SASToken, creds.AzureAccount,
		drRepoName,
		container,
		drJobName,
		scheduleHour,
	)

	out, err := runPS(script)
	if err != nil {
		return fmt.Errorf("configureJob PS falhou: %w", err)
	}
	if !strings.Contains(out, "configured") {
		return fmt.Errorf("configureJob saida inesperada: %s", out)
	}
	logInfo(fmt.Sprintf("DR: job '%s' configurado → azure://%s/%s", drJobName, creds.AzureAccount, container))
	return nil
}

// triggerBackupNow starts the DR backup job immediately.
func triggerBackupNow() error {
	script := fmt.Sprintf(`
$ErrorActionPreference = 'Stop'
Import-Module '%s' -Force
$job = Get-VBRJob -Name '%s' -ErrorAction SilentlyContinue
if (-not $job) { throw "Job '%s' nao encontrado" }
Start-VBRJob -Job $job -RunAsync
Write-Output "started"
`, veeamPSModulePath, drJobName, drJobName)

	out, err := runPS(script)
	if err != nil {
		return fmt.Errorf("triggerBackupNow falhou: %w", err)
	}
	if !strings.Contains(out, "started") {
		return fmt.Errorf("triggerBackupNow saida inesperada: %s", out)
	}
	return nil
}

// readStatus builds a DRStatus by querying Veeam via PowerShell, with log file fallback.
func readStatus() DRStatus {
	s := DRStatus{
		Setup:        "not_installed",
		VeeamVersion: getVeeamVersion(),
	}
	if !isVeeamInstalled() {
		return s
	}
	s.Setup = "installed"

	script := fmt.Sprintf(`
Import-Module '%s' -Force -ErrorAction SilentlyContinue
$sess = Get-VBRSession -ErrorAction SilentlyContinue |
    Where-Object { $_.JobName -eq '%s' } |
    Sort-Object CreationTime -Descending |
    Select-Object -First 1
if ($sess) {
    @{
        Result       = [string]$sess.Result
        CreationTime = $sess.CreationTime.ToUniversalTime().ToString('o')
        EndTime      = if ($sess.EndTime) { $sess.EndTime.ToUniversalTime().ToString('o') } else { '' }
        IsRunning    = ($sess.State -eq 'Working')
    } | ConvertTo-Json -Compress
}
`, veeamPSModulePath, drJobName)

	if out, err := runPS(script); err == nil && len(out) > 0 {
		var sess struct {
			Result       string `json:"Result"`
			CreationTime string `json:"CreationTime"`
			EndTime      string `json:"EndTime"`
			IsRunning    bool   `json:"IsRunning"`
		}
		if json.Unmarshal([]byte(out), &sess) == nil {
			s.Setup = "configured"
			s.IsRunning = sess.IsRunning
			s.LastBackupAt = sess.CreationTime
			s.LastBackupOk = sess.Result == "Success"
			if !s.LastBackupOk && sess.Result != "" {
				s.ErrorMsg = "Veeam result: " + sess.Result
			}
			if !sess.IsRunning && sess.EndTime != "" {
				t1, e1 := time.Parse(time.RFC3339, sess.CreationTime)
				t2, e2 := time.Parse(time.RFC3339, sess.EndTime)
				if e1 == nil && e2 == nil {
					s.DurationMin = int(t2.Sub(t1).Minutes())
				}
			}
			return s
		}
	}

	return readStatusFromLogs(s)
}

var (
	rexOK   = regexp.MustCompile(`(?i)backup.*success|job.*finished.*success`)
	rexFail = regexp.MustCompile(`(?i)backup.*fail|job.*fail`)
	rexGB   = regexp.MustCompile(`(?i)transferred[^0-9]*([\d.]+)\s*gb`)
)

func readStatusFromLogs(base DRStatus) DRStatus {
	entries, err := os.ReadDir(veeamLogDir)
	if err != nil {
		return base
	}
	sort.Slice(entries, func(i, j int) bool {
		ii, _ := entries[i].Info()
		jj, _ := entries[j].Info()
		return ii.ModTime().After(jj.ModTime())
	})
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".log") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(veeamLogDir, e.Name()))
		if err != nil {
			continue
		}
		content := string(data)
		info, _ := e.Info()
		if rexOK.MatchString(content) {
			base.Setup = "configured"
			base.LastBackupAt = info.ModTime().UTC().Format(time.RFC3339)
			base.LastBackupOk = true
			if m := rexGB.FindStringSubmatch(strings.ToLower(content)); len(m) > 1 {
				if gb, err := strconv.ParseFloat(m[1], 64); err == nil {
					base.StorageGB = gb
				}
			}
			return base
		}
		if rexFail.MatchString(content) {
			base.Setup = "error"
			base.LastBackupOk = false
			base.ErrorMsg = "Veeam backup falhou (ver logs em C:\\ProgramData\\Veeam\\Endpoint\\Log)"
			return base
		}
	}
	return base
}

func getCachedDRStatus() *DRStatus {
	if drStatusCache == nil {
		s := readStatus()
		drStatusCache = &s
	}
	return drStatusCache
}

func invalidateDRCache() {
	drStatusCache = nil
}
