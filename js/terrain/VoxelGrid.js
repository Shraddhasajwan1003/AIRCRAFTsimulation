// js/terrain/VoxelGrid.js
// 3D voxel occupancy grid for pathfinding, collision and RL state
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  // Voxel types (0-3 are solid/core, 10+ are distance field margins)
  const TYPE = { 
    FREE: 0, TERRAIN: 1, OBSTACLE: 2, THREAT_ZONE: 3,
    MARGIN_1: 11, // 1 voxel away (very high cost)
    MARGIN_2: 12, // 2 voxels away (high cost)
    MARGIN_3: 13, // 3 voxels away (medium cost)
    MARGIN_4: 14  // 4 voxels away (low cost)
  };

  class VoxelGrid {
    /**
     * @param {number} dimX  - number of voxels in X
     * @param {number} dimY  - number of voxels in Y (altitude)
     * @param {number} dimZ  - number of voxels in Z
     * @param {number} voxelSize - meters per voxel edge
     */
    constructor(dimX, dimY, dimZ, voxelSize) {
      this.dimX      = dimX;
      this.dimY      = dimY;
      this.dimZ      = dimZ;
      this.voxelSize = voxelSize;
      // Flat Uint8Array for speed — index = x*dimY*dimZ + y*dimZ + z
      this.data = new Uint8Array(dimX * dimY * dimZ);
    }

    // ── Index ────────────────────────────────────────────────────

    _idx(vx, vy, vz) { return vx * this.dimY * this.dimZ + vy * this.dimZ + vz; }

    inBounds(vx, vy, vz) {
      return vx >= 0 && vy >= 0 && vz >= 0 &&
             vx < this.dimX && vy < this.dimY && vz < this.dimZ;
    }

    // ── Read/Write ───────────────────────────────────────────────

    getType(vx, vy, vz) {
      if (!this.inBounds(vx, vy, vz)) return TYPE.TERRAIN; // treat OOB as solid
      return this.data[this._idx(vx, vy, vz)];
    }

    setType(vx, vy, vz, type) {
      if (!this.inBounds(vx, vy, vz)) return;
      this.data[this._idx(vx, vy, vz)] = type;
    }

    isFree(vx, vy, vz) { return this.getType(vx, vy, vz) === TYPE.FREE; }
    isBlocked(vx, vy, vz) { return this.getType(vx, vy, vz) !== TYPE.FREE; }

    // ── Coordinate conversion ─────────────────────────────────────

    worldToVoxel(wx, wy, wz) {
      return {
        x: Math.floor(wx / this.voxelSize),
        y: Math.floor(wy / this.voxelSize),
        z: Math.floor(wz / this.voxelSize),
      };
    }

    voxelToWorld(vx, vy, vz) {
      return {
        x: (vx + 0.5) * this.voxelSize,
        y: (vy + 0.5) * this.voxelSize,
        z: (vz + 0.5) * this.voxelSize,
      };
    }

    voxelCenterWorld(vx, vy, vz) { return this.voxelToWorld(vx, vy, vz); }

    // ── Terrain marking from heightmap ───────────────────────────
    // heights: Float32Array of length dimX*dimZ, value = height in meters

    applyHeightmap(heights) {
      for (let x = 0; x < this.dimX; x++) {
        for (let z = 0; z < this.dimZ; z++) {
          const h = heights[x * this.dimZ + z];
          const maxVY = Math.min(Math.ceil(h / this.voxelSize), this.dimY - 1);
          for (let y = 0; y <= maxVY; y++) {
            this.setType(x, y, z, TYPE.TERRAIN);
          }
        }
      }
    }

    // ── Obstacle/threat zone placement ───────────────────────────

    setBox(cx, cy, cz, halfW, halfH, halfD, type) {
      const x0 = Math.max(0, cx - halfW), x1 = Math.min(this.dimX-1, cx + halfW);
      const y0 = Math.max(0, cy - halfH), y1 = Math.min(this.dimY-1, cy + halfH);
      const z0 = Math.max(0, cz - halfD), z1 = Math.min(this.dimZ-1, cz + halfD);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++)
            this.setType(x, y, z, type);
    }

    // Sphere-shaped zone (used for threat radius)
    setSphere(cx, cy, cz, radius, type) {
      const r = Math.ceil(radius);
      for (let x = cx-r; x <= cx+r; x++)
        for (let y = cy-r; y <= cy+r; y++)
          for (let z = cz-r; z <= cz+r; z++) {
            if ((x-cx)**2 + (y-cy)**2 + (z-cz)**2 <= radius*radius)
              this.setType(x, y, z, type);
          }
    }

    // Inflate only a specific voxel type by a margin (safety margin)
    inflateZone(targetType, marginVox) {
      if (marginVox <= 0) return;
      const copy = new Uint8Array(this.data);
      const offsets = [];
      for (let dx = -marginVox; dx <= marginVox; dx++)
        for (let dy = -marginVox; dy <= marginVox; dy++)
          for (let dz = -marginVox; dz <= marginVox; dz++)
            if (dx*dx + dy*dy + dz*dz <= marginVox*marginVox)
              offsets.push([dx, dy, dz]);

      for (let x = 0; x < this.dimX; x++)
        for (let y = 0; y < this.dimY; y++)
          for (let z = 0; z < this.dimZ; z++) {
            if (copy[this._idx(x,y,z)] === targetType) {
              for (const [dx,dy,dz] of offsets) {
                const nx=x+dx, ny=y+dy, nz=z+dz;
                if (this.inBounds(nx,ny,nz) && this.data[this._idx(nx,ny,nz)] === TYPE.FREE)
                  this.data[this._idx(nx,ny,nz)] = targetType;
              }
            }
          }
    }

    // ── Distance Field / Cost Gradient ────────────────────────────

    // Scans outward from all TERRAIN and OBSTACLE voxels to create concentric
    // layers of MARGIN_X voxels. These act as a visual and pathfinding cost gradient.
    computeDistanceField() {
      console.log('[VoxelGrid] Computing 4-layer distance field...');
      let currentShell = [];
      const dims = this.dimX * this.dimY * this.dimZ;
      
      // Pass 0: Find all solid boundaries
      for (let i = 0; i < dims; i++) {
        const t = this.data[i];
        if (t === TYPE.TERRAIN || t === TYPE.OBSTACLE) {
          currentShell.push(i);
        }
      }

      // 6-connected neighbor offsets (up, down, left, right, front, back)
      const nOffs = [
        1, -1, 
        this.dimZ, -this.dimZ, 
        this.dimY * this.dimZ, -this.dimY * this.dimZ
      ];

      // Pass 1-4: Propagate outward
      const layers = [TYPE.MARGIN_1, TYPE.MARGIN_2, TYPE.MARGIN_3, TYPE.MARGIN_4];
      
      for (let d = 0; d < layers.length; d++) {
        const nextShell = [];
        const layerType = layers[d];
        
        for (let i = 0; i < currentShell.length; i++) {
          const idx = currentShell[i];
          // Recover x,y,z to check bounds
          const z = idx % this.dimZ;
          const y = Math.floor(idx / this.dimZ) % this.dimY;
          const x = Math.floor(idx / (this.dimY * this.dimZ));

          for (const off of nOffs) {
            const nIdx = idx + off;
            // Strict bounds check via coordinates to prevent wrap-around
            if (off === 1 && z === this.dimZ - 1) continue;
            if (off === -1 && z === 0) continue;
            if (off === this.dimZ && y === this.dimY - 1) continue;
            if (off === -this.dimZ && y === 0) continue;
            if (off === this.dimY * this.dimZ && x === this.dimX - 1) continue;
            if (off === -this.dimY * this.dimZ && x === 0) continue;

            if (this.data[nIdx] === TYPE.FREE) {
              this.data[nIdx] = layerType;
              nextShell.push(nIdx);
            }
          }
        }
        currentShell = nextShell;
      }
      console.log('[VoxelGrid] Distance field complete.');
    }

    // ── Surface height query ──────────────────────────────────────
    // Returns the world Y of the highest TERRAIN voxel at (wx, wz)

    surfaceHeightAt(wx, wz) {
      const vx = Math.max(0, Math.min(this.dimX-1, Math.floor(wx / this.voxelSize)));
      const vz = Math.max(0, Math.min(this.dimZ-1, Math.floor(wz / this.voxelSize)));
      for (let vy = this.dimY - 1; vy >= 0; vy--) {
        if (!this.isFree(vx, vy, vz)) return (vy + 1) * this.voxelSize;
      }
      return 0;
    }

    // ── Local window extraction for RL state ─────────────────────
    // Returns flat 27-element array (3×3×3 centered on agent voxel)
    // 0 = free, 1 = occupied

    getLocalWindow(wx, wy, wz) {
      const { x: vx, y: vy, z: vz } = this.worldToVoxel(wx, wy, wz);
      const window = new Float32Array(27);
      let i = 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            window[i++] = this.isFree(vx+dx, vy+dy, vz+dz) ? 0.0 : 1.0;
      return window;
    }

    // ── Serialization ─────────────────────────────────────────────

    toJSON() {
      return {
        dimX: this.dimX, dimY: this.dimY, dimZ: this.dimZ,
        voxelSize: this.voxelSize,
        data: Array.from(this.data),
      };
    }

    static fromJSON(obj) {
      const g = new VoxelGrid(obj.dimX, obj.dimY, obj.dimZ, obj.voxelSize);
      g.data = new Uint8Array(obj.data);
      return g;
    }
  }

  VoxelGrid.TYPE = TYPE;
  window.JADO.VoxelGrid = VoxelGrid;
})();
