// dashboard/electron/__tests__/sensitiveDirGuard.test.js
import { describe, it, expect } from 'vitest'
import { isInsideSensitiveDir } from '../sensitiveDirGuard'

const SENSITIVE_DIRS = [
  'C:\\Program Files\\DelirioManager\\resources\\app.asar',
  'C:\\Program Files\\DelirioManager\\resources',
  'C:\\Users\\Operador\\AppData\\Roaming\\delirio-manager-dashboard',
]

describe('isInsideSensitiveDir', () => {
  it('bloqueia um arquivo dentro do diretorio sensivel (exato)', () => {
    expect(isInsideSensitiveDir('C:\\Program Files\\DelirioManager\\resources\\app.asar', SENSITIVE_DIRS)).toBe(true)
  })

  it('bloqueia um arquivo dentro de subdiretorio sensivel', () => {
    expect(isInsideSensitiveDir('C:\\Program Files\\DelirioManager\\resources\\app.asar\\electron\\main.js', SENSITIVE_DIRS)).toBe(true)
  })

  it('NAO bloqueia diretorio irmao com nome parecido (sem false-positive de prefixo)', () => {
    expect(isInsideSensitiveDir('C:\\Program Files\\DelirioManager Backup\\algumacoisa.txt', SENSITIVE_DIRS)).toBe(false)
  })

  it('bloqueia o config.json em userData (onde o adminSecret mora de verdade)', () => {
    expect(isInsideSensitiveDir('C:\\Users\\Operador\\AppData\\Roaming\\delirio-manager-dashboard\\config.json', SENSITIVE_DIRS)).toBe(true)
  })

  it('bloqueia mesmo com capitalizacao diferente (NTFS e case-insensitive)', () => {
    expect(isInsideSensitiveDir('c:\\program files\\deliriomanager\\resources\\app.asar\\electron\\main.js', SENSITIVE_DIRS)).toBe(true)
  })

  it('permite um arquivo normal do usuario, fora de qualquer diretorio sensivel', () => {
    expect(isInsideSensitiveDir('C:\\Users\\Operador\\Downloads\\instalador.exe', SENSITIVE_DIRS)).toBe(false)
  })
})
