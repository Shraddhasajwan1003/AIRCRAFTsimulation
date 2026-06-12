// js/ui/UIManager.js
// Manages all UI interactions: placement modes, form inputs, event bindings
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  class UIManager {
    constructor() {
      this._placementMode = null;
      this._pendingPlacement = null;
      this._toastTimeout = null;
      this._missionClock = 0;
      this._clockInterval = null;
      this._weatherSpec = JADO.UnitSpecs.WEATHER.clear;
    }

    // ── Terrain ───────────────────────────────────────────────────

    loadTerrainFile() {
      document.getElementById('terrain-file-input').click();
    }

    async handleTerrainFile(file) {
      if (!file) return;
      this.toast('Loading terrain file...', 'info');
      try {
        const resolution = parseInt(document.getElementById('terrain-resolution').value);
        const data = await JADO.TerrainLoader.loadFile(file, resolution);
        this._applyTerrain(data);
        this.toast(`Terrain loaded: ${file.name}`, 'success');
      } catch(e) {
        this.toast('Error loading terrain: ' + e.message, 'error');
        console.error(e);
      }
    }

    generateProceduralTerrain() {
      const resolution = parseInt(document.getElementById('terrain-resolution').value) || 50;
      const seed = Math.floor(Math.random() * 99999);
      this.toast('Generating procedural terrain...', 'info');
      setTimeout(() => {
        const data = JADO.TerrainGenerator.generate({
          worldSizeX: 5000, worldSizeZ: 5000,
          maxHeight: 1200, voxelSize: resolution, seed,
        });
        this._applyTerrain(data);
        this.toast('Procedural terrain ready', 'success');
      }, 50); // slight delay to let toast render
    }

    _applyTerrain(data) {
      JADO.state.terrainData = data;
      JADO.state.grid        = data.grid;
      JADO.Renderer.loadTerrain(data);
      JADO.EW.setWeather(this._weatherSpec);

      const g = data.geoInfo || {};
      const voxels = `${data.dimX}×${data.dimZ}×${data.dimY}`;
      JADO.log(`Terrain loaded: ${voxels} voxels (${data.voxelSize}m)`, 'info');

      if (g.hasGeoRef) {
        if (g.lat != null && g.lon != null)
          JADO.log(`  🌐 Centre: ${g.lat.toFixed(5)}°N, ${g.lon.toFixed(5)}°E`, 'info');
        if (g.minLat != null)
          JADO.log(`  Bounds: ${g.minLat.toFixed(4)}°N–${g.maxLat.toFixed(4)}°N  ${g.minLon.toFixed(4)}°E–${g.maxLon.toFixed(4)}°E`, 'info');
        JADO.log(`  Elevation: ${g.elevMin}m – ${g.elevMax}m  (Δ${g.altRange}m)`, 'info');
        if (g.crs)    JADO.log(`  CRS: ${g.crs}`, 'info');
        if (g.source) JADO.log(`  Source: ${g.source}`, 'info');
      }

      this._showTerrainInfo(g, data);
    }

    _showTerrainInfo(g, data) {
      const el = document.getElementById('terrain-info-box');
      if (!el) return;

      if (!g || !g.hasGeoRef) {
        el.innerHTML = `<div class="ti-row"><span>Size</span><span>${data.dimX}×${data.dimZ} voxels</span></div>
          <div class="ti-row"><span>Voxel</span><span>${data.voxelSize} m</span></div>
          <div class="ti-row"><span>Max Alt</span><span>${Math.round(data.maxHeight)} m</span></div>`;
        el.classList.remove('hidden');
        return;
      }

      let html = '';
      if (g.lat != null && g.lon != null) {
        html += `<div class="ti-row geo"><span>🌐 LAT</span><span>${g.lat.toFixed(5)}°N</span></div>`;
        html += `<div class="ti-row geo"><span>🌐 LON</span><span>${g.lon.toFixed(5)}°E</span></div>`;
      }
      if (g.minLat != null) {
        html += `<div class="ti-row"><span>N Bound</span><span>${g.minLat.toFixed(4)}° – ${g.maxLat.toFixed(4)}°</span></div>`;
        html += `<div class="ti-row"><span>E Bound</span><span>${g.minLon.toFixed(4)}° – ${g.maxLon.toFixed(4)}°</span></div>`;
      }
      if (g.elevMin != null) {
        html += `<div class="ti-row"><span>Elev Min</span><span>${g.elevMin} m</span></div>`;
        html += `<div class="ti-row"><span>Elev Max</span><span>${g.elevMax} m</span></div>`;
        html += `<div class="ti-row"><span>Δ Alt</span><span>${g.altRange} m</span></div>`;
      }
      if (g.crs)    html += `<div class="ti-row"><span>CRS</span><span>${g.crs}</span></div>`;
      if (g.source) html += `<div class="ti-row"><span>Source</span><span style="font-size:8px">${g.source.slice(0,30)}</span></div>`;
      html += `<div class="ti-row"><span>Conv.</span><span>${g.convention || 'Y_UP'}</span></div>`;
      html += `<div class="ti-row"><span>Voxel</span><span>${data.voxelSize} m</span></div>`;

      el.innerHTML = html;
      el.classList.remove('hidden');

      // Also update HUD if geo-ref
      if (JADO.Renderer && g.lat != null) {
        JADO.Renderer.setGeoHUD(g);
      }
    }

    // ── Friendly aircraft placement ───────────────────────────────

    startPlaceFriendly() {
      if (!JADO.state.terrainData) { this.toast('Load terrain first', 'warn'); return; }
      const specKey = document.getElementById('friendly-type').value;
      const spec    = JADO.UnitSpecs.AIRCRAFT[specKey];
      this._showPlacementBanner(`Click map to place ${spec.name}`);
      JADO.Renderer.startPlacement('friendly', (pos) => {
        this._hidePlacementBanner();
        const terrainH = JADO.state.terrainData.grid.surfaceHeightAt(pos.x, pos.z);
        pos.y = Math.max(terrainH + 200, 500);
        const agent = new JADO.Agent(spec, pos, 'friendly');
        JADO.state.agents.push(agent);
        JADO.Renderer.addAgent(agent);
        this._addUnitListItem('friendly-list', agent.id, spec.name, () => {
          JADO.state.agents = JADO.state.agents.filter(a => a.id !== agent.id);
          JADO.Renderer.removeAgent(agent.id);
        });
        JADO.log(`Placed ${agent.id} at (${Math.round(pos.x)}, ${Math.round(pos.z)})`, 'info');
        document.getElementById('agent-count').textContent = JADO.state.agents.length;
      });
    }

    // ── Threat placement ──────────────────────────────────────────

    startPlaceThreat() {
      if (!JADO.state.terrainData) { this.toast('Load terrain first', 'warn'); return; }
      const specKey = document.getElementById('threat-type').value;
      const spec    = JADO.UnitSpecs.THREATS[specKey];
      this._showPlacementBanner(`Click map to place ${spec.name}`);
      JADO.Renderer.startPlacement('threat', (pos) => {
        this._hidePlacementBanner();
        const threat = {
          id:   `THR_${specKey}_${Date.now()}`,
          spec, x: pos.x, z: pos.z, y: 0,
        };
        JADO.state.threats.push(threat);
        JADO.Renderer.addThreat(threat);
        
        const radiusM = spec.radius || 50000;

        if (JADO.state.cache) {
          JADO.state.cache.addThreatZone(
            JADO.state.missionId, threat.id,
            threat.x, 0, threat.z,
            radiusM, spec.type
          );
        }
        this._addUnitListItem('threat-list', threat.id, spec.name, () => {
          JADO.state.threats = JADO.state.threats.filter(t => t.id !== threat.id);
          JADO.Renderer.clearAllThreats();
          JADO.state.threats.forEach(t => JADO.Renderer.addThreat(t));
        });
        JADO.log(`Placed ${spec.name} at (${Math.round(pos.x)}, ${Math.round(pos.z)})`, 'warn');
        document.getElementById('threat-count').textContent = JADO.state.threats.length;
      });
    }

    // ── Obstacle placement ────────────────────────────────────────

    startPlaceObstacle() {
      if (!JADO.state.terrainData) { this.toast('Load terrain first', 'warn'); return; }
      const typeKey = document.getElementById('obstacle-type').value;
      const spec    = JADO.UnitSpecs.OBSTACLES[typeKey];
      const size    = parseInt(document.getElementById('obstacle-size').value) || 3;
      const sizeM   = size * 100;

      this._showPlacementBanner('Click map to place obstacle');
      JADO.Renderer.startPlacement('obstacle', (pos) => {
        this._hidePlacementBanner();
        // Mark voxel grid
        if (JADO.state.grid) {
          const vc = JADO.state.grid.worldToVoxel(pos.x, pos.y, pos.z);
          const halfV = Math.ceil(size / 2);
          JADO.state.grid.setBox(vc.x, vc.y, vc.z, halfV, halfV * spec.heightMult, halfV, JADO.VoxelGrid.TYPE.OBSTACLE);
          JADO.state.grid.inflateZone(JADO.VoxelGrid.TYPE.OBSTACLE, 3); // 3-voxel safety margin for obstacles
        }
        JADO.Renderer.addObstacle(pos, sizeM, parseInt(spec.color.replace('#',''), 16));
        JADO.log(`Placed ${spec.name} obstacle at (${Math.round(pos.x)}, ${Math.round(pos.z)})`, 'info');
      });
    }

    // ── Target placement ──────────────────────────────────────────

    startPlaceTarget() {
      if (!JADO.state.terrainData) { this.toast('Load terrain first', 'warn'); return; }
      this._showPlacementBanner('Click map to set mission target');
      JADO.Renderer.startPlacement('target', (pos) => {
        this._hidePlacementBanner();
        pos.y = JADO.state.terrainData.grid.surfaceHeightAt(pos.x, pos.z);
        JADO.state.targetPos = pos;
        // Remove old target marker
        if (JADO.state._targetMarker) {
          JADO.Renderer._scene.remove(JADO.state._targetMarker);
        }
        JADO.state._targetMarker = JADO.Renderer.addTarget(pos);
        document.getElementById('target-coords-display').textContent =
          `X:${Math.round(pos.x)} Z:${Math.round(pos.z)}`;
        JADO.log(`Target set at (${Math.round(pos.x)}, ${Math.round(pos.z)})`, 'info');
      });
    }

    // ── Clear target ──────────────────────────────────────────────

    clearTarget() {
      if (JADO.state._targetMarker) {
        JADO.Renderer._scene.remove(JADO.state._targetMarker);
        JADO.state._targetMarker = null;
      }
      JADO.state.targetPos = null;
      document.getElementById('target-coords-display').textContent = 'Not set';
      JADO.log('Mission target cleared', 'info');
      this.toast('Target cleared', 'info');
    }

    // ── Path planning ─────────────────────────────────────────────

    computePaths() {
      if (!JADO.state.grid) { this.toast('Load terrain first', 'warn'); return; }
      if (!JADO.state.agents.length) { this.toast('Place aircraft first', 'warn'); return; }
      if (!JADO.state.targetPos) { this.toast('Set mission target first', 'warn'); return; }

      this.toast('Computing A* corridors...', 'info');
      const btn = document.getElementById('btn-compute-paths');
      if (btn) btn.disabled = true;

      setTimeout(() => {
        try {
          const startPos = JADO.state.agents[0].getPos();
          const pathfinder = new JADO.AStar3D(JADO.state.grid);
          const corridors = pathfinder.planCorridors(startPos, JADO.state.targetPos);

          JADO.state.corridors = corridors;
          if (JADO.state.cache) {
            JADO.state.cache.setCorridors(JADO.state.missionId, corridors);
          }

          const found = Object.entries(corridors).filter(([,v]) => v !== null).length;
          JADO.Renderer.setCorridors(corridors);

          if (found === 0) {
            this.toast('No paths found — check start/target positions', 'error');
          } else {
            this.toast(`Found ${found}/3 corridors. Ready to run.`, 'success');
            JADO.log(`A* complete: ${found}/3 corridors found`, 'info');
            Object.entries(corridors).forEach(([type, path]) => {
              if (path) JADO.log(`  ${type}: ${path.length} waypoints`, 'info');
            });
            // Show corridor stats in right panel
            this._showCorridorStats(JADO.state.corridorStats);
          }
        } catch(e) {
          this.toast('Pathfinding error: ' + e.message, 'error');
          console.error(e);
        }
        if (btn) btn.disabled = false;
      }, 100);
    }

    // ── Corridor stats display ────────────────────────────────────

    _showCorridorStats(stats) {
      const container = document.getElementById('path-stats-content');
      if (!container || !stats) return;

      const corColors = { shortest: '#00ff88', safest: '#ffdd00', balanced: '#00ccff', fastest: '#00ff88', lowAlt: '#ffdd00' };
      const corLabels = { shortest: '⚡ Shortest', safest: '🛡️ Safest', balanced: '⚖ Balanced', fastest: '⚡ Fastest', lowAlt: '↓ Low-Alt' };

      container.innerHTML = Object.entries(stats).map(([type, s]) => {
        if (!s) return `<div class="path-stat-block" style="border-left:2px solid #333">
          <div class="path-stat-title" style="color:#304060">${corLabels[type] || type} — NO PATH</div>
        </div>`;
        return `<div class="path-stat-block" style="border-left:2px solid ${corColors[type] || '#444'}">
          <div class="path-stat-title" style="color:${corColors[type] || '#aaa'}">${corLabels[type] || type}</div>
          <div class="path-stat-row"><span>Length</span><span>${s.lengthKm} km</span></div>
          <div class="path-stat-row"><span>Waypoints</span><span>${s.waypoints}</span></div>
          <div class="path-stat-row"><span>Min Alt</span><span>${s.minAlt} m</span></div>
          <div class="path-stat-row"><span>Max Alt</span><span>${s.maxAlt} m</span></div>
          <div class="path-stat-row"><span>Avg Alt</span><span>${s.avgAlt} m</span></div>
          <div class="path-stat-row"><span>Computed</span><span>${s.computeMs} ms</span></div>
        </div>`;
      }).join('');
    }


    // ── Corridor visibility toggles ───────────────────────────────

    toggleCorridor(type, show) { JADO.Renderer.toggleCorridor(type, show); }

    // ── Grid / Voxel overlays ─────────────────────────────────────

    toggleGrid() { JADO.Renderer.toggleGrid(); }

    toggleVoxels() {
      this._voxelsVisible = !this._voxelsVisible;
      JADO.Renderer.toggleVoxels(this._voxelsVisible);
      this.toast(`Voxel view ${this._voxelsVisible ? 'enabled' : 'disabled'}`, 'info');
    }

    // ── Cancel placement ──────────────────────────────────────────

    cancelPlacement() {
      JADO.Renderer.cancelPlacement();
      this._hidePlacementBanner();
    }

    // ── Weather ───────────────────────────────────────────────────

    applyWeather() {
      const key  = document.getElementById('weather-type').value;
      this._weatherSpec = JADO.UnitSpecs.WEATHER[key];
      JADO.EW.setWeather(this._weatherSpec);
      JADO.log(`Weather set: ${this._weatherSpec.name} (radar ×${this._weatherSpec.radarMult})`, 'info');
    }

    // ── Simulation controls ───────────────────────────────────────

    startSim() {
      if (!JADO.state.terrainData) { this.toast('Load terrain first', 'warn'); return; }
      if (!JADO.state.agents.length) { this.toast('Place aircraft first', 'warn'); return; }

      this.applyWeather();

      // Build or rebuild sim controller
      const corridors = JADO.state.corridors || {};
      const rlEnv = new JADO.RLEnvironment(
        JADO.state.grid, JADO.EW,
        JADO.state.threats,
        JADO.state.targetPos,
        'balanced'
      );

      JADO.state.sim = new JADO.SimController({
        agents:      JADO.state.agents,
        threats:     JADO.state.threats,
        grid:        JADO.state.grid,
        terrainData: JADO.state.terrainData,
        corridors,
        targetPos:   JADO.state.targetPos,
        missionId:   JADO.state.missionId,
        cache:       JADO.state.cache,
        ew:          JADO.EW,
        dqnAgent:    JADO.state.dqnAgent,
        rlEnv,
      });

      JADO.state.sim.on('tick', (data) => this._onTick(data));
      JADO.state.sim.on('death', (agent) => this._onAgentDeath(agent));
      JADO.state.sim.on('complete', (data) => this._onMissionComplete(data));

      JADO.state.sim.start();
      this._startClock();
      this._setSimStatus('RUNNING');

      document.getElementById('btn-run').disabled   = true;
      document.getElementById('btn-pause').disabled = false;

      // Show RL indicator
      const rlInd = document.getElementById('rl-indicator');
      if (rlInd) rlInd.classList.remove('hidden');
    }

    pauseSim() {
      if (JADO.state.sim) JADO.state.sim.pause();
      this._stopClock();
      this._setSimStatus('PAUSED');
      document.getElementById('btn-run').disabled   = false;
      document.getElementById('btn-pause').disabled = true;
    }

    resetSim() {
      if (JADO.state.sim) JADO.state.sim.reset();
      this._stopClock();
      this._missionClock = 0;
      this._updateClock();
      this._setSimStatus('STANDBY');
      document.getElementById('btn-run').disabled   = false;
      document.getElementById('btn-pause').disabled = true;
      // Reset agent visuals
      JADO.state.agents.forEach(a => {
        a.alive = true; a.currentPk = 0; a.flightPath = [];
        JADO.Renderer.updateAgent(a);
      });
      const rlInd = document.getElementById('rl-indicator');
      if (rlInd) rlInd.classList.add('hidden');
    }

    setSimSpeed(mult) {
      if (JADO.state.sim) JADO.state.sim.setSpeed(mult);
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      const speedMap = { 1: 'spd-1x', 2: 'spd-2x', 5: 'spd-5x', 10: 'spd-10x' };
      const el = document.getElementById(speedMap[mult]);
      if (el) el.classList.add('active');
    }

    // ── Tick event ────────────────────────────────────────────────

    _onTick(data) {
      // Update agent visuals
      JADO.state.agents.forEach(a => JADO.Renderer.updateAgent(a));

      // Update telemetry panel
      if (JADO.state.telemetry) {
        JADO.state.telemetry.refresh(JADO.state.agents);
      }

      // Update header counts
      if (data && data.stats) {
        document.getElementById('agent-count').textContent = data.stats.agentsAlive;
        document.getElementById('threat-count').textContent = JADO.state.threats.length;
        document.getElementById('tick-counter').textContent = data.tick;
      }

      // Update RL training stats
      if (JADO.state.dqnAgent) {
        const s = JADO.state.dqnAgent.getStats();
        const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
        set('rl-ep-count',    s.episodes);
        set('rl-eps-val',     s.epsilon);
        set('rl-avg-reward',  s.avgReward);
        set('rl-memory-size', `${s.memory} / 5000`);
        set('rl-train-steps', s.trainSteps);
        set('rl-epsilon',     'ε: ' + s.epsilon);
        set('rl-episodes',    'Ep: ' + s.episodes);
        set('rl-states-seen', s.memory);
      }

      // Update live RL agent position panel (primary agent)
      const primaryAgent = JADO.state.agents.find(a => a.alive);
      if (primaryAgent) {
        const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
        
        // Add geographical lat/lon string if georef is loaded
        let latStr = '—', lonStr = '—';
        if (JADO.state.terrainData && JADO.state.terrainData.geoRef) {
          const ll = JADO.Renderer._worldToLatLon(primaryAgent.x, primaryAgent.z);
          latStr = ll.lat.toFixed(5) + '°N';
          lonStr = ll.lon.toFixed(5) + '°E';
        }
        
        set('rl-pos-x',       Math.round(primaryAgent.x) + ' m');
        set('rl-pos-y',       Math.round(primaryAgent.altitude) + ' m');
        set('rl-pos-z',       Math.round(primaryAgent.z) + ' m');
        
        // If there's an element for lat/lon, update it
        set('rl-pos-lat', latStr);
        set('rl-pos-lon', lonStr);
        
        set('rl-heading',     Math.round(primaryAgent.heading) + '°');
        set('rl-corridor-type', primaryAgent.corridorType || '—');
        set('rl-wp-idx',      primaryAgent.corridorWaypointIdx || '—');
        set('rl-wp-total',    primaryAgent.corridor ? primaryAgent.corridor.length : '—');
        set('rl-deviation',   Math.round(primaryAgent.corridorDeviation || 0) + ' m');
        // Progress: waypoint index / total waypoints
        const progress = primaryAgent.corridor && primaryAgent.corridor.length > 0
          ? ((primaryAgent.corridorWaypointIdx / (primaryAgent.corridor.length - 1)) * 100).toFixed(1) + '%'
          : '—';
        set('rl-progress',    progress);
        set('rl-ticks-alive', primaryAgent.ticksAlive || '0');
        const secAlive = ((primaryAgent.ticksAlive || 0) / 10).toFixed(1);
        set('rl-time-alive',  secAlive + ' s');
      }
    }

    _onAgentDeath(agent) {
      this.toast(`☠ ${agent.id} destroyed!`, 'error');
      JADO.Renderer.updateAgent(agent);
    }

    _onMissionComplete(data) {
      this._stopClock();
      this._setSimStatus('COMPLETE');
      if (data.reason === 'all_dead') {
        this.toast('MISSION FAILED — All agents lost', 'error');
      } else if (data.reason === 'target_reached') {
        this.toast('MISSION SUCCESS — Target reached!', 'success');
      }
    }

    // ── Clear all ─────────────────────────────────────────────────

    clearMission() {
      this.resetSim();
      JADO.state.agents  = [];
      JADO.state.threats = [];
      JADO.state.corridors = null;
      JADO.state.targetPos = null;
      JADO.Agent.resetCounter();

      JADO.Renderer.clearAllAgents();
      JADO.Renderer.clearAllThreats();
      Object.values(JADO.Renderer._corridorLines).forEach(l => { if(l) l.visible = false; });

      document.getElementById('friendly-list').innerHTML = '';
      document.getElementById('threat-list').innerHTML   = '';
      document.getElementById('agent-cards').innerHTML   = '';
      document.getElementById('pk-gauges').innerHTML     = '';
      document.getElementById('agent-count').textContent = '0';
      document.getElementById('threat-count').textContent = '0';
      document.getElementById('target-coords-display').textContent = 'Not set';

      if (JADO.state.cache) JADO.state.cache.clearMission(JADO.state.missionId);
      JADO.log('Mission cleared', 'info');
    }

    // ── Export AAR ────────────────────────────────────────────────

    exportAAR() {
      const aar = JADO.state.sim ? JADO.state.sim.generateAAR() : { error: 'No simulation run' };
      const blob = new Blob([JSON.stringify(aar, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `JADO_AAR_${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast('After-Action Report exported', 'success');
    }

    screenshot() {
      const url = JADO.Renderer._renderer.domElement.toDataURL('image/png');
      const a   = document.createElement('a');
      a.href = url;
      a.download = `JADO_screenshot_${Date.now()}.png`;
      a.click();
      this.toast('Screenshot saved', 'success');
    }

    // ── UI helpers ────────────────────────────────────────────────

    _addUnitListItem(containerId, id, name, onDelete) {
      const el = document.createElement('div');
      el.className = 'unit-item ' + (containerId.includes('friendly') ? 'friendly' : 'enemy');
      el.id = `unit-${id}`;
      el.innerHTML = `
        <span class="unit-id">${id}</span>
        <span>${name}</span>
        <button class="unit-del" title="Remove">✕</button>
      `;
      el.querySelector('.unit-del').addEventListener('click', () => {
        el.remove();
        if (onDelete) onDelete();
      });
      document.getElementById(containerId).appendChild(el);
    }

    _showPlacementBanner(text) {
      const banner = document.getElementById('placement-banner');
      const txt    = document.getElementById('placement-text');
      if (banner) banner.classList.remove('hidden');
      if (txt)    txt.textContent = text;
    }

    _hidePlacementBanner() {
      const banner = document.getElementById('placement-banner');
      if (banner) banner.classList.add('hidden');
    }

    _setSimStatus(status) {
      const badge = document.getElementById('sim-status-badge');
      if (!badge) return;
      const map = {
        RUNNING:  { text: '● RUNNING',  cls: 'running' },
        PAUSED:   { text: '⏸ PAUSED',   cls: '' },
        STANDBY:  { text: '● STANDBY',  cls: '' },
        COMPLETE: { text: '■ COMPLETE', cls: 'danger' },
      };
      const s = map[status] || map.STANDBY;
      badge.textContent = s.text;
      badge.className = `status-badge ${s.cls}`;
    }

    _startClock() {
      this._stopClock();
      this._clockInterval = setInterval(() => {
        this._missionClock++;
        this._updateClock();
      }, 1000);
    }

    _stopClock() {
      if (this._clockInterval) { clearInterval(this._clockInterval); this._clockInterval = null; }
    }

    _updateClock() {
      const t  = this._missionClock;
      const h  = String(Math.floor(t / 3600)).padStart(2, '0');
      const m  = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
      const s  = String(t % 60).padStart(2, '0');
      const el = document.getElementById('mission-clock');
      if (el) el.textContent = `${h}:${m}:${s}`;
    }

    toast(message, type = 'info') {
      let container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
      }
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
  }

  window.JADO.UIManager = UIManager;
})();
