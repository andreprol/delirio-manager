'use strict';

const {
  registerSession, getSession, unregisterSession, routeMessage,
  attachCompanionSocket, attachDashboardSocket,
} = require('./liveSessionRelay');

function fakeSocket() {
  const sent = [];
  const sentOptions = [];
  return {
    send: (data, options, callback) => {
      sent.push(data);
      sentOptions.push(typeof options === 'object' ? options : undefined);
      const cb = typeof options === 'function' ? options : callback;
      if (cb) cb();
    },
    _sent: sent,
    _sentOptions: sentOptions,
    readyState: 1,
    OPEN: 1,
  };
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

  // Achado real em produção (André, 11/11/2026): a lib `ws` sempre entrega
  // `data` como Buffer no evento 'message', seja o frame original
  // TextMessage ou BinaryMessage -- sem repassar o 2º argumento do evento
  // (isBinary) pro `.send()` de saída, `ws` infere `binary: typeof data !==
  // 'string'` (sempre true pra um Buffer), convertendo TODO frame de texto
  // em binário ao sair daqui. O companion manda file-transfer-progress/
  // -done/-error como TextMessage de propósito (agent/filetransfer_windows.go)
  // -- sem este fix, o dashboard recebia isso como frame BINÁRIO, tentava
  // decodificar o JSON como imagem de vídeo (createImageBitmap) e lançava
  // "InvalidStateError: source image could not be decoded", sem NUNCA
  // processar o status de verdade (silêncio total na UI de transferência).
  it('routeMessage preserva isBinary (texto permanece texto, binário permanece binário) ao repassar', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    const session = getSession('s1');
    const dashboardWs = fakeSocket();
    session.dashboardWs = dashboardWs;

    // Companion manda file-transfer-progress como TextMessage (isBinary=false).
    routeMessage('s1', 'companion', Buffer.from(JSON.stringify({ type: 'file-transfer-progress' })), false);
    // Companion manda um frame de vídeo JPEG como BinaryMessage (isBinary=true).
    routeMessage('s1', 'companion', Buffer.from([0xff, 0xd8, 0xff]), true);

    expect(dashboardWs._sentOptions).toEqual([{ binary: false }, { binary: true }]);
  });

  it('routeMessage sem isBinary (chamador não passou) repassa como texto por padrão', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    const session = getSession('s1');
    const companionWs = fakeSocket();
    session.companionWs = companionWs;

    routeMessage('s1', 'dashboard', JSON.stringify({ type: 'unlock-local-input' }));

    expect(companionWs._sentOptions).toEqual([{ binary: false }]);
  });

  it('unregisterSession remove a sessão', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    unregisterSession('s1');
    expect(getSession('s1')).toBeUndefined();
  });

  // Achado do code-reviewer: sem fechar os sockets aqui, um POST /stop
  // disparado de outro lugar nunca avisava o dashboard (nem o companion)
  // que a sessão acabou -- a janela do Acesso Remoto ficava "Conectado" pra
  // sempre com o último frame congelado. useLiveSession.js (dashboard) trata
  // o código 4004 como terminal, não tenta reconectar.
  it('unregisterSession fecha dashboardWs e companionWs com o código 4004 (sessão encerrada)', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    const session = getSession('s1');
    session.dashboardWs = fakeSocket();
    session.companionWs = fakeSocket();
    const dashboardClose = (session.dashboardWs.close = jest.fn());
    const companionClose = (session.companionWs.close = jest.fn());

    unregisterSession('s1');

    expect(dashboardClose).toHaveBeenCalledWith(4004, expect.any(String));
    expect(companionClose).toHaveBeenCalledWith(4004, expect.any(String));
  });

  it('unregisterSession não lança quando os sockets não têm .close (fakeSocket de outros testes)', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc', dashboardToken: 'dash-abc' });
    const session = getSession('s1');
    session.dashboardWs = fakeSocket();
    session.companionWs = fakeSocket();

    expect(() => unregisterSession('s1')).not.toThrow();
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

  // Teste ponta-a-ponta com sockets reais (não fakeSocket) do bug real: o
  // companion manda duas mensagens, uma de texto (JSON, como um
  // file-transfer-progress de verdade) e uma binária (como um frame JPEG de
  // verdade) -- confirma que o relay preserva o opcode original de cada uma
  // na saída pro dashboard (isBinary do evento 'message' do cliente `ws`
  // reflete o frame real recebido pela rede, não é cosmético).
  it('relay preserva o opcode (texto vs binário) de cada mensagem do companion ao repassar pro dashboard', (done) => {
    registerSession('s-real', {
      machineId: 'm1', mode: 'shadow', companionToken: 'tok-123', dashboardToken: 'dash-123',
    });

    const dashboardWs = new WebSocket(
      `ws://localhost:${port}/live?sessionId=s-real&role=dashboard&token=dash-123`
    );
    let companionWs;
    const received = [];

    // try/catch/finally (achado 🔵 do code-reviewer): sem isto, se as
    // expects falhassem o teste travaria até o timeout do Jest em vez de
    // reportar a asserção que falhou de forma limpa (sockets nunca
    // fechados, done() nunca chamado). done(err) no catch garante que uma
    // falha real aqui é reportada como falha, não como timeout nem --
    // crucial -- como sucesso falso-positivo (um finally sem catch
    // chamaria done() sem erro mesmo com a expect tendo lançado).
    dashboardWs.on('message', (data, isBinary) => {
      received.push({ text: data.toString(), isBinary });
      if (received.length !== 2) return;
      try {
        expect(received[0]).toEqual({ text: JSON.stringify({ type: 'file-transfer-progress' }), isBinary: false });
        expect(received[1]).toEqual({ text: 'frame-binario', isBinary: true });
        done();
      } catch (err) {
        done(err);
      } finally {
        dashboardWs.close();
        companionWs.close();
      }
    });

    dashboardWs.on('open', () => {
      companionWs = new WebSocket(
        `ws://localhost:${port}/live?sessionId=s-real&role=companion&token=tok-123`
      );
      companionWs.on('open', () => {
        companionWs.send(JSON.stringify({ type: 'file-transfer-progress' })); // texto -- send('string') infere binary:false
        companionWs.send(Buffer.from('frame-binario'), { binary: true }); // binário de propósito
      });
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
