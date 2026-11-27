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

// Teto do connect(). pg.Client não tem timeout de conexão por padrão — sob
// contenção de I/O (incidentes 15-16/11) o connect() pode pendurar
// indefinidamente. Menor que RETRY_INTERVAL_MS de propósito: uma tentativa
// sempre termina antes da próxima ser agendada.
const CONNECT_TIMEOUT_MS = 10000;

// Estado interno do módulo.
let client = null;
let leaderFlag = false;
let retryTimer = null;
// true enquanto um tryAcquire() está em voo — o retry não abre uma 2ª
// tentativa (e uma 2ª conexão) concorrente. Sem isso, um connect() lento
// fazia o retry criar outro Client (client ainda null); se o 1º depois
// ganhasse o lock ficava órfão segurando-o, e esta instância nunca mais
// viraria líder (pg_try_advisory_lock false pra sempre na 2ª conexão).
let acquiring = false;
// Promise da 1ª tentativa disparada por start() — sempre resolve (nunca
// rejeita: o .catch() do start() já engole/loga o erro). Exposta via
// whenFirstAttemptSettled() pra quem precisa SABER se é líder antes de
// decidir (ex.: catch-ups imediatos no boot em server.js).
let firstAttempt = null;

// connect() com teto próprio, além do connectionTimeoutMillis do pg (defesa
// em profundidade: garante que `acquiring` sempre volta a false). Se estourar
// ou rejeitar, o Client é encerrado e NUNCA é atribuído a `client` nem
// recebe query — logo nunca chega a pegar o lock, mesmo que o connect
// "acorde" depois.
async function connectWithTimeout(newClient) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`connect() excedeu ${CONNECT_TIMEOUT_MS}ms`)),
      CONNECT_TIMEOUT_MS
    );
  });
  try {
    await Promise.race([newClient.connect(), timeout]);
  } catch (err) {
    newClient.end().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function tryAcquire() {
  if (acquiring) return; // tentativa anterior ainda em voo
  acquiring = true;
  try {
    if (client === null) {
      const newClient = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      });
      newClient.on('error', (err) => {
        // Só a conexão ATUAL mexe no estado. Um Client já descartado (timeout
        // / falha de connect) emitindo erro tarde não pode zerar `client` e
        // `leaderFlag` de outra conexão viva que detém o lock.
        if (client !== newClient) return;
        logger.error('[leaderElection] conexao encerrada com erro, perdendo lideranca', { error: err.message });
        leaderFlag = false;
        client = null;
      });
      await connectWithTimeout(newClient);
      client = newClient;
    }

    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [LOCK_KEY]
    );
    leaderFlag = rows[0].acquired === true;
  } finally {
    acquiring = false;
  }
}

function start() {
  firstAttempt = tryAcquire().catch(err => logger.error('[leaderElection] falha ao tentar adquirir lock', { error: err.message }));

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

// Resolve quando a 1ª tentativa de start() terminou (ganhando o lock, perdendo
// ou falhando) — a partir daí isLeader() reflete a disputa real, não o `false`
// inicial. start() continua fire-and-forget; isto é só um sinal opcional.
// Chamado antes de start(): resolve na hora (nunca pendura quem esquecer).
function whenFirstAttemptSettled() {
  return (firstAttempt || Promise.resolve()).then(() => undefined);
}

module.exports = { start, stop, isLeader, whenFirstAttemptSettled };
