package main

import (
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
