'use strict';

// routes/live.js — start/stop de sessão ao vivo (ver/assumir tela em tempo
// real). Esta rota é quem gera os dois segredos (companionToken, dashboardToken)
// de que o WebSocketServer em /live (services/liveSessionRelay.js) depende pra
// autenticar cada lado da sessão. Cada token só pode chegar ao lado certo:
// companionToken vai pro agente (via comando enfileirado), dashboardToken volta
// na resposta HTTP pra quem chamou /start (o dashboard) — nunca o contrário, e
// nunca os dois juntos do mesmo lado. Mesmo padrão X-Admin-Secret de
// routes/machines.js (endpoint /:id/run).

const express   = require('express');
const router    = express.Router();
const crypto    = require('crypto');
const db        = require('../db');
const logger    = require('../services/logger');
const relay     = require('../services/liveSessionRelay');
const { adminAuth } = require('../middleware/adminAuth');
const { generateFileTransferUrls, MAX_FILE_BYTES } = require('../services/blobSas');

// POST /api/live/:machineId/start  { mode: 'normal'|'shadow' }
router.post('/:machineId/start', adminAuth, (req, res) => {
  const { mode } = req.body || {};
  if (mode !== 'normal' && mode !== 'shadow') {
    return res.status(400).json({ error: "mode deve ser 'normal' ou 'shadow'" });
  }

  const machine = db.getMachineById(req.params.machineId);
  if (!machine) {
    return res.status(404).json({ error: 'Máquina não encontrada' });
  }

  const sessionId      = db.createLiveSession(machine.id, mode);
  const companionToken = crypto.randomBytes(32).toString('hex');
  const dashboardToken = crypto.randomBytes(32).toString('hex');

  // registra os dois tokens no relay (ambos obrigatórios — ver liveSessionRelay.js)
  relay.registerSession(sessionId, { machineId: machine.id, mode, companionToken, dashboardToken });

  // só o companionToken vai pro agente, via comando enfileirado
  db.createCommand(machine.id, 'start-live-session', { sessionId, mode, companionToken });

  // só o dashboardToken volta na resposta — companionToken nunca aparece aqui
  res.json({ ok: true, sessionId, mode, dashboardToken });
});

// POST /api/live/:sessionId/file/upload-url  { fileName, fileSize }
// Gera SAS de upload (escrita) + download (leitura) pro MESMO blob, pra
// transferencia de arquivo operador->maquina remota. Bytes nunca passam
// por este servidor. Tamanho validado AQUI (antes de chamar o servico)
// pra distinguir 400 (entrada invalida do cliente) de 500 (problema de
// config do servidor) sem precisar inspecionar a mensagem de erro —
// qualquer erro que blobSas ainda lançar depois dessa validação (ex:
// blobStorage ausente do config.json) é problema do SERVIDOR, não do
// cliente.
router.post('/:sessionId/file/upload-url', adminAuth, (req, res) => {
  const { fileName, fileSize } = req.body || {};
  if (!fileName || typeof fileSize !== 'number') {
    return res.status(400).json({ error: 'fileName e fileSize (number) sao obrigatorios' });
  }
  if (fileSize > MAX_FILE_BYTES) {
    return res.status(400).json({ error: `Arquivo acima do limite de 2GB (recebido: ${fileSize} bytes)` });
  }
  // Achado do code-reviewer: sem isto, qualquer chamador com X-Admin-Secret
  // recebia SAS válidas pra um sessionId inexistente/já finalizado (mesmo
  // guard que /stop já tinha).
  const session = db.getLiveSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }
  try {
    const result = generateFileTransferUrls({ fileName, fileSize });
    // Achado do code-reviewer: diferente de mouse/teclado (visível na tela
    // física da loja), transferência de arquivo não deixa rastro nenhum
    // sem log -- auditoria mínima de quem pediu o quê.
    logger.info('[FileTransfer] upload-url pedido', { fileName, sessionId: session.id, machineId: session.machine_id });
    res.json(result);
  } catch (err) {
    logger.error('[FileTransfer] upload-url falhou', { fileName, sessionId: session.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/live/:sessionId/file/download-url  { fileName }
// Mesmo par de SAS (upload+download pro MESMO blob) que /file/upload-url,
// só que pra direção CONTRÁRIA — transferência de arquivo máquina
// remota->operador. O companion recebe a uploadUrl (sobe o arquivo lido do
// disco remoto pro Blob) e o dashboard guarda a downloadUrl (baixa do Blob
// pro computador do operador via window.electronAPI.downloadFile, assim
// que o companion avisar 'file-download-done'). Sem fileSize aqui de
// propósito: o operador só informa um CAMINHO no remoto, o tamanho real só
// é conhecido quando o companion abre o arquivo pra ler — generateFileTransferUrls
// tolera fileSize ausente (a checagem de MAX_FILE_BYTES simplesmente não
// dispara pra undefined), então não precisa de variante própria no serviço.
router.post('/:sessionId/file/download-url', adminAuth, (req, res) => {
  const { fileName } = req.body || {};
  if (!fileName) {
    return res.status(400).json({ error: 'fileName é obrigatório' });
  }
  const session = db.getLiveSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }
  try {
    const result = generateFileTransferUrls({ fileName });
    // Achado do code-reviewer: ler um arquivo do disco remoto e subir pro
    // Blob é SILENCIOSO (nenhum sinal visual pra quem estiver na loja,
    // diferente de mouse/teclado) -- sem log, uma exfiltração não deixa
    // rastro nenhum pra auditoria posterior.
    logger.info('[FileTransfer] download-url pedido', { fileName, sessionId: session.id, machineId: session.machine_id });
    res.json(result);
  } catch (err) {
    logger.error('[FileTransfer] download-url falhou', { fileName, sessionId: session.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/live/:sessionId/stop  { recorded?: boolean }
router.post('/:sessionId/stop', adminAuth, (req, res) => {
  const session = db.getLiveSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }

  if (req.body && req.body.recorded) {
    db.setLiveSessionRecorded(session.id);
  }
  db.endLiveSession(session.id);
  relay.unregisterSession(session.id);
  db.createCommand(session.machine_id, 'stop-live-session', { sessionId: session.id });

  res.json({ ok: true });
});

module.exports = router;
