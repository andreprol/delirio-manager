'use strict';

const { WebSocketServer } = require('ws');

let wss;

function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    console.log('[WS] Dashboard conectado:', req.socket.remoteAddress);

    // Usa JSON ping/pong — compativel com browser WebSocket API
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
        }
      } catch {}
    });

    ws.on('error', () => {});
    ws.on('close', () => {
      console.log('[WS] Dashboard desconectado');
    });
  });

  console.log('[WS] WebSocket server iniciado em /ws');
  return wss;
}

function broadcast(type, data) {
  if (!wss) return;
  const msg = JSON.stringify({ type, data, ts: new Date().toISOString() });
  wss.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg, err => { if (err) {} });
    }
  });
}

function getClientCount() {
  return wss ? wss.clients.size : 0;
}

module.exports = { initWebSocket, broadcast, getClientCount };
