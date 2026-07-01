//go:build windows

package main

import (
	"encoding/json"
	"testing"
)

func TestReadStatusFromLogsEmpty(t *testing.T) {
	base := DRStatus{Setup: "installed"}
	result := readStatusFromLogs(base)
	if result.Setup != "installed" {
		t.Errorf("expected setup=installed for missing log dir, got %s", result.Setup)
	}
}

func TestGetCachedDRStatusReturnsSomething(t *testing.T) {
	invalidateDRCache()
	s := getCachedDRStatus()
	if s == nil {
		t.Fatal("getCachedDRStatus returned nil")
	}
	valid := map[string]bool{
		"not_installed": true, "installed": true,
		"configured": true, "pending": true, "error": true,
	}
	if !valid[s.Setup] {
		t.Errorf("unexpected setup value: %q", s.Setup)
	}
}

func TestDRCredsJSON(t *testing.T) {
	raw := `{"azure_account":"dtmanagerdr","sas_token":"abc","schedule_hour":23}`
	var c DrCreds
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		t.Fatal(err)
	}
	if c.AzureAccount != "dtmanagerdr" {
		t.Errorf("expected dtmanagerdr, got %s", c.AzureAccount)
	}
	if c.ScheduleHour != 23 {
		t.Errorf("expected 23, got %d", c.ScheduleHour)
	}
}
