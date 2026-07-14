'use strict';

const js      = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // Ignora arquivos gerados e node_modules
  {
    ignores: ['node_modules/**', 'public/**', 'data/**', 'logs/**'],
  },

  // Base: regras recomendadas
  js.configs.recommended,

  // Arquivos de produção (CommonJS Node.js)
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Bugs reais — error
      'no-undef':        'error',
      'no-unreachable':  'error',
      'eqeqeq':         ['error', 'always', { null: 'ignore' }],
      'no-fallthrough':  'error',

      // Empty catch blocks são intencionais em vários lugares (swallow errors)
      'no-empty':        ['error', { allowEmptyCatch: true }],

      // no-useless-assignment: downgrade para warn (codebase existente tem casos legítimos)
      'no-useless-assignment': 'warn',

      // Complexidade ciclomática — máx 10 por função (Cap. 5 Eng.Soft.Moderna)
      // Meta atingida em 14/07/2026 — CI bloqueia novas violações
      'complexity':      ['error', { max: 10 }],

      // Funções longas — máx 40 linhas (Cap. 9 Eng.Soft.Moderna — Método Longo)
      // 33 violações em 14/07/2026 (warn). Limpar e promover para error gradualmente.
      // Exceções legítimas: migrate (DB migrations), generateDocx (builder).
      'max-lines-per-function': ['warn', { max: 40, skipBlankLines: true, skipComments: true }],

      // Qualidade — warn (migração gradual)
      'no-unused-vars':  ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console':      'warn',
    },
  },

  // Arquivos de teste — adiciona globals Jest
  {
    files: ['**/*.test.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
];
