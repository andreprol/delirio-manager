package main

import (
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
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
			if err := sc.WriteMessageWithDeadline(1, []byte("x"), time.Now().Add(time.Second)); err != nil {
				t.Errorf("WriteMessageWithDeadline: %v", err)
			}
		}()
	}
	wg.Wait()

	if inner.calls != n {
		t.Fatalf("esperava %d chamadas, teve %d -- safeConn nao serializou corretamente (lost update)", n, inner.calls)
	}
}

// deadlineThenWriteFake grava, com seu PRÓPRIO mutex só pra proteger o
// slice de log (não pra serializar a chamada em si -- quem tem que fazer
// isso é o safeConn sob teste), a ordem exata de SetWriteDeadline/
// WriteMessage que recebe. runtime.Gosched() dentro de SetWriteDeadline
// força uma janela de troca de contexto bem no meio da operação -- se
// WriteMessageWithDeadline não travar UM mutex só em volta dos dois
// passos (era o bug real: 2 locks separados, ver wsconn_windows.go),
// outra goroutine concorrente consegue intercalar seu próprio par nessa
// janela, corrompendo a ordem abaixo.
type deadlineThenWriteFake struct {
	logMu sync.Mutex
	log   []string
}

func (f *deadlineThenWriteFake) record(entry string) {
	f.logMu.Lock()
	f.log = append(f.log, entry)
	f.logMu.Unlock()
}

func (f *deadlineThenWriteFake) SetWriteDeadline(t time.Time) error {
	f.record("deadline:" + t.String())
	runtime.Gosched()
	return nil
}

func (f *deadlineThenWriteFake) WriteMessage(messageType int, data []byte) error {
	f.record("write:" + string(data))
	return nil
}

// TestSafeConnWriteMessageWithDeadlineIsAtomic prova que SetWriteDeadline
// e o WriteMessage que ele protege nunca se separam -- cada chamada
// concorrente usa um deadline ÚNICO (índice codificado no próprio valor),
// e o log tem que mostrar sempre o par (deadline:N, write:owner-N)
// adjacente, nunca o deadline de uma chamada seguido do write de outra.
func TestSafeConnWriteMessageWithDeadlineIsAtomic(t *testing.T) {
	inner := &deadlineThenWriteFake{}
	sc := newSafeConn(inner)

	const n = 20
	deadlines := make([]time.Time, n)
	for i := 0; i < n; i++ {
		deadlines[i] = time.Unix(0, int64(i+1))
	}

	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			owner := fmt.Sprintf("owner-%d", i)
			if err := sc.WriteMessageWithDeadline(1, []byte(owner), deadlines[i]); err != nil {
				t.Errorf("WriteMessageWithDeadline: %v", err)
			}
		}(i)
	}
	wg.Wait()

	inner.logMu.Lock()
	defer inner.logMu.Unlock()
	if len(inner.log) != n*2 {
		t.Fatalf("esperava %d entradas no log (1 deadline + 1 write por chamada), teve %d: %v", n*2, len(inner.log), inner.log)
	}
	for i := 0; i < len(inner.log); i += 2 {
		deadlineEntry := inner.log[i]
		writeEntry := inner.log[i+1]
		if !strings.HasPrefix(deadlineEntry, "deadline:") || !strings.HasPrefix(writeEntry, "write:") {
			t.Fatalf("par na posição %d/%d fora de ordem (deadline de uma chamada intercalado com write de outra): %v", i, i+1, inner.log)
		}
		owner := strings.TrimPrefix(writeEntry, "write:")
		idx, err := strconv.Atoi(strings.TrimPrefix(owner, "owner-"))
		if err != nil {
			t.Fatalf("write com owner inesperado %q: %v", owner, err)
		}
		wantDeadline := "deadline:" + deadlines[idx].String()
		if deadlineEntry != wantDeadline {
			t.Fatalf("write de %s veio depois do deadline de OUTRA chamada (%s, queria %s) -- SetWriteDeadline e WriteMessage não são atômicos", owner, deadlineEntry, wantDeadline)
		}
	}
}
