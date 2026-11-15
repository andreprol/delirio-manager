import { useEffect, useCallback, useRef } from 'react'

// FileBrowserModal: navegador de arquivos dual-pane (estilo FileZilla) —
// substitui os campos de caminho digitado por navegação visual. Painel
// esquerdo é o computador do OPERADOR (list-local-dir, Electron), painel
// direito é a MÁQUINA REMOTA (list-remote-dir, companion Go) — os dois
// protocolos são espelhados de propósito (mesma forma {path, entries}),
// ver dashboard/electron/main.js e agent/filetransfer_windows.go.
//
// Navegação, seleção e os botões de transferência só montam o caminho
// completo e chamam onSendToRemote/onSendToLocal — a mecânica real de
// transferência (SAS/Blob) já existe em LiveSessionWindow.jsx, esta
// janela só troca COMO o caminho é escolhido (clique em vez de digitar).

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// THIS_PC: sentinela que significa "mostra as unidades disponíveis" em
// vez de uma pasta de verdade -- equivalente ao "Este Computador"/"This
// PC" do Explorer. André pediu pra dar pra navegar entre TODAS as
// unidades (C:, D:, etc.), não só a árvore do Desktop -- esse literal
// precisa bater EXATAMENTE com thisPCSentinel (agent/filetransfer_windows.go)
// e THIS_PC_SENTINEL (dashboard/electron/main.js), mesmo risco já
// documentado pra LIVE_SESSION_MSG/CLOSE_CODES (server).
const THIS_PC = 'Este Computador'

// DRIVE_RE identifica uma entrada de unidade (ex: "C:\") -- usado pra
// escolher o ícone certo e pra joinWindowsPath saber que, partindo de
// THIS_PC, deve navegar DIRETO pra unidade em vez de juntar os caminhos.
const DRIVE_RE = /^[A-Za-z]:\\?$/

// Ambos os lados (operador e loja) são sempre Windows (app só roda nesse
// SO) — backslash fixo, sem precisar detectar separador, mesmo padrão já
// usado no resto do projeto (ex: defaultDestDir em LiveSessionWindow.jsx).
function joinWindowsPath(base, name) {
  if (base === THIS_PC) return DRIVE_RE.test(name) ? name.replace(/\\?$/, '\\') : name
  return base.replace(/[\\/]+$/, '') + '\\' + name
}

// parentWindowsPath pára em THIS_PC (unidades disponíveis) em vez de
// ficar preso na raiz da unidade (ex: "C:\") pra sempre -- é assim que o
// operador alcança OUTRAS unidades (D:, pendrive, etc.), subindo a partir
// de qualquer uma. Trata raiz UNC (\\servidor\share) como piso igual à
// raiz de unidade (sobe pra THIS_PC também) -- achado 🟡 do
// code-reviewer: sem isso, "⬆" na raiz de um compartilhamento de rede
// (comum em loja com pasta compartilhada mapeada) cortava no meio do nome
// do servidor (ex: "\\servidor"), um caminho incompleto que fs.readdir
// rejeitaria.
function parentWindowsPath(p) {
  if (p === THIS_PC) return THIS_PC // já no topo, não sobe mais
  const trimmed = p.replace(/[\\/]+$/, '')
  const uncMatch = trimmed.match(/^\\\\[^\\]+\\[^\\]+/)
  if (uncMatch) {
    const uncRoot = uncMatch[0]
    if (trimmed.length <= uncRoot.length) return THIS_PC // já na raiz do compartilhamento
    const idx = trimmed.lastIndexOf('\\')
    return idx <= uncRoot.length ? uncRoot : trimmed.slice(0, idx)
  }
  const idx = trimmed.lastIndexOf('\\')
  if (idx < 0) return THIS_PC // já na raiz da unidade (ex: "C:\") -- sobe pras outras unidades
  if (idx <= 2) return trimmed.slice(0, 2) + '\\' // 1 nível acima da raiz (ex: "C:\Users") -- pára na raiz da unidade, não pula pra THIS_PC
  return trimmed.slice(0, idx)
}

