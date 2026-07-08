// dashboard/src/components/report/StoreList.jsx

function dotColor(score) {
  if (score === null) return '#4a5568'
  if (score > 50)    return '#e53e3e'
  if (score > 30)    return '#ed8936'
  return '#48bb78'
}

function zamakLine(z) {
  if (!z) return <span style={{ color: '#4a5568' }}>Zamak não sincronizada</span>
  const parts = []
  if (z.devices_offline > 0) parts.push(`${z.devices_offline} offline`)
  if (z.patch_critical  > 0) parts.push(`${z.patch_critical} críticos`)
  if (z.threats_active  > 0) parts.push(`${z.threats_active} ameaças`)
  const bad = parts.length > 0
  return (
    <span style={{ color: bad ? '#ed8936' : '#48bb78' }}>
      {bad ? `⚠ ${parts.join(' · ')}` : `✓ Zamak ${z.total_devices}d OK`}
    </span>
  )
}

export function StoreList({ stores, selectedStore, onSelect, zamakByStore = {} }) {
  return (
    <div style={{ width: 220, borderRight: '1px solid #2d3748', padding: 12, flexShrink: 0, background: '#131720', overflowY: 'auto' }}>
      <div style={{ fontSize: '0.7rem', color: '#4a5568', fontWeight: 700, letterSpacing: '.08em', marginBottom: 8 }}>LOJAS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {stores.map(s => (
          <div key={s.name} onClick={() => onSelect(s.name)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 6,
              background: selectedStore === s.name ? '#1e2a3a' : 'transparent', cursor: 'pointer' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: dotColor(s.score), flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.78rem', fontWeight: selectedStore === s.name ? 600 : 400, color: selectedStore === s.name ? '#e2e8f0' : '#a0aec0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.name}
              </div>
              <div style={{ fontSize: '0.65rem', display: 'flex', flexDirection: 'column', gap: 1, marginTop: 1 }}>
                {/* Score ou placeholder */}
                <span style={{ color: '#4a5568' }}>
                  {s.score !== null ? `Score ${s.score}` : 'Sem relatório'}{s.openTopics > 0 ? ` · ${s.openTopics} tópico${s.openTopics > 1 ? 's' : ''}` : ''}
                </span>
                {/* Freshdesk */}
                {s.freshdeskCount > 0
                  ? <span style={{ color: '#48bb78' }}>✓ {s.freshdeskCount} tickets sincronizados</span>
                  : <span style={{ color: '#4a5568' }}>Freshdesk sem tickets</span>
                }
                {/* Zamak RMM — lookup com fallback accent-insensitive */}
                {zamakLine(zamakByStore[s.name] ?? zamakByStore[(s.name||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()])}
              </div>
            </div>
          </div>
        ))}
        {!stores.length && <p style={{ fontSize: '0.75rem', color: '#4a5568' }}>Nenhuma loja com dados.</p>}
      </div>
    </div>
  )
}
