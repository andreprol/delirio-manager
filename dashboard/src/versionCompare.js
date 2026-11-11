// Compara versoes no formato "major.minor.patch" (so numeros, separados por
// ponto) -- usado pra saber qual agente da frota esta desatualizado em
// relacao ao mais recente visto entre as maquinas conectadas.
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na !== nb) return na - nb
  }
  return 0
}

// isValidVersion confirma que a string e so numeros separados por ponto
// (ex: "1.9.1") -- uma versao mal-formada (ex: "1.9.1-rc1", "dev") nao deve
// virar baseline da frota nem ser comparada como se fosse 0 silenciosamente.
export function isValidVersion(v) {
  return typeof v === 'string' && /^\d+(\.\d+)*$/.test(v)
}

// Retorna a maior versao valida da lista (ignora vazios/undefined/mal-
// formados) ou null se nenhuma versao valida foi encontrada.
export function getLatestVersion(versions) {
  let latest = null
  for (const v of versions) {
    if (!isValidVersion(v)) continue
    if (!latest || compareVersions(v, latest) > 0) latest = v
  }
  return latest
}

// getVersionBadgeStatus decide o estado visual do badge de versao de uma
// maquina em relacao a baseline da frota (latestVersion) -- centraliza a
// logica que antes vivia inline no render de MachineCard (achado do
// code-reviewer). 'unknown' quando ainda nao ha baseline confiavel (nenhuma
// maquina online com versao valida ainda reportou) -- nao finge "em dia"
// sem ter comparado de verdade.
export function getVersionBadgeStatus(version, latestVersion) {
  if (!isValidVersion(version)) return null
  if (!isValidVersion(latestVersion)) {
    return { state: 'unknown', color: '#6b7280', tooltip: `Agente v${version} — versão da frota ainda desconhecida` }
  }
  if (compareVersions(version, latestVersion) < 0) {
    return { state: 'outdated', color: '#f59e0b', tooltip: `Agente v${version} — desatualizado (mais recente na frota: v${latestVersion})` }
  }
  return { state: 'current', color: '#22c55e', tooltip: `Agente v${version} — em dia com a frota` }
}
