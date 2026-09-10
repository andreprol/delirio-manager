import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api', () => ({
  api: {
    rh: {
      getClockStatus: vi.fn(),
      markClockNew:   vi.fn(),
    },
  },
}))

import { api } from '../api'
import { ClockStatusGrid } from '../components/ClockStatusGrid'

const SAMPLE_STATUS = {
  total: 9,
  reachable: 9,
  timestamp: '2026-09-10T12:00:00.000Z',
  armed: [],
  clocks: [
    { ip: '192.168.14.151', reachable: true, responseTimeMs: 40 },
    { ip: '192.168.15.151', reachable: true, responseTimeMs: 55 },
    { ip: '192.168.12.151', reachable: true, responseTimeMs: 30 },
    { ip: '192.168.0.151',  reachable: true, responseTimeMs: 20 },
    { ip: '192.168.13.151', reachable: true, responseTimeMs: 25 },
    { ip: '192.168.18.151', reachable: true, responseTimeMs: 35 },
    { ip: '192.168.16.151', reachable: true, responseTimeMs: 45 },
    { ip: '192.168.20.151', reachable: true, responseTimeMs: 50 },
    { ip: '192.168.10.150', reachable: true, responseTimeMs: 60 },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  api.rh.getClockStatus.mockResolvedValue(SAMPLE_STATUS)
})

describe('ClockStatusGrid — botão "Marcar como relógio novo"', () => {
  it('exibe o botão em cada card de relógio após carregar', async () => {
    render(<ClockStatusGrid />)
    await waitFor(() => expect(screen.getAllByText(/marcar como relógio novo/i)).toHaveLength(9))
  })

  it('pede confirmação e chama api.rh.markClockNew com o IP correto', async () => {
    window.confirm = vi.fn(() => true)
    api.rh.markClockNew.mockResolvedValue({ ok: true, ip: '192.168.14.151' })

    render(<ClockStatusGrid />)
    await waitFor(() => screen.getAllByText(/marcar como relógio novo/i))

    fireEvent.click(screen.getAllByText(/marcar como relógio novo/i)[0])

    expect(window.confirm).toHaveBeenCalled()
    await waitFor(() => expect(api.rh.markClockNew).toHaveBeenCalledWith('192.168.14.151'))
  })

  it('não chama a API se o usuário cancelar a confirmação', async () => {
    window.confirm = vi.fn(() => false)

    render(<ClockStatusGrid />)
    await waitFor(() => screen.getAllByText(/marcar como relógio novo/i))

    fireEvent.click(screen.getAllByText(/marcar como relógio novo/i)[0])

    expect(window.confirm).toHaveBeenCalled()
    expect(api.rh.markClockNew).not.toHaveBeenCalled()
  })

  it('troca o botão por um badge "aguardando releitura" após marcar com sucesso', async () => {
    window.confirm = vi.fn(() => true)
    api.rh.markClockNew.mockResolvedValue({ ok: true, ip: '192.168.14.151' })

    render(<ClockStatusGrid />)
    await waitFor(() => screen.getAllByText(/marcar como relógio novo/i))

    fireEvent.click(screen.getAllByText(/marcar como relógio novo/i)[0])

    await waitFor(() => expect(screen.getByText(/aguardando releitura/i)).toBeInTheDocument())
    expect(screen.getAllByText(/marcar como relógio novo/i)).toHaveLength(8)
  })

  it('mostra erro se a chamada de marcar falhar, sem trocar pelo badge', async () => {
    window.confirm = vi.fn(() => true)
    api.rh.markClockNew.mockRejectedValue(new Error('clock-proxy indisponível'))

    render(<ClockStatusGrid />)
    await waitFor(() => screen.getAllByText(/marcar como relógio novo/i))

    fireEvent.click(screen.getAllByText(/marcar como relógio novo/i)[0])

    await waitFor(() => expect(screen.getByText(/clock-proxy indisponível/i)).toBeInTheDocument())
    expect(screen.queryByText(/aguardando releitura/i)).not.toBeInTheDocument()
  })

  it('não exibe o botão em cards placeholder (IP sem dado real retornado pela API)', async () => {
    api.rh.getClockStatus.mockResolvedValue({
      total: 9,
      reachable: 2,
      timestamp: '2026-09-10T12:00:00.000Z',
      armed: [],
      clocks: [
        { ip: '192.168.14.151', reachable: true, responseTimeMs: 40 },
        { ip: '192.168.15.151', reachable: true, responseTimeMs: 55 },
      ],
    })

    render(<ClockStatusGrid />)

    await waitFor(() => expect(screen.getAllByText(/marcar como relógio novo/i)).toHaveLength(2))
    expect(screen.getAllByText(/aguardando o relógio responder/i)).toHaveLength(7)
  })

  it('exibe o badge "aguardando releitura" já no carregamento inicial se o servidor reportar a flag armada', async () => {
    api.rh.getClockStatus.mockResolvedValue({
      ...SAMPLE_STATUS,
      armed: ['192.168.14.151'],
    })

    render(<ClockStatusGrid />)

    await waitFor(() => expect(screen.getByText(/aguardando releitura/i)).toBeInTheDocument())
    expect(api.rh.markClockNew).not.toHaveBeenCalled()
    expect(screen.getAllByText(/marcar como relógio novo/i)).toHaveLength(8)
  })

  it('desabilita o botão e mostra "Marcando…" enquanto a chamada está em voo', async () => {
    window.confirm = vi.fn(() => true)
    let resolvePromise
    api.rh.markClockNew.mockImplementation(() => new Promise(r => { resolvePromise = r }))

    render(<ClockStatusGrid />)
    await waitFor(() => screen.getAllByText(/marcar como relógio novo/i))

    fireEvent.click(screen.getAllByText(/marcar como relógio novo/i)[0])

    await waitFor(() => expect(screen.getByText(/marcando/i)).toBeInTheDocument())
    expect(screen.getByText(/marcando/i)).toBeDisabled()

    resolvePromise({ ok: true, ip: '192.168.14.151' })
    await waitFor(() => expect(screen.getByText(/aguardando releitura/i)).toBeInTheDocument())
  })
})
