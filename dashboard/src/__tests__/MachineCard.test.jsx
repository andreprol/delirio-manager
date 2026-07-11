import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MachineCard } from '../components/MachineCard'

// Mocks dos sub-componentes que fazem chamadas de rede
vi.mock('../components/EventsTab', () => ({
  EventsTab: () => <div data-testid="events-tab">EventsTab</div>,
}))
vi.mock('../components/InsightsTab', () => ({
  InsightsTab: () => <div data-testid="insights-tab">InsightsTab</div>,
}))
vi.mock('../api', () => ({
  api: {
    dr: { setup: vi.fn(), backupNow: vi.fn() },
  },
}))

function makeMachine(overrides = {}) {
  return {
    id: 'mach-test',
    hostname: 'PC-BOH',
    displayName: null,
    status: 'online',
    location: 'Cidade',
    ipInterno: '192.168.1.10',
    mac: 'AA:BB:CC:DD:EE:FF',
    agentVersion: '1.5.18',
    lastSeen: new Date().toISOString(),
    onlineSince: null,
    lastMetrics: { cpuPct: 40, ramFreeMB: 4096, ramTotalMB: 8192, diskFreeGB: 50, diskTotalGB: 100, uptimeH: 5 },
    wolStatus: 'unknown',
    wolEverConfirmed: false,
    dr_setup: 'not_installed',
    critica: false,
    pendingCommand: false,
    winEventsUnread: 0,
    ...overrides,
  }
}

const noop = () => {}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Renderização básica ───────────────────────────────────────────────────────

