package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gorilla/websocket"
)

// fileTransferStatus é o protocolo de volta pro dashboard (companion →
// relay → dashboard) — primeira vez que o companion manda TextMessage
// JSON nesse sentido (antes só vídeo binário).
type fileTransferStatus struct {
	Type          string `json:"type"` // "file-transfer-progress" | "file-transfer-done" | "file-transfer-error"
	BytesReceived int64  `json:"bytesReceived,omitempty"`
	BytesTotal    int64  `json:"bytesTotal,omitempty"`
	Message       string `json:"message,omitempty"`
}

func sendFileTransferStatus(w frameWriter, status fileTransferStatus) {
	if w == nil {
		return
	}
	b, err := json.Marshal(status)
	if err != nil {
		logWarn(fmt.Sprintf("companion: falha ao serializar status de transferencia: %v", err))
		return
	}
	if err := w.WriteMessage(websocket.TextMessage, b); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao mandar status de transferencia: %v", err))
	}
}

// progressWriter conta bytes escritos e chama onProgress no maximo 1x por
// progressThrottle — io.Copy chama Write varias vezes por segundo pra
// arquivo grande, sem throttle isso inundaria o WS de mensagens de status.
const progressThrottle = 1 * time.Second

type progressWriter struct {
	dest       io.Writer
	received   int64
	total      int64
	onProgress func(received, total int64)
	lastSent   time.Time
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, err := p.dest.Write(b)
	p.received += int64(n)
	if time.Since(p.lastSent) >= progressThrottle {
		p.lastSent = time.Now()
		p.onProgress(p.received, p.total)
	}
	return n, err
}

// downloadFileWithProgress baixa downloadURL pra destDir/fileName — mesmo
// padrao de downloadBinary (updater.go): escreve num temp no MESMO
// diretorio final (garante que o rename seja atomico, sem cruzar volume)
// e so substitui o destino depois do download completo.
func downloadFileWithProgress(downloadURL, destDir, fileName string, onProgress func(received, total int64)) error {
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return fmt.Errorf("criar diretorio de destino %q: %w", destDir, err)
	}

	resp, err := http.Get(downloadURL) // #nosec — URL vem do servidor confiavel, SAS de leitura
	if err != nil {
		return fmt.Errorf("GET %s: %w", downloadURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("servidor retornou HTTP %d ao baixar arquivo", resp.StatusCode)
	}

	f, err := os.CreateTemp(destDir, "delirio-filetransfer-*")
	if err != nil {
		return fmt.Errorf("criar arquivo temporario em %q: %w", destDir, err)
	}
	tmpPath := f.Name()
	defer func() {
		f.Close()
		if _, err := os.Stat(tmpPath); err == nil {
			os.Remove(tmpPath)
		}
	}()

	pw := &progressWriter{dest: f, total: resp.ContentLength, onProgress: onProgress}
	if _, err := io.Copy(pw, resp.Body); err != nil {
		return fmt.Errorf("download incompleto: %w", err)
	}
	onProgress(pw.received, pw.total) // garante 1 ultima chamada com o total real

	if err := f.Close(); err != nil {
		return fmt.Errorf("fechar arquivo temporario: %w", err)
	}

	finalPath := filepath.Join(destDir, fileName)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return fmt.Errorf("mover pra destino final %q: %w", finalPath, err)
	}
	return nil
}

// applyFileTransferFn indireciona applyFileTransfer pra permitir mock em
// teste (mesmo padrao de injectMouseMoveFn etc. em input_windows.go).
var applyFileTransferFn = applyFileTransfer

// applyFileTransfer dispara o download em goroutine separada — download de
// arquivo grande NAO PODE bloquear a goroutine leitora de mouse/teclado
// (readLiveSessionInput), senao o operador trava enquanto o arquivo baixa.
func applyFileTransfer(msg inputMessage, sessionID string, w frameWriter) {
	safeGo("file-transfer-"+sessionID, func() {
		err := downloadFileWithProgress(msg.DownloadURL, msg.DestDir, msg.FileName, func(received, total int64) {
			sendFileTransferStatus(w, fileTransferStatus{
				Type: "file-transfer-progress", BytesReceived: received, BytesTotal: total,
			})
		})
		if err != nil {
			logWarn(fmt.Sprintf("companion: transferencia de arquivo falhou: %v", err))
			sendFileTransferStatus(w, fileTransferStatus{Type: "file-transfer-error", Message: err.Error()})
			return
		}
		sendFileTransferStatus(w, fileTransferStatus{Type: "file-transfer-done"})
	})
}
