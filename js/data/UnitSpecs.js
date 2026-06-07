// js/data/UnitSpecs.js
// Aircraft and radar threat specifications
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  // ── Friendly Aircraft ─────────────────────────────────────────
  const AIRCRAFT = {
    F16C: {
      id: 'F16C', name: 'F-16C Falcon', role: 'STRIKE',
      maxSpeed: 560,      // m/s
      cruiseSpeed: 340,   // m/s
      maxAltitude: 15000, // m
      minAltitude: 30,    // m
      rcs: 1.2,           // m² (Radar Cross Section)
      jammerERP: 0,       // watts (no onboard jammer)
      flares: 20,
      color: '#00ff88',
      icon: '▲',
      turnRate: 25,       // deg/s
      climbRate: 150,     // m/s
    },
    F22A: {
      id: 'F22A', name: 'F-22A Raptor', role: 'STRIKE',
      maxSpeed: 620,
      cruiseSpeed: 400,
      maxAltitude: 19800,
      minAltitude: 30,
      rcs: 0.0001,        // VLO stealth
      jammerERP: 0,
      flares: 16,
      color: '#00ccff',
      icon: '▲',
      turnRate: 30,
      climbRate: 200,
    },
    EA18G: {
      id: 'EA18G', name: 'EA-18G Growler', role: 'EW_SUPPORT',
      maxSpeed: 490,
      cruiseSpeed: 300,
      maxAltitude: 12600,
      minAltitude: 30,
      rcs: 2.4,
      jammerERP: 1800000, // 1.8 MW EW suite
      flares: 16,
      color: '#ffaa00',
      icon: '▲',
      turnRate: 20,
      climbRate: 120,
    },
    B2A: {
      id: 'B2A', name: 'B-2A Spirit', role: 'HEAVY_STRIKE',
      maxSpeed: 250,
      cruiseSpeed: 200,
      maxAltitude: 15000,
      minAltitude: 50,
      rcs: 0.00001,       // Extreme stealth
      jammerERP: 0,
      flares: 0,
      color: '#aa88ff',
      icon: '▼',
      turnRate: 10,
      climbRate: 80,
    },
  };

  // ── Enemy Threat Systems ──────────────────────────────────────
  const THREATS = {
    SA10: {
      id: 'SA10', name: 'SA-10 Grumble (S-300)',
      type: 'SAM',
      // Radar parameters for range equation
      Pt: 3e6,          // transmit power (W)
      Gt: 5000,         // transmit gain
      Gr: 5000,         // receive gain
      lambda: 0.1,      // wavelength (m) — 3 GHz band
      Pmin: 1e-13,      // min detectable power (W)
      maxRange: 90000,  // m nominal
      missileRange: 90000,
      missilePk: 0.72,  // base probability of kill
      missileType: 'RADAR_GUIDED',
      reloadTime: 4000, // ms between shots
      color: '#ff4444',
      radius: 90000,    // threat zone radius (m) for visualization
    },
    SA20: {
      id: 'SA20', name: 'SA-20 Gargoyle (S-400)',
      type: 'SAM',
      Pt: 5e6,
      Gt: 8000,
      Gr: 8000,
      lambda: 0.08,
      Pmin: 8e-14,
      maxRange: 120000,
      missileRange: 120000,
      missilePk: 0.85,
      missileType: 'RADAR_GUIDED',
      reloadTime: 6000,
      color: '#ff2222',
      radius: 120000,
    },
    SHORADS: {
      id: 'SHORADS', name: 'SA-15 Tor-M1',
      type: 'SHORADS',
      Pt: 800000,
      Gt: 1200,
      Gr: 1200,
      lambda: 0.03,
      Pmin: 5e-13,
      maxRange: 12000,
      missileRange: 12000,
      missilePk: 0.55,
      missileType: 'IR_GUIDED',
      reloadTime: 2000,
      color: '#ff6600',
      radius: 12000,
    },
    RADAR: {
      id: 'RADAR', name: 'EW Radar (Early Warning)',
      type: 'EW_RADAR',
      Pt: 1e6,
      Gt: 10000,
      Gr: 10000,
      lambda: 0.5,      // VHF band
      Pmin: 1e-14,
      maxRange: 250000,
      missileRange: 0,  // radar only, no missiles
      missilePk: 0,
      missileType: 'NONE',
      reloadTime: 0,
      color: '#ffdd00',
      radius: 250000,
    },
    MIG31: {
      id: 'MIG31', name: 'MiG-31 Foxhound',
      type: 'INTERCEPTOR',
      Pt: 1.5e6,
      Gt: 2000,
      Gr: 2000,
      lambda: 0.05,
      Pmin: 2e-13,
      maxRange: 200000,
      missileRange: 200000,
      missilePk: 0.65,
      missileType: 'RADAR_GUIDED',
      reloadTime: 8000,
      color: '#ff4488',
      radius: 200000,
      // Airborne — moves along patrol route
      mobile: true,
      speed: 380,       // m/s patrol speed
    },
  };

  // ── Obstacle Types ───────────────────────────────────────────
  const OBSTACLES = {
    mountain: { name: 'Mountain Ridge', heightMult: 3, color: '#886644', sizeVox: 4 },
    building: { name: 'Urban Structure', heightMult: 1, color: '#888888', sizeVox: 2 },
    cliff:    { name: 'Rock Cliff',      heightMult: 2, color: '#667766', sizeVox: 3 },
    custom:   { name: 'Custom Box',      heightMult: 1, color: '#555555', sizeVox: 2 },
  };

  // ── Weather Effects ──────────────────────────────────────────
  const WEATHER = {
    clear:    { name: 'Clear',       radarMult: 1.00, visMult: 1.00, fogDensity: 0.00004 },
    overcast: { name: 'Overcast',    radarMult: 0.90, visMult: 0.85, fogDensity: 0.00010 },
    rain:     { name: 'Heavy Rain',  radarMult: 0.75, visMult: 0.60, fogDensity: 0.00022 },
    storm:    { name: 'Storm',       radarMult: 0.60, visMult: 0.35, fogDensity: 0.00050 },
  };

  window.JADO.UnitSpecs = { AIRCRAFT, THREATS, OBSTACLES, WEATHER };
})();
