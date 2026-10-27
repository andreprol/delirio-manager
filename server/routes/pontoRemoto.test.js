'use strict';

const express = require('express');
const request = require('supertest');

const { hashPassword } = require('../services/password');

const ADMIN_SECRET = 'segredo-123';
const VALID_SENHA  = 'senha-forte-123';
const EMPLOYEE = {
  id: 1,
  cpf: '00000000000',
  name: 'Fulano de Tal',
  store: 'Gávea',
  password_hash: hashPassword(VALID_SENHA),
  active: 1,
};

jest.mock('../db', () => ({
  getRemoteEmployeeByCpf:  jest.fn(),
  getRemoteEmployeeById:   jest.fn(),
  createRemoteSession:     jest.fn(),
  getRemoteSession:        jest.fn(),
  deleteRemoteSession:     jest.fn(),
  insertRemoteTimeEntry:   jest.fn(),
  listRemoteTimeEntriesForEmployee: jest.fn(() => []),
  createRemoteEmployee:    jest.fn(),
  listRemoteEmployees:     jest.fn(() => []),
  setRemoteEmployeeActive: jest.fn(),
  listAllRemoteTimeEntries: jest.fn(() => []),
  getRemoteTimeEntryById:  jest.fn(),
}));

const db = require('../db');

function makeApp() {
  const router = require('./pontoRemoto');
  const app = express();
  app.use(express.json());
  app.use('/api/ponto-remoto', router);
  return app;
}

function login(app, cpf, senha) {
  return request(app).post('/api/ponto-remoto/login').send({ cpf, senha });
}

function adminReq(method, app, path) {
  return request(app)[method](path).set('x-admin-secret', ADMIN_SECRET);
}

// Liga os mocks pra se comportar como uma sessão real: createRemoteSession
// guarda, getRemoteSession busca pelo hash, getRemoteEmployeeById resolve o funcionário.
function wireValidSession() {
  let stored = null;
  db.createRemoteSession.mockImplementation(({ tokenHash, employeeId, expiresAt }) => {
    stored = { token_hash: tokenHash, employee_id: employeeId, expires_at: expiresAt };
  });
  db.getRemoteSession.mockImplementation((tokenHash) =>
    (stored && stored.token_hash === tokenHash) ? stored : undefined
  );
  db.getRemoteEmployeeById.mockImplementation((id) => (id === EMPLOYEE.id ? EMPLOYEE : undefined));
  return { revoke: () => { stored = null; } };
}

// Loga como EMPLOYEE num supertest agent (cookie persiste nas chamadas seguintes).
async function loginAgent(app, cpf) {
  wireValidSession();
  db.getRemoteEmployeeByCpf.mockReturnValue(EMPLOYEE);
  const agent = request.agent(app);
  await agent.post('/api/ponto-remoto/login').send({ cpf, senha: VALID_SENHA });
  return agent;
}

const ORIGINAL_ADMIN_SECRET = process.env.ADMIN_SECRET;
const ORIGINAL_INSECURE_COOKIE = process.env.PONTO_REMOTO_INSECURE_COOKIE;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  // Testes rodam em HTTP puro (sem TLS) — sem isso o cookie Secure não voltaria no agent.
  process.env.PONTO_REMOTO_INSECURE_COOKIE = 'true';
});

