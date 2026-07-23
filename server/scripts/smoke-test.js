'use strict';

const host = process.env.HEALTH_HOST || 'localhost';
const port = process.env.HEALTH_PORT || process.env.PORT || 3847;
const url  = `http://${host}:${port}/health`;

async function run() {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    console.error(`[smoke] FALHA — não foi possível conectar em ${url}: ${e.message}`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`[smoke] FALHA — /health retornou HTTP ${res.status}`);
    process.exit(1);
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    console.error('[smoke] FALHA — /health retornou JSON inválido');
    process.exit(1);
  }

  const checks = [
    [body.status === 'ok',             'status deve ser "ok"'],
    [typeof body.version === 'string', 'version deve ser string'],
    [typeof body.uptime === 'number',  'uptime deve ser número'],
    [body.machines != null,            'machines não pode ser null'],
    [typeof body.machines.total === 'number', 'machines.total deve ser número'],
  ];

  let passed = true;
  for (const [ok, label] of checks) {
    if (ok) {
      console.log(`  ✓ ${label}`);
    } else {
      console.error(`  ✗ ${label}`);
      passed = false;
    }
  }

  if (!passed) {
    console.error('[smoke] FALHA — um ou mais checks falharam');
    process.exit(1);
  }

  console.log(`[smoke] OK — ${url} respondeu v${body.version} uptime=${body.uptime}s machines=${body.machines.total}`);
  process.exit(0);
}

run();
