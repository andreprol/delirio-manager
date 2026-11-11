package main

import (
	"runtime"
	"sync"
	"testing"
)

// countingWriter conta chamadas de WriteMessage SEM nenhuma sincronizacao
// propria -- de proposito, pra que o teste abaixo prove que é o safeConn
// (nao o fake) quem serializa. runtime.Gosched() entre a leitura e a
// escrita de calls força uma troca de contexto no meio de uma operação
// read-modify-write não-atômica: se 2 goroutines executarem isso ao mesmo
// tempo SEM um mutex externo serializando as chamadas, pelo menos um
// incremento se perde (classic lost-update race) de forma confiável, sem
// precisar do -race detector (indisponível neste ambiente, sem toolchain
// C). Se countingWriter tivesse seu próprio mutex (como antes), o teste
// passaria mesmo com safeConn quebrado -- achado real de um code review.
type countingWriter struct {
	calls int
}

func (w *countingWriter) WriteMessage(messageType int, data []byte) error {
	current := w.calls
	runtime.Gosched()
	w.calls = current + 1
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
		t.Fatalf("esperava %d chamadas, teve %d -- safeConn nao serializou corretamente (lost update)", n, inner.calls)
	}
}
