import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { FileBrowserModal } from '../components/FileBrowserModal'

function makeProps(overrides = {}) {
  return {
    localListing: { path: 'C:\\Users\\Andre\\Desktop', entries: [] },
    remoteListing: { path: 'C:\\Users\\Loja\\Desktop', entries: [] },
    requestLocalDir: vi.fn(),
    requestRemoteDir: vi.fn(),
    onSendToRemote: vi.fn(),
    onSendToLocal: vi.fn(),
    isTransferring: false,
    onClose: vi.fn(),
    ...overrides,
  }
}

describe('FileBrowserModal', () => {
  it('pede as 2 listagens (local e remota) assim que monta, com diretório vazio (default)', () => {
    const props = makeProps()
    render(<FileBrowserModal {...props} />)
    expect(props.requestLocalDir).toHaveBeenCalledWith('')
    expect(props.requestRemoteDir).toHaveBeenCalledWith('')
  })

  it('renderiza pastas e arquivos de cada painel, com tamanho só nos arquivos', () => {
    const props = makeProps({
      localListing: {
        path: 'C:\\Users\\Andre\\Desktop',
        entries: [{ name: 'Projetos', isDir: true, size: 0 }, { name: 'nota.txt', isDir: false, size: 1024 }],
      },
    })
    render(<FileBrowserModal {...props} />)
    expect(screen.getByTestId('local-pane-entry-Projetos')).toBeInTheDocument()
    expect(screen.getByTestId('local-pane-entry-nota.txt')).toHaveTextContent('1.0 KB')
  })

  it('clicar numa PASTA não seleciona (botão "Enviar →" continua desabilitado)', () => {
    const props = makeProps({
      localListing: { path: 'C:\\x', entries: [{ name: 'Projetos', isDir: true, size: 0 }] },
    })
    render(<FileBrowserModal {...props} />)
    fireEvent.click(screen.getByTestId('local-pane-entry-Projetos'))
    expect(screen.getByText('Enviar →')).toBeDisabled()
  })

  it('duplo-clique numa pasta local navega pra dentro dela (requestLocalDir com o caminho completo)', () => {
    const props = makeProps({
      localListing: { path: 'C:\\Users\\Andre\\Desktop', entries: [{ name: 'Projetos', isDir: true, size: 0 }] },
    })
    render(<FileBrowserModal {...props} />)
    fireEvent.doubleClick(screen.getByTestId('local-pane-entry-Projetos'))
    expect(props.requestLocalDir).toHaveBeenCalledWith('C:\\Users\\Andre\\Desktop\\Projetos')
  })

  it('duplo-clique num ARQUIVO não navega (só pastas navegam)', () => {
    const props = makeProps({
      remoteListing: { path: 'C:\\Users\\Loja\\Desktop', entries: [{ name: 'nota.txt', isDir: false, size: 10 }] },
    })
    render(<FileBrowserModal {...props} />)
    props.requestRemoteDir.mockClear() // limpa a chamada do mount
    fireEvent.doubleClick(screen.getByTestId('remote-pane-entry-nota.txt'))
    expect(props.requestRemoteDir).not.toHaveBeenCalled()
  })

  it('botão "⬆" (subir) pede o diretório pai, parando na raiz da unidade', () => {
    const props = makeProps({
      localListing: { path: 'C:\\Users\\Andre\\Desktop\\Projetos', entries: [] },
      remoteListing: { path: 'C:\\', entries: [] },
    })
    render(<FileBrowserModal {...props} />)
    const upButtons = screen.getAllByTitle('Subir um nível')
    fireEvent.click(upButtons[0]) // painel local
    expect(props.requestLocalDir).toHaveBeenCalledWith('C:\\Users\\Andre\\Desktop')
    fireEvent.click(upButtons[1]) // painel remoto, já na raiz -- não desce além
    expect(props.requestRemoteDir).toHaveBeenCalledWith('C:\\')
  })

  it('botão "⬆" numa raiz UNC (\\\\servidor\\share) não corta no meio do nome do servidor', () => {
    const props = makeProps({
      localListing: { path: '\\\\servidor\\share\\pasta', entries: [] },
      remoteListing: { path: '\\\\servidor\\share', entries: [] },
    })
    render(<FileBrowserModal {...props} />)
    const upButtons = screen.getAllByTitle('Subir um nível')
    fireEvent.click(upButtons[0]) // sobe de \\servidor\share\pasta -- pára na raiz do compartilhamento
    expect(props.requestLocalDir).toHaveBeenCalledWith('\\\\servidor\\share')
    fireEvent.click(upButtons[1]) // já na raiz do compartilhamento -- não corta no meio de "servidor"
    expect(props.requestRemoteDir).toHaveBeenCalledWith('\\\\servidor\\share')
  })

  // Achado 🟠 do code-reviewer: "⬆" navegava SEM limpar a seleção —
  // canSend/canDownload só checam a string selecionada, não se ela existe
  // na listagem atual. Sem isso, selecionar um arquivo, subir um nível, e
  // a pasta-pai ter um arquivo de MESMO NOME deixava "Enviar →" habilitado
  // pra enviar o arquivo da pasta ERRADA, em silêncio.
  it('botão "⬆" limpa a seleção -- "Enviar →" volta a ficar desabilitado mesmo que a pasta-pai tenha um arquivo de mesmo nome', () => {
    const props = makeProps({
      localListing: { path: 'C:\\Users\\Andre\\Desktop\\Projetos', entries: [{ name: 'a.txt', isDir: false, size: 1 }] },
    })
    const { rerender } = render(<FileBrowserModal {...props} />)

    fireEvent.click(screen.getByTestId('local-pane-entry-a.txt'))
    expect(screen.getByText('Enviar →')).not.toBeDisabled()

    fireEvent.click(screen.getAllByTitle('Subir um nível')[0]) // painel local
    // Simula a resposta da navegação chegando: pasta-pai TAMBÉM tem "a.txt".
    rerender(<FileBrowserModal {...props} localListing={{ path: 'C:\\Users\\Andre\\Desktop', entries: [{ name: 'a.txt', isDir: false, size: 2 }] }} />)

    expect(screen.getByText('Enviar →')).toBeDisabled()
  })

  it('selecionar um arquivo local habilita "Enviar →", clicar chama onSendToRemote com o caminho completo + pasta remota atual', () => {
    const props = makeProps({
      localListing: { path: 'C:\\Users\\Andre\\Desktop', entries: [{ name: 'instalador.exe', isDir: false, size: 8 }] },
      remoteListing: { path: 'C:\\Users\\Loja\\Desktop', entries: [] },
    })
    render(<FileBrowserModal {...props} />)
    expect(screen.getByText('Enviar →')).toBeDisabled()

    fireEvent.click(screen.getByTestId('local-pane-entry-instalador.exe'))
    expect(screen.getByText('Enviar →')).not.toBeDisabled()

    fireEvent.click(screen.getByText('Enviar →'))
    expect(props.onSendToRemote).toHaveBeenCalledWith('C:\\Users\\Andre\\Desktop\\instalador.exe', 'instalador.exe', 'C:\\Users\\Loja\\Desktop')
  })

  it('selecionar um arquivo remoto habilita "← Baixar", clicar chama onSendToLocal com o caminho completo', () => {
    const props = makeProps({
      remoteListing: { path: 'C:\\Users\\Loja\\Desktop', entries: [{ name: 'relatorio.pdf', isDir: false, size: 2048 }] },
    })
    render(<FileBrowserModal {...props} />)
    expect(screen.getByText('← Baixar')).toBeDisabled()

    fireEvent.click(screen.getByTestId('remote-pane-entry-relatorio.pdf'))
    expect(screen.getByText('← Baixar')).not.toBeDisabled()

    fireEvent.click(screen.getByText('← Baixar'))
    expect(props.onSendToLocal).toHaveBeenCalledWith('C:\\Users\\Loja\\Desktop\\relatorio.pdf')
  })

  // isTransferring (uma transferência já em andamento) desabilita os 2
  // botões mesmo com algo selecionado -- mesmo guard de 2 cliques
  // concorrentes já usado no resto do projeto (transferringRef).
  it('isTransferring desabilita "Enviar →"/"← Baixar" mesmo com seleção', () => {
    const props = makeProps({
      localListing: { path: 'C:\\x', entries: [{ name: 'a.txt', isDir: false, size: 1 }] },
      remoteListing: { path: 'C:\\y', entries: [{ name: 'b.txt', isDir: false, size: 1 }] },
      isTransferring: true,
    })
    render(<FileBrowserModal {...props} />)
    fireEvent.click(screen.getByTestId('local-pane-entry-a.txt'))
    fireEvent.click(screen.getByTestId('remote-pane-entry-b.txt'))
    expect(screen.getByText('Enviar →')).toBeDisabled()
    expect(screen.getByText('← Baixar')).toBeDisabled()
  })

  it('erro de listagem (ex: pasta sem permissão) mostra a mensagem, sem quebrar o resto da UI', () => {
    const props = makeProps({
      remoteListing: { path: 'C:\\Windows\\System32\\config', error: 'acesso negado' },
    })
    render(<FileBrowserModal {...props} />)
    expect(screen.getByText(/acesso negado/i)).toBeInTheDocument()
    expect(screen.getByText('← Baixar')).toBeDisabled()
  })

  it('botão "Fechar" chama onClose', () => {
    const props = makeProps()
    render(<FileBrowserModal {...props} />)
    fireEvent.click(screen.getByText('Fechar'))
    expect(props.onClose).toHaveBeenCalled()
  })
})