afterEach(() => {
  if (ORIGINAL_ADMIN_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIGINAL_ADMIN_SECRET;
  if (ORIGINAL_INSECURE_COOKIE === undefined) delete process.env.PONTO_REMOTO_INSECURE_COOKIE;
  else process.env.PONTO_REMOTO_INSECURE_COOKIE = ORIGINAL_INSECURE_COOKIE;
});

describe('POST /login', () => {
  it('cpf e senha corretos — 200 + cookie HttpOnly de sessão', async () => {
    wireValidSession();
    db.getRemoteEmployeeByCpf.mockReturnValue(EMPLOYEE);

    const res = await login(makeApp(), '11111111111', VALID_SENHA);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, name: EMPLOYEE.name, store: EMPLOYEE.store });
    expect(res.headers['set-cookie'][0]).toMatch(/^pr_session=/);
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/);
  });

  it('senha errada — 401 com mensagem genérica', async () => {
    db.getRemoteEmployeeByCpf.mockReturnValue(EMPLOYEE);
    const res = await login(makeApp(), '22222222222', 'errada');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('CPF ou senha inválidos');
  });

  it('cpf inexistente — mesma mensagem genérica (não revela se o CPF existe)', async () => {
    db.getRemoteEmployeeByCpf.mockReturnValue(undefined);
    const res = await login(makeApp(), '33333333333', 'qualquer');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('CPF ou senha inválidos');
  });

  it('funcionário inativo — 401', async () => {
    db.getRemoteEmployeeByCpf.mockReturnValue({ ...EMPLOYEE, active: 0 });
    const res = await login(makeApp(), '44444444444', VALID_SENHA);
    expect(res.status).toBe(401);
  });

  it('cpf ou senha ausente — 400', async () => {
    const res = await request(makeApp()).post('/api/ponto-remoto/login').send({ cpf: '55555555555' });
    expect(res.status).toBe(400);
  });

  it('rate limit — bloqueia (429) após 5 tentativas erradas na mesma janela', async () => {
    db.getRemoteEmployeeByCpf.mockReturnValue(EMPLOYEE);
    const app = makeApp();
    const cpf = '66666666666';

    for (let i = 0; i < 5; i++) await login(app, cpf, 'errada');
    const res = await login(app, cpf, VALID_SENHA);
    expect(res.status).toBe(429);
  });
});

describe('normalização de CPF no login', () => {
  it('cpf com máscara bate com cadastro sem máscara', async () => {
    wireValidSession();
    db.getRemoteEmployeeByCpf.mockReturnValue(EMPLOYEE);

    const res = await login(makeApp(), '000.000.000-00', VALID_SENHA);

    expect(res.status).toBe(200);
    expect(db.getRemoteEmployeeByCpf).toHaveBeenCalledWith('00000000000');
  });
});

describe('rotas autenticadas por sessão de funcionário', () => {
  it('sem cookie de sessão — 401 em /clock e /my-entries', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/ponto-remoto/clock').send({ tipo: 'in' })).status).toBe(401);
    expect((await request(app).get('/api/ponto-remoto/my-entries')).status).toBe(401);
  });
});

describe('POST /clock', () => {
  it('grava com timestamp DO SERVIDOR — ignora timestamp enviado pelo client', async () => {
    db.insertRemoteTimeEntry.mockImplementation((args) => ({ id: 1, ...args }));
    const agent = await loginAgent(makeApp(), '77777777777');

    const forged = '2000-01-01T00:00:00.000Z';
    const res = await agent.post('/api/ponto-remoto/clock')
      .send({ tipo: 'in', lat: -22.9, lng: -43.2, serverTs: forged, timestamp: forged });

    expect(res.status).toBe(201);
    const [[callArgs]] = db.insertRemoteTimeEntry.mock.calls;
    expect(callArgs.serverTs).not.toBe(forged);
    expect(callArgs.employeeId).toBe(EMPLOYEE.id);
    expect(callArgs.createdBy).toBe('employee');
  });

  it('tipo inválido — 400', async () => {
    const agent = await loginAgent(makeApp(), '88888888888');
    const res = await agent.post('/api/ponto-remoto/clock').send({ tipo: 'lateral' });
    expect(res.status).toBe(400);
  });
});

