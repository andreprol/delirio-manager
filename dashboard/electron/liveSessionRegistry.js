'use strict'

// Registro das janelas de sessão ao vivo abertas no processo principal.
// countVisibleNormalWindows é a parte PURA (testável sem Electron real) da
// regra 3 de André (11/11/2026): tecla Windows só funciona quando
// EXATAMENTE 1 janela em modo Normal está visivel (nao minimizada) ao
// mesmo tempo.
function countVisibleNormalWindows(windows) {
  return windows.filter((w) => w.mode === 'normal' && !w.minimized && !w.destroyed).length
}

module.exports = { countVisibleNormalWindows }
