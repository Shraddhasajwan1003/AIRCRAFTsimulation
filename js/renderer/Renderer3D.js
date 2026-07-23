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

    _clearTerrainObjects() {
      // Remove by reference
      if (this._terrainMesh) {
        this._scene.remove(this._terrainMesh);
        if (this._terrainMesh.geometry) this._terrainMesh.geometry.dispose();
        if (this._terrainMesh.material) this._terrainMesh.material.dispose();
        this._terrainMesh = null;
      }
      if (this._terrainPlane) {
        this._scene.remove(this._terrainPlane);
        this._terrainPlane = null;
      }
      // Sweep scene for any leftover terrain/wireframe/voxel objects by name
      const toRemove = [];
      this._scene.traverse(obj => {
        if (obj.name === 'terrain_wire' || obj.name === 'terrain' || obj.name === 'terrain_plane' || obj.name === 'voxel_mesh') {
          toRemove.push(obj);
        }
      });
      toRemove.forEach(obj => {
        this._scene.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
    }

    loadTerrain(terrainData) {
      // ── Purge ALL old terrain objects from scene ──────────────────
      this._clearTerrainObjects();

      // ── Add new terrain mesh ──────────────────────────────────────
      const mesh = terrainData.mesh;
      // Ensure TIF PlaneGeometry meshes (centered at origin) are shifted
      // so the terrain spans [0..worldSizeX] × [0..worldSizeZ]
      if (!mesh.position.x && !mesh.position.z) {
        mesh.position.set(terrainData.worldSizeX / 2, 0, terrainData.worldSizeZ / 2);
      }
      mesh.name = 'terrain';
      this._terrainMesh = mesh;
      if (this._showVoxels) mesh.visible = false;
      this._scene.add(mesh);

      // ── Subtle wireframe overlay (military grid look) ─────────────
      const wireGeo = mesh.geometry.clone();
      const wireMat = new THREE.MeshBasicMaterial({
        color: 0x00ff88, wireframe: true,
        transparent: true, opacity: 0.04,
        depthWrite: false,
      });
      const wire = new THREE.Mesh(wireGeo, wireMat);
      wire.position.copy(mesh.position);
      wire.name = 'terrain_wire';
      this._terrainWire = wire; // Store reference for toggling
      if (this._showVoxels) wire.visible = false;
      this._scene.add(wire);

      // ── Build Minecraft-style Voxel Grid (Hidden by default) ──────
      if (terrainData.grid) {
        this.renderVoxelGrid(terrainData);
      }

      // ── Invisible flat plane for fallback raycasting ─────────────
      const ps = Math.max(terrainData.worldSizeX, terrainData.worldSizeZ);
      this._terrainPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(ps * 3, ps * 3),
        new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
      );
      this._terrainPlane.rotation.x = -Math.PI / 2;
      this._terrainPlane.position.set(terrainData.worldSizeX / 2, 0, terrainData.worldSizeZ / 2);
      this._terrainPlane.name = 'terrain_plane';
      this._scene.add(this._terrainPlane);

      // ── XYZ Axis Helper & Geographic Labels ─────────────
      if (this._axisGroup) {
        this._scene.remove(this._axisGroup);
        if (this._axisLabels) {
          this._axisLabels.forEach(l => { if (l.el.parentNode) l.el.parentNode.removeChild(l.el); });
        }
      }
      
      this._axisGroup = new THREE.Group();
      this._axisGroup.name = 'axis_helper';
      
      const geoInfo = terrainData.geoInfo;
      const wsX = terrainData.worldSizeX;
      const wsZ = terrainData.worldSizeZ;
      const mH = terrainData.maxHeight;
      
      // Draw 3 thick lines (X=Red, Y=Green, Z=Blue)
      const matX = new THREE.LineBasicMaterial({ color: 0xff4444, linewidth: 2 });
      const matY = new THREE.LineBasicMaterial({ color: 0x44ff44, linewidth: 2 });
      const matZ = new THREE.LineBasicMaterial({ color: 0x4444ff, linewidth: 2 });
      
      const drawLine = (p1, p2, mat) => {
        const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
        this._axisGroup.add(new THREE.Line(geo, mat));
      };
      
      // Extend lines slightly past the map bounds for visibility
      const pad = Math.max(wsX, wsZ) * 0.05;
      drawLine(new THREE.Vector3(0,0,0), new THREE.Vector3(wsX + pad, 0, 0), matX);
      drawLine(new THREE.Vector3(0,0,0), new THREE.Vector3(0, mH + (pad*0.5), 0), matY);
      drawLine(new THREE.Vector3(0,0,0), new THREE.Vector3(0, 0, wsZ + pad), matZ);
      
      this._scene.add(this._axisGroup);
      
      // Setup HTML labels tracking the 3D points
      this._axisLabels = [];
      const createLabel = (pos, text, color) => {
        const el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.background = 'rgba(0,10,20,0.8)';
        el.style.color = color;
        el.style.border = `1px solid ${color}`;
        el.style.padding = '4px 6px';
        el.style.fontFamily = 'monospace';
        el.style.fontSize = '11px';
        el.style.pointerEvents = 'none';
        el.style.borderRadius = '3px';
        el.style.zIndex = '10';
        el.innerHTML = text.replace(/\n/g, '<br>');
        this.canvas.parentNode.appendChild(el);
        this._axisLabels.push({ pos, el });
      };
      
      let oLat = '—', oLon = '—', xLon = '—', zLat = '—';
      if (geoInfo && geoInfo.hasGeoRef) {
        oLat = geoInfo.minLat.toFixed(5) + '°';
        oLon = geoInfo.minLon.toFixed(5) + '°';
        xLon = geoInfo.maxLon.toFixed(5) + '°';
        zLat = geoInfo.maxLat.toFixed(5) + '°';
      }
      
      createLabel(new THREE.Vector3(0,0,0), `ORIGIN (0,0,0)\nLat: ${oLat}\nLon: ${oLon}`, '#ffffff');
      createLabel(new THREE.Vector3(wsX + pad, 0, 0), `X-AXIS (East)\nLon: ${xLon}`, '#ff8888');
      createLabel(new THREE.Vector3(0, 0, wsZ + pad), `Z-AXIS (North)\nLat: ${zLat}`, '#8888ff');
      createLabel(new THREE.Vector3(0, mH + (pad*0.5), 0), `Y-AXIS (Up)\nElev: ${Math.round(mH)}m`, '#88ff88');

      // ── Store geographic reference for lat/lon conversion ─────────
      this._geoRef = terrainData.geoRef || null;

      // ── Reposition camera ─────────────────────────────────────────
      const cx = terrainData.worldSizeX / 2;
      const cz = terrainData.worldSizeZ / 2;
      const camH = Math.max(terrainData.maxHeight * 3.5, 2000);
      this._camera.position.set(cx, camH, cz - terrainData.worldSizeZ * 0.65);
      this._camera.lookAt(cx, 0, cz);
      this._controls.target.set(cx, 0, cz);
      this._controls.update();
      this._gridHelper.position.set(cx, 0, cz);
    }

    // ── Voxel (Minecraft) Rendering ───────────────────────────────

    renderVoxelGrid(terrainData) {
      const grid = terrainData.grid;
      if (this._voxelMesh) {
        this._scene.remove(this._voxelMesh);
        this._voxelMesh.geometry.dispose();
        this._voxelMesh.material.dispose();
        this._voxelMesh = null;
      }

      console.log('[Renderer3D] Building Voxel Mesh...');
      const TYPE = JADO.VoxelGrid.TYPE;
      const vs = grid.voxelSize;
      
      // Calculate real-world elevation scaling
      const geoInfo = terrainData.geoInfo || null;
      let elevMin = 0;
      let displayAltScale = 1;
      if (geoInfo && geoInfo.hasGeoRef) {
        elevMin = geoInfo.elevMin;
        displayAltScale = terrainData.maxHeight / Math.max(1, geoInfo.altRange);
      }

      // 1. Count surface voxels to size the InstancedMesh
      let count = 0;
      const surfaceVoxels = []; // array of {x, y, z, type}
      const isSurface = (vx, vy, vz) => {
        // A voxel is surface if any of its 6 neighbors is FREE
        const n = [
          [1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1]
        ];
        for (const [dx, dy, dz] of n) {
          const nx = vx+dx, ny = vy+dy, nz = vz+dz;
          if (!grid.inBounds(nx, ny, nz) || grid.data[grid._idx(nx, ny, nz)] === TYPE.FREE) {
            return true;
          }
        }
        return false;
      };

      for (let x = 0; x < grid.dimX; x++) {
        for (let y = 0; y < grid.dimY; y++) {
          for (let z = 0; z < grid.dimZ; z++) {
            const t = grid.data[grid._idx(x, y, z)];
            if (t !== TYPE.FREE && t !== TYPE.THREAT_ZONE) {
              if (isSurface(x, y, z)) {
                surfaceVoxels.push({ x, y, z, type: t });
                count++;
              }
            }
          }
        }
      }

      console.log(`[Renderer3D] Voxel surface count: ${count}`);
      if (count === 0) return;

      // 2. Create InstancedMesh (Using Lambert for shadow shading and slightly scaled geometry for gaps)
      const geo = new THREE.BoxGeometry(vs * 0.96, vs * 0.96, vs * 0.96);
      const mat = new THREE.MeshLambertMaterial({
        color: 0x999999, // Lower base color so top faces aren't washed out by the intense sun
      });
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.name = 'voxel_mesh';
      mesh.visible = this._showVoxels || false; // Default hidden

      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      const colorArray = new Float32Array(count * 3);

      for (let i = 0; i < count; i++) {
        const v = surfaceVoxels[i];
        
        // Position
        dummy.position.set(
          (v.x + 0.5) * vs,
          (v.y + 0.5) * vs,
          (v.z + 0.5) * vs
        );
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        // Color based on type and height
        if (v.type === TYPE.TERRAIN) {
          // Calculate actual TIF elevation for this voxel
          const worldY = v.y * vs;
          const realElev = (worldY / displayAltScale) + elevMin;
          
          // Allot specific colors to specific elevation bands (Real-world meters)
          if (realElev < 100) color.setHex(0x1a5225);      // Deep Green
          else if (realElev < 400) color.setHex(0x367a31); // Forest Green
          else if (realElev < 800) color.setHex(0x8a9942); // Olive / Foothills
          else if (realElev < 1400) color.setHex(0xb88e39);// Golden Brown
          else if (realElev < 2200) color.setHex(0xa65728);// High Brown
          else if (realElev < 3000) color.setHex(0x5e4537);// Dark Rock
          else color.setHex(0xffffff);                     // Snow Peaks
        }
        else if (v.type === TYPE.OBSTACLE) color.setHex(0x111111); // Black for obstacles
        else if (v.type === TYPE.MARGIN_1) color.setHex(0xff0000); // Red
        else if (v.type === TYPE.MARGIN_2) color.setHex(0xff6600); // Orange
        else if (v.type === TYPE.MARGIN_3) color.setHex(0xffff00); // Yellow
        else if (v.type === TYPE.MARGIN_4) color.setHex(0x00ffff); // Cyan/Light Blue
        else color.setHex(0xffffff);

        mesh.setColorAt(i, color);
      }

      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
      this._voxelMesh = mesh;
      this._scene.add(mesh);
    }

    toggleVoxels(show) {
      this._showVoxels = show;
      if (this._voxelMesh) this._voxelMesh.visible = show;
      // Hide smooth mesh when voxels are on
      if (this._terrainMesh) this._terrainMesh.visible = !show;
      if (this._terrainWire) this._terrainWire.visible = !show;
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

      let line = this._trailLines.get(agent.id);
      
      if (!line) {
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array(120 * 3);
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.LineBasicMaterial({
          color: agent.faction === 'friendly' ? 0x00ff88 : 0xff4444,
          transparent: true, opacity: 0.5,
        });
        line = new THREE.Line(geo, mat);
        line.frustumCulled = false; // Prevents clipping as bounds change
        this._scene.add(line);
        this._trailLines.set(agent.id, line);
      }

      if (pts.length < 2) return;
      
      const positionAttr = line.geometry.attributes.position;
      for (let i = 0; i < pts.length; i++) {
        positionAttr.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
      }
      line.geometry.setDrawRange(0, pts.length);
      positionAttr.needsUpdate = true;
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
        side: THREE.DoubleSide, depthWrite: false, depthTest: false
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
      // Remove ALL old corridor objects (lines + dots + labels)
      if (this._corridorGroup) {
        this._scene.remove(this._corridorGroup);
        this._corridorGroup.traverse(obj => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
            else obj.material.dispose();
          }
        });
      }
      this._corridorGroup = new THREE.Group();
      this._corridorGroup.name = 'corridors';
      this._scene.add(this._corridorGroup);

      // Reset line refs
      this._corridorLines = { shortest: null, balanced: null, safest: null };

      const colors = {
        shortest: 0x00ff88,   // green  — shortest distance
        balanced: 0x00ccff,   // cyan   — balanced
        safest:   0xffdd00,   // yellow — safest / low-alt
      };

      const labels = {
        shortest: 'SHORTEST', balanced: 'BALANCED', safest: 'SAFEST',
      };

      for (const [type, path] of Object.entries(corridors)) {
        if (!path || path.length < 2) continue;
        const col = colors[type] || 0xffffff;

        // Lift path slightly above terrain
        const pts = path.map(p => new THREE.Vector3(p.x, p.y + 60, p.z));

        // Draw tube-style corridor line
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({
          color: col, transparent: true, opacity: 0.85, depthTest: false
        });
        const line = new THREE.Line(geo, mat);
        line.visible = this._showCorridors;
        this._corridorGroup.add(line);
        this._corridorLines[type] = line;

        // Waypoint spheres + lat/lon labels (every ~8 waypoints)
        const step = Math.max(1, Math.floor(pts.length / 8));
        for (let i = 0; i < pts.length; i += step) {
          const isFirst = (i === 0);
          const isLast  = (i >= pts.length - step);

          // Sphere
          const r = (isFirst || isLast) ? 70 : 40;
          const dotGeo = new THREE.SphereGeometry(r, 8, 8);
          const dotMat = new THREE.MeshBasicMaterial({ color: col, depthTest: false });
          const dot = new THREE.Mesh(dotGeo, dotMat);
          dot.position.copy(pts[i]);
          dot.visible = this._showCorridors;
          this._corridorGroup.add(dot);

          // Lat/lon label if geo-reference is available
          if (this._geoRef) {
            const ll = this._worldToLatLon(path[i].x, path[i].z);
            const labelText = `${ll.lat.toFixed(4)}°N\n${ll.lon.toFixed(4)}°E`;
            const sprite = this._makeTextSprite(labelText, col);
            sprite.position.set(pts[i].x, pts[i].y + 180, pts[i].z);
            sprite.visible = this._showCorridors;
            this._corridorGroup.add(sprite);
          }
        }

        // Corridor type label at start
        const startLabel = this._makeTextSprite(labels[type] || type.toUpperCase(), col);
        startLabel.position.set(pts[0].x, pts[0].y + 320, pts[0].z);
        startLabel.visible = this._showCorridors;
        this._corridorGroup.add(startLabel);
      }
    }

    // Convert world X/Z to geographic lat/lon using stored geoRef
    _worldToLatLon(wx, wz) {
      if (!this._geoRef) return { lat: 0, lon: 0 };
      const { originLat, originLon, mPerLat, mPerLon } = this._geoRef;
      return {
        lat: originLat + wz / mPerLat,
        lon: originLon + wx / mPerLon,
      };
    }

    // Create a canvas-based text sprite for 3D labels
    _makeTextSprite(text, color = 0x00ff88) {
      const lines = text.split('\n');
      const W = 340, H = lines.length > 1 ? 90 : 54;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      const hex = '#' + color.toString(16).padStart(6, '0');
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = hex;
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, W-2, H-2);
      ctx.fillStyle = hex;
      ctx.font = 'bold 22px Consolas, monospace';
      ctx.textAlign = 'center';
      lines.forEach((l, i) => ctx.fillText(l, W/2, 28 + i * 28));
      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(W * 1.8, H * 1.8, 1);
      return sprite;
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

    // Show geo-info in the HUD lat/lon panel
    setGeoHUD(geoInfo) {
      const el = document.getElementById('hud-geo');
      if (!el) return;
      const lat = geoInfo.lat != null ? geoInfo.lat.toFixed(4) + '°N' : '—';
      const lon = geoInfo.lon != null ? geoInfo.lon.toFixed(4) + '°E' : '—';
      const elev = geoInfo.elevMin != null
        ? `${geoInfo.elevMin}–${geoInfo.elevMax}m`
        : (geoInfo.altRange ? `Δ${geoInfo.altRange}m` : '');
      el.textContent = `🌐 ${lat}  ${lon}${elev ? '  ▲' + elev : ''}`;
      el.classList.remove('hidden');
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

      // Prevent orbit controls from also firing
      event.stopPropagation();

      const rect = this._renderer.domElement.getBoundingClientRect();
      this._mouse.x = ((event.clientX - rect.left) / rect.width)  *  2 - 1;
      this._mouse.y = ((event.clientY - rect.top)  / rect.height) * -2 + 1;

      this._raycaster.setFromCamera(this._mouse, this._camera);

      // Priority 1: raycast against actual terrain mesh (accurate heights)
      if (this._terrainMesh) {
        const wasVis = this._terrainMesh.visible;
        this._terrainMesh.visible = true;
        if (!wasVis) this._terrainMesh.updateMatrixWorld(true);
        
        const hits = this._raycaster.intersectObject(this._terrainMesh, false);
        this._terrainMesh.visible = wasVis;
        
        if (hits.length > 0) {
          const pt = hits[0].point;
          this._placementCB({ x: pt.x, y: pt.y, z: pt.z });
          this.cancelPlacement();
          return;
        }
      }

      // Priority 2: fallback to flat plane (handles edge/water areas)
      if (this._terrainPlane) {
        const hits = this._raycaster.intersectObject(this._terrainPlane, false);
        if (hits.length > 0) {
          const pt = hits[0].point;
          this._placementCB({ x: pt.x, y: 0, z: pt.z });
          this.cancelPlacement();
        }
      }
    }


    _onMouseMove(event) {
      const rect = this.canvas.getBoundingClientRect();
      const mx = ((event.clientX - rect.left) / rect.width)  *  2 - 1;
      const my = ((event.clientY - rect.top)  / rect.height) * -2 + 1;
      
      const tooltip = document.getElementById('cursor-tooltip');
      
      if (this._terrainMesh) {
        // Temporarily force visible to allow raycasting, even in voxel mode
        const wasVis = this._terrainMesh.visible;
        this._terrainMesh.visible = true;
        // CRITICAL: Ensure matrix is updated if it was hidden on the first frame
        if (!wasVis) this._terrainMesh.updateMatrixWorld(true);
        
        const rc = new THREE.Raycaster();
        rc.setFromCamera({ x: mx, y: my }, this._camera);
        const hits = rc.intersectObject(this._terrainMesh, false);
        
        this._terrainMesh.visible = wasVis;
        
        if (hits.length > 0) {
          const p = hits[0].point;
          let html = `<b>XYZ:</b> ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}<br>`;
          html += `<b>Elev:</b> ${Math.round(p.y)} m<br>`;
          
          if (window.JADO && JADO.state && JADO.state.terrainData && JADO.state.terrainData.geoRef) {
             const ref = JADO.state.terrainData.geoRef;
             const lon = ref.originLon + (p.x / ref.mPerLon);
             const lat = ref.originLat + (p.z / ref.mPerLat);
             html += `<b>Lat:</b> ${lat.toFixed(5)}°<br>`;
             html += `<b>Lon:</b> ${lon.toFixed(5)}°`;
          }
          
          if (tooltip) {
             tooltip.innerHTML = html;
             tooltip.style.left = (event.clientX + 15) + 'px';
             tooltip.style.top = (event.clientY + 15) + 'px';
             tooltip.style.display = 'block';
          }
          return;
        }
      }
      if (tooltip) tooltip.style.display = 'none';
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
      
      // Update Axis Labels
      if (this._axisLabels && this._axisLabels.length > 0) {
        const rect = this.canvas.parentNode.getBoundingClientRect();
        for (const lbl of this._axisLabels) {
          const vec = lbl.pos.clone();
          vec.project(this._camera);
          
          if (vec.z > 1) { // Behind camera
            lbl.el.style.display = 'none';
          } else {
            lbl.el.style.display = 'block';
            const x = (vec.x * 0.5 + 0.5) * rect.width;
            const y = (vec.y * -0.5 + 0.5) * rect.height;
            // Center label slightly
            lbl.el.style.left = (x - 20) + 'px';
            lbl.el.style.top = (y - 15) + 'px';
          }
        }
      }
    }

    dispose() {
      cancelAnimationFrame(this._animFrame);
      this._renderer.dispose();
    }
  }

  window.JADO.Renderer3D = Renderer3D;
})();
