import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GenerateModal } from '../components/report/GenerateModal'

vi.mock('../api', () => ({
  getServerUrl: () => 'https://dt-manager.test',
  api: {
    relatorio: {
      generate:     vi.fn(),
      saveFeedback: vi.fn(),
    },
  },
}))

import { api } from '../api'

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Renderização inicial ───────────────────────────────────────────────────────

describe('GenerateModal — renderização inicial', () => {
  it('exibe nome da loja no título', () => {
    render(<GenerateModal storeName="Cidade" onClose={() => {}} onGenerated={() => {}} />)
    expect(screen.getByText(/cidade/i)).toBeInTheDocument()
  })

  it('campo de mês tem valor padrão (mês atual)', () => {
    const now = new Date()
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    render(<GenerateModal storeName="Loja" onClose={() => {}} onGenerated={() => {}} />)
    expect(screen.getByDisplayValue(expected)).toBeInTheDocument()
  })

  it('botão Gerar Relatório está presente e habilitado', () => {
    render(<GenerateModal storeName="Loja" onClose={() => {}} onGenerated={() => {}} />)
    expect(screen.getByRole('button', { name: /gerar relatório/i })).not.toBeDisabled()
  })

  it('botão Cancelar chama onClose', () => {
    const onClose = vi.fn()
    render(<GenerateModal storeName="Loja" onClose={onClose} onGenerated={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ── Geração de relatório ───────────────────────────────────────────────────────

describe('GenerateModal — geração', () => {
  it('exibe estado de loading durante geração', async () => {
    api.relatorio.generate.mockReturnValue(new Promise(() => {})) // nunca resolve
    render(<GenerateModal storeName="Loja" onClose={() => {}} onGenerated={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }))
    expect(await screen.findByText(/aguarde/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /aguarde/i })).toBeDisabled()
  })

  it('exibe resultado com score ao concluir', async () => {
    api.relatorio.generate.mockResolvedValue({
      score: 72,
      docxUrl: '/downloads/relatorios/rel.docx',
      pdfUrl:  '/downloads/relatorios/rel.pdf',
      runId:   'run-abc',
    })
    render(<GenerateModal storeName="Loja" onClose={() => {}} onGenerated={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }))
    expect(await screen.findByText(/score: 72\/100/i)).toBeInTheDocument()
    expect(screen.getByText(/relatório gerado/i)).toBeInTheDocument()
  })

  it('chama onGenerated com resultado ao concluir', async () => {
    const result = { score: 85, docxUrl: '/rel.docx', pdfUrl: null, runId: 'r1' }
    const onGenerated = vi.fn()
    api.relatorio.generate.mockResolvedValue(result)

    render(<GenerateModal storeName="Loja" onClose={() => {}} onGenerated={onGenerated} />)
    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }))
    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith(result))
  })

  it('exibe botão Word quando docxUrl disponível', async () => {
    api.relatorio.generate.mockResolvedValue({
      score: 70,
      docxUrl: '/rel.docx',
      pdfUrl:  null,
      runId:   'r2',
    })
    render(<GenerateModal storeName="Loja" onClose={() => {}} onGenerated={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }))
    expect(await screen.findByText(/word/i)).toBeInTheDocument()
  })

  it('não exibe botão PDF quando pdfUrl é null', async () => {
    api.relatorio.generate.mockResolvedValue({
      score: 70,
      docxUrl: '/rel.docx',
      pdfUrl:  null,
      runId:   'r3',
    })
    render(<GenerateModal storeName="Loja" onClose={() => {}} onGenerated={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }))
    await screen.findByText(/word/i) // espera resultado carregar
    expect(screen.queryByText(/pdf/i)).not.toBeInTheDocument()
  })
})

// ── Erro ──────────────────────────────────────────────────────────────────────

describe('GenerateModal — erro na geração', () => {
  it('exibe mensagem de erro quando api falha', async () => {
    api.relatorio.generate.mockRejectedValue(new Error('Timeout do servidor'))

    render(<GenerateModal storeName="Loja" onClose={() => {}} onGenerated={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }))

    expect(await screen.findByText(/timeout do servidor/i)).toBeInTheDocument()
  })

  it('reabilita botão após erro para permitir nova tentativa', async () => {
    api.relatorio.generate.mockRejectedValue(new Error('Erro'))

    render(<GenerateModal storeName="Loja" onClose={() => {}} onGenerated={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }))

    await screen.findByText(/erro/i)
    expect(screen.getByRole('button', { name: /gerar relatório/i })).not.toBeDisabled()
  })
})

// ── Feedback ──────────────────────────────────────────────────────────────────

describe('GenerateModal — feedback', () => {
  async function renderWithResult() {
    api.relatorio.generate.mockResolvedValue({
      score: 65, docxUrl: '/rel.docx', pdfUrl: null, runId: 'r4',
    })
    api.relatorio.saveFeedback.mockResolvedValue({})

    render(<GenerateModal storeName="Loja" onClose={() => {}} onGenerated={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /gerar relatório/i }))
    await screen.findByText(/score/i)
  }

  it('textarea de feedback está disponível após resultado', async () => {
    await renderWithResult()
    expect(screen.getByPlaceholderText(/score muito alto/i)).toBeInTheDocument()
  })

  it('botão Salvar Feedback desabilitado quando textarea vazia', async () => {
    await renderWithResult()
    expect(screen.getByRole('button', { name: /salvar feedback/i })).toBeDisabled()
  })

  it('salva feedback e exibe confirmação', async () => {
    await renderWithResult()

    fireEvent.change(screen.getByPlaceholderText(/score/i), {
      target: { value: 'Score muito alto, impressora não é crítica' },
    })
    fireEvent.click(screen.getByRole('button', { name: /salvar feedback/i }))

    expect(await screen.findByText(/feedback salvo/i)).toBeInTheDocument()
    expect(api.relatorio.saveFeedback).toHaveBeenCalledWith(
      'Loja',
      expect.any(String),
      'Score muito alto, impressora não é crítica',
      'r4'
    )
  })
})
