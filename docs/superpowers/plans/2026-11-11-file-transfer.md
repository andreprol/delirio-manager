# Transferência de Arquivo (Operador → Máquina Remota) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar o operador arrastar (ou escolher) um arquivo na janela da sessão ao vivo e colocá-lo
numa pasta da máquina remota, suportando arquivos grandes (até 2GB) sem travar mouse/teclado em
tempo real.

**Architecture:** Dashboard pede SAS de upload+download ao servidor → sobe o arquivo direto pro
Azure Blob (bytes nunca passam pelo Node) → manda comando leve pelo WS `/live` já existente →
companion baixa via HTTPS (mesmo padrão do auto-update) e escreve no destino, reportando
progresso/erro de volta pelo mesmo WS, numa conexão agora com escrita thread-safe (vídeo + status
concorrentes).

**Tech Stack:** `@azure/storage-blob` (servidor), Go + `gorilla/websocket` (companion), React +
Electron IPC (dashboard).

**Spec:** `docs/superpowers/specs/2026-11-11-acesso-remoto-winkey-file-transfer-design.md`

**Pré-requisito de infra (fora deste plano, fazer antes do deploy em produção):** criar o container
`dtmanagerdr/live-transfer` no Azure Blob Storage + regra de lifecycle (auto-expira blobs em 24h).
Não é tarefa de código — André autoriza/roda, ou autoriza esta sessão a rodar via `az storage
container create` + `az storage container-rm` (lifecycle policy).

---

## Grupo 1 — Servidor (SAS de upload/download)

### Task 1: Dependência + config de Storage

**Files:**
- Modify: `server/package.json`
- Modify: `server/config.example.json`

- [ ] **Step 1: Instalar o SDK do Azure Blob**

Run: `cd server && npm install @azure/storage-blob`
Expected: `package.json`/`package-lock.json` ganham a dependência, sem erro.

- [ ] **Step 2: Documentar os campos novos de config**

Em `server/config.example.json`, adicionar (mantendo os campos existentes):

```json
{
  "blobStorage": {
    "accountName": "dtmanagerdr",
    "accountKey": "TROCAR-POR-ACCOUNT-KEY-REAL-AQUI",
    "container": "live-transfer"
  },
  "alerts": {
```

(campos existentes de `alerts`/`insights`/`autoWake`/`whatsapp`/`adminSecret` continuam como estão
— só inserir `blobStorage` como novo campo de topo antes de `alerts`.)

- [ ] **Step 3: Commit**

```bash
cd server
git add package.json package-lock.json config.example.json
git commit -m "chore(server): adiciona @azure/storage-blob + campo blobStorage no config.example

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 2: Módulo `blobSas.js` — gera SAS de upload + download

**Files:**
- Create: `server/services/blobSas.js`
- Test: `server/services/blobSas.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```javascript
// server/services/blobSas.test.js
'use strict';

jest.mock('fs');
jest.mock('@azure/storage-blob', () => ({
  StorageSharedKeyCredential: jest.fn().mockImplementation((account, key) => ({ account, key })),
  generateBlobSASQueryParameters: jest.fn(() => ({ toString: () => 'sig=fake&se=fake' })),
  BlobSASPermissions: { parse: jest.fn((s) => s) },
}));

const fs = require('fs');

function mockConfig(cfg) {
  fs.readFileSync.mockReturnValue(JSON.stringify(cfg));
}

describe('blobSas.generateFileTransferUrls', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('lança erro claro se blobStorage não está configurado', () => {
    mockConfig({});
    const { generateFileTransferUrls } = require('./blobSas');
    expect(() => generateFileTransferUrls({ fileName: 'a.txt', fileSize: 100 }))
      .toThrow(/blobStorage não configurado/);
  });

  it('recusa arquivo acima de 2GB', () => {
    mockConfig({ blobStorage: { accountName: 'acc', accountKey: 'key', container: 'live-transfer' } });
    const { generateFileTransferUrls } = require('./blobSas');
    const TWO_GB_PLUS_1 = 2 * 1024 * 1024 * 1024 + 1;
    expect(() => generateFileTransferUrls({ fileName: 'a.txt', fileSize: TWO_GB_PLUS_1 }))
      .toThrow(/2GB/);
  });

  it('retorna uploadUrl e downloadUrl pro mesmo blob, dentro do limite', () => {
    mockConfig({ blobStorage: { accountName: 'acc', accountKey: 'key', container: 'live-transfer' } });
    const { generateFileTransferUrls } = require('./blobSas');
    const result = generateFileTransferUrls({ fileName: 'instalador.exe', fileSize: 1024 });
    expect(result.uploadUrl).toContain('acc.blob.core.windows.net');
    expect(result.uploadUrl).toContain('live-transfer');
    expect(result.downloadUrl).toContain('acc.blob.core.windows.net');
    expect(result.blobName).toMatch(/instalador\.exe$/);
    // uploadUrl e downloadUrl apontam pro MESMO blob
    const uploadPath = new URL(result.uploadUrl).pathname;
    const downloadPath = new URL(result.downloadUrl).pathname;
    expect(uploadPath).toBe(downloadPath);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha (módulo não existe ainda)**

Run: `cd server && npx jest services/blobSas.test.js`
Expected: FAIL — `Cannot find module './blobSas'`.

- [ ] **Step 3: Implementar `blobSas.js`**

```javascript
// server/services/blobSas.js
'use strict';

