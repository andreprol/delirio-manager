package main

import (
	"strings"

	"github.com/shirou/gopsutil/v3/host"
)

// Temperatures holds CPU and room temperature readings.
type Temperatures struct {
	CPU  float64 // CPU temperature in Celsius (-1 = not available)
	Room float64 // Ambient/case temperature in Celsius (-1 = not available)
}

// readTemperatures reads CPU temperature (via LHM if available, gopsutil fallback)
// and room/ambient temperature (via ACPI sensor).
func readTemperatures() Temperatures {
	result := Temperatures{CPU: -1, Room: -1}

	// Try LibreHardwareMonitor first — most accurate CPU reading on Windows
	if cpu := readCPUTempLHM(); cpu > 0 {
		result.CPU = cpu
	}

	// Read gopsutil sensors for room temp (ACPI) and CPU fallback
	temps, err := host.SensorsTemperatures()
	if err != nil || len(temps) == 0 {
		return result
	}

	// CPU fallback via gopsutil (only if LHM didn't work)
	if result.CPU < 0 {
		cpuPreferred := []string{
			"coretemp_core_0",
			"k10temp_tdie",
			"cpu_thermal_0",
			"cpu-thermal_0",
		}
		for _, name := range cpuPreferred {
			for _, t := range temps {
				if t.SensorKey == name && t.Temperature >= 35 && t.Temperature < 110 {
					result.CPU = round2(t.Temperature)
					break
				}
			}
			if result.CPU > 0 {
				break
			}
		}

		if result.CPU < 0 {
			for _, t := range temps {
				key := strings.ToLower(t.SensorKey)
				if strings.Contains(key, "cpu") &&
					!strings.Contains(key, "acpi") &&
					t.Temperature >= 35 && t.Temperature < 110 {
					result.CPU = round2(t.Temperature)
					break
				}
			}
		}
	}

	// Room temperature from ACPI thermal zone
	for _, t := range temps {
		key := strings.ToLower(t.SensorKey)
		if strings.Contains(key, "acpi") && t.Temperature >= 10 && t.Temperature <= 50 {
			result.Room = round2(t.Temperature)
			break
		}
	}

	return result
}
