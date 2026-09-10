// Flag "relógio novo" por IP — bypass de um-tiro pro guard de divergência
// (isSuspiciousReading) em clock-proxy/server.js. Ver spec:
// docs/superpowers/specs/2026-09-10-relogio-novo-flag-design.md
'use strict';

const fs = require('fs');

// Carrega o Set de IPs marcados a partir do disco. Retorna Set vazio se o
// arquivo não existir ou estiver corrompido — nunca lança exceção.
function loadFlags(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return new Set(arr);
    }
  } catch (err) {
    // arquivo corrompido — começa do zero, não trava o boot do processo
    console.error('[newClockFlags] falha ao carregar flags, iniciando vazio:', err.message);
  }
  return new Set();
}

// Grava o Set de flags em disco de forma atômica (arquivo temporário +
// rename) e nunca lança — se a escrita falhar (disco cheio, EACCES,
// diretório inexistente etc.) a flag permanece só em memória e o erro é
// apenas logado, sem derrubar o processo chamador.
function saveFlags(filePath, flags) {
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify([...flags]), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[newClockFlags] falha ao salvar flags em disco:', err.message);
  }
}

function isNewClockBypassActive(flags, ip) {
  return flags.has(ip);
}

// Marca um IP para bypass na próxima leitura. Persiste imediatamente —
// sobrevive a um restart do processo entre o "Marcar" e o "Atualizar".
function markAsNewClock(flags, ip, filePath) {
  flags.add(ip);
  saveFlags(filePath, flags);
}

// Remove a flag após seu uso (sucesso ou falha da leitura). Retorna true se
// havia flag ativa para esse IP, false caso contrário.
function consumeNewClockFlag(flags, ip, filePath) {
  if (!flags.has(ip)) return false;
  flags.delete(ip);
  saveFlags(filePath, flags);
  return true;
}

// Guard de divergência do clock-proxy — extraído para função pura testável.
// bypassGuard=true (flag "relógio novo" ativa) ignora a checagem por completo.
function isSuspiciousReading({ bypassGuard, prevSuccess, prevCount, newCount }) {
  if (bypassGuard) return false;
  return !!prevSuccess && prevCount > 0 && newCount < Math.ceil(prevCount * 0.5);
}

module.exports = {
  loadFlags,
  saveFlags,
  isNewClockBypassActive,
  markAsNewClock,
  consumeNewClockFlag,
  isSuspiciousReading,
};
