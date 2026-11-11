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
