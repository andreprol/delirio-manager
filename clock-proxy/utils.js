'use strict';

/**
 * Formata CPF para o padrão Henry Hexa ADV: xxx.xxx.xxx-xx.
 * Remove não-dígitos, limita a 11 caracteres.
 */
function formatCpf(cpfRaw) {
  const digits = (cpfRaw || '').replace(/\D/g, '').slice(0, 11);
  return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

/**
 * Constrói o cache mestre de funcionários a partir dos resultados brutos por relógio.
 * Detecta divergências (ausente em algum relógio acessível) e cartões incompletos
 * (ref2 no mestre mas ausente em algum relógio em que o funcionário está presente).
 *
 * @param {Array}    clockResults - [{ ip, success, employees: [{cpf, name, ref1, ref2}], total?, message? }]
 * @param {string[]} allClockIps  - lista completa de IPs configurados (para o campo allClockIps na resposta)
 */
function buildMasterCache(clockResults, allClockIps) {
  const clockRef2Map = {};
  for (const clock of clockResults) {
    if (!clock.success) continue;
    clockRef2Map[clock.ip] = {};
    for (const emp of clock.employees) {
      clockRef2Map[clock.ip][emp.cpf] = emp.ref2 || '';
    }
  }

  const masterMap = new Map();
  for (const clock of clockResults) {
    if (!clock.success) continue;
    for (const emp of clock.employees) {
      if (!masterMap.has(emp.cpf)) {
        masterMap.set(emp.cpf, {
          name: emp.name, cpf: emp.cpf, ref1: emp.ref1, ref2: emp.ref2,
          presentIn: [], absentIn: [],
        });
      } else {
        const existing = masterMap.get(emp.cpf);
        if (!existing.ref2 && emp.ref2) existing.ref2 = emp.ref2;
        if (!existing.ref1 && emp.ref1) existing.ref1 = emp.ref1;
      }
      masterMap.get(emp.cpf).presentIn.push(clock.ip);
    }
  }

  const reachableIps = clockResults.filter(r => r.success).map(r => r.ip);
  for (const emp of masterMap.values()) {
    emp.absentIn     = reachableIps.filter(ip => !emp.presentIn.includes(ip));
    emp.incompleteIn = emp.ref2
      ? reachableIps.filter(ip => emp.presentIn.includes(ip) && !clockRef2Map[ip]?.[emp.cpf])
      : [];
  }

  const employees  = Array.from(masterMap.values());
  const divergent  = employees.filter(e => e.absentIn.length > 0);
  const incomplete = employees.filter(e => e.incompleteIn.length > 0);
  return {
    total:        employees.length,
    divergent:    divergent.length,
    incomplete:   incomplete.length,
    synchronized: employees.length - divergent.length,
    employees,
    clocks: clockResults.map(r => ({
      ip: r.ip, success: r.success, total: r.total || 0, error: r.message,
    })),
    allClockIps: allClockIps || [],
    timestamp:   new Date().toISOString(),
  };
}

module.exports = { formatCpf, buildMasterCache };
