'use strict';

jest.mock('../db', () => ({
  purgeActivityLog: jest.fn(() => 3),
}));

const { runPurgeOnce } = require('./activityRetention');

describe('runPurgeOnce', () => {
  it('chama purgeActivityLog com 90 dias e retorna quantas linhas removeu', () => {
    const db = require('../db');
    const removed = runPurgeOnce();
    expect(db.purgeActivityLog).toHaveBeenCalledWith(90);
    expect(removed).toBe(3);
  });

  it('erro no purge não lança — retorna 0 e segue', () => {
    const db = require('../db');
    db.purgeActivityLog.mockImplementationOnce(() => {
      throw new Error('disco cheio');
    });
    let removed;
    expect(() => { removed = runPurgeOnce(); }).not.toThrow();
    expect(removed).toBe(0);
  });
});
