'use strict';

const { distanceMeters, isWithinGeofence } = require('./geofence');

describe('distanceMeters', () => {
  it('mesmo ponto — distância 0', () => {
    expect(distanceMeters(-22.9, -43.2, -22.9, -43.2)).toBeCloseTo(0, 3);
  });

  it('~1.11km de diferença em 0.01 grau de latitude', () => {
    const d = distanceMeters(-22.9, -43.2, -22.91, -43.2);
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1200);
  });
});

describe('isWithinGeofence', () => {
  const cfg = { lat: -22.9, lng: -43.2, radiusMeters: 150 };

  it('sem storeConfig — null (não bloqueia)', () => {
    expect(isWithinGeofence(undefined, -22.9, -43.2)).toBeNull();
  });

  it('sem coordenada do client — null (não bloqueia)', () => {
    expect(isWithinGeofence(cfg, null, null)).toBeNull();
    expect(isWithinGeofence(cfg, undefined, undefined)).toBeNull();
  });

  it('dentro do raio — true', () => {
    expect(isWithinGeofence(cfg, -22.9001, -43.2001)).toBe(true);
  });

  it('fora do raio — false', () => {
    expect(isWithinGeofence(cfg, -22.95, -43.25)).toBe(false);
  });
});
