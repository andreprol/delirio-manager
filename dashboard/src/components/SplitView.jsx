import { useState, useEffect, useRef } from 'react'
import { MachineCard } from './MachineCard'

function SidebarItem({ name, machines, isSelected, onSelect, onRename, onDelete, isEmpty, isRegistered }) {
  const [ctxMenu,    setCtxMenu]    = useState(null)
  const [editing,    setEditing]    = useState(false)
  const [newName,    setNewName]    = useState(name)
  const [confirmDel, setConfirmDel] = useState(false)
  const inputRef = useRef(null)

  const online  = machines.filter(m => m.status === 'online').length
  const offline = machines.filter(m => m.status === 'offline').length
  const total   = machines.length

  const isTemporario = name.toLowerCase() === 'temporário'
  const canRename    = !isTemporario
  const canDelete    = !isTemporario && isEmpty
  const dotClass     = total === 0 ? 'dot-empty' : online > 0 ? 'dot-online' : 'dot-offline'

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [ctxMenu])

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  function handleRightClick(e) {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  function commitRename() {
    const trimmed = newName.trim()
    if (trimmed && trimmed !== name) onRename(name, trimmed)
    setEditing(false)
  }

  return (
    <>
      <div
        className={`sidebar-item ${isSelected ? 'sidebar-selected' : ''} ${total === 0 ? 'sidebar-empty' : ''}`}
        onClick={() => !editing && onSelect(name)}
        onContextMenu={handleRightClick}
        onDoubleClick={e => { if (!canRename) return; e.stopPropagation(); setEditing(true); setNewName(name) }}
      >
        <span className={`sidebar-dot ${dotClass}`} />

        {editing ? (
          <input
            ref={inputRef}
            className="sidebar-rename-input"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(false) }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="sidebar-name" title={canRename ? 'Clique duplo para renomear' : undefined}>
            {name}
          </span>
        )}

        <div className="sidebar-badges">
          {online  > 0 && <span className="sb-online">{online}</span>}
          {offline > 0 && <span className="sb-offline">{offline}</span>}
          {total === 0  && <span className="sb-empty">vazio</span>}
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="context-menu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          <div className="ctx-header">{name}</div>

          {isTemporario ? (
            <div className="ctx-section" style={{ paddingBottom: 8 }}>Grupo padrão — não editável</div>
          ) : (
            <>
              <button className="ctx-item" onClick={() => { setEditing(true); setNewName(name); setCtxMenu(null) }}>
                Renomear
              </button>

              {canDelete ? (
                confirmDel ? (
                  <>
                    <button className="ctx-item" style={{ color: 'var(--red)' }}
                      onClick={() => { onDelete(name); setConfirmDel(false); setCtxMenu(null) }}>
                      Confirmar exclusão
                    </button>
                    <button className="ctx-item" onClick={() => { setConfirmDel(false); setCtxMenu(null) }}>
                      Cancelar
                    </button>
                  </>
                ) : (
                  <button className="ctx-item ctx-remove" onClick={() => setConfirmDel(true)}>
                    Excluir grupo
                  </button>
                )
              ) : (
                <button className="ctx-item" disabled style={{ opacity: .4, cursor: 'not-allowed' }}
                  title="Remova todas as máquinas antes de excluir">
                  Excluir grupo (tem máquinas)
                </button>
              )}
            </>
          )}
        </div>
      )}
    </>
  )
}

export function SplitView({
  filteredGroups, allGroups, groupsList,
  onCommand, onWol, onMoveToGroup,
  onRename, onDelete,
  selectedGroup, onSelectGroup,
  search = '',
}) {
  const hasSearch = search.trim().length > 0
  const searchMachines = hasSearch
    ? filteredGroups.flatMap(([, macs]) => macs)
    : null

  const effectiveSelected = selectedGroup ?? allGroups[0]?.[0] ?? null
  const selectedEntry     = allGroups.find(([n]) => n === effectiveSelected)
  const selectedMachines  = selectedEntry?.[1] || []
  const selectedIsEmpty   = selectedEntry?.[2] && selectedMachines.length === 0

  return (
    <div className="split-view">
      {/* ── Sidebar ── */}
      <aside className="split-sidebar">
        <div className="sidebar-header">Localidades</div>
        {allGroups.map(([name, macs, isRegistered]) => (
          <SidebarItem
            key={name || '__sem__'}
            name={name || 'Sem localidade'}
            machines={macs}
            isSelected={name === effectiveSelected}
            isEmpty={macs.length === 0}
            isRegistered={isRegistered}
            onSelect={onSelectGroup}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </aside>

      {/* ── Painel direito ── */}
      <div className="split-panel">
        {hasSearch ? (
          /* Search mode: flat list of all matching machines */
          <>
            <div className="split-panel-header">
              <div className="split-panel-title-row">
                <span className="split-panel-title">Resultados para "{search}"</span>
                <span className="split-panel-count">
                  {searchMachines.filter(m => m.status === 'online').length} online
                  {' / '}{searchMachines.length} encontrada{searchMachines.length !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
            {searchMachines.length === 0 ? (
              <div className="split-empty-state">Nenhuma máquina encontrada para "{search}".</div>
            ) : (
              <div className="split-machines">
                {[...searchMachines]
                  .sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id))
                  .map(m => (
                    <MachineCard
                      key={m.id}
                      machine={m}
                      onCommand={onCommand}
                      onWol={onWol}
                      onMoveToGroup={onMoveToGroup}
                      groupsList={groupsList}
                    />
                  ))
                }
              </div>
            )}
          </>
        ) : effectiveSelected !== null ? (
          /* Normal mode: selected group */
          <>
            <div className="split-panel-header">
              <div className="split-panel-title-row">
                <span className="split-panel-title">{effectiveSelected || 'Sem localidade'}</span>
                <span className="split-panel-count">
                  {selectedMachines.filter(m => m.status === 'online').length} online
                  {' / '}{selectedMachines.length} total
                </span>
              </div>
            </div>
            {selectedIsEmpty || selectedMachines.length === 0 ? (
              <div className="split-empty-state">
                Nenhuma máquina conectada neste grupo ainda.
                <br />
                <span style={{ fontSize: 11, marginTop: 6, display: 'block' }}>
                  Instale o agente nas máquinas e elas aparecerão aqui automaticamente.
                </span>
              </div>
            ) : (
              <div className="split-machines">
                {[...selectedMachines]
                  .sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id))
                  .map(m => (
                    <MachineCard
                      key={m.id}
                      machine={m}
                      onCommand={onCommand}
                      onWol={onWol}
                      onMoveToGroup={onMoveToGroup}
                      groupsList={groupsList}
                    />
                  ))
                }
              </div>
            )}
          </>
        ) : (
          <div className="split-empty-state">Selecione uma localidade.</div>
        )}
      </div>
    </div>
  )
}
