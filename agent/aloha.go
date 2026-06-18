package main

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
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
	DatabaseFiles []AlohaFileInfo  `json:"database_files"` // .DBF em C:\Bootdrv (sem AlohaFiscal)
	NFCe          AlohaNFCeSummary `json:"nfce"`           // XMLs em AlohaFiscal\ServerData\XML
	Error         string           `json:"error,omitempty"`
}

// scanAloha realiza dois scans focados:
//  1. Arquivos .DBF em C:\Bootdrv (banco de dados Aloha, ignora subdir AlohaFiscal)
//  2. XMLs de NF-Ce em C:\Bootdrv\AlohaFiscal\ServerData\XML
func scanAloha() AlohaScanResult {
	result := AlohaScanResult{
		ScannedAt:     time.Now().UTC().Format(time.RFC3339),
		DatabaseFiles: []AlohaFileInfo{},
		NFCe:          AlohaNFCeSummary{Recent: []AlohaFileInfo{}},
	}

	if _, err := os.Stat(alohaBootdrvPath); err != nil {
		result.BootdrvExists = false
		result.Error = fmt.Sprintf("C:\\Bootdrv nao encontrado: %v", err)
		return result
	}
	result.BootdrvExists = true

	// ── 1. Banco de dados: arquivos .DBF em C:\Bootdrv ──────────────────────
	filepath.WalkDir(alohaBootdrvPath, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			return nil
		}
		if d.IsDir() {
			// Pula a árvore AlohaFiscal — contém milhares de XMLs, não DBFs
			if strings.EqualFold(d.Name(), "AlohaFiscal") {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.EqualFold(filepath.Ext(path), ".dbf") {
			fi, err := d.Info()
			if err != nil {
				return nil
			}
			result.DatabaseFiles = append(result.DatabaseFiles, AlohaFileInfo{
				Path:    filepath.Base(path),
				SizeMB:  alohaRoundMB(fi.Size()),
				ModTime: fi.ModTime().Format("2006-01-02T15:04:05Z"),
			})
		}
		return nil
	})

	// Ordena por tamanho decrescente (arquivos mais importantes primeiro)
	sort.Slice(result.DatabaseFiles, func(i, j int) bool {
		return result.DatabaseFiles[i].SizeMB > result.DatabaseFiles[j].SizeMB
	})

	// ── 2. NF-Ce: XMLs em C:\Bootdrv\AlohaFiscal\ServerData\XML ────────────
	if _, err := os.Stat(alohaNFCePath); err != nil {
		result.NFCe.PathExists = false
		return result
	}
	result.NFCe.PathExists = true

	var xmlFiles []AlohaFileInfo
	filepath.WalkDir(alohaNFCePath, func(path string, d os.DirEntry, werr error) error {
		if werr != nil || d.IsDir() {
			return nil
		}
		if !strings.EqualFold(filepath.Ext(path), ".xml") {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		xmlFiles = append(xmlFiles, AlohaFileInfo{
			Path:    filepath.Base(path),
			SizeMB:  alohaRoundMB(fi.Size()),
			ModTime: fi.ModTime().Format("2006-01-02T15:04:05Z"),
		})
		return nil
	})

	result.NFCe.Total = len(xmlFiles)
	if len(xmlFiles) > 0 {
		sort.Slice(xmlFiles, func(i, j int) bool {
			return xmlFiles[i].ModTime > xmlFiles[j].ModTime
		})
		result.NFCe.LatestDate = xmlFiles[0].ModTime[:10]
		n := 10
		if len(xmlFiles) < n {
			n = len(xmlFiles)
		}
		result.NFCe.Recent = xmlFiles[:n]
	}

	return result
}

func alohaRoundMB(bytes int64) float64 {
	return math.Round(float64(bytes)/1024/1024*100) / 100
}
