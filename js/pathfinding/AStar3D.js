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
     * Lift a voxel coordinate upward until it is in FREE space.
     * Guarantees start/goal are never inside terrain.
     * Minimum clearance: minClearVoxels above the surface.
     */
    _liftToFree(vx, vz, prefY, minClearVoxels = 2) {
      const grid = this.grid;
      vx = Math.max(0, Math.min(grid.dimX - 1, vx));
      vz = Math.max(0, Math.min(grid.dimZ - 1, vz));

      // Find highest blocked voxel in this XZ column
      let surfaceY = 0;
      for (let vy = grid.dimY - 1; vy >= 0; vy--) {
        if (!grid.isFree(vx, vy, vz)) { surfaceY = vy; break; }
      }

      // Place voxel above surface + clearance (or at prefY if higher)
      const safeY = surfaceY + minClearVoxels;
      const vy = Math.max(safeY, Math.min(grid.dimY - 1, prefY));
      return { x: vx, y: vy, z: vz };
    }

    /**
     * Run A* from startVox to goalVox.
     * @param {object} startVox - {x,y,z} voxel
     * @param {object} goalVox  - {x,y,z} voxel
     * @param {number} altitudePenalty - extra cost per voxel of altitude (0=fastest, >0=hug terrain)
     * @param {number} threatPenalty   - extra cost multiplier for THREAT_ZONE voxels
     * @param {number} maxNodes        - node expansion cap to prevent freeze
     * @returns {Array|null} array of world-coordinate {x,y,z} or null if no path
     */
    findPath(startVox, goalVox, altitudePenalty = 0, threatPenalty = 2, maxNodes = 80000) {
      const grid = this.grid;

      // Ensure start/goal are above terrain surface
      const sv = this._liftToFree(startVox.x, startVox.z, startVox.y, 2);
      const gv = this._liftToFree(goalVox.x,  goalVox.z,  goalVox.y,  2);

      const key = (x, y, z) => `${x},${y},${z}`;
      const startKey = key(sv.x, sv.y, sv.z);
      const goalKey  = key(gv.x, gv.y, gv.z);

      const openSet  = new MinHeap();
      const gScore   = new Map();
      const cameFrom = new Map();
      const closed   = new Set();

      gScore.set(startKey, 0);
      openSet.push({
        f: octile3D(sv.x, sv.y, sv.z, gv.x, gv.y, gv.z),
        x: sv.x, y: sv.y, z: sv.z,
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

          // ── BUG FIX: was grid.getType(nx, ny, dz) — must use nz ──
          const vType = grid.getType(nx, ny, nz);
          if (vType === 1 || vType === 2) continue; // terrain/obstacle: blocked

          const nk = key(nx, ny, nz);
          if (closed.has(nk)) continue;

          // Step cost: Euclidean distance in voxel space
          let stepCost = Math.sqrt(dx*dx + dy*dy + dz*dz);
          
          // Distance Field Penalty (Push away from solid boundaries)
          // 11=MARGIN_1, 12=MARGIN_2, 13=MARGIN_3, 14=MARGIN_4
          if (vType === 11) stepCost += 12.0; // Very close
          else if (vType === 12) stepCost += 6.0;  // Close
          else if (vType === 13) stepCost += 3.0;  // Moderate
          else if (vType === 14) stepCost += 1.0;  // Far
          
          // Altitude penalty (encourages low flight)
          stepCost += altitudePenalty * ny;
          
          // Threat zone penalty (Dynamic calculation)
          if (window.JADO && window.JADO.state && window.JADO.state.threats) {
            let inThreat = false;
            const wx = nx * grid.voxelSize;
            const wz = nz * grid.voxelSize;
            for (let i = 0; i < window.JADO.state.threats.length; i++) {
              const t = window.JADO.state.threats[i];
              const dx = wx - t.x;
              const dz = wz - t.z;
              const r = t.spec ? (t.spec.radius || 50000) : 50000;
              // Treat threat zone as an infinite cylinder for safety
              if (dx*dx + dz*dz <= r*r) {
                inThreat = true;
                break;
              }
            }
            if (inThreat) stepCost *= threatPenalty;
          }

          const tentG = curG + stepCost;
          if (tentG < (gScore.get(nk) || Infinity)) {
            gScore.set(nk, tentG);
            cameFrom.set(nk, { x: cur.x, y: cur.y, z: cur.z });
            openSet.push({
              f: tentG + octile3D(nx, ny, nz, gv.x, gv.y, gv.z),
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
    _smooth(path, epsilon = 0.8) {
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
        if (Math.sqrt(px*px + py*py + pz*pz) > epsilon) result.push(cur);
      }
      result.push(path[path.length - 1]);
      return result;
    }

    /**
     * Plan all 3 corridors from world-coordinate start/goal.
     *
     * SHORTEST — pure octile distance, ignores threat zones and altitude
     *            Best for drones / fast strike aircraft needing direct route
     *
     * BALANCED — moderate threat avoidance (×3), slight altitude preference
     *            General-purpose corridor for medium-altitude assets
     *
     * SAFEST   — maximum threat avoidance (×8), strong altitude preference
     *            NOE (Nap-of-Earth) terrain masking, hugs terrain for radar shadow
     *
     * Returns { shortest, balanced, safest } — each is array of {x,y,z} or null
     */
    planCorridors(startWorld, goalWorld) {
      const s = this.grid.worldToVoxel(startWorld.x, startWorld.y, startWorld.z);
      const g = this.grid.worldToVoxel(goalWorld.x,  goalWorld.y,  goalWorld.z);

      // Lift both ends above terrain before planning
      const sc = this._liftToFree(s.x, s.z, s.y, 2);
      const gc = this._liftToFree(g.x, g.z, g.y, 2);

      console.log('[A*] Planning corridors vox', sc, '→', gc);

      const t0 = performance.now();

      // SHORTEST: pure distance, no threat/altitude bias
      const shortest  = this.findPath(sc, gc, 0.0,  1.0);
      const t1 = performance.now();

      // BALANCED: moderate threat avoidance, slight altitude cost
      const balanced  = this.findPath(sc, gc, 0.15, 3.0);
      const t2 = performance.now();

      // SAFEST: heavy threat avoidance, strong preference to hug terrain
      // (low altitude = radar masking by terrain)
      const safest    = this.findPath(sc, gc, 0.5,  8.0);
      const t3 = performance.now();

      // Compute rich statistics for UI panel
      const stats = {};
      const pathStats = (path, name, ms) => {
        if (!path) { stats[name] = null; return; }
        let len = 0;
        for (let i = 1; i < path.length; i++) {
          const dx = path[i].x - path[i-1].x;
          const dy = path[i].y - path[i-1].y;
          const dz = path[i].z - path[i-1].z;
          len += Math.sqrt(dx*dx + dy*dy + dz*dz);
        }
        const altitudes = path.map(p => p.y);
        stats[name] = {
          waypoints:  path.length,
          lengthKm:   (len / 1000).toFixed(2),
          minAlt:     Math.round(Math.min(...altitudes)),
          maxAlt:     Math.round(Math.max(...altitudes)),
          avgAlt:     Math.round(altitudes.reduce((a,b)=>a+b,0) / altitudes.length),
          computeMs:  Math.round(ms),
          sampleWaypoints: path
            .filter((_, i) => i % Math.max(1, Math.floor(path.length / 8)) === 0)
            .map(p => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) })),
        };
      };
      pathStats(shortest, 'shortest', t1 - t0);
      pathStats(balanced, 'balanced', t2 - t1);
      pathStats(safest,   'safest',   t3 - t2);

      window.JADO.state.corridorStats = stats;
      return { shortest, balanced, safest };
    }
  }

  window.JADO.AStar3D = AStar3D;
})();
