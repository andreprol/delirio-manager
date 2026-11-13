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

// CLOSE_CODES: todo código de fechamento de WS não-padrão que este relay usa
// de propósito, nomeado aqui — achado do code-reviewer: antes eram literais
// soltos (4000 aqui, 4003 ali), fácil de mudar um sem lembrar do outro (ou
// do dashboard, que mantém sua PRÓPRIA cópia em TERMINAL_CLOSE_CODES,
// useLiveSession.js — nenhum vínculo automático entre os dois pacotes, só
// os comentários de cada lado e os testes que afirmam os valores literais).
const CLOSE_CODES = {
  SESSION_NOT_FOUND: 4000,
  INVALID_TOKEN: 4001,
  INVALID_ROLE: 4002,
  STALE_CONNECTION: 4003,
  SESSION_ENDED: 4004,
  // COMPANION_LOST: o companion caiu com a sessão ainda registrada (não foi
  // um stop explícito — esse caminho já teria apagado a sessão antes do
  // close deste socket rodar, ver isCurrentSocket em wireLiveSocket). Achado
  // real em produção (12/11/2026): sem fechar o dashboardWs aqui, ele ficava
  // "Conectado" pra sempre sem nunca mais receber frame — a sessão virava
  // zumbi no servidor (companionWs null, dashboardWs vivo, ninguém nunca
  // limpava). useLiveSession.js trata este código como terminal, igual
  // SESSION_ENDED — a diferença é só pra log/diagnóstico (ver comentário de
  // unregisterSessionDueToCompanionLoss).
  COMPANION_LOST: 4005,
};

// LIVE_SESSION_MSG: tipos de mensagem de TEXTO (não close code — a sessão
// continua viva, só avisa) mandados pro dashboard durante a folga de
// reconexão do companion (companionLostGraceMs). Achado 🟡 do code-reviewer:
// mesmo risco de CLOSE_CODES acima (literais soltos, fácil mudar um lado e
// esquecer o outro) — useLiveSession.js (dashboard/src/hooks) mantém sua
// PRÓPRIA cópia dos valores literais, sem vínculo automático entre os dois
// pacotes, só estes comentários e os testes de cada lado que afirmam os
// valores exatos.
const LIVE_SESSION_MSG = {
  COMPANION_RECONNECTING: 'companion-reconnecting',
  COMPANION_RECONNECTED: 'companion-reconnected',
};

const sessions = new Map();

// dashboardUnlockGraceMs é o tempo que o relay espera, depois do socket do
// dashboard cair, antes de mandar unlock-local-input de verdade pro
// companion — maior que RECONNECT_DELAY_MS (3000ms, useLiveSession.js), pra
// dar tempo da reconexão automática do dashboard reconectar antes do input
// ser liberado (reconecta indefinidamente desde 11/11/2026, não só 1x). Sem
// essa folga, um blip de rede (Wi-Fi, VPN) que se recupera rápido já
// destravava o input físico da loja no meio do suporte, sem o operador
// saber (achado 🔴 do code-reviewer) — a UI (LiveSessionWindow.jsx) não
// tinha como saber que o servidor já liberou por conta própria, e
// continuava mostrando "travado" quando já não estava mais. `let`, não
// `const`, só pra setDashboardUnlockGraceMsForTests poder encurtar em teste.
let dashboardUnlockGraceMs = 5000;

function setDashboardUnlockGraceMsForTests(ms) {
  dashboardUnlockGraceMs = ms;
}

// companionLostGraceMs é o tempo que o relay espera, depois do socket do
// companion cair de forma INESPERADA, antes de encerrar a sessão de vez —
// achado real em produção (13/11/2026): antes, QUALQUER queda do companion
// (blip de Wi-Fi da loja, NAT instável) matava a sessão na hora, e o
// dashboard (TERMINAL_CLOSE_CODES, useLiveSession.js) corretamente desistia
// de reconectar, já que reconectar o lado dashboard sozinho não adianta nada
// sem um companion do outro lado. Com a graça, o companion (que agora tenta
// reconectar sozinho com backoff, ver runLiveSessionWithReconnect em
// agent/livesession_windows.go) tem uma janela real pra voltar antes da
// sessão morrer de vez — sem precisar fechar/reabrir a janela manualmente
// no dashboard pra toda queda de rede transitória. Achado 🟠 do
// code-reviewer: a soma REAL do backoff do agent não é
// liveSessionReconnectMaxDelay×tentativas — é exponencial até o teto, então
// 1+2+4+8+8+8 = 31s (initial=1s, max=8s, 6 tentativas, ver
// agent/livesession_windows.go). Precisa folga de verdade acima disso, não
// só acima do delay máximo de UMA tentativa. `let`, não `const`, só pra
// setCompanionLostGraceMsForTests poder encurtar.
let companionLostGraceMs = 40000;

