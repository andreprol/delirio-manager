import { useState } from 'react'
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

// Harness: selectedLocal/selectedRemote viraram props controladas (achado
// 🟠 do code-reviewer, 14/11/2026 -- subidas pro componente PAI de verdade
// em produção, LiveSessionWindow.jsx, pra sobreviver ao desmonte/remonte
// deste modal no round-trip do dialog nativo remoto). Este harness só
// reproduz esse mesmo papel de "pai com estado" nos testes, pra todo o
// resto do arquivo continuar testando clique→seleciona→habilita sem
// precisar saber da mudança.
function Harness(props) {
  const [selectedLocal, setSelectedLocal] = useState(null)
  const [selectedRemote, setSelectedRemote] = useState(null)
  return (
    <FileBrowserModal
      {...props}
      selectedLocal={selectedLocal}
      setSelectedLocal={setSelectedLocal}
      selectedRemote={selectedRemote}
      setSelectedRemote={setSelectedRemote}
    />
  )
}

describe('FileBrowserModal', () => {
  it('pede as 2 listagens (local e remota) assim que monta sem preserveListing, com diretório vazio (default)', () => {
    const props = makeProps({ localListing: null, remoteListing: null })
    render(<Harness {...props} />)
    expect(props.requestLocalDir).toHaveBeenCalledWith('')
    expect(props.requestRemoteDir).toHaveBeenCalledWith('')
  })

  // Achado AO VIVO real (14/11/2026): LiveSessionWindow.jsx DESMONTA este
  // modal (fecha, esconde o vídeo da sessão enquanto o dialog nativo
  // remoto espera o operador) e REMONTA (reabre) quando a resposta chega
  // -- localListing/remoteListing (props, vivem no PAI) sobrevivem ao
  // desmonte, mas o efeito de mount deste componente chamava
  // requestLocalDir('')/requestRemoteDir('') incondicionalmente de novo a
  // cada remonte, sobrescrevendo de volta pro default a navegação que
  // acabara de chegar (ex: pro caminho escolhido no dialog) -- a pasta
  // nunca "fixava". preserveListing=true (setado só por
  // recoverFromBrowseRemote, LiveSessionWindow.jsx) é o sinal explícito de
  // que ESTE remonte é o round-trip do picker -- o mount não deve refazer
  // a busca.
  it('preserveListing=true: NÃO pede as listagens de novo ao montar (remonte do round-trip do dialog remoto)', () => {
    const props = makeProps({ preserveListing: true })
    render(<Harness {...props} />)
    expect(props.requestLocalDir).not.toHaveBeenCalled()
    expect(props.requestRemoteDir).not.toHaveBeenCalled()
  })

  // 2º achado 🟡 do code-reviewer, mesma rodada: usar "já existe uma
  // listagem" (nullness) como proxy quebrava a reabertura MANUAL pela
  // toolbar depois de fechar -- também passaria a resumir a última pasta
  // em vez do default, mudança de comportamento não pedida. preserveListing
  // explícito (false nesse caminho, ver o botão da toolbar em
  // LiveSessionWindow.jsx) corrige: mesmo com listagem já populada (como
  // numa reabertura de verdade), sem preserveListing o mount busca o
  // default de novo -- igual sempre foi.
  it('preserveListing=false (abertura manual) pede o default de novo mesmo já existindo uma listagem', () => {
    const props = makeProps({ preserveListing: false }) // localListing/remoteListing já preenchidos por makeProps()
    render(<Harness {...props} />)
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
    render(<Harness {...props} />)
    expect(screen.getByTestId('local-pane-entry-Projetos')).toBeInTheDocument()
    expect(screen.getByTestId('local-pane-entry-nota.txt')).toHaveTextContent('1.0 KB')
  })

  it('clicar numa PASTA não seleciona (botão "Enviar →" continua desabilitado)', () => {
    const props = makeProps({
      localListing: { path: 'C:\\x', entries: [{ name: 'Projetos', isDir: true, size: 0 }] },
    })
    render(<Harness {...props} />)
    fireEvent.click(screen.getByTestId('local-pane-entry-Projetos'))
    expect(screen.getByText('Enviar →')).toBeDisabled()
  })

  it('duplo-clique numa pasta local navega pra dentro dela (requestLocalDir com o caminho completo)', () => {
    const props = makeProps({
      localListing: { path: 'C:\\Users\\Andre\\Desktop', entries: [{ name: 'Projetos', isDir: true, size: 0 }] },
    })
    render(<Harness {...props} />)
    fireEvent.doubleClick(screen.getByTestId('local-pane-entry-Projetos'))
    expect(props.requestLocalDir).toHaveBeenCalledWith('C:\\Users\\Andre\\Desktop\\Projetos')
  })

  it('duplo-clique num ARQUIVO não navega (só pastas navegam)', () => {
    const props = makeProps({
      remoteListing: { path: 'C:\\Users\\Loja\\Desktop', entries: [{ name: 'nota.txt', isDir: false, size: 10 }] },
    })
    render(<Harness {...props} />)
    props.requestRemoteDir.mockClear() // limpa a chamada do mount
    fireEvent.doubleClick(screen.getByTestId('remote-pane-entry-nota.txt'))
    expect(props.requestRemoteDir).not.toHaveBeenCalled()
  })

  it('botão "⬆" (subir) pede o diretório pai; na raiz da unidade, sobe pra "Este Computador" (lista de unidades)', () => {
    const props = makeProps({
      localListing: { path: 'C:\\Users\\Andre\\Desktop\\Projetos', entries: [] },
      remoteListing: { path: 'C:\\', entries: [] },
    })
    render(<Harness {...props} />)
    const upButtons = screen.getAllByTitle('Subir um nível')
    fireEvent.click(upButtons[0]) // painel local
    expect(props.requestLocalDir).toHaveBeenCalledWith('C:\\Users\\Andre\\Desktop')
    fireEvent.click(upButtons[1]) // painel remoto, já na raiz -- sobe pra ver as outras unidades
    expect(props.requestRemoteDir).toHaveBeenCalledWith('Este Computador')
  })

  it('botão "⬆" numa raiz UNC (\\\\servidor\\share) sobe pra "Este Computador", sem cortar no meio do nome do servidor', () => {
    const props = makeProps({
      localListing: { path: '\\\\servidor\\share\\pasta', entries: [] },
      remoteListing: { path: '\\\\servidor\\share', entries: [] },
    })
    render(<Harness {...props} />)
    const upButtons = screen.getAllByTitle('Subir um nível')
    fireEvent.click(upButtons[0]) // sobe de \\servidor\share\pasta -- pára na raiz do compartilhamento
    expect(props.requestLocalDir).toHaveBeenCalledWith('\\\\servidor\\share')
    fireEvent.click(upButtons[1]) // já na raiz do compartilhamento -- sobe pra "Este Computador", nunca corta no meio de "servidor"
    expect(props.requestRemoteDir).toHaveBeenCalledWith('Este Computador')
  })

  // Achado 🟠 do code-reviewer: parentWindowsPath fundia "já na raiz da
  // unidade" (ex: "C:\") com "1 nível acima da raiz" (ex: "C:\Users") no
  // mesmo if -- "⬆" a partir de QUALQUER pasta de topo (C:\Users,
  // D:\Projetos etc.) saltava direto pra "Este Computador", pulando a
  // listagem da raiz da unidade por completo.
  it('botão "⬆" numa pasta de topo (ex: "C:\\Users") pára na raiz da unidade, não pula pra "Este Computador"', () => {
    const props = makeProps({ remoteListing: { path: 'C:\\Users', entries: [] } })
    render(<Harness {...props} />)
    fireEvent.click(screen.getAllByTitle('Subir um nível')[1])
    expect(props.requestRemoteDir).toHaveBeenCalledWith('C:\\')
  })

  // "Este Computador" (THIS_PC): sentinela que lista as unidades
  // disponíveis -- André pediu pra dar pra navegar entre TODAS as
  // unidades (C:, D:, etc.), não só a árvore do Desktop.
  it('no topo ("Este Computador"), botão "⬆" fica desabilitado', () => {
    const props = makeProps({ localListing: { path: 'Este Computador', entries: [] } })
    render(<Harness {...props} />)
    expect(screen.getAllByTitle('Subir um nível')[0]).toBeDisabled()
  })

  it('duplo-clique numa unidade listada em "Este Computador" navega DIRETO pra ela (não junta os caminhos)', () => {
    const props = makeProps({
      remoteListing: { path: 'Este Computador', entries: [{ name: 'D:\\', isDir: true, size: 0 }] },
    })
    render(<Harness {...props} />)
    fireEvent.doubleClick(screen.getByTestId('remote-pane-entry-D:\\'))
    expect(props.requestRemoteDir).toHaveBeenCalledWith('D:\\')
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
    const { rerender } = render(<Harness {...props} />)

    fireEvent.click(screen.getByTestId('local-pane-entry-a.txt'))
    expect(screen.getByText('Enviar →')).not.toBeDisabled()

    fireEvent.click(screen.getAllByTitle('Subir um nível')[0]) // painel local
    // Simula a resposta da navegação chegando: pasta-pai TAMBÉM tem "a.txt".
    rerender(<Harness {...props} localListing={{ path: 'C:\\Users\\Andre\\Desktop', entries: [{ name: 'a.txt', isDir: false, size: 2 }] }} />)

    expect(screen.getByText('Enviar →')).toBeDisabled()
  })

  it('selecionar um arquivo local habilita "Enviar →", clicar chama onSendToRemote com o caminho completo + pasta remota atual', () => {
    const props = makeProps({
      localListing: { path: 'C:\\Users\\Andre\\Desktop', entries: [{ name: 'instalador.exe', isDir: false, size: 8 }] },
      remoteListing: { path: 'C:\\Users\\Loja\\Desktop', entries: [] },
    })
    render(<Harness {...props} />)
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
    render(<Harness {...props} />)
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
    render(<Harness {...props} />)
    fireEvent.click(screen.getByTestId('local-pane-entry-a.txt'))
    fireEvent.click(screen.getByTestId('remote-pane-entry-b.txt'))
    expect(screen.getByText('Enviar →')).toBeDisabled()
    expect(screen.getByText('← Baixar')).toBeDisabled()
  })

  it('erro de listagem (ex: pasta sem permissão) mostra a mensagem, sem quebrar o resto da UI', () => {
    const props = makeProps({
      remoteListing: { path: 'C:\\Windows\\System32\\config', error: 'acesso negado' },
    })
    render(<Harness {...props} />)
    expect(screen.getByText(/acesso negado/i)).toBeInTheDocument()
    expect(screen.getByText('← Baixar')).toBeDisabled()
  })

  it('botão "Fechar" chama onClose', () => {
    const props = makeProps()
    render(<Harness {...props} />)
    fireEvent.click(screen.getByText('Fechar'))
    expect(props.onClose).toHaveBeenCalled()
  })

  // Painel remoto não tem "📂 Procurar pasta..." nativo (não existe
  // Explorer rodando dentro da sessão remota pra abrir um dialog) -- o
  // campo de caminho editável é o substituto, pedido do André (item de
  // pendência do Acesso Remoto, 13/11/2026).
  it('painel remoto mostra o caminho como campo editável; painel local continua só leitura (tem o "📂" nativo)', () => {
    const props = makeProps()
    render(<Harness {...props} />)
    expect(screen.getByTestId('remote-pane-path-input')).toHaveValue('C:\\Users\\Loja\\Desktop')
    expect(screen.queryByTestId('local-pane-path-input')).not.toBeInTheDocument()
  })

  // André comparou print a print, 2 vezes: 1ª tentativa (campo editável,
  // botão só focava) foi rejeitada -- "o botão está sem função". 2ª
  // tentativa (14/11/2026): o botão remoto chama onBrowseRemote, que abre
  // o dialog nativo "Procurar pasta" DE VERDADE na tela remota (ver
  // agent/folderpicker_windows.go) -- mesmo ícone "📂", mesmo título, que
  // o painel local.
  it('painel remoto também tem o botão "📂"; clicar chama onBrowseRemote (abre o dialog nativo na tela remota)', () => {
    const onBrowseRemote = vi.fn()
    const props = makeProps({ onBrowseLocal: vi.fn(), onBrowseRemote })
    render(<Harness {...props} />)
    expect(screen.getAllByText('📂')).toHaveLength(2)
    expect(screen.getAllByTitle('Procurar pasta...')).toHaveLength(2)

    const input = screen.getByTestId('remote-pane-path-input')
    fireEvent.click(screen.getAllByTitle('Procurar pasta...')[1]) // painel remoto
    expect(onBrowseRemote).toHaveBeenCalledTimes(1)
    expect(input).not.toHaveFocus() // dialog real -- não é mais "focar o campo"
  })

  // browsingRemote=true: dialog já está aberto na tela remota, esperando o
  // operador escolher -- botão vira "⏳" e desabilita (2º clique só
  // confundiria, abrindo outro dialog por cima).
  it('browsingRemote=true desabilita o botão "📂" remoto e mostra "⏳"', () => {
    const onBrowseRemote = vi.fn()
    const props = makeProps({ onBrowseRemote, browsingRemote: true })
    render(<Harness {...props} />)

    const button = screen.getByTitle('Aguardando seleção na tela remota...')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('⏳')
    fireEvent.click(button)
    expect(onBrowseRemote).not.toHaveBeenCalled()
  })

  // Sem onBrowseRemote (defensivo -- não deveria acontecer em uso real,
  // LiveSessionWindow.jsx sempre passa as 2 props juntas): cai no
  // comportamento antigo (foca+seleciona o campo), nunca quebra o botão.
  it('sem onBrowseRemote, clicar no "📂" remoto cai no fallback (foca e seleciona o campo de caminho)', () => {
    const props = makeProps()
    render(<Harness {...props} />)
    const input = screen.getByTestId('remote-pane-path-input')
    fireEvent.click(screen.getAllByTitle('Procurar pasta...')[0]) // só o remoto tem esse botão aqui (sem onBrowseLocal)
    expect(input).toHaveFocus()
  })

  it('digitar um caminho no painel remoto e apertar Enter navega direto pra lá (sem precisar clicar pasta por pasta)', () => {
    const props = makeProps()
    render(<Harness {...props} />)
    const input = screen.getByTestId('remote-pane-path-input')
    fireEvent.change(input, { target: { value: 'C:\\Windows\\System32' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.requestRemoteDir).toHaveBeenCalledWith('C:\\Windows\\System32')
  })

  it('tecla diferente de Enter no campo de caminho não navega', () => {
    const props = makeProps()
    render(<Harness {...props} />)
    const input = screen.getByTestId('remote-pane-path-input')
    props.requestRemoteDir.mockClear() // limpa a chamada do mount
    fireEvent.change(input, { target: { value: 'C:\\Windows' } })
    fireEvent.keyDown(input, { key: 'a' })
    expect(props.requestRemoteDir).not.toHaveBeenCalled()
  })

  it('campo de caminho vazio (ou só espaço) no Enter não navega', () => {
    const props = makeProps()
    render(<Harness {...props} />)
    const input = screen.getByTestId('remote-pane-path-input')
    props.requestRemoteDir.mockClear()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.requestRemoteDir).not.toHaveBeenCalled()
  })

  // Mesmo cuidado de goUpRemote/navigateRemote (achado 🟠 original do
  // code-reviewer): navegar por caminho digitado também precisa limpar a
  // seleção, senão a pasta de destino podia ter um arquivo de mesmo nome e
  // "← Baixar" mandaria o arquivo errado.
  it('navegar por caminho digitado limpa a seleção remota -- "← Baixar" volta a ficar desabilitado', () => {
    const props = makeProps({
      remoteListing: { path: 'C:\\Users\\Loja\\Desktop', entries: [{ name: 'a.txt', isDir: false, size: 1 }] },
    })
    const { rerender } = render(<Harness {...props} />)

    fireEvent.click(screen.getByTestId('remote-pane-entry-a.txt'))
    expect(screen.getByText('← Baixar')).not.toBeDisabled()

    const input = screen.getByTestId('remote-pane-path-input')
    fireEvent.change(input, { target: { value: 'C:\\Windows' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Simula a resposta da navegação chegando: pasta nova TAMBÉM tem "a.txt".
    rerender(<Harness {...props} remoteListing={{ path: 'C:\\Windows', entries: [{ name: 'a.txt', isDir: false, size: 2 }] }} />)

    expect(screen.getByText('← Baixar')).toBeDisabled()
  })
})
