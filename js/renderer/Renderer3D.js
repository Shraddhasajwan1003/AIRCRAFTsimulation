// js/renderer/Renderer3D.js
// Three.js 3D scene: terrain, agents, threats, corridors, trails, overlays
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  class Renderer3D {
    constructor(canvas) {
      this.canvas   = canvas;
      this._scene   = null;
      this._camera  = null;
      this._renderer = null;
      this._controls = null;
      this._raycaster = new THREE.Raycaster();
      this._mouse     = new THREE.Vector2();

      // Scene objects
      this._terrainMesh  = null;
      this._gridHelper   = null;
      this._agentMeshes  = new Map(); // agentId → mesh group
      this._threatMeshes = new Map(); // threatId → group
      this._corridorLines = { fastest: null, lowAlt: null, balanced: null };
      this._trailLines   = new Map(); // agentId → Line
      this._trailPoints  = new Map(); // agentId → position history

      // Toggles
      this._showThreatZones = true;
      this._showCorridors   = true;
      this._showTrails      = true;
      this._showGrid        = false;

      // Placement mode
      this._placementMode = null;
      this._placementCB   = null;
      this._terrainPlane  = null;

      // Animation clock
      this._clock    = new THREE.Clock();
      this._animFrame = null;

      this._init();
    }

    _init() {
      const W = this.canvas.clientWidth  || this.canvas.offsetWidth;
      const H = this.canvas.clientHeight || this.canvas.offsetHeight;

      // Renderer
      this._renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: false,
      });
      this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this._renderer.setSize(W, H, false);
      this._renderer.shadowMap.enabled = true;
      this._renderer.setClearColor(0x020710, 1);

      // Scene
      this._scene = new THREE.Scene();
      this._scene.fog = new THREE.FogExp2(0x020a1a, 0.00006);

      // Camera
      this._camera = new THREE.PerspectiveCamera(55, W / H, 10, 200000);
      this._camera.position.set(2500, 3000, -3000);
      this._camera.lookAt(2500, 0, 2500);

      // Orbit controls
      this._controls = new THREE.OrbitControls(this._camera, this._renderer.domElement);
      this._controls.enableDamping = true;
      this._controls.dampingFactor = 0.05;
      this._controls.minDistance   = 200;
      this._controls.maxDistance   = 80000;
      this._controls.maxPolarAngle = Math.PI / 2.1;
      this._controls.target.set(2500, 0, 2500);

      // Lighting
      const ambient = new THREE.AmbientLight(0x1a2a40, 0.8);
      this._scene.add(ambient);

      const sun = new THREE.DirectionalLight(0xffffff, 1.2);
      sun.position.set(1000, 3000, 1000);
      sun.castShadow = true;
      sun.shadow.camera.near = 100;
      sun.shadow.camera.far  = 30000;
      sun.shadow.camera.left = sun.shadow.camera.bottom = -6000;
      sun.shadow.camera.right = sun.shadow.camera.top   =  6000;
      sun.shadow.mapSize.set(2048, 2048);
      this._scene.add(sun);

      const fill = new THREE.DirectionalLight(0x304060, 0.4);
      fill.position.set(-1000, 500, -1000);
      this._scene.add(fill);

      // Grid helper (hidden by default)
      this._gridHelper = new THREE.GridHelper(10000, 100, 0x00ffcc, 0x003322);
      this._gridHelper.material.opacity = 0.15;
      this._gridHelper.material.transparent = true;
      this._gridHelper.visible = false;
      this._scene.add(this._gridHelper);

      // Stars background (simple point cloud)
      this._addStars();

      // Click handler for placement
      this._renderer.domElement.addEventListener('click', (e) => this._onClick(e));
      this._renderer.domElement.addEventListener('mousemove', (e) => this._onMouseMove(e));

      // Resize handler
      window.addEventListener('resize', () => this._onResize());

      // Start render loop
      this._renderLoop();
    }

    _addStars() {
      const starGeo = new THREE.BufferGeometry();
      const positions = new Float32Array(3000);
      for (let i = 0; i < 1000; i++) {
        positions[i*3]   = (Math.random() - 0.5) * 80000;
        positions[i*3+1] = Math.random() * 20000 + 5000;
        positions[i*3+2] = (Math.random() - 0.5) * 80000;
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const starMat = new THREE.PointsMaterial({ color: 0xaaccff, size: 8, sizeAttenuation: true });
      this._scene.add(new THREE.Points(starGeo, starMat));
    }

    // ── Terrain loading ───────────────────────────────────────────

    loadTerrain(terrainData) {
      // Remove old terrain
      if (this._terrainMesh) {
        this._scene.remove(this._terrainMesh);
        this._terrainMesh.geometry.dispose();
      }
      this._terrainMesh = terrainData.mesh;
      this._scene.add(this._terrainMesh);

      // Add wireframe overlay
      const wireGeo = this._terrainMesh.geometry.clone();
      const wireMat = new THREE.MeshBasicMaterial({ color: 0x003322, wireframe: true, transparent: true, opacity: 0.08 });
      const wire = new THREE.Mesh(wireGeo, wireMat);
      wire.position.copy(this._terrainMesh.position);
      wire.name = 'terrain_wire';
      this._scene.add(wire);

      // Create invisible plane for raycasting (placement)
      const ps = Math.max(terrainData.worldSizeX, terrainData.worldSizeZ);
      this._terrainPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(ps * 2, ps * 2),
        new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
      );
      this._terrainPlane.rotation.x = -Math.PI / 2;
      this._terrainPlane.position.set(terrainData.worldSizeX / 2, 0, terrainData.worldSizeZ / 2);
      this._scene.add(this._terrainPlane);

      // Reposition camera
      const cx = terrainData.worldSizeX / 2;
      const cz = terrainData.worldSizeZ / 2;
      this._camera.position.set(cx, terrainData.maxHeight * 3, cz - terrainData.worldSizeZ * 0.7);
      this._controls.target.set(cx, 0, cz);
      this._gridHelper.position.set(cx, 0, cz);
    }

    // ── Agent rendering ───────────────────────────────────────────

    addAgent(agent) {
      const group = new THREE.Group();
      group.name  = agent.id;

      // Body: cone pointing forward
      const bodyGeo = new THREE.ConeGeometry(60, 180, 6);
      const bodyMat = new THREE.MeshPhongMaterial({
        color: agent.faction === 'friendly' ? 0x00ff88 : 0xff4444,
        emissive: agent.faction === 'friendly' ? 0x002200 : 0x220000,
        shininess: 50,
      });
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.rotation.x = Math.PI / 2; // point in Z direction
      body.castShadow = true;
      group.add(body);

      // Wing spans
      const wingGeo = new THREE.BoxGeometry(400, 15, 100);
      const wingMat = bodyMat.clone();
      const wings = new THREE.Mesh(wingGeo, wingMat);
      wings.position.z = -30;
      group.add(wings);

      // Exhaust glow (point light)
      const glow = new THREE.PointLight(
        agent.faction === 'friendly' ? 0x00ffaa : 0xff6600, 0.6, 1200
      );
      glow.position.z = -100;
      group.add(glow);
      group.userData.glow = glow;

      // ID label (sprite)
      group.userData.agent  = agent;
      group.position.set(agent.x, agent.y, agent.z);

      this._scene.add(group);
      this._agentMeshes.set(agent.id, group);

      // Init trail
      this._trailPoints.set(agent.id, []);
    }

    updateAgent(agent) {
      const group = this._agentMeshes.get(agent.id);
      if (!group) return;

      group.position.set(agent.x, agent.y, agent.z);
      const rad = agent.heading * Math.PI / 180;
      group.rotation.y = -rad;

      // Alive/dead visual
      const bodyMesh = group.children[0];
      if (!agent.alive) {
        bodyMesh.material.color.setHex(0x333333);
        bodyMesh.material.emissive.setHex(0x000000);
        group.userData.glow.intensity = 0;
      } else {
        // Threat level → glow intensity / color
        const pk = agent.currentPk;
        if (pk > 0.5) {
          bodyMesh.material.emissive.setHex(0x220000);
          group.userData.glow.color.setHex(0xff2200);
          group.userData.glow.intensity = 1.5;
        } else if (pk > 0.25) {
          group.userData.glow.intensity = 0.8;
        } else {
          group.userData.glow.intensity = 0.4 + 0.2 * Math.sin(Date.now() * 0.003);
        }
      }

      // Trail
      if (this._showTrails) this._updateTrail(agent);
    }

    _updateTrail(agent) {
      const pts = this._trailPoints.get(agent.id);
      pts.push(new THREE.Vector3(agent.x, agent.y, agent.z));
      if (pts.length > 120) pts.shift();

      // Remove old line
      const oldLine = this._trailLines.get(agent.id);
      if (oldLine) { this._scene.remove(oldLine); oldLine.geometry.dispose(); }

      if (pts.length < 2) return;
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: agent.faction === 'friendly' ? 0x00ff88 : 0xff4444,
        transparent: true, opacity: 0.5,
      });
      const line = new THREE.Line(geo, mat);
      this._scene.add(line);
      this._trailLines.set(agent.id, line);
    }

    removeAgent(agentId) {
      const group = this._agentMeshes.get(agentId);
      if (group) { this._scene.remove(group); this._agentMeshes.delete(agentId); }
    }

    clearAllAgents() {
      for (const [id, mesh] of this._agentMeshes) { this._scene.remove(mesh); }
      this._agentMeshes.clear();
      for (const [id, line] of this._trailLines) { this._scene.remove(line); }
      this._trailLines.clear();
      this._trailPoints.clear();
    }

    // ── Threat rendering ──────────────────────────────────────────

    addThreat(threat) {
      const group = new THREE.Group();
      group.name  = threat.id;

      // Base marker
      const baseGeo = new THREE.CylinderGeometry(80, 80, 40, 8);
      const baseMat = new THREE.MeshPhongMaterial({
        color: 0xff3333, emissive: 0x220000, shininess: 20,
      });
      const base = new THREE.Mesh(baseGeo, baseMat);
      group.add(base);

      // Radar dish (for visual)
      const dishGeo = new THREE.TorusGeometry(120, 15, 8, 20, Math.PI);
      const dishMat = new THREE.MeshPhongMaterial({ color: 0xaaaaaa });
      const dish    = new THREE.Mesh(dishGeo, dishMat);
      dish.position.y = 80;
      dish.rotation.x = Math.PI / 4;
      group.add(dish);
      group.userData.dish = dish;

      // Threat zone sphere (translucent)
      const radius = threat.spec ? Math.min(threat.spec.radius, 150000) : 50000;
      const sphereGeo = new THREE.SphereGeometry(radius, 32, 16);
      const sphereMat = new THREE.MeshBasicMaterial({
        color: 0xff2200, transparent: true, opacity: 0.04,
        side: THREE.FrontSide, depthWrite: false,
      });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      sphere.visible = this._showThreatZones;
      group.add(sphere);
      group.userData.sphere = sphere;

      // Radar sweep ring (animated)
      const ringGeo = new THREE.RingGeometry(radius * 0.95, radius, 64);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xff3300, transparent: true, opacity: 0.12,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.visible = this._showThreatZones;
      group.add(ring);
      group.userData.ring = ring;

      group.position.set(threat.x, 0, threat.z);
      this._scene.add(group);
      this._threatMeshes.set(threat.id, group);
    }

    clearAllThreats() {
      for (const [id, g] of this._threatMeshes) { this._scene.remove(g); }
      this._threatMeshes.clear();
    }

    // ── Corridor rendering ────────────────────────────────────────

    setCorridors(corridors) {
      // Remove old
      Object.values(this._corridorLines).forEach(l => { if (l) this._scene.remove(l); });

      const colors = { fastest: 0x00ff88, lowAlt: 0xffdd00, balanced: 0x00ccff };
      for (const [type, path] of Object.entries(corridors)) {
        if (!path || path.length < 2) continue;
        const pts = path.map(p => new THREE.Vector3(p.x, p.y + 50, p.z));
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({
          color: colors[type] || 0xffffff,
          linewidth: 2,
          transparent: true, opacity: 0.8,
        });
        const line = new THREE.Line(geo, mat);
        line.visible = this._showCorridors;
        this._scene.add(line);
        this._corridorLines[type] = line;

        // Add waypoint markers
        for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length/20))) {
          const dotGeo = new THREE.SphereGeometry(40, 8, 8);
          const dotMat = new THREE.MeshBasicMaterial({ color: colors[type] || 0xffffff });
          const dot = new THREE.Mesh(dotGeo, dotMat);
          dot.position.copy(pts[i]);
          dot.visible = this._showCorridors;
          this._scene.add(dot);
        }
      }
    }

    toggleCorridor(type, show) {
      if (this._corridorLines[type]) this._corridorLines[type].visible = show;
    }

    // ── Obstacle rendering ────────────────────────────────────────

    addObstacle(pos, sizeMeters, color = 0x555555) {
      const geo = new THREE.BoxGeometry(sizeMeters, sizeMeters * 2, sizeMeters);
      const mat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.8 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(pos.x, pos.y + sizeMeters, pos.z);
      mesh.castShadow = true;
      this._scene.add(mesh);
      return mesh;
    }

    addTarget(pos) {
      const group = new THREE.Group();
      // Pulsing ring
      const ringGeo = new THREE.TorusGeometry(200, 20, 8, 32);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      group.add(ring);
      // Center spike
      const spikeGeo = new THREE.ConeGeometry(40, 300, 8);
      const spikeMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
      const spike = new THREE.Mesh(spikeGeo, spikeMat);
      spike.position.y = 150;
      group.add(spike);
      group.position.set(pos.x, pos.y || 0, pos.z);
      group.name = 'target_marker';
      this._scene.add(group);
      return group;
    }

    // ── Toggles ───────────────────────────────────────────────────

    toggleThreatZones(show) {
      this._showThreatZones = show;
      for (const [, g] of this._threatMeshes) {
        if (g.userData.sphere) g.userData.sphere.visible = show;
        if (g.userData.ring)   g.userData.ring.visible   = show;
      }
    }

    toggleCorridors(show) {
      this._showCorridors = show;
      Object.values(this._corridorLines).forEach(l => { if (l) l.visible = show; });
    }

    toggleTrails(show) { this._showTrails = show; }

    toggleGrid(show) {
      this._showGrid = show !== undefined ? show : !this._showGrid;
      this._gridHelper.visible = this._showGrid;
    }

    // ── Camera controls ───────────────────────────────────────────

    resetCamera() {
      this._camera.position.set(2500, 3000, -2500);
      this._controls.target.set(2500, 0, 2500);
    }

    topView() {
      this._camera.position.set(2500, 12000, 2500);
      this._controls.target.set(2500, 0, 2500);
    }

    // ── Placement mode ────────────────────────────────────────────

    startPlacement(mode, callback) {
      this._placementMode = mode;
      this._placementCB   = callback;
      this._controls.enabled = false;
    }

    cancelPlacement() {
      this._placementMode = null;
      this._placementCB   = null;
      this._controls.enabled = true;
    }

    _onClick(event) {
      if (!this._placementMode || !this._placementCB) return;

      const rect = this.canvas.getBoundingClientRect();
      this._mouse.x = ((event.clientX - rect.left) / rect.width)  *  2 - 1;
      this._mouse.y = ((event.clientY - rect.top)  / rect.height) * -2 + 1;

      this._raycaster.setFromCamera(this._mouse, this._camera);

      const targets = this._terrainMesh ? [this._terrainMesh, this._terrainPlane].filter(Boolean) : [];
      const intersects = this._raycaster.intersectObjects(targets, false);

      if (intersects.length > 0) {
        const pt = intersects[0].point;
        this._placementCB({ x: pt.x, y: pt.y, z: pt.z });
        this.cancelPlacement();
      }
    }

    _onMouseMove(event) {
      const rect = this.canvas.getBoundingClientRect();
      const mx = ((event.clientX - rect.left) / rect.width)  *  2 - 1;
      const my = ((event.clientY - rect.top)  / rect.height) * -2 + 1;
      // Update HUD coords via raycasting
      if (this._terrainMesh) {
        const rc = new THREE.Raycaster();
        rc.setFromCamera({ x: mx, y: my }, this._camera);
        const hits = rc.intersectObject(this._terrainMesh);
        if (hits.length > 0) {
          const p = hits[0].point;
          const el = document.getElementById('hud-coords');
          if (el) el.textContent = `XYZ: ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
        }
      }
    }

    _onResize() {
      const W = this.canvas.clientWidth  || this.canvas.offsetWidth;
      const H = this.canvas.clientHeight || this.canvas.offsetHeight;
      this._camera.aspect = W / H;
      this._camera.updateProjectionMatrix();
      this._renderer.setSize(W, H, false);
    }

    // ── Render loop ───────────────────────────────────────────────

    _renderLoop() {
      this._animFrame = requestAnimationFrame(() => this._renderLoop());
      const dt = this._clock.getDelta();

      // Animate threat radar dishes
      for (const [, group] of this._threatMeshes) {
        if (group.userData.dish) group.userData.dish.rotation.y += dt * 2;
      }

      this._controls.update();
      this._renderer.render(this._scene, this._camera);
    }

    dispose() {
      cancelAnimationFrame(this._animFrame);
      this._renderer.dispose();
    }
  }

  window.JADO.Renderer3D = Renderer3D;
})();
