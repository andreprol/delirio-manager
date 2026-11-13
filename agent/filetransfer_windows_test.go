package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestDownloadFileWithProgressSuccess(t *testing.T) {
	content := strings.Repeat("x", 10000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Content-Length explicito: sem isso, net/http/httptest manda a
		// resposta em chunked transfer encoding pra um corpo deste tamanho
		// (escrito num Write só, acima do buffer de auto-detecção do
		// servidor) e resp.ContentLength chega -1 no cliente — nunca o caso
		// real contra Azure Blob SAS (sempre reporta Content-Length numa
		// GET), então fixamos aqui pra o teste refletir o caminho real.
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.Write([]byte(content))
	}))
	defer srv.Close()

	destDir := t.TempDir()
	var lastReceived, lastTotal int64
	err := downloadFileWithProgress(srv.URL, destDir, "arquivo.txt", func(received, total int64) {
		lastReceived, lastTotal = received, total
	})
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(destDir, "arquivo.txt"))
	if err != nil {
		t.Fatalf("ler arquivo final: %v", err)
	}
	if string(data) != content {
		t.Errorf("conteudo nao bate, len=%d esperado=%d", len(data), len(content))
	}
	if lastReceived != int64(len(content)) {
		t.Errorf("progresso final = %d, esperado %d", lastReceived, len(content))
	}
	if lastTotal != int64(len(content)) {
		t.Errorf("total = %d, esperado %d", lastTotal, len(content))
	}
}

func TestDownloadFileWithProgressHttpError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	err := downloadFileWithProgress(srv.URL, t.TempDir(), "a.txt", func(int64, int64) {})
	if err == nil {
		t.Fatal("esperava erro pra HTTP 403")
	}
}

func TestDownloadFileWithProgressNetworkErrorDoesNotLeakUrl(t *testing.T) {
	// URL com um "SAS token" fake na query string, que a falha de conexao
	// (host invalido/porta fechada) NUNCA deveria vazar na mensagem de erro —
	// achado real do code review: o erro antigo interpolava a URL inteira
	// (e, mais sutil ainda: o PROPRIO net/http tambem embute a URL completa
	// dentro do *url.Error que http.Get devolve em falha de transporte,
	// independente do %w usado por fora — so trocar o fmt.Errorf nao bastava).
	downloadURL := "http://127.0.0.1:1/arquivo?sv=2021&se=2026-01-01&sig=SEGREDO-FAKE-NAO-PODE-VAZAR"

	err := downloadFileWithProgress(downloadURL, t.TempDir(), "a.txt", func(int64, int64) {})
	if err == nil {
		t.Fatal("esperava erro de conexao (porta 1 nao deve ter nada escutando)")
	}
	if strings.Contains(err.Error(), "SEGREDO-FAKE-NAO-PODE-VAZAR") {
		t.Fatalf("mensagem de erro vazou o SAS token da URL: %v", err)
	}
	if strings.Contains(err.Error(), "?") {
		t.Fatalf("mensagem de erro contem a query string da URL (pode conter credencial): %v", err)
	}
}

func TestDownloadFileWithProgressDestinoSemPermissao(t *testing.T) {
	tmp := t.TempDir()
	blockedPath := filepath.Join(tmp, "nao-e-diretorio")
	if err := os.WriteFile(blockedPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("x"))
	}))
	defer srv.Close()

	err := downloadFileWithProgress(srv.URL, filepath.Join(blockedPath, "sub"), "a.txt", func(int64, int64) {})
	if err == nil {
		t.Fatal("esperava erro ao criar diretorio dentro de um arquivo")
	}
}

