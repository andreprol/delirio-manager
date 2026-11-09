import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AlohaDANFESearch } from '../components/AlohaDANFESearch'

/**
 * Bug real (09/11/2026): o botão "Baixar PDF" não fazia nada visível dentro
 * do dashboard Electron — fetch+blob+<a href="blob:...">.click() não dispara
 * o will-download do Electron de forma confiável. O caminho certo é
 * window.electronAPI.downloadFile (mesmo padrão já usado pelo relatório BIOS
 * em App.jsx), que passa pelo main process via webContents.downloadURL.
 */

vi.mock('../api', () => ({
  getServerUrl: () => 'https://dt-manager.test',
  api: {
    aloha: {
      indexStatus: vi.fn().mockResolvedValue({
        totalDays: 0, pendingDays: 0, processedDays: 0, totalRecords: 0, months: [],
      }),
    },
    nfce: {
      search:        vi.fn(),
      downloadDanfe: vi.fn(),
      sendEmail:     vi.fn(),
    },
  },
}))

import { api } from '../api'

const bohMachines = [{ id: 'm1', hostname: 'ASSBOH', location: 'Assembléia' }]
const sampleResult = {
  chave: 'abc123', n_nf: 166179, dh_emi: '2026-11-09T14:58:00', v_nf: 55.5,
  products_text: 'SOPA TOMATE MIN | SAND NAT PASTAS | SUCO LARJ CEN G',
}

beforeEach(() => {
  vi.clearAllMocks()
  api.nfce.search.mockResolvedValue({ total: 1, results: [sampleResult] })
  delete window.electronAPI
})

async function renderAndSearch() {
  render(<AlohaDANFESearch bohMachines={bohMachines} />)
  fireEvent.click(await screen.findByRole('button', { name: /buscar/i }))
  await screen.findByText(/166179/)
}

describe('AlohaDANFESearch — download de PDF no Electron', () => {
  it('chama window.electronAPI.downloadFile com a URL certa, nunca o fallback fetch+blob', async () => {
    const downloadFile = vi.fn()
    window.electronAPI = { downloadFile, onDownloadDone: vi.fn(() => () => {}) }

    await renderAndSearch()
    fireEvent.click(screen.getByTitle('Baixar DANFE em PDF'))

    expect(downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('/api/aloha/nfce/abc123/danfe?machineId=m1')
    )
    expect(api.nfce.downloadDanfe).not.toHaveBeenCalled()
  })

  it('mostra "✓ Salvo" com o caminho quando download-done chega com state completed', async () => {
    let doneCallback
    window.electronAPI = {
      downloadFile: vi.fn(),
      onDownloadDone: vi.fn((cb) => { doneCallback = cb; return () => {} }),
    }

    await renderAndSearch()
    fireEvent.click(screen.getByTitle('Baixar DANFE em PDF'))
    doneCallback({ state: 'completed', filename: 'DANFE-166179.pdf', savePath: 'C:\\Downloads\\DANFE-166179.pdf' })

    const savedBtn = await screen.findByText('✓ Salvo')
    expect(savedBtn).not.toBeDisabled()
    expect(savedBtn.title).toContain('C:\\Downloads\\DANFE-166179.pdf')
  })

  it('clicar em "✓ Salvo" abre a pasta em vez de baixar de novo', async () => {
    let doneCallback
    const showInFolder = vi.fn()
    window.electronAPI = {
      downloadFile: vi.fn(),
      onDownloadDone: vi.fn((cb) => { doneCallback = cb; return () => {} }),
      showInFolder,
    }

    await renderAndSearch()
    fireEvent.click(screen.getByTitle('Baixar DANFE em PDF'))
    doneCallback({ state: 'completed', filename: 'DANFE-166179.pdf', savePath: 'C:\\Downloads\\DANFE-166179.pdf' })
    const savedBtn = await screen.findByText('✓ Salvo')

    window.electronAPI.downloadFile.mockClear()
    fireEvent.click(savedBtn)

    expect(showInFolder).toHaveBeenCalledWith('C:\\Downloads\\DANFE-166179.pdf')
    expect(window.electronAPI.downloadFile).not.toHaveBeenCalled()
  })

  it('mostra alerta quando download-done chega com erro', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    let doneCallback
    window.electronAPI = {
      downloadFile: vi.fn(),
      onDownloadDone: vi.fn((cb) => { doneCallback = cb; return () => {} }),
    }

    await renderAndSearch()
    fireEvent.click(screen.getByTitle('Baixar DANFE em PDF'))
    doneCallback({ state: 'interrupted', filename: 'DANFE-166179.pdf' })

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Erro ao gerar DANFE (status: interrupted)'))
    alertSpy.mockRestore()
  })

  it('ignora eventos download-done de outro arquivo', async () => {
    let doneCallback
    window.electronAPI = {
      downloadFile: vi.fn(),
      onDownloadDone: vi.fn((cb) => { doneCallback = cb; return () => {} }),
    }

    await renderAndSearch()
    fireEvent.click(screen.getByTitle('Baixar DANFE em PDF'))
    doneCallback({ state: 'completed', filename: 'relatorio-bios-2026-01-01.pdf' })

    expect(screen.getByTitle('Baixar DANFE em PDF')).toBeDisabled()
  })

  it('alerta quando a chamada a downloadFile rejeita (erro no main process)', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    window.electronAPI = {
      downloadFile:   vi.fn().mockRejectedValue(new Error('falha simulada')),
      onDownloadDone: vi.fn(() => () => {}),
    }

    await renderAndSearch()
    fireEvent.click(screen.getByTitle('Baixar DANFE em PDF'))

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Erro ao iniciar download: falha simulada'))
    expect(screen.getByTitle('Baixar DANFE em PDF')).not.toBeDisabled()
    alertSpy.mockRestore()
  })

  it('sem window.electronAPI (navegador puro), usa o fallback fetch+blob', async () => {
    api.nfce.downloadDanfe.mockResolvedValue(new Blob(['%PDF-test']))
    await renderAndSearch()
    fireEvent.click(screen.getByTitle('Baixar DANFE em PDF'))

    await waitFor(() => expect(api.nfce.downloadDanfe).toHaveBeenCalledWith('m1', 'abc123', 166179))
  })
})
