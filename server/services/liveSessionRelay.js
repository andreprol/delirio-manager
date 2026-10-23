'use strict';

const { WebSocketServer } = require('ws');
const { URL } = require('url');
const crypto = require('crypto');
const logger = require('./logger');

// Estado em memória das sessões ao vivo ativas. Não persiste — histórico/auditoria
// fica em db.js (tabela live_sessions). Ver spec 2026-10-23: Shadow nunca repassa
// input, mesmo que o dashboard mande por engano/bug — bloqueio aqui, não só na UI.
//
// Assume processo único (dt-manager roda com exec_mode:'fork', instances:1) — este
// Map não sobrevive a múltiplos processos nem a restart, o que é aceitável porque
// uma sessão ao vivo não precisa sobreviver a um restart do servidor.

const MODE_NORMAL = 'normal';

const sessions = new Map();

function registerSession(sessionId, { machineId, mode, companionToken, dashboardToken }) {
  if (sessions.has(sessionId)) {
    throw new Error(
      `liveSessionRelay: sessão ${sessionId} já registrada — chame unregisterSession antes de registrar de novo`
    );
  }
  if (typeof companionToken !== 'string' || !companionToken) {
    throw new Error('liveSessionRelay: companionToken obrigatório e não-vazio');
  }
  if (typeof dashboardToken !== 'string' || !dashboardToken) {
    throw new Error('liveSessionRelay: dashboardToken obrigatório e não-vazio');
  }
  sessions.set(sessionId, {
    machineId, mode, companionToken, dashboardToken,
    companionWs: null,
    dashboardWs: null,
  });
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function unregisterSession(sessionId) {
  sessions.delete(sessionId);
}

// Fecha o socket anterior (se houver e for diferente do novo) antes de
// substituir — uma reconexão não deve deixar a conexão antiga pra trás ainda
// viva, recebendo/mandando mensagens em paralelo com a nova.
function closeStale(ws) {
  if (ws && typeof ws.close === 'function') ws.close(4003, 'substituído por nova conexão');
}

function attachCompanionSocket(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.companionWs && session.companionWs !== ws) closeStale(session.companionWs);
  session.companionWs = ws;
}

function attachDashboardSocket(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.dashboardWs && session.dashboardWs !== ws) closeStale(session.dashboardWs);
  session.dashboardWs = ws;
}

function detachCompanionSocket(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.companionWs = null;
}

function detachDashboardSocket(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.dashboardWs = null;
}

// Nunca deixa um erro de socket (ex: conexão já fechada) escapar e derrubar o
// processo inteiro — mesmo padrão de services/websocket.js, mas logando o erro
// em vez de engolir em silêncio (esse módulo é sensível demais pra isso passar
// despercebido).
function safeSend(ws, data) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(data, (err) => {
      if (err) logger.error('[liveSessionRelay] erro ao enviar', { error: err.message });
    });
  }
}

// Comparação resistente a timing attack — tokens de autenticação não devem ser
// comparados com !== direto (tempo de execução vaza quantos bytes bateram).
function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// origin: 'dashboard' | 'companion'
function routeMessage(sessionId, origin, data) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (origin === 'companion') {
    // Frame de vídeo (ou qualquer mensagem do companion) — sempre repassa pro dashboard,
    // em qualquer modo. Quem está vendo a tela sempre recebe a imagem.
    safeSend(session.dashboardWs, data);
    return;
  }

  // origin === 'dashboard'. Allow-list estrito em MODE_NORMAL (não deny-list em
  // 'shadow'): qualquer mode que não seja exatamente 'normal' — shadow, typo,
  // undefined, string vazia — bloqueia o repasse. Esta é a linha que garante
  // que Shadow nunca vira controle remoto por engano de código em outro lugar
  // do projeto, mesmo que o dashboard mande input por bug.
  if (session.mode !== MODE_NORMAL) return;
  safeSend(session.companionWs, data);
}

// true se `ws` ainda é o socket anexado pro seu papel nesta sessão — usado
// tanto no 'message' (não rotear socket substituído) quanto no 'close' (não
// desanexar a conexão atual por engano de um close tardio da antiga).
function isCurrentSocket(sessionId, role, ws) {
  const current = getSession(sessionId);
  if (!current) return false;
  if (role === 'companion') return current.companionWs === ws;
  if (role === 'dashboard') return current.dashboardWs === ws;
  return false;
}

// WebSocketServer real em /live — autentica o companion por token, recusa
// sessão inexistente/role inválido e liga cada socket ao relay em memória
// acima. Nunca reatribui companionWs/dashboardWs direto: sempre pelos setters
// attach*/detach* (mesmo padrão em toda esta função, incluindo no close).
function initLiveRelay(server) {
  const wss = new WebSocketServer({ server, path: '/live' });

  wss.on('connection', (ws, req) => {
    // Primeira linha, antes de qualquer close() de rejeição — mesmo padrão de
    // services/websocket.js: nunca deixa 'error' sem handler derrubar o
    // processo, mesmo num socket recusado logo em seguida (token/role/sessão).
    ws.on('error', () => {});

    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const role       = url.searchParams.get('role');
    const token      = url.searchParams.get('token');

    const session = getSession(sessionId);
    if (!session) {
      ws.close(4000, 'sessão inexistente');
      return;
    }

    if (role === 'companion') {
      if (!safeTokenEqual(token, session.companionToken)) {
        ws.close(4001, 'token inválido');
        return;
      }
      attachCompanionSocket(sessionId, ws);
    } else if (role === 'dashboard') {
      // sessionId sozinho NÃO é segredo suficiente pra autorizar o dashboard —
      // precisa do dashboardToken emitido junto no POST /start (achado 🔴 do
      // code-reviewer da Task 9: sem isso, qualquer um que soubesse o sessionId
      // abria a sessão como se fosse o operador autorizado).
      if (!safeTokenEqual(token, session.dashboardToken)) {
        ws.close(4001, 'token inválido');
        return;
      }
      attachDashboardSocket(sessionId, ws);
    } else {
      ws.close(4002, 'role inválido');
      return;
    }

    ws.on('message', (data) => {
      if (!isCurrentSocket(sessionId, role, ws)) return;
      routeMessage(sessionId, role, data);
    });

    ws.on('close', () => {
      if (!isCurrentSocket(sessionId, role, ws)) return;
      if (role === 'companion') detachCompanionSocket(sessionId);
      if (role === 'dashboard') detachDashboardSocket(sessionId);
    });
  });

  logger.info('[liveSessionRelay] WebSocket server iniciado em /live');
  return wss;
}

module.exports = {
  registerSession, getSession, unregisterSession, routeMessage,
  attachCompanionSocket, attachDashboardSocket,
  detachCompanionSocket, detachDashboardSocket,
  initLiveRelay,
};
