import { useState, useEffect, useRef } from 'react'
import { MachineCard } from './MachineCard'

export function LocationGroup({ name, machines, onCommand, onWol, onMoveToGroup, onRename, onDelete, groupsList, isEmpty }) {
  const [collapsed,  setCollapsed]  = useState(false)
  const [editing,    setEditing]    = useState(false)
  const [newName,    setNewName]    = useState(name)
  const [confirmDel, setConfirmDel] = useState(false)
  const [ctxMenu,    setCtxMenu]    = useState(null) // { x, y }
  const menuRef = useRef(null)

  const online  = machines.filter(m => m.status === 'online').length
  const offline = machines.filter(m => m.status === 'offline').length
  const total   = machines.length

  const isTemporario = name.toLowerCase() === 'temporário'
  const canRename    = !isTemporario && name !== 'Sem localidade'
  const canDelete    = !isTemporario && name !== 'Sem localidade' && isEmpty

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [ctxMenu])

  function handleRename() {
    if (newName.trim() && newName.trim() !== name) {
      onRename(name, newName.trim())
    }
    setEditing(false)
  }

  function handleRightClick(e) {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <>
    <div className={`location-group ${isEmpty ? 'group-empty' : ''}`}>
      <div className="group-header"
        onClick={() => !editing && setCollapsed(c => !c)}
        onContextMenu={handleRightClick}
      >
        <div className="group-title">
          <span className="group-arrow">{collapsed ? '▶' : '▼'}</span>
          {editing ? (
            <input
              className="group-name-input"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onBlur={handleRename}
              onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditing(false) }}
              onClick={e => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span
              className="group-name"
              onDoubleClick={e => { if (!canRename) return; e.stopPropagation(); setEditing(true); setNewName(name) }}
              title={canRename ? 'Clique duplo para renomear' : undefined}
              style={canRename ? undefined : { cursor: 'default' }}
            >
              {name}
            </span>
          )}
          {isEmpty && <span className="badge-empty">vazio</span>}
        </div>

        <div className="group-actions" onClick={e => e.stopPropagation()}>
          {total > 0 && (
            <div className="group-stats">
              <span className="stat-online">{online} online</span>
              {offline > 0 && <span className="stat-offline">{offline} offline</span>}
              <span className="stat-total">{total} total</span>
            </div>
          )}
          {/* Botao de excluir grupo (so aparece em grupos registrados no servidor) */}
          {onDelete && canDelete && (
            confirmDel ? (
              <>
                <button className="btn btn-danger" style={{ padding: '2px 8px', fontSize: 11 }}
                  onClick={() => { onDelete(); setConfirmDel(false) }}>
                  Confirmar
                </button>
                <button className="btn btn-secondary" style={{ padding: '2px 8px', fontSize: 11 }}
                  onClick={() => setConfirmDel(false)}>
                  Cancelar
                </button>
              </>
            ) : (
              <button
                className="icon-btn"
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={() => setConfirmDel(true)}
                title="Excluir grupo"
              >
                Excluir
              </button>
            )
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          {isEmpty ? (
            <div className="group-empty-msg">
              Grupo vazio — as maquinas atribuidas a este grupo apareceram aqui.
            </div>
          ) : (
            <div className="group-machines">
              {machines
                .slice()
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
      )}
    </div>

    {/* Menu de contexto do grupo */}
    {ctxMenu && (
      <div
        ref={menuRef}
        className="context-menu"
        style={{ top: ctxMenu.y, left: ctxMenu.x }}
        onClick={e => e.stopPropagation()}
      >
        <div className="ctx-header">{name}</div>

        {canRename && (
          <button className="ctx-item" onClick={() => { setEditing(true); setNewName(name); setCtxMenu(null) }}>
            Renomear
          </button>
        )}

        {canDelete ? (
          confirmDel ? (
            <>
              <button className="ctx-item" style={{ color: 'var(--red)' }}
                onClick={() => { onDelete(); setConfirmDel(false); setCtxMenu(null) }}>
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
        ) : !canRename ? null : (
          <button className="ctx-item" disabled style={{ opacity: .4, cursor: 'not-allowed' }}
            title="Remova todas as máquinas antes de excluir">
            Excluir grupo (tem máquinas)
          </button>
        )}

        {isTemporario && (
          <div className="ctx-section" style={{ paddingBottom: 8 }}>Grupo padrão — não editável</div>
        )}
      </div>
    )}
    </>
  )
}
