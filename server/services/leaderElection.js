// server/services/leaderElection.js
// Eleição de líder entre instâncias ativas do servidor via advisory lock de
// sessão do Postgres (pg_try_advisory_lock). Motivação: duas instâncias do
// server/ compartilhando o mesmo Postgres (alta disponibilidade) não podem
// duplicar jobs agendados em background (ver plano
// 2026-11-27-leader-election-and-healthz) — só a instância que detém o lock
// (o "líder") deve rodá-los. As Tasks 2-4 usam isLeader() pra decidir se
// rodam um job ou não.
//
// Mecanismo: advisory lock de SESSÃO (não de transação) — fica preso à
// conexão (`client`) enquanto ela existir. Se a conexão cair (erro, stop()),
// o Postgres libera o lock automaticamente (é isso que faz o failover
// funcionar: a outra instância, tentando a cada RETRY_INTERVAL_MS, adquire o
// lock assim que o antigo líder desconectar).
'use strict';

const { Client } = require('pg');
const logger = require('./logger');

// Chave numérica fixa e arbitrária do advisory lock. Único requisito: nunca
// reusar esse número pra outro pg_advisory_lock/pg_try_advisory_lock no
// mesmo banco (colisão faria duas disputas lógicas diferentes compartilharem
// um único lock).
const LOCK_KEY = 915006;

// De quanto em quanto tempo quem NÃO é líder tenta de novo.
const RETRY_INTERVAL_MS = 30000;

// Estado interno do módulo.
let client = null;
let leaderFlag = false;
let retryTimer = null;

async function tryAcquire() {
  if (client === null) {
    const newClient = new Client({ connectionString: process.env.DATABASE_URL });
    newClient.on('error', (err) => {
      logger.error('[leaderElection] conexao encerrada com erro, perdendo lideranca', { error: err.message });
      leaderFlag = false;
      client = null;
    });
    await newClient.connect();
    client = newClient;
  }

  const { rows } = await client.query(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [LOCK_KEY]
  );
  leaderFlag = rows[0].acquired === true;
}

function start() {
  tryAcquire().catch(err => logger.error('[leaderElection] falha ao tentar adquirir lock', { error: err.message }));

  retryTimer = setInterval(() => {
    if (leaderFlag) return; // quem já é líder não precisa redisputar
    tryAcquire().catch(err => logger.error('[leaderElection] falha ao tentar adquirir lock', { error: err.message }));
  }, RETRY_INTERVAL_MS);
  retryTimer.unref();
}

async function stop() {
  clearInterval(retryTimer);
  if (client) {
    await client.end().catch(() => {});
  }
  client = null;
  leaderFlag = false;
}

function isLeader() {
  return leaderFlag;
}

module.exports = { start, stop, isLeader };
