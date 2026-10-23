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
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc' });
    const session = getSession('s1');
    expect(session.machineId).toBe('m1');
    expect(session.mode).toBe('normal');
  });

  it('Normal: input do dashboard é repassado pro companion', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc' });
    const companionWs = fakeSocket();
    const session = getSession('s1');
    session.companionWs = companionWs;

    routeMessage('s1', 'dashboard', JSON.stringify({ type: 'input', key: 'a' }));

    expect(companionWs._sent).toHaveLength(1);
  });

  it('Shadow: input do dashboard NUNCA é repassado pro companion', () => {
    registerSession('s1', { machineId: 'm1', mode: 'shadow', companionToken: 'tok-abc' });
    const companionWs = fakeSocket();
    const session = getSession('s1');
    session.companionWs = companionWs;

    routeMessage('s1', 'dashboard', JSON.stringify({ type: 'input', key: 'a' }));

    expect(companionWs._sent).toHaveLength(0);
  });

  it('frame de vídeo do companion é sempre repassado pro dashboard, nos dois modos', () => {
    registerSession('s1', { machineId: 'm1', mode: 'shadow', companionToken: 'tok-abc' });
    const dashboardWs = fakeSocket();
    const session = getSession('s1');
    session.dashboardWs = dashboardWs;

    routeMessage('s1', 'companion', Buffer.from([1, 2, 3]));

    expect(dashboardWs._sent).toHaveLength(1);
  });

  it('unregisterSession remove a sessão', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc' });
    unregisterSession('s1');
    expect(getSession('s1')).toBeUndefined();
  });

  it('routeMessage em sessão inexistente não lança erro', () => {
    expect(() => routeMessage('nao-existe', 'dashboard', 'x')).not.toThrow();
  });

  it('mode ausente/inválido bloqueia input do dashboard, não só "shadow" exato', () => {
    registerSession('s1', { machineId: 'm1', mode: undefined, companionToken: 'tok-abc' });
    const companionWs = fakeSocket();
    attachCompanionSocket('s1', companionWs);

    routeMessage('s1', 'dashboard', 'x');

    expect(companionWs._sent).toHaveLength(0);
  });

  it('registrar sessionId já existente lança erro, não sobrescreve em silêncio', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc' });
    expect(() =>
      registerSession('s1', { machineId: 'm2', mode: 'shadow', companionToken: 'tok-outro' })
    ).toThrow();
    expect(getSession('s1').machineId).toBe('m1');
  });

  it('attachCompanionSocket/attachDashboardSocket anexam o socket na sessão', () => {
    registerSession('s1', { machineId: 'm1', mode: 'normal', companionToken: 'tok-abc' });
    const companionWs = fakeSocket();
    const dashboardWs = fakeSocket();

    attachCompanionSocket('s1', companionWs);
    attachDashboardSocket('s1', dashboardWs);

    expect(getSession('s1').companionWs).toBe(companionWs);
    expect(getSession('s1').dashboardWs).toBe(dashboardWs);
  });
});
