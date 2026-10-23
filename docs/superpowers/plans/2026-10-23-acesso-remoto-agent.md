# Acesso Remoto — Agent (modo companion, Go/Windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao agente Go (`delirio-agent.exe`) um modo "companion" que roda na sessão
interativa do usuário (não no serviço Session 0), reportando log de atividade continuamente e,
sob comando do servidor, capturando tela e injetando input pra sessões ao vivo Normal/Shadow.

**Architecture:** Um único binário (o mesmo `delirio-agent.exe`), dois modos de execução: serviço
(Session 0, já existe) e companion (`--companion`, novo — lançado pelo serviço via
`WTSQueryUserToken`+`CreateProcessAsUser` assim que detecta sessão de usuário ativa). O companion
roda de forma majoritariamente autônoma: lê o mesmo `config.json` do serviço (mesmo diretório de
instalação) e fala direto com o servidor via HTTP pro log de atividade (Camada 1) — não precisa do
serviço como intermediário pra isso. Só pra sessão ao vivo (Camada 3) o serviço, que já faz polling
de comando, precisa repassar o sinal "comece/pare" pro companion via named pipe local
(`\\.\pipe\DelirioCompanion`), já que é o servidor quem inicia essa ação, não o companion.

**Tech Stack:** Go 1.22, `golang.org/x/sys/windows` (já existe), `github.com/gorilla/websocket`
(nova dependência — cliente WS maduro, sem binding Go oficial pra isso na stdlib). Captura de tela
via GDI BitBlt (syscalls diretos, sem lib de terceiros — decisão tomada com o André após pesquisa:
não existe binding Go maduro pra DXGI Desktop Duplication, exigiria interop COM manual ou cgo).
Input via `user32.dll!SendInput` (syscall direto, sem lib de terceiros).

---

## Referência — decisões já fechadas

Ver `docs/superpowers/specs/2026-10-23-acesso-remoto-design.md` (design geral) e o plano irmão
`docs/superpowers/plans/2026-10-23-acesso-remoto-server.md` (já implementado e mergeado — define o
contrato HTTP/WS que este plano consome: `POST /api/activity` com header `Authorization: Bearer
<token>`, comandos `capture-screenshot`/`start-live-session`/`stop-live-session` na fila de
comandos existente, WebSocket em `/live?sessionId=X&role=companion&token=Y`).

- Companion não é exe separado — é o mesmo `delirio-agent.exe` com flag `--companion`.
- Sem ocultação de processo (constraint fixa de toda a feature) — `tasklist`/Gerenciador de Tarefas
  mostra `delirio-agent.exe` duas vezes (serviço + companion), nome igual, PID diferente. Isso é
  aceitável e esperado.
- Shadow = view-only — companion NUNCA injeta input em sessão Shadow. Essa garantia já está no
  servidor (`liveSessionRelay.routeMessage` nunca repassa mensagem de input pro companion em
  sessão Shadow) — o companion em si não precisa reforçar isso (defesa em profundidade já existe
  do lado do servidor), mas também não deve assumir que vai receber input mesmo que o protocolo
  WS permita tecnicamente — só processa mensagem de input se ela chegar.

## Fora de escopo deste plano

- Dashboard (viewer, botões, gravação) — plano próprio, ainda não escrito.
- OCR de screenshot, áudio, qualquer coisa já descartada na spec geral.
- Watchdog de reinstalação do companion em caso de crash repetido — fica pra depois, se necessário.

---

## Fase A — Companion básico + Log de Atividade (Camada 1)

### Task 1: Modo companion — entry point

**Files:**
- Create: `agent/companion.go`
- Modify: `agent/main.go`
- Test: `agent/companion_test.go`

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/companion_test.go
package main

import "testing"

