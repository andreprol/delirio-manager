'use strict';

const { hashPassword, verifyPassword } = require('./password');

describe('hashPassword/verifyPassword', () => {
  it('senha correta verifica true', () => {
    const stored = hashPassword('minhaSenha123');
    expect(verifyPassword('minhaSenha123', stored)).toBe(true);
  });

  it('senha errada verifica false', () => {
    const stored = hashPassword('minhaSenha123');
    expect(verifyPassword('outraSenha', stored)).toBe(false);
  });

  it('hash nunca é a senha em texto puro', () => {
    const stored = hashPassword('minhaSenha123');
    expect(stored).not.toContain('minhaSenha123');
  });

  it('dois hashes da mesma senha são diferentes (salt aleatório)', () => {
    const a = hashPassword('mesmaSenha');
    const b = hashPassword('mesmaSenha');
    expect(a).not.toBe(b);
  });

  it('stored malformado (sem ":") retorna false em vez de lançar', () => {
    expect(verifyPassword('qualquer', 'hashsemformato')).toBe(false);
  });

  it('stored vazio/undefined retorna false', () => {
    expect(verifyPassword('qualquer', '')).toBe(false);
    expect(verifyPassword('qualquer', undefined)).toBe(false);
  });
});
