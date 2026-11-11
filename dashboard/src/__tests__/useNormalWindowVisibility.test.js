import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useNormalWindowVisibility } from '../hooks/useNormalWindowVisibility'

describe('useNormalWindowVisibility', () => {
  let originalElectronAPI

  beforeEach(() => {
    originalElectronAPI = window.electronAPI
  })

  afterEach(() => {
    window.electronAPI = originalElectronAPI
  })

  it('comeca em 0 (default seguro) antes de qualquer pull/push resolver', () => {
    let pushCb
    window.electronAPI = {
      onNormalWindowVisibilityChange: vi.fn((cb) => { pushCb = cb; return () => {} }),
      getNormalWindowVisibility: vi.fn(() => new Promise(() => {})), // nunca resolve neste teste
    }
    const { result } = renderHook(() => useNormalWindowVisibility())
    expect(result.current.current).toBe(0)
  })

  it('aplica o valor do pull quando ele resolve antes de qualquer push chegar', async () => {
    window.electronAPI = {
      onNormalWindowVisibilityChange: vi.fn(() => () => {}),
      getNormalWindowVisibility: vi.fn().mockResolvedValue({ visibleNormalCount: 1 }),
    }
    const { result } = renderHook(() => useNormalWindowVisibility())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(result.current.current).toBe(1)
  })

  it('aplica o valor do push assim que ele chega', () => {
    let pushCb
    window.electronAPI = {
      onNormalWindowVisibilityChange: vi.fn((cb) => { pushCb = cb; return () => {} }),
      getNormalWindowVisibility: vi.fn(() => new Promise(() => {})),
    }
    const { result } = renderHook(() => useNormalWindowVisibility())
    act(() => { pushCb({ visibleNormalCount: 2 }) })
    expect(result.current.current).toBe(2)
  })

  it('descarta o pull atrasado se um push ja chegou antes dele resolver', async () => {
    let pushCb
    let resolvePull
    window.electronAPI = {
      onNormalWindowVisibilityChange: vi.fn((cb) => { pushCb = cb; return () => {} }),
      getNormalWindowVisibility: vi.fn(() => new Promise((resolve) => { resolvePull = resolve })),
    }
    const { result } = renderHook(() => useNormalWindowVisibility())

    // push chega primeiro, com o valor "fresco"
    act(() => { pushCb({ visibleNormalCount: 1 }) })
    expect(result.current.current).toBe(1)

    // pull resolve DEPOIS, com um valor diferente/desatualizado -- deve ser ignorado
    await act(async () => {
      resolvePull({ visibleNormalCount: 99 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.current).toBe(1) // continua 1, NAO virou 99
  })

  it('desinscreve do push ao desmontar', () => {
    const unsubscribe = vi.fn()
    window.electronAPI = {
      onNormalWindowVisibilityChange: vi.fn(() => unsubscribe),
      getNormalWindowVisibility: vi.fn(() => new Promise(() => {})),
    }
    const { unmount } = renderHook(() => useNormalWindowVisibility())
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
