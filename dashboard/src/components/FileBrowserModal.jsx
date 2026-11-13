import { useState, useEffect, useCallback } from 'react'

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

// Ambos os lados (operador e loja) são sempre Windows (app só roda nesse
// SO) — backslash fixo, sem precisar detectar separador, mesmo padrão já
// usado no resto do projeto (ex: defaultDestDir em LiveSessionWindow.jsx).
function joinWindowsPath(base, name) {
  return base.replace(/[\\/]+$/, '') + '\\' + name
}

// parentWindowsPath pára na raiz da unidade (ex: "C:\") em vez de descer
// pra string vazia — descer além da raiz reabriria o default (Desktop),
// confuso pra quem clicou "subir" esperando ver a raiz do disco. Trata
// raiz UNC (\\servidor\share) como piso também -- achado 🟡 do
// code-reviewer: sem isso, "⬆" na raiz de um compartilhamento de rede
// (comum em loja com pasta compartilhada mapeada) cortava no meio do nome
// do servidor (ex: "\\servidor"), um caminho incompleto que fs.readdir
// rejeitaria.
function parentWindowsPath(p) {
  const trimmed = p.replace(/[\\/]+$/, '')
  const uncMatch = trimmed.match(/^\\\\[^\\]+\\[^\\]+/)
  if (uncMatch) {
    const uncRoot = uncMatch[0]
    if (trimmed.length <= uncRoot.length) return uncRoot // já na raiz do compartilhamento
    const idx = trimmed.lastIndexOf('\\')
    return idx <= uncRoot.length ? uncRoot : trimmed.slice(0, idx)
  }
  const idx = trimmed.lastIndexOf('\\')
  if (idx < 0 || idx <= 2) return trimmed.slice(0, 2) + '\\'
  return trimmed.slice(0, idx)
}

function Pane({ testId, title, listing, selected, onSelect, onNavigate, onUp }) {
  const path = listing?.path || ''
  const entries = listing?.entries || []
  const error = listing?.error || listing?.message
  return (
    <div data-testid={testId} style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, border: '1px solid #1e1e30', borderRadius: 6 }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #1e1e30', display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong style={{ flexShrink: 0 }}>{title}</strong>
        <button className="btn btn-secondary" onClick={onUp} title="Subir um nível" style={{ padding: '2px 8px' }}>⬆</button>
        <span style={{ fontSize: 12, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
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
            <span>{e.isDir ? '📁' : '📄'} {e.name}</span>
            {!e.isDir && <span style={{ color: '#9ca3af' }}>{formatBytes(e.size)}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

export function FileBrowserModal({
  localListing, remoteListing, requestLocalDir, requestRemoteDir,
  onSendToRemote, onSendToLocal, isTransferring, onClose,
}) {
  const [selectedLocal, setSelectedLocal] = useState(null)
  const [selectedRemote, setSelectedRemote] = useState(null)

  // Abre os 2 painéis no default (Desktop de cada lado) assim que a janela
  // monta — dir vazio é o contrato combinado com Electron/companion pra
  // "sem preferência, abra no default".
  useEffect(() => {
    requestLocalDir('')
    requestRemoteDir('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const localPath = localListing?.path || ''
  const remotePath = remoteListing?.path || ''

  const navigateLocal = useCallback((entry) => {
    setSelectedLocal(null)
    requestLocalDir(joinWindowsPath(localPath, entry.name))
  }, [localPath, requestLocalDir])

  const navigateRemote = useCallback((entry) => {
    setSelectedRemote(null)
    requestRemoteDir(joinWindowsPath(remotePath, entry.name))
  }, [remotePath, requestRemoteDir])

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
    setSelectedRemote(null)
    requestRemoteDir(parentWindowsPath(remotePath))
  }, [remotePath, requestRemoteDir])

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
          />
        </div>
      </div>
    </div>
  )
}
