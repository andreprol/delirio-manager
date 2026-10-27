'use strict';

// config/storeGeofence.js — raio permitido (metros) ao redor de cada loja para
// validar o clock-in remoto. VAZIO POR PADRÃO DE PROPÓSITO: coordenada errada
// bloquearia funcionário real sem ele poder fazer nada. Enquanto uma loja não
// tiver entrada aqui, o clock-in dessa loja é aceito sem checagem de geofence
// (within_geofence fica null, visível pro RH no espelho de ponto).
//
// A chave tem que bater exatamente com a grafia usada em STORES
// (dashboard/src/components/PontoRemotoModule.jsx) — divergência faz o
// geofence daquela loja nunca casar, silenciosamente.
//
// Preencher com lat/lng real de cada loja antes de confiar no bloqueio por
// geofence em produção:
//
// STORE_GEOFENCE['Gávea'] = { lat: -22.xxxxxx, lng: -43.xxxxxx, radiusMeters: 150 };

const STORE_GEOFENCE = {};

module.exports = { STORE_GEOFENCE };