function setCompanionLostGraceMsForTests(ms) {
  companionLostGraceMs = ms;
}

// cancelPendingUnlock cancela o unlock agendado por scheduleUnlockOnDashboardDisconnect,
// se houver — chamada quando o dashboard reconecta a tempo (attachDashboardSocket) ou
// quando a sessão é encerrada de vez (unregisterSession), pra não deixar um
// timer pendente referenciando uma sessão que já era.
function cancelPendingUnlock(session) {
  if (session.pendingUnlockTimer) {
    clearTimeout(session.pendingUnlockTimer);
    session.pendingUnlockTimer = null;
  }
}

// scheduleUnlockOnDashboardDisconnect agenda o unlock sintético (ver close
// handler em wireLiveSocket) em vez de mandar na hora — dá a folga de
// dashboardUnlockGraceMs pro dashboard reconectar e cancelar. routeMessage
// já filtra por mode==='normal' e por companionWs presente, então chamar
// isto numa sessão Shadow ou já sem companion é inofensivo (no-op).
function scheduleUnlockOnDashboardDisconnect(session, sessionId) {
  cancelPendingUnlock(session);
  session.pendingUnlockTimer = setTimeout(() => {
    session.pendingUnlockTimer = null;
    routeMessage(sessionId, 'dashboard', JSON.stringify({ type: 'unlock-local-input' }));
  }, dashboardUnlockGraceMs);
}

// cancelPendingCompanionLoss cancela o timer agendado por
// scheduleSessionEndOnCompanionLoss, se houver — chamada quando o companion
// reconecta a tempo (attachCompanionSocket) ou quando a sessão é encerrada
// de vez por qualquer outro motivo (unregisterSession), mesmo padrão de
// cancelPendingUnlock acima pro lado do dashboard.
function cancelPendingCompanionLoss(session) {
  if (session.pendingCompanionLossTimer) {
    clearTimeout(session.pendingCompanionLossTimer);
    session.pendingCompanionLossTimer = null;
  }
}

// scheduleSessionEndOnCompanionLoss agenda o encerramento de vez da sessão
// (em vez de matar na hora) — dá a folga de companionLostGraceMs pro
// companion reconectar sozinho (runLiveSessionWithReconnect, agent) e
// cancelar via attachCompanionSocket. Só mata a sessão de verdade
// (COMPANION_LOST) se o companion não voltar dentro da janela.
function scheduleSessionEndOnCompanionLoss(session, sessionId) {
  cancelPendingCompanionLoss(session);
  session.pendingCompanionLossTimer = setTimeout(() => {
    session.pendingCompanionLossTimer = null;
    logger.warn('[liveSessionRelay] companion não reconectou a tempo, encerrando sessão', { sessionId });
    unregisterSession(sessionId, {
      code: CLOSE_CODES.COMPANION_LOST,
      reason: 'companion não reconectou a tempo',
    });
  }, companionLostGraceMs);
}

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
    pendingUnlockTimer: null,
    pendingCompanionLossTimer: null,
  });
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

// unregisterSession fecha os 2 sockets com CLOSE_CODES.SESSION_ENDED antes
// de apagar a sessão do Map — achado do code-reviewer: sem isso, um
// encerramento de propósito (POST /:sessionId/stop) só apagava a sessão em
// memória, mas nem o dashboard nem o companion recebiam 'close' nenhum.
// Ficavam "Conectado" pra sempre com o último frame congelado, sem saber
// que a sessão já acabou do lado do servidor. useLiveSession.js (dashboard)
// trata este código como terminal (TERMINAL_CLOSE_CODES) — não tenta
// reconectar.
function unregisterSession(sessionId, { code = CLOSE_CODES.SESSION_ENDED, reason = 'sessão encerrada' } = {}) {
  const session = sessions.get(sessionId);
  if (session) {
    cancelPendingUnlock(session);
    cancelPendingCompanionLoss(session);
    safeClose(session.dashboardWs, code, reason);
    safeClose(session.companionWs, code, reason);
  }
  sessions.delete(sessionId);
}

