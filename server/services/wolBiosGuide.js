'use strict';

const BIOS_GUIDES = [
  {
    match: ['asus', 'asustek'],
    manufacturer: 'ASUS',
    path: 'Advanced → APM Configuration → Power On By PCI-E/PCI → Enabled',
    note: 'Também verificar: ErP Ready = Disabled',
  },
  {
    match: ['gigabyte', 'giga-byte'],
    manufacturer: 'Gigabyte',
    path: 'Settings → IO Ports → Wake on LAN Enable → Enabled',
    note: 'Também verificar: Power → ErP → Disabled (obrigatório para WoL)',
  },
  {
    match: ['msi', 'micro-star'],
    manufacturer: 'MSI',
    path: 'Settings → Advanced → Power Management Setup → Resume By PCI-E Device → Enabled',
    note: '',
  },
  {
    match: ['asrock'],
    manufacturer: 'ASRock',
    path: 'Advanced → ACPI Configuration → PCIE Device Power On → Enabled',
    note: '',
  },
  {
    match: ['dell'],
    manufacturer: 'Dell',
    path: 'Settings → Power Management → Wake on LAN/WLAN → LAN Only',
    note: 'Em alguns modelos: Deep Sleep Control → Disabled',
  },
  {
    match: ['hp', 'hewlett'],
    manufacturer: 'HP',
    path: 'Advanced → Power-On Options → S5 Wake On LAN → Enable',
    note: 'Em alguns modelos: S4/S5 Wake On LAN',
  },
  {
    match: ['lenovo'],
    manufacturer: 'Lenovo',
    path: 'Config → Network → Wake On LAN → Enabled',
    note: 'Em desktops Lenovo: Power → Automatic Power On → Wake on LAN → Enabled',
  },
  {
    match: ['intel'],
    manufacturer: 'Intel NUC',
    path: 'Power → Secondary Power Settings → Wake on LAN from S4/S5 → Power On - Normal Boot',
    note: '',
  },
];

const GENERIC_GUIDE = {
  path: 'Power Management → Wake on LAN → Enabled (ou "PCI-E Wake" / "EuP Ready: Disabled")',
  note: 'Consulte o manual da placa-mãe. Palavras-chave: Wake on LAN, WoL, PCI-E Power On, ErP',
};

/**
 * Retorna o guia de BIOS para configurar Wake-on-LAN.
 * @param {string} motherboard - Formato "Fabricante|Modelo" vindo do agente
 * @returns {{ manufacturer: string, model: string, path: string, note: string }}
 */
function getBiosGuide(motherboard) {
  const [mfr = '', model = ''] = (motherboard || '').split('|');
  const mfrLower = mfr.toLowerCase();

  const guide = BIOS_GUIDES.find(g => g.match.some(m => mfrLower.includes(m)));

  return {
    manufacturer: mfr || 'Desconhecido',
    model:        model || 'Desconhecido',
    path:         guide ? guide.path : GENERIC_GUIDE.path,
    note:         guide ? guide.note : GENERIC_GUIDE.note,
  };
}

module.exports = { getBiosGuide };
