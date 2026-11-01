package main

import (
	"context"
	"errors"
	"net"
	"testing"
)

// fakeConn satisfaz net.Conn minimamente — só a identidade do valor importa
// nos testes abaixo (comparar se o conn devolvido é o esperado).
type fakeConn struct {
	net.Conn
	tag string
}

func TestIsDNSFailure(t *testing.T) {
	t.Run("net.DNSError é falha de DNS", func(t *testing.T) {
		if !isDNSFailure(&net.DNSError{Err: "no such host", Name: "exemplo.com"}) {
			t.Fatal("esperava true pra *net.DNSError")
		}
	})
	t.Run("erro genérico não é falha de DNS", func(t *testing.T) {
		if isDNSFailure(errors.New("connection refused")) {
			t.Fatal("esperava false pra erro genérico — não deveria tentar DNS alternativo")
		}
	})
	t.Run("erro de timeout de TCP (não-DNS) não é falha de DNS", func(t *testing.T) {
		if isDNSFailure(&net.OpError{Op: "dial", Err: errors.New("i/o timeout")}) {
			t.Fatal("esperava false — host já resolvido certo, timeout é problema de conectividade, não de DNS")
		}
	})
}

func TestResilientDialContext(t *testing.T) {
	origDial, origLookup := systemDialFn, fallbackLookupFn
	defer func() { systemDialFn, fallbackLookupFn = origDial, origLookup }()

	t.Run("DNS do sistema funciona: usa direto, nunca tenta fallback", func(t *testing.T) {
		lookupCalls := 0
		fallbackLookupFn = func(context.Context, string, string) ([]string, error) {
			lookupCalls++
			return nil, errors.New("não deveria ser chamado")
		}
		systemDialFn = func(_ context.Context, _, addr string) (net.Conn, error) {
			return &fakeConn{tag: "direto:" + addr}, nil
		}

		conn, err := resilientDialContext(context.Background(), "tcp", "servidor.exemplo.com:443")
		if err != nil {
			t.Fatalf("erro inesperado: %v", err)
		}
		if conn.(*fakeConn).tag != "direto:servidor.exemplo.com:443" {
			t.Fatalf("conn inesperado: %v", conn.(*fakeConn).tag)
		}
		if lookupCalls != 0 {
			t.Fatalf("fallbackLookupFn chamado %d vezes, want 0", lookupCalls)
		}
	})

	t.Run("erro não-DNS (ex: porta fechada): devolve direto, nunca tenta fallback", func(t *testing.T) {
		lookupCalls := 0
		fallbackLookupFn = func(context.Context, string, string) ([]string, error) {
			lookupCalls++
			return nil, errors.New("não deveria ser chamado")
		}
		wantErr := errors.New("connection refused")
		systemDialFn = func(context.Context, string, string) (net.Conn, error) {
			return nil, wantErr
		}

		_, err := resilientDialContext(context.Background(), "tcp", "servidor.exemplo.com:443")
		if !errors.Is(err, wantErr) {
			t.Fatalf("erro = %v, want %v (erro original, sem tentar fallback)", err, wantErr)
		}
		if lookupCalls != 0 {
			t.Fatalf("fallbackLookupFn chamado %d vezes, want 0 — erro não é de DNS", lookupCalls)
		}
	})

	t.Run("DNS do sistema falha, 1º fallback resolve e conecta", func(t *testing.T) {
		dnsErr := &net.DNSError{Err: "no such host", Name: "servidor.exemplo.com"}
		systemDialFn = func(_ context.Context, _, addr string) (net.Conn, error) {
			if addr == "servidor.exemplo.com:443" {
				return nil, dnsErr
			}
			return &fakeConn{tag: "fallback:" + addr}, nil
		}
		var gotServer string
		fallbackLookupFn = func(_ context.Context, dnsServer, host string) ([]string, error) {
			gotServer = dnsServer
			if host != "servidor.exemplo.com" {
				t.Fatalf("lookup host = %q, want servidor.exemplo.com", host)
			}
			return []string{"1.2.3.4"}, nil
		}

		conn, err := resilientDialContext(context.Background(), "tcp", "servidor.exemplo.com:443")
		if err != nil {
			t.Fatalf("erro inesperado: %v", err)
		}
		if conn.(*fakeConn).tag != "fallback:1.2.3.4:443" {
			t.Fatalf("conn = %v, want conexão no IP resolvido pelo fallback", conn.(*fakeConn).tag)
		}
		if gotServer != fallbackDNSServers[0] {
			t.Fatalf("usou servidor DNS %q, want 1º da lista (%q)", gotServer, fallbackDNSServers[0])
		}
	})

	t.Run("DNS do sistema falha, 1º fallback erra lookup, 2º resolve", func(t *testing.T) {
		if len(fallbackDNSServers) < 2 {
			t.Skip("precisa de pelo menos 2 servidores fallback configurados")
		}
		dnsErr := &net.DNSError{Err: "no such host"}
		systemDialFn = func(_ context.Context, _, addr string) (net.Conn, error) {
			if addr == "servidor.exemplo.com:443" {
				return nil, dnsErr
			}
			return &fakeConn{tag: "fallback:" + addr}, nil
		}
		fallbackLookupFn = func(_ context.Context, dnsServer, _ string) ([]string, error) {
			if dnsServer == fallbackDNSServers[0] {
				return nil, errors.New("1º fallback indisponível")
			}
			return []string{"5.6.7.8"}, nil
		}

		conn, err := resilientDialContext(context.Background(), "tcp", "servidor.exemplo.com:443")
		if err != nil {
			t.Fatalf("erro inesperado: %v", err)
		}
		if conn.(*fakeConn).tag != "fallback:5.6.7.8:443" {
			t.Fatalf("conn = %v, want IP resolvido pelo 2º fallback", conn.(*fakeConn).tag)
		}
	})

	t.Run("DNS do sistema falha, TODOS os fallbacks falham: devolve o erro ORIGINAL", func(t *testing.T) {
		originalErr := &net.DNSError{Err: "no such host", Name: "servidor.exemplo.com"}
		systemDialFn = func(_ context.Context, _, addr string) (net.Conn, error) {
			if addr == "servidor.exemplo.com:443" {
				return nil, originalErr
			}
			return nil, errors.New("fallback dial também falhou")
		}
		fallbackLookupFn = func(context.Context, string, string) ([]string, error) {
			return nil, errors.New("lookup falhou")
		}

		_, err := resilientDialContext(context.Background(), "tcp", "servidor.exemplo.com:443")
		if !errors.Is(err, originalErr) {
			t.Fatalf("erro = %v, want erro ORIGINAL do DNS do sistema (%v) — mais útil pro diagnóstico que o erro do fallback", err, originalErr)
		}
	})

	t.Run("addr sem porta: devolve erro original sem panicar", func(t *testing.T) {
		dnsErr := &net.DNSError{Err: "no such host"}
		systemDialFn = func(context.Context, string, string) (net.Conn, error) {
			return nil, dnsErr
		}
		fallbackLookupFn = func(context.Context, string, string) ([]string, error) {
			t.Fatal("não deveria tentar lookup — SplitHostPort já falhou")
			return nil, nil
		}

		_, err := resilientDialContext(context.Background(), "tcp", "endereco-sem-porta")
		if !errors.Is(err, dnsErr) {
			t.Fatalf("erro = %v, want erro original", err)
		}
	})
}
