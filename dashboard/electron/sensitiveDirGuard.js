// dashboard/electron/sensitiveDirGuard.js
'use strict'

const path = require('path')

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
