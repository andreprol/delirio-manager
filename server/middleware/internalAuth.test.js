'use strict';

const { internalAuth } = require('./internalAuth');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

describe('internalAuth', () => {
  const ORIGINAL_ENV = process.env.INTERNAL_API_KEY;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = ORIGINAL_ENV;
  });

  it('503 quando INTERNAL_API_KEY não está configurada', () => {
    delete process.env.INTERNAL_API_KEY;
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    internalAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 quando o header não bate com a chave configurada', () => {
    process.env.INTERNAL_API_KEY = 'segredo-123';
    const req = { headers: { 'x-internal-key': 'chave-errada' } };
    const res = mockRes();
    const next = jest.fn();

    internalAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401 quando o header está ausente', () => {
    process.env.INTERNAL_API_KEY = 'segredo-123';
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    internalAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('passa adiante quando o header bate com a chave configurada', () => {
    process.env.INTERNAL_API_KEY = 'segredo-123';
    const req = { headers: { 'x-internal-key': 'segredo-123' } };
    const res = mockRes();
    const next = jest.fn();

    internalAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
