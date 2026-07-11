'use strict';

const logger = require('./logger');

describe('logger.formatUptime', () => {
  it('< 1h → Xm', () => {
    expect(logger.formatUptime(0)).toBe('0m');
    expect(logger.formatUptime(59)).toBe('0m');
    expect(logger.formatUptime(60)).toBe('1m');
    expect(logger.formatUptime(3599)).toBe('59m');
  });

  it('1h–23h → Xh Ym', () => {
    expect(logger.formatUptime(3600)).toBe('1h 0m');
    expect(logger.formatUptime(3661)).toBe('1h 1m');
    expect(logger.formatUptime(86399)).toBe('23h 59m');
  });

  it('>= 1d → Xd Yh Zm', () => {
    expect(logger.formatUptime(86400)).toBe('1d 0h 0m');
    expect(logger.formatUptime(90061)).toBe('1d 1h 1m');
    expect(logger.formatUptime(172800)).toBe('2d 0h 0m');
  });
});

describe('logger — métodos de log', () => {
  let stdoutSpy, stderrSpy;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('info escreve em stdout', () => {
    logger.info('mensagem de teste');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('warn escreve em stdout', () => {
    logger.warn('aviso de teste');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it('error escreve em stderr', () => {
    logger.error('erro de teste');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('output contém level e msg', () => {
    logger.info('hello world', { foo: 'bar' });
    const output = stdoutSpy.mock.calls[0][0];
    expect(output).toContain('hello world');
    expect(output).toContain('INFO');
  });

  it('meta é incluído no output', () => {
    logger.warn('alerta', { machineId: 'mach-01', threshold: 80 });
    const output = stdoutSpy.mock.calls[0][0];
    expect(output).toContain('mach-01');
    expect(output).toContain('80');
  });
});