// safeClose fecha um socket com código/motivo dados, sem lançar se ele já
// estiver fechado/em closing — mesma defesa em profundidade de safeSend.
function safeClose(ws, code, reason) {
  if (ws && typeof ws.close === 'function') ws.close(code, reason);
}

// Fecha o socket anterior (se houver e for diferente do novo) antes de
// substituir — uma reconexão não deve deixar a conexão antiga pra trás ainda
// viva, recebendo/mandando mensagens em paralelo com a nova.
function closeStale(ws) {
  safeClose(ws, CLOSE_CODES.STALE_CONNECTION, 'substituído por nova conexão');
}

function attachCompanionSocket(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.companionWs && session.companionWs !== ws) closeStale(session.companionWs);
  // wasReconnecting checado ANTES de cancelPendingCompanionLoss limpar o
  // timer — é o único jeito de diferenciar "companion voltou depois de uma
  // queda" (avisa o dashboard) de "primeiro attach da sessão, nunca caiu"
  // (nada pra avisar, pendingCompanionLossTimer nunca existiu).
  const wasReconnecting = !!session.pendingCompanionLossTimer;
  cancelPendingCompanionLoss(session);
  session.companionWs = ws;
  if (wasReconnecting) {
    logger.info('[liveSessionRelay] companion reconectou a tempo', { sessionId });
    safeSend(session.dashboardWs, JSON.stringify({ type: LIVE_SESSION_MSG.COMPANION_RECONNECTED }));
  }
}

function detachCompanionSocket(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.companionWs = null;
}

function attachDashboardSocket(sessionId, ws) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.dashboardWs && session.dashboardWs !== ws) closeStale(session.dashboardWs);
  cancelPendingUnlock(session);
  session.dashboardWs = ws;
  // Achado 🔴 CRÍTICO do code-reviewer: 'companion-reconnecting' só era
  // mandado 1x, pro socket dashboard ANTIGO, no momento em que o companion
  // caiu (ver close handler de wireLiveSocket). Se o PRÓPRIO socket
  // dashboard↔servidor cair e reconectar (useLiveSession.js já reconecta
  // infinitamente desde 11/11/2026, cenário normal) ENQUANTO a folga do
  // companion ainda está pendente, o dashboard novo nunca recebe esse
  // aviso — e seu ws.onopen manda 'connected' incondicionalmente. A UI
  // ficava "Conectado" com o frame congelado até a sessão morrer de vez,
  // reproduzindo o exato bug que esta feature existe pra resolver.
  if (session.pendingCompanionLossTimer) {
    safeSend(ws, JSON.stringify({ type: LIVE_SESSION_MSG.COMPANION_RECONNECTING }));
  }
}

function detachDashboardSocket(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.dashboardWs = null;
}

