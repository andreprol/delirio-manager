'use strict';

const { validateHeartbeat } = require('./agent');

describe('validateHeartbeat', () => {

  // ── Happy paths ──────────────────────────────────────────────────────────

  it('retorna [] para payload completo e válido', () => {
    const body = {
      agentVersion: '1.5.18',
      motherboard:  'ASUS ROG STRIX',
      osVersion:    'Windows 10 Pro',
      wolEnabled:   true,
      metrics: {
        cpu_pct:  45.2,
        ram_pct:  62.0,
        disk_pct: 33.1,
        temp_c:   55.0,
        mac:      'AA:BB:CC:DD:EE:FF',
        ips:      ['192.168.1.10', '10.0.0.5'],
      },
      drStatus: {
        setup:          'installed',
        veeam_version:  '12.1',
        storage_gb:     500,
        last_backup_at: '2026-07-10T02:00:00Z',
        last_backup_ok: true,
      },
    };
    expect(validateHeartbeat(body)).toEqual([]);
  });

  it('retorna [] quando metrics está ausente (campo opcional)', () => {
    expect(validateHeartbeat({ agentVersion: '1.5.18' })).toEqual([]);
  });

  it('retorna [] quando drStatus está ausente (campo opcional)', () => {
    expect(validateHeartbeat({ metrics: { cpu_pct: 50 } })).toEqual([]);
  });

  it('aceita disk_pct nos limites exatos 0 e 100', () => {
    expect(validateHeartbeat({ metrics: { disk_pct: 0   } })).toEqual([]);
    expect(validateHeartbeat({ metrics: { disk_pct: 100 } })).toEqual([]);
  });

  it('aceita MAC com separador hífen', () => {
    expect(validateHeartbeat({ metrics: { mac: 'AA-BB-CC-DD-EE-FF' } })).toEqual([]);
  });

  // ── Campos numéricos fora do range ────────────────────────────────────────

  it('rejeita cpu_pct acima de 100', () => {
    const erros = validateHeartbeat({ metrics: { cpu_pct: 150 } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/cpu_pct/);
  });

  it('rejeita cpu_pct negativo', () => {
    const erros = validateHeartbeat({ metrics: { cpu_pct: -1 } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/cpu_pct/);
  });

  it('rejeita ram_pct quando é string', () => {
    const erros = validateHeartbeat({ metrics: { ram_pct: 'muito' } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/ram_pct/);
  });

  it('rejeita temp_c acima de 150', () => {
    const erros = validateHeartbeat({ metrics: { temp_c: 200 } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/temp_c/);
  });

  it('rejeita NaN em disk_pct', () => {
    const erros = validateHeartbeat({ metrics: { disk_pct: NaN } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/disk_pct/);
  });

  // ── Strings com tamanho excessivo ─────────────────────────────────────────

  it('rejeita agentVersion com mais de 50 chars', () => {
    const erros = validateHeartbeat({ agentVersion: 'A'.repeat(51) });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/agentVersion/);
  });

  it('rejeita motherboard com mais de 200 chars', () => {
    const erros = validateHeartbeat({ motherboard: 'B'.repeat(201) });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/motherboard/);
  });

  it('rejeita osVersion com mais de 100 chars', () => {
    const erros = validateHeartbeat({ osVersion: 'C'.repeat(101) });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/osVersion/);
  });

  // ── MAC inválido ──────────────────────────────────────────────────────────

  it('rejeita MAC com formato inválido', () => {
    const erros = validateHeartbeat({ metrics: { mac: 'nao-e-um-mac' } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/mac/);
  });

  it('rejeita MAC com bytes extras', () => {
    const erros = validateHeartbeat({ metrics: { mac: 'AA:BB:CC:DD:EE:FF:00' } });
    expect(erros.length).toBeGreaterThan(0);
  });

  // ── IPs inválidos ─────────────────────────────────────────────────────────

  it('rejeita metrics.ips com mais de 20 itens', () => {
    const erros = validateHeartbeat({ metrics: { ips: Array(21).fill('192.168.1.1') } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/ips/);
  });

  it('rejeita metrics.ips quando não é array', () => {
    const erros = validateHeartbeat({ metrics: { ips: '192.168.1.1' } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/ips/);
  });

  it('rejeita item de ips com mais de 45 chars', () => {
    const longIp = 'A'.repeat(46);
    const erros = validateHeartbeat({ metrics: { ips: [longIp] } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/ips/);
  });

  // ── metrics não é objeto ──────────────────────────────────────────────────

  it('rejeita metrics quando é string', () => {
    const erros = validateHeartbeat({ metrics: 'payload_malicioso' });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/metrics/);
  });

  it('rejeita metrics quando é array', () => {
    const erros = validateHeartbeat({ metrics: [{ cpu_pct: 50 }] });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/metrics/);
  });

  // ── drStatus inválido ─────────────────────────────────────────────────────

  it('rejeita drStatus.storage_gb não-numérico', () => {
    const erros = validateHeartbeat({ drStatus: { storage_gb: 'abc' } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/storage_gb/);
  });

  it('rejeita drStatus.storage_gb negativo', () => {
    const erros = validateHeartbeat({ drStatus: { storage_gb: -10 } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/storage_gb/);
  });

  it('rejeita drStatus.setup com mais de 50 chars', () => {
    const erros = validateHeartbeat({ drStatus: { setup: 'x'.repeat(51) } });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/setup/);
  });

  it('rejeita drStatus quando é string', () => {
    const erros = validateHeartbeat({ drStatus: 'installed' });
    expect(erros.length).toBeGreaterThan(0);
    expect(erros[0]).toMatch(/drStatus/);
  });

  // ── Múltiplos erros simultâneos ───────────────────────────────────────────

  it('retorna múltiplos erros quando vários campos são inválidos', () => {
    const body = {
      agentVersion: 'A'.repeat(100),
      metrics: { cpu_pct: 999, ram_pct: -5 },
    };
    const erros = validateHeartbeat(body);
    expect(erros.length).toBeGreaterThanOrEqual(3);
  });

});
