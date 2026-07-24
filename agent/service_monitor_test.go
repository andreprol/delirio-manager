package main

import (
	"strings"
	"testing"
	"time"
)

// ── isBOHMachine (via hostname suffix logic) ──────────────────────────────────
// isBOHMachine calls os.Hostname(), so we test the underlying string logic directly.

func isBOHHostname(hostname string) bool {
	return strings.HasSuffix(strings.ToUpper(hostname), "BOH")
}

func TestIsBOHHostname(t *testing.T) {
	tests := []struct {
		hostname string
		want     bool
	}{
		{"CAXIASBOH", true},
		{"caxiasboh", true},   // case insensitive
		{"TijucaBOH", true},
		{"CAXIAS-BOH", true},
		{"BOH", true},
		{"CAXIAS", false},
		{"BOHNOT", false},     // BOH not at suffix
		{"", false},
		{"BOHATIJUCA", false}, // BOH in middle
	}
	for _, tt := range tests {
		got := isBOHHostname(tt.hostname)
		if got != tt.want {
			t.Errorf("isBOHHostname(%q) = %v, want %v", tt.hostname, got, tt.want)
		}
	}
}

// ── queryServiceState parsing ─────────────────────────────────────────────────
// Test the sc.exe output parsing logic isolated from exec.Command.

func parseServiceState(scOutput string) svcState {
	if strings.Contains(scOutput, "RUNNING") {
		return svcRunning
	}
	if strings.Contains(scOutput, "PENDING") {
		return svcPending
	}
	return svcStopped
}

func TestParseServiceState(t *testing.T) {
	tests := []struct {
		name   string
		output string
		want   svcState
	}{
		{
			"running service",
			"SERVICE_NAME: NCR Voyix Takeout and Delivery\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 4  RUNNING\r\n",
			svcRunning,
		},
		{
			"start pending",
			"SERVICE_NAME: NCR Voyix Takeout and Delivery\r\n        STATE              : 2  START_PENDING\r\n",
			svcPending,
		},
		{
			"stop pending",
			"SERVICE_NAME: NCR Voyix Takeout and Delivery\r\n        STATE              : 3  STOP_PENDING\r\n",
			svcPending,
		},
		{
			"stopped",
			"SERVICE_NAME: NCR Voyix Takeout and Delivery\r\n        STATE              : 1  STOPPED\r\n",
			svcStopped,
		},
		{
			"empty output (sc error)",
			"",
			svcStopped,
		},
		{
			"service not found",
			"[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\r\nThe specified service does not exist as an installed service.\r\n",
			svcStopped,
		},
		{
			"RUNNING in different locale spacing",
			"        STATE              : 4  RUNNING\r\n                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)\r\n",
			svcRunning,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseServiceState(tt.output)
			if got != tt.want {
				t.Errorf("parseServiceState = %v, want %v", got, tt.want)
			}
		})
	}
}

// ── sleepOrStop ───────────────────────────────────────────────────────────────

func TestSleepOrStop_TimerFires(t *testing.T) {
	stopCh := make(chan struct{})
	result := sleepOrStop(10*time.Millisecond, stopCh)
	if !result {
		t.Error("sleepOrStop retornou false mas stopCh não foi fechado")
	}
}

func TestSleepOrStop_StopCh(t *testing.T) {
	stopCh := make(chan struct{})
	go func() {
		time.Sleep(5 * time.Millisecond)
		close(stopCh)
	}()
	result := sleepOrStop(1*time.Second, stopCh)
	if result {
		t.Error("sleepOrStop retornou true mas stopCh foi fechado")
	}
}

// ── svcState constants ────────────────────────────────────────────────────────

func TestSvcStateConstants(t *testing.T) {
	if svcRunning == svcPending || svcRunning == svcStopped || svcPending == svcStopped {
		t.Error("svcState constants devem ser distintos")
	}
}

// ── ncrServices list ──────────────────────────────────────────────────────────

func TestNCRServicesNotEmpty(t *testing.T) {
	if len(ncrServices) == 0 {
		t.Error("ncrServices não pode ser vazio")
	}
	for _, svc := range ncrServices {
		if svc == "" {
			t.Error("ncrServices contém nome vazio")
		}
	}
}

func TestNCRServicesExpectedNames(t *testing.T) {
	expected := map[string]bool{
		"NCR Voyix Takeout and Delivery":    false,
		"NCR Voyix Takeout Service Monitor": false,
	}
	for _, svc := range ncrServices {
		if _, ok := expected[svc]; ok {
			expected[svc] = true
		}
	}
	for name, found := range expected {
		if !found {
			t.Errorf("serviço esperado não encontrado em ncrServices: %q", name)
		}
	}
}
