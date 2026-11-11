import { useEffect, useRef } from 'react'

// useNormalWindowVisibility expõe, via ref (lido dentro de handlers de
// teclado — não precisa re-renderizar o componente a cada mudança),
// quantas janelas de sessão ao vivo em modo Normal estão visíveis AGORA.
// Combina pull-no-mount (getNormalWindowVisibility, cobre o instante entre
// a janela montar e o 1º push chegar) com push contínuo
// (onNormalWindowVisibilityChange) — não há garantia de ordem entre eles
// (Electron não ordena um invoke em trânsito contra um send concorrente),
// então: subscreve o push ANTES de disparar o pull, e descarta o
// resultado do pull se um push já chegou antes dele resolver (o push é
// sempre mais atual que um pull que ainda não voltou).
export function useNormalWindowVisibility() {
  const countRef = useRef(0) // 0 = nenhum dado ainda — default seguro

  useEffect(() => {
    let hasReceivedPush = false

    const unsubscribe = window.electronAPI?.onNormalWindowVisibilityChange((data) => {
      hasReceivedPush = true
      countRef.current = data.visibleNormalCount
    })

    window.electronAPI?.getNormalWindowVisibility().then((data) => {
      if (!hasReceivedPush) {
        countRef.current = data.visibleNormalCount
      }
    })

    return unsubscribe
  }, [])

  return countRef
}
