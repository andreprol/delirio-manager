'use strict';

const { normalizeCpf, isValidCpfFormat } = require('./cpf');

describe('normalizeCpf', () => {
  it('remove pontuação de máscara', () => {
    expect(normalizeCpf('111.222.333-44')).toBe('11122233344');
  });

  it('já normalizado fica igual', () => {
    expect(normalizeCpf('11122233344')).toBe('11122233344');
  });

  it('vazio/undefined vira string vazia', () => {
    expect(normalizeCpf('')).toBe('');
    expect(normalizeCpf(undefined)).toBe('');
  });
});

describe('isValidCpfFormat', () => {
  it('11 dígitos (com ou sem máscara) — válido', () => {
    expect(isValidCpfFormat('11122233344')).toBe(true);
    expect(isValidCpfFormat('111.222.333-44')).toBe(true);
  });

  it('menos ou mais de 11 dígitos — inválido', () => {
    expect(isValidCpfFormat('123')).toBe(false);
    expect(isValidCpfFormat('111222333445')).toBe(false);
  });
});
