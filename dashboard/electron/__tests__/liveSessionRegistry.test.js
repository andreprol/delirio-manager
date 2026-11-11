import { describe, it, expect } from 'vitest'
import { countVisibleNormalWindows } from '../liveSessionRegistry'

describe('countVisibleNormalWindows', () => {
  it('conta 0 quando não há janelas', () => {
    expect(countVisibleNormalWindows([])).toBe(0)
  })

  it('conta 1 janela Normal visível', () => {
    expect(countVisibleNormalWindows([{ mode: 'normal', minimized: false, destroyed: false }])).toBe(1)
  })

  it('não conta janela minimizada', () => {
    expect(countVisibleNormalWindows([
      { mode: 'normal', minimized: true, destroyed: false },
      { mode: 'normal', minimized: false, destroyed: false },
    ])).toBe(1)
  })

  it('não conta janela Shadow', () => {
    expect(countVisibleNormalWindows([
      { mode: 'shadow', minimized: false, destroyed: false },
      { mode: 'normal', minimized: false, destroyed: false },
    ])).toBe(1)
  })

  it('não conta janela já destruída', () => {
    expect(countVisibleNormalWindows([
      { mode: 'normal', minimized: false, destroyed: true },
    ])).toBe(0)
  })

  it('conta 2 quando 2 janelas Normal estão visíveis ao mesmo tempo', () => {
    expect(countVisibleNormalWindows([
      { mode: 'normal', minimized: false, destroyed: false },
      { mode: 'normal', minimized: false, destroyed: false },
    ])).toBe(2)
  })
})
