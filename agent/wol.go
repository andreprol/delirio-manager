package main

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"net"
	"os/exec"
	"strings"
)

// sendMagicPacket envia um pacote Wake-on-LAN (magic packet) para o MAC informado.
// broadcast: endereco de broadcast da subnet (ex: "192.168.14.255")
// mac: endereco MAC no formato "AA:BB:CC:DD:EE:FF" ou "AA-BB-CC-DD-EE-FF"
func sendMagicPacket(mac, broadcast string) error {
	// Normaliza MAC: remove separadores e converte para bytes
	mac = strings.ReplaceAll(mac, ":", "")
	mac = strings.ReplaceAll(mac, "-", "")
	mac = strings.ToLower(mac)

	if len(mac) != 12 {
		return fmt.Errorf("MAC invalido: %q (esperado 12 hex chars)", mac)
	}

	macBytes, err := hex.DecodeString(mac)
	if err != nil {
		return fmt.Errorf("MAC hex invalido: %w", err)
	}

	// Magic packet: 6 bytes 0xFF + MAC repetido 16 vezes = 102 bytes
	packet := make([]byte, 102)
	for i := 0; i < 6; i++ {
		packet[i] = 0xFF
	}
	for i := 1; i <= 16; i++ {
		copy(packet[i*6:], macBytes)
	}

	// Envia via UDP broadcast na porta 9
	addr := fmt.Sprintf("%s:9", broadcast)
	conn, err := net.Dial("udp", addr)
	if err != nil {
		return fmt.Errorf("abrir UDP: %w", err)
	}
	defer conn.Close()

	n, err := conn.Write(packet)
	if err != nil {
		return fmt.Errorf("enviar pacote: %w", err)
	}
	if n != 102 {
		return fmt.Errorf("pacote incompleto: %d/102 bytes", n)
	}

	return nil
}

// localBroadcast detecta o endereco de broadcast da interface de rede principal.
// Usado quando o servidor nao especifica o broadcast no comando WoL.
func localBroadcast() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "255.255.255.255"
	}

	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP.To4()
			if ip == nil {
				continue
			}
			// Calcula broadcast: IP | ~mask
			mask := ipNet.Mask
			broadcast := make(net.IP, 4)
			for i := 0; i < 4; i++ {
				broadcast[i] = ip[i] | ^mask[i]
			}
			return broadcast.String()
		}
	}
	return "255.255.255.255"
}

// checkAndEnableWolDriver verifica se algum NIC físico tem WakeOnMagicPacket habilitado.
// Efeito colateral: se não estiver habilitado, tenta habilitar via Set-NetAdapterPowerManagement.
// Retorna true somente se o WoL estiver ativo após a operação; retorna false tanto quando
// o driver está desabilitado quanto quando o PowerShell falha (erro propagado via logWarn).
func checkAndEnableWolDriver() bool {
	script := `
$enabled = $false
try {
  $adapters = Get-NetAdapter -Physical -ErrorAction SilentlyContinue
  foreach ($a in $adapters) {
    $pm = $a | Get-NetAdapterPowerManagement -ErrorAction SilentlyContinue
    if ($pm -and $pm.WakeOnMagicPacket -ne 'Enabled') {
      $pm | Set-NetAdapterPowerManagement -WakeOnMagicPacket Enabled -ErrorAction SilentlyContinue
    }
  }
  $enabled = ($null -ne (Get-NetAdapterPowerManagement -ErrorAction SilentlyContinue |
    Where-Object { $_.WakeOnMagicPacket -eq 'Enabled' }))
} catch {}

# Fallback: Get-NetAdapterPowerManagement falha em algumas placas ("Classe invalida").
# Nesse caso verifica diretamente o registro — *WakeOnMagicPacket=1 equivale a Enabled.
if (-not $enabled) {
  $regBase = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4D36E972-E325-11CE-BFC1-08002BE10318}'
  $keys = Get-ChildItem $regBase -ErrorAction SilentlyContinue
  foreach ($k in $keys) {
    $v = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
    if ($v.'*WakeOnMagicPacket' -eq '1') { $enabled = $true; break }
  }
}
Write-Output $(if ($enabled) { 'true' } else { 'false' })
`
	var out bytes.Buffer
	cmd := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		logWarn(fmt.Sprintf("checkAndEnableWolDriver: powershell falhou: %v", err))
		return false
	}
	return strings.TrimSpace(out.String()) == "true"
}

// getMotherboardInfo retorna informações da placa-mãe no formato "Fabricante|Modelo".
// Tenta Win32_BaseBoard primeiro; cai em Win32_ComputerSystem quando o fabricante está
// ausente ou marcado como genérico (ex: "Not Applicable"). Retorna "Unknown|Unknown"
// quando o PowerShell falha ou a saída está vazia.
func getMotherboardInfo() string {
	script := `
try {
  $b = Get-CimInstance -ClassName Win32_BaseBoard -ErrorAction SilentlyContinue
  if ($b -and $b.Manufacturer -and $b.Manufacturer -notmatch 'Not Applicable|Default') {
    Write-Output "$($b.Manufacturer.Trim())|$($b.Product.Trim())"
  } else {
    $c = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
    Write-Output "$($c.Manufacturer.Trim())|$($c.Model.Trim())"
  }
} catch { Write-Output 'Unknown|Unknown' }
`
	var out bytes.Buffer
	cmd := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		logWarn(fmt.Sprintf("getMotherboardInfo: powershell falhou: %v", err))
		return "Unknown|Unknown"
	}
	result := strings.TrimSpace(out.String())
	if result == "" {
		return "Unknown|Unknown"
	}
	return result
}

// getWindowsVersion retorna a versão do SO no formato "Windows 11 Pro 23H2".
// ProductName no registro do Windows 11 ainda diz "Windows 10" — a distinção
// correta é pelo CurrentBuildNumber: >= 22000 = Windows 11.
func getWindowsVersion() string {
	script := `
try {
  $k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $p = Get-ItemProperty $k
  $n = $p.ProductName
  $d = $p.DisplayVersion
  $b = [int]$p.CurrentBuildNumber
  if ($b -ge 22000) { $n = $n -replace 'Windows 10', 'Windows 11' }
  if ($d) { "$n $d" } else { $n }
} catch { "" }
`
	var out bytes.Buffer
	cmd := exec.Command("powershell", "-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		logWarn(fmt.Sprintf("getWindowsVersion: powershell falhou: %v", err))
		return ""
	}
	return strings.TrimSpace(out.String())
}
