// dashboard/electron/sensitiveDirGuard.js
'use strict'

// path.win32 explícito (não o `path` genérico) — este app só roda em
// Windows em produção (Electron desktop, máquinas de loja), mas a CI
// (Vitest) roda em runner Linux. path.resolve/path.sep genéricos viram
// POSIX nesse runner (backslash deixa de ser separador, "C:\..." vira só
// mais um segmento relativo ao cwd) — o teste passava local (Windows) e
// falhava só na CI, 4 dos 6 testes, porque o cwd do runner se infiltrava
// na comparação. win32 fixo garante o MESMO comportamento em qualquer SO
// que rodar o teste, já que a função sempre modela um caminho Windows.
const path = require('path').win32

// isInsideSensitiveDir é a parte PURA (testável sem Electron real) do
// bloqueio de leitura de diretórios sensíveis do app em file:read
// (main.js) — recebe os diretórios sensíveis já resolvidos (chamador
// monta a lista com app.getAppPath()/process.resourcesPath/__dirname/
// app.getPath('userData')), nunca chama API do Electron diretamente.
//
// Comparação case-INSENSITIVE: Windows/NTFS trata caminhos sem diferença
// de maiúscula/minúscula, mas string comparison normal (startsWith/===)
// é case-sensitive — sem lowercase dos dois lados, mudar a capitalização
// de um caminho já bloqueado bypassa o bloqueio (achado real de code
// review, confirmado por execução direta).
function isInsideSensitiveDir(resolvedPath, sensitiveDirs) {
  const target = resolvedPath.toLowerCase()
  return sensitiveDirs.some((dir) => {
    const normalizedDir = path.resolve(dir).toLowerCase()
    return target === normalizedDir || target.startsWith(normalizedDir + path.sep.toLowerCase())
  })
}

module.exports = { isInsideSensitiveDir }
