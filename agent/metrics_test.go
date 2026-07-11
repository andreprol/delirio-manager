package main

import (
	"testing"
)

// ── round2 ────────────────────────────────────────────────────────────────────

func TestRound2(t *testing.T) {
	tests := []struct {
		input float64
		want  float64
	}{
		{0, 0},
		{1, 1},
		{33.333, 33.33},
		{33.335, 33.34},
		{99.999, 100},
		{0.004, 0},
		{0.005, 0.01},
		{-0.004, 0},
	}
	for _, tt := range tests {
		got := round2(tt.input)
		if got != tt.want {
			t.Errorf("round2(%v) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

// ── isLoopback ────────────────────────────────────────────────────────────────

func TestIsLoopback(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"lo", true},
		{"Loopback Pseudo-Interface 1", true},
		{"VMware Network Adapter VMnet8", true},
		{"VEthernet (WSL)", true},
		{"Hyper-V Virtual Ethernet Adapter", true},
		{"Topaz Network Adapter", true},
		{"KM-TEST Adapter", true},
		{"VirtualBox Host-Only Network", true},
		{"Ethernet", false},
		{"Wi-Fi", false},
		{"Local Area Connection", false},
		{"Intel(R) Ethernet Controller", false},
		{"", false},
	}
	for _, tt := range tests {
		got := isLoopback(tt.name)
		if got != tt.want {
			t.Errorf("isLoopback(%q) = %v, want %v", tt.name, got, tt.want)
		}
	}
}

// ── isIPv4 ────────────────────────────────────────────────────────────────────

func TestIsIPv4(t *testing.T) {
	tests := []struct {
		ip   string
		want bool
	}{
		{"192.168.1.100", true},
		{"10.0.0.1", true},
		{"172.16.0.1", true},
		{"0.0.0.0", true},
		{"255.255.255.255", true},
		{"2001:db8::1", false},
		{"fe80::1", false},
		{"::1", false},
		{"", true}, // vazio sem colons — passa como IPv4 (filtragem por len ocorre fora)
	}
	for _, tt := range tests {
		got := isIPv4(tt.ip)
		if got != tt.want {
			t.Errorf("isIPv4(%q) = %v, want %v", tt.ip, got, tt.want)
		}
	}
}

// ── isLinkLocal ───────────────────────────────────────────────────────────────

func TestIsLinkLocal(t *testing.T) {
	tests := []struct {
		ip   string
		want bool
	}{
		{"169.254.0.1", true},
		{"169.254.255.254", true},
		{"192.168.1.1", false},
		{"10.0.0.1", false},
		{"169.253.0.1", false},
		{"169.255.0.1", false},
		{"", false},
		{"169.2", false}, // muito curto
	}
	for _, tt := range tests {
		got := isLinkLocal(tt.ip)
		if got != tt.want {
			t.Errorf("isLinkLocal(%q) = %v, want %v", tt.ip, got, tt.want)
		}
	}
}

// ── extractIP ─────────────────────────────────────────────────────────────────

func TestExtractIP(t *testing.T) {
	tests := []struct {
		addr string
		want string
	}{
		{"192.168.1.100/24", "192.168.1.100"},
		{"10.0.0.1/8", "10.0.0.1"},
		{"192.168.1.1", "192.168.1.1"},
		{"2001:db8::1/64", "2001:db8::1"},
		{"", ""},
	}
	for _, tt := range tests {
		got := extractIP(tt.addr)
		if got != tt.want {
			t.Errorf("extractIP(%q) = %q, want %q", tt.addr, got, tt.want)
		}
	}
}

// ── Metrics.Validate ──────────────────────────────────────────────────────────

func TestMetricsValidate(t *testing.T) {
	t.Run("happy path — metricas validas", func(t *testing.T) {
		m := &Metrics{
			CPUPct:    45.0,
			RAMTotalMB: 8192,
			RAMFreeMB:  4096,
		}
		if err := m.Validate(); err != nil {
			t.Errorf("esperava nil, obteve: %v", err)
		}
	})

	t.Run("CPU negativa", func(t *testing.T) {
		m := &Metrics{CPUPct: -1, RAMTotalMB: 8192, RAMFreeMB: 4096}
		if err := m.Validate(); err == nil {
			t.Error("esperava erro para CPU negativa")
		}
	})

	t.Run("CPU acima de 100", func(t *testing.T) {
		m := &Metrics{CPUPct: 101, RAMTotalMB: 8192, RAMFreeMB: 4096}
		if err := m.Validate(); err == nil {
			t.Error("esperava erro para CPU > 100")
		}
	})

	t.Run("CPU exatamente 100 — valida", func(t *testing.T) {
		m := &Metrics{CPUPct: 100, RAMTotalMB: 8192, RAMFreeMB: 4096}
		if err := m.Validate(); err != nil {
			t.Errorf("CPUPct=100 deve ser valido, obteve: %v", err)
		}
	})

	t.Run("RAM total zero", func(t *testing.T) {
		m := &Metrics{CPUPct: 50, RAMTotalMB: 0, RAMFreeMB: 0}
		if err := m.Validate(); err == nil {
			t.Error("esperava erro para RAMTotalMB=0")
		}
	})

	t.Run("RAM free maior que total", func(t *testing.T) {
		m := &Metrics{CPUPct: 50, RAMTotalMB: 4096, RAMFreeMB: 8192}
		if err := m.Validate(); err == nil {
			t.Error("esperava erro para RAMFreeMB > RAMTotalMB")
		}
	})

	t.Run("RAM free igual ao total — borda valida", func(t *testing.T) {
		m := &Metrics{CPUPct: 0, RAMTotalMB: 4096, RAMFreeMB: 4096}
		if err := m.Validate(); err != nil {
			t.Errorf("RAMFreeMB == RAMTotalMB deve ser valido, obteve: %v", err)
		}
	})
}
