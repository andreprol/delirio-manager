import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AlertsPanel } from '../components/AlertsPanel'

const STORAGE_KEY = 'dt_alerts'

function makeAlert(overrides = {}) {
  return {
    id: Date.now(),
    machineId: 'mach-01',
    displayName: 'PC BOH',
    location: 'Cidade',
    read: false,
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('AlertsPanel — estado vazio', () => {
  it('exibe mensagem quando não há alertas', () => {
    render(<AlertsPanel newOfflineAlert={null} onClose={() => {}} />)
    expect(screen.getByText(/nenhum alerta/i)).toBeInTheDocument()
  })

  it('não exibe badge de não-lidos quando lista vazia', () => {
    render(<AlertsPanel newOfflineAlert={null} onClose={() => {}} />)
    expect(screen.queryByText(/\d+/)).not.toBeInTheDocument()
  })
})

describe('AlertsPanel — carregamento do localStorage', () => {
  it('exibe alertas persistidos no localStorage', () => {
    const alerts = [makeAlert({ displayName: 'PC-BOH', location: 'Cidade', id: 1000, read: false })]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts))

    render(<AlertsPanel newOfflineAlert={null} onClose={() => {}} />)

    expect(screen.getByText('PC-BOH')).toBeInTheDocument()
    expect(screen.getByText('Cidade')).toBeInTheDocument()
  })

  it('exibe badge com contagem de não-lidos', () => {
    const alerts = [
      makeAlert({ id: 1001, read: false }),
      makeAlert({ id: 1002, read: false }),
      makeAlert({ id: 1003, read: true }),
    ]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts))

    render(<AlertsPanel newOfflineAlert={null} onClose={() => {}} />)

    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('não exibe badge quando todos os alertas já são lidos', () => {
    const alerts = [makeAlert({ id: 2001, read: true })]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts))

    render(<AlertsPanel newOfflineAlert={null} onClose={() => {}} />)

    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })
})

describe('AlertsPanel — novo alerta via prop', () => {
  it('adiciona alerta no topo da lista quando prop newOfflineAlert muda', () => {
    const alert = makeAlert({ displayName: 'PC-NOVO', location: 'Loja Nova', id: 3001 })

    const { rerender } = render(<AlertsPanel newOfflineAlert={null} onClose={() => {}} />)
    expect(screen.queryByText('PC-NOVO')).not.toBeInTheDocument()

    rerender(<AlertsPanel newOfflineAlert={alert} onClose={() => {}} />)
    expect(screen.getByText('PC-NOVO')).toBeInTheDocument()
  })

  it('incrementa badge de não-lidos ao receber novo alerta', () => {
    const alert = makeAlert({ id: 4001 })

    const { rerender } = render(<AlertsPanel newOfflineAlert={null} onClose={() => {}} />)
    rerender(<AlertsPanel newOfflineAlert={alert} onClose={() => {}} />)

    expect(screen.getByText('1')).toBeInTheDocument()
  })
})

describe('AlertsPanel — interações', () => {
  it('"Marcar todos lidos" remove badge e some botão', () => {
    const alerts = [makeAlert({ id: 5001, read: false })]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts))

    render(<AlertsPanel newOfflineAlert={null} onClose={() => {}} />)

    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByText(/marcar todos lidos/i))
    expect(screen.queryByText('1')).not.toBeInTheDocument()
    expect(screen.queryByText(/marcar todos lidos/i)).not.toBeInTheDocument()
  })

  it('botão ✕ chama onClose', () => {
    const onClose = vi.fn()
    render(<AlertsPanel newOfflineAlert={null} onClose={onClose} />)
    fireEvent.click(screen.getByText('✕'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
