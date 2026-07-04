// dashboard/src/components/report/TopicList.jsx

const SEV_STYLE = {
  critica: { bg: '#2d1f1f', border: '#742a2a', badgeBg: '#742a2a', badgeColor: '#fc8181' },
  alta:    { bg: '#2d2416', border: '#744210', badgeBg: '#744210', badgeColor: '#fbd38d' },
  media:   { bg: '#1a202c', border: '#2d3748', badgeBg: '#1a365d', badgeColor: '#90cdf4' },
  baixa:   { bg: '#1a202c', border: '#2d3748', badgeBg: '#1a4731', badgeColor: '#9ae6b4' },
}

export function TopicList({ topics, onResolve }) {
  if (!topics.length) {
    return <p style={{ color: '#4a5568', fontSize: '0.8rem' }}>Nenhum tópico aberto nesta loja.</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {topics.map(t => {
        const s = SEV_STYLE[t.severity] || SEV_STYLE.baixa
        return (
          <div key={t.id} style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 6, padding: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ fontSize: '0.65rem', fontWeight: 700, color: s.badgeColor, background: s.badgeBg, padding: '2px 5px', borderRadius: 3, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {t.severity.toUpperCase()}
            </span>
            <div style={{ flex: 1, fontSize: '0.75rem', color: '#e2e8f0' }}>{t.description}</div>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
              {t.is_critical_machine ? <span style={{ fontSize: '0.65rem', color: '#e53e3e', fontWeight: 700 }}>🔴 BOH/TERM</span> : null}
              {t.machine_mention && !t.is_critical_machine ? <span style={{ fontSize: '0.65rem', color: '#718096' }}>{t.machine_mention}</span> : null}
              <span style={{ fontSize: '0.65rem', color: '#4a5568' }}>{t.created_at?.slice(0, 10)}</span>
              <button onClick={() => onResolve(t.id)}
                style={{ background: 'none', border: 'none', color: '#4a5568', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}
                title="Marcar como resolvido">🗑</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
