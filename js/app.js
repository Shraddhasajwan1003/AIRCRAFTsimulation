// js/app.js
// Application bootstrap — initializes all modules and wires them together
(function() {
  'use strict';

  // ── Verify libraries loaded ───────────────────────────────────
  function checkDeps() {
    const missing = [];
    if (typeof THREE    === 'undefined') missing.push('Three.js');
    if (typeof tf       === 'undefined') missing.push('TensorFlow.js');
    if (!window.JADO)                   missing.push('JADO modules');
    return missing;
  }

  // ── Global simulation state ───────────────────────────────────
  window.JADO = window.JADO || {};
  window.JADO.state = {
    missionId:   'mission_' + Date.now(),
    terrainData: null,
    grid:        null,
    agents:      [],
    threats:     [],
    obstacles:   [],
    corridors:   null,
    targetPos:   null,
    cache:       null,
    sim:         null,
    dqnAgent:    null,
    telemetry:   null,
    _targetMarker: null,
  };

  // Instantiate Database
  JADO.MapDB = new JADO.MapDatabase();

  // ── Global log function ───────────────────────────────────────
  window.JADO.log = function(msg, type = '') {
    const container = document.getElementById('sim-log');
    if (!container) return;
    const ts  = new Date().toTimeString().slice(0,8);
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    div.innerHTML = `<span class="ts">[${ts}]</span> <span class="msg">${msg}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    // Cap at 100 entries
    while (container.children.length > 100) container.removeChild(container.firstChild);
  };

  // ── Bootstrap ─────────────────────────────────────────────────
  async function init() {
    // Check dependencies
    const missing = checkDeps();
    if (missing.length > 0) {
      document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#050911;color:#ff3333;font-family:monospace;text-align:center;padding:40px">
          <div>
            <div style="font-size:48px;margin-bottom:20px">⚠</div>
            <h2 style="color:#ff3333;margin-bottom:16px">Missing Libraries</h2>
            <p>The following libraries were not found:</p>
            <p style="color:#ffaa00;margin:12px 0">${missing.join(', ')}</p>
            <p>Please run <strong>setup.bat</strong> first to download required files.</p>
          </div>
        </div>`;
      return;
    }

    console.log('[JADO] Initializing...');

    // 1. Create TelemetryCache (Redis equivalent)
    JADO.state.cache = new JADO.TelemetryCache();

    // 2. Create DQN agent
    JADO.state.dqnAgent = new JADO.DQNAgent(38, 9);
    // Try loading saved model from previous session
    const loaded = await JADO.state.dqnAgent.load();
    if (loaded) JADO.log('Loaded saved DQN model from previous session', 'info');
    else JADO.log('DQN agent initialized (fresh — will train from scratch)', 'info');

    // 3. Initialize 3D renderer
    const canvas = document.getElementById('theater-canvas');
    JADO.Renderer = new JADO.Renderer3D(canvas);
    window.addEventListener('resize', () => {
      const W = canvas.clientWidth, H = canvas.clientHeight;
      canvas.width = W; canvas.height = H;
    });

    // 4. Initialize UI
    JADO.UI = new JADO.UIManager();

    // 5. Initialize Telemetry panel
    JADO.state.telemetry = new JADO.TelemetryPanel(JADO.state.cache);
    JADO.state.telemetry.setMissionId(JADO.state.missionId);

    // 6. Wire global shortcut references for HTML onclick handlers
    JADO.Sim = {
      start:    () => JADO.UI.startSim(),
      pause:    () => JADO.UI.pauseSim(),
      reset:    () => JADO.UI.resetSim(),
      setSpeed: (m) => JADO.UI.setSimSpeed(m),
    };

    // 7. Setup drag-drop on terrain dropzone
    const dropzone = document.getElementById('terrain-dropzone');
    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) JADO.UI.handleTerrainFile(file);
      });
    }

    // File input handler
    const fileInput = document.getElementById('terrain-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) JADO.UI.handleTerrainFile(file);
        fileInput.value = '';
      });
    }

    // 8. Setup range input labels
    const obsizeSlider = document.getElementById('obstacle-size');
    if (obsizeSlider) {
      obsizeSlider.addEventListener('input', () => {
        document.getElementById('obstacle-size-label').textContent = obsizeSlider.value;
      });
    }

    const ecmSlider = document.getElementById('ecm-density');
    if (ecmSlider) {
      ecmSlider.addEventListener('input', () => {
        document.getElementById('ecm-label').textContent = ecmSlider.value + '%';
      });
    }

    // 9. Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') JADO.UI.cancelPlacement();
      if (e.key === ' ' && !['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) {
        e.preventDefault();
        if (JADO.state.sim && JADO.state.sim.running) JADO.UI.pauseSim();
        else JADO.UI.startSim();
      }
    });

    // 10. Auto-generate procedural terrain on startup (after tiny delay)
    setTimeout(() => {
      JADO.UI.generateProceduralTerrain();
      JADO.log('JADO Simulation System ready', 'info');
      JADO.log('Run setup.bat once for library downloads, then run.bat to launch offline', 'info');
    }, 200);

    console.log('[JADO] Initialization complete');
  }

  // Run after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
