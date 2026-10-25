'use strict';

// services/upgradeRouter.js — roteador único pra todos os upgrades de
// WebSocket deste processo (/ws e /live).
//
// Por quê isso existe: um WebSocketServer da lib `ws` criado com
// `{ server, path }` registra, por conta própria, um listener no
// `'upgrade'` do http.Server que chama `handleUpgrade` INCONDICIONALMENTE
// pra QUALQUER path — é só DENTRO de `handleUpgrade` que ele checa
// `shouldHandle` (o path bate?); se não bater, ele já ABORTA o socket com
// 400 ali mesmo (ver node_modules/ws/lib/websocket-server.js). Quando
// `services/websocket.js` (/ws) e `services/liveSessionRelay.js` (/live)
// cada um criava seu próprio WebSocketServer apontando pro MESMO
// http.Server dessa forma, o PRIMEIRO registrado (/ws, por ordem de
// chamada em server.js) sempre vencia a corrida de 'upgrade' e abortava
// com 400 qualquer tentativa de conectar em /live — achado em produção
// (Delirio Manager): toda sessão ao vivo dava "Conexão perdida" com um
// 400 que nem passava pelo nginx, vinha direto do backend. Fix: os dois
// nascem com `noServer: true` (sem listener próprio nenhum), e este
// roteador único decide por pathname qual `handleUpgrade` chamar.
function createUpgradeRouter({ wsServer, liveWss }) {
  return function handleUpgradeRequest(req, socket, head) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === '/ws') {
      wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
    } else if (pathname === '/live') {
      liveWss.handleUpgrade(req, socket, head, (ws) => liveWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  };
}

module.exports = { createUpgradeRouter };
