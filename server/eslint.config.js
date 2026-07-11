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
