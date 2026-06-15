require('dotenv').config();
const express = require('express');
const { HenryHexa } = require('./henry-hexa');

const app = express();
const PORT       = process.env.PORT       || 4321;
const API_TOKEN  = process.env.API_TOKEN;
const CLOCK_USER = process.env.CLOCK_USER;
const CLOCK_PASS = process.env.CLOCK_PASS;
const CLOCK_IPS  = (process.env.CLOCK_IPS || '')
  .split(',').map(ip => ip.trim()).filter(Boolean);

if (!API_TOKEN || !CLOCK_USER || !CLOCK_PASS) {
  console.error('ERRO: API_TOKEN, CLOCK_USER e CLOCK_PASS sao obrigatorios no .env');
  process.exit(1);
}

app.use(express.json());

// Health check sem autenticação (usado pelo Delirio Manager para checar se o proxy está vivo)
app.get('/health', (req, res) => res.json({ ok: true, service: 'dt-clock-proxy' }));

// Middleware de autenticação Bearer
app.use((req, res, next) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${API_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── OFFBOARDING (LGPD Art. 15/16) ──────────────────────────────────────────
// Remove funcionário de um relógio específico
// Body: { cpf, employeeName, triggeredBy }
app.post('/clock/:ip/offboard', async (req, res) => {
  const { ip } = req.params;
  const { cpf, employeeName, triggeredBy } = req.body;

  if (!cpf) return res.status(400).json({ error: 'cpf obrigatório' });

  console.log(`[${new Date().toISOString()}] OFFBOARD ${cpf} (${employeeName}) em ${ip} — por ${triggeredBy}`);

  const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await henry.deleteEmployee(cpf);

  console.log(`[${new Date().toISOString()}] OFFBOARD resultado: ${JSON.stringify(result)}`);
  res.json(result);
});

// ─── ONBOARDING ──────────────────────────────────────────────────────────────
// Cadastra funcionário em um relógio específico
// Body: { cpf, name, ref1, ref2, password }
// ref1 (matrícula) é obrigatório pelo relógio — sem ele o save retorna "Parâmetros inválidos"
app.post('/clock/:ip/enroll', async (req, res) => {
  const { ip } = req.params;
  const { cpf, name, ref1, ref2, password } = req.body;

  if (!cpf || !name || !ref1) return res.status(400).json({ error: 'cpf, name e ref1 (matrícula) são obrigatórios' });

  console.log(`[${new Date().toISOString()}] ENROLL ${cpf} (${name}) ref1=${ref1} em ${ip}`);

  const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await henry.enrollEmployee({ cpf, name, ref1, ref2, password });

  console.log(`[${new Date().toISOString()}] ENROLL resultado: ${JSON.stringify(result)}`);
  res.json(result);
});

// ─── ATUALIZAR CARTÃO ────────────────────────────────────────────────────────
// Atualiza Referência 2 (UID do cartão NFC) de um funcionário
// Body: { cpf, ref2 }
app.put('/clock/:ip/card', async (req, res) => {
  const { ip } = req.params;
  const { cpf, ref2 } = req.body;

  if (!cpf || !ref2) return res.status(400).json({ error: 'cpf e ref2 obrigatórios' });

  const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await henry.updateCardRef2(cpf, ref2);

  res.json(result);
});

// ─── LISTAR FUNCIONÁRIOS ─────────────────────────────────────────────────────
// Lista todos os funcionários cadastrados em um relógio
app.get('/clock/:ip/employees', async (req, res) => {
  const { ip } = req.params;

  const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
  const result = await henry.listEmployees();

  res.json(result);
});

// ─── OFFBOARD LGPD — TODOS OS RELÓGIOS ───────────────────────────────────────
// Chamado pelo Delirio Manager (Azure) no desligamento de funcionário.
// Remove o funcionário de todos os relógios configurados em CLOCK_IPS.
// Body: { cpf, employeeName, triggeredBy }
app.post('/rh/offboard', async (req, res) => {
  const { cpf, employeeName, triggeredBy } = req.body;

  if (!cpf) return res.status(400).json({ error: 'cpf obrigatorio' });

  if (CLOCK_IPS.length === 0) {
    return res.status(500).json({ error: 'CLOCK_IPS nao configurado no .env do servidor' });
  }

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] RH OFFBOARD ${cpf} (${employeeName}) em ${CLOCK_IPS.length} relogios — por ${triggeredBy}`);

  const results = [];
  for (const ip of CLOCK_IPS) {
    const henry = new HenryHexa(ip, CLOCK_USER, CLOCK_PASS);
    const result = await henry.deleteEmployee(cpf);
    results.push({ clockIp: ip, ...result });
    console.log(`[${new Date().toISOString()}] ${ip}: ${result.success ? 'OK' : result.alreadyAbsent ? 'JA_AUSENTE' : 'FALHOU'}`);
  }

  const summary = {
    success:       results.every(r => r.success || r.alreadyAbsent),
    cpf,
    employeeName,
    triggeredBy,
    timestamp,
    clocks:        results,
    total:         results.length,
    removed:       results.filter(r => r.success && !r.alreadyAbsent).length,
    alreadyAbsent: results.filter(r => r.alreadyAbsent).length,
    failed:        results.filter(r => !r.success && !r.alreadyAbsent).length,
  };

  res.json(summary);
});

// Escuta em todas as interfaces para ser acessível via LAN/VPN pelo backend Azure
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dt-clock-proxy] Rodando em 0.0.0.0:${PORT}`);
  console.log(`[dt-clock-proxy] Relogios configurados: ${CLOCK_IPS.length > 0 ? CLOCK_IPS.join(', ') : 'NENHUM — configure CLOCK_IPS no .env'}`);
});
