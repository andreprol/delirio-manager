package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// fileTransferStatus é o protocolo de volta pro dashboard (companion →
// relay → dashboard) — primeira vez que o companion manda TextMessage
// JSON nesse sentido (antes só vídeo binário).
type fileTransferStatus struct {
	Type          string `json:"type"` // "file-transfer-progress" | "file-transfer-done" | "file-transfer-error" | "file-download-progress" | "file-download-done" | "file-download-error"
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
	// Mesmo deadline do frame de vídeo (liveSessionWriteTimeout) — antes
	// esta escrita não setava deadline próprio nenhum, dependendo de
	// qualquer deadline que a ÚLTIMA chamada a SetWriteDeadline (do loop de
	// vídeo) tivesse deixado na conexão. Ver WriteMessageWithDeadline
	// (wsconn_windows.go) pro bug real que isso causava.
	deadline := time.Now().Add(liveSessionWriteTimeout)
	if err := w.WriteMessageWithDeadline(websocket.TextMessage, b, deadline); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao mandar status de transferencia: %v", err))
	}
}

// remoteDirEntry é 1 item (arquivo ou pasta) de uma listagem de diretório
// remoto -- navegador de arquivos dual-pane (FileBrowserModal.jsx).
type remoteDirEntry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"` // RFC3339, UTC
}

// remoteDirListing é o protocolo de volta pro dashboard (mesmo canal de
// texto de fileTransferStatus/sessionInfoMsg) em resposta a
// "list-remote-dir".
type remoteDirListing struct {
	Type      string           `json:"type"` // "remote-dir-listing" | "remote-dir-error"
	Path      string           `json:"path"`
	Entries   []remoteDirEntry `json:"entries,omitempty"`
	Message   string           `json:"message,omitempty"` // só em "remote-dir-error"
	RequestID int64            `json:"requestId,omitempty"`
}

func sendRemoteDirListing(w frameWriter, listing remoteDirListing) {
	if w == nil {
		return
	}
	b, err := json.Marshal(listing)
	if err != nil {
		logWarn(fmt.Sprintf("companion: falha ao serializar listagem de diretorio: %v", err))
		return
	}
	deadline := time.Now().Add(liveSessionWriteTimeout)
	if err := w.WriteMessageWithDeadline(websocket.TextMessage, b, deadline); err != nil {
		logWarn(fmt.Sprintf("companion: falha ao mandar listagem de diretorio: %v", err))
	}
}

// maxRemoteDirEntries limita quantas entradas uma listagem devolve -- uma
// pasta com dezenas de milhares de arquivos (ex: cache de algum app,
// pasta de logs) nao pode gerar um payload JSON gigante nem travar a UI do
// dashboard tentando renderizar tudo de uma vez. var, nao const, so pra
// teste poder encurtar sem precisar criar milhares de arquivos de verdade.
var maxRemoteDirEntries = 2000

// thisPCSentinel e o valor especial de "diretorio" que significa "mostra
// as unidades disponiveis" (C:, D:, etc.) em vez de listar uma pasta de
// verdade -- equivalente ao "Este Computador"/"This PC" do Explorer.
// Alcancado subindo (parentWindowsPath, dashboard) a partir da raiz de
// qualquer unidade -- antes disso, so dava pra navegar dentro da arvore
// que comeca em %USERPROFILE%\Desktop, sem jeito de ver OUTRAS unidades
// (D:, pendrive, etc.), que Andre pediu pra existir nas duas pontas.
const thisPCSentinel = "Este Computador"

// procGetLogicalDrives (kernel32, ja declarado em activity_windows.go)
// devolve um bitmask: bit 0 = unidade A existe, bit 1 = B, etc. --
// GetLogicalDriveStringsW tambem resolveria isso, mas exigiria um buffer
// de tamanho incerto; o bitmask e mais simples pra só confirmar existencia
// por letra.
var procGetLogicalDrives = kernel32.NewProc("GetLogicalDrives")

// listLogicalDrivesFn indirecona listLogicalDrives pra permitir mock em
// teste (chamar GetLogicalDrives de verdade exigiria rodar em Windows com
// as unidades exatas do ambiente de teste, nao portavel/determinístico).
var listLogicalDrivesFn = listLogicalDrives

// listLogicalDrives devolve cada unidade existente (A:\, C:\, etc.) como
// uma entrada de pasta -- usado quando dir == thisPCSentinel.
func listLogicalDrives() []remoteDirEntry {
	mask, _, _ := procGetLogicalDrives.Call()
	entries := make([]remoteDirEntry, 0, 4)
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		letter := string(rune('A' + i))
		entries = append(entries, remoteDirEntry{Name: letter + ":\\", IsDir: true})
	}
	return entries
}

