'use strict';

const { findMatch } = require('./watchlistMatcher');

describe('findMatch', () => {
  const keywords = [
    { id: 1, keyword: 'vaga de emprego' },
    { id: 2, keyword: 'LinkedIn' },
  ];

  it('acha match case-insensitive no título da janela', () => {
    const result = findMatch('Vaga de Emprego - LinkedIn - Google Chrome', keywords);
    expect(result).toEqual({ id: 1, keyword: 'vaga de emprego' });
  });

  it('retorna null quando não bate nenhuma keyword', () => {
    const result = findMatch('Planilha de custos - Excel', keywords);
    expect(result).toBeNull();
  });

  it('retorna null quando a lista de keywords está vazia', () => {
    expect(findMatch('qualquer coisa', [])).toBeNull();
  });

  it('ignora keyword vazia na lista sem quebrar', () => {
    const result = findMatch('tela qualquer', [{ id: 3, keyword: '' }]);
    expect(result).toBeNull();
  });

  it('casa mesmo com espaço nas bordas da keyword', () => {
    const result = findMatch('Vaga de Emprego - Google Chrome', [{ id: 4, keyword: '  vaga de emprego  ' }]);
    expect(result).toEqual({ id: 4, keyword: '  vaga de emprego  ' });
  });

  it('retorna a primeira keyword que bater quando mais de uma casa', () => {
    const result = findMatch('Vaga de Emprego - LinkedIn - Google Chrome', keywords);
    expect(result.id).toBe(1);
  });

  it('retorna null quando text não é string', () => {
    expect(findMatch(123, keywords)).toBeNull();
  });
});
