# Delirio Manager — Agent

Go-based Windows service installed on each managed PC. Reports metrics, collects event logs, and executes remote commands from the server.

## Stack

- **Language**: Go 1.21+
- **Runs as**: Windows Service (`DelirioAgent`)
- **Hardware monitoring**: LibreHardwareMonitor (LHM) — optional, for CPU/GPU temperatures

## Features

- Heartbeat every 30 seconds with CPU, RAM, disk usage, temperatures, uptime, IP addresses
- Windows Event Log collection and forwarding
- Remote command execution: reboot, shutdown, cancel-shutdown, Wake-on-LAN relay, self-uninstall
- Wake-on-LAN detection: tests and reports WoL driver status automatically
- Auto-update: downloads and applies new agent versions from the server
- Graceful service lifecycle (install, start, stop, uninstall)

## Project Structure

```
agent/
├── main.go          # Entry point: service registration, CLI flags
├── service.go       # Windows service lifecycle
├── config.go        # Configuration loading and persistence
├── metrics.go       # CPU, RAM, disk metrics collection
├── temperature.go   # CPU/GPU temperature via LHM
├── lhm.go           # LibreHardwareMonitor integration
├── events.go        # Windows Event Log collection
├── commands.go      # Remote command handlers
├── wol.go           # Wake-on-LAN detection and relay
├── updater.go       # Auto-update logic
├── logger.go        # Logging to file + Windows Event Log
├── go.mod
├── go.sum
└── build.ps1        # Build script → delirio-agent.exe
```

## Building

```powershell
cd agent
.\build.ps1
# Output: delirio-agent.exe (Windows x64)
```

The binary must be placed in `server/public/delirio-agent.exe` to be served for installation.

## Installation (on managed PCs)

Run as **Administrator** in PowerShell:

```powershell
# One-liner install from server
irm https://your-server/install.ps1 | iex
```

Or manually:
```powershell
# Download and install
Invoke-WebRequest -Uri "https://your-server/downloads/delirio-agent.exe" `
    -OutFile "C:\Program Files\DelirioAgent\delirio-agent.exe"

# Register with server and install as service
& "C:\Program Files\DelirioAgent\delirio-agent.exe" -server "https://your-server"
& "C:\Program Files\DelirioAgent\delirio-agent.exe" -install
```

## Service Management

```powershell
Get-Service DelirioAgent                    # Check status
Start-Service DelirioAgent                  # Start
Stop-Service DelirioAgent                   # Stop
& "C:\...\delirio-agent.exe" -uninstall     # Remove service
```

## Configuration

The agent stores its config at `C:\Program Files\DelirioAgent\config.json`:

```json
{
  "server_url": "https://your-server",
  "machine_id": "unique-machine-id",
  "token": "auth-token-from-server",
  "agent_version": "1.5.0"
}
```

The `machine_id` and `token` are assigned during first registration and never change.

## Heartbeat Payload

```json
{
  "machineId": "...",
  "hostname": "MACHINE-NAME",
  "agentVersion": "1.5.0",
  "metrics": {
    "cpuPct": 11.2,
    "ramFreeMB": 6144,
    "ramTotalMB": 8192,
    "diskFreeGB": 45.3,
    "diskTotalGB": 237.0,
    "uptimeH": 14.5,
    "cpuTempC": 45.0,
    "roomTempC": -1,
    "ips": ["192.168.1.10"]
  },
  "mac": "e8:9c:25:7a:bc:ab",
  "wolStatus": "wol_confirmed"
}
```

## Wake-on-LAN Detection

On startup, the agent:
1. Checks if the WoL driver is enabled in Windows device manager
2. If enabled, reports `driver_enabled` and waits for a power cycle test
3. After confirmed WoL wake, reports `wol_confirmed`
4. If WoL fails after BIOS check is needed, reports `bios_needed`

The server uses this status to populate the WoL badge in the dashboard and to decide which machines can be auto-woken.
