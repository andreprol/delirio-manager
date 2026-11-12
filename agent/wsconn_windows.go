package main

import (
	"sync"
	"time"
)

// messageWriter é o subconjunto mínimo que newSafeConn exige do conn
// embrulhado — só WriteMessage, não o frameWriter inteiro. Isso permite
// testar safeConn com um fake que não implementa SetWriteDeadline
// (TestSafeConnSerializesConcurrentWrites usa um countingWriter assim), e
// ainda assim aceitar o *websocket.Conn real (que tem os dois métodos) em
// produção — ele satisfaz messageWriter trivialmente, por ter WriteMessage.
type messageWriter interface {
	WriteMessage(messageType int, data []byte) error
}

// safeConn serializa WriteMessage (e SetWriteDeadline) entre goroutines
// concorrentes — gorilla/websocket só permite 1 escritor por vez na mesma
// conexão (reads e writes podem ser concorrentes entre si, mas não 2 writes
// ao mesmo tempo, e SetWriteDeadline entra no mesmo grupo de "métodos de
// escrita" pela própria documentação do gorilla). Antes da transferência de
// arquivo, só sendLiveSessionFrame escrevia (goroutine principal, via
// ticker). Agora a goroutine de download de arquivo também escreve
// (progresso/done/erro), concorrente com os frames de vídeo.
//
// 🔴 bug real corrigido aqui (achado em produção 12/11/2026 — ver memória
// do projeto, "transferência de arquivo trava a sessão"): SetWriteDeadline
// e WriteMessage eram 2 MÉTODOS PÚBLICOS separados, cada um com seu próprio
// Lock/Unlock — sendLiveSessionFrame chamava um, depois o outro, contando
// que o deadline setado valesse pra ESSE write específico. Mas entre as
// duas chamadas o mutex era liberado, e a goroutine de transferência de
// arquivo (sem deadline próprio, só WriteMessage) podia intercalar sua
// própria escrita nessa janela — como o deadline é estado ABSOLUTO da
// conexão (não por mensagem), essa escrita concorrente consumia parte do
// prazo que era pra proteger o frame de vídeo. Quando isso estourava o
// deadline do frame, sendLiveSessionFrame retornava false e
// runLiveSessionLoop encerrava a sessão inteira — sem fechar nem avisar o
// socket do dashboard (ver liveSessionRelay.js), virando "a tela congela e
// não funciona mais" sem erro nenhum na tela.
//
// WriteMessageWithDeadline substitui os 2 métodos por 1 só, cobrindo os 2
// passos com UM ÚNICO Lock — nenhuma outra goroutine consegue mais
// intercalar entre "setar o deadline" e "escrever com esse deadline".
type safeConn struct {
	mu   sync.Mutex
	conn messageWriter
}

func newSafeConn(conn messageWriter) *safeConn {
	return &safeConn{conn: conn}
}

// WriteMessageWithDeadline seta o deadline de escrita e grava a mensagem
// numa seção crítica só — ver comentário do tipo safeConn pro bug real que
// isto corrige. SetWriteDeadline faz type-assertion pra dentro, delegando
// pro conn real quando ele suporta (sempre o caso em produção, onde conn é
// um *websocket.Conn); um fake de teste sem SetWriteDeadline simplesmente
// não recebe a chamada nesse caminho.
func (s *safeConn) WriteMessageWithDeadline(messageType int, data []byte, deadline time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.conn.(interface{ SetWriteDeadline(time.Time) error }); ok {
		if err := d.SetWriteDeadline(deadline); err != nil {
			return err
		}
	}
	return s.conn.WriteMessage(messageType, data)
}
