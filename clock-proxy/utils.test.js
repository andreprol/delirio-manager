'use strict';

const { formatCpf, buildMasterCache } = require('./utils');

// ── formatCpf ─────────────────────────────────────────────────────────────────

describe('formatCpf', () => {
  it('digits only → xxx.xxx.xxx-xx', () => {
    expect(formatCpf('12345678909')).toBe('123.456.789-09');
  });

  it('already formatted → unchanged', () => {
    expect(formatCpf('123.456.789-09')).toBe('123.456.789-09');
  });

  it('strips spaces, dots, dashes then formats', () => {
    expect(formatCpf('  123 456 789 09  ')).toBe('123.456.789-09');
  });

  it('truncates to 11 digits when extra digits provided', () => {
    expect(formatCpf('123456789099999')).toBe('123.456.789-09');
  });

  it('partial CPF (< 11 digits) → partial regex match (no format applied)', () => {
    // Regex requires exactly 3+3+3+2 = 11 digits to match
    expect(formatCpf('12345')).toBe('12345');
  });

  it('null → empty string', () => {
    expect(formatCpf(null)).toBe('');
  });

  it('undefined → empty string', () => {
    expect(formatCpf(undefined)).toBe('');
  });

  it('empty string → empty string', () => {
    expect(formatCpf('')).toBe('');
  });
});

// ── buildMasterCache ──────────────────────────────────────────────────────────

const IP1 = '192.168.14.151';
const IP2 = '192.168.15.151';
const IP3 = '192.168.12.151';

function makeEmp(cpf, opts = {}) {
  return { cpf, name: opts.name || `Func ${cpf}`, ref1: opts.ref1 || '001', ref2: opts.ref2 || '' };
}

function makeClock(ip, employees, success = true) {
  return { ip, success, employees: success ? employees : [], total: employees.length, message: success ? undefined : 'offline' };
}

