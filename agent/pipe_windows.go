package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const pipeName = `\\.\pipe\DelirioCompanion`

// pipeMessage é o protocolo local entre serviço (cliente) e companion
// (servidor da pipe). RequestID correlaciona pedido/resposta; Error
// preenchido só na resposta, em caso de falha do lado do companion.
type pipeMessage struct {
	Type             string `json:"type"` // "capture-screenshot" | "start-live-session" | "stop-live-session"
	RequestID        string `json:"requestId"`
	SessionID        string `json:"sessionId,omitempty"`
	Mode             string `json:"mode,omitempty"`
	CompanionToken   string `json:"companionToken,omitempty"`
	ServerURL        string `json:"serverUrl,omitempty"`
	ResultJPEGBase64 string `json:"resultJpegBase64,omitempty"`
	Error            string `json:"error,omitempty"`
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
	_ = conn.SetDeadline(time.Now().Add(timeout)) // melhor esforço — se falhar, timeout já cobre a chamada via DialPipe

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

// currentUserSID devolve a SID textual (S-1-...) da conta sob a qual o
// processo atual está rodando, lendo o token primário do próprio processo.
// Usada por pipeSecurityDescriptor para montar o DACL da pipe sem precisar
// hardcodar nenhuma SID de usuário (que varia por máquina/sessão).
func currentUserSID() (string, error) {
	tok := windows.GetCurrentProcessToken()
	u, err := tok.GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("obter SID do usuário atual: %w", err)
	}
	return u.User.Sid.String(), nil
}

