'use strict';

const http = require('http');

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });
}

describe('rhHealthMonitor', () => {
  let mockServer;
  let port;
  let monitor;
  let sendAlert;

  beforeEach(() => {
    // isola o estado module-level (consecutiveConnFailures) entre testes
    jest.resetModules();
    jest.doMock('./resendAlert', () => ({ sendAlert: jest.fn().mockResolvedValue({ sent: true }) }));
    monitor = require('./rhHealthMonitor');
    sendAlert = require('./resendAlert').sendAlert;
  });

  afterEach(async () => {
    monitor.stop();
    if (mockServer) await new Promise(r => mockServer.close(r));
    mockServer = undefined;
  });

  it('happy path — 200 com todos os relógios esperados alcançáveis não dispara alerta', async () => {
    mockServer = await startMock((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total: 9, reachable: 9, unreachable: 0,
        clocks: [
          { ip: '192.168.15.151', reachable: true },
          { ip: '192.168.14.151', reachable: true },
        ],
      }));
    });
    port = mockServer.address().port;

    await monitor.start(port);
    await new Promise(r => setTimeout(r, 100));

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('500 (CLOCK_PROXY_TOKEN ausente) — alerta imediato, sem esperar threshold', async () => {
    mockServer = await startMock((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CLOCK_PROXY_TOKEN nao configurado' }));
    });
    port = mockServer.address().port;

    await monitor.start(port);
    await new Promise(r => setTimeout(r, 100));

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'CLOCK_PROXY_TOKEN ausente',
      cooldownKey: 'rh:token-missing',
    }));
  });

  it('502 (proxy inacessível) — 1ª falha não alerta, precisa de 2 falhas consecutivas', async () => {
    mockServer = await startMock((req, res) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Falha ao conectar com o clock-proxy', detail: 'timeout', hint: 'checar VPN' }));
    });
    port = mockServer.address().port;

    await monitor.start(port); // dispara o check inicial (1ª falha)
    await new Promise(r => setTimeout(r, 100));
    expect(sendAlert).not.toHaveBeenCalled();

    monitor.stop();
    await monitor.start(port); // 2ª falha consecutiva
    await new Promise(r => setTimeout(r, 100));

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ cooldownKey: 'rh:connection-failed' }));
  });

  it('502 seguido de sucesso reseta o contador de falhas consecutivas', async () => {
    let hits = 0;
    mockServer = await startMock((req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Falha ao conectar com o clock-proxy' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: 0, reachable: 0, unreachable: 0, clocks: [] }));
    });
    port = mockServer.address().port;

    await monitor.start(port); // falha 1
    await new Promise(r => setTimeout(r, 100));
    monitor.stop();

    await monitor.start(port); // sucesso — deve resetar o contador
    await new Promise(r => setTimeout(r, 100));
    monitor.stop();

    // uma 3ª chamada com 502 sozinha não deve alertar (contador foi resetado)
    mockServer.close();
    mockServer = await startMock((req, res) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Falha ao conectar com o clock-proxy' }));
    });
    port = mockServer.address().port;
    await monitor.start(port);
    await new Promise(r => setTimeout(r, 100));

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('200 com relógios abaixo do esperado (excluindo Città/Tijuca) dispara alerta', async () => {
    mockServer = await startMock((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total: 9, reachable: 5, unreachable: 4,
        clocks: [
          { ip: '192.168.15.151', reachable: true },
          { ip: '192.168.14.151', reachable: true },
          { ip: '192.168.12.151', reachable: true },
          { ip: '192.168.0.151',  reachable: true },
          { ip: '192.168.18.151', reachable: true },
          { ip: '192.168.16.151', reachable: false }, // inesperado offline
          { ip: '192.168.10.150', reachable: false }, // inesperado offline
          { ip: '192.168.13.151', reachable: false }, // Città — conhecido, excluído
          { ip: '192.168.20.151', reachable: false }, // Tijuca — conhecido, excluído
        ],
      }));
    });
    port = mockServer.address().port;

    await monitor.start(port);
    await new Promise(r => setTimeout(r, 100));

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ cooldownKey: 'rh:reachable-baixo' }));
  });

  it('200 só com Città/Tijuca offline (problema de hardware conhecido) não dispara alerta', async () => {
    mockServer = await startMock((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total: 9, reachable: 7, unreachable: 2,
        clocks: [
          { ip: '192.168.15.151', reachable: true },
          { ip: '192.168.14.151', reachable: true },
          { ip: '192.168.12.151', reachable: true },
          { ip: '192.168.0.151',  reachable: true },
          { ip: '192.168.18.151', reachable: true },
          { ip: '192.168.16.151', reachable: true },
          { ip: '192.168.10.150', reachable: true },
          { ip: '192.168.13.151', reachable: false }, // Città
          { ip: '192.168.20.151', reachable: false }, // Tijuca
        ],
      }));
    });
    port = mockServer.address().port;

    await monitor.start(port);
    await new Promise(r => setTimeout(r, 100));

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('falha de conexão total (servidor local não responde) não crasha e não chama sendAlert indevidamente', async () => {
    // porta sem nenhum servidor escutando
    await monitor.start(59999);
    await new Promise(r => setTimeout(r, 200));

    expect(sendAlert).not.toHaveBeenCalled();
  });
});
