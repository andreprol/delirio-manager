'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const {
  loadFlags,
  saveFlags,
  isNewClockBypassActive,
  markAsNewClock,
  consumeNewClockFlag,
  isSuspiciousReading,
} = require('./newClockFlags');

function tmpFile() {
  return path.join(os.tmpdir(), `new-clock-flags-test-${Date.now()}-${Math.random()}.json`);
}

describe('loadFlags / saveFlags', () => {
  it('retorna Set vazio quando o arquivo não existe', () => {
    const flags = loadFlags(tmpFile());
    expect(flags).toBeInstanceOf(Set);
    expect(flags.size).toBe(0);
  });

  it('salva e recarrega os IPs marcados (sobrevive a restart)', () => {
    const file = tmpFile();
    const flags = new Set(['192.168.14.151', '192.168.20.151']);
    saveFlags(file, flags);

    const reloaded = loadFlags(file);
    expect([...reloaded].sort()).toEqual(['192.168.14.151', '192.168.20.151']);

    fs.unlinkSync(file);
  });

  it('retorna Set vazio se o arquivo estiver corrompido, sem lançar exceção', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{not valid json', 'utf8');

    const flags = loadFlags(file);
    expect(flags.size).toBe(0);

    fs.unlinkSync(file);
  });
});

describe('markAsNewClock / isNewClockBypassActive / consumeNewClockFlag', () => {
  it('marca um IP e a flag fica ativa', () => {
    const file  = tmpFile();
    const flags = new Set();

    markAsNewClock(flags, '192.168.14.151', file);

    expect(isNewClockBypassActive(flags, '192.168.14.151')).toBe(true);
    expect(isNewClockBypassActive(flags, '192.168.20.151')).toBe(false);

    fs.unlinkSync(file);
  });

  it('consumir a flag remove ela e persiste em disco', () => {
    const file  = tmpFile();
    const flags = new Set(['192.168.14.151']);
    saveFlags(file, flags);

    const consumed = consumeNewClockFlag(flags, '192.168.14.151', file);

    expect(consumed).toBe(true);
    expect(isNewClockBypassActive(flags, '192.168.14.151')).toBe(false);
    expect([...loadFlags(file)]).toEqual([]);

    fs.unlinkSync(file);
  });

  it('consumir um IP sem flag ativa não lança exceção e retorna false', () => {
    const file  = tmpFile();
    const flags = new Set();

    const consumed = consumeNewClockFlag(flags, '192.168.14.151', file);

    expect(consumed).toBe(false);
  });
});

describe('isSuspiciousReading', () => {
  it('sem bypass: novo count < 50% do anterior é suspeito', () => {
    const result = isSuspiciousReading({
      bypassGuard: false, prevSuccess: true, prevCount: 300, newCount: 10,
    });
    expect(result).toBe(true);
  });

  it('sem bypass: novo count >= 50% do anterior não é suspeito', () => {
    const result = isSuspiciousReading({
      bypassGuard: false, prevSuccess: true, prevCount: 300, newCount: 200,
    });
    expect(result).toBe(false);
  });

  it('sem bypass: sem leitura anterior bem-sucedida nunca é suspeito', () => {
    const result = isSuspiciousReading({
      bypassGuard: false, prevSuccess: false, prevCount: 0, newCount: 0,
    });
    expect(result).toBe(false);
  });

  it('COM bypass ativo: mesmo com queda >50%, nunca é suspeito', () => {
    const result = isSuspiciousReading({
      bypassGuard: true, prevSuccess: true, prevCount: 300, newCount: 0,
    });
    expect(result).toBe(false);
  });
});
