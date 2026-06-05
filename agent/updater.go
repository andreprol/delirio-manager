package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// UpdateInfo e retornado pelo servidor no heartbeat ou em /api/agent/version
type UpdateInfo struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
}

// checkAndUpdate verifica se ha nova versao e faz a substituicao do binario.
// Usa o rename trick do Windows: e possivel renomear um exe em execucao.
// Apos substituir o arquivo, sai com codigo 1 para o SCM reiniciar o servico
// com o novo binario.
func (a *Agent) checkAndUpdate(latest UpdateInfo) {
	if latest.Version == "" || latest.Version == Version {
		return
	}

	logInfo(fmt.Sprintf("Nova versao disponivel: %s (atual: %s). Iniciando atualizacao...", latest.Version, Version))

	exe, err := os.Executable()
	if err != nil {
		logError("Nao foi possivel determinar caminho do executavel: " + err.Error())
		return
	}
	exe, _ = filepath.Abs(exe)
	newExe := exe + ".new"
	oldExe := exe + ".old"

	// 1. Baixa novo binario
	if err := downloadBinary(a.cfg.ServerURL+"/downloads/delirio-agent.exe", newExe); err != nil {
		logError("Download da atualizacao falhou: " + err.Error())
		os.Remove(newExe)
		return
	}

	// 2. Valida hash SHA256
	if latest.SHA256 != "" {
		hash, err := fileSHA256(newExe)
		if err != nil || hash != latest.SHA256 {
			logError(fmt.Sprintf("Hash invalido! Esperado: %s, Obtido: %s", latest.SHA256, hash))
			os.Remove(newExe)
			return
		}
		logInfo("Hash SHA256 validado com sucesso.")
	}

	// 3. Rename trick: renomeia o exe atual para .old (permitido mesmo em uso),
	//    depois renomeia o .new para o nome original.
	os.Remove(oldExe) // limpa .old de atualizacao anterior, se houver

	if err := os.Rename(exe, oldExe); err != nil {
		logError("Falha ao renomear exe atual: " + err.Error())
		os.Remove(newExe)
		return
	}

	if err := os.Rename(newExe, exe); err != nil {
		os.Rename(oldExe, exe) // rollback
		logError("Falha ao colocar novo exe no lugar: " + err.Error())
		return
	}

	// 4. Sai com codigo nao-zero — o SCM aplica a recovery action e reinicia
	//    o servico com o novo binario ja no lugar.
	logInfo("Atualizacao aplicada. Encerrando para o SCM reiniciar com nova versao...")
	os.Exit(1)
}

// cleanOldExe remove o .old deixado por uma atualizacao anterior.
// Chamado na inicializacao do agente.
func cleanOldExe() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	exe, _ = filepath.Abs(exe)
	os.Remove(exe + ".old")
}

// downloadBinary baixa um arquivo para o destino especificado.
func downloadBinary(url, dest string) error {
	resp, err := http.Get(url) // #nosec — URL vem da config confiavel
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("servidor retornou HTTP %d", resp.StatusCode)
	}

	f, err := os.CreateTemp(filepath.Dir(dest), "delirio-update-*")
	if err != nil {
		return fmt.Errorf("criar arquivo temporario: %w", err)
	}
	tmpPath := f.Name()
	defer func() {
		f.Close()
		if _, err := os.Stat(tmpPath); err == nil {
			os.Remove(tmpPath)
		}
	}()

	if _, err := io.Copy(f, resp.Body); err != nil {
		return fmt.Errorf("download incompleto: %w", err)
	}
	f.Close()

	return os.Rename(tmpPath, dest)
}

// fileSHA256 calcula o hash SHA256 de um arquivo.
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
