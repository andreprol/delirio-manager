package main

import (
	"testing"
)

func TestMagicPacketFormat(t *testing.T) {
	// WoL via loopback nao envia de verdade, mas valida a logica do pacote
	// Para testar sem rede: verificamos so a geracao do payload

	tests := []struct {
		mac       string
		wantError bool
	}{
		{"AA:BB:CC:DD:EE:FF", false},
		{"AA-BB-CC-DD-EE-FF", false},
		{"aabbccddeeff", false},
		{"ZZ:BB:CC:DD:EE:FF", true},  // hex invalido
		{"AA:BB:CC:DD:EE", true},     // MAC curto
		{"", true},                   // vazio
	}

	for _, tt := range tests {
		err := sendMagicPacket(tt.mac, "127.0.0.1") // loopback — nao envia de verdade
		if tt.wantError && err == nil {
			t.Errorf("MAC %q: esperava erro, nao obteve", tt.mac)
		}
		if !tt.wantError && err != nil {
			t.Errorf("MAC %q: nao esperava erro, obteve: %v", tt.mac, err)
		}
	}
}

func TestLocalBroadcast(t *testing.T) {
	b := localBroadcast()
	if b == "" {
		t.Error("localBroadcast retornou string vazia")
	}
	// Deve retornar um IP valido (nao vazio, nao so pontos)
	if len(b) < 7 {
		t.Errorf("broadcast parece invalido: %q", b)
	}
}
