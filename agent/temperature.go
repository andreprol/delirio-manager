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

	if cpu := readCPUTempLHM(); cpu > 0 {
		result.CPU = cpu
	}

	temps, err := host.SensorsTemperatures()
	if err != nil || len(temps) == 0 {
		return result
	}

	if result.CPU < 0 {
		result.CPU = readCPUTempFromSensors(temps)
	}
	result.Room = readRoomTempFromSensors(temps)
	return result
}

// readCPUTempFromSensors tries preferred sensor names first, then fuzzy-matches "cpu".
func readCPUTempFromSensors(temps []host.TemperatureStat) float64 {
	preferred := []string{"coretemp_core_0", "k10temp_tdie", "cpu_thermal_0", "cpu-thermal_0"}
	for _, name := range preferred {
		for _, t := range temps {
			if t.SensorKey == name && isCPUTempValid(t.Temperature) {
				return round2(t.Temperature)
			}
		}
	}
	for _, t := range temps {
		key := strings.ToLower(t.SensorKey)
		if strings.Contains(key, "cpu") && !strings.Contains(key, "acpi") && isCPUTempValid(t.Temperature) {
			return round2(t.Temperature)
		}
	}
	return -1
}

// readRoomTempFromSensors reads ambient temperature from ACPI thermal zone.
func readRoomTempFromSensors(temps []host.TemperatureStat) float64 {
	for _, t := range temps {
		if strings.Contains(strings.ToLower(t.SensorKey), "acpi") &&
			t.Temperature >= 10 && t.Temperature <= 50 {
			return round2(t.Temperature)
		}
	}
	return -1
}

// isCPUTempValid checks if a temperature reading is within a plausible CPU range.
func isCPUTempValid(t float64) bool {
	return t >= 35 && t < 110
}
