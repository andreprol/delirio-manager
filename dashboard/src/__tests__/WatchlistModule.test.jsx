import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WatchlistModule } from '../components/WatchlistModule'

vi.mock('../api', () => ({
  api: {
    watchlist: {
      list:      vi.fn(),
      create:    vi.fn(),
      setActive: vi.fn(),
      remove:    vi.fn(),
    },
  },
}))

import { api } from '../api'

function makeKeyword(overrides = {}) {
  return { id: 1, keyword: 'vaga de emprego', active: true, created_at: '2026-10-20T10:00:00Z', ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.confirm = vi.fn(() => true)
})

describe('WatchlistModule', () => {
  it('lista as keywords carregadas', async () => {
    api.watchlist.list.mockResolvedValue([makeKeyword()])
    render(<WatchlistModule onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('vaga de emprego')).toBeInTheDocument())
  })

  it('adicionar keyword vazia não chama api.watchlist.create', async () => {
    api.watchlist.list.mockResolvedValue([])
    render(<WatchlistModule onClose={() => {}} />)
    await waitFor(() => expect(api.watchlist.list).toHaveBeenCalled())

    await act(async () => {
      fireEvent.click(screen.getByText('Adicionar'))
    })
    expect(api.watchlist.create).not.toHaveBeenCalled()
  })

  it('adicionar keyword válida chama create e mostra na lista', async () => {
    api.watchlist.list.mockResolvedValue([])
    api.watchlist.create.mockResolvedValue({ ok: true, id: 2, keyword: 'currículo' })
    render(<WatchlistModule onClose={() => {}} />)
    await waitFor(() => expect(api.watchlist.list).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText('Nova palavra-chave'), { target: { value: 'currículo' } })
    await act(async () => {
      fireEvent.click(screen.getByText('Adicionar'))
    })

    expect(api.watchlist.create).toHaveBeenCalledWith('currículo')
    expect(screen.getByText('currículo')).toBeInTheDocument()
  })

  it('toggle de ativo chama setActive com o valor invertido', async () => {
    api.watchlist.list.mockResolvedValue([makeKeyword({ active: true })])
    api.watchlist.setActive.mockResolvedValue({ ok: true })
    render(<WatchlistModule onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('vaga de emprego')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox'))
    })
    expect(api.watchlist.setActive).toHaveBeenCalledWith(1, false)
  })

  it('excluir pede confirmação antes de chamar remove', async () => {
    api.watchlist.list.mockResolvedValue([makeKeyword()])
    api.watchlist.remove.mockResolvedValue({ ok: true })
    render(<WatchlistModule onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('vaga de emprego')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByText('Excluir'))
    })

    expect(window.confirm).toHaveBeenCalled()
    expect(api.watchlist.remove).toHaveBeenCalledWith(1)
    expect(screen.queryByText('vaga de emprego')).not.toBeInTheDocument()
  })

  it('excluir cancelado não chama remove', async () => {
    window.confirm = vi.fn(() => false)
    api.watchlist.list.mockResolvedValue([makeKeyword()])
    render(<WatchlistModule onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('vaga de emprego')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(screen.getByText('Excluir'))
    })

    expect(api.watchlist.remove).not.toHaveBeenCalled()
    expect(screen.getByText('vaga de emprego')).toBeInTheDocument()
  })
})
