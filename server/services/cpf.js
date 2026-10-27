'use strict';

// services/cpf.js — normalização de CPF pra chave de busca/login consistente.
// Admin cadastra com máscara ("111.222.333-44"), funcionário costuma digitar
// só números no celular — sem normalizar, os dois nunca batem como a mesma
// string e o login falha silenciosamente pra sempre.

function normalizeCpf(cpf) {
  return String(cpf || '').replace(/\D/g, '');
}

function isValidCpfFormat(cpf) {
  return /^\d{11}$/.test(normalizeCpf(cpf));
}

module.exports = { normalizeCpf, isValidCpfFormat };