func TestParseCompanionFlags(t *testing.T) {
	args := []string{"--companion"}
	if !isCompanionMode(args) {
		t.Fatal("esperava isCompanionMode(true) com --companion presente")
	}
	if isCompanionMode([]string{"--install"}) {
		t.Fatal("esperava isCompanionMode(false) sem --companion")
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestParseCompanionFlags ./...`
Expected: FAIL — `undefined: isCompanionMode`

- [ ] **Step 3: Implementar**

```go
// agent/companion.go
package main

import (
	"fmt"
)

// isCompanionMode detecta a flag --companion nos args brutos (chamado antes
// do flag.Parse() principal em main.go, que não reconhece essa flag).
func isCompanionMode(args []string) bool {
	for _, a := range args {
		if a == "--companion" {
			return true
		}
	}
	return false
}

// runCompanion é o entry point do modo companion — roda na sessão
// interativa do usuário (lançado pelo serviço via CreateProcessAsUser),
// nunca no serviço (Session 0). Lê o mesmo config.json do serviço.
func runCompanion() error {
	cfg, err := loadConfig()
	if err != nil {
		logWarn(fmt.Sprintf("companion: erro ao carregar config: %v — usando padrão.", err))
	}
	if cfg.ServerURL == "" || cfg.Token == "" {
		return fmt.Errorf("companion: ServerURL/Token ausentes — serviço ainda não registrou")
	}

	logInfo("Companion iniciado.")

	stopCh := make(chan struct{})
	go activityReportLoop(cfg, stopCh)
	go companionPipeLoop(cfg, stopCh)

	select {} // bloqueia forever — processo companion vive até ser morto pelo serviço
}
```

Em `agent/main.go`, no início de `main()` (antes de `flag.Parse()`, já que `--companion` não é uma
flag reconhecida pelo parser de flags padrão e causaria erro):

```go
func main() {
	if isCompanionMode(os.Args[1:]) {
		if err := runCompanion(); err != nil {
			log.Fatalf("Erro no modo companion: %v", err)
		}
		return
	}

	install    := flag.Bool("install", false, "Instalar como servico Windows")
	// ... resto igual
```

`activityReportLoop` e `companionPipeLoop` ainda não existem — são as próximas tasks. Para este
commit, criar stubs mínimos em `agent/companion.go` só pra compilar:

```go
func activityReportLoop(cfg *Config, stopCh <-chan struct{}) {
	<-stopCh
}

func companionPipeLoop(cfg *Config, stopCh <-chan struct{}) {
	<-stopCh
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go test -run TestParseCompanionFlags ./...`
Expected: PASS

Run também: `cd agent && go build ./...` (confirma que compila no todo, incluindo `main.go`
modificado) — como o agente só compila de verdade (com as tags do Windows) em `GOOS=windows`,
rodar: `cd agent && GOOS=windows GOARCH=amd64 go build ./...`

- [ ] **Step 5: Commit**

```bash
git add agent/companion.go agent/main.go agent/companion_test.go
git commit -m "feat(agent): modo companion — entry point + wiring em main.go"
```

---

### Task 2: Captura de janela em foco + processo

**Files:**
- Create: `agent/activity_windows.go`
- Test: `agent/activity_windows_test.go`

Esta função usa a API do Windows (`user32.dll!GetForegroundWindow`, `GetWindowThreadProcessId`) —
não dá pra testar essas duas chamadas em si sem uma sessão desktop interativa real (não roda em
CI). O que É testável: a lógica de mapear nome de processo pra nome amigável, separada da captura.

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/activity_windows_test.go
package main

import "testing"

func TestFriendlyProcessName(t *testing.T) {
	cases := map[string]string{
		"chrome.exe":  "Google Chrome",
		"CHROME.EXE":  "Google Chrome",
		"EXCEL.EXE":   "Excel",
		"notepad.exe": "notepad.exe", // sem mapeamento conhecido: devolve o original
	}
	for input, want := range cases {
		got := friendlyProcessName(input)
		if got != want {
			t.Errorf("friendlyProcessName(%q) = %q, want %q", input, got, want)
		}
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestFriendlyProcessName ./...`
Expected: FAIL — `undefined: friendlyProcessName`

- [ ] **Step 3: Implementar**

```go
// agent/activity_windows.go
package main

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"
)

var friendlyProcessNames = map[string]string{
	"chrome.exe":  "Google Chrome",
	"msedge.exe":  "Microsoft Edge",
	"firefox.exe": "Firefox",
	"excel.exe":   "Excel",
	"winword.exe": "Word",
	"outlook.exe": "Outlook",
}

// friendlyProcessName traduz o nome técnico do executável pra um nome
// legível na UI do dashboard (ver spec: "log traduzido pra linguagem
// comum"). Sem mapeamento conhecido, devolve o nome original sem alteração.
func friendlyProcessName(exeName string) string {
	key := strings.ToLower(exeName)
	if friendly, ok := friendlyProcessNames[key]; ok {
		return friendly
	}
	return exeName
}

var (
	user32                      = syscall.NewLazyDLL("user32.dll")
	procGetForegroundWindow     = user32.NewProc("GetForegroundWindow")
	procGetWindowTextW          = user32.NewProc("GetWindowTextW")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	kernel32                    = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess             = kernel32.NewProc("OpenProcess")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
	procCloseHandle             = kernel32.NewProc("CloseHandle")
)

const (
	processQueryLimitedInformation = 0x1000
)

// captureForegroundWindow lê a janela em foco agora — título + nome do
// processo. Não testável em CI (precisa de sessão desktop interativa real);
// verificar manualmente rodando o companion numa máquina Windows de teste.
func captureForegroundWindow() (windowTitle string, processName string, err error) {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return "", "", fmt.Errorf("nenhuma janela em foco")
	}

	buf := make([]uint16, 512)
	procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	windowTitle = syscall.UTF16ToString(buf)

	var pid uint32
	procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return windowTitle, "", fmt.Errorf("pid não encontrado pra janela em foco")
	}

	hProcess, _, _ := procOpenProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if hProcess == 0 {
		return windowTitle, "", fmt.Errorf("OpenProcess falhou pro pid %d", pid)
	}
	defer procCloseHandle.Call(hProcess)

	pathBuf := make([]uint16, 512)
	pathLen := uint32(len(pathBuf))
	ret, _, _ := procQueryFullProcessImageNameW.Call(
		hProcess, 0, uintptr(unsafe.Pointer(&pathBuf[0])), uintptr(unsafe.Pointer(&pathLen)),
	)
	if ret == 0 {
		return windowTitle, "", fmt.Errorf("QueryFullProcessImageName falhou pro pid %d", pid)
	}
	fullPath := syscall.UTF16ToString(pathBuf[:pathLen])
	parts := strings.Split(strings.ReplaceAll(fullPath, "/", "\\"), "\\")
	processName = parts[len(parts)-1]

	return windowTitle, processName, nil
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go test -run TestFriendlyProcessName ./...`
Expected: PASS

Run: `cd agent && GOOS=windows GOARCH=amd64 go vet ./...` (confirma que os syscalls estão com a
assinatura certa — `go vet` pega erros de tipo em chamadas `.Call()`, mesmo sem executar).

- [ ] **Step 5: Commit**

```bash
git add agent/activity_windows.go agent/activity_windows_test.go
git commit -m "feat(agent): captura de janela em foco + processo via syscalls Win32"
```

---

### Task 3: Loop de report de atividade (companion → servidor)

**Files:**
- Modify: `agent/companion.go` (substituir o stub `activityReportLoop`)
- Test: `agent/companion_test.go`

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/companion_test.go — adicionar ao final do arquivo
func TestBuildActivityPayload(t *testing.T) {
	payload := buildActivityPayload("Vagas - LinkedIn", "chrome.exe")
	if payload.WindowTitle != "Vagas - LinkedIn" {
		t.Errorf("WindowTitle = %q", payload.WindowTitle)
	}
	if payload.ProcessName != "chrome.exe" {
		t.Errorf("ProcessName = %q", payload.ProcessName)
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestBuildActivityPayload ./...`
Expected: FAIL — `undefined: buildActivityPayload` (ou `ActivityPayload`)

- [ ] **Step 3: Implementar**

Substituir o stub de `activityReportLoop` em `agent/companion.go`:

```go
// ActivityPayload é o corpo JSON de POST /api/activity.
type ActivityPayload struct {
	WindowTitle string `json:"windowTitle"`
	ProcessName string `json:"processName"`
}

func buildActivityPayload(windowTitle, processName string) ActivityPayload {
	return ActivityPayload{WindowTitle: windowTitle, ProcessName: processName}
}

const activityReportIntervalSecs = 4

// activityReportLoop reporta a janela em foco pro servidor a cada ~4s
// (ver spec: "3-5s"). Erros de captura ou de rede não derrubam o loop —
// só pula o ciclo e tenta de novo no próximo tick.
func activityReportLoop(cfg *Config, stopCh <-chan struct{}) {
	ticker := time.NewTicker(activityReportIntervalSecs * time.Second)
	defer ticker.Stop()
	client := &http.Client{Timeout: 10 * time.Second}

	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			title, proc, err := captureForegroundWindow()
			if err != nil {
				continue // sem janela em foco (ex: tela de login) — tenta de novo no próximo tick
			}
			payload := buildActivityPayload(title, proc)
			if err := sendActivityPayload(client, cfg, payload); err != nil {
				logWarn(fmt.Sprintf("companion: erro ao reportar atividade: %v", err))
			}
		}
	}
}

func sendActivityPayload(client *http.Client, cfg *Config, payload ActivityPayload) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", cfg.ServerURL+"/api/activity", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("servidor retornou status %d", resp.StatusCode)
	}
	return nil
}
```

Adicionar os imports necessários (`bytes`, `encoding/json`, `net/http`, `time`) ao topo de
`agent/companion.go`.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go test -run TestBuildActivityPayload ./...`
Expected: PASS

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./...`

- [ ] **Step 5: Commit**

```bash
git add agent/companion.go agent/companion_test.go
git commit -m "feat(agent): companion reporta atividade pro servidor a cada 4s"
```

---

### Task 4: Detecção de sessão ativa (dentro do serviço)

**Files:**
- Create: `agent/session_windows.go`
- Test: `agent/session_windows_test.go`

`WTSEnumerateSessions` e `WTSQueryUserToken` não são testáveis em CI (exigem SYSTEM + sessão
desktop real). O que É testável: a lógica de escolher qual sessão é "a ativa" dado uma lista de
sessões, separada da chamada real à API.

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/session_windows_test.go
package main

import "testing"

func TestPickActiveSession(t *testing.T) {
	sessions := []sessionInfo{
		{ID: 0, State: wtsStateDisconnected},
		{ID: 1, State: wtsStateActive},
		{ID: 2, State: wtsStateConnected},
	}
	id, ok := pickActiveSession(sessions)
	if !ok || id != 1 {
		t.Fatalf("pickActiveSession = (%d, %v), want (1, true)", id, ok)
	}
}

func TestPickActiveSessionNoneActive(t *testing.T) {
	sessions := []sessionInfo{
		{ID: 0, State: wtsStateDisconnected},
	}
	_, ok := pickActiveSession(sessions)
	if ok {
		t.Fatal("esperava ok=false quando nenhuma sessão está ativa")
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestPickActiveSession ./...`
Expected: FAIL — tipos/funções indefinidos

- [ ] **Step 3: Implementar**

```go
// agent/session_windows.go
package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

type wtsSessionState uint32

const (
	wtsStateActive       wtsSessionState = 0
	wtsStateConnected    wtsSessionState = 1
	wtsStateDisconnected wtsSessionState = 4
)

type sessionInfo struct {
	ID    uint32
	State wtsSessionState
}

// pickActiveSession escolhe a sessão WTS_ACTIVE (usuário efetivamente
// logado e com desktop visível) numa lista de sessões. Sem sessão ativa
// (ex: tela de login, máquina travada), retorna ok=false — não lança o
// companion nesse caso.
func pickActiveSession(sessions []sessionInfo) (uint32, bool) {
	for _, s := range sessions {
		if s.State == wtsStateActive {
			return s.ID, true
		}
	}
	return 0, false
}

var (
	wtsapi32                 = syscall.NewLazyDLL("wtsapi32.dll")
	procWTSEnumerateSessionsW = wtsapi32.NewProc("WTSEnumerateSessionsW")
	procWTSFreeMemory        = wtsapi32.NewProc("WTSFreeMemory")
)

type wtsSessionInfoRaw struct {
	SessionID      uint32
	WinStationName *uint16
	State          uint32
}

// enumerateSessions chama WTSEnumerateSessionsW de verdade — não testável
// em CI (exige contexto SYSTEM real). Verificar manualmente.
func enumerateSessions() ([]sessionInfo, error) {
	var ppSessionInfo uintptr
	var count uint32

	ret, _, err := procWTSEnumerateSessionsW.Call(
		0, // WTS_CURRENT_SERVER_HANDLE
		0, 1,
		uintptr(unsafe.Pointer(&ppSessionInfo)),
		uintptr(unsafe.Pointer(&count)),
	)
	if ret == 0 {
		return nil, fmt.Errorf("WTSEnumerateSessionsW falhou: %w", err)
	}
	defer procWTSFreeMemory.Call(ppSessionInfo)

	sessions := make([]sessionInfo, 0, count)
	rawSlice := (*[1 << 10]wtsSessionInfoRaw)(unsafe.Pointer(ppSessionInfo))[:count:count]
	for _, raw := range rawSlice {
		sessions = append(sessions, sessionInfo{ID: raw.SessionID, State: wtsSessionState(raw.State)})
	}
	return sessions, nil
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go test -run TestPickActiveSession ./...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/session_windows.go agent/session_windows_test.go
git commit -m "feat(agent): detecção de sessão WTS ativa (lógica pura testável)"
```

---

### Task 5: Lançar o companion na sessão ativa (CreateProcessAsUser) + watcher no serviço

**Files:**
- Modify: `agent/session_windows.go` (adicionar `launchCompanion`)
- Modify: `agent/agent.go` (adicionar `sessionWatchLoop`)
- Test: `agent/session_windows_test.go`

`launchCompanion` (WTSQueryUserToken + CreateProcessAsUser) não é testável em CI. O que É
testável: a lógica de decidir SE precisa relançar o companion (companion não está rodando, ou
sessão mudou), separada da chamada real de spawn.

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/session_windows_test.go — adicionar ao final
func TestShouldRelaunchCompanion(t *testing.T) {
	cases := []struct {
		name           string
		companionAlive bool
		sessionChanged bool
		want           bool
	}{
		{"companion morto, sessão igual", false, false, true},
		{"companion vivo, sessão igual", true, false, false},
		{"companion vivo, sessão mudou (logoff/logon)", true, true, true},
		{"companion morto, sessão mudou", false, true, true},
	}
	for _, c := range cases {
		got := shouldRelaunchCompanion(c.companionAlive, c.sessionChanged)
		if got != c.want {
			t.Errorf("%s: shouldRelaunchCompanion(%v, %v) = %v, want %v",
				c.name, c.companionAlive, c.sessionChanged, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestShouldRelaunchCompanion ./...`
Expected: FAIL — `undefined: shouldRelaunchCompanion`

- [ ] **Step 3: Implementar**

Em `agent/session_windows.go`, adicionar:

```go
// shouldRelaunchCompanion decide se o companion precisa ser (re)lançado:
// se não está vivo, ou se a sessão ativa mudou desde o último lançamento
// (logoff/logon — o companion antigo ficou órfão numa sessão que já não
// é mais a ativa).
func shouldRelaunchCompanion(companionAlive bool, sessionChanged bool) bool {
	return !companionAlive || sessionChanged
}

var (
	advapi32                = syscall.NewLazyDLL("advapi32.dll")
	procOpenProcessToken    = advapi32.NewProc("OpenProcessToken")
	procDuplicateTokenEx    = advapi32.NewProc("DuplicateTokenEx")
	procWTSQueryUserToken   = wtsapi32.NewProc("WTSQueryUserToken")
	procCreateProcessAsUserW = advapi32.NewProc("CreateProcessAsUserW")
)

// launchCompanion lança delirio-agent.exe --companion na sessão sessionID,
// usando o token do usuário logado nela. Não testável em CI — exige
// contexto SYSTEM com SeTcbPrivilege e uma sessão desktop real. Verificar
// manualmente numa VM/PC de teste: logar, confirmar que o serviço lança o
// companion, delirio-agent.exe aparece 2x no Gerenciador de Tarefas.
func launchCompanion(sessionID uint32) (companionPID uint32, err error) {
	var hUserToken syscall.Handle
	ret, _, callErr := procWTSQueryUserToken.Call(uintptr(sessionID), uintptr(unsafe.Pointer(&hUserToken)))
	if ret == 0 {
		return 0, fmt.Errorf("WTSQueryUserToken falhou pra sessão %d: %w", sessionID, callErr)
	}
	defer procCloseHandle.Call(uintptr(hUserToken))

	var hPrimaryToken syscall.Handle
	const tokenDuplicate = 0x0002
	const securityImpersonation = 2
	const tokenPrimary = 1
	ret, _, callErr = procDuplicateTokenEx.Call(
		uintptr(hUserToken), tokenDuplicate|0x8|0x4, 0,
		securityImpersonation, tokenPrimary, uintptr(unsafe.Pointer(&hPrimaryToken)),
	)
	if ret == 0 {
		return 0, fmt.Errorf("DuplicateTokenEx falhou: %w", callErr)
	}
	defer procCloseHandle.Call(uintptr(hPrimaryToken))

	exePath, err := os.Executable()
	if err != nil {
		return 0, fmt.Errorf("os.Executable: %w", err)
	}
	cmdLine := fmt.Sprintf(`"%s" --companion`, exePath)
	cmdLineUTF16, err := syscall.UTF16PtrFromString(cmdLine)
	if err != nil {
		return 0, err
	}
	desktopUTF16, err := syscall.UTF16PtrFromString(`winsta0\default`)
	if err != nil {
		return 0, err
	}

	var si startupInfo
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Desktop = desktopUTF16
	var pi processInformation

	const createNoWindow = 0x08000000
	ret, _, callErr = procCreateProcessAsUserW.Call(
		uintptr(hPrimaryToken), 0, uintptr(unsafe.Pointer(cmdLineUTF16)),
		0, 0, 0, createNoWindow, 0, 0,
		uintptr(unsafe.Pointer(&si)), uintptr(unsafe.Pointer(&pi)),
	)
	if ret == 0 {
		return 0, fmt.Errorf("CreateProcessAsUserW falhou: %w", callErr)
	}
	defer procCloseHandle.Call(uintptr(pi.Process))
	defer procCloseHandle.Call(uintptr(pi.Thread))

	return pi.ProcessId, nil
}

type startupInfo struct {
	Cb              uint32
	_reserved1      *uint16
	Desktop         *uint16
	Title           *uint16
	_pad            [13]uint32
	_reservedPtr    *byte
	StdInput        syscall.Handle
	StdOutput       syscall.Handle
	StdErr          syscall.Handle
}

type processInformation struct {
	Process   syscall.Handle
	Thread    syscall.Handle
	ProcessId uint32
	ThreadId  uint32
}
```

Em `agent/agent.go`, adicionar ao `Agent` struct o estado de rastreamento, e um novo loop:

```go
// (adicionar aos campos de Agent struct)
	companionPID     uint32
	companionSession uint32
```

```go
const sessionWatchIntervalSecs = 15

// sessionWatchLoop roda só no serviço (Session 0): detecta a sessão de
// usuário ativa e garante que o companion está rodando nela. Relança em
// logoff/logon (sessão muda) ou se o companion morreu por qualquer motivo.
func (a *Agent) sessionWatchLoop() {
	ticker := time.NewTicker(sessionWatchIntervalSecs * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-a.stopCh:
			return
		case <-ticker.C:
			sessions, err := enumerateSessions()
			if err != nil {
				logWarn(fmt.Sprintf("sessionWatch: erro ao enumerar sessões: %v", err))
				continue
			}
			activeID, ok := pickActiveSession(sessions)
			if !ok {
				continue // sem usuário logado agora (tela de login) — nada a fazer
			}

			sessionChanged := activeID != a.companionSession
			alive := a.companionPID != 0 && processIsAlive(a.companionPID)
			if !shouldRelaunchCompanion(alive, sessionChanged) {
				continue
			}

			pid, err := launchCompanion(activeID)
			if err != nil {
				logError(fmt.Sprintf("sessionWatch: falha ao lançar companion: %v", err))
				continue
			}
			a.companionPID = pid
			a.companionSession = activeID
			logInfo(fmt.Sprintf("Companion lançado (PID %d, sessão %d).", pid, activeID))
		}
	}
}
```

`processIsAlive(pid uint32) bool` ainda não existe — adicionar em `agent/session_windows.go`:

```go
func processIsAlive(pid uint32) bool {
	const synchronize = 0x00100000
	h, _, _ := procOpenProcess.Call(synchronize, 0, uintptr(pid))
	if h == 0 {
		return false
	}
	defer procCloseHandle.Call(h)
	return true
}
```

Em `agent/agent.go`, dentro de `start()`, perto dos outros `go a.xLoop()`:

```go
	go a.sessionWatchLoop()
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go test -run TestShouldRelaunchCompanion ./...`
Expected: PASS

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./...` e `go vet ./...`

- [ ] **Step 5: Commit**

```bash
git add agent/session_windows.go agent/agent.go agent/session_windows_test.go
git commit -m "feat(agent): serviço lança companion na sessão ativa via CreateProcessAsUser"
```

---

## Fase B — Screenshot sob gatilho + Sessão ao vivo (Camadas 2 e 3)

### Task 6: Captura de 1 frame de tela (GDI BitBlt) + JPEG

**Files:**
- Create: `agent/screencapture_windows.go`
- Test: `agent/screencapture_windows_test.go`

A chamada BitBlt real não é testável em CI (precisa de desktop real). O que É testável: a função
que decide a resolução/qualidade de captura a partir dos limites da tela, separada da captura em
si.

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/screencapture_windows_test.go
package main

import "testing"

func TestClampJPEGQuality(t *testing.T) {
	if q := clampJPEGQuality(0); q != 1 {
		t.Errorf("clampJPEGQuality(0) = %d, want 1", q)
	}
	if q := clampJPEGQuality(200); q != 100 {
		t.Errorf("clampJPEGQuality(200) = %d, want 100", q)
	}
	if q := clampJPEGQuality(70); q != 70 {
		t.Errorf("clampJPEGQuality(70) = %d, want 70", q)
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestClampJPEGQuality ./...`
Expected: FAIL — `undefined: clampJPEGQuality`

- [ ] **Step 3: Implementar**

```go
// agent/screencapture_windows.go
package main

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"syscall"
	"unsafe"
)

func clampJPEGQuality(q int) int {
	if q < 1 {
		return 1
	}
	if q > 100 {
		return 100
	}
	return q
}

const defaultJPEGQuality = 70

var (
	gdi32                  = syscall.NewLazyDLL("gdi32.dll")
	procGetDC              = user32.NewProc("GetDC")
	procReleaseDC          = user32.NewProc("ReleaseDC")
	procGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject       = gdi32.NewProc("SelectObject")
	procBitBlt             = gdi32.NewProc("BitBlt")
	procGetDIBits          = gdi32.NewProc("GetDIBits")
	procDeleteDC           = gdi32.NewProc("DeleteDC")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
)

const (
	smCxScreen  = 0
	smCyScreen  = 1
	srcCopy     = 0x00CC0020
	biRGB       = 0
	dibRGBColors = 0
)

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

// captureScreenJPEG tira 1 print da tela inteira e devolve como JPEG.
// Não testável em CI (precisa de desktop real) — verificar manualmente.
func captureScreenJPEG(quality int) ([]byte, error) {
	quality = clampJPEGQuality(quality)

	width, _, _ := procGetSystemMetrics.Call(smCxScreen)
	height, _, _ := procGetSystemMetrics.Call(smCyScreen)
	if width == 0 || height == 0 {
		return nil, fmt.Errorf("GetSystemMetrics retornou tela com dimensão zero")
	}

	hdcScreen, _, _ := procGetDC.Call(0)
	if hdcScreen == 0 {
		return nil, fmt.Errorf("GetDC falhou")
	}
	defer procReleaseDC.Call(0, hdcScreen)

	hdcMem, _, _ := procCreateCompatibleDC.Call(hdcScreen)
	if hdcMem == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC falhou")
	}
	defer procDeleteDC.Call(hdcMem)

	hBitmap, _, _ := procCreateCompatibleBitmap.Call(hdcScreen, width, height)
	if hBitmap == 0 {
		return nil, fmt.Errorf("CreateCompatibleBitmap falhou")
	}
	defer procDeleteObject.Call(hBitmap)

	procSelectObject.Call(hdcMem, hBitmap)
	ret, _, _ := procBitBlt.Call(hdcMem, 0, 0, width, height, hdcScreen, 0, 0, srcCopy)
	if ret == 0 {
		return nil, fmt.Errorf("BitBlt falhou")
	}

	bi := bitmapInfoHeader{
		Size:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		Width:       int32(width),
		Height:      -int32(height), // negativo = top-down (sem precisar inverter linhas)
		Planes:      1,
		BitCount:    32,
		Compression: biRGB,
	}
	buf := make([]byte, width*height*4)
	ret, _, _ = procGetDIBits.Call(
		hdcMem, hBitmap, 0, uintptr(height),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bi)), dibRGBColors,
	)
	if ret == 0 {
		return nil, fmt.Errorf("GetDIBits falhou")
	}

	img := image.NewRGBA(image.Rect(0, 0, int(width), int(height)))
	for i := 0; i < int(width*height); i++ {
		b, g, r, a := buf[i*4], buf[i*4+1], buf[i*4+2], buf[i*4+3]
		img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = r, g, b, a
	}

	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("jpeg.Encode: %w", err)
	}
	return out.Bytes(), nil
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go test -run TestClampJPEGQuality ./...`
Expected: PASS

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./...` e `go vet ./...`

- [ ] **Step 5: Commit**

```bash
git add agent/screencapture_windows.go agent/screencapture_windows_test.go
git commit -m "feat(agent): captura de 1 frame de tela via GDI BitBlt + JPEG"
```

---

### Task 7: Handler `capture-screenshot` no agente (serviço)

**Files:**
- Modify: `agent/commands.go`
- Test: `agent/commands_test.go`

O handler roda no SERVIÇO (que recebe o comando via polling existente), mas a captura de tela
real só é possível na sessão do usuário — então o serviço repassa o pedido pro companion via named
pipe (Task 9) e aguarda o resultado. Para esta task, implementar o handler assumindo que a função
de IPC (`requestScreenshotFromCompanion`) existe — ela será implementada de verdade na Task 9;
aqui, criar um stub que retorna erro "não implementado" pra não travar a compilação, e um teste que
confirma o handler está registrado e chama a função de IPC corretamente (via injeção de função,
mockável).

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/commands_test.go — adicionar ao final do arquivo existente
func TestHandleCaptureScreenshot(t *testing.T) {
	original := requestScreenshotFromCompanionFn
	defer func() { requestScreenshotFromCompanionFn = original }()

	requestScreenshotFromCompanionFn = func() ([]byte, error) {
		return []byte("fake-jpeg-bytes"), nil
	}

	cmd := Command{ID: "cmd-1", Type: "capture-screenshot", Params: json.RawMessage(`{"activityLogId":42}`)}
	result, err := handleCaptureScreenshot(cmd)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if result == "" {
		t.Fatal("esperava resultado não-vazio (base64 do JPEG)")
	}
}

func TestHandleCaptureScreenshotCompanionError(t *testing.T) {
	original := requestScreenshotFromCompanionFn
	defer func() { requestScreenshotFromCompanionFn = original }()

	requestScreenshotFromCompanionFn = func() ([]byte, error) {
		return nil, fmt.Errorf("companion não respondeu")
	}

	cmd := Command{ID: "cmd-1", Type: "capture-screenshot", Params: json.RawMessage(`{}`)}
	_, err := handleCaptureScreenshot(cmd)
	if err == nil {
		t.Fatal("esperava erro quando companion falha")
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestHandleCaptureScreenshot ./...`
Expected: FAIL — símbolos indefinidos

- [ ] **Step 3: Implementar**

Em `agent/commands.go`, adicionar ao mapa `commandHandlers()`:

```go
		"capture-screenshot":     handleCaptureScreenshot,
```

E a função (mais um stub temporário de `requestScreenshotFromCompanionFn`, que a Task 9 substitui
pela implementação real via pipe):

```go
// requestScreenshotFromCompanionFn pede 1 frame pro companion via IPC local
// e aguarda a resposta (timeout interno). Var (não const) pra ser mockável
// em teste. Implementação real: Task 9 (named pipe).
var requestScreenshotFromCompanionFn = func() ([]byte, error) {
	return nil, fmt.Errorf("IPC com companion ainda não implementado")
}

func handleCaptureScreenshot(cmd Command) (string, error) {
	logInfo(fmt.Sprintf("Comando CAPTURE-SCREENSHOT recebido (ID: %s).", cmd.ID))
	jpegBytes, err := requestScreenshotFromCompanionFn()
	if err != nil {
		return "", fmt.Errorf("capture-screenshot: %w", err)
	}
	return base64.StdEncoding.EncodeToString(jpegBytes), nil
}
```

Adicionar `"encoding/base64"` aos imports de `agent/commands.go` se ainda não estiver presente.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go test -run TestHandleCaptureScreenshot ./...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/commands.go agent/commands_test.go
git commit -m "feat(agent): handler capture-screenshot (IPC com companion stub)"
```

---

### Task 8: Named pipe IPC entre serviço e companion

**Files:**
- Create: `agent/pipe_windows.go`
- Test: `agent/pipe_windows_test.go`

Named pipes locais (`\\.\pipe\...`) funcionam em CI (não exigem sessão desktop, só o SO rodando) —
esta task é mais testável que as anteriores. Protocolo: mensagens JSON de uma linha, servidor da
pipe é o COMPANION (ele é quem fica esperando comando), cliente é o SERVIÇO (que escreve o pedido
e lê a resposta).

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/pipe_windows_test.go
package main

import (
	"encoding/json"
	"testing"
)

func TestEncodeDecodePipeMessage(t *testing.T) {
	msg := pipeMessage{Type: "capture-screenshot", RequestID: "req-1"}
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded pipeMessage
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.Type != "capture-screenshot" || decoded.RequestID != "req-1" {
		t.Errorf("decoded = %+v", decoded)
	}
}

func TestPipeRequestTimeout(t *testing.T) {
	// Sem servidor de pipe rodando, um cliente tentando conectar deve
	// falhar rápido (timeout curto), não travar pra sempre.
	_, err := sendPipeRequest(pipeMessage{Type: "ping"}, 200*time.Millisecond)
	if err == nil {
		t.Fatal("esperava erro ao conectar numa pipe que não existe")
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && GOOS=windows GOARCH=amd64 go test -run "TestEncodeDecodePipeMessage|TestPipeRequestTimeout" ./...`
Expected: FAIL — símbolos indefinidos (named pipes são Windows-only; este teste só roda de fato em
`GOOS=windows` — rodar via CI do agente, que já é `windows-latest`, ver `ci-agent.yml`)

- [ ] **Step 3: Implementar**

```go
// agent/pipe_windows.go
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"time"

	"gopkg.in/Microsoft/go-winio.v0" // ver nota de dependência abaixo
)

const pipeName = `\\.\pipe\DelirioCompanion`

// pipeMessage é o protocolo local entre serviço (cliente) e companion
// (servidor da pipe). RequestID correlaciona pedido/resposta; Error
// preenchido só na resposta, em caso de falha do lado do companion.
type pipeMessage struct {
	Type        string `json:"type"`                  // "capture-screenshot" | "start-live-session" | "stop-live-session"
	RequestID   string `json:"requestId"`
	SessionID   string `json:"sessionId,omitempty"`
	Mode        string `json:"mode,omitempty"`
	CompanionToken string `json:"companionToken,omitempty"`
	ServerURL   string `json:"serverUrl,omitempty"`
	ResultJPEGBase64 string `json:"resultJpegBase64,omitempty"`
	Error       string `json:"error,omitempty"`
}

// sendPipeRequest conecta na pipe do companion, manda a mensagem, lê UMA
// linha de resposta. Usado pelo SERVIÇO (cliente). timeout cobre conexão +
// resposta — se o companion não estiver rodando ou travado, falha rápido
// em vez de travar o handler de comando indefinidamente.
func sendPipeRequest(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
	var resp pipeMessage
	conn, err := winio.DialPipe(pipeName, &timeout)
	if err != nil {
		return resp, fmt.Errorf("conectar na pipe do companion: %w", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout))

	data, err := json.Marshal(msg)
	if err != nil {
		return resp, err
	}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return resp, fmt.Errorf("escrever na pipe: %w", err)
	}

	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return resp, fmt.Errorf("ler resposta da pipe: %w", err)
	}
	if err := json.Unmarshal(line, &resp); err != nil {
		return resp, fmt.Errorf("decodificar resposta: %w", err)
	}
	if resp.Error != "" {
		return resp, fmt.Errorf("companion retornou erro: %s", resp.Error)
	}
	return resp, nil
}

// listenPipe roda no COMPANION: aceita conexões na pipe local e despacha
// cada mensagem pro handler correspondente. Não testável em CI de forma
// completa (o listener real exige privilégio de pipe no contexto certo),
// mas a função de parsing/despacho em si (handlePipeMessage) é testável
// isoladamente.
func listenPipe(handler func(pipeMessage) pipeMessage, stopCh <-chan struct{}) {
	listener, err := winio.ListenPipe(pipeName, nil)
	if err != nil {
		logError(fmt.Sprintf("companion: falha ao abrir pipe: %v", err))
		return
	}
	defer listener.Close()

	go func() {
		<-stopCh
		listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			return // listener fechado (stopCh) ou erro — encerra o loop
		}
		go func() {
			defer conn.Close()
			line, err := bufio.NewReader(conn).ReadBytes('\n')
			if err != nil {
				return
			}
			var msg pipeMessage
			if err := json.Unmarshal(line, &msg); err != nil {
				return
			}
			resp := handler(msg)
			data, _ := json.Marshal(resp)
			conn.Write(append(data, '\n'))
		}()
	}
}
```

**Nota de dependência nova:** `github.com/Microsoft/go-winio` — named pipes não têm API nativa boa
em `golang.org/x/sys/windows` (dá pra fazer via syscall direto, mas é consideravelmente mais
código/risco de bug do que usar essa lib, que é mantida pela própria Microsoft e já é dependência
transitiva comum em ecossistema Docker/containerd no Windows — baixo risco de adotar). Adicionar ao
`agent/go.mod`:

```bash
cd agent && go get github.com/Microsoft/go-winio@latest
```

Corrigir o import no código acima de `gopkg.in/Microsoft/go-winio.v0` pra `github.com/Microsoft/go-winio`.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go mod tidy && GOOS=windows GOARCH=amd64 go test -run "TestEncodeDecodePipeMessage|TestPipeRequestTimeout" ./...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/pipe_windows.go agent/pipe_windows_test.go agent/go.mod agent/go.sum
git commit -m "feat(agent): named pipe IPC entre serviço e companion (go-winio)"
```

---

### Task 9: Ligar capture-screenshot de verdade via pipe (serviço) + companion responde

**Files:**
- Modify: `agent/commands.go` (substituir o stub de `requestScreenshotFromCompanionFn`)
- Modify: `agent/companion.go` (substituir o stub de `companionPipeLoop`)
- Test: `agent/commands_test.go`, `agent/companion_test.go`

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/companion_test.go — adicionar ao final
func TestHandleCompanionPipeMessage(t *testing.T) {
	original := captureScreenJPEGFn
	defer func() { captureScreenJPEGFn = original }()
	captureScreenJPEGFn = func(quality int) ([]byte, error) {
		return []byte("fake-jpeg"), nil
	}

	resp := handleCompanionPipeMessage(pipeMessage{Type: "capture-screenshot", RequestID: "req-1"})
	if resp.Error != "" {
		t.Fatalf("erro inesperado: %s", resp.Error)
	}
	if resp.ResultJPEGBase64 == "" {
		t.Fatal("esperava resultJpegBase64 preenchido")
	}
}

func TestHandleCompanionPipeMessageUnknownType(t *testing.T) {
	resp := handleCompanionPipeMessage(pipeMessage{Type: "tipo-desconhecido", RequestID: "req-2"})
	if resp.Error == "" {
		t.Fatal("esperava erro pra tipo de mensagem desconhecido")
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestHandleCompanionPipeMessage ./...`
Expected: FAIL — símbolos indefinidos

- [ ] **Step 3: Implementar**

Em `agent/screencapture_windows.go`, tornar a captura mockável (var em vez de chamada direta):

```go
// captureScreenJPEGFn permite mock em teste — produção chama captureScreenJPEG de verdade.
var captureScreenJPEGFn = captureScreenJPEG
```

Em `agent/companion.go`, substituir o stub de `companionPipeLoop`:

```go
func companionPipeLoop(cfg *Config, stopCh <-chan struct{}) {
	listenPipe(handleCompanionPipeMessage, stopCh)
}

// handleCompanionPipeMessage despacha mensagens recebidas do serviço via
// pipe. Testável isoladamente (não depende do listener de pipe em si).
func handleCompanionPipeMessage(msg pipeMessage) pipeMessage {
	switch msg.Type {
	case "capture-screenshot":
		jpegBytes, err := captureScreenJPEGFn(defaultJPEGQuality)
		if err != nil {
			return pipeMessage{RequestID: msg.RequestID, Error: err.Error()}
		}
		return pipeMessage{
			RequestID:        msg.RequestID,
			ResultJPEGBase64: base64.StdEncoding.EncodeToString(jpegBytes),
		}
	default:
		return pipeMessage{RequestID: msg.RequestID, Error: fmt.Sprintf("tipo de mensagem desconhecido: %s", msg.Type)}
	}
}
```

Adicionar `"encoding/base64"` aos imports de `agent/companion.go`.

Em `agent/commands.go`, substituir o stub de `requestScreenshotFromCompanionFn`:

```go
var requestScreenshotFromCompanionFn = func() ([]byte, error) {
	resp, err := sendPipeRequest(pipeMessage{Type: "capture-screenshot", RequestID: generateUUID()}, 10*time.Second)
	if err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(resp.ResultJPEGBase64)
}
```

Adicionar `"time"` aos imports de `agent/commands.go` se ainda não estiver presente.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go test -run TestHandleCompanionPipeMessage ./...`
Expected: PASS

Run a suite completa: `cd agent && go test ./...` e `GOOS=windows GOARCH=amd64 go build ./...`

- [ ] **Step 5: Commit**

```bash
git add agent/commands.go agent/companion.go agent/screencapture_windows.go agent/commands_test.go agent/companion_test.go
git commit -m "feat(agent): capture-screenshot fim a fim via pipe (serviço↔companion)"
```

---

### Task 10: Handlers `start-live-session` / `stop-live-session` (serviço → companion)

**Files:**
- Modify: `agent/commands.go`
- Modify: `agent/companion.go`
- Test: `agent/commands_test.go`, `agent/companion_test.go`

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/commands_test.go — adicionar ao final
func TestHandleStartLiveSession(t *testing.T) {
	original := sendPipeRequestFn
	defer func() { sendPipeRequestFn = original }()

	var gotMsg pipeMessage
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		gotMsg = msg
		return pipeMessage{RequestID: msg.RequestID}, nil
	}

	params := `{"sessionId":"s1","mode":"shadow","companionToken":"tok-abc"}`
	cmd := Command{ID: "cmd-1", Type: "start-live-session", Params: json.RawMessage(params)}
	_, err := handleStartLiveSession(cmd)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if gotMsg.SessionID != "s1" || gotMsg.Mode != "shadow" || gotMsg.CompanionToken != "tok-abc" {
		t.Errorf("mensagem repassada pro companion incompleta: %+v", gotMsg)
	}
}

func TestHandleStopLiveSession(t *testing.T) {
	original := sendPipeRequestFn
	defer func() { sendPipeRequestFn = original }()

	var gotType string
	sendPipeRequestFn = func(msg pipeMessage, timeout time.Duration) (pipeMessage, error) {
		gotType = msg.Type
		return pipeMessage{RequestID: msg.RequestID}, nil
	}

	cmd := Command{ID: "cmd-2", Type: "stop-live-session", Params: json.RawMessage(`{"sessionId":"s1"}`)}
	_, err := handleStopLiveSession(cmd)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if gotType != "stop-live-session" {
		t.Errorf("tipo repassado = %q, want stop-live-session", gotType)
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run "TestHandleStartLiveSession|TestHandleStopLiveSession" ./...`
Expected: FAIL — símbolos indefinidos

- [ ] **Step 3: Implementar**

Em `agent/pipe_windows.go`, tornar `sendPipeRequest` mockável:

```go
// sendPipeRequestFn permite mock em teste.
var sendPipeRequestFn = sendPipeRequest
```

Em `agent/commands.go`, adicionar ao mapa `commandHandlers()`:

```go
		"start-live-session": handleStartLiveSession,
		"stop-live-session":  handleStopLiveSession,
```

E as funções:

```go
func handleStartLiveSession(cmd Command) (string, error) {
	var params struct {
		SessionID      string `json:"sessionId"`
		Mode           string `json:"mode"`
		CompanionToken string `json:"companionToken"`
	}
	if err := json.Unmarshal(cmd.Params, &params); err != nil {
		return "", fmt.Errorf("start-live-session: params inválidos: %w", err)
	}
	logInfo(fmt.Sprintf("Comando START-LIVE-SESSION recebido (ID: %s, mode: %s).", cmd.ID, params.Mode))

	_, err := sendPipeRequestFn(pipeMessage{
		Type: "start-live-session", RequestID: generateUUID(),
		SessionID: params.SessionID, Mode: params.Mode, CompanionToken: params.CompanionToken,
		ServerURL: globalServerURLForLiveSession,
	}, 10*time.Second)
	if err != nil {
		return "", fmt.Errorf("start-live-session: %w", err)
	}
	return "Sessão ao vivo iniciada no companion.", nil
}

func handleStopLiveSession(cmd Command) (string, error) {
	var params struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(cmd.Params, &params); err != nil {
		return "", fmt.Errorf("stop-live-session: params inválidos: %w", err)
	}
	logInfo(fmt.Sprintf("Comando STOP-LIVE-SESSION recebido (ID: %s).", cmd.ID))

	_, err := sendPipeRequestFn(pipeMessage{
		Type: "stop-live-session", RequestID: generateUUID(), SessionID: params.SessionID,
	}, 10*time.Second)
	if err != nil {
		return "", fmt.Errorf("stop-live-session: %w", err)
	}
	return "Sessão ao vivo encerrada.", nil
}
```

`globalServerURLForLiveSession` é uma variável simples setada no boot do agente a partir de
`cfg.ServerURL` (o companion precisa saber pra qual servidor WS conectar, e não tem acesso direto
ao `*Config` do serviço — só ao que vier na mensagem da pipe). Adicionar no topo de
`agent/commands.go`:

```go
var globalServerURLForLiveSession string

func init() {
	cfg, err := loadConfig()
	if err == nil {
		globalServerURLForLiveSession = cfg.ServerURL
	}
}
```

Em `agent/companion.go`, estender `handleCompanionPipeMessage` com os 2 novos casos (implementação
completa de conectar no WS fica pra Task 11 — aqui só repassa/loga, retornando sucesso):

```go
	case "start-live-session":
		logInfo(fmt.Sprintf("companion: start-live-session recebido (sessão %s, mode %s)", msg.SessionID, msg.Mode))
		startLiveSessionFn(msg.SessionID, msg.Mode, msg.CompanionToken, msg.ServerURL)
		return pipeMessage{RequestID: msg.RequestID}
	case "stop-live-session":
		logInfo(fmt.Sprintf("companion: stop-live-session recebido (sessão %s)", msg.SessionID))
		stopLiveSessionFn(msg.SessionID)
		return pipeMessage{RequestID: msg.RequestID}
```

Com stubs temporários (Task 11 implementa de verdade):

```go
var startLiveSessionFn = func(sessionID, mode, companionToken, serverURL string) {}
var stopLiveSessionFn = func(sessionID string) {}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go test -run "TestHandleStartLiveSession|TestHandleStopLiveSession" ./...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/commands.go agent/companion.go agent/commands_test.go
git commit -m "feat(agent): handlers start/stop-live-session repassam pro companion via pipe"
```

---

### Task 11: Companion conecta no WebSocket `/live` e transmite frames contínuos

**Files:**
- Create: `agent/livesession_windows.go`
- Modify: `agent/companion.go` (substituir os stubs `startLiveSessionFn`/`stopLiveSessionFn`)
- Test: `agent/livesession_windows_test.go`

A conexão WS real não é testável em CI sem um servidor de verdade rodando (seria um teste de
integração pesado). O que É testável: a lógica de qual frame enviar e com que intervalo, separada
do transporte.

**Nova dependência:** `github.com/gorilla/websocket` (cliente WS maduro — Go não tem isso na
stdlib). Adicionar: `cd agent && go get github.com/gorilla/websocket@latest`.

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/livesession_windows_test.go
package main

import "testing"

func TestLiveSessionFrameIntervalMs(t *testing.T) {
	// ~10fps conforme spec (sessão ao vivo fluida) = 100ms entre frames
	if ms := liveSessionFrameIntervalMs(); ms != 100 {
		t.Errorf("liveSessionFrameIntervalMs() = %d, want 100", ms)
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestLiveSessionFrameIntervalMs ./...`
Expected: FAIL — `undefined: liveSessionFrameIntervalMs`

- [ ] **Step 3: Implementar**

```go
// agent/livesession_windows.go
package main

import (
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const liveSessionFPS = 10

func liveSessionFrameIntervalMs() int {
	return 1000 / liveSessionFPS
}

type liveSessionHandle struct {
	stopCh chan struct{}
}

var (
	liveSessionsMu sync.Mutex
	liveSessions   = map[string]*liveSessionHandle{}
)

// startLiveSession conecta no WebSocket /live do servidor como companion e
// começa a transmitir frames de tela em loop, até stopLiveSession ser
// chamado ou a conexão cair. Não testável em CI de ponta a ponta (exige
// desktop real + servidor real) — verificar manualmente.
func startLiveSession(sessionID, mode, companionToken, serverURL string) {
	liveSessionsMu.Lock()
	if _, exists := liveSessions[sessionID]; exists {
		liveSessionsMu.Unlock()
		logWarn(fmt.Sprintf("companion: sessão %s já está ativa, ignorando start duplicado", sessionID))
		return
	}
	handle := &liveSessionHandle{stopCh: make(chan struct{})}
	liveSessions[sessionID] = handle
	liveSessionsMu.Unlock()

	wsURL := buildLiveWebSocketURL(serverURL, sessionID, companionToken)

	safeGo("liveSession-"+sessionID, func() {
		runLiveSessionLoop(wsURL, mode, handle.stopCh)
		liveSessionsMu.Lock()
		delete(liveSessions, sessionID)
		liveSessionsMu.Unlock()
	})
}

func stopLiveSession(sessionID string) {
	liveSessionsMu.Lock()
	defer liveSessionsMu.Unlock()
	if handle, exists := liveSessions[sessionID]; exists {
		close(handle.stopCh)
		delete(liveSessions, sessionID)
	}
}

func buildLiveWebSocketURL(serverURL, sessionID, companionToken string) string {
	wsBase := strings.Replace(serverURL, "https://", "wss://", 1)
	wsBase = strings.Replace(wsBase, "http://", "ws://", 1)
	q := url.Values{}
	q.Set("sessionId", sessionID)
	q.Set("role", "companion")
	q.Set("token", companionToken)
	return wsBase + "/live?" + q.Encode()
}

func runLiveSessionLoop(wsURL, mode string, stopCh <-chan struct{}) {
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		logError(fmt.Sprintf("companion: falha ao conectar em %s: %v", wsURL, err))
		return
	}
	defer conn.Close()

	// Normal mode: lê mensagens de input numa goroutine separada e injeta
	// via SendInput. Shadow: o servidor nunca repassa input pra cá, mas o
	// companion não assume isso — só processa se algo chegar.
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			handleLiveSessionInput(data)
		}
	}()

	ticker := time.NewTicker(time.Duration(liveSessionFrameIntervalMs()) * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			frame, err := captureScreenJPEGFn(defaultJPEGQuality)
			if err != nil {
				continue
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				logWarn(fmt.Sprintf("companion: falha ao enviar frame, encerrando sessão: %v", err))
				return
			}
		}
	}
}
```

Em `agent/companion.go`, substituir os stubs:

```go
var startLiveSessionFn = startLiveSession
var stopLiveSessionFn = stopLiveSession
```

`handleLiveSessionInput` ainda não existe — criar um stub por enquanto (Task 12 implementa):

```go
// agent/livesession_windows.go — adicionar
func handleLiveSessionInput(data []byte) {
	// Implementado na Task 12 (SendInput).
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go mod tidy && go test -run TestLiveSessionFrameIntervalMs ./...`
Expected: PASS

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./...`

- [ ] **Step 5: Commit**

```bash
git add agent/livesession_windows.go agent/companion.go agent/livesession_windows_test.go agent/go.mod agent/go.sum
git commit -m "feat(agent): companion conecta no WS /live e transmite frames em loop"
```

---

### Task 12: Injeção de input (SendInput) — só mode Normal

**Files:**
- Create: `agent/input_windows.go`
- Modify: `agent/livesession_windows.go` (substituir o stub `handleLiveSessionInput`)
- Test: `agent/input_windows_test.go`

A chamada real a `SendInput` não é testável em CI (injeta input de verdade no desktop). O que É
testável: o parsing da mensagem JSON de input recebida pelo WS, e a montagem do struct `INPUT`
(sem de fato chamar a syscall).

- [ ] **Step 1: Escrever o teste que falha**

```go
// agent/input_windows_test.go
package main

import "testing"

func TestParseInputMessage(t *testing.T) {
	data := []byte(`{"type":"mousemove","x":100,"y":200}`)
	msg, err := parseInputMessage(data)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if msg.Type != "mousemove" || msg.X != 100 || msg.Y != 200 {
		t.Errorf("msg = %+v", msg)
	}
}

func TestParseInputMessageInvalid(t *testing.T) {
	_, err := parseInputMessage([]byte("não é json"))
	if err == nil {
		t.Fatal("esperava erro pra JSON inválido")
	}
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd agent && go test -run TestParseInputMessage ./...`
Expected: FAIL — símbolos indefinidos

- [ ] **Step 3: Implementar**

```go
// agent/input_windows.go
package main

import (
	"encoding/json"
	"fmt"
	"syscall"
	"unsafe"
)

// inputMessage é o protocolo de input recebido do dashboard via WS
// (role=dashboard → servidor → aqui, só em sessão mode=normal — o
// servidor garante isso, ver liveSessionRelay.routeMessage no plano do
// server). Tipos: "mousemove", "mousedown", "mouseup", "keydown", "keyup".
type inputMessage struct {
	Type    string `json:"type"`
	X       int32  `json:"x,omitempty"`
	Y       int32  `json:"y,omitempty"`
	Button  string `json:"button,omitempty"`  // "left" | "right"
	KeyCode uint16 `json:"keyCode,omitempty"` // virtual-key code
}

func parseInputMessage(data []byte) (inputMessage, error) {
	var msg inputMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return msg, fmt.Errorf("parseInputMessage: %w", err)
	}
	return msg, nil
}

const (
	inputMouse                = 0
	inputKeyboard             = 1
	mouseEventFMove           = 0x0001
	mouseEventFLeftDown       = 0x0002
	mouseEventFLeftUp         = 0x0004
	mouseEventFRightDown      = 0x0008
	mouseEventFRightUp        = 0x0010
	mouseEventFAbsolute       = 0x8000
	keyEventFKeyUp            = 0x0002
)

// mouseInput e keybdInput espelham os structs MOUSEINPUT/KEYBDINPUT do
// Win32 — layout tem que bater exatamente (padding incluso) senão
// SendInput lê lixo. Ver referência Win32: estrutura INPUT é uma union de
// MOUSEINPUT/KEYBDINPUT/HARDWAREINPUT do mesmo tamanho (maior delas).
type mouseInput struct {
	Dx, Dy      int32
	MouseData   uint32
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

type input struct {
	Type uint32
	_    uint32 // padding pra alinhar o union em 64-bit
	Mi   mouseInput
}

var (
	procSendInput = user32.NewProc("SendInput")
)

func injectMouseMove(x, y int32) error {
	// Coordenadas absolutas normalizadas (0-65535) — ver doc MOUSEINPUT.
	screenW, _, _ := procGetSystemMetrics.Call(smCxScreen)
	screenH, _, _ := procGetSystemMetrics.Call(smCyScreen)
	normX := int32(x) * 65536 / int32(screenW)
	normY := int32(y) * 65536 / int32(screenH)

	in := input{
		Type: inputMouse,
		Mi: mouseInput{
			Dx: normX, Dy: normY,
			DwFlags: mouseEventFMove | mouseEventFAbsolute,
		},
	}
	return sendInputStruct(in)
}

func injectMouseButton(button string, down bool) error {
	var flag uint32
	switch {
	case button == "left" && down:
		flag = mouseEventFLeftDown
	case button == "left" && !down:
		flag = mouseEventFLeftUp
	case button == "right" && down:
		flag = mouseEventFRightDown
	case button == "right" && !down:
		flag = mouseEventFRightUp
	default:
		return fmt.Errorf("botão desconhecido: %s", button)
	}
	in := input{Type: inputMouse, Mi: mouseInput{DwFlags: flag}}
	return sendInputStruct(in)
}

func sendInputStruct(in input) error {
	ret, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
	if ret == 0 {
		return fmt.Errorf("SendInput falhou: %w", err)
	}
	return nil
}
```

Em `agent/livesession_windows.go`, substituir o stub:

```go
func handleLiveSessionInput(data []byte) {
	msg, err := parseInputMessage(data)
	if err != nil {
		logWarn(fmt.Sprintf("companion: input inválido recebido: %v", err))
		return
	}
	switch msg.Type {
	case "mousemove":
		_ = injectMouseMove(msg.X, msg.Y)
	case "mousedown":
		_ = injectMouseButton(msg.Button, true)
	case "mouseup":
		_ = injectMouseButton(msg.Button, false)
	default:
		logWarn(fmt.Sprintf("companion: tipo de input não suportado ainda: %s", msg.Type))
	}
}
```

Nota: teclado (`keydown`/`keyup`) fica como `default` (loga e ignora) por enquanto — mouse é
suficiente pra validar o fluxo fim a fim; adicionar `KEYBDINPUT` numa iteração futura se o André
confirmar que precisa de teclado também no piloto inicial.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd agent && go test -run TestParseInputMessage ./...`
Expected: PASS

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./...` e `go vet ./...`

- [ ] **Step 5: Commit**

```bash
git add agent/input_windows.go agent/livesession_windows.go agent/input_windows_test.go
git commit -m "feat(agent): injeção de mouse via SendInput (modo Normal)"
```

---

### Task 13: Version bump + SHA256 (checklist de deploy do agente)

**Files:**
- Modify: `agent/main.go`

Convenção já estabelecida no projeto (ver `feedback_agent_version_build` na memória): bump de
versão ANTES do build final, senão o auto-updater não detecta a versão nova.

- [ ] **Step 1: Não aplicável (não é mudança de lógica testável) — pular direto pro Step 3**

- [ ] **Step 3: Bump de versão**

Em `agent/main.go`, atualizar a constante:

```go
	Version            = "1.6.0" // minor bump: nova capacidade (companion/acesso remoto)
```

- [ ] **Step 4: Confirmar que o binário compila e reporta a versão nova**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build -o /tmp/delirio-agent-test.exe ./...`
(Em Windows puro, sem WSL/Git Bash cruzando pra Linux, usar path local em vez de `/tmp`.)

- [ ] **Step 5: Commit**

```bash
git add agent/main.go
git commit -m "chore(agent): bump versão 1.6.0 — modo companion / acesso remoto"
```

---

## Self-review (feito antes de entregar este plano)

- **Cobertura da spec**: Camada 1 (log de atividade) nas Tasks 1-5; Camada 2 (screenshot sob
  gatilho) nas Tasks 6-9 (o gatilho em si — checar watchlist e decidir disparar — já está no
  servidor, implementado; aqui só o lado do agente que EXECUTA a captura quando o comando chega);
  Camada 3 (sessão ao vivo) nas Tasks 7-12 (BitBlt reaproveitado), 8-12.
- **Dependências novas**: `github.com/Microsoft/go-winio` (named pipes) e
  `github.com/gorilla/websocket` (cliente WS) — ambas declaradas explicitamente nas tasks que as
  introduzem (8 e 11), nenhuma escondida.
- **Testabilidade**: todo syscall Win32 real (BitBlt, SendInput, WTSQueryUserToken,
  CreateProcessAsUser, WTSEnumerateSessions) está marcado explicitamente como "não testável em
  CI, verificar manualmente" — a lógica de decisão ao redor de cada um (que É testável) foi
  extraída pra função pura separada em toda task onde isso fez sentido.
- **Placeholder scan**: sem "TODO"/"TBD". Os stubs temporários (`requestScreenshotFromCompanionFn`,
  `startLiveSessionFn`/`stopLiveSessionFn`) são explicitamente proposital — cada um tem a task
  exata que o substitui, nomeada.
- **Consistência de tipos**: `pipeMessage` usado identicamente em `pipe_windows.go`,
  `commands.go` e `companion.go`; `captureScreenJPEGFn`/`sendPipeRequestFn` (as duas vars
  mockáveis) têm a mesma assinatura em toda task que as referencia.
