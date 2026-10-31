'use strict';

const {
  registerSession, getSession, unregisterSession, routeMessage,
  attachCompanionSocket, attachDashboardSocket,
} = require('./liveSessionRelay');

function fakeSocket() {
  const sent = [];
  return { send: (data) => sent.push(data), _sent: sent, readyState: 1, OPEN: 1 };
}

describe('liveSessionRelay', () => {
  afterEach(() => unregisterSession('s1'));

  it('registra e recupera uma sessão', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    const session = getSession('s1');
    expect(session.machineId).toBe('m1');
    expect(session.mode).toBe('normal');
  });

  it('Normal: input do dashboard é repassado pro companion', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    const companionWs = fakeSocket();
    const session = getSession('s1');
    session.companionWs = companionWs;

    routeMessage('s1', 'dashboard', JSON.stringify({ type: 'input', key: 'a' }));

    expect(companionWs._sent).toHaveLength(1);
  });

  it('Shadow: input do dashboard NUNCA é repassado pro companion', () => {
    registerSession('s1', { machineId: 'm1', mode: 'shadow', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    const companionWs = fakeSocket();
    const session = getSession('s1');
    session.companionWs = companionWs;

    routeMessage('s1', 'dashboard', JSON.stringify({ type: 'input', key: 'a' }));

    expect(companionWs._sent).toHaveLength(0);
  });

  it('frame de vídeo do companion é sempre repassado pro dashboard, nos dois modos', () => {
    registerSession('s1', { machineId: 'm1', mode: 'shadow', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    const dashboardWs = fakeSocket();
    const session = getSession('s1');
    session.dashboardWs = dashboardWs;

    routeMessage('s1', 'companion', Buffer.from([1, 2, 3]));

    expect(dashboardWs._sent).toHaveLength(1);
  });

  it('unregisterSession remove a sessão', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    unregisterSession('s1');
    expect(getSession('s1')).toBeUndefined();
  });

  it('routeMessage em sessão inexistente não lança erro', () => {
    expect(() => routeMessage('nao-existe', 'dashboard', 'x')).not.toThrow();
  });

  it('mode ausente/inválido bloqueia input do dashboard, não só "shadow" exato', () => {
    registerSession('s1', { machineId: 'm1', mode: undefined, companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    const companionWs = fakeSocket();
    attachCompanionSocket('s1', companionWs);

    routeMessage('s1', 'dashboard', 'x');

    expect(companionWs._sent).toHaveLength(0);
  });

  it('registrar sessionId já existente lança erro, não sobrescreve em silêncio', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    expect(() =>
      registerSession('s1', { machineId: 'm2', mode: 'shadow', companionToken: 'tok-outro', dashboardToken: 'dash-outro' })
    ).toThrow();
    expect(getSession('s1').machineId).toBe('m1');
  });

  it('registerSession rejeita companionToken/dashboardToken vazio ou ausente', () => {
    expect(() =>
      registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: '', dashboardToken: 'dash-abc' })
    ).toThrow();
    expect(getSession('s1')).toBeUndefined();

    expect(() =>
      registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc' })
    ).toThrow();
    expect(getSession('s1')).toBeUndefined();
  });

  it('attachCompanionSocket/attachDashboardSocket anexam o socket na sessão', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    const companionWs = fakeSocket();
    const dashboardWs = fakeSocket();

    attachCompanionSocket('s1', companionWs);
    attachDashboardSocket('s1', dashboardWs);

    expect(getSession('s1').companionWs).toBe(companionWs);
    expect(getSession('s1').dashboardWs).toBe(dashboardWs);
  });
});

