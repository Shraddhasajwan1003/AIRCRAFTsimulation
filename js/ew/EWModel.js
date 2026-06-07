// js/ew/EWModel.js
// Physics-based Electronic Warfare model
// Implements: Radar range equation, Bresenham LOS, Pk calculation, jamming
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  class EWModel {
    constructor() {
      this._weatherMult = 1.0; // modified by weather setting
    }

    setWeather(weatherSpec) {
      this._weatherMult = weatherSpec ? weatherSpec.radarMult : 1.0;
    }

    // ── Radar Range Equation ────────────────────────────────────
    // R_max = [(Pt * Gt * Gr * λ² * RCS) / ((4π)³ * Pmin)]^(1/4)
    // Jamming reduces Pt_eff: Pt_eff = Pt / (1 + J/S)
    // Returns detection range in meters.

    radarMaxRange(radarSpec, aircraftRCS, jammerERP = 0) {
      const { Pt, Gt, Gr, lambda, Pmin } = radarSpec;

      // Jamming: J/S ratio reduces effective transmit power
      let Pt_eff = Pt;
      if (jammerERP > 0) {
        // Simplified: jamming effectiveness proportional to ERP / distance² (distance assumed constant at ~50km for simplicity)
        const js = (jammerERP * Gr) / (Math.max(Pt, 1));
        Pt_eff = Pt / Math.max(1, 1 + js * 5e-8);
      }

      const num = Pt_eff * Gt * Gr * (lambda * lambda) * aircraftRCS;
      const den = Math.pow(4 * Math.PI, 3) * Pmin;
      if (den <= 0 || num <= 0) return 0;

      const range = Math.pow(num / den, 0.25) * this._weatherMult;
      return Math.min(range, radarSpec.maxRange || 300000);
    }

    // ── Bresenham 3D Line-of-Sight ──────────────────────────────
    // Returns true if there is unobstructed LOS between posA and posB
    // through the voxel grid (terrain blocks LOS; threat zones do not)

    losCheck(grid, posA, posB) {
      const va = grid.worldToVoxel(posA.x, posA.y, posA.z);
      const vb = grid.worldToVoxel(posB.x, posB.y, posB.z);
      for (const [vx, vy, vz] of this._bresenham3D(va.x, va.y, va.z, vb.x, vb.y, vb.z)) {
        const t = grid.getType(vx, vy, vz);
        if (t === 1 || t === 2) return false; // terrain or obstacle blocks
      }
      return true;
    }

    // Bresenham 3D voxel traversal (returns generator)
    * _bresenham3D(x1, y1, z1, x2, y2, z2) {
      let dx = Math.abs(x2-x1), dy = Math.abs(y2-y1), dz = Math.abs(z2-z1);
      const sx = x1<x2?1:-1, sy = y1<y2?1:-1, sz = z1<z2?1:-1;
      let dm = Math.max(dx, dy, dz);
      if (dm === 0) { yield [x1,y1,z1]; return; }
      let ex = dm/2, ey = dm/2, ez = dm/2;
      let x=x1, y=y1, z=z1;
      for (let i = 0; i <= dm; i++) {
        yield [x, y, z];
        ex -= dx; ey -= dy; ez -= dz;
        if (ex < 0) { x += sx; ex += dm; }
        if (ey < 0) { y += sy; ey += dm; }
        if (ez < 0) { z += sz; ez += dm; }
      }
    }

    // ── Probability of Kill ─────────────────────────────────────
    // Returns final Pk (0–1) after applying modifiers.

    probabilityOfKill(radarSpec, agent) {
      if (!radarSpec.missilePk || radarSpec.missileType === 'NONE') return 0;

      let pk = radarSpec.missilePk;

      // Speed factor: fast aircraft are harder to intercept
      const speedRatio = agent.speed / Math.max(agent.spec.maxSpeed, 1);
      pk *= Math.max(0.5, 1.0 - speedRatio * 0.3);

      // Altitude factor: NOE (nap-of-earth) flying reduces radar lock quality
      if (agent.altitude < 200) pk *= 0.7;

      // RCS factor (stealth helps even against radar-guided missiles via seeker)
      const rcsFactor = Math.min(1.0, Math.sqrt(agent.spec.rcs + 0.001) * 0.3);
      pk *= rcsFactor;

      // Flare deployment vs IR-guided missiles
      if (agent.flaresDeploying && radarSpec.missileType === 'IR_GUIDED') pk *= 0.20;

      // Active jamming vs radar-guided missiles
      if (agent.jammerActive && radarSpec.missileType === 'RADAR_GUIDED') {
        const jsEff = Math.min(0.75, agent.spec.jammerERP / 5e6);
        pk *= (1 - jsEff);
      }

      // Stealth bonus for very low RCS
      if (agent.spec.rcs < 0.01) pk *= 0.3;

      return Math.max(0, Math.min(1, pk));
    }

    // ── Per-agent threat evaluation ─────────────────────────────
    // Returns aggregate threat level 0–1 for display purposes

    getThreatLevel(agent, threats, grid) {
      let maxThreat = 0;
      const agentPos = { x: agent.x, y: agent.y, z: agent.z };

      for (const threat of threats) {
        if (!threat.spec) continue;
        const jammerERP = agent.jammerActive ? agent.spec.jammerERP : 0;
        const rng = this.radarMaxRange(threat.spec, agent.spec.rcs, jammerERP);
        const dist = this._dist3(agentPos, threat);

        if (dist > rng * 1.5) continue;

        // LOS check (terrain masking reduces threat)
        const hasLOS = this.losCheck(grid, agentPos, { x: threat.x, y: threat.y || 0, z: threat.z });
        if (!hasLOS) continue;

        const proximity = Math.max(0, 1 - dist / rng);
        maxThreat = Math.max(maxThreat, proximity);
      }
      return Math.min(1, maxThreat);
    }

    // Returns normalized distances to nearest N threats (for RL state)
    getThreatDistances(agent, threats, count = 4, maxDist = 300000) {
      const agentPos = { x: agent.x, y: agent.y, z: agent.z };
      const distances = threats.map(t => this._dist3(agentPos, t));
      distances.sort((a,b) => a - b);
      const result = new Float32Array(count).fill(1.0);
      for (let i = 0; i < Math.min(count, distances.length); i++) {
        result[i] = Math.min(1, distances[i] / maxDist);
      }
      return result;
    }

    // ── Missile fire decision ────────────────────────────────────
    // Returns { fires: bool, pk: float } for a given radar-agent pair

    evaluateMissileFire(radarSpec, agent, grid, tickMs = 100) {
      if (!radarSpec.missilePk) return { fires: false, pk: 0 };
      const agentPos = { x: agent.x, y: agent.y, z: agent.z };
      const radarPos = { x: agent._threatRef.x, y: 0, z: agent._threatRef.z };

      // Check range
      const jamERP = agent.jammerActive ? agent.spec.jammerERP : 0;
      const maxR = this.radarMaxRange(radarSpec, agent.spec.rcs, jamERP);
      const dist = this._dist3(agentPos, radarPos);
      if (dist > maxR) return { fires: false, pk: 0 };

      // Check LOS
      if (!this.losCheck(grid, agentPos, radarPos)) return { fires: false, pk: 0 };

      const pk = this.probabilityOfKill(radarSpec, agent);
      return { fires: true, pk };
    }

    _dist3(a, b) {
      const dx = a.x - (b.x || 0);
      const dy = a.y - (b.y || 0);
      const dz = a.z - (b.z || 0);
      return Math.sqrt(dx*dx + dy*dy + dz*dz);
    }
  }

  window.JADO.EWModel = new EWModel();
})();
