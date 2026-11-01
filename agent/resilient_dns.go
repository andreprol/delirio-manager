package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"
)

// fallbackDNSServers são resolvedores públicos usados só quando a resolução
// via DNS do sistema (o que o roteador/rede local da loja calhar de ter
// configurado) falha. Achado em produção (01/11/2026, KIONE-ESC): o DNS
// local da loja (pfSense) não resolvia o hostname do servidor
// ("no such host" / "No response from server"), mesmo com a rede geral da
// máquina saudável (IP/gateway ok, outros apps como AnyDesk funcionando
// normal) — porque AnyDesk não depende de resolver ESSE hostname específico
// via ESSE resolvedor. André apontou o ponto certo: não dá pra depender do
// DNS de cada uma das 130 lojas estar configurado direito; o agente tem que
// ser resiliente sozinho, do mesmo jeito que ferramentas comerciais de
// acesso remoto já são.
// Risco aceito (avaliado pelo code-reviewer, 01/11/2026): DNS puro
// (UDP/TCP:53, sem DoH/DNSSEC) pode ser spoofado por quem já está no mesmo
// segmento de rede onde o DNS local está suspeito. A mitigação real não é
// aqui — é o TLS da conexão HTTPS/WSS seguinte: um IP forjado sem a chave
// privada de dt-manager.brazilsouth.cloudapp.azure.com falha o handshake
// (nenhum InsecureSkipVerify/tls.Config custom existe neste pacote). Blast
// radius de um fallback envenenado é DoS (conexão falha), não MITM.
var fallbackDNSServers = []string{"8.8.8.8:53", "1.1.1.1:53"}

// systemDialFn/fallbackLookupFn: substituíveis em teste, mesmo padrão já
// usado neste pacote (enumerateSessionsFn, isCompanionAliveFn etc.) —
// resolução DNS real não é testável em CI de forma determinística.
var (
	systemDialFn     = (&net.Dialer{Timeout: 10 * time.Second}).DialContext
	fallbackLookupFn = lookupHostViaDNSServer
)

// primaryDialTimeout limita a 1ª tentativa (DNS do sistema) — achado 🟠 do
// code-reviewer: o cenário real de produção é "No response from server"
// (servidor DNS não responde, não um NXDOMAIN rápido), que sem este teto
// consumiria quase todo o budget do ctx externo (ex: hbClient.Timeout=10s)
// antes mesmo de tentar o fallback, deixando pouco ou nenhum tempo pra ele
// completar dentro do mesmo deadline. context.WithTimeout usa o MENOR entre
// este valor e o deadline que já existir no ctx recebido — nunca estende um
// ctx mais curto, só encurta um mais longo.
const primaryDialTimeout = 3 * time.Second

// resilientDialContext tenta a conexão normal primeiro (resolução via
// resolvedor do sistema — mais rápido no caminho feliz, e cobre qualquer
// rede saudável sem overhead extra), com teto de primaryDialTimeout pra
// sobrar tempo real pro fallback dentro do mesmo ctx. Só se isso falhar com
// um erro de DNS (não qualquer erro de rede — timeout de TCP após resolver
// certo, por exemplo, não deveria tentar DNS alternativo) tenta de novo
// resolvendo o host via DNS público fixo, usando o ctx ORIGINAL (resto do
// budget, não mais limitado a primaryDialTimeout). Usado tanto pelo
// http.Client (heartbeat/comandos) quanto pelo dial da WebSocket do
// companion (live session) — qualquer caminho que precise alcançar o
// servidor por hostname.
func resilientDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	primaryCtx, cancel := context.WithTimeout(ctx, primaryDialTimeout)
	conn, err := systemDialFn(primaryCtx, network, addr)
	cancel()
	if err == nil {
		return conn, nil
	}
	if !isDNSFailure(err) {
		return nil, err
	}

	host, port, splitErr := net.SplitHostPort(addr)
	if splitErr != nil {
		return nil, err
	}

	for _, dnsServer := range fallbackDNSServers {
		ips, lookupErr := fallbackLookupFn(ctx, dnsServer, host)
		if lookupErr != nil || len(ips) == 0 {
			continue
		}
		fallbackConn, dialErr := systemDialFn(ctx, network, net.JoinHostPort(ips[0], port))
		if dialErr == nil {
			logWarn(fmt.Sprintf("DNS do sistema falhou pra %s, resolvido via %s (fallback)", host, dnsServer))
			return fallbackConn, nil
		}
	}
	// Devolve o erro ORIGINAL (do DNS do sistema), não o do último fallback
	// tentado — mais útil pro log/diagnóstico, é a causa real.
	return nil, err
}

// isDNSFailure distingue erro de RESOLUÇÃO (hostname não encontrado,
// servidor DNS não respondeu) de qualquer outro erro de rede (porta
// fechada, timeout de TCP com o IP já resolvido certo, etc.) — só o
// primeiro caso justifica tentar um resolvedor alternativo; os demais são
// erros reais de conectividade que um DNS diferente não resolveria.
func isDNSFailure(err error) bool {
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr)
}

// lookupHostViaDNSServer resolve host usando especificamente dnsServer
// (ex: "8.8.8.8:53"), ignorando o resolvedor do sistema — implementação
// real usada em produção; mockada em teste via fallbackLookupFn.
func lookupHostViaDNSServer(ctx context.Context, dnsServer, host string) ([]string, error) {
	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: 5 * time.Second}
			return d.DialContext(ctx, network, dnsServer)
		},
	}
	return resolver.LookupHost(ctx, host)
}
