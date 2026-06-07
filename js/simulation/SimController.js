// js/simulation/SimController.js
// Master simulation tick loop — orchestrates RL agents, EW model, telemetry
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  const TICK_RATE_HZ = 10; // simulation ticks per second

  class SimController {
    /**
     * @param {object} config
     *   .agents     - array of Agent
     *   .threats     - array of {id, spec, x, z, ...}
     *   .grid        - VoxelGrid
     *   .terrainData - full terrain data from generator/loader
     *   .corridors   - {fastest, lowAlt, balanced}
     *   .targetPos   - {x, y, z}
     *   .missionId   - string
     *   .cache       - TelemetryCache
     *   .ew          - EWModel
     *   .dqnAgent    - DQNAgent
     *   .rlEnv       - RLEnvironment
     */
    constructor(config) {
      this.agents      = config.agents     || [];
      this.threats     = config.threats    || [];
      this.grid        = config.grid;
      this.terrainData = config.terrainData;
      this.corridors   = config.corridors  || {};
      this.targetPos   = config.targetPos;
      this.missionId   = config.missionId;
      this.cache       = config.cache;
      this.ew          = config.ew;
      this.dqnAgent    = config.dqnAgent;
      this.rlEnv       = config.rlEnv;

      this.tick        = 0;
      this.running     = false;
      this._speed      = 1;
      this._interval   = null;
      this._prevStates = new Map(); // agent.id → previous observation
      this._missileCD  = new Map(); // threat.id → cooldown ticks remaining

      // Callbacks
      this._callbacks  = { tick: [], death: [], complete: [], pathUpdate: [] };

      // Stats
      this.stats = {
        ticksTotal: 0, agentsAlive: 0, agentsKilled: 0,
        missilesFired: 0, missileKills: 0,
      };

      // Assign corridors to agents
      this._assignCorridors();

      // Assign threat zones to cache
      this._initThreatCache();

      // Initialize RL env for each agent
      this.agents.forEach(a => {
        if (this.rlEnv) this.rlEnv.reset(a);
        a.startPos = { x: a.x, y: a.y, z: a.z };
        a.targetPos = this.targetPos;
      });
    }

    // ── Lifecycle ─────────────────────────────────────────────────

    start() {
      if (this.running) return;
      this.running = true;
      const intervalMs = Math.round(1000 / TICK_RATE_HZ / this._speed);
      this._interval = setInterval(() => this._tick(), intervalMs);
      JADO.log('Mission STARTED', 'info');
      this._emit('tick');
    }

    pause() {
      if (!this.running) return;
      this.running = false;
      clearInterval(this._interval);
      this._interval = null;
      JADO.log('Simulation PAUSED', 'info');
    }

    reset() {
      this.pause();
      this.tick = 0;
      this.stats = { ticksTotal: 0, agentsAlive: 0, agentsKilled: 0, missilesFired: 0, missileKills: 0 };
      this._missileCD.clear();
      this._prevStates.clear();
      if (this.dqnAgent) this.dqnAgent.endEpisode();
      JADO.log('Simulation RESET', 'info');
    }

    setSpeed(mult) {
      this._speed = mult;
      if (this.running) { this.pause(); this.start(); }
    }

    on(event, cb) {
      if (this._callbacks[event]) this._callbacks[event].push(cb);
    }

    _emit(event, data) {
      (this._callbacks[event] || []).forEach(cb => { try { cb(data); } catch(e){} });
    }

    // ── Main Tick ─────────────────────────────────────────────────

    async _tick() {
      this.tick++;
      this.stats.ticksTotal++;
      const dt = (1 / TICK_RATE_HZ) * this._speed; // simulated seconds per tick

      let anyAlive = false;
      let allDone  = true;

      for (const agent of this.agents) {
        if (!agent.alive) continue;
        anyAlive = true;

        // 1. Build RL observation
        const obs = this.rlEnv ? this.rlEnv.observe(agent) : null;
        const prevObs = this._prevStates.get(agent.id) || (obs ? new Float32Array(obs.length) : null);

        // 2. DQN action selection
        let actionIdx = 0;
        if (obs && this.dqnAgent) {
          actionIdx = this.dqnAgent.act(Array.from(obs));
        }
        const actionSpec = (this.dqnAgent ? this.dqnAgent.getActionSpec(actionIdx) : JADO.DQNAgent.ACTIONS[0]);

        // 3. Apply action to agent physics
        agent.applyAction(actionSpec, this.terrainData, dt);

        // 4. EW evaluation — check each threat
        let killed = false;
        for (const threat of this.threats) {
          if (!threat.spec || !threat.spec.missilePk) continue;

          // Cooldown check
          const cdKey = `${threat.id}-${agent.id}`;
          const cd = this._missileCD.get(cdKey) || 0;
          if (cd > 0) { this._missileCD.set(cdKey, cd - 1); continue; }

          const agentPos   = agent.getPos();
          const threatPos  = { x: threat.x, y: threat.y || 0, z: threat.z };
          const jammerERP  = agent.jammerActive ? agent.spec.jammerERP : 0;
          const maxRange   = this.ew.radarMaxRange(threat.spec, agent.spec.rcs, jammerERP);
          const dist       = agent.distanceTo(threatPos);

          if (dist > maxRange) { agent.currentPk = 0; continue; }
          const hasLOS = this.ew.losCheck(this.grid, agentPos, threatPos);
          if (!hasLOS) { agent.currentPk = 0; continue; }

          // Compute Pk
          agent._threatRef = threat;
          const pk = this.ew.probabilityOfKill(threat.spec, agent);
          agent.currentPk = Math.max(agent.currentPk, pk);
          agent.peakPk    = Math.max(agent.peakPk, pk);

          // Stochastic missile fire
          if (Math.random() < pk * dt * 0.5) {
            this.stats.missilesFired++;
            if (Math.random() < pk) {
              agent.die(`MISSILE (${threat.spec.name})`);
              killed = true;
              this.stats.missileKills++;
              this._emit('death', agent);
              JADO.log(`☠ ${agent.id} killed by ${threat.spec.name} (Pk=${(pk*100).toFixed(0)}%)`, 'kill');
            } else {
              JADO.log(`⚠ Missile missed ${agent.id} (Pk=${(pk*100).toFixed(0)}%)`, 'warn');
            }
            // Set cooldown
            this._missileCD.set(cdKey, Math.floor(threat.spec.reloadTime / (100 / this._speed)));
          }
        }

        // 5. RL: compute reward, store experience, train
        if (obs && this.dqnAgent && this.rlEnv) {
          const { done, reached } = this.rlEnv.isDone(agent);
          const reward = this.rlEnv.computeReward(agent, prevObs, done, killed, reached);
          const nextObs = killed ? new Float32Array(obs.length) : this.rlEnv.observe(agent);
          this.dqnAgent.remember(
            Array.from(prevObs),
            actionIdx,
            reward,
            Array.from(nextObs),
            done
          );
          this._prevStates.set(agent.id, nextObs);

          if (reached) {
            JADO.log(`✓ ${agent.id} REACHED TARGET!`, 'info');
            this.dqnAgent.endEpisode();
            this._emit('complete', { agent, reason: 'target_reached' });
          }
          if (!done) allDone = false;
        } else {
          allDone = false;
        }

        // 6. Push telemetry to cache (the Redis equivalent)
        this.cache.setAgentPos(
          this.missionId, agent.id,
          agent.x, agent.y, agent.z,
          agent.heading, agent.alive, agent.currentPk
        );
        // History for charts
        this.cache.pushHistory(this.missionId, agent.id, 'altitude', agent.altitude);
        this.cache.pushHistory(this.missionId, agent.id, 'speed',    agent.speed);
        this.cache.pushHistory(this.missionId, agent.id, 'pk',       agent.currentPk);

        // Reset Pk for next tick (accumulates fresh each tick)
        if (!killed) agent.currentPk = 0;
      }

      // 7. Train DQN (async, every 5 ticks to avoid UI blocking)
      if (this.dqnAgent && this.tick % 5 === 0) {
        this.dqnAgent.train().catch(() => {});
      }

      // 8. Update stats
      this.stats.agentsAlive = this.agents.filter(a => a.alive).length;
      this.stats.agentsKilled = this.agents.filter(a => !a.alive).length;

      // 9. Mission end check
      if (!anyAlive) {
        this.pause();
        JADO.log('All agents lost — MISSION FAILED', 'danger');
        this._emit('complete', { reason: 'all_dead' });
        if (this.dqnAgent) { this.dqnAgent.endEpisode(); this.dqnAgent.save(); }
      }

      // 10. Emit tick event for UI refresh
      this._emit('tick', { tick: this.tick, stats: this.stats });
    }

    // ── Setup helpers ─────────────────────────────────────────────

    _assignCorridors() {
      const types = ['fastest', 'lowAlt', 'balanced'];
      this.agents.forEach((agent, i) => {
        const type = types[i % types.length];
        const path = this.corridors[type];
        if (path) agent.setCorridor(path, type);
      });
    }

    _initThreatCache() {
      this.threats.forEach(threat => {
        this.cache.addThreatZone(
          this.missionId, threat.id,
          threat.x, 0, threat.z,
          (threat.spec ? threat.spec.radius : 50000),
          threat.spec ? threat.spec.type : 'UNKNOWN'
        );
      });
    }

    // ── After-action report ───────────────────────────────────────

    generateAAR() {
      return {
        missionId: this.missionId,
        timestamp: new Date().toISOString(),
        duration_ticks: this.tick,
        duration_seconds: this.tick / TICK_RATE_HZ,
        stats: { ...this.stats },
        agents: this.agents.map(a => ({
          id: a.id, type: a.spec.name, faction: a.faction,
          survived: a.alive, ticksAlive: a.ticksAlive,
          peakPk: (a.peakPk * 100).toFixed(1) + '%',
          corridorType: a.corridorType || 'none',
          flightPathPoints: a.flightPath.length,
          cause: a.cause || null,
          flightPath: a.flightPath,
        })),
        threats: this.threats.map(t => ({
          id: t.id, type: t.spec ? t.spec.name : 'Unknown',
          position: { x: t.x, z: t.z },
        })),
        rlStats: this.dqnAgent ? this.dqnAgent.getStats() : null,
      };
    }
  }

  window.JADO.SimController = SimController;
})();
