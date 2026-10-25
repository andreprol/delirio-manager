'use strict';

const { createUpgradeRouter } = require('./upgradeRouter');

function fakeWsServer() {
  return { handleUpgrade: jest.fn(), emit: jest.fn() };
}

function fakeSocket() {
  return { destroy: jest.fn() };
}

describe('createUpgradeRouter — roteamento por pathname', () => {
  it('roteia /ws pro wsServer.handleUpgrade, não pro liveWss', () => {
    const wsServer = fakeWsServer();
    const liveWss = fakeWsServer();
    const router = createUpgradeRouter({ wsServer, liveWss });
    const req = { url: '/ws' };
    const socket = fakeSocket();
    const head = Buffer.from([]);

    router(req, socket, head);

    expect(wsServer.handleUpgrade).toHaveBeenCalledWith(req, socket, head, expect.any(Function));
    expect(liveWss.handleUpgrade).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('roteia /live pro liveWss.handleUpgrade, não pro wsServer', () => {
    const wsServer = fakeWsServer();
    const liveWss = fakeWsServer();
    const router = createUpgradeRouter({ wsServer, liveWss });
    const req = { url: '/live?sessionId=s1&role=dashboard&token=tok' };
    const socket = fakeSocket();
    const head = Buffer.from([]);

    router(req, socket, head);

    expect(liveWss.handleUpgrade).toHaveBeenCalledWith(req, socket, head, expect.any(Function));
    expect(wsServer.handleUpgrade).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('path desconhecido destroi o socket, não chama nenhum handleUpgrade', () => {
    const wsServer = fakeWsServer();
    const liveWss = fakeWsServer();
    const router = createUpgradeRouter({ wsServer, liveWss });
    const req = { url: '/qualquer-outra-coisa' };
    const socket = fakeSocket();

    router(req, socket, Buffer.from([]));

    expect(socket.destroy).toHaveBeenCalled();
    expect(wsServer.handleUpgrade).not.toHaveBeenCalled();
    expect(liveWss.handleUpgrade).not.toHaveBeenCalled();
  });
});

describe('createUpgradeRouter — callback e casos extremos', () => {
  it('o callback de handleUpgrade pro /ws emite "connection" no wsServer certo', () => {
    const wsServer = fakeWsServer();
    const liveWss = fakeWsServer();
    const router = createUpgradeRouter({ wsServer, liveWss });
    const req = { url: '/ws' };

    router(req, fakeSocket(), Buffer.from([]));

    const callback = wsServer.handleUpgrade.mock.calls[0][3];
    const fakeWs = { id: 'ws-instance' };
    callback(fakeWs);

    expect(wsServer.emit).toHaveBeenCalledWith('connection', fakeWs, req);
    expect(liveWss.emit).not.toHaveBeenCalled();
  });

  it('url sem path reconhecido (ex: undefined) destroi o socket em vez de lançar', () => {
    const wsServer = fakeWsServer();
    const liveWss = fakeWsServer();
    const router = createUpgradeRouter({ wsServer, liveWss });
    const socket = fakeSocket();

    expect(() => router({ url: undefined }, socket, Buffer.from([]))).not.toThrow();
    expect(socket.destroy).toHaveBeenCalled();
  });
});