describe('GET /me', () => {
  it('sem sessão — 401', async () => {
    const res = await request(makeApp()).get('/api/ponto-remoto/me');
    expect(res.status).toBe(401);
  });

  it('com sessão — nome e loja do funcionário autenticado', async () => {
    const agent = await loginAgent(makeApp(), '20202020202');
    const res = await agent.get('/api/ponto-remoto/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: EMPLOYEE.name, store: EMPLOYEE.store });
  });
});

describe('GET /my-entries e logout', () => {
  it('my-entries consulta só os registros do funcionário autenticado', async () => {
    db.listRemoteTimeEntriesForEmployee.mockReturnValue([{ id: 1, employee_id: EMPLOYEE.id }]);
    const agent = await loginAgent(makeApp(), '99999999999');

    const res = await agent.get('/api/ponto-remoto/my-entries');
    expect(res.status).toBe(200);
    expect(db.listRemoteTimeEntriesForEmployee).toHaveBeenCalledWith(EMPLOYEE.id);
  });

  it('logout revoga a sessão — chamada autenticada seguinte falha', async () => {
    wireValidSession();
    db.getRemoteEmployeeByCpf.mockReturnValue(EMPLOYEE);
    const app = makeApp();
    const agent = request.agent(app);
    await agent.post('/api/ponto-remoto/login').send({ cpf: '10101010101', senha: VALID_SENHA });

    const logoutRes = await agent.post('/api/ponto-remoto/logout');
    expect(logoutRes.status).toBe(200);
    expect(db.deleteRemoteSession).toHaveBeenCalled();

    db.getRemoteSession.mockReturnValue(undefined); // simula a remoção real da linha em remote_sessions
    expect((await agent.get('/api/ponto-remoto/my-entries')).status).toBe(401);
  });
});

describe('rotas admin — exigem X-Admin-Secret', () => {
  it('401 sem header em qualquer rota admin', async () => {
    const app = makeApp();
    expect((await request(app).get('/api/ponto-remoto/admin/employees')).status).toBe(401);
    const postRes = await request(app).post('/api/ponto-remoto/admin/employees')
      .send({ cpf: '1', name: 'X', store: 'Y', senha: 'z' });
    expect(postRes.status).toBe(401);
  });

  it('cadastra funcionário novo — 201', async () => {
    db.getRemoteEmployeeByCpf.mockReturnValue(undefined);
    db.createRemoteEmployee.mockReturnValue({ id: 2, cpf: '12312312312', name: 'Novo', store: 'Metro' });

    const res = await adminReq('post', makeApp(), '/api/ponto-remoto/admin/employees')
      .send({ cpf: '12312312312', name: 'Novo', store: 'Metro', senha: 'senha123' });

    expect(res.status).toBe(201);
    expect(res.body.employee.cpf).toBe('12312312312');
  });

  it('cadastra CPF já existente — 409', async () => {
    db.getRemoteEmployeeByCpf.mockReturnValue(EMPLOYEE);
    const res = await adminReq('post', makeApp(), '/api/ponto-remoto/admin/employees')
      .send({ cpf: EMPLOYEE.cpf, name: 'Dup', store: 'Metro', senha: 'senha123' });
    expect(res.status).toBe(409);
  });

  it('cpf com formato inválido (não 11 dígitos) — 400', async () => {
    const res = await adminReq('post', makeApp(), '/api/ponto-remoto/admin/employees')
      .send({ cpf: '123', name: 'X', store: 'Metro', senha: 'senha123' });
    expect(res.status).toBe(400);
  });

  it('toggle active de funcionário inexistente — 404', async () => {
    db.getRemoteEmployeeById.mockReturnValue(undefined);
    const res = await adminReq('patch', makeApp(), '/api/ponto-remoto/admin/employees/999').send({ active: false });
    expect(res.status).toBe(404);
  });
});

describe('correção de registro — admin', () => {
  it('cria linha nova referenciando a original, nunca edita', async () => {
    db.getRemoteTimeEntryById.mockReturnValue({ id: 5, employee_id: EMPLOYEE.id });
    db.insertRemoteTimeEntry.mockImplementation((args) => ({ id: 6, ...args }));

    const res = await adminReq('post', makeApp(), '/api/ponto-remoto/admin/entries/5/correct')
      .send({ tipo: 'in', timestamp: '2026-10-27T09:00:00.000Z', motivo: 'esqueceu de bater' });

    expect(res.status).toBe(201);
    const [[callArgs]] = db.insertRemoteTimeEntry.mock.calls;
    expect(callArgs.correctsId).toBe(5);
    expect(callArgs.createdBy).toBe('admin');
    expect(callArgs.correctionReason).toBe('esqueceu de bater');
  });

  it('registro inexistente — 404', async () => {
    db.getRemoteTimeEntryById.mockReturnValue(undefined);
    const res = await adminReq('post', makeApp(), '/api/ponto-remoto/admin/entries/999/correct')
      .send({ tipo: 'in', timestamp: '2026-10-27T09:00:00.000Z', motivo: 'x' });
    expect(res.status).toBe(404);
  });
});
