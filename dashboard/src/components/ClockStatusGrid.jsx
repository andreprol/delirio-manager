import { useState, useEffect } from 'react'
import { api } from '../api'

const IP_TO_STORE = {
  '192.168.15.151': 'Gávea',
  '192.168.14.151': 'Metropolitano',
  '192.168.12.151': 'Bshop',
  '192.168.0.151':  'Assembleia',
  '192.168.13.151': 'Città',
  '192.168.18.151': 'Ipanema',
  '192.168.16.151': 'Rio Sul',
  '192.168.20.151': 'Tijuca',
  '192.168.20.150': 'Niterói',
}

const CLOCK_IPS = Object.keys(IP_TO_STORE)

const styles = {
  container: {
    padding: '16px',
    background: 'var(--bg, #181c20)',
    color: 'var(--text, #e2e8f0)',
    fontFamily: 'inherit',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '16px',
    flexWrap: 'wrap',
    gap: '8px',
  },
  title: {
    fontSize: '15px',
    fontWeight: 700,
    color: 'var(--text, #e2e8f0)',
    margin: 0,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
  },
  summary: {
    fontSize: '13px',
    color: 'var(--text-muted, #94a3b8)',
  },
  summaryCount: {
    fontWeight: 700,
    color: 'var(--green, #4ade80)',
  },
  summaryCountBad: {
    fontWeight: 700,
    color: 'var(--red, #f87171)',
  },
  timestamp: {
    fontSize: '11px',
    color: 'var(--text-muted, #64748b)',
  },
  verifyBtn: {
    padding: '6px 14px',
    background: 'var(--accent, #3b82f6)',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
  verifyBtnLoading: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  errorBanner: {
    background: 'rgba(248,113,113,0.12)',
    border: '1px solid var(--red, #f87171)',
    borderRadius: '8px',
    padding: '10px 14px',
    marginBottom: '14px',
    fontSize: '13px',
    color: 'var(--red, #f87171)',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '12px',
  },
  card: {
    background: 'var(--card-bg, #1e2530)',
    border: '1px solid var(--border, #2d3748)',
    borderRadius: '10px',
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    minWidth: 0,
  },
  cardReachable: {
    borderColor: 'rgba(74,222,128,0.35)',
  },
  cardUnreachable: {
    borderColor: 'rgba(248,113,113,0.35)',
  },
  cardSkeleton: {
    background: 'var(--card-bg, #1e2530)',
    border: '1px solid var(--border, #2d3748)',
    borderRadius: '10px',
    padding: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minWidth: 0,
  },
  skeletonLine: (width, height = 12) => ({
    background: 'var(--border, #2d3748)',
    borderRadius: '4px',
    height: `${height}px`,
    width,
    animation: 'pulse 1.4s ease-in-out infinite',
  }),
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  storeName: {
    fontWeight: 700,
    fontSize: '14px',
    color: 'var(--text, #e2e8f0)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  statusIcon: {
    fontSize: '16px',
    flexShrink: 0,
  },
  ip: {
    fontSize: '11px',
    color: 'var(--text-muted, #64748b)',
    fontFamily: 'monospace',
  },
  responseTime: {
    fontSize: '12px',
    color: 'var(--green, #4ade80)',
    fontWeight: 600,
  },
  errorMsg: {
    fontSize: '11px',
    color: 'var(--red, #f87171)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
}

function SkeletonCard() {
  return (
    <div style={styles.cardSkeleton}>
      <div style={styles.cardHeader}>
        <div style={styles.skeletonLine('60%', 13)} />
        <div style={styles.skeletonLine('16px', 16)} />
      </div>
      <div style={styles.skeletonLine('45%', 10)} />
      <div style={styles.skeletonLine('35%', 10)} />
    </div>
  )
}

function ClockCard({ clock }) {
  const storeName = IP_TO_STORE[clock.ip] || clock.ip
  const cardStyle = {
    ...styles.card,
    ...(clock.reachable ? styles.cardReachable : styles.cardUnreachable),
  }

  return (
    <div style={cardStyle}>
      <div style={styles.cardHeader}>
        <span style={styles.storeName}>{storeName}</span>
        <span style={styles.statusIcon}>{clock.reachable ? '✅' : '❌'}</span>
      </div>
      <span style={styles.ip}>{clock.ip}</span>
      {clock.reachable
        ? <span style={styles.responseTime}>{clock.responseTimeMs}ms</span>
        : <span style={styles.errorMsg} title={clock.error}>{clock.error || 'Sem resposta'}</span>
      }
    </div>
  )
}

export function ClockStatusGrid() {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  async function fetchStatus() {
    setLoading(true)
    setError(null)
    try {
      const result = await api.rh.getClockStatus()
      setData(result)
    } catch (err) {
      setError(err.message || 'Não foi possível conectar ao clock-proxy.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchStatus() }, [])

  const reachable = data?.reachable ?? 0
  const total     = data?.total     ?? CLOCK_IPS.length
  const allGood   = !loading && !error && reachable === total

  const timestampStr = data?.timestamp
    ? new Date(data.timestamp).toLocaleString('pt-BR')
    : null

  const clocks = data?.clocks ?? []

  // Ensure all known IPs appear (fill missing ones from the response)
  const knownIps = new Set(clocks.map(c => c.ip))
  const fullClocks = [
    ...clocks,
    ...CLOCK_IPS.filter(ip => !knownIps.has(ip)).map(ip => ({
      ip,
      reachable: false,
      responseTimeMs: null,
      error: 'Sem dados',
    })),
  ]

  return (
    <div style={styles.container}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      <div style={styles.header}>
        <h3 style={styles.title}>Relógios de Ponto</h3>
        <div style={styles.headerRight}>
          {!loading && !error && (
            <span style={styles.summary}>
              <span style={allGood ? styles.summaryCount : styles.summaryCountBad}>
                {reachable}
              </span>
              <span style={styles.summary}>/{total} online</span>
            </span>
          )}
          {timestampStr && (
            <span style={styles.timestamp}>Verificado: {timestampStr}</span>
          )}
          <button
            style={{ ...styles.verifyBtn, ...(loading ? styles.verifyBtnLoading : {}) }}
            onClick={fetchStatus}
            disabled={loading}
          >
            {loading ? 'Verificando…' : 'Verificar'}
          </button>
        </div>
      </div>

      {error && (
        <div style={styles.errorBanner}>
          <span>⚠️</span>
          <span>clock-proxy indisponível: {error}</span>
        </div>
      )}

      <div style={styles.grid}>
        {loading
          ? CLOCK_IPS.map(ip => <SkeletonCard key={ip} />)
          : fullClocks.map(clock => <ClockCard key={clock.ip} clock={clock} />)
        }
      </div>
    </div>
  )
}
