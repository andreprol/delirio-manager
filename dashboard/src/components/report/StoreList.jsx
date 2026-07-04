// dashboard/src/components/report/StoreList.jsx

function dotColor(score) {
  if (score === null) return '#4a5568'
  if (score >= 60)   return '#e53e3e'
  if (score >= 30)   return '#ed8936'
  return '#48bb78'
}

export function StoreList({ stores, selectedStore, onSelect }) {
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
              <div style={{ fontSize: '0.65rem', color: '#4a5568' }}>
                {s.score !== null ? `Score ${s.score}` : 'Sem dados'}{s.openTopics > 0 ? ` · ${s.openTopics} tópico${s.openTopics > 1 ? 's' : ''}` : ''}
              </div>
            </div>
          </div>
        ))}
        {!stores.length && <p style={{ fontSize: '0.75rem', color: '#4a5568' }}>Nenhuma loja com dados.</p>}
      </div>
    </div>
  )
}
