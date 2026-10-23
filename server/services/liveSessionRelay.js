'use strict';

// Estado em memória das sessões ao vivo ativas. Não persiste — histórico/auditoria
// fica em db.js (tabela live_sessions). Ver spec 2026-10-23: Shadow nunca repassa
// input, mesmo que o dashboard mande por engano/bug — bloqueio aqui, não só na UI.
//
// Assume processo único (dt-manager roda com exec_mode:'fork', instances:1) — este
// Map não sobrevive a múltiplos processos nem a restart, o que é aceitável porque
// uma sessão ao vivo não precisa sobreviver a um restart do servidor.

const MODE_NORMAL = 'normal';

const sessions = new Map();

function registerSession(sessionId, { machineId, mode, companionToken }) {
  if (sessions.has(sessionId)) {
    throw new Error(
      `liveSessionRelay: sessão ${sessionId} já registrada — chame unregisterSession antes de registrar de novo`
    );
  }
  sessions.set(sessionId, {
    machineId, mode, companionToken,
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

function attachCompanionSocket(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (session) session.companionWs = ws;
}

function attachDashboardSocket(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (session) session.dashboardWs = ws;
}

// Nunca deixa um erro de socket (ex: conexão já fechada) escapar e derrubar o
// processo inteiro — mesmo padrão de services/websocket.js, mas logando o erro
// em vez de engolir em silêncio (esse módulo é sensível demais pra isso passar
// despercebido).
function safeSend(ws, data) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(data, (err) => {
      if (err) console.error('[liveSessionRelay] erro ao enviar:', err.message);
    });
  }
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

module.exports = {
  registerSession, getSession, unregisterSession, routeMessage,
  attachCompanionSocket, attachDashboardSocket,
};
