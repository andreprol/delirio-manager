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
// (progresso/done/erro), concorrente com os frames de vídeo — sem isso,
// corrupção de frame no WS.
//
// *safeConn implementa frameWriter inteiro (SetWriteDeadline + WriteMessage)
// mesmo guardando só um messageWriter internamente — runLiveSessionLoop
// passa este wrapper tanto pra sendLiveSessionFrame (que chama os dois
// métodos) quanto pra readLiveSessionInput (que o repassa como frameWriter
// pra applyFileTransferFn), então precisa satisfazer a interface inteira
// pra compilar nos dois pontos de uso. SetWriteDeadline faz type-assertion
// pra dentro, delegando pro conn real quando ele suporta (sempre o caso em
// produção, onde conn é um *websocket.Conn); um fake de teste sem
// SetWriteDeadline (como countingWriter) simplesmente não recebe a chamada
// nesse caminho — nenhum teste atual exercita SetWriteDeadline via safeConn.
type safeConn struct {
	mu   sync.Mutex
	conn messageWriter
}

func newSafeConn(conn messageWriter) *safeConn {
	return &safeConn{conn: conn}
}

func (s *safeConn) WriteMessage(messageType int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.WriteMessage(messageType, data)
}

func (s *safeConn) SetWriteDeadline(t time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.conn.(interface{ SetWriteDeadline(time.Time) error }); ok {
		return d.SetWriteDeadline(t)
	}
	return nil
}