describe('MachineCard — renderização básica', () => {
  it('exibe displayName quando disponível', () => {
    render(<MachineCard machine={makeMachine({ displayName: 'BOH Principal' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expect(screen.getByText('BOH Principal')).toBeInTheDocument()
  })

  it('usa hostname como fallback quando displayName é null', () => {
    render(<MachineCard machine={makeMachine({ displayName: null })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expect(screen.getByText('PC-BOH')).toBeInTheDocument()
  })

  it('exibe "Online" para status online', () => {
    render(<MachineCard machine={makeMachine({ status: 'online' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expect(screen.getByText('Online')).toBeInTheDocument()
  })

  it('exibe "Offline" para status offline', () => {
    render(<MachineCard machine={makeMachine({ status: 'offline' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expect(screen.getByText('Offline')).toBeInTheDocument()
  })

  it('exibe badge CRIT para máquina crítica', () => {
    render(<MachineCard machine={makeMachine({ critica: true })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expect(screen.getByText('CRIT')).toBeInTheDocument()
  })

  it('não exibe badge CRIT para máquina não-crítica', () => {
    render(<MachineCard machine={makeMachine({ critica: false })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expect(screen.queryByText('CRIT')).not.toBeInTheDocument()
  })

  it('exibe badge WoL ✓ para status wol_confirmed', () => {
    render(<MachineCard machine={makeMachine({ wolStatus: 'wol_confirmed' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expect(screen.getByText('WoL ✓')).toBeInTheDocument()
  })

  it('exibe badge WoL ✗ para status driver_disabled', () => {
    render(<MachineCard machine={makeMachine({ wolStatus: 'driver_disabled' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expect(screen.getByText('WoL ✗')).toBeInTheDocument()
  })

  it('não exibe badge WoL para status unknown', () => {
    render(<MachineCard machine={makeMachine({ wolStatus: 'unknown' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expect(screen.queryByText(/WoL/)).not.toBeInTheDocument()
  })

  it('exibe badge DR ✓ para dr_setup configured', () => {
    render(<MachineCard machine={makeMachine({ dr_setup: 'configured' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expect(screen.getByText('DR ✓')).toBeInTheDocument()
  })
})

// ── Expand / collapse ────────────────────────────────────────────────────────

describe('MachineCard — expand / collapse', () => {
  it('painel expandido está oculto inicialmente', () => {
    render(<MachineCard machine={makeMachine()}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expect(screen.queryByText('Métricas')).not.toBeInTheDocument()
  })

  it('expande ao clicar no card', () => {
    const { container } = render(<MachineCard machine={makeMachine()}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    fireEvent.click(container.querySelector('.mc'))
    expect(screen.getByText('Métricas')).toBeInTheDocument()
  })

  it('colapsa ao clicar novamente', () => {
    const { container } = render(<MachineCard machine={makeMachine()}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    const card = container.querySelector('.mc')
    fireEvent.click(card)
    expect(screen.getByText('Métricas')).toBeInTheDocument()
    fireEvent.click(card)
    expect(screen.queryByText('Métricas')).not.toBeInTheDocument()
  })
})

// ── Botões de ação ────────────────────────────────────────────────────────────

describe('MachineCard — botões de ação (tab Métricas)', () => {
  function expandCard(container) {
    fireEvent.click(container.querySelector('.mc'))
  }

  it('botão Ligar desabilitado quando máquina online', () => {
    const { container } = render(<MachineCard machine={makeMachine({ status: 'online' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    expect(screen.getByRole('button', { name: 'Ligar' })).toBeDisabled()
  })

  it('botão Ligar habilitado quando máquina offline', () => {
    const { container } = render(<MachineCard machine={makeMachine({ status: 'offline' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    expect(screen.getByRole('button', { name: 'Ligar' })).not.toBeDisabled()
  })

  it('botões Reiniciar/Desligar desabilitados quando offline', () => {
    const { container } = render(<MachineCard machine={makeMachine({ status: 'offline' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    expect(screen.getByRole('button', { name: /reiniciar/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /desligar/i })).toBeDisabled()
  })

  it('botões Reiniciar/Desligar habilitados quando online', () => {
    const { container } = render(<MachineCard machine={makeMachine({ status: 'online' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    expect(screen.getByRole('button', { name: /reiniciar/i })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /desligar/i })).not.toBeDisabled()
  })

  it('clique em Reiniciar chama onCommand(machineId, "reboot")', async () => {
    const onCommand = vi.fn().mockResolvedValue(undefined)
    const { container } = render(<MachineCard machine={makeMachine({ status: 'online', critica: false })}
      onCommand={onCommand} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    fireEvent.click(screen.getByRole('button', { name: /reiniciar/i }))
    expect(onCommand).toHaveBeenCalledWith('mach-test', 'reboot', {}, undefined)
  })

  it('clique em Ligar chama onWol(machineId)', async () => {
    const onWol = vi.fn().mockResolvedValue(undefined)
    const { container } = render(<MachineCard machine={makeMachine({ status: 'offline' })}
      onCommand={noop} onWol={onWol} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    fireEvent.click(screen.getByRole('button', { name: 'Ligar' }))
    expect(onWol).toHaveBeenCalledWith('mach-test')
  })
})

// ── Caixa de confirmação — uninstall ─────────────────────────────────────────

describe('MachineCard — confirmação de uninstall', () => {
  function expandCard(container) {
    fireEvent.click(container.querySelector('.mc'))
  }

  it('abre caixa de confirmação ao clicar em Desinstalar', () => {
    const { container } = render(<MachineCard machine={makeMachine({ status: 'online', displayName: 'BOH-01' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    fireEvent.click(screen.getByRole('button', { name: /desinstalar/i }))
    expect(screen.getByText(/permanentemente/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeInTheDocument()
  })

  it('botão Confirmar desabilitado enquanto texto não bate com displayName', () => {
    const { container } = render(<MachineCard machine={makeMachine({ status: 'online', displayName: 'BOH-01' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    fireEvent.click(screen.getByRole('button', { name: /desinstalar/i }))

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'texto-errado' } })
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeDisabled()
  })

  it('botão Confirmar habilitado ao digitar displayName correto', () => {
    const { container } = render(<MachineCard machine={makeMachine({ status: 'online', displayName: 'BOH-01' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    fireEvent.click(screen.getByRole('button', { name: /desinstalar/i }))

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'BOH-01' } })
    expect(screen.getByRole('button', { name: /confirmar/i })).not.toBeDisabled()
  })

  it('botão Cancelar fecha caixa de confirmação', () => {
    const { container } = render(<MachineCard machine={makeMachine({ status: 'online' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    fireEvent.click(screen.getByRole('button', { name: /desinstalar/i }))
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }))
    expect(screen.queryByRole('button', { name: /confirmar/i })).not.toBeInTheDocument()
  })
})

// ── Métricas renderizadas ─────────────────────────────────────────────────────

describe('MachineCard — métricas (tab expandida)', () => {
  function expandCard(container) {
    fireEvent.click(container.querySelector('.mc'))
  }

  it('exibe IP e MAC da máquina', () => {
    const { container } = render(<MachineCard
      machine={makeMachine({ ipInterno: '192.168.1.55', mac: 'AA:BB:CC:DD:EE:FF' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    expect(screen.getByText('192.168.1.55')).toBeInTheDocument()
    expect(screen.getByText('AA:BB:CC:DD:EE:FF')).toBeInTheDocument()
  })

  it('exibe versão do agente', () => {
    const { container } = render(<MachineCard machine={makeMachine({ agentVersion: '1.5.18' })}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    expect(screen.getByText('v1.5.18')).toBeInTheDocument()
  })

  it('exibe barras de CPU, RAM e Disco', () => {
    const { container } = render(<MachineCard machine={makeMachine()}
      onCommand={noop} onWol={noop} onMoveToGroup={noop} onDeleteMachine={noop} />)
    expandCard(container)
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('RAM')).toBeInTheDocument()
    expect(screen.getByText('Disco')).toBeInTheDocument()
  })
})
