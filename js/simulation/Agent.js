// js/simulation/Agent.js
// Aircraft agent state, physics, and action application
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  let _agentCounter = 0;

  class Agent {
    /**
     * @param {object} spec      - UnitSpecs.AIRCRAFT entry
     * @param {object} startPos  - {x, y, z} world coords
     * @param {string} faction   - 'friendly' | 'enemy'
     * @param {string} role      - optional override
     */
    constructor(spec, startPos, faction = 'friendly') {
      this.id      = `${faction.toUpperCase()}_${spec.id}_${String(++_agentCounter).padStart(2,'0')}`;
      this.spec    = spec;
      this.faction = faction;

      // ── Position & kinematics ─────────────────────────────────
      this.x        = startPos.x;
      this.y        = startPos.y || 500; // default 500m altitude
      this.z        = startPos.z;
      this.altitude = this.y;
      this.heading  = 90;   // degrees, 0=North, 90=East
      this.speed    = spec.cruiseSpeed || 300; // m/s

      // ── State ─────────────────────────────────────────────────
      this.alive          = true;
      this.flares         = spec.flares || 0;
      this.jammerActive   = false;
      this.flaresDeploying = false;
      this._flareTimer    = 0;   // ticks remaining for flare effect
      this._jammerHeat    = 0;   // heat buildup (limits continuous use)

      // ── Navigation ────────────────────────────────────────────
      this.corridor          = null;  // array of {x,y,z} waypoints
      this.corridorWaypointIdx = 0;
      this.corridorDeviation = 0;     // meters from corridor
      this.startPos          = { x: this.x, y: this.y, z: this.z };
      this.targetPos         = null;
      this.progress          = 0;     // 0–1 toward target

      // ── Kill stats ────────────────────────────────────────────
      this.currentPk    = 0;    // current Pk% (0–1)
      this.peakPk       = 0;
      this.ticksAlive   = 0;
      this.kills        = 0;
      this.flightPath   = [];   // [{x,y,z,t}] telemetry

      // ── Threat reference (set by SimController per tick) ──────
      this._threatRef   = null;
    }

    // ── Action application (called by DQN or rule-based fallback) ──

    applyAction(actionSpec, terrainData, dt = 0.1) {
      if (!this.alive) return;

      const { dHeading = 0, dAlt = 0, jammerToggle = false, flare = false } = actionSpec;

      // --- Heading update (with bank rate limiting) ---
      const maxTurn = (this.spec.turnRate || 20) * dt;
      const headingDelta = Math.max(-maxTurn, Math.min(maxTurn, dHeading * dt * 5));
      this.heading = (this.heading + headingDelta + 360) % 360;

      // --- Altitude update (with climb rate limiting) ---
      const maxClimb = (this.spec.climbRate || 100) * dt;
      const altDelta = Math.max(-maxClimb, Math.min(maxClimb, dAlt * dt));
      const targetAlt = this.altitude + altDelta;

      // Terrain collision avoidance: enforce min clearance
      const terrainH = terrainData ? terrainData.grid.surfaceHeightAt(this.x, this.z) : 0;
      const minAlt = Math.max(this.spec.minAltitude || 30, terrainH + 30);
      this.altitude = Math.max(minAlt, Math.min(this.spec.maxAltitude || 15000, targetAlt));
      this.y = this.altitude;

      // --- Forward movement ---
      const rad = (this.heading - 90) * Math.PI / 180; // convert to standard math angle
      const dist = this.speed * dt;
      this.x += Math.cos(rad) * dist;
      this.z += Math.sin(rad) * dist;

      // Clamp to terrain bounds
      if (terrainData) {
        const ws = terrainData.worldSizeX;
        const wz = terrainData.worldSizeZ;
        this.x = Math.max(0, Math.min(ws, this.x));
        this.z = Math.max(0, Math.min(wz, this.z));
      }

      // --- Jammer ---
      if (jammerToggle && this.spec.jammerERP > 0) {
        if (!this.jammerActive) {
          this.jammerActive = true;
        } else {
          this.jammerActive = false;
        }
      }

      // --- Flares ---
      if (flare && this.flares > 0 && !this.flaresDeploying) {
        this.flares--;
        this.flaresDeploying = true;
        this._flareTimer = 15; // 15 ticks (~1.5 seconds)
      }
      if (this._flareTimer > 0) {
        this._flareTimer--;
        if (this._flareTimer <= 0) this.flaresDeploying = false;
      }

      // --- Update corridor deviation ---
      this._updateCorridorDeviation();

      // --- Track flight path (every 5 ticks) ---
      this.ticksAlive++;
      if (this.ticksAlive % 5 === 0) {
        this.flightPath.push({ x: this.x, y: this.y, z: this.z, t: Date.now() });
        if (this.flightPath.length > 500) this.flightPath.shift();
      }
    }

    // Corridor following: find nearest waypoint and update deviation
    _updateCorridorDeviation() {
      if (!this.corridor || this.corridor.length === 0) {
        this.corridorDeviation = 0;
        return;
      }
      let minDist = Infinity;
      let bestIdx = this.corridorWaypointIdx;
      // Search forward from current waypoint
      const searchRange = Math.min(this.corridor.length, this.corridorWaypointIdx + 20);
      for (let i = this.corridorWaypointIdx; i < searchRange; i++) {
        const wp = this.corridor[i];
        const d = Math.sqrt((this.x - wp.x)**2 + (this.y - wp.y)**2 + (this.z - wp.z)**2);
        if (d < minDist) { minDist = d; bestIdx = i; }
      }
      this.corridorDeviation = minDist;
      this.corridorWaypointIdx = bestIdx;

      // Advance waypoint if close enough
      while (this.corridorWaypointIdx < this.corridor.length - 1) {
        const wp = this.corridor[this.corridorWaypointIdx];
        const d = Math.sqrt((this.x - wp.x)**2 + (this.y - wp.y)**2 + (this.z - wp.z)**2);
        if (d < 200) this.corridorWaypointIdx++;
        else break;
      }
    }

    // Assign a corridor path to this agent
    setCorridor(path, corridorType) {
      this.corridor = path;
      this.corridorType = corridorType;
      this.corridorWaypointIdx = 0;
    }

    // Get current world position as object
    getPos() { return { x: this.x, y: this.y, z: this.z }; }

    distanceTo(pos) {
      return Math.sqrt((this.x - pos.x)**2 + (this.y - pos.y)**2 + (this.z - pos.z)**2);
    }

    die(cause = 'MISSILE') {
      this.alive = false;
      this.cause = cause;
      window.JADO.log(`${this.id} DESTROYED (${cause})`, 'kill');
    }

    // Summary for telemetry display
    getStatus() {
      return {
        id:       this.id,
        type:     this.spec.name,
        faction:  this.faction,
        alive:    this.alive,
        x: this.x, y: this.y, z: this.z,
        altitude: this.altitude,
        heading:  this.heading,
        speed:    this.speed,
        pk:       this.currentPk,
        flares:   this.flares,
        jammer:   this.jammerActive,
        corridor: this.corridorType || 'none',
        deviation:this.corridorDeviation,
        ticksAlive: this.ticksAlive,
      };
    }

    static resetCounter() { _agentCounter = 0; }
  }

  window.JADO.Agent = Agent;
})();