describe('initLiveRelay — conexão real', () => {
  const http = require('http');
  const WebSocket = require('ws');
  const { WebSocketServer } = require('ws');
  const { registerSession, initLiveRelay, unregisterSession, getSession, setDashboardUnlockGraceMsForTests } = require('./liveSessionRelay');
  const { createUpgradeRouter } = require('./upgradeRouter');

  let server;
  let port;

  beforeAll((done) => {
    server = http.createServer();
    const liveWss = initLiveRelay();
    // Um 2º WebSocketServer coexistindo no MESMO http.Server, exatamente
    // como /ws (services/websocket.js) coexiste em produção (server.js) —
    // é essa coexistência que causava o bug real: com {server, path} em
    // cada um (API antiga), o 1º registrado abortava com 400 qualquer
    // upgrade de path diferente do seu, ANTES do WebSocketServer certo ter
    // a chance de atender — mesmo direto no backend, sem passar pelo
    // nginx. Este teste SEMPRE testou initLiveRelay isolado (sem nenhum
    // outro WebSocketServer coexistindo), por isso nunca flagrou o
    // problema — achado só testando em produção.
    const otherWss = new WebSocketServer({ noServer: true });
    server.on('upgrade', createUpgradeRouter({ wsServer: otherWss, liveWss }));
    server.listen(0, () => { port = server.address().port; done(); });
  });

  afterAll((done) => { server.close(done); });
  afterEach(() => unregisterSession('s-real'));

  // Regressão achada em produção: com a API antiga ({server, path} em cada
  // WebSocketServer), esta conexão em /live recebia 400 do próprio /ws
  // (registrado "primeiro"), nunca chegando a abrir.
  it('conexão em /live funciona mesmo com outro WebSocketServer (/ws) coexistindo no mesmo http.Server', (done) => {
    registerSession('s-real', {
      machineId: 'm1', mode: 'shadow', companionToken: 'tok-123', dashboardToken: 'dash-123',
    });
    const dashboardWs = new WebSocket(
      `ws://localhost:${port}/live?sessionId=s-real&role=dashboard&token=dash-123`
    );
    dashboardWs.on('unexpected-response', (req, res) => {
      done(new Error(`esperava upgrade bem-sucedido, recebeu HTTP ${res.statusCode}`));
    });
    dashboardWs.on('error', (err) => done(err));
    dashboardWs.on('open', () => { dashboardWs.close(); done(); });
  });

  it('companion autenticado consegue conectar e dashboard recebe o frame', (done) => {
    registerSession('s-real', {
      machineId: 'm1', mode: 'shadow', companionToken: 'tok-123', dashboardToken: 'dash-123',
    });

    const dashboardWs = new WebSocket(
      `ws://localhost:${port}/live?sessionId=s-real&role=dashboard&token=dash-123`
    );
    let companionWs;

    dashboardWs.on('message', (data) => {
      expect(data.toString()).toBe('frame-de-teste');
      dashboardWs.close();
      companionWs.close();
      done();
    });

    dashboardWs.on('open', () => {
      companionWs = new WebSocket(
        `ws://localhost:${port}/live?sessionId=s-real&role=companion&token=tok-123`
      );
      companionWs.on('open', () => companionWs.send('frame-de-teste'));
    });
  });

  it('companion com token errado é desconectado', (done) => {
    registerSession('s-real', { machineId: 'm1', mode: 'shadow', companionToken: 'tok-correto', dashboardToken: 'dash-correto' });
    const ws = new WebSocket(`ws://localhost:${port}/live?sessionId=s-real&role=companion&token=errado`);
    ws.on('close', (code) => {
      expect(code).toBe(4001);
      done();
    });
  });

  it('dashboard sem dashboardToken correto é desconectado (sessionId sozinho não autoriza)', (done) => {
    registerSession('s-real', {
      machineId: 'm1', mode: 'shadow', companionToken: 'tok-123', dashboardToken: 'dash-correto',
    });
    const ws = new WebSocket(
      `ws://localhost:${port}/live?sessionId=s-real&role=dashboard&token=errado`
    );
    ws.on('close', (code) => {
      expect(code).toBe(4001);
      done();
    });
  });

  it('role inválido é desconectado', (done) => {
    registerSession('s-real', { machineId: 'm1', mode: 'shadow', companionToken: 'tok-123', dashboardToken: 'dash-123' });
    const ws = new WebSocket(`ws://localhost:${port}/live?sessionId=s-real&role=garbage`);
    ws.on('close', (code) => {
      expect(code).toBe(4002);
      done();
    });
  });

  it('sessão inexistente é recusada', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}/live?sessionId=nao-existe&role=dashboard`);
    ws.on('close', (code) => {
      expect(code).toBe(4000);
      done();
    });
  });

  // Operador pode cair sem clicar "desbloquear" (rede, crash do app) — o
  // servidor manda unlock-local-input pro companion por conta própria,
  // depois de uma folga (setDashboardUnlockGraceMsForTests encurta pro
  // teste não ficar lento), quando o socket do dashboard cai.
  it('mode normal: dashboard desconectar manda unlock-local-input pro companion, depois da folga', (done) => {
    setDashboardUnlockGraceMsForTests(20);
    registerSession('s-real', {
      machineId: 'm1', mode: 'normal', companionToken: 'tok-123', dashboardToken: 'dash-123',
    });

    const companionWs = new WebSocket(
      `ws://localhost:${port}/live?sessionId=s-real&role=companion&token=tok-123`
    );
    let dashboardWs;

    companionWs.on('message', (data) => {
      expect(JSON.parse(data.toString())).toEqual({ type: 'unlock-local-input' });
      setDashboardUnlockGraceMsForTests(5000);
      companionWs.close();
      done();
    });

    companionWs.on('open', () => {
      dashboardWs = new WebSocket(
        `ws://localhost:${port}/live?sessionId=s-real&role=dashboard&token=dash-123`
      );
      dashboardWs.on('open', () => dashboardWs.close());
    });
  });

  // Achado 🔴 do code-reviewer: sem a folga, um blip de rede que o dashboard
  // já resolve sozinho (1 retentativa automática, useLiveSession.js) liberava
  // o input físico da loja no meio do suporte, com a UI do operador nem
  // sabendo. Reconectar DENTRO da folga cancela o unlock agendado por
  // completo — nada deve chegar ao companion, nem depois da folga original
  // ter passado.
  it('mode normal: dashboard reconectar dentro da folga cancela o unlock agendado', (done) => {
    setDashboardUnlockGraceMsForTests(50);
    registerSession('s-real', {
      machineId: 'm1', mode: 'normal', companionToken: 'tok-123', dashboardToken: 'dash-123',
    });

    const companionWs = new WebSocket(
      `ws://localhost:${port}/live?sessionId=s-real&role=companion&token=tok-123`
    );
    const onUnexpectedMessage = (data) => {
      done(new Error(`companion não deveria receber nada, recebeu: ${data.toString()}`));
    };

    companionWs.on('message', onUnexpectedMessage);

    companionWs.on('open', () => {
      const dashboardA = new WebSocket(
        `ws://localhost:${port}/live?sessionId=s-real&role=dashboard&token=dash-123`
      );
      dashboardA.on('open', () => {
        dashboardA.close(); // cai — agenda o unlock pra dentro de 50ms

        // Reconecta ANTES da folga passar (simula a retentativa automática
        // do dashboard, useLiveSession.js) — deve cancelar o unlock agendado.
        setTimeout(() => {
          const dashboardB = new WebSocket(
            `ws://localhost:${port}/live?sessionId=s-real&role=dashboard&token=dash-123`
          );
          dashboardB.on('open', () => {
            // Espera além da folga original (50ms) pra confirmar que o
            // unlock agendado de verdade não disparou, não só que ainda não
            // tinha disparado.
            setTimeout(() => {
              companionWs.off('message', onUnexpectedMessage);
              dashboardB.close();
              companionWs.close();
              setDashboardUnlockGraceMsForTests(5000);
              done();
            }, 150);
          });
        }, 10);
      });
    });
  });

  // Operador fecha a janela (api.live.stop → unregisterSession) rápido
  // depois de um blip de rede, antes da folga do unlock agendado passar —
  // não deve sobrar nenhum timer tentando mandar algo pra uma sessão que
  // já não existe mais (routeMessage(sessionId inexistente) é no-op, mas
  // cancelPendingUnlock em unregisterSession evita até essa tentativa).
  it('mode normal: encerrar a sessão (unregister) durante a folga não quebra nem manda nada depois', (done) => {
    setDashboardUnlockGraceMsForTests(50);
    registerSession('s-real', {
      machineId: 'm1', mode: 'normal', companionToken: 'tok-123', dashboardToken: 'dash-123',
    });

    const companionWs = new WebSocket(
      `ws://localhost:${port}/live?sessionId=s-real&role=companion&token=tok-123`
    );
    const onUnexpectedMessage = (data) => {
      done(new Error(`companion não deveria receber nada, recebeu: ${data.toString()}`));
    };
    companionWs.on('message', onUnexpectedMessage);
    companionWs.on('error', (err) => done(err));

    companionWs.on('open', () => {
      const dashboardWs = new WebSocket(
        `ws://localhost:${port}/live?sessionId=s-real&role=dashboard&token=dash-123`
      );
      dashboardWs.on('open', () => {
        dashboardWs.close(); // agenda o unlock pra dentro de 50ms

        // Encerra a sessão de vez ANTES da folga passar — simula o operador
        // fechando a janela/api.live.stop logo depois do blip.
        setTimeout(() => {
          expect(() => unregisterSession('s-real')).not.toThrow();

          setTimeout(() => {
            companionWs.off('message', onUnexpectedMessage);
            companionWs.close();
            setDashboardUnlockGraceMsForTests(5000);
            done();
          }, 150);
        }, 10);
      });
    });
  });

  // Em mode shadow não existe controle remoto pra travar — o close do
  // dashboard não deve mandar nada pro companion (routeMessage já bloqueia
  // isso, este teste confirma que o close handler não contorna o allow-list,
  // esperando além da folga de verdade, não só que ainda não disparou).
  it('mode shadow: dashboard desconectar NÃO manda nada pro companion', (done) => {
    setDashboardUnlockGraceMsForTests(20);
    registerSession('s-real', {
      machineId: 'm1', mode: 'shadow', companionToken: 'tok-123', dashboardToken: 'dash-123',
    });

    const companionWs = new WebSocket(
      `ws://localhost:${port}/live?sessionId=s-real&role=companion&token=tok-123`
    );
    const onUnexpectedMessage = (data) => {
      done(new Error(`companion não deveria receber nada, recebeu: ${data.toString()}`));
    };
    let dashboardWs;

    companionWs.on('message', onUnexpectedMessage);

    companionWs.on('open', () => {
      dashboardWs = new WebSocket(
        `ws://localhost:${port}/live?sessionId=s-real&role=dashboard&token=dash-123`
      );
      dashboardWs.on('open', () => dashboardWs.close());
    });

    setTimeout(() => {
      companionWs.off('message', onUnexpectedMessage);
      companionWs.close();
      setDashboardUnlockGraceMsForTests(5000);
      done();
    }, 150);
  });
});
