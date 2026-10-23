'use strict';

// Estado em memória das sessões ao vivo ativas. Não persiste — histórico/auditoria
// fica em db.js (tabela live_sessions). Ver spec 2026-10-23: Shadow nunca repassa
// input, mesmo que o dashboard mande por engano/bug — bloqueio aqui, não só na UI.

const sessions = new Map();

function registerSession(sessionId, { machineId, mode, companionToken }) {
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

// origin: 'dashboard' | 'companion'
function routeMessage(sessionId, origin, data) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (origin === 'companion') {
    // Frame de vídeo (ou qualquer mensagem do companion) — sempre repassa pro dashboard,
    // em qualquer modo. Quem está vendo a tela sempre recebe a imagem.
    if (session.dashboardWs && session.dashboardWs.readyState === session.dashboardWs.OPEN) {
      session.dashboardWs.send(data);
    }
    return;
  }

  // origin === 'dashboard'
  if (session.mode !== 'normal') return; // Shadow: descarta qualquer input, sempre.
  if (session.companionWs && session.companionWs.readyState === session.companionWs.OPEN) {
    session.companionWs.send(data);
  }
}

module.exports = { registerSession, getSession, unregisterSession, routeMessage };
