//go:build windows

package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	lhmDirName = "lhm"
	lhmExeName = "LibreHardwareMonitor.exe"
	lhmZipName = "lhm.zip"
)

func lhmDir() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), lhmDirName)
}

func lhmExePath() string {
	return filepath.Join(lhmDir(), lhmExeName)
}

// isLHMWMIAvailable returns true if the LHM WMI namespace is populated with sensors.
func isLHMWMIAvailable() bool {
	cmd := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-Command",
		`try { ((Get-WmiObject -Namespace "root\LibreHardwareMonitor" -Class Sensor -ErrorAction Stop) | Measure-Object).Count -gt 0 } catch { $false }`)
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "True"
}

// isLHMRunning returns true if the LHM process is running.
func isLHMRunning() bool {
	cmd := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-Command",
		`(Get-Process -Name "LibreHardwareMonitor" -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0`)
	out, _ := cmd.Output()
	return strings.TrimSpace(string(out)) == "True"
}

// downloadAndExtractLHM downloads lhm.zip from the server and extracts it.
func downloadAndExtractLHM(serverURL string) error {
	url := serverURL + "/downloads/" + lhmZipName
	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("download lhm.zip: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download lhm.zip: HTTP %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read lhm.zip: %w", err)
	}

	if err := os.MkdirAll(lhmDir(), 0755); err != nil {
		return fmt.Errorf("create lhm dir: %w", err)
	}

	r, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("open lhm.zip: %w", err)
	}

	for _, f := range r.File {
		if f.FileInfo().IsDir() {
			continue
		}
		destPath := filepath.Join(lhmDir(), f.Name)
		if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		fc, err := os.Create(destPath)
		if err != nil {
			rc.Close()
			continue
		}
		io.Copy(fc, rc)
		rc.Close()
		fc.Close()
	}
	return nil
}

// startLHMHidden starts LibreHardwareMonitor.exe with no visible window.
func startLHMHidden() error {
	exePath := lhmExePath()
	if _, err := os.Stat(exePath); err != nil {
		return fmt.Errorf("LHM exe not found at %s", exePath)
	}

	cmd := exec.Command(exePath)
	cmd.Dir = lhmDir()
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000008, // DETACHED_PROCESS
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start LHM: %w", err)
	}

	// Wait up to 15s for WMI namespace to populate
	for i := 0; i < 15; i++ {
		time.Sleep(time.Second)
		if isLHMWMIAvailable() {
			return nil
		}
	}
	return nil
}

// ensureLHM ensures LibreHardwareMonitor is installed and running.
// Should be called in a background goroutine.
func ensureLHM(serverURL string) {
	if isLHMWMIAvailable() {
		return // already running
	}

	// Download if not present
	if _, err := os.Stat(lhmExePath()); os.IsNotExist(err) {
		logInfo("LHM: baixando LibreHardwareMonitor...")
		if err := downloadAndExtractLHM(serverURL); err != nil {
			logWarn(fmt.Sprintf("LHM: falha no download: %v", err))
			return
		}
		logInfo("LHM: download concluido.")
	}

	// Start if not running
	if !isLHMRunning() {
		logInfo("LHM: iniciando processo...")
		if err := startLHMHidden(); err != nil {
			logWarn(fmt.Sprintf("LHM: falha ao iniciar: %v", err))
			return
		}
		logInfo("LHM: WMI disponivel, temperatura da CPU habilitada.")
	}
}

// readCPUTempLHM reads CPU temperature from the LibreHardwareMonitor WMI namespace.
// Returns -1 if LHM is not available or no sensor found.
func readCPUTempLHM() float64 {
	if !isLHMWMIAvailable() {
		return -1
	}

	// Query CPU Package or highest Core temperature
	script := `
$sensors = Get-WmiObject -Namespace "root\LibreHardwareMonitor" -Class Sensor -ErrorAction SilentlyContinue |
    Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match 'Package|CPU Package|CPU$|Core Max' }
if (-not $sensors) {
    $sensors = Get-WmiObject -Namespace "root\LibreHardwareMonitor" -Class Sensor -ErrorAction SilentlyContinue |
        Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match 'Core \d' }
}
if ($sensors) {
    [math]::Round(($sensors | Sort-Object Value -Descending | Select-Object -First 1).Value, 1)
} else { '-1' }
`
	var out bytes.Buffer
	cmd := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-Command", script)
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return -1
	}

	s := strings.TrimSpace(out.String())
	if s == "" || s == "-1" {
		return -1
	}
	temp, err := strconv.ParseFloat(s, 64)
	if err != nil || temp <= 0 || temp > 120 {
		return -1
	}
	return round2(temp)
}
