// js/rl/RLEnvironment.js
// Gymnasium-style environment wrapper for the JADO simulation
// Provides: observe(), step(), reward(), reset() for each agent
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  class RLEnvironment {
    /**
     * @param {VoxelGrid}     grid
     * @param {EWModel}       ew
     * @param {Array<object>} threats  - placed threat objects
     * @param {object}        targetPos - {x,y,z} world coordinates
     * @param {string}        corridorType - 'fastest'|'lowAlt'|'balanced'
     */
    constructor(grid, ew, threats, targetPos, corridorType = 'balanced') {
      this.grid        = grid;
      this.ew          = ew;
      this.threats     = threats;
      this.targetPos   = targetPos;
      this.corridorType = corridorType;

      // Per-agent previous states for reward delta calculations
      this._prevProgress = new Map();
      this._prevAlt      = new Map();
    }

    // ── Observation building (38-dim state vector) ────────────────
    // Matches the DQNAgent stateSize = 38
    // [0-26]  Local 3×3×3 voxel window (27)
    // [27]    Altitude normalized
    // [28-29] Heading sin/cos
    // [30]    Speed normalized
    // [31]    Flares remaining normalized
    // [32]    Jammer active
    // [33]    Corridor deviation normalized
    // [34-37] 4 nearest threat distances normalized

    observe(agent) {
      const state = new Float32Array(38);

      // Local voxel window (27)
      const window = this.grid.getLocalWindow(agent.x, agent.y, agent.z);
      state.set(window, 0);

      // Scalar features (starting at index 27)
      state[27] = agent.altitude / (this.grid.dimY * this.grid.voxelSize);
      state[28] = Math.sin(agent.heading * Math.PI / 180);
      state[29] = Math.cos(agent.heading * Math.PI / 180);
      state[30] = agent.speed / (agent.spec ? agent.spec.maxSpeed : 600);
      state[31] = (agent.spec && agent.spec.flares > 0) ? agent.flares / agent.spec.flares : 0;
      state[32] = agent.jammerActive ? 1.0 : 0.0;

      // Corridor deviation
      const maxDev = 2000; // meters
      state[33] = Math.min(1, agent.corridorDeviation / maxDev);

      // 4 nearest threat distances
      const threatDists = this.ew.getThreatDistances(agent, this.threats);
      state[34] = threatDists[0] || 1.0;
      state[35] = threatDists[1] || 1.0;
      state[36] = threatDists[2] || 1.0;
      state[37] = threatDists[3] || 1.0;

      return state;
    }

    // ── Reward computation ────────────────────────────────────────

    computeReward(agent, prevState, done, killed, reachedTarget) {
      let reward = 0;

      // 1. Survival: base per-tick reward
      reward += 0.5;

      // 2. Corridor adherence
      if (agent.corridorDeviation < 500) reward += 1.5;
      else if (agent.corridorDeviation < 1500) reward += 0.5;
      else reward -= 1.0;

      // 3. Threat exposure penalty
      const threatLevel = this.ew.getThreatLevel(agent, this.threats, this.grid);
      reward -= threatLevel * 8.0;

      // 4. Progress toward target
      const curProgress = this._computeProgress(agent);
      const prevProgress = this._prevProgress.get(agent.id) || 0;
      reward += (curProgress - prevProgress) * 20.0;
      this._prevProgress.set(agent.id, curProgress);

      // 5. Altitude optimization (too high = radar exposed, too low = terrain risk)
      const terrainH = this.grid.surfaceHeightAt(agent.x, agent.z);
      const clearance = agent.altitude - terrainH;
      if (clearance < 50) reward -= 3.0;      // terrain collision risk
      else if (clearance < 200) reward += 0.5; // good nap-of-earth
      else if (agent.altitude > 8000) reward -= 1.0; // too high, radar exposed

      // 6. Jammer usage
      if (agent.jammerActive && agent.spec && agent.spec.jammerERP > 0 && threatLevel > 0.3) {
        reward += 1.0; // correct use of EW
      }

      // 7. Flare use (only reward if missile threat present)
      if (agent.flaresDeploying && threatLevel > 0.5) reward += 2.0;

      // 8. Terminal rewards
      if (killed)         reward -= 100.0;
      if (reachedTarget)  reward += 500.0;

      return reward;
    }

    _computeProgress(agent) {
      if (!this.targetPos) return 0;
      const corridor = agent.corridor;
      if (!corridor || corridor.length === 0) {
        // Fallback: straight-line progress
        const totalDist = this._dist3(agent.startPos, this.targetPos);
        const remDist   = this._dist3({ x: agent.x, y: agent.y, z: agent.z }, this.targetPos);
        return Math.max(0, Math.min(1, 1 - remDist / Math.max(1, totalDist)));
      }

      // Progress along corridor
      const agentPos = { x: agent.x, y: agent.y, z: agent.z };
      let minDist = Infinity;
      let bestIdx = 0;
      for (let i = 0; i < corridor.length; i++) {
        const d = this._dist3(agentPos, corridor[i]);
        if (d < minDist) { minDist = d; bestIdx = i; }
      }
      return bestIdx / Math.max(1, corridor.length - 1);
    }

    // ── Episode reset ─────────────────────────────────────────────

    reset(agent) {
      this._prevProgress.set(agent.id, 0);
      this._prevAlt.set(agent.id, agent.altitude);
    }

    // ── Done condition ────────────────────────────────────────────

    isDone(agent) {
      if (!agent.alive) return { done: true, killed: true, reached: false };
      if (!this.targetPos) return { done: false, killed: false, reached: false };
      const d = this._dist3({ x: agent.x, y: agent.y, z: agent.z }, this.targetPos);
      if (d < 300) return { done: true, killed: false, reached: true };
      return { done: false, killed: false, reached: false };
    }

    _dist3(a, b) {
      if (!a || !b) return 999999;
      return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
    }
  }

  window.JADO.RLEnvironment = RLEnvironment;
})();
