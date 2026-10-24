package main

import (
	"encoding/json"
	"testing"
	"time"
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

// TestPipeRoundtrip sobe um listener real (servidor) numa goroutine com um
// handler fake, manda uma requisição via sendPipeRequest (cliente) na mesma
// pipe, e confirma que a resposta volta corretamente. Depois pede pro
// listener parar via stopCh e confirma que ele encerra (sem travar o teste).
func TestPipeRoundtrip(t *testing.T) {
	stopCh := make(chan struct{})
	done := make(chan struct{})

	handler := func(msg pipeMessage) pipeMessage {
		if msg.Type != "ping" || msg.RequestID != "req-roundtrip" {
			return pipeMessage{RequestID: msg.RequestID, Error: "mensagem inesperada"}
		}
		return pipeMessage{Type: "pong", RequestID: msg.RequestID}
	}

	go func() {
		defer close(done)
		listenPipe(handler, stopCh)
	}()

	// SEM sleep aqui de propósito: sendPipeRequest agora tem retry próprio
	// (pipeDialRetryInterval) especificamente pra cobrir o caso de o
	// listener ainda não ter chamado winio.ListenPipe quando o cliente já
	// tenta conectar — é exatamente essa corrida que este teste exercita.
	resp, err := sendPipeRequest(pipeMessage{Type: "ping", RequestID: "req-roundtrip"}, 2*time.Second)
	if err != nil {
		t.Fatalf("sendPipeRequest: %v", err)
	}
	if resp.Type != "pong" || resp.RequestID != "req-roundtrip" {
		t.Errorf("resp = %+v, want Type=pong RequestID=req-roundtrip", resp)
	}

	close(stopCh)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("listenPipe não encerrou após stopCh fechado")
	}
}
