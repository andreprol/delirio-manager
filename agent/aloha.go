package main

import (
	"fmt"
	"math"
	"os"
	"time"
)

const (
	alohaBootdrvPath = `C:\Bootdrv`
	alohaNFCePath    = `C:\Bootdrv\AlohaFiscal\ServerData\XML`
)

// AlohaFileInfo descreve um arquivo encontrado no BOH.
type AlohaFileInfo struct {
	Path    string  `json:"path"`
	SizeMB  float64 `json:"size_mb"`
	ModTime string  `json:"mod_time"`
}

// AlohaNFCeSummary resume os XMLs de NF-Ce em C:\Bootdrv\AlohaFiscal\ServerData\XML.
type AlohaNFCeSummary struct {
	PathExists bool            `json:"path_exists"`
	Total      int             `json:"total"`
	LatestDate string          `json:"latest_date,omitempty"`
	Recent     []AlohaFileInfo `json:"recent"`
}

// AlohaScanResult é o payload retornado pelo comando aloha-scan.
type AlohaScanResult struct {
	ScannedAt     string           `json:"scanned_at"`
	BootdrvExists bool             `json:"bootdrv_exists"`
	NFCe          AlohaNFCeSummary `json:"nfce"` // XMLs em AlohaFiscal\ServerData\XML
	Error         string           `json:"error,omitempty"`
}

// scanAloha verifica existência e estrutura de C:\Bootdrv\AlohaFiscal\ServerData\XML.
// Usa apenas listNFCeMonths (leitura de diretórios, 3 níveis) — NÃO percorre arquivos
// individuais, evitando walk de 100k+ XMLs que trava o agente por 1-3 minutos em BOHs
// com histórico de anos.
func scanAloha() AlohaScanResult {
	result := AlohaScanResult{
		ScannedAt: time.Now().UTC().Format(time.RFC3339),
		NFCe:      AlohaNFCeSummary{Recent: []AlohaFileInfo{}},
	}

	if _, err := os.Stat(alohaBootdrvPath); err != nil {
		result.BootdrvExists = false
		result.Error = fmt.Sprintf("C:\\Bootdrv nao encontrado: %v", err)
		return result
	}
	result.BootdrvExists = true

	if _, err := os.Stat(alohaNFCePath); err != nil {
		result.NFCe.PathExists = false
		return result
	}
	result.NFCe.PathExists = true

	// Usa listNFCeMonths para derivar resumo — só percorre pastas ano/mês/dia (rápido)
	months := listNFCeMonths()
	totalDays := 0
	latestKey := ""
	for _, m := range months.Months {
		totalDays += len(m.Days)
		for _, d := range m.Days {
			key := m.Year + m.Month + d
			if key > latestKey {
				latestKey = key
			}
		}
	}
	// Total aproximado: número de pastas de dia (cada pasta tem ~dezenas a centenas de XMLs)
	result.NFCe.Total = totalDays
	if latestKey != "" && len(latestKey) == 8 {
		result.NFCe.LatestDate = latestKey[0:4] + "-" + latestKey[4:6] + "-" + latestKey[6:8]
	}

	return result
}

func alohaRoundMB(bytes int64) float64 {
	return math.Round(float64(bytes)/1024/1024*100) / 100
}