// TestUploadFileWithProgressSuccess cobre a direção contrária (remoto ->
// operador): companion lê um arquivo LOCAL (do ponto de vista da máquina
// remota) e sobe pro blob via PUT — espelho de
// TestDownloadFileWithProgressSuccess.
func TestUploadFileWithProgressSuccess(t *testing.T) {
	content := strings.Repeat("y", 10000)
	tmp := t.TempDir()
	localPath := filepath.Join(tmp, "relatorio.pdf")
	if err := os.WriteFile(localPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	var gotMethod, gotBlobType string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotBlobType = r.Header.Get("x-ms-blob-type")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated) // Azure Blob PUT bem-sucedido devolve 201
	}))
	defer srv.Close()

	var lastSent, lastTotal int64
	err := uploadFileWithProgress(localPath, srv.URL, func(sent, total int64) {
		lastSent, lastTotal = sent, total
	})
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if gotMethod != http.MethodPut {
		t.Errorf("método = %q, want PUT", gotMethod)
	}
	if gotBlobType != "BlockBlob" {
		t.Errorf("x-ms-blob-type = %q, want BlockBlob (Azure recusa PUT direto sem isso)", gotBlobType)
	}
	if string(gotBody) != content {
		t.Errorf("corpo enviado não bate, len=%d esperado=%d", len(gotBody), len(content))
	}
	if lastSent != int64(len(content)) || lastTotal != int64(len(content)) {
		t.Errorf("progresso final = %d/%d, esperado %d/%d", lastSent, lastTotal, len(content), len(content))
	}
}

func TestUploadFileWithProgressArquivoInexistente(t *testing.T) {
	err := uploadFileWithProgress(filepath.Join(t.TempDir(), "nao-existe.txt"), "http://127.0.0.1:1/x", func(int64, int64) {})
	if err == nil {
		t.Fatal("esperava erro pra arquivo inexistente")
	}
}

func TestUploadFileWithProgressCaminhoEhDiretorio(t *testing.T) {
	err := uploadFileWithProgress(t.TempDir(), "http://127.0.0.1:1/x", func(int64, int64) {})
	if err == nil {
		t.Fatal("esperava erro pra caminho que é diretório, não arquivo")
	}
}

func TestUploadFileWithProgressHttpError(t *testing.T) {
	tmp := t.TempDir()
	localPath := filepath.Join(tmp, "a.txt")
	if err := os.WriteFile(localPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	err := uploadFileWithProgress(localPath, srv.URL, func(int64, int64) {})
	if err == nil {
		t.Fatal("esperava erro pra HTTP 403")
	}
}

// TestUploadFileWithProgressNetworkErrorDoesNotLeakUrl: mesmo achado real
// de TestDownloadFileWithProgressNetworkErrorDoesNotLeakUrl, agora na
// direção de upload — a uploadURL (SAS de ESCRITA) é tão sensível quanto a
// de leitura, não pode vazar numa mensagem de erro.
func TestUploadFileWithProgressNetworkErrorDoesNotLeakUrl(t *testing.T) {
	tmp := t.TempDir()
	localPath := filepath.Join(tmp, "a.txt")
	if err := os.WriteFile(localPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	uploadURL := "http://127.0.0.1:1/arquivo?sv=2021&se=2026-01-01&sig=SEGREDO-FAKE-NAO-PODE-VAZAR"

	err := uploadFileWithProgress(localPath, uploadURL, func(int64, int64) {})
	if err == nil {
		t.Fatal("esperava erro de conexao (porta 1 nao deve ter nada escutando)")
	}
	if strings.Contains(err.Error(), "SEGREDO-FAKE-NAO-PODE-VAZAR") {
		t.Fatalf("mensagem de erro vazou o SAS token da URL: %v", err)
	}
	if strings.Contains(err.Error(), "?") {
		t.Fatalf("mensagem de erro contem a query string da URL (pode conter credencial): %v", err)
	}
}

func TestUploadFileWithProgressAcimaDoLimite(t *testing.T) {
	original := maxUploadFileBytes
	defer func() { maxUploadFileBytes = original }()
	maxUploadFileBytes = 10 // encurta pra não precisar criar um arquivo de 2GB de verdade

	tmp := t.TempDir()
	localPath := filepath.Join(tmp, "a.txt")
	if err := os.WriteFile(localPath, []byte("conteudo-maior-que-10-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	err := uploadFileWithProgress(localPath, "http://127.0.0.1:1/x", func(int64, int64) {})
	if err == nil {
		t.Fatal("esperava erro por exceder o limite")
	}
	if !strings.Contains(err.Error(), "limite") {
		t.Errorf("mensagem de erro = %q, esperava mencionar o limite", err.Error())
	}
}
