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
  } catch (_) {
    // arquivo corrompido — começa do zero, não trava o boot do processo
  }
  return new Set();
}

function saveFlags(filePath, flags) {
  fs.writeFileSync(filePath, JSON.stringify([...flags]), 'utf8');
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
