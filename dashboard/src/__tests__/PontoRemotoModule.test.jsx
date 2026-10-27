import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PontoRemotoModule } from '../components/PontoRemotoModule'

vi.mock('../api', () => ({
  api: {
    pontoRemoto: {
      listEmployees:     vi.fn(),
      createEmployee:    vi.fn(),
      setEmployeeActive: vi.fn(),
      listEntries:       vi.fn(),
      correctEntry:      vi.fn(),
    },
  },
}))

import { api } from '../api'

function makeEmployee(overrides = {}) {
  return { id: 1, cpf: '11122233344', name: 'Fulano', store: 'Gávea', active: 1, ...overrides }
}

function makeEntry(overrides = {}) {
  return {
    id: 10, employee_id: 1, type: 'in', server_ts: '2026-10-27T13:00:00.000Z',
    within_geofence: null, corrects_id: null, created_by: 'employee', ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.pontoRemoto.listEmployees.mockResolvedValue({ employees: [] })
  api.pontoRemoto.listEntries.mockResolvedValue({ entries: [] })
})

describe('PontoRemotoModule — aba Funcionários', () => {
  it('lista funcionários carregados', async () => {
    api.pontoRemoto.listEmployees.mockResolvedValue({ employees: [makeEmployee()] })
    render(<PontoRemotoModule onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Fulano')).toBeInTheDocument())
  })

  it('cadastro sem campos obrigatórios não chama createEmployee', async () => {
    render(<PontoRemotoModule onClose={() => {}} />)
    await waitFor(() => expect(api.pontoRemoto.listEmployees).toHaveBeenCalled())

    await act(async () => { fireEvent.click(screen.getByText('Cadastrar')) })
    expect(api.pontoRemoto.createEmployee).not.toHaveBeenCalled()
  })

  it('cadastro válido chama createEmployee e recarrega a lista', async () => {
    api.pontoRemoto.createEmployee.mockResolvedValue({ ok: true, employee: makeEmployee({ id: 2 }) })
    render(<PontoRemotoModule onClose={() => {}} />)
    await waitFor(() => expect(api.pontoRemoto.listEmployees).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText('CPF'), { target: { value: '11122233344' } })
    fireEvent.change(screen.getByPlaceholderText('Nome'), { target: { value: 'Fulano' } })
    fireEvent.change(screen.getByPlaceholderText('Senha inicial'), { target: { value: 'senha123' } })

    await act(async () => { fireEvent.click(screen.getByText('Cadastrar')) })

    expect(api.pontoRemoto.createEmployee).toHaveBeenCalledWith(
      expect.objectContaining({ cpf: '11122233344', name: 'Fulano', senha: 'senha123' })
    )
    expect(api.pontoRemoto.listEmployees).toHaveBeenCalledTimes(2)
  })

  it('toggle de ativo chama setEmployeeActive com o valor invertido e desabilita durante a chamada', async () => {
    api.pontoRemoto.listEmployees.mockResolvedValue({ employees: [makeEmployee({ active: 1 })] })
    let resolveToggle
    api.pontoRemoto.setEmployeeActive.mockReturnValue(new Promise((r) => { resolveToggle = r }))

    render(<PontoRemotoModule onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Fulano')).toBeInTheDocument())

    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
    expect(api.pontoRemoto.setEmployeeActive).toHaveBeenCalledWith(1, false)
    expect(checkbox).toBeDisabled()

    await act(async () => { resolveToggle({ ok: true }) })
    expect(checkbox).not.toBeDisabled()
  })
})

describe('PontoRemotoModule — aba Espelho de Ponto', () => {
  it('lista registros do funcionário', async () => {
    api.pontoRemoto.listEmployees.mockResolvedValue({ employees: [makeEmployee()] })
    api.pontoRemoto.listEntries.mockResolvedValue({ entries: [makeEntry()] })

    render(<PontoRemotoModule onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Fulano')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Espelho de Ponto'))

    await waitFor(() => expect(api.pontoRemoto.listEntries).toHaveBeenCalled())
    expect(await screen.findAllByText('Fulano')).not.toHaveLength(0)
  })

  it('correção sem tocar no horário preserva o instante UTC original (regressão do bug de fuso)', async () => {
    const entry = makeEntry()
    api.pontoRemoto.listEmployees.mockResolvedValue({ employees: [makeEmployee()] })
    api.pontoRemoto.listEntries.mockResolvedValue({ entries: [entry] })
    api.pontoRemoto.correctEntry.mockResolvedValue({ ok: true, entry: {} })

    const { container } = render(<PontoRemotoModule onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('Fulano')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Espelho de Ponto'))
    await waitFor(() => expect(api.pontoRemoto.listEntries).toHaveBeenCalled())

    await act(async () => { fireEvent.click(screen.getByText('Corrigir')) })

    const timeInput = container.querySelector('input[type="datetime-local"]')
    // O valor mostrado no input (horário LOCAL do browser) tem que representar
    // o MESMO instante que entry.server_ts (UTC) — essa era a parte que
    // o bug corrompia silenciosamente.
    expect(new Date(timeInput.value).getTime()).toBe(new Date(entry.server_ts).getTime())

    fireEvent.change(screen.getByPlaceholderText('Motivo'), { target: { value: 'esqueceu de bater' } })
    await act(async () => { fireEvent.click(screen.getByText('Salvar')) })

    const [[, payload]] = api.pontoRemoto.correctEntry.mock.calls
    expect(new Date(payload.timestamp).getTime()).toBe(new Date(entry.server_ts).getTime())
  })
})