// remoteBrowse agrupa as 3 props que só existem no painel REMOTO (campo de
// caminho editável + botão de dialog nativo) -- achado 🟡 do
// code-reviewer (14/11/2026): Pane tinha crescido pra 11 props soltas,
// piorado por este diff. Só o painel remoto passa este objeto.
function Pane({ testId, title, listing, selected, onSelect, onNavigate, onUp, onBrowse, remoteBrowse }) {
  const { onGoToPath, onBrowseRemote, browsingRemote, remoteConnected } = remoteBrowse || {}
  // disabled 🟡 do code-reviewer (14/11/2026): antes só checava
  // browsingRemote -- numa reconexão passageira ('reconnecting'/
  // 'disconnected') ou numa sessão já morta ('error') reaberta pelo
  // watcher em LiveSessionWindow.jsx, o botão aparecia clicável mas
  // sendBrowseRemoteFolder já virava no-op silencioso (status!=='connected'
  // em handleBrowseRemote) -- clique sem efeito nenhum, sem aviso.
  // remoteConnected vem undefined pro painel LOCAL (onGoToPath/
  // onBrowseRemote também não existem ali), então só afeta o remoto.
  const disabledRemoteBrowse = !!browsingRemote || remoteConnected === false
  const path = listing?.path || ''
  const entries = listing?.entries || []
  const error = listing?.error || listing?.message
  const pathInputRef = useRef(null)
  return (
    <div data-testid={testId} style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, border: '1px solid #1e1e30', borderRadius: 6 }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #1e1e30', display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={{ flexShrink: 0 }}>{title}</strong>
        <button className="btn btn-secondary" onClick={onUp} disabled={path === THIS_PC} title="Subir um nível" style={{ padding: '2px 8px' }}>⬆</button>
        {/* onBrowse (só no painel LOCAL): abre o seletor de pasta NATIVO do
            Windows -- pedido do André, "mais parecido com o que já há no
            mercado" (FileZilla etc. têm um atalho assim pro lado local). */}
        {onBrowse && (
          <button className="btn btn-secondary" onClick={onBrowse} title="Procurar pasta..." style={{ padding: '2px 8px' }}>📂</button>
        )}
        {/* onBrowseRemote (só no painel REMOTO): mesmo ícone "📂" do local,
            e desta vez abrindo um dialog NATIVO de verdade -- 2ª tentativa
            depois do André rejeitar a 1ª (14/11/2026): "o botão está sem
            função" (a 1ª versão só focava o campo de texto). O dialog
            nativo "Procurar pasta" do Windows abre NA TELA remota
            (agent/folderpicker_windows.go) -- aparece no vídeo da sessão
            ao vivo e é clicável pelo mesmo mouse/teclado injetado que já
            controla o resto da sessão Normal, então é a mesma experiência
            de verdade do lado local, só numa tela diferente. Fallback
            (foca+seleciona o campo, sem dialog) só se onBrowseRemote não
            vier -- nunca deveria acontecer em uso real, onde
            LiveSessionWindow.jsx sempre passa as 2 props juntas. */}
        {onGoToPath && (
          <button
            className="btn btn-secondary"
            onClick={onBrowseRemote || (() => { pathInputRef.current?.focus(); pathInputRef.current?.select() })}
            disabled={disabledRemoteBrowse}
            title={
              browsingRemote ? 'Aguardando seleção na tela remota...'
                : remoteConnected === false ? 'Sem conexão com a sessão ao vivo'
                : 'Procurar pasta...'
            }
            style={{ padding: '2px 8px' }}
          >{browsingRemote ? '⏳' : '📂'}</button>
        )}
        {onGoToPath ? (
          <input
            ref={pathInputRef}
            key={path}
            data-testid={`${testId}-path-input`}
            defaultValue={path}
            className="form-input"
            title="Digite ou cole um caminho e aperte Enter pra ir direto"
            style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '2px 6px', marginBottom: 0 }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const typed = e.target.value.trim()
              if (typed) onGoToPath(typed)
            }}
          />
        ) : (
          <span style={{ fontSize: 12, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 4 }}>
        {error && <div style={{ color: '#ef4444', padding: 8 }}>error: {error}</div>}
        {!error && entries.length === 0 && <div style={{ color: '#9ca3af', padding: 8 }}>(vazio)</div>}
        {!error && entries.map((e) => (
          <div
            key={e.name}
            data-testid={`${testId}-entry-${e.name}`}
            onClick={() => onSelect(e)}
            onDoubleClick={() => { if (e.isDir) onNavigate(e) }}
            style={{
              padding: '3px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
              background: selected === e.name ? '#2563eb55' : 'transparent',
              display: 'flex', justifyContent: 'space-between', gap: 8,
            }}
          >
            <span>{e.isDir ? (DRIVE_RE.test(e.name) ? '💽' : '📁') : '📄'} {e.name}</span>
            {!e.isDir && <span style={{ color: '#9ca3af' }}>{formatBytes(e.size)}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

export function FileBrowserModal({
  localListing, remoteListing, requestLocalDir, requestRemoteDir,
  onSendToRemote, onSendToLocal, isTransferring, onClose, onBrowseLocal,
  onBrowseRemote, browsingRemote, remoteConnected, preserveListing,
  selectedLocal, setSelectedLocal, selectedRemote, setSelectedRemote,
}) {
  // selectedLocal/selectedRemote/preserveListing: achados 🟠+🟡 do
  // code-reviewer (14/11/2026) -- subidos pro PAI (LiveSessionWindow.jsx,
  // junto de localListing/remoteListing) em vez de useState aqui, pelo
  // mesmo motivo: este modal é desmontado/remontado no round-trip do
  // dialog nativo remoto (ver handleBrowseRemote lá), e qualquer estado
  // que vivesse só AQUI desaparecia nesse meio-tempo sem aviso.

  // Abre os 2 painéis no default (Desktop de cada lado) na 1ª vez que a
  // janela monta — dir vazio é o contrato combinado com Electron/companion
  // pra "sem preferência, abra no default".
  //
  // preserveListing: achado 🟡 do code-reviewer -- a versão anterior deste
  // fix usava "já existe uma listagem" (nullness de localListing/
  // remoteListing) como proxy pra "este remonte é o round-trip do dialog
  // remoto, não abrir manual". Proxy frágil: (1) reabrir MANUALMENTE pela
  // toolbar depois de fechar também passava a resumir a última pasta em
  // vez do default, mudança de comportamento não pedida; (2)
  // requestLocalDir/requestRemoteDir são assíncronos -- numa rede lenta o
  // fetch do 1º open podia ainda não ter respondido quando o round-trip do
  // picker terminasse, disparando um requestRemoteDir('') extra que corre
  // contra a navegação pro caminho ESCOLHIDO já em voo. Prop explícita
  // (setada só nos caminhos que precisam preservar, ver
  // recoverFromBrowseRemote em LiveSessionWindow.jsx) resolve os dois.
  useEffect(() => {
    if (!preserveListing) {
      requestLocalDir('')
      requestRemoteDir('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const localPath = localListing?.path || ''
  const remotePath = remoteListing?.path || ''

  const navigateLocal = useCallback((entry) => {
    setSelectedLocal(null)
    requestLocalDir(joinWindowsPath(localPath, entry.name))
  }, [localPath, requestLocalDir])

  // goRemoteTo: achado 🟡 do code-reviewer (14/11/2026) -- navigateRemote/
  // goUpRemote/goToRemotePath só calculam o path de formas diferentes, mas
  // repetiam o mesmo par "limpar seleção + requestRemoteDir" 3x. Único
  // lugar que entende "navegar no painel remoto" de verdade.
  const goRemoteTo = useCallback((path) => {
    setSelectedRemote(null)
    requestRemoteDir(path)
  }, [requestRemoteDir])

  const navigateRemote = useCallback((entry) => {
    goRemoteTo(joinWindowsPath(remotePath, entry.name))
  }, [remotePath, goRemoteTo])

  // goUpLocal/goUpRemote TAMBÉM limpam a seleção -- achado 🟠 do
  // code-reviewer: "⬆" navegava sem limpar, e canSend/canDownload só
  // checam a STRING selecionada, não se ela existe na listagem atual. Se o
  // operador selecionasse um arquivo, subisse um nível, e a pasta-pai
  // tivesse um arquivo de MESMO NOME, o botão continuava habilitado e
  // enviava/baixava o arquivo da pasta ERRADA, em silêncio.
  const goUpLocal = useCallback(() => {
    setSelectedLocal(null)
    requestLocalDir(parentWindowsPath(localPath))
  }, [localPath, requestLocalDir])

  const goUpRemote = useCallback(() => {
    goRemoteTo(parentWindowsPath(remotePath))
  }, [remotePath, goRemoteTo])

  // handleBrowseLocal: onBrowseLocal (prop) é só "pergunta ao SO por uma
  // pasta" (window.electronAPI.pickLocalFolder, em LiveSessionWindow.jsx)
  // -- quem limpa a seleção e navega é AQUI, igual goUpLocal/navigateLocal
  // acima, mesmo motivo (achado 🟠 do code-reviewer sobre "⬆" não limpar
  // seleção se aplica igual aqui: pular pra uma pasta nova via dialog sem
  // limpar a seleção também arriscaria enviar o arquivo errado se a pasta
  // nova tiver um arquivo de mesmo nome).
  const handleBrowseLocal = useCallback(async () => {
    const picked = await onBrowseLocal?.()
    if (!picked) return // operador cancelou o dialog
    setSelectedLocal(null)
    requestLocalDir(picked)
  }, [onBrowseLocal, requestLocalDir])

  const canSend = !!selectedLocal && !isTransferring
  const canDownload = !!selectedRemote && !isTransferring

  return (
    <div
      data-testid="file-browser-modal"
      style={{ position: 'fixed', inset: 0, background: '#000000aa', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div style={{ background: '#0f1117', border: '1px solid #2a2a3d', borderRadius: 8, width: '90%', height: '80%', display: 'flex', flexDirection: 'column', padding: 16, gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Transferir arquivo</strong>
          <button className="btn btn-secondary" onClick={onClose}>Fechar</button>
        </div>
        <div style={{ flex: 1, display: 'flex', gap: 10, minHeight: 0 }}>
          <Pane
            testId="local-pane"
            title="Seu computador"
            listing={localListing}
            selected={selectedLocal}
            onSelect={(e) => !e.isDir && setSelectedLocal(e.name)}
            onNavigate={navigateLocal}
            onUp={goUpLocal}
            onBrowse={onBrowseLocal ? handleBrowseLocal : undefined}
          />
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
            <button
              className="btn btn-primary"
              disabled={!canSend}
              onClick={() => {
                onSendToRemote(joinWindowsPath(localPath, selectedLocal), selectedLocal, remotePath)
                setSelectedLocal(null)
              }}
            >
              Enviar →
            </button>
            <button
              className="btn btn-primary"
              disabled={!canDownload}
              onClick={() => {
                onSendToLocal(joinWindowsPath(remotePath, selectedRemote))
                setSelectedRemote(null)
              }}
            >
              ← Baixar
            </button>
          </div>
          <Pane
            testId="remote-pane"
            title="Máquina remota"
            listing={remoteListing}
            selected={selectedRemote}
            onSelect={(e) => !e.isDir && setSelectedRemote(e.name)}
            onNavigate={navigateRemote}
            onUp={goUpRemote}
            remoteBrowse={{ onGoToPath: goRemoteTo, onBrowseRemote, browsingRemote, remoteConnected }}
          />
        </div>
      </div>
    </div>
  )
}
