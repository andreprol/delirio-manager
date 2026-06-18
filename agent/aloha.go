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

// AlohaFileInfo descreve um arquivo encontrado em C:\Bootdrv.
type AlohaFileInfo struct {
	Path    string  `json:"path"`
	SizeMB  float64 `json:"size_mb"`
	ModTime string  `json:"mod_time"`
}

// AlohaXMLSummary resume os XMLs fiscais (DANFE/NF-Ce) sem listar todos.
type AlohaXMLSummary struct {
	Total      int             `json:"total"`
	LatestDate string          `json:"latest_date,omitempty"`
	Recent     []AlohaFileInfo `json:"recent"`
}

// AlohaScanResult e o payload completo retornado pelo comando aloha-scan.
type AlohaScanResult struct {
	ScannedAt     string          `json:"scanned_at"`
	BootdrvPath   string          `json:"bootdrv_path"`
	BootdrvExists bool            `json:"bootdrv_exists"`
	TotalFiles    int             `json:"total_files"`
	TotalSizeMB   float64         `json:"total_size_mb"`
	DatabaseFiles []AlohaFileInfo `json:"database_files"`
	ConfigFiles   []AlohaFileInfo `json:"config_files"`
	XMLFiscal     AlohaXMLSummary `json:"xml_fiscal"`
	Directories   []string        `json:"directories"`
	Error         string          `json:"error,omitempty"`
}

var alohaDbExt = map[string]bool{
	".mdb": true, ".mdf": true, ".ldf": true, ".ndf": true,
	".db": true, ".sqlite": true, ".sqlite3": true, ".sdf": true,
}

var alohaCfgExt = map[string]bool{
	".ini": true, ".cfg": true, ".conf": true, ".config": true,
}

// scanAloha percorre C:\Bootdrv e classifica os arquivos encontrados.
func scanAloha() AlohaScanResult {
	result := AlohaScanResult{
		ScannedAt:     time.Now().UTC().Format(time.RFC3339),
		BootdrvPath:   `C:\Bootdrv`,
		DatabaseFiles: []AlohaFileInfo{},
		ConfigFiles:   []AlohaFileInfo{},
		XMLFiscal:     AlohaXMLSummary{Recent: []AlohaFileInfo{}},
		Directories:   []string{},
	}

	info, err := os.Stat(result.BootdrvPath)
	if err != nil || !info.IsDir() {
		result.BootdrvExists = false
		result.Error = fmt.Sprintf("C:\\Bootdrv nao encontrado: %v", err)
		return result
	}
	result.BootdrvExists = true

	// Diretórios de primeiro nível
	entries, _ := os.ReadDir(result.BootdrvPath)
	for _, e := range entries {
		if e.IsDir() {
			result.Directories = append(result.Directories, e.Name())
		}
	}

	var xmlFiles []AlohaFileInfo
	var totalBytes int64

	filepath.WalkDir(result.BootdrvPath, func(path string, d os.DirEntry, werr error) error {
		if werr != nil || d.IsDir() {
			return nil
		}
		fi, ferr := d.Info()
		if ferr != nil {
			return nil
		}

		result.TotalFiles++
		totalBytes += fi.Size()

		relPath := strings.TrimPrefix(path, result.BootdrvPath+`\`)
		ext := strings.ToLower(filepath.Ext(path))
		sizeMB := alohaRoundMB(fi.Size())
		modTime := fi.ModTime().Format("2006-01-02T15:04:05Z")
		f := AlohaFileInfo{Path: relPath, SizeMB: sizeMB, ModTime: modTime}

		switch {
		case alohaDbExt[ext]:
			result.DatabaseFiles = append(result.DatabaseFiles, f)
		case ext == ".xml" || ext == ".nfe" || ext == ".nfce":
			xmlFiles = append(xmlFiles, f)
		case alohaCfgExt[ext]:
			result.ConfigFiles = append(result.ConfigFiles, f)
		}
		return nil
	})

	result.TotalSizeMB = alohaRoundMB(totalBytes)
	result.XMLFiscal.Total = len(xmlFiles)

	if len(xmlFiles) > 0 {
		// Ordena por data decrescente para pegar os mais recentes
		sort.Slice(xmlFiles, func(i, j int) bool {
			return xmlFiles[i].ModTime > xmlFiles[j].ModTime
		})
		result.XMLFiscal.LatestDate = xmlFiles[0].ModTime[:10]
		n := 10
		if len(xmlFiles) < n {
			n = len(xmlFiles)
		}
		result.XMLFiscal.Recent = xmlFiles[:n]
	}

	return result
}

func alohaRoundMB(bytes int64) float64 {
	return math.Round(float64(bytes)/1024/1024*100) / 100
}