// Gera URLs assinadas (SAS) de upload (escrita) e download (leitura) pro
// MESMO blob, pra transferência de arquivo operador→máquina remota
// (Acesso Remoto). Bytes do arquivo nunca passam por este servidor — o
// Dashboard sobe direto pro Blob com uploadUrl, e o companion baixa direto
// do Blob com downloadUrl. Ver docs/superpowers/specs/
// 2026-11-11-acesso-remoto-winkey-file-transfer-design.md.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require('@azure/storage-blob');

const CONFIG_PATH    = path.join(__dirname, '..', 'config.json');
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — ver spec, folga sobre instalador tipico
const SAS_TTL_MS     = 15 * 60 * 1000;         // 15min — mesmo valor aprovado no spec

function loadBlobStorageConfig() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    cfg = {};
  }
  if (!cfg.blobStorage || !cfg.blobStorage.accountName || !cfg.blobStorage.accountKey) {
    throw new Error('blobStorage não configurado em config.json (accountName/accountKey)');
  }
  return cfg.blobStorage;
}

// sanitizeFileName evita path traversal/caracteres invalidos de blob name —
// mantem so o nome final, sem diretorios.
function sanitizeFileName(fileName) {
  return path.basename(fileName).replace(/[^\w.\-áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ ]/g, '_');
}

// generateFileTransferUrls({fileName, fileSize}) -> {uploadUrl, downloadUrl, blobName}
function generateFileTransferUrls({ fileName, fileSize }) {
  if (fileSize > MAX_FILE_BYTES) {
    throw new Error(`Arquivo acima do limite de 2GB (recebido: ${fileSize} bytes)`);
  }

  const { accountName, accountKey, container } = loadBlobStorageConfig();
  const credential = new StorageSharedKeyCredential(accountName, accountKey);

  const safeFileName = sanitizeFileName(fileName);
  const blobName = `${crypto.randomUUID()}-${safeFileName}`;

  const now       = new Date();
  const startsOn  = new Date(now.getTime() - 5 * 60 * 1000); // folga de relogio
  const expiresOn = new Date(now.getTime() + SAS_TTL_MS);

  const baseParams = {
    containerName: container,
    blobName,
    startsOn,
    expiresOn,
    protocol: 'https',
  };

  const uploadSas = generateBlobSASQueryParameters(
    { ...baseParams, permissions: BlobSASPermissions.parse('cw') },
    credential,
  ).toString();

  const downloadSas = generateBlobSASQueryParameters(
    { ...baseParams, permissions: BlobSASPermissions.parse('r') },
    credential,
  ).toString();

  const blobUrlBase = `https://${accountName}.blob.core.windows.net/${container}/${encodeURIComponent(blobName)}`;

  return {
    uploadUrl:   `${blobUrlBase}?${uploadSas}`,
    downloadUrl: `${blobUrlBase}?${downloadSas}`,
    blobName,
  };
}

module.exports = { generateFileTransferUrls, MAX_FILE_BYTES };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest services/blobSas.test.js`
Expected: PASS — 3 testes.

- [ ] **Step 5: Commit**

```bash
cd server
git add services/blobSas.js services/blobSas.test.js
git commit -m "feat(server): modulo blobSas — gera SAS de upload/download pro mesmo blob

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 3: Endpoint `POST /api/live/:sessionId/file/upload-url`

**Files:**
- Modify: `server/routes/live.js`
- Test: `server/routes/live.test.js` (criar se não existir — checar primeiro com `ls server/routes/live.test.js`)

- [ ] **Step 1: Escrever o teste que falha**

```javascript
// adicionar ao final de server/routes/live.test.js (ou criar o arquivo
// seguindo o padrão de server/routes/activity.test.js: express() + router +
// supertest, mockando '../services/blobSas' e '../middleware/adminAuth')

jest.mock('../services/blobSas', () => ({
  generateFileTransferUrls: jest.fn(),
}));

describe('POST /api/live/:sessionId/file/upload-url', () => {
  it('401 sem X-Admin-Secret', async () => {
    const app = makeApp(); // mesmo helper já usado nos outros describes deste arquivo
    const res = await request(app)
      .post('/api/live/s1/file/upload-url')
      .send({ fileName: 'a.txt', fileSize: 100 });
    expect(res.status).toBe(401);
  });

  it('400 sem fileName ou fileSize', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/live/s1/file/upload-url')
      .set('X-Admin-Secret', process.env.TEST_ADMIN_SECRET || 'test-secret')
      .send({ fileName: 'a.txt' });
    expect(res.status).toBe(400);
  });

  it('200 com uploadUrl/downloadUrl quando tudo ok', async () => {
    const blobSas = require('../services/blobSas');
    blobSas.generateFileTransferUrls.mockReturnValue({
      uploadUrl: 'https://acc.blob.core.windows.net/live-transfer/x?sas',
      downloadUrl: 'https://acc.blob.core.windows.net/live-transfer/x?sas2',
      blobName: 'x',
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/live/s1/file/upload-url')
      .set('X-Admin-Secret', process.env.TEST_ADMIN_SECRET || 'test-secret')
      .send({ fileName: 'instalador.exe', fileSize: 12345 });
    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toContain('live-transfer');
    expect(res.body.downloadUrl).toContain('live-transfer');
  });

  it('400 quando o arquivo passa do limite (blobSas lança erro de tamanho)', async () => {
    const blobSas = require('../services/blobSas');
    blobSas.generateFileTransferUrls.mockImplementation(() => { throw new Error('Arquivo acima do limite de 2GB'); });
    const app = makeApp();
    const res = await request(app)
      .post('/api/live/s1/file/upload-url')
      .set('X-Admin-Secret', process.env.TEST_ADMIN_SECRET || 'test-secret')
      .send({ fileName: 'enorme.iso', fileSize: 999999999999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2GB/);
  });
});
```

