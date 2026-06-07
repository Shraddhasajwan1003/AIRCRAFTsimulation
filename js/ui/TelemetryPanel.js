// js/ui/TelemetryPanel.js
// Canvas-based scrolling charts and Pk gauges for the telemetry panel
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  class TelemetryPanel {
    constructor(cache) {
      this.cache       = cache;
      this.missionId   = null;
      this._agentCards = new Map();
      this._charts     = {};
      this._initCharts();
    }

    setMissionId(id) { this.missionId = id; }

    _initCharts() {
      this._charts.altitude = document.getElementById('altitude-chart');
      this._charts.speed    = document.getElementById('speed-chart');
      this._charts.threat   = document.getElementById('threat-chart');
    }

    // ── Full refresh (called every 100ms by tick event) ───────────

    refresh(agents) {
      if (!agents || !agents.length) return;
      this._updateAgentCards(agents);
      this._updatePkGauges(agents);
      this._updateCharts(agents);
      this._updateRLStats();
    }

    // ── Agent status cards ────────────────────────────────────────

    _updateAgentCards(agents) {
      const container = document.getElementById('agent-cards');
      if (!container) return;

      agents.forEach(agent => {
        let card = this._agentCards.get(agent.id);

        if (!card) {
          card = document.createElement('div');
          card.className = 'agent-card';
          card.id = `card-${agent.id}`;
          container.appendChild(card);
          this._agentCards.set(agent.id, card);
        }

        const pk    = agent.currentPk || 0;
        const pkPct = (pk * 100).toFixed(0);
        const threatClass = pk > 0.5 ? 'threat-high' : pk > 0.25 ? 'threat-med' : 'alive';
        card.className = `agent-card ${agent.alive ? threatClass : 'dead'}`;

        const altKm = ((agent.altitude || 0) / 1000).toFixed(1);
        const hdg   = Math.round(agent.heading || 0);
        const spd   = Math.round(agent.speed   || 0);
        const dev   = Math.round(agent.corridorDeviation || 0);

        card.innerHTML = `
          <div class="agent-header">
            <div>
              <span class="agent-id">${agent.id}</span><br>
              <span class="agent-type">${agent.spec ? agent.spec.name : ''}</span>
            </div>
            <span class="agent-alive-badge ${agent.alive ? 'alive' : 'dead'}">${agent.alive ? 'ACTIVE' : 'KIA'}</span>
          </div>
          <div class="agent-stats">
            <div class="agent-stat"><span class="stat-lbl">ALT</span><span class="stat-val">${altKm}km</span></div>
            <div class="agent-stat"><span class="stat-lbl">HDG</span><span class="stat-val">${hdg}°</span></div>
            <div class="agent-stat"><span class="stat-lbl">SPD</span><span class="stat-val">${spd}m/s</span></div>
            <div class="agent-stat"><span class="stat-lbl">DEV</span><span class="stat-val">${dev}m</span></div>
            <div class="agent-stat"><span class="stat-lbl">JAM</span><span class="stat-val" style="color:${agent.jammerActive?'#00ffcc':'#304060'}">${agent.jammerActive?'ON':'--'}</span></div>
            <div class="agent-stat"><span class="stat-lbl">FLR</span><span class="stat-val">${agent.flares||0}</span></div>
          </div>
        `;
      });
    }

    // ── Pk gauges ─────────────────────────────────────────────────

    _updatePkGauges(agents) {
      const container = document.getElementById('pk-gauges');
      if (!container) return;

      container.innerHTML = '';
      agents.forEach(agent => {
        if (!agent.alive) return;
        const pk    = agent.currentPk || 0;
        const pkPct = (pk * 100).toFixed(1);
        const cls   = pk > 0.5 ? 'high' : pk > 0.25 ? 'medium' : 'low';
        const color = pk > 0.5 ? '#ff3333' : pk > 0.25 ? '#ffaa00' : '#00ff88';

        const div = document.createElement('div');
        div.className = 'pk-gauge';
        div.innerHTML = `
          <div class="pk-header">
            <span class="pk-id">${agent.id}</span>
            <span class="pk-val ${cls}">Pk: ${pkPct}%</span>
          </div>
          <div class="pk-bar-track">
            <div class="pk-bar-fill" style="width:${pkPct}%;background:${color}"></div>
          </div>
        `;
        container.appendChild(div);
      });
    }

    // ── Canvas charts ─────────────────────────────────────────────

    _updateCharts(agents) {
      if (!this.missionId) return;
      const aliveAgents = agents.filter(a => a.alive);
      if (!aliveAgents.length) return;

      const agent = aliveAgents[0]; // Chart primary agent

      this._drawChart(
        this._charts.altitude,
        this.cache.getHistory(this.missionId, agent.id, 'altitude'),
        { color: '#00ccff', label: 'ALT', unit: 'm', minVal: 0, maxVal: agent.spec ? agent.spec.maxAltitude : 15000 }
      );
      this._drawChart(
        this._charts.speed,
        this.cache.getHistory(this.missionId, agent.id, 'speed'),
        { color: '#00ff88', label: 'SPD', unit: 'm/s', minVal: 0, maxVal: agent.spec ? agent.spec.maxSpeed : 600 }
      );
      this._drawChart(
        this._charts.threat,
        this.cache.getHistory(this.missionId, agent.id, 'pk').map(v => v * 100),
        { color: '#ff3333', label: 'Pk%', unit: '%', minVal: 0, maxVal: 100 }
      );
    }

    _drawChart(canvas, data, opts) {
      if (!canvas || !data || data.length < 2) return;
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      const pad = 4;

      ctx.clearRect(0, 0, W, H);

      // Background
      ctx.fillStyle = 'rgba(0, 5, 15, 0.8)';
      ctx.fillRect(0, 0, W, H);

      // Grid lines
      ctx.strokeStyle = 'rgba(0, 255, 204, 0.08)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = pad + (H - 2*pad) * i / 4;
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
      }

      // Data line
      const n = data.length;
      const minVal = opts.minVal !== undefined ? opts.minVal : Math.min(...data);
      const maxVal = opts.maxVal !== undefined ? opts.maxVal : Math.max(...data);
      const range  = Math.max(1, maxVal - minVal);

      ctx.strokeStyle = opts.color;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = pad + (W - 2*pad) * i / (n - 1);
        const y = H - pad - (H - 2*pad) * (v - minVal) / range;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Fill under line
      ctx.lineTo(pad + (W - 2*pad), H - pad);
      ctx.lineTo(pad, H - pad);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, opts.color + '44');
      grad.addColorStop(1, opts.color + '00');
      ctx.fillStyle = grad;
      ctx.fill();

      // Current value label
      if (data.length > 0) {
        const last = data[data.length - 1];
        ctx.fillStyle = opts.color;
        ctx.font = '10px Consolas, monospace';
        ctx.fillText(`${Math.round(last)}${opts.unit}`, W - 55, 14);
      }
    }

    // ── RL training stats ─────────────────────────────────────────

    _updateRLStats() {
      const agent = window.JADO.state && window.JADO.state.dqnAgent;
      if (!agent) return;
      const s = agent.getStats();
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      set('rl-ep-count',    s.episodes);
      set('rl-eps-val',     s.epsilon);
      set('rl-avg-reward',  s.avgReward);
      set('rl-memory-size', s.memory);
      set('rl-train-steps', s.trainSteps);
      set('rl-indicator',   '');
      // Also update the top indicator
      set('rl-epsilon', 'ε: ' + s.epsilon);
      set('rl-episodes', 'Ep: ' + s.episodes);
    }
  }

  window.JADO.TelemetryPanel = TelemetryPanel;
})();
