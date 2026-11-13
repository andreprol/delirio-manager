package main

import (
	"fmt"
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

// TestListRemoteDirThisPCListaUnidades cobre o sentinela "Este Computador"
// -- dir == thisPCSentinel devolve as unidades (mockadas via
// listLogicalDrivesFn, mesma indireção de applyFileTransferFn etc.) em vez
// de tentar ler uma pasta de verdade com esse nome.
func TestListRemoteDirThisPCListaUnidades(t *testing.T) {
	original := listLogicalDrivesFn
	defer func() { listLogicalDrivesFn = original }()
	listLogicalDrivesFn = func() []remoteDirEntry {
		return []remoteDirEntry{{Name: "C:\\", IsDir: true}, {Name: "D:\\", IsDir: true}}
	}

	path, entries, err := listRemoteDir(thisPCSentinel)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if path != thisPCSentinel {
		t.Errorf("path = %q, want %q", path, thisPCSentinel)
	}
	if len(entries) != 2 || entries[0].Name != "C:\\" || entries[1].Name != "D:\\" {
		t.Errorf("entries = %+v, want unidades C:\\ e D:\\", entries)
	}
}

// TestListLogicalDrivesSempreTemC confirma a função REAL (sem mock) contra
// o Windows de verdade do ambiente de teste -- toda instalação Windows tem
// pelo menos a unidade C:, então C:\ sempre deve aparecer na lista.
func TestListLogicalDrivesSempreTemC(t *testing.T) {
	drives := listLogicalDrives()
	found := false
	for _, d := range drives {
		if d.Name == "C:\\" {
			found = true
		}
		if !d.IsDir {
			t.Errorf("unidade %q deveria ter IsDir=true", d.Name)
		}
	}
	if !found {
		t.Errorf("unidades = %+v, esperava encontrar C:\\ (toda instalação Windows tem)", drives)
	}
}

// TestListRemoteDirSuccess cobre o happy path do navegador de arquivos
// dual-pane: pastas primeiro, depois arquivos, cada grupo alfabético.
func TestListRemoteDirSuccess(t *testing.T) {
	tmp := t.TempDir()
	for _, name := range []string{"zebra.txt", "banana.txt"} {
		if err := os.WriteFile(filepath.Join(tmp, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"Zpasta", "Apasta"} {
		if err := os.Mkdir(filepath.Join(tmp, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	gotDir, entries, err := listRemoteDir(tmp)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if gotDir != tmp {
		t.Errorf("dir devolvido = %q, want %q", gotDir, tmp)
	}
	if len(entries) != 4 {
		t.Fatalf("entries = %d, want 4", len(entries))
	}
	// pastas primeiro (alfabético entre si), depois arquivos (alfabético entre si)
	wantOrder := []string{"Apasta", "Zpasta", "banana.txt", "zebra.txt"}
	for i, want := range wantOrder {
		if entries[i].Name != want {
			t.Errorf("entries[%d].Name = %q, want %q (ordem completa: %v)", i, entries[i].Name, want, entries)
		}
	}
	if !entries[0].IsDir || !entries[1].IsDir {
		t.Errorf("entries[0]/[1] deveriam ser pastas (IsDir=true)")
	}
	if entries[2].IsDir || entries[3].IsDir {
		t.Errorf("entries[2]/[3] deveriam ser arquivos (IsDir=false)")
	}
	if entries[2].Size != 1 {
		t.Errorf("banana.txt size = %d, want 1", entries[2].Size)
	}
}

func TestListRemoteDirDiretorioInexistente(t *testing.T) {
	tmp := t.TempDir()
	naoExiste := filepath.Join(tmp, "nao-existe")
	_, _, err := listRemoteDir(naoExiste)
	if err == nil {
		t.Fatal("esperava erro pra diretório inexistente")
	}
}

func TestListRemoteDirVazioUsaUserProfileDesktop(t *testing.T) {
	original := os.Getenv("USERPROFILE")
	defer os.Setenv("USERPROFILE", original)
	tmp := t.TempDir()
	os.Setenv("USERPROFILE", tmp)
	if err := os.MkdirAll(filepath.Join(tmp, "Desktop"), 0o755); err != nil {
		t.Fatal(err)
	}

	gotDir, _, err := listRemoteDir("")
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	wantDir := filepath.Join(tmp, "Desktop")
	if gotDir != wantDir {
		t.Errorf("dir = %q, want %q (USERPROFILE\\Desktop)", gotDir, wantDir)
	}
}

// TestListRemoteDirRespeitaTeto confirma que maxRemoteDirEntries corta a
// listagem em vez de devolver um payload gigante -- encurtado pra não
// precisar criar milhares de arquivos de verdade (mesmo padrão de
// maxUploadFileBytes acima, var pra teste).
func TestListRemoteDirRespeitaTeto(t *testing.T) {
	original := maxRemoteDirEntries
	defer func() { maxRemoteDirEntries = original }()
	maxRemoteDirEntries = 3

	tmp := t.TempDir()
	for i := 0; i < 10; i++ {
		if err := os.WriteFile(filepath.Join(tmp, fmt.Sprintf("arquivo-%02d.txt", i)), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	_, entries, err := listRemoteDir(tmp)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if len(entries) != 3 {
		t.Errorf("entries = %d, want 3 (teto respeitado)", len(entries))
	}
}

// TestListRemoteDirOrdenaAntesDeCortar é a regressão do achado 🟠 do
// code-reviewer: TestListRemoteDirRespeitaTeto acima só usa nomes
// puramente numéricos, onde a ordem bruta de os.ReadDir e a ordem final
// (pastas primeiro) coincidem -- nunca pegaria o bug de cortar pelo teto
// ANTES de reordenar. Aqui, "zzz-pasta" (uma PASTA) vem depois dos 3
// arquivos na ordem alfabética BRUTA (zzz > aaa/bbb/ccc) -- se o corte
// acontecesse antes da ordenação, "zzz-pasta" seria descartado mesmo
// devendo aparecer PRIMEIRO no resultado final (pastas sempre antes de
// arquivos).
func TestListRemoteDirOrdenaAntesDeCortar(t *testing.T) {
	original := maxRemoteDirEntries
	defer func() { maxRemoteDirEntries = original }()
	maxRemoteDirEntries = 3

	tmp := t.TempDir()
	for _, name := range []string{"aaa.txt", "bbb.txt", "ccc.txt"} {
		if err := os.WriteFile(filepath.Join(tmp, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(tmp, "zzz-pasta"), 0o755); err != nil {
		t.Fatal(err)
	}

	_, entries, err := listRemoteDir(tmp)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("entries = %d, want 3 (teto respeitado)", len(entries))
	}
	if entries[0].Name != "zzz-pasta" || !entries[0].IsDir {
		t.Errorf("entries[0] = %+v, want zzz-pasta (pasta) primeiro -- corte aconteceu antes da ordenação?", entries[0])
	}
}