Checar primeiro como `makeApp()`/`adminAuth` já são mockados nos testes existentes de
`server/routes/live.js` (se o arquivo de teste já existir) — seguir o MESMO padrão, não inventar
um novo. Se `live.test.js` não existir ainda, criar seguindo exatamente a estrutura de
`server/routes/activity.test.js` (express + router montado em `/api/live` + supertest), com
`adminAuth` real (não mockado) e um `X-Admin-Secret` de teste configurado via
`process.env.ADMIN_SECRET` no `beforeAll`.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && npx jest routes/live.test.js -t "upload-url"`
Expected: FAIL — rota não existe (404) ou módulo `blobSas` não é chamado.

- [ ] **Step 3: Implementar a rota**

Em `server/routes/live.js`, adicionar (perto das outras rotas, usando o `adminAuth` já importado no
topo do arquivo):

```javascript
const { generateFileTransferUrls } = require('../services/blobSas');

// POST /api/live/:sessionId/file/upload-url
// Gera SAS de upload (escrita) + download (leitura) pro MESMO blob, pra
// transferencia de arquivo operador->maquina remota. Bytes nunca passam
// por este servidor.
router.post('/:sessionId/file/upload-url', adminAuth, (req, res) => {
  const { fileName, fileSize } = req.body || {};
  if (!fileName || typeof fileSize !== 'number') {
    return res.status(400).json({ error: 'fileName e fileSize (number) sao obrigatorios' });
  }
  try {
    const result = generateFileTransferUrls({ fileName, fileSize });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd server && npx jest routes/live.test.js`
Expected: PASS — todos os testes do arquivo, incluindo os 4 novos.

- [ ] **Step 5: Commit**

```bash
cd server
git add routes/live.js routes/live.test.js
git commit -m "feat(server): endpoint POST /api/live/:sessionId/file/upload-url

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Grupo 2 — Agent/Companion (Go)

### Task 4: Escrita thread-safe na conexão WS (`safeConn`)

**Files:**
- Create: `agent/wsconn_windows.go`
- Test: `agent/wsconn_windows_test.go`
- Modify: `agent/livesession_windows.go`

Contexto: hoje só `sendLiveSessionFrame` escreve na conexão (goroutine principal, via ticker). A
transferência de arquivo vai escrever progresso de uma goroutine SEPARADA (o download não pode
bloquear a leitura de mouse/teclado) — `gorilla/websocket` não permite 2 goroutines escrevendo ao
mesmo tempo na mesma conexão. `safeConn` serializa isso com um mutex.

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/wsconn_windows_test.go
package main

import (
	"sync"
	"testing"
)

type countingWriter struct {
	mu    sync.Mutex
	calls int
}

func (w *countingWriter) WriteMessage(messageType int, data []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.calls++
	return nil
}

func TestSafeConnSerializesConcurrentWrites(t *testing.T) {
	inner := &countingWriter{}
	sc := newSafeConn(inner)

	const n = 50
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			if err := sc.WriteMessage(1, []byte("x")); err != nil {
				t.Errorf("WriteMessage: %v", err)
			}
		}()
	}
	wg.Wait()

	if inner.calls != n {
		t.Fatalf("esperava %d chamadas, teve %d", n, inner.calls)
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestSafeConnSerializesConcurrentWrites ./... -v`
Expected: FAIL — `undefined: newSafeConn`.

- [ ] **Step 3: Implementar `safeConn`**

```go
// agent/wsconn_windows.go
package main

import "sync"

// safeConn serializa WriteMessage entre goroutines concorrentes —
// gorilla/websocket só permite 1 escritor por vez na mesma conexão
// (reads e writes podem ser concorrentes entre si, mas não 2 writes ao
// mesmo tempo). Antes da transferência de arquivo, só sendLiveSessionFrame
// escrevia (goroutine principal, via ticker). Agora a goroutine de
// download de arquivo também escreve (progresso/done/erro), concorrente
// com os frames de vídeo — sem isso, corrupção de frame no WS.
type safeConn struct {
	mu   sync.Mutex
	conn frameWriter
}

func newSafeConn(conn frameWriter) *safeConn {
	return &safeConn{conn: conn}
}

func (s *safeConn) WriteMessage(messageType int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.WriteMessage(messageType, data)
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go test -run TestSafeConnSerializesConcurrentWrites ./... -v`
Expected: PASS.

- [ ] **Step 5: Plugar `safeConn` em `runLiveSessionLoop`**

Em `agent/livesession_windows.go`, dentro de `runLiveSessionLoop` (hoje começa com
`conn, _, err := liveSessionDialer.Dial(...)`), logo após o `defer conn.Close()`, adicionar:

```go
	writer := newSafeConn(conn)
```

E trocar a chamada de `readLiveSessionInput(conn, mode, sessionID)` (dentro do `safeGo` do leitor)
por `readLiveSessionInput(conn, mode, sessionID, writer)` — `conn` continua sendo usado só pra
LER (`messageReader`), `writer` é o novo canal de ESCREVER usado pela transferência de arquivo.
A chamada de `sendLiveSessionFrame(conn, sessionID, capturer, &captureFailures)` (dentro do loop
`for`) passa a ser `sendLiveSessionFrame(writer, sessionID, capturer, &captureFailures)` — `*safeConn`
já implementa `frameWriter` (mesmo método `WriteMessage`), compatível sem mudar a assinatura de
`sendLiveSessionFrame`.

- [ ] **Step 6: Rodar a suíte do agent inteira (ainda não compila — próxima task ajusta
`readLiveSessionInput`)**

Run: `cd agent && go build ./...`
Expected: FAIL — `readLiveSessionInput` ainda espera 3 argumentos. Normal, resolvido na Task 5.

- [ ] **Step 7: Commit (junto com a Task 5, já que o build só fecha depois dela)**

Não commitar ainda — seguir direto pra Task 5, o commit cobre as duas.

### Task 5: Protocolo `file-transfer` no companion (download + progresso)

**Files:**
- Modify: `agent/input_windows.go`
- Modify: `agent/livesession_windows.go`
- Create: `agent/filetransfer_windows.go`
- Test: `agent/filetransfer_windows_test.go`
- Test: `agent/input_windows_test.go` (atualizar chamadas existentes)

- [ ] **Step 1: Ajustar `readLiveSessionInput`/`handleLiveSessionInput`/`dispatchLiveSessionInput`
pra receber o `writer`**

Em `agent/livesession_windows.go`, `readLiveSessionInput` passa a receber um `frameWriter` a mais:

```go
func readLiveSessionInput(conn messageReader, mode string, sessionID string, w frameWriter) {
	if mode != liveSessionNormalMode {
		logError(fmt.Sprintf("companion: sessão não-normal (mode=%q) — input desabilitado nesta conexão", mode))
	}
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		handleLiveSessionInput(data, mode, sessionID, w)
	}
}
```

Em `agent/input_windows.go`, `handleLiveSessionInput` e `dispatchLiveSessionInput` ganham o mesmo
parâmetro a mais:

```go
func handleLiveSessionInput(data []byte, mode string, sessionID string, w frameWriter) {
	if mode != liveSessionNormalMode {
		return
	}
	msg, err := parseInputMessage(data)
	if err != nil {
		logWarn(fmt.Sprintf("companion: input inválido recebido: %v", err))
		return
	}
	dispatchLiveSessionInput(msg, sessionID, w)
}
```

```go
func dispatchLiveSessionInput(msg inputMessage, sessionID string, w frameWriter) {
	switch msg.Type {
	case "mousemove":
		applyMouseMove(msg)
	case "mousedown":
		applyMouseButton(msg, true)
	case "mouseup":
		applyMouseButton(msg, false)
	case "keydown":
		applyKeyboardInput(msg, true)
	case "keyup":
		applyKeyboardInput(msg, false)
	case "lock-local-input":
		applyLocalInputLock(sessionID, true)
	case "unlock-local-input":
		applyLocalInputLock(sessionID, false)
	case "clipboard-paste":
		applyClipboardPaste(msg)
	case "file-transfer":
		applyFileTransfer(msg, sessionID, w)
	default:
		logWarn(fmt.Sprintf("companion: tipo de input não suportado ainda: %s", msg.Type))
	}
}
```

E `inputMessage` (mesmo arquivo) ganha os 3 campos novos:

```go
// inputMessage é o protocolo de input recebido do dashboard via WS
// (role=dashboard → servidor → aqui, só em sessão mode=normal — o
// servidor garante isso, ver liveSessionRelay.routeMessage no plano do
// server). Tipos: "mousemove", "mousedown", "mouseup", "keydown", "keyup",
// "lock-local-input", "unlock-local-input", "clipboard-paste",
// "file-transfer".
type inputMessage struct {
	Type        string `json:"type"`
	X           int32  `json:"x,omitempty"`
	Y           int32  `json:"y,omitempty"`
	Button      string `json:"button,omitempty"`  // "left" | "right"
	KeyCode     uint16 `json:"keyCode,omitempty"` // virtual-key code
	Text        string `json:"text,omitempty"`    // clipboard-paste: texto a colar
	DownloadURL string `json:"downloadUrl,omitempty"` // file-transfer: SAS de leitura do blob
	FileName    string `json:"fileName,omitempty"`    // file-transfer: nome final do arquivo
	DestDir     string `json:"destDir,omitempty"`     // file-transfer: diretorio de destino (sem o nome do arquivo)
}
```

- [ ] **Step 2: Atualizar as chamadas existentes de `handleLiveSessionInput` nos testes (sem
isso o pacote não compila)**

Em `agent/input_windows_test.go`, toda chamada `handleLiveSessionInput(data, mode, sessionID)` ou
`dispatchLiveSessionInput(msg, sessionID)` ganha um 4º/3º argumento `nil` (nenhum teste existente
exercita `file-transfer`, então um `frameWriter` nulo nunca é usado nesses casos — Go aceita `nil`
pra uma interface sem panicar até alguém chamar um método nela). Ex:

```go
	handleLiveSessionInput(data, "normal", "session-1", nil)
```

Fazer essa troca em TODAS as chamadas do arquivo (uso de `grep -n "handleLiveSessionInput(\|dispatchLiveSessionInput("
agent/input_windows_test.go` pra achar cada uma antes de editar).

- [ ] **Step 3: Escrever o teste novo que falha (dispatch de file-transfer)**

```go
// adicionar em agent/input_windows_test.go
func TestDispatchLiveSessionInputFileTransfer(t *testing.T) {
	original := applyFileTransferFn
	defer func() { applyFileTransferFn = original }()

	var gotMsg inputMessage
	var gotSession string
	called := false
	applyFileTransferFn = func(msg inputMessage, sessionID string, w frameWriter) {
		called = true
		gotMsg = msg
		gotSession = sessionID
	}

	msg := inputMessage{Type: "file-transfer", DownloadURL: "https://x/y?sas", FileName: "a.txt", DestDir: `C:\Users\Loja\Desktop`}
	dispatchLiveSessionInput(msg, "session-1", nil)

	if !called {
		t.Fatal("esperava applyFileTransferFn chamado")
	}
	if gotMsg.FileName != "a.txt" || gotSession != "session-1" {
		t.Errorf("msg/sessionID incorretos: %+v / %s", gotMsg, gotSession)
	}
}
```

(Indireção `applyFileTransferFn` — mesmo padrão de `injectMouseMoveFn`/`injectKeyboardFn` — permite
testar o dispatch sem baixar nada de verdade. `dispatchLiveSessionInput` chama
`applyFileTransferFn(msg, sessionID, w)` em vez de `applyFileTransfer` direto.)

- [ ] **Step 4: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestDispatchLiveSessionInputFileTransfer ./... -v`
Expected: FAIL — `undefined: applyFileTransferFn`.

- [ ] **Step 5: Implementar `filetransfer_windows.go`**

```go
// agent/filetransfer_windows.go
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
	dest      io.Writer
	received  int64
	total     int64
	onProgress func(received, total int64)
	lastSent  time.Time
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
```

Atualizar a chamada dentro de `dispatchLiveSessionInput` (Step 1 acima) pra usar a var indireta:
`case "file-transfer": applyFileTransferFn(msg, sessionID, w)`.

- [ ] **Step 6: Rodar o teste de dispatch e confirmar que passa**

Run: `cd agent && go test -run TestDispatchLiveSessionInputFileTransfer ./... -v`
Expected: PASS.

- [ ] **Step 7: Escrever testes de `downloadFileWithProgress` (sucesso, HTTP erro, destino sem
permissão)**

```go
// agent/filetransfer_windows_test.go
package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDownloadFileWithProgressSuccess(t *testing.T) {
	content := strings.Repeat("x", 10000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

func TestDownloadFileWithProgressDestinoSemPermissao(t *testing.T) {
	// Arquivo no lugar de diretorio forca MkdirAll a falhar.
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
```

- [ ] **Step 8: Rodar e confirmar que os 3 passam**

Run: `cd agent && go test -run TestDownloadFileWithProgress ./... -v`
Expected: PASS — 3 testes.

- [ ] **Step 9: Build completo + suíte inteira do agent**

Run: `cd agent && go build ./... && go vet ./... && go test ./...`
Expected: PASS, zero erro de compilação (confirma que a Task 4 + esta Task fecham juntas).

- [ ] **Step 10: Commit (Tasks 4 e 5 juntas — só fecham build juntas)**

```bash
cd agent
git add wsconn_windows.go wsconn_windows_test.go filetransfer_windows.go filetransfer_windows_test.go \
        input_windows.go input_windows_test.go livesession_windows.go
git commit -m "feat(agent): transferencia de arquivo via file-transfer no WS /live

safeConn serializa escrita entre video (ticker) e progresso de download
(goroutine separada) na mesma conexao WS. downloadFileWithProgress
reaproveita o padrao de downloadBinary (updater.go): temp no mesmo
diretorio final + rename atomico. Download roda em goroutine propria —
nao bloqueia leitura de mouse/teclado durante arquivo grande.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 6: Bump de versão do agent

**Files:**
- Modify: `agent/main.go` (campo `Version`)

- [ ] **Step 1: Confirmar a versão atual e incrementar (minor — feature nova, não breaking)**

Run: `grep -n "Version" agent/main.go`

Atualizar pra próxima minor (ex: se hoje é `1.8.2`, trocar pra `1.9.0` — conferir o valor real
antes de editar, não assumir).

- [ ] **Step 2: Commit**

```bash
cd agent
git add main.go
git commit -m "chore(agent): bump versao pra 1.9.0 (transferencia de arquivo)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**⚠️ NÃO rodar `git tag`/push ainda** — tag de agent é HIGH (propaga pull-based pra frota inteira
no próximo heartbeat). Pausar e pedir confirmação explícita do André antes do tag, só depois que
Grupo 3 (dashboard) também estiver pronto e testado — mesmo padrão de toda a feature até aqui.

---

## Grupo 3 — Dashboard (Electron/React)

### Task 7: IPC de seletor de arquivo local

**Files:**
- Modify: `dashboard/electron/main.js`
- Modify: `dashboard/electron/preload.js`

- [ ] **Step 1: Registrar o handler no processo principal**

Em `dashboard/electron/main.js`, perto de onde `clipboard:read-text` já é tratado (mesmo arquivo,
achar com `grep -n "clipboard:read-text" dashboard/electron/main.js`), adicionar:

```javascript
const { dialog } = require('electron')

ipcMain.handle('file:pick', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})
```

- [ ] **Step 2: Expor no preload**

Em `dashboard/electron/preload.js`, no mesmo objeto de `contextBridge.exposeInMainWorld('electronAPI', {...})`
onde `readClipboardText` já está (linha 74), adicionar:

```javascript
  pickFile: () => ipcRenderer.invoke('file:pick'),
```

- [ ] **Step 3: Commit**

```bash
cd dashboard
git add electron/main.js electron/preload.js
git commit -m "feat(dashboard): IPC file:pick — seletor de arquivo nativo pro Electron

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 8: `useLiveSession` — enviar arquivo + receber status

**Files:**
- Modify: `dashboard/src/hooks/useLiveSession.js`
- Test: `dashboard/src/__tests__/useLiveSession.test.js`

- [ ] **Step 1: Escrever o teste que falha**

O arquivo já define `class FakeWebSocket` (com `static instances`, `.sent`, `._open()`,
`._message(data)`) usada por `beforeEach`/`afterEach` do `describe('useLiveSession', ...)` — usar
EXATAMENTE essa classe, dentro do mesmo `describe` já existente (não criar um novo mock):

```javascript
it('mensagem de texto file-transfer-progress chama onFileTransferStatus em vez de drawFrame', () => {
  const canvasRef = makeCanvasRef()
  const onFileTransferStatus = vi.fn()
  renderHook(() => useLiveSession({
    serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
    mode: 'normal', canvasRef, onFileTransferStatus,
  }))
  const ws = FakeWebSocket.instances[0]
  ws._open()
  ws._message(JSON.stringify({ type: 'file-transfer-progress', bytesReceived: 50, bytesTotal: 100 }))

  expect(onFileTransferStatus).toHaveBeenCalledWith({ type: 'file-transfer-progress', bytesReceived: 50, bytesTotal: 100 })
})

it('sendFileTransfer manda type file-transfer com downloadUrl/fileName/destDir', () => {
  const canvasRef = makeCanvasRef()
  const { result } = renderHook(() => useLiveSession({
    serverUrl: 'https://servidor.example.com', sessionId: 's1', dashboardToken: 'tok',
    mode: 'normal', canvasRef,
  }))
  const ws = FakeWebSocket.instances[0]
  ws._open()
  act(() => {
    result.current.sendFileTransfer('https://blob/x?sas', 'instalador.exe', 'C:\\Users\\Loja\\Desktop')
  })

  expect(ws.sent).toContain(JSON.stringify({
    type: 'file-transfer', downloadUrl: 'https://blob/x?sas', fileName: 'instalador.exe', destDir: 'C:\\Users\\Loja\\Desktop',
  }))
})
```

Adicionar os 2 testes dentro do `describe('useLiveSession', ...)` já existente (depois dos testes
que já usam `makeCanvasRef()`/`FakeWebSocket`), não num describe novo.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd dashboard && npx vitest run src/__tests__/useLiveSession.test.js -t "file-transfer"`
Expected: FAIL — `onFileTransferStatus` não existe, `sendFileTransfer` não existe.

- [ ] **Step 3: Implementar**

Em `dashboard/src/hooks/useLiveSession.js`:

```javascript
export function useLiveSession({ serverUrl, sessionId, dashboardToken, mode, canvasRef, onStatusChange, onFileTransferStatus }) {
```

Trocar `ws.onmessage = (e) => { drawFrame(e.data) }` por:

```javascript
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type?.startsWith('file-transfer-')) onFileTransferStatus?.(msg)
        } catch { /* mensagem de texto nao-JSON, ignora */ }
        return
      }
      drawFrame(e.data)
    }
```

E adicionar, perto de `sendClipboardPaste`:

```javascript
  // sendFileTransfer manda o comando leve pro companion baixar o arquivo
  // do Blob (downloadUrl ja e a SAS de leitura, gerada pelo servidor) —
  // ver agent/filetransfer_windows.go.
  const sendFileTransfer = useCallback((downloadUrl, fileName, destDir) => {
    sendInput({ type: 'file-transfer', downloadUrl, fileName, destDir })
  }, [sendInput])
```

E incluir `sendFileTransfer` no `return` final do hook.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd dashboard && npx vitest run src/__tests__/useLiveSession.test.js`
Expected: PASS — suíte inteira do arquivo.

- [ ] **Step 5: Commit**

```bash
cd dashboard
git add src/hooks/useLiveSession.js src/__tests__/useLiveSession.test.js
git commit -m "feat(dashboard): useLiveSession ganha sendFileTransfer + onFileTransferStatus

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 9: UI — drop-zone, botão, campo de destino, barra de progresso

**Files:**
- Modify: `dashboard/src/api.js:185-188`
- Modify: `dashboard/src/components/LiveSessionWindow.jsx`
- Test: `dashboard/src/__tests__/LiveSessionWindow.test.jsx`

- [ ] **Step 1: Adicionar `api.live.getFileUploadUrl` (mesmo padrão de `live.start`/`live.stop`)**

Em `dashboard/src/api.js`, dentro do objeto `live` (linhas 185-188):

```javascript
  live: {
    start: (machineId, mode)        => request('POST', `/api/live/${machineId}/start`, { mode }, { admin: true }),
    stop:  (sessionId, recorded)    => request('POST', `/api/live/${sessionId}/stop`, { recorded: !!recorded }, { admin: true }),
    getFileUploadUrl: (sessionId, fileName, fileSize) =>
      request('POST', `/api/live/${sessionId}/file/upload-url`, { fileName, fileSize }, { admin: true }),
  },
```

- [ ] **Step 2: Escrever o teste que falha (fluxo completo via botão, mais simples de simular que
drag-drop em RTL)**

No mock de `vi.mock('../hooks/useLiveSession', ...)` (topo do arquivo, linhas 11-21), adicionar
`sendFileTransfer` ao retorno:

```javascript
const sendFileTransferMock = vi.fn()
// ...
vi.mock('../hooks/useLiveSession', () => ({
  useLiveSession: (args) => {
    lastUseLiveSessionArgs = args
    return {
      sendInput: sendInputMock,
      sendMouseEvent: sendMouseEventMock,
      sendKeyEvent: sendKeyEventMock,
      sendClipboardPaste: sendClipboardPasteMock,
      sendFileTransfer: sendFileTransferMock,
    }
  },
}))
```

E no mock de `vi.mock('../api', ...)` (linhas 23-27), adicionar `getFileUploadUrl` dentro de `live`:

```javascript
vi.mock('../api', () => ({
  api: {
    live: {
      stop: vi.fn().mockResolvedValue({ ok: true }),
      getFileUploadUrl: vi.fn().mockResolvedValue({ uploadUrl: 'https://blob/x?sas-up', downloadUrl: 'https://blob/x?sas-down' }),
    },
  },
  setServerUrl: vi.fn(),
  setAdminSecret: vi.fn(),
}))
```

Testes novos:

```javascript
it('mode normal: botao Enviar arquivo pede upload-url, sobe pro blob e manda sendFileTransfer', async () => {
  window.electronAPI.pickFile = vi.fn().mockResolvedValue('C:\\Users\\Andre\\Downloads\\instalador.exe')
  window.electronAPI.readLocalFile = vi.fn().mockResolvedValue(new ArrayBuffer(8))
  global.fetch = vi.fn().mockResolvedValue({ ok: true }) // PUT pro blob

  render(<LiveSessionWindow />)
  fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

  await act(async () => {
    fireEvent.click(screen.getByText(/Enviar arquivo/i))
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(api.live.getFileUploadUrl).toHaveBeenCalledWith('s1', 'instalador.exe', 8)
  expect(global.fetch).toHaveBeenCalledWith('https://blob/x?sas-up', expect.objectContaining({ method: 'PUT' }))
  expect(sendFileTransferMock).toHaveBeenCalledWith('https://blob/x?sas-down', 'instalador.exe', expect.any(String))
})

it('mode shadow: botao Enviar arquivo nao aparece', () => {
  render(<LiveSessionWindow />)
  fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'shadow', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })
  expect(screen.queryByText(/Enviar arquivo/i)).not.toBeInTheDocument()
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `cd dashboard && npx vitest run src/__tests__/LiveSessionWindow.test.jsx -t "Enviar arquivo"`
Expected: FAIL — botão não existe.

- [ ] **Step 4: Implementar a UI**

Em `LiveSessionWindow.jsx`, usar o `sendFileTransfer` retornado por `useLiveSession` (ajustar a
desestruturação do hook no topo do componente) e adicionar estado local:

```javascript
  const [fileDestDir, setFileDestDir] = useState('')
  const [fileTransferProgress, setFileTransferProgress] = useState(null) // {bytesReceived, bytesTotal} | 'error: ...' | 'done' | null

  const handleFileTransferStatus = useCallback((msg) => {
    if (msg.type === 'file-transfer-progress') {
      setFileTransferProgress({ bytesReceived: msg.bytesReceived, bytesTotal: msg.bytesTotal })
    } else if (msg.type === 'file-transfer-done') {
      setFileTransferProgress('done')
    } else if (msg.type === 'file-transfer-error') {
      setFileTransferProgress('error: ' + msg.message)
    }
  }, [])
```

Passar `onFileTransferStatus: handleFileTransferStatus` na chamada de `useLiveSession(...)`.

Função de envio (reaproveitada pelo botão e pelo drop-handler — recebe o caminho local já
resolvido), usando `api.live.getFileUploadUrl` (já importado no topo do arquivo):

```javascript
  const defaultDestDir = `C:\\Users\\${session?.remoteUser || 'Loja'}\\Desktop`

  const sendLocalFileToRemote = useCallback(async (localPath, fileNameHint) => {
    const fileName = fileNameHint || localPath.split(/[\\/]/).pop()
    setFileTransferProgress({ bytesReceived: 0, bytesTotal: 0 })
    try {
      const fileBuffer = await window.electronAPI.readLocalFile(localPath)
      const { uploadUrl, downloadUrl } = await api.live.getFileUploadUrl(session.sessionId, fileName, fileBuffer.byteLength)
      const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob' }, body: fileBuffer })
      if (!putRes.ok) { setFileTransferProgress('error: falha ao subir pro Blob'); return }
      sendFileTransfer(downloadUrl, fileName, fileDestDir || defaultDestDir)
    } catch (err) {
      setFileTransferProgress('error: ' + err.message)
    }
  }, [session, fileDestDir, defaultDestDir, sendFileTransfer])

  const handlePickFile = useCallback(async () => {
    const localPath = await window.electronAPI.pickFile()
    if (!localPath) return
    sendLocalFileToRemote(localPath)
  }, [sendLocalFileToRemote])
```

E no JSX, dentro do bloco que só renderiza em `mode === 'normal'` (mesmo lugar dos outros botões de
controle):

```jsx
{session?.mode === 'normal' && (
  <div className="file-transfer-controls">
    <input
      type="text"
      value={fileDestDir}
      onChange={(e) => setFileDestDir(e.target.value)}
      placeholder={defaultDestDir}
    />
    <button className="btn" onClick={handlePickFile}>Enviar arquivo</button>
    {fileTransferProgress && typeof fileTransferProgress === 'object' && (
      <progress value={fileTransferProgress.bytesReceived} max={fileTransferProgress.bytesTotal || 1} />
    )}
    {fileTransferProgress === 'done' && <span>Arquivo enviado ✓</span>}
    {typeof fileTransferProgress === 'string' && fileTransferProgress.startsWith('error') && <span>{fileTransferProgress}</span>}
  </div>
)}
```

- [ ] **Step 5: IPC de leitura de arquivo local (necessário pro `readLocalFile` usado acima)**

Em `dashboard/electron/main.js`, perto de `file:pick`:

```javascript
ipcMain.handle('file:read', async (_event, filePath) => {
  const fs = require('fs/promises')
  const buf = await fs.readFile(filePath)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
})
```

Em `preload.js`:

```javascript
  readLocalFile: (path) => ipcRenderer.invoke('file:read', path),
```

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `cd dashboard && npx vitest run src/__tests__/LiveSessionWindow.test.jsx`
Expected: PASS — suíte inteira do arquivo.

- [ ] **Step 7: Rodar a suíte inteira do dashboard**

Run: `cd dashboard && npm test`
Expected: PASS, zero regressão.

- [ ] **Step 8: Commit**

```bash
cd dashboard
git add electron/main.js electron/preload.js src/api.js src/components/LiveSessionWindow.jsx src/__tests__/LiveSessionWindow.test.jsx
git commit -m "feat(dashboard): UI de transferencia de arquivo (botao + destino + progresso)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 10: Drag-and-drop (complemento ao botão)

**Files:**
- Modify: `dashboard/src/components/LiveSessionWindow.jsx`
- Test: `dashboard/src/__tests__/LiveSessionWindow.test.jsx`

- [ ] **Step 1: Escrever o teste que falha**

```javascript
it('mode normal: soltar arquivo na janela chama sendLocalFileToRemote com o path do arquivo', async () => {
  render(<LiveSessionWindow />)
  fireLiveSessionInit({ sessionId: 's1', machineId: 'm1', mode: 'normal', dashboardToken: 'tok', serverUrl: 'https://s.example.com' })

  const dropZone = screen.getByTestId('live-session-dropzone')
  const file = new File(['conteudo'], 'driver.exe', { type: 'application/octet-stream' })
  Object.defineProperty(file, 'path', { value: 'C:\\Users\\Andre\\Downloads\\driver.exe' })

  fireEvent.drop(dropZone, { dataTransfer: { files: [file] } })

  await waitFor(() => expect(window.electronAPI.pickFile).not.toHaveBeenCalled()) // drop nao usa o dialog
})
```

(Teste mínimo — Electron expõe `file.path` em `File` arrastado do SO, algo que jsdom não simula
de verdade; o ponto deste teste é confirmar que o handler de `drop` dispara o fluxo de envio sem
passar pelo seletor nativo. Testar o upload de ponta a ponta fica pro teste manual ao vivo, Task
11.)

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd dashboard && npx vitest run src/__tests__/LiveSessionWindow.test.jsx -t "soltar arquivo"`
Expected: FAIL — `data-testid="live-session-dropzone"` não existe.

- [ ] **Step 3: Implementar**

No JSX, envolver a área da sessão (canvas + controles) com os handlers de drop, reaproveitando
`sendLocalFileToRemote` da Task 9:

```jsx
  const handleDrop = useCallback((e) => {
    e.preventDefault()
    if (session?.mode !== 'normal') return
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    sendLocalFileToRemote(file.path, file.name)
  }, [session, sendLocalFileToRemote])

  const handleDragOver = useCallback((e) => { e.preventDefault() }, [])
```

```jsx
<div data-testid="live-session-dropzone" onDrop={handleDrop} onDragOver={handleDragOver}>
  {/* canvas + controles existentes, sem mudar */}
</div>
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd dashboard && npx vitest run src/__tests__/LiveSessionWindow.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd dashboard
git add src/components/LiveSessionWindow.jsx src/__tests__/LiveSessionWindow.test.jsx
git commit -m "feat(dashboard): arrastar-e-soltar arquivo na janela da sessao ao vivo

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Grupo 4 — Integração, revisão e rollout

### Task 11: Revisão local + teste ao vivo

- [ ] **Step 1: `code-reviewer` nos 3 diffs** (server, agent, dashboard) — aplicar todo 🔴 CRÍTICO e
🟠 ALTO antes de seguir.
- [ ] **Step 2: Criar o container Blob** (se ainda não existir) — `dtmanagerdr/live-transfer` +
lifecycle de 24h. Confirmar com André antes (toca Azure).
- [ ] **Step 3: Preencher `blobStorage.accountKey` real no `config.json` de produção do servidor**
(nunca no `config.example.json`/git) — mesmo mecanismo manual já usado pros outros segredos desse
arquivo.
- [ ] **Step 4: Teste ao vivo em 1 máquina BOH**: tecla Windows liberada (plano separado), arquivo
pequeno (<10MB), arquivo grande (100-500MB) com barra de progresso visível, destino inválido
(path sem permissão) mostrando erro.
- [ ] **Step 5: Só então — pausar e pedir confirmação explícita do André pro `git tag` do agent**
(Task 6) — propaga pull-based pra frota inteira assim que tagueado.

### Rollout

- Servidor: sobe sozinho no push pro master (CI existente, `ci-server.yml`).
- Dashboard: `release:auto` (regra fixa do projeto) depois de Tasks 7-10 + revisão.
- Agent: **HIGH** — só tag+push depois de autorização explícita (Task 11, Step 5).
