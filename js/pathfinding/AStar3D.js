// js/pathfinding/AStar3D.js
// 3D A* pathfinding over VoxelGrid — produces 3 corridor variants
// Fastest | Low-Altitude (terrain masking) | Balanced
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  // 26-connected 3D neighborhood (all face/edge/corner neighbours)
  const NEIGHBORS_26 = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        if (dx || dy || dz) NEIGHBORS_26.push([dx, dy, dz]);

  // Octile distance heuristic (admissible in 3D)
  function octile3D(ax, ay, az, bx, by, bz) {
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    const dz = Math.abs(az - bz);
    const sorted = [dx, dy, dz].sort((a,b) => b - a); // [max, mid, min]
    return sorted[0] + (Math.SQRT2 - 1) * sorted[1] + (Math.sqrt(3) - Math.SQRT2) * sorted[2];
  }

  // Minimal binary min-heap for the open set
  class MinHeap {
    constructor() { this.data = []; }
    push(item) {
      this.data.push(item);
      this._bubbleUp(this.data.length - 1);
    }
    pop() {
      const top = this.data[0];
      const last = this.data.pop();
      if (this.data.length) { this.data[0] = last; this._sinkDown(0); }
      return top;
    }
    get size() { return this.data.length; }
    _bubbleUp(i) {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.data[p].f <= this.data[i].f) break;
        [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
        i = p;
      }
    }
    _sinkDown(i) {
      const n = this.data.length;
      while (true) {
        let min = i;
        const l = 2*i+1, r = 2*i+2;
        if (l < n && this.data[l].f < this.data[min].f) min = l;
        if (r < n && this.data[r].f < this.data[min].f) min = r;
        if (min === i) break;
        [this.data[min], this.data[i]] = [this.data[i], this.data[min]];
        i = min;
      }
    }
  }

  class AStar3D {
    constructor(grid) { this.grid = grid; }

    /**
     * Run A* from startVox to goalVox.
     * @param {object} startVox - {x,y,z} voxel
     * @param {object} goalVox  - {x,y,z} voxel
     * @param {number} altitudePenalty - extra cost per voxel of altitude (0=fastest, >0=hug terrain)
     * @param {number} threatPenalty   - extra cost multiplier for THREAT_ZONE voxels
     * @param {number} maxNodes        - node expansion cap to prevent freeze
     * @returns {Array|null} array of world-coordinate {x,y,z} or null if no path
     */
    findPath(startVox, goalVox, altitudePenalty = 0, threatPenalty = 2, maxNodes = 60000) {
      const grid = this.grid;
      if (grid.isBlocked(startVox.x, startVox.y, startVox.z)) return null;
      if (grid.isBlocked(goalVox.x, goalVox.y, goalVox.z)) return null;

      const key = (x, y, z) => `${x},${y},${z}`;
      const startKey = key(startVox.x, startVox.y, startVox.z);
      const goalKey  = key(goalVox.x,  goalVox.y,  goalVox.z);

      const openSet  = new MinHeap();
      const gScore   = new Map();
      const cameFrom = new Map();
      const closed   = new Set();

      gScore.set(startKey, 0);
      openSet.push({
        f: octile3D(startVox.x, startVox.y, startVox.z, goalVox.x, goalVox.y, goalVox.z),
        x: startVox.x, y: startVox.y, z: startVox.z,
      });

      let nodesExpanded = 0;

      while (openSet.size > 0) {
        const cur = openSet.pop();
        const ck  = key(cur.x, cur.y, cur.z);

        if (closed.has(ck)) continue;
        closed.add(ck);

        if (ck === goalKey) return this._reconstructPath(cameFrom, cur, grid);

        if (++nodesExpanded > maxNodes) break; // Time cap

        const curG = gScore.get(ck) || 0;

        for (const [dx, dy, dz] of NEIGHBORS_26) {
          const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
          if (!grid.inBounds(nx, ny, nz)) continue;

          const vType = grid.getType(nx, ny, dz);
          if (vType === 1 || vType === 2) continue; // terrain/obstacle: blocked

          const nk = key(nx, ny, nz);
          if (closed.has(nk)) continue;

          // Step cost: Euclidean distance in voxel space
          let stepCost = Math.sqrt(dx*dx + dy*dy + dz*dz);
          // Altitude penalty (encourages low flight)
          stepCost += altitudePenalty * ny;
          // Threat zone penalty
          if (vType === 3) stepCost *= threatPenalty;

          const tentG = curG + stepCost;
          if (tentG < (gScore.get(nk) || Infinity)) {
            gScore.set(nk, tentG);
            cameFrom.set(nk, { x: cur.x, y: cur.y, z: cur.z });
            openSet.push({
              f: tentG + octile3D(nx, ny, nz, goalVox.x, goalVox.y, goalVox.z),
              x: nx, y: ny, z: nz,
            });
          }
        }
      }

      // No path found — try relaxed (allow threat zones)
      if (threatPenalty > 0) return this.findPath(startVox, goalVox, altitudePenalty, 0, maxNodes);
      return null;
    }

    _reconstructPath(cameFrom, goal, grid) {
      const key = (n) => `${n.x},${n.y},${n.z}`;
      const path = [];
      let cur = goal;
      while (cur) {
        const w = grid.voxelCenterWorld(cur.x, cur.y, cur.z);
        path.push(w);
        cur = cameFrom.get(key(cur));
      }
      path.reverse();
      // Smooth path (Douglas-Peucker simplification)
      return this._smooth(path);
    }

    // Simple path smoothing: remove collinear points
    _smooth(path, epsilon = 0.5) {
      if (path.length <= 3) return path;
      const result = [path[0]];
      for (let i = 1; i < path.length - 1; i++) {
        const prev = result[result.length - 1];
        const cur  = path[i];
        const next = path[i + 1];
        // Check if cur is roughly on the line from prev to next
        const dx1 = cur.x - prev.x, dy1 = cur.y - prev.y, dz1 = cur.z - prev.z;
        const dx2 = next.x - prev.x, dy2 = next.y - prev.y, dz2 = next.z - prev.z;
        const len2 = Math.sqrt(dx2*dx2 + dy2*dy2 + dz2*dz2);
        if (len2 < 0.001) continue;
        // Perpendicular distance
        const t = (dx1*dx2 + dy1*dy2 + dz1*dz2) / (len2*len2);
        const px = prev.x + t*dx2 - cur.x;
        const py = prev.y + t*dy2 - cur.y;
        const pz = prev.z + t*dz2 - cur.z;
        const dist = Math.sqrt(px*px + py*py + pz*pz);
        if (dist > epsilon) result.push(cur);
      }
      result.push(path[path.length - 1]);
      return result;
    }

    /**
     * Plan all 3 corridors from world-coordinate start/goal.
     * Returns { fastest, lowAlt, balanced } — each is array of {x,y,z} or null
     */
    planCorridors(startWorld, goalWorld) {
      const s = this.grid.worldToVoxel(startWorld.x, startWorld.y, startWorld.z);
      const g = this.grid.worldToVoxel(goalWorld.x, goalWorld.y, goalWorld.z);

      // Clamp to grid
      const clamp = (v) => ({
        x: Math.max(0, Math.min(this.grid.dimX-1, v.x)),
        y: Math.max(0, Math.min(this.grid.dimY-1, v.y)),
        z: Math.max(0, Math.min(this.grid.dimZ-1, v.z)),
      });

      const sc = clamp(s), gc = clamp(g);

      console.log('[A*] Planning corridors', sc, '→', gc);

      return {
        fastest:  this.findPath(sc, gc, 0.0, 3.0),   // pure distance, avoid threats
        lowAlt:   this.findPath(sc, gc, 0.6, 4.0),   // hug terrain, strong threat avoid
        balanced: this.findPath(sc, gc, 0.25, 2.5),  // compromise
      };
    }
  }

  window.JADO.AStar3D = AStar3D;
})();
