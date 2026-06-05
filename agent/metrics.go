package main

import (
	"fmt"
	"math"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	psnet "github.com/shirou/gopsutil/v3/net"
)

// Metrics representa as metricas coletadas em um instante.
type Metrics struct {
	CPUPct      float64  `json:"cpuPct"`
	RAMFreeMB   uint64   `json:"ramFreeMB"`
	RAMTotalMB  uint64   `json:"ramTotalMB"`
	DiskFreeGB  float64  `json:"diskFreeGB"`
	DiskTotalGB float64  `json:"diskTotalGB"`
	UptimeH     float64  `json:"uptimeH"`
	CPUTempC    float64  `json:"cpuTempC"`
	RoomTempC   float64  `json:"roomTempC"`
	IPs         []string `json:"ips"`
	MAC         string   `json:"mac"`
}

func collectMetrics() (*Metrics, error) {
	m := &Metrics{}

	// CPU — media dos ultimos 2 segundos
	pcts, err := cpu.Percent(2*time.Second, false)
	if err == nil && len(pcts) > 0 {
		m.CPUPct = round2(pcts[0])
	}

	// RAM
	vmStat, err := mem.VirtualMemory()
	if err == nil {
		m.RAMFreeMB  = vmStat.Available / 1024 / 1024
		m.RAMTotalMB = vmStat.Total / 1024 / 1024
	}

	// Disco — particao C:
	diskStat, err := disk.Usage("C:\\")
	if err == nil {
		m.DiskFreeGB  = round2(float64(diskStat.Free) / 1024 / 1024 / 1024)
		m.DiskTotalGB = round2(float64(diskStat.Total) / 1024 / 1024 / 1024)
	}

	// Uptime
	uptimeSec, err := host.Uptime()
	if err == nil {
		m.UptimeH = round2(float64(uptimeSec) / 3600)
	}

	// Temperatura CPU e sala
	temps := readTemperatures()
	m.CPUTempC  = temps.CPU
	m.RoomTempC = temps.Room

	// IPs e MAC — apenas IPv4, ignora loopback e link-local
	ifaces, err := psnet.Interfaces()
	if err == nil {
		for _, iface := range ifaces {
			if isLoopback(iface.Name) {
				continue
			}
			for _, addr := range iface.Addrs {
				ip := extractIP(addr.Addr)
				if ip != "" && isIPv4(ip) && !isLinkLocal(ip) {
					m.IPs = append(m.IPs, ip)
					if m.MAC == "" && iface.HardwareAddr != "" {
						m.MAC = iface.HardwareAddr
					}
				}
			}
		}
	}

	return m, nil
}

func round2(f float64) float64 {
	return math.Round(f*100) / 100
}

func isLoopback(name string) bool {
	return name == "Loopback Pseudo-Interface 1" || name == "lo"
}

func isIPv4(ip string) bool {
	for _, c := range ip {
		if c == ':' {
			return false
		}
	}
	return true
}

func isLinkLocal(ip string) bool {
	return len(ip) >= 7 && ip[:7] == "169.254"
}

func extractIP(addr string) string {
	// addr pode ser "192.168.1.1/24" — retorna so o IP
	for i, c := range addr {
		if c == '/' {
			return addr[:i]
		}
	}
	return addr
}

// Valida se as metricas parecem razoaveis (usado nos testes)
func (m *Metrics) Validate() error {
	if m.CPUPct < 0 || m.CPUPct > 100 {
		return fmt.Errorf("CPU fora do range: %.1f", m.CPUPct)
	}
	if m.RAMTotalMB == 0 {
		return fmt.Errorf("RAM total zerada")
	}
	if m.RAMFreeMB > m.RAMTotalMB {
		return fmt.Errorf("RAM free > total")
	}
	return nil
}
