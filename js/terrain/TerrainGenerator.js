// js/terrain/TerrainGenerator.js
// Procedural terrain using multi-octave Perlin noise → VoxelGrid + Three.js mesh
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  // ── Perlin Noise (seeded, no external library) ────────────────
  class PerlinNoise {
    constructor(seed = 42) {
      this.perm = new Uint8Array(512);
      const p = new Uint8Array(256);
      for (let i = 0; i < 256; i++) p[i] = i;
      // Seeded shuffle (LCG)
      let s = seed;
      for (let i = 255; i > 0; i--) {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        const j = Math.abs(s) % (i + 1);
        [p[i], p[j]] = [p[j], p[i]];
      }
      for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    }

    fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
    lerp(a, b, t) { return a + t * (b - a); }
    grad(hash, x, y) {
      const h = hash & 3;
      return ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
    }

    noise(x, y) {
      const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
      const xf = x - Math.floor(x), yf = y - Math.floor(y);
      const u = this.fade(xf), v = this.fade(yf);
      const aa = this.perm[this.perm[xi] + yi];
      const ab = this.perm[this.perm[xi] + yi + 1];
      const ba = this.perm[this.perm[xi+1] + yi];
      const bb = this.perm[this.perm[xi+1] + yi + 1];
      return this.lerp(
        this.lerp(this.grad(aa, xf, yf),   this.grad(ba, xf-1, yf),   u),
        this.lerp(this.grad(ab, xf, yf-1), this.grad(bb, xf-1, yf-1), u),
        v
      );
    }

    // Multi-octave fractal Brownian motion
    fbm(x, y, octaves = 6, lacunarity = 2.0, gain = 0.5) {
      let value = 0, amp = 0.5, freq = 1;
      for (let i = 0; i < octaves; i++) {
        value += amp * this.noise(x * freq, y * freq);
        amp  *= gain; freq *= lacunarity;
      }
      return value;
    }
  }

  // ── TerrainGenerator ─────────────────────────────────────────
  class TerrainGenerator {
    /**
     * @param {object} opts
     *   worldSizeX, worldSizeZ: meters
     *   maxHeight: meters
     *   voxelSize: meters
     *   seed: int
     *   flatness: 0–1 (0=very rough, 1=flat)
     */
    generate(opts = {}) {
      const {
        worldSizeX = 5000,
        worldSizeZ = 5000,
        maxHeight  = 1200,
        voxelSize  = 50,
        seed       = 42,
        flatness   = 0.0,
      } = opts;

      const dimX = Math.ceil(worldSizeX / voxelSize);
      const dimZ = Math.ceil(worldSizeZ / voxelSize);
      const dimY = Math.ceil(maxHeight  / voxelSize) + 4;

      const noise = new PerlinNoise(seed);
      const heights = new Float32Array(dimX * dimZ);

      // Generate heightmap
      for (let x = 0; x < dimX; x++) {
        for (let z = 0; z < dimZ; z++) {
          const nx = x / dimX * 3.5;
          const nz = z / dimZ * 3.5;
          let h = (noise.fbm(nx, nz, 6, 2.0, 0.5) + 0.5); // 0–1
          // Apply flatness: lerp toward baseline
          h = h * (1 - flatness) + 0.05 * flatness;
          // Ridge-like features by folding
          h = Math.pow(Math.max(0, h), 1.2);
          // Edge falloff (coastline effect)
          const ex = Math.sin(Math.PI * x / dimX);
          const ez = Math.sin(Math.PI * z / dimZ);
          h *= ex * ez;
          heights[x * dimZ + z] = h * maxHeight;
        }
      }

      // Build VoxelGrid
      const VoxelGrid = window.JADO.VoxelGrid;
      const grid = new VoxelGrid(dimX, dimY, dimZ, voxelSize);
      grid.applyHeightmap(heights);
      grid.inflate(1); // 1 voxel safety margin

      // Build Three.js mesh
      const mesh = this._buildMesh(dimX, dimZ, voxelSize, heights, maxHeight);

      return { grid, mesh, heights, dimX, dimY, dimZ, voxelSize, worldSizeX, worldSizeZ, maxHeight };
    }

    _buildMesh(dimX, dimZ, voxelSize, heights, maxHeight) {
      const geometry = new THREE.PlaneGeometry(
        dimX * voxelSize, dimZ * voxelSize,
        dimX - 1, dimZ - 1
      );
      geometry.rotateX(-Math.PI / 2);

      // Apply heights to vertices
      const pos = geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const xi = Math.floor(i % dimX);
        const zi = Math.floor(i / dimX);
        const h = heights[xi * dimZ + zi] || 0;
        pos.setY(i, h);
      }
      pos.needsUpdate = true;
      geometry.computeVertexNormals();

      // Vertex colors for terrain type (green→brown→white by altitude)
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const h = pos.getY(i) / maxHeight; // 0–1
        let r, g, b;
        if (h < 0.1) { r=0.13; g=0.30; b=0.10; }       // deep green (lowlands)
        else if (h < 0.35) { r=0.20; g=0.38; b=0.12; }  // green
        else if (h < 0.55) { r=0.45; g=0.38; b=0.22; }  // brown
        else if (h < 0.75) { r=0.55; g=0.50; b=0.38; }  // rocky
        else { r=0.92; g=0.92; b=0.92; }                 // snow
        colors[i*3]=r; colors[i*3+1]=g; colors[i*3+2]=b;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      const material = new THREE.MeshPhongMaterial({
        vertexColors: true,
        shininess: 8,
        specular: new THREE.Color(0x111111),
      });

      const mesh = new THREE.Mesh(geometry, material);
      // Center mesh on XZ
      mesh.position.set(dimX * voxelSize / 2, 0, dimZ * voxelSize / 2);
      mesh.receiveShadow = true;
      mesh.name = 'terrain';
      return mesh;
    }
  }

  window.JADO.TerrainGenerator = new TerrainGenerator();
})();