// pipeSecurityDescriptor monta o SDDL do DACL aplicado à pipe. Histórico da
// investigação de segurança feita antes de fechar esta task (3 tentativas,
// a 3ª é a usada):
//
// 1) winio.ListenPipe(path, nil) — PipeConfig.SecurityDescriptor vazio — usa
// o default do Windows (RtlDefaultNpAcl via NTDLL, o mesmo que CreateNamedPipe
// usa quando lpSecurityAttributes é NULL). Documentado pela própria
// Microsoft (remarks de CreateNamedPipe): concede controle total a
// LocalSystem, Administrators e "Creator Owner", e concede LEITURA ao grupo
// Everyone e à conta anônima. Isso é permissivo demais pro cenário (~224
// máquinas corporativas, qualquer processo do usuário logado pode
// bisbilhotar mensagens via Everyone-read; e "Creator Owner" dá controle
// TOTAL — não só leitura — a qualquer processo rodando sob a MESMA conta do
// usuário interativo que lança o companion via CreateProcessAsUser, não só
// ao companion.exe especificamente). Rejeitado.
//
// 2) Restringir explicitamente a só SY (serviço, que roda como SYSTEM) +
// BA (Administrators, pra diagnóstico manual), sem Creator Owner nem
// Everyone — testado e DERRUBA O PRÓPRIO COMPANION: descobri via o teste de
// integração deste arquivo (TestPipeRoundtrip) que o DACL da pipe não é
// checado só na conexão do CLIENTE (sendPipeRequest/DialPipe) — o SERVIDOR
// também é checado a cada Accept(), porque toda instância de pipe aceita
// depois da primeira é reaberta internamente pelo go-winio via
// CreateFile/NtCreateNamedPipeFile pedindo GENERIC_READ|GENERIC_WRITE,
// sujeito ao mesmo DACL. Como o companion roda como o usuário interativo
// (não SYSTEM, não necessariamente Administrators), excluir essa identidade
// do DACL faz TODO Accept() falhar com "Access is denied" — o companion
// nunca aceita nenhuma conexão. Confirmado com um repro isolado fora do
// pacote antes de descartar. Rejeitado.
//
// 3) Tentativa de usar o alias SDDL "CO" (Creator Owner) no lugar de uma SID
// fixa, esperando que o kernel substituísse pela SID real de quem criou a
// pipe (é assim que o default do Windows no item 1 concede controle total
// ao criador). Também testado isoladamente e DEU ACCESS DENIED, inclusive
// pro próprio processo criador: "Creator Owner"/"Creator Group" só são
// substituídos pela SID real durante o algoritmo de herança de ACEs
// (SeAssignSecurity a partir de ACEs herdáveis de um objeto pai) — pipes
// nomeados aqui não têm esse contexto de herança do jeito que construímos o
// SD (DACL aplicado direto, não herdado), então o literal S-1-3-0 fica no
// ACE e nunca bate com nenhuma SID de token real. Rejeitado (e o resultado
// desse teste descartado do arquivo de teste final — não vale manter um
// teste que força um caminho conhecidamente errado).
//
// Decisão final: resolver a SID do usuário sob o qual o companion está
// rodando EM TEMPO DE EXECUÇÃO (currentUserSID, via
// golang.org/x/sys/windows — já dependência do módulo) e embuti-la
// literalmente no DACL. Isso concede exatamente:
//   - SY (NT AUTHORITY\SYSTEM)    — GENERIC_ALL — identidade do serviço (cliente).
//   - a SID resolvida            — GENERIC_ALL — identidade real do companion
//     (o usuário logado interativo), sem precisar de nenhum SID hardcoded —
//     funciona em qualquer uma das ~224 máquinas.
//   - BA (BUILTIN\Administrators) — GENERIC_ALL — diagnóstico manual; processos
//     NÃO elevados de uma conta admin não carregam esse grupo no token
//     (UAC split-token), então isso não reabre a brecha do item 1.
//
// "D:P" = DACL protegido (não herda ACEs de um pai). Sem ACE para
// "Everyone"/"Authenticated Users", nenhum outro processo do sistema
// consegue nem abrir a pipe.
//
// RISCO RESIDUAL CONHECIDO (pra eu, controller, avaliar): como o companion
// roda como o usuário interativo comum (não uma conta de serviço fixa), e o
// Windows faz o access-check de Accept() contra a identidade REAL do
// processo chamador (não contra "este .exe específico"), a SID resolvida
// aqui inevitavelmente concede o mesmo acesso total a QUALQUER OUTRO
// processo que rode sob essa mesma conta de usuário — exatamente o mesmo
// problema que motivou rejeitar "Creator Owner" no item 1, só que agora
// como consequência inevitável (e não mais evitável só com ACL do Windows)
// de o companion ter que se autoconceder acesso pra conseguir aceitar
// conexões. Fechar essa lacuna de verdade exigiria autenticação no próprio
// protocolo pipeMessage (um segredo compartilhado serviço↔companion,
// independente do CompanionToken que é servidor↔companion via WebSocket) ou
// trocar a arquitetura pra o SERVIÇO (SYSTEM, identidade fixa) ser quem
// cria/possui a pipe em vez do companion — nenhuma das duas está no escopo
// desta task. O que esta ACL garante de fato, na prática, é bloquear
// Everyone/anônimo/outros usuários da máquina — não bloqueia outro processo
// do MESMO usuário logado.
func pipeSecurityDescriptor() string {
	selfSID, err := currentUserSID()
	if err != nil {
		// Não deveria acontecer em condições normais (todo processo tem um
		// token primário com User SID) — mas se acontecer, cair pro default
		// do Windows (nil) é a única forma do companion continuar
		// funcionando. Loga alto (ERROR, vai pro Windows Event Log também)
		// porque isso reabre a exposição a Everyone/anônimo documentada no
		// item 1 acima, e precisa ser investigado se aparecer em produção.
		logError(fmt.Sprintf("companion: não obteve SID própria pra restringir ACL da pipe — usando default do Windows (mais permissivo, ver comentário em pipe_windows.go#pipeSecurityDescriptor): %v", err))
		return ""
	}
	return fmt.Sprintf("D:P(A;;GA;;;SY)(A;;GA;;;%s)(A;;GA;;;BA)", selfSID)
}

// listenPipe roda no COMPANION: aceita conexões na pipe local e despacha
// cada mensagem pro handler correspondente. O DACL aplicado (ver
// pipeSecurityDescriptor acima) restringe quem consegue abrir a pipe.
func listenPipe(handler func(pipeMessage) pipeMessage, stopCh <-chan struct{}) {
	cfg := &winio.PipeConfig{SecurityDescriptor: pipeSecurityDescriptor()}
	listener, err := winio.ListenPipe(pipeName, cfg)
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
			// Melhor esforço — conn fecha via defer de qualquer forma; se a
			// escrita falhar, o cliente trata como erro de leitura da pipe.
			_, _ = conn.Write(append(data, '\n'))
		}()
	}
}