describe('buildMasterCache', () => {
  it('resultado vazio → counters zerados', () => {
    const result = buildMasterCache([], [IP1]);
    expect(result.total).toBe(0);
    expect(result.divergent).toBe(0);
    expect(result.incomplete).toBe(0);
    expect(result.synchronized).toBe(0);
    expect(result.employees).toHaveLength(0);
  });

  it('allClockIps passado para o campo allClockIps', () => {
    const result = buildMasterCache([], [IP1, IP2]);
    expect(result.allClockIps).toEqual([IP1, IP2]);
  });

  it('allClockIps undefined → campo é []', () => {
    const result = buildMasterCache([], undefined);
    expect(result.allClockIps).toEqual([]);
  });

  it('relógio com success:false não conta como acessível nem como fonte de funcionários', () => {
    const clock = makeClock(IP1, [makeEmp('11111111111')], false);
    const result = buildMasterCache([clock], [IP1]);
    expect(result.total).toBe(0);
  });

  it('funcionário presente em único relógio → absentIn vazio, presentIn correto', () => {
    const result = buildMasterCache([makeClock(IP1, [makeEmp('11111111111')])], [IP1]);
    expect(result.total).toBe(1);
    expect(result.employees[0].presentIn).toEqual([IP1]);
    expect(result.employees[0].absentIn).toEqual([]);
  });

  it('funcionário presente em todos os relógios → absentIn vazio (synchronized)', () => {
    const emp = makeEmp('22222222222');
    const result = buildMasterCache([makeClock(IP1, [emp]), makeClock(IP2, [emp])], [IP1, IP2]);
    expect(result.divergent).toBe(0);
    expect(result.synchronized).toBe(1);
    expect(result.employees[0].absentIn).toHaveLength(0);
  });

  it('funcionário ausente em um relógio → absentIn correto, divergent = 1', () => {
    const emp = makeEmp('33333333333');
    const result = buildMasterCache([makeClock(IP1, [emp]), makeClock(IP2, [])], [IP1, IP2]);
    expect(result.divergent).toBe(1);
    expect(result.employees[0].absentIn).toContain(IP2);
    expect(result.employees[0].presentIn).toContain(IP1);
  });

  it('deduplicação: mesmo CPF em dois relógios → uma entrada', () => {
    const emp = makeEmp('44444444444');
    const result = buildMasterCache([makeClock(IP1, [emp]), makeClock(IP2, [emp])], [IP1, IP2]);
    expect(result.total).toBe(1);
    expect(result.employees[0].presentIn).toHaveLength(2);
  });

  it('ref2 mesclado: relógio A tem ref2, relógio B não → entrada mestre conserva ref2', () => {
    const empComRef2  = makeEmp('55555555555', { ref2: 'CARD001' });
    const empSemRef2  = makeEmp('55555555555', { ref2: '' });
    const result = buildMasterCache(
      [makeClock(IP1, [empComRef2]), makeClock(IP2, [empSemRef2])],
      [IP1, IP2],
    );
    expect(result.employees[0].ref2).toBe('CARD001');
  });

  it('ref1 mesclado: relógio A tem ref1, relógio B não → entrada mestre conserva ref1', () => {
    const empComRef1 = makeEmp('66666666666', { ref1: 'MAT123' });
    const empSemRef1 = { cpf: '66666666666', name: 'Func', ref1: '', ref2: '' };
    const result = buildMasterCache(
      [makeClock(IP1, [empComRef1]), makeClock(IP2, [empSemRef1])],
      [IP1, IP2],
    );
    expect(result.employees[0].ref1).toBe('MAT123');
  });

  it('funcionário sem ref2 → incompleteIn vazio mesmo presente em vários relógios', () => {
    const emp = makeEmp('77777777777', { ref2: '' });
    const result = buildMasterCache([makeClock(IP1, [emp]), makeClock(IP2, [emp])], [IP1, IP2]);
    expect(result.employees[0].incompleteIn).toHaveLength(0);
    expect(result.incomplete).toBe(0);
  });

  it('ref2 no mestre mas ausente em relógio onde funcionário está presente → incompleteIn', () => {
    // IP1: tem ref2; IP2: não tem ref2 (campo vazio no relógio)
    const empComRef2 = makeEmp('88888888888', { ref2: 'CARD002' });
    const empSemRef2 = makeEmp('88888888888', { ref2: '' });
    const result = buildMasterCache(
      [makeClock(IP1, [empComRef2]), makeClock(IP2, [empSemRef2])],
      [IP1, IP2],
    );
    expect(result.employees[0].incompleteIn).toContain(IP2);
    expect(result.incomplete).toBe(1);
  });

  it('relógio offline excluído de reachableIps → não afeta absentIn do funcionário', () => {
    const emp = makeEmp('99999999999');
    const online  = makeClock(IP1, [emp], true);
    const offline = makeClock(IP2, [],    false);
    const result  = buildMasterCache([online, offline], [IP1, IP2]);
    // IP2 offline → não aparece em reachableIps → não entra em absentIn
    expect(result.employees[0].absentIn).toHaveLength(0);
  });

  it('clocks no retorno reflete mapeamento correto de success e total', () => {
    const result = buildMasterCache(
      [makeClock(IP1, [makeEmp('10101010101')], true), makeClock(IP2, [], false)],
      [IP1, IP2],
    );
    const c1 = result.clocks.find(c => c.ip === IP1);
    const c2 = result.clocks.find(c => c.ip === IP2);
    expect(c1.success).toBe(true);
    expect(c2.success).toBe(false);
  });

  it('synchronized = total − divergent', () => {
    const emp1 = makeEmp('11223344556');
    const emp2 = makeEmp('22334455667');
    // emp1 nos dois, emp2 só no IP1 → divergent=1, total=2, synchronized=1
    const result = buildMasterCache(
      [makeClock(IP1, [emp1, emp2]), makeClock(IP2, [emp1])],
      [IP1, IP2],
    );
    expect(result.total).toBe(2);
    expect(result.divergent).toBe(1);
    expect(result.synchronized).toBe(1);
  });

  it('três relógios: funcionário em 2 de 3 → absentIn tem exatamente o IP ausente', () => {
    const emp = makeEmp('55566677788');
    const result = buildMasterCache(
      [makeClock(IP1, [emp]), makeClock(IP2, [emp]), makeClock(IP3, [])],
      [IP1, IP2, IP3],
    );
    expect(result.employees[0].absentIn).toEqual([IP3]);
  });

  it('timestamp presente no retorno', () => {
    const result = buildMasterCache([], []);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
