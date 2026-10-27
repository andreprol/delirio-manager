'use strict';

// services/geofence.js — fórmula haversine pura, sem I/O, pra validar se um
// clock-in remoto está dentro do raio permitido da loja.

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// null = loja sem storeConfig (geofence não configurado) OU sem coordenada
// enviada pelo client — não bloqueia, só fica sem avaliação. true/false só
// quando há config E coordenada pra comparar.
function isWithinGeofence(storeConfig, lat, lng) {
  if (!storeConfig || lat == null || lng == null) return null;
  return distanceMeters(lat, lng, storeConfig.lat, storeConfig.lng) <= storeConfig.radiusMeters;
}

module.exports = { distanceMeters, isWithinGeofence };