// Nunca deixa um erro de socket (ex: conexão já fechada) escapar e derrubar o
// processo inteiro — mesmo padrão de services/websocket.js, mas logando o erro
// em vez de engolir em silêncio (esse módulo é sensível demais pra isso passar
// despercebido).
function safeSend(ws, data, isBinary = false) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(data, { binary: isBinary }, (err) => {
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

// origin: 'dashboard' | 'companion'. isBinary preserva o TIPO original do
// frame WS (texto vs binário) ao repassar — achado real em produção
// (André, 11/11/2026): a lib `ws` sempre entrega `data` como Buffer no
// evento 'message', seja o frame original TextMessage ou BinaryMessage (só
// `isBinary`, o 2º argumento do evento, diz qual era de verdade). Sem
// repassar esse flag pro `.send()` de saída, `ws` infere `binary: typeof
// data !== 'string'` (ver node_modules/ws/lib/websocket.js) — como `data`
// aqui é SEMPRE Buffer, TUDO vira frame binário ao sair daqui, mesmo que o
// companion tenha mandado como TextMessage de propósito (ex:
// file-transfer-progress/-done/-error, agent/filetransfer_windows.go). O
// dashboard distingue os dois pelo tipo (useLiveSession.js: `typeof
// e.data === 'string'` → JSON de status; senão → tenta decodificar como
// frame de vídeo) — sem este fix, todo status de transferência de arquivo
// virava binário e o dashboard tentava createImageBitmap() no JSON,
// lançando "InvalidStateError: source image could not be decoded" sem
// NUNCA processar o status de verdade (silêncio total na UI). Frame de
// vídeo (sempre binário mesmo) não é afetado — só por isso o bug nunca
// apareceu em input/vídeo, só na transferência de arquivo.
function routeMessage(sessionId, origin, data, isBinary = false) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (origin === 'companion') {
    // Frame de vídeo (ou qualquer mensagem do companion) — sempre repassa pro dashboard,
    // em qualquer modo. Quem está vendo a tela sempre recebe a imagem.
    if (session.dashboardWs && session.dashboardWs.readyState === session.dashboardWs.OPEN) {
      session.warnedCompanionNoDashboard = false;
    } else if (!session.warnedCompanionNoDashboard) {
      // Achado do code-reviewer (12/11/2026): sem isto, uma mensagem 1x-só
      // do companion (ex: session-info, agent/livesession_windows.go) que
      // chegasse ANTES do dashboard anexar se perdia em silêncio — ficava
      // indistinguível de "agent antigo sem suporte a session-info" (mesmo
      // fallback visual no dashboard). Logado 1x por sessão (reseta quando
      // o dashboard anexa), não a cada frame de vídeo perdido na mesma
      // janela de corrida — evita inundar o log (achado de sessão anterior:
      // este log já roda verboso sob carga normal).
      session.warnedCompanionNoDashboard = true;
      logger.warn('[liveSessionRelay] companion mandou mensagem sem dashboard anexado — descartada', { sessionId });
    }
    safeSend(session.dashboardWs, data, isBinary);
    return;
  }

  // origin === 'dashboard'. Allow-list estrito em MODE_NORMAL (não deny-list em
  // 'shadow'): qualquer mode que não seja exatamente 'normal' — shadow, typo,
  // undefined, string vazia — bloqueia o repasse. Esta é a linha que garante
  // que Shadow nunca vira controle remoto por engano de código em outro lugar
  // do projeto, mesmo que o dashboard mande input por bug.
  if (session.mode !== MODE_NORMAL) return;
  safeSend(session.companionWs, data, isBinary);
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
//
// noServer: true (não mais {server, path}) — achado real em produção: com
// {server, path}, este WebSocketServer e o de services/websocket.js (/ws)
// competiam pelo 'upgrade' do mesmo http.Server, e o /ws (registrado
// primeiro em server.js) sempre abortava com 400 qualquer tentativa de
// conectar em /live antes deste aqui ter a chance de atender — mesmo
// direto no backend, sem nem passar pelo nginx. Ver
// services/upgradeRouter.js: server.js agora chama handleUpgrade
// manualmente, roteado por pathname.
// authenticateAndAttach valida o token do role contra a sessão e anexa o
// socket (attachCompanionSocket/attachDashboardSocket) se bater — extraído
// do handler de 'connection' só pra não estourar max-lines-per-function,
// mesmo resultado/logs de antes.
function authenticateAndAttach(session, sessionId, role, token, ws) {
  const expectedToken = role === 'companion' ? session.companionToken : session.dashboardToken;
  if (!safeTokenEqual(token, expectedToken)) return false;

  if (role === 'companion') attachCompanionSocket(sessionId, ws);
  else attachDashboardSocket(sessionId, ws);

  logger.info(`[liveSessionRelay] ${role} anexado`, { sessionId, machineId: session.machineId, mode: session.mode });
  return true;
}

// wireLiveSocket registra message/close depois que o socket já foi
// autenticado e anexado — mesma extração de authenticateAndAttach, pelo
// mesmo motivo (comprimento de função).
function wireLiveSocket(sessionId, role, ws) {
  // isBinary (2º argumento do evento 'message' da lib `ws`) é o único jeito
  // de saber se o frame original era TextMessage ou BinaryMessage — `data`
  // sozinho não diz (ver comentário de routeMessage pro porquê isso importa).
  ws.on('message', (data, isBinary) => {
    if (!isCurrentSocket(sessionId, role, ws)) return;
    routeMessage(sessionId, role, data, isBinary);
  });

  ws.on('close', (code, reasonBuf) => {
    if (!isCurrentSocket(sessionId, role, ws)) return;
    logger.info('[liveSessionRelay] socket desconectado', { sessionId, role, code, reason: reasonBuf?.toString() });
    if (role === 'companion') {
      // Chegou até aqui (isCurrentSocket true) só quando a sessão AINDA
      // estava registrada — um stop explícito (POST /stop → unregisterSession)
      // já teria apagado a sessão antes deste close rodar, fazendo
      // isCurrentSocket devolver false acima. Então todo close de companion
      // que chega aqui é uma queda INESPERADA (rede, ou a race do safeConn
      // corrigida em agent/wsconn_windows.go).
      //
      // Achado real (13/11/2026): matar a sessão NA HORA aqui (comportamento
      // antigo) não dava nenhuma chance pro companion reconectar sozinho
      // (runLiveSessionWithReconnect, agent/livesession_windows.go) — toda
      // queda de rede transitória (Wi-Fi/NAT da loja) exigia fechar e reabrir
      // a janela manualmente no dashboard. Agora só desanexa o socket morto,
      // avisa o dashboard (pra não ficar com a tela congelada sem explicação)
      // e agenda o fim de vez pra daqui a companionLostGraceMs — tempo real
      // pro companion voltar via attachCompanionSocket, que cancela este
      // timer e avisa 'companion-reconnected'.
      logger.warn('[liveSessionRelay] companion desconectou inesperadamente, aguardando reconexão', {
        sessionId, code, reason: reasonBuf?.toString(),
      });
      const session = getSession(sessionId);
      if (session) {
        detachCompanionSocket(sessionId);
        safeSend(session.dashboardWs, JSON.stringify({ type: LIVE_SESSION_MSG.COMPANION_RECONNECTING }));
        scheduleSessionEndOnCompanionLoss(session, sessionId);
      }
      return;
    }
    if (role === 'dashboard') {
      detachDashboardSocket(sessionId);
      // O operador pode cair sem clicar "desbloquear" (rede, crash do app) —
      // sem isso, o usuário da loja ficaria com mouse/teclado travados até
      // alguém encerrar a sessão manualmente. Agendado (não na hora, ver
      // scheduleUnlockOnDashboardDisconnect) pra não destravar no meio de um
      // blip que a própria retentativa automática do dashboard resolveria
      // sozinha. routeMessage já é o MESMO allow-list de mode==='normal' que
      // qualquer input real passa, então isso nunca escapa pra uma sessão
      // Shadow. O agent trata esta mensagem como no-op se o input já não
      // estiver travado (ver setLocalInputLocked em input_windows.go).
      const session = getSession(sessionId);
      if (session) scheduleUnlockOnDashboardDisconnect(session, sessionId);
    }
  });
}

function initLiveRelay() {
  const wss = new WebSocketServer({ noServer: true });

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
      logger.warn('[liveSessionRelay] conexão recusada: sessão inexistente', { sessionId, role });
      ws.close(CLOSE_CODES.SESSION_NOT_FOUND, 'sessão inexistente');
      return;
    }

    // sessionId sozinho NÃO é segredo suficiente pra autorizar o dashboard —
    // precisa do dashboardToken emitido junto no POST /start (achado 🔴 do
    // code-reviewer da Task 9: sem isso, qualquer um que soubesse o sessionId
    // abria a sessão como se fosse o operador autorizado). Mesma checagem de
    // token pro companion.
    if (role !== 'companion' && role !== 'dashboard') {
      logger.warn('[liveSessionRelay] conexão recusada: role inválido', { sessionId, role });
      ws.close(CLOSE_CODES.INVALID_ROLE, 'role inválido');
      return;
    }

    if (!authenticateAndAttach(session, sessionId, role, token, ws)) {
      logger.warn('[liveSessionRelay] conexão recusada: token inválido', { sessionId, role, machineId: session.machineId });
      ws.close(CLOSE_CODES.INVALID_TOKEN, 'token inválido');
      return;
    }

    wireLiveSocket(sessionId, role, ws);
  });

  logger.info('[liveSessionRelay] WebSocket server iniciado em /live');
  return wss;
}

module.exports = {
  registerSession, getSession, unregisterSession, routeMessage,
  attachCompanionSocket, attachDashboardSocket,
  detachDashboardSocket, detachCompanionSocket,
  initLiveRelay,
  setDashboardUnlockGraceMsForTests,
  setCompanionLostGraceMsForTests,
};