// listRemoteDir lista dir (diretorio NESTE computador, remoto do ponto de
// vista do operador) -- dir vazio abre em %USERPROFILE%\Desktop (mesmo
// usuario interativo que o companion roda sob, ver session_windows.go);
// dir == thisPCSentinel lista as unidades disponiveis em vez de uma pasta
// de verdade. Entrada ilegivel (permissao, link quebrado) e pulada, nao
// derruba a listagem inteira -- 1 arquivo problematico nao pode impedir
// ver o resto da pasta.
func listRemoteDir(dir string) (string, []remoteDirEntry, error) {
	if dir == thisPCSentinel {
		return thisPCSentinel, listLogicalDrivesFn(), nil
	}
	if dir == "" {
		dir = filepath.Join(os.Getenv("USERPROFILE"), "Desktop")
	}
	dirEntries, err := os.ReadDir(dir)
	if err != nil {
		return dir, nil, fmt.Errorf("ler diretorio %q: %w", dir, err)
	}

	// Ordena ANTES de cortar pelo teto -- achado 🟠 do code-reviewer:
	// os.ReadDir devolve em ordem alfabética BRUTA (sem separar pastas de
	// arquivos). Cortar pelo teto antes de reordenar "pastas primeiro"
	// descartava uma pasta inteira sempre que seu nome vinha depois do
	// ponto de corte na ordem bruta, mesmo que ela devesse aparecer
	// PRIMEIRO no resultado final -- pastas primeiro, depois arquivos,
	// cada grupo em ordem alfabética (convenção universal de qualquer
	// navegador de arquivos: Explorer, FileZilla, etc.). Ordenar os
	// DirEntry crus (IsDir()/Name(), sem Info() ainda) é barato -- só
	// chama Info() (stat) nos que sobrarem depois do corte, abaixo.
	sort.Slice(dirEntries, func(i, j int) bool {
		if dirEntries[i].IsDir() != dirEntries[j].IsDir() {
			return dirEntries[i].IsDir()
		}
		return strings.ToLower(dirEntries[i].Name()) < strings.ToLower(dirEntries[j].Name())
	})

	entries := make([]remoteDirEntry, 0, min(len(dirEntries), maxRemoteDirEntries))
	for _, e := range dirEntries {
		if len(entries) >= maxRemoteDirEntries {
			break
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		entries = append(entries, remoteDirEntry{
			Name: e.Name(), IsDir: e.IsDir(), Size: info.Size(),
			ModTime: info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	return dir, entries, nil
}

// applyListRemoteDirFn indireciona applyListRemoteDir pra permitir mock em
// teste (mesmo padrao de applyFileTransferFn/applyFileDownloadFn).
var applyListRemoteDirFn = applyListRemoteDir

// applyListRemoteDir roda em goroutine separada -- mesmo motivo de
// applyFileTransfer/applyFileDownload: uma pasta de rede lenta ou disco
// ocupado nao pode bloquear a goroutine leitora de mouse/teclado. Ecoa
// msg.RequestID na resposta -- achado 🟡 do code-reviewer: cada
// "list-remote-dir" roda numa goroutine própria, sem ordem garantida de
// conclusão; sem o id de correlação, 2 navegações rápidas (ex: entrar numa
// pasta de rede lenta, depois "⬆" pra uma rápida) podiam ter a resposta
// mais lenta chegar DEPOIS e fazer a UI "voltar" pra um diretório já
// abandonado. O dashboard (useLiveSession.js) descarta qualquer resposta
// cujo requestId não seja o do último pedido que ele mesmo mandou.
func applyListRemoteDir(msg inputMessage, sessionID string, w frameWriter) {
	safeGo("list-remote-dir-"+sessionID, func() {
		dir, entries, err := listRemoteDir(msg.RemoteDir)
		if err != nil {
			sendRemoteDirListing(w, remoteDirListing{Type: "remote-dir-error", Path: dir, Message: err.Error(), RequestID: msg.RequestID})
			return
		}
		sendRemoteDirListing(w, remoteDirListing{Type: "remote-dir-listing", Path: dir, Entries: entries, RequestID: msg.RequestID})
	})
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

// sanitizeDownloadErr remove a downloadURL (SAS do Azure Blob, credencial na
// query string) de dentro do erro de rede antes de propagar. NAO BASTA so
// parar de interpolar downloadURL na nossa propria mensagem (fmt.Errorf):
// confirmado ao vivo que o proprio net/http ja embute a URL completa -- com
// query string e tudo -- dentro do *url.Error que http.Get devolve em
// QUALQUER falha de transporte (dial/DNS/timeout/connection refused), e
// Error() desse tipo imprime essa URL independente do %w usado por fora
// (`Get "http://host/path?sig=SEGREDO": dial tcp ...`). Mesma classe de
// risco que redactLiveSessionURL resolve pra outra URL neste mesmo arquivo
// (companionToken) -- aqui a URL mora dentro do tipo de erro do stdlib, nao
// numa string nossa, entao desembrulhamos o *url.Error e devolvemos so o
// erro de rede interno (ex: "dial tcp 127.0.0.1:1: connectex: ..."), que
// continua util pra diagnostico sem carregar a credencial.
func sanitizeDownloadErr(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
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
		return fmt.Errorf("download do arquivo falhou: %w", sanitizeDownloadErr(err))
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

	// filepath.Base defende contra um fileName com ".." ou caminho absoluto
	// escapando destDir via filepath.Join — nao e vetor de privilegio novo
	// (o mesmo operador ja controla teclado/mouse/shell na maquina remota),
	// mas custa 1 linha e elimina a pergunta.
	finalPath := filepath.Join(destDir, filepath.Base(fileName))
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return fmt.Errorf("mover pra destino final %q: %w", finalPath, err)
	}
	return nil
}

// maxUploadFileBytes espelha MAX_FILE_BYTES (server/services/blobSas.js) --
// a direcao remoto->operador nao tem o mesmo passo de validacao ANTES de
// comecar (o servidor nao sabe o tamanho do arquivo, so o operador informa
// um caminho), entao a checagem acontece aqui, cedo, depois do Stat, em vez
// de deixar um arquivo gigante estourar o limite de PUT de block blob do
// proprio Azure (~5000 MiB numa unica requisicao) no meio do upload. var,
// nao const, so pra TestUploadFileWithProgressAcimaDoLimite poder encurtar
// sem precisar criar um arquivo de teste de 2GB de verdade.
var maxUploadFileBytes int64 = 2 * 1024 * 1024 * 1024 // 2GB

// progressReader conta bytes lidos e chama onProgress no maximo 1x por
// progressThrottle -- espelho de progressWriter (upload em vez de
// download), mesmo motivo (io.Copy/http.NewRequest chamam Read varias
// vezes por segundo pra arquivo grande).
type progressReader struct {
	src        io.Reader
	sent       int64
	total      int64
	onProgress func(sent, total int64)
	lastSent   time.Time
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.src.Read(b)
	p.sent += int64(n)
	if time.Since(p.lastSent) >= progressThrottle {
		p.lastSent = time.Now()
		p.onProgress(p.sent, p.total)
	}
	return n, err
}

// uploadFileWithProgress le localPath (arquivo NESTA maquina, a remota do
// ponto de vista do operador) e sobe pro mesmo blob que uploadURL assina --
// espelho de downloadFileWithProgress, direcao contraria. x-ms-blob-type
// BlockBlob e obrigatorio pro Azure aceitar um PUT direto (sem isso devolve
// 400 MissingRequiredHeader) -- mesmo header que o lado dashboard (browser)
// ja manda pro upload local->remoto (ver sendLocalFileToRemote,
// LiveSessionWindow.jsx).
func uploadFileWithProgress(localPath, uploadURL string, onProgress func(sent, total int64)) error {
	f, err := os.Open(localPath) // #nosec -- caminho vem do operador que ja controla teclado/mouse/shell nesta sessao, nao e vetor de privilegio novo
	if err != nil {
		return fmt.Errorf("abrir arquivo %q: %w", localPath, err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("verificar arquivo %q: %w", localPath, err)
	}
	if info.IsDir() {
		return fmt.Errorf("%q é um diretório, não um arquivo", localPath)
	}
	total := info.Size()
	if total > maxUploadFileBytes {
		return fmt.Errorf("arquivo acima do limite de 2GB (%d bytes)", total)
	}

	pr := &progressReader{src: f, total: total, onProgress: onProgress}
	req, err := http.NewRequest(http.MethodPut, uploadURL, pr) // #nosec -- URL vem do servidor confiavel, SAS de escrita com expiracao curta
	if err != nil {
		// sanitizeDownloadErr tambem aqui (achado do code-reviewer): URL
		// malformada faz net/url devolver *url.Error, que embute a URL
		// COMPLETA -- com o SAS de escrita -- na propria Error(), igual ao
		// caso de http.DefaultClient.Do mais abaixo (ja sanitizado).
		return fmt.Errorf("criar requisição de upload: %w", sanitizeDownloadErr(err))
	}
	req.ContentLength = total
	req.Header.Set("x-ms-blob-type", "BlockBlob")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("upload do arquivo falhou: %w", sanitizeDownloadErr(err))
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("servidor retornou HTTP %d ao subir arquivo: %s", resp.StatusCode, body)
	}
	onProgress(total, total) // garante 1 última chamada com o total real
	return nil
}

// applyFileDownloadFn indireciona applyFileDownload pra permitir mock em
// teste (mesmo padrao de applyFileTransferFn acima).
var applyFileDownloadFn = applyFileDownload

// applyFileDownload dispara o upload em goroutine separada -- mesmo motivo
// de applyFileTransfer (upload de arquivo grande NAO PODE bloquear a
// goroutine leitora de mouse/teclado).
func applyFileDownload(msg inputMessage, sessionID string, w frameWriter) {
	safeGo("file-download-"+sessionID, func() {
		err := uploadFileWithProgress(msg.RemotePath, msg.UploadURL, func(sent, total int64) {
			sendFileTransferStatus(w, fileTransferStatus{
				Type: "file-download-progress", BytesReceived: sent, BytesTotal: total,
			})
		})
		if err != nil {
			logWarn(fmt.Sprintf("companion: envio de arquivo pro operador falhou: %v", err))
			sendFileTransferStatus(w, fileTransferStatus{Type: "file-download-error", Message: err.Error()})
			return
		}
		sendFileTransferStatus(w, fileTransferStatus{Type: "file-download-done"})
	})
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
