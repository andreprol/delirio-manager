package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// ── fileSHA256 ────────────────────────────────────────────────────────────────

func TestFileSHA256(t *testing.T) {
	t.Run("hash correto para conteudo conhecido", func(t *testing.T) {
		content := []byte("Delirio Manager Agent v1.5.18")

		f, err := os.CreateTemp(t.TempDir(), "sha-test-*")
		if err != nil {
			t.Fatal(err)
		}
		f.Write(content)
		f.Close()

		got, err := fileSHA256(f.Name())
		if err != nil {
			t.Fatalf("fileSHA256: %v", err)
		}

		h := sha256.Sum256(content)
		want := hex.EncodeToString(h[:])
		if got != want {
			t.Errorf("hash incorreto\ngot  %s\nwant %s", got, want)
		}
	})

	t.Run("arquivo vazio tem hash valido (nao erro)", func(t *testing.T) {
		f, err := os.CreateTemp(t.TempDir(), "sha-empty-*")
		if err != nil {
			t.Fatal(err)
		}
		f.Close()

		got, err := fileSHA256(f.Name())
		if err != nil {
			t.Fatalf("fileSHA256 em arquivo vazio: %v", err)
		}
		if len(got) != 64 {
			t.Errorf("hash deve ter 64 chars hex, got %d", len(got))
		}
	})

	t.Run("arquivo inexistente retorna erro", func(t *testing.T) {
		_, err := fileSHA256("/nao/existe/arquivo.bin")
		if err == nil {
			t.Error("esperava erro para arquivo inexistente")
		}
	})
}

// ── validateBinary ────────────────────────────────────────────────────────────

func makeTempBinary(t *testing.T, size int, magic [2]byte) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test-agent.exe")

	content := make([]byte, size)
	content[0] = magic[0]
	content[1] = magic[1]

	if err := os.WriteFile(path, content, 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestValidateBinary(t *testing.T) {
	const MB = 1024 * 1024

	t.Run("binario valido — MZ + tamanho OK", func(t *testing.T) {
		path := makeTempBinary(t, 2*MB, [2]byte{0x4D, 0x5A})
		if err := validateBinary(path, "1.5.19"); err != nil {
			t.Errorf("nao esperava erro: %v", err)
		}
	})

	t.Run("arquivo muito pequeno (< 1 MB)", func(t *testing.T) {
		path := makeTempBinary(t, 512*1024, [2]byte{0x4D, 0x5A})
		if err := validateBinary(path, "1.5.19"); err == nil {
			t.Error("esperava erro para binario < 1 MB")
		}
	})

	t.Run("magic bytes incorretos — nao e PE Windows", func(t *testing.T) {
		path := makeTempBinary(t, 2*MB, [2]byte{0x7F, 0x45}) // ELF header
		if err := validateBinary(path, "1.5.19"); err == nil {
			t.Error("esperava erro para magic bytes != MZ")
		}
	})

	t.Run("magic bytes zerados", func(t *testing.T) {
		path := makeTempBinary(t, 2*MB, [2]byte{0x00, 0x00})
		if err := validateBinary(path, "1.5.19"); err == nil {
			t.Error("esperava erro para magic bytes zerados")
		}
	})

	t.Run("arquivo inexistente", func(t *testing.T) {
		if err := validateBinary("/nao/existe.exe", "1.5.19"); err == nil {
			t.Error("esperava erro para arquivo inexistente")
		}
	})

	t.Run("exatamente 1 MB — borda valida", func(t *testing.T) {
		path := makeTempBinary(t, 1*MB, [2]byte{0x4D, 0x5A})
		if err := validateBinary(path, "1.5.19"); err != nil {
			t.Errorf("1 MB exato deve ser valido: %v", err)
		}
	})
}

// ── downloadBinary ────────────────────────────────────────────────────────────

func TestDownloadBinary(t *testing.T) {
	t.Run("download bem-sucedido — conteudo correto no destino", func(t *testing.T) {
		payload := []byte{0x4D, 0x5A, 0x01, 0x02, 0x03}

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write(payload)
		}))
		defer srv.Close()

		dest := filepath.Join(t.TempDir(), "agent.exe")
		if err := downloadBinary(srv.URL+"/downloads/delirio-agent.exe", dest); err != nil {
			t.Fatalf("downloadBinary: %v", err)
		}

		got, err := os.ReadFile(dest)
		if err != nil {
			t.Fatalf("ler destino: %v", err)
		}
		if string(got) != string(payload) {
			t.Errorf("conteudo incorreto\ngot  %v\nwant %v", got, payload)
		}
	})

	t.Run("servidor retorna 404 — erro", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		}))
		defer srv.Close()

		dest := filepath.Join(t.TempDir(), "agent.exe")
		if err := downloadBinary(srv.URL+"/nao-existe.exe", dest); err == nil {
			t.Error("esperava erro para HTTP 404")
		}
	})

	t.Run("servidor retorna 500 — erro", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer srv.Close()

		dest := filepath.Join(t.TempDir(), "agent.exe")
		if err := downloadBinary(srv.URL+"/agent.exe", dest); err == nil {
			t.Error("esperava erro para HTTP 500")
		}
	})

	t.Run("URL invalida — erro de conexao", func(t *testing.T) {
		dest := filepath.Join(t.TempDir(), "agent.exe")
		if err := downloadBinary("http://localhost:1/agent.exe", dest); err == nil {
			t.Error("esperava erro de conexao")
		}
	})
}
