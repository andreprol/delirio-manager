import { describe, it, expect } from 'vitest'
import { compareVersions, getLatestVersion, isValidVersion, getVersionBadgeStatus } from '../versionCompare'

describe('compareVersions', () => {
  it('retorna 0 pra versoes iguais', () => {
    expect(compareVersions('1.9.1', '1.9.1')).toBe(0)
  })

  it('retorna positivo quando a primeira e maior (patch)', () => {
    expect(compareVersions('1.9.1', '1.9.0')).toBeGreaterThan(0)
  })

  it('retorna negativo quando a primeira e menor (patch)', () => {
    expect(compareVersions('1.9.0', '1.9.1')).toBeLessThan(0)
  })

  it('compara minor corretamente mesmo com patch menor', () => {
    expect(compareVersions('1.9.0', '1.8.9')).toBeGreaterThan(0)
  })

  it('compara major corretamente', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
  })

  it('trata partes ausentes como zero', () => {
    expect(compareVersions('1.9', '1.9.0')).toBe(0)
    expect(compareVersions('1.9.1', '1.9')).toBeGreaterThan(0)
  })
})

describe('getLatestVersion', () => {
  it('retorna a maior versao da lista', () => {
    expect(getLatestVersion(['1.8.2', '1.9.1', '1.9.0'])).toBe('1.9.1')
  })

  it('ignora valores vazios/undefined/null', () => {
    expect(getLatestVersion(['1.8.2', undefined, null, '', '1.9.0'])).toBe('1.9.0')
  })

  it('retorna null pra lista vazia ou so com valores invalidos', () => {
    expect(getLatestVersion([])).toBeNull()
    expect(getLatestVersion([undefined, null, ''])).toBeNull()
  })

  it('retorna a unica versao quando a lista tem 1 item', () => {
    expect(getLatestVersion(['1.9.1'])).toBe('1.9.1')
  })

  it('ignora versoes mal-formadas (nao numericas) sem virar baseline', () => {
    expect(getLatestVersion(['1.9.1-rc1', 'dev', '1.9.0'])).toBe('1.9.0')
    expect(getLatestVersion(['1.9.1-rc1', 'dev'])).toBeNull()
  })
})

describe('isValidVersion', () => {
  it('aceita formato numerico com pontos', () => {
    expect(isValidVersion('1.9.1')).toBe(true)
    expect(isValidVersion('1')).toBe(true)
    expect(isValidVersion('1.9')).toBe(true)
  })

  it('rejeita formato nao numerico, vazio ou tipos errados', () => {
    expect(isValidVersion('1.9.1-rc1')).toBe(false)
    expect(isValidVersion('dev')).toBe(false)
    expect(isValidVersion('')).toBe(false)
    expect(isValidVersion(undefined)).toBe(false)
    expect(isValidVersion(null)).toBe(false)
    expect(isValidVersion(1.9)).toBe(false)
  })
})

describe('getVersionBadgeStatus', () => {
  it('retorna null quando a versao da maquina e invalida', () => {
    expect(getVersionBadgeStatus('dev', '1.9.1')).toBeNull()
    expect(getVersionBadgeStatus(undefined, '1.9.1')).toBeNull()
  })

  it('retorna estado "unknown" quando nao ha baseline da frota ainda', () => {
    const status = getVersionBadgeStatus('1.9.0', null)
    expect(status.state).toBe('unknown')
    expect(status.tooltip).toContain('versão da frota ainda desconhecida')
  })

  it('retorna estado "unknown" quando a baseline em si e invalida', () => {
    const status = getVersionBadgeStatus('1.9.0', 'dev')
    expect(status.state).toBe('unknown')
  })

  it('retorna estado "current" quando igual ou maior que a baseline', () => {
    expect(getVersionBadgeStatus('1.9.1', '1.9.1').state).toBe('current')
    expect(getVersionBadgeStatus('1.9.2', '1.9.1').state).toBe('current')
  })

  it('retorna estado "outdated" quando menor que a baseline', () => {
    const status = getVersionBadgeStatus('1.9.0', '1.9.1')
    expect(status.state).toBe('outdated')
    expect(status.tooltip).toContain('desatualizado')
    expect(status.tooltip).toContain('v1.9.1')
  })
})
