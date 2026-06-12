// js/terrain/TerrainLoader.js
// Loads OBJ or STL files → Three.js geometry → vertex colours → VoxelGrid
// Features:
//   - Relative altitude colouring (min..max of the file, not 0..maxHeight)
//   - Lat/lon extraction from OBJ comments + auto-detect from vertex values
//   - Z-up / Y-up convention handling
//   - Original geometry preserved (no detail-losing plane rebuild)
//   - Rich military colour palette: deep green → savanna → slope → rock → snow
(function () {
  'use strict';
  window.JADO = window.JADO || {};

  // ── Colour palette (normalised 0–1 altitude bands) ───────────────────────
  // Each entry: [threshold, r, g, b]
  const ALT_PALETTE = [
    [0.00, 0.05, 0.18, 0.04],  // deep shadow green
    [0.08, 0.10, 0.30, 0.08],  // forest green
    [0.20, 0.16, 0.38, 0.10],  // mid green
    [0.35, 0.30, 0.42, 0.14],  // highland green
    [0.46, 0.48, 0.44, 0.22],  // savanna / dry grass
    [0.56, 0.52, 0.42, 0.28],  // sandy slope
    [0.65, 0.54, 0.44, 0.32],  // light earth
    [0.73, 0.52, 0.48, 0.42],  // rocky brown
    [0.80, 0.60, 0.56, 0.52],  // grey rock
    [0.88, 0.74, 0.72, 0.70],  // high rock
    [0.93, 0.88, 0.88, 0.88],  // snow patch
    [1.00, 0.97, 0.97, 0.97],  // peak snow
  ];

  function altitudeColor(t) {
    // t: 0..1  relative to this file's min..max height
    t = Math.max(0, Math.min(1, t));
    for (let i = ALT_PALETTE.length - 1; i >= 0; i--) {
      if (t >= ALT_PALETTE[i][0]) {
        // Lerp to next band
        const lo = ALT_PALETTE[i];
        const hi = ALT_PALETTE[Math.min(i + 1, ALT_PALETTE.length - 1)];
        const span = hi[0] - lo[0];
        const f = span > 0 ? (t - lo[0]) / span : 0;
        return [
          lo[1] + f * (hi[1] - lo[1]),
          lo[2] + f * (hi[2] - lo[2]),
          lo[3] + f * (hi[3] - lo[3]),
        ];
      }
    }
    return [0.97, 0.97, 0.97];
  }

  // ── Geo-info extraction from OBJ text ────────────────────────────────────

  function parseGeoInfo(text) {
    const info = {
      hasGeoRef: false, lat: null, lon: null,
      minLat: null, maxLat: null, minLon: null, maxLon: null,
      minElev: null, maxElev: null, crs: null, source: null,
      elevUnit: 'm',
    };

    // Only scan first 200 lines (comments are at top)
    const head = text.split('\n').slice(0, 200);
    for (const raw of head) {
      const line = raw.trim();
      if (!line.startsWith('#') && line !== '' && !line.startsWith('mtllib') && !line.startsWith('o ')) continue;

      let m;

      // lat / lon single-origin
      m = line.match(/lat[itude]*[\s:=]+([+-]?\d+\.?\d*)[,\s;]+lon[gitude]*[\s:=]+([+-]?\d+\.?\d*)/i);
      if (m) { info.lat = +m[1]; info.lon = +m[2]; info.hasGeoRef = true; }

      // lon / lat order
      m = line.match(/lon[gitude]*[\s:=]+([+-]?\d+\.?\d*)[,\s;]+lat[itude]*[\s:=]+([+-]?\d+\.?\d*)/i);
      if (m) { info.lon = +m[1]; info.lat = +m[2]; info.hasGeoRef = true; }

      // bounds / extent: minLon minLat maxLon maxLat or minLat minLon maxLat maxLon
      m = line.match(/(?:bounds?|extent)[:\s]+([+-]?\d+\.?\d*)[,\s]+([+-]?\d+\.?\d*)[,\s]+([+-]?\d+\.?\d*)[,\s]+([+-]?\d+\.?\d*)/i);
      if (m) {
        const nums = [+m[1], +m[2], +m[3], +m[4]];
        // Heuristic: if first value ≥ 180 it might be UTM, else treat as lon/lat
        if (Math.abs(nums[0]) <= 180 && Math.abs(nums[1]) <= 90) {
          [info.minLon, info.minLat, info.maxLon, info.maxLat] = nums;
        } else {
          [info.minLat, info.minLon, info.maxLat, info.maxLon] = nums;
        }
        info.hasGeoRef = true;
      }

      // Elevation range
      m = line.match(/elev[ation]*[\s:]+([+-]?\d+\.?\d*)[\s\w]+([+-]?\d+\.?\d*)/i);
      if (m) { info.minElev = +m[1]; info.maxElev = +m[2]; }

      // Unit
      if (/feet|ft\b/i.test(line)) info.elevUnit = 'ft';

      // CRS / EPSG
      m = line.match(/EPSG[:\s]+(\d+)/i);
      if (m) info.crs = 'EPSG:' + m[1];

      // Source / generator tags
      m = line.match(/(?:source|generated.?by|export)[:\s]+(.+)/i);
      if (m) info.source = m[1].trim().slice(0, 60);
    }

    // ── Auto-detect geographic coordinates from vertex values ─────────────
    if (!info.hasGeoRef) {
      const vLines = [];
      const all = text.split('\n');
      for (const l of all) {
        if (l.startsWith('v ')) { vLines.push(l); if (vLines.length >= 40) break; }
      }
      const xs = [], zs = [];
      for (const vl of vLines) {
        const p = vl.trim().split(/\s+/);
        if (p.length >= 4) { xs.push(+p[1]); zs.push(+p[3]); }
      }
      if (xs.length >= 5) {
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minZ = Math.min(...zs), maxZ = Math.max(...zs);
        // If X looks like longitude and Z looks like latitude
        if (minX >= -180 && maxX <= 180 && minZ >= -90 && maxZ <= 90) {
          info.minLon = minX; info.maxLon = maxX;
          info.minLat = minZ; info.maxLat = maxZ;
          info.lat    = (minZ + maxZ) / 2;
          info.lon    = (minX + maxX) / 2;
          info.hasGeoRef = true;
          info.autoDetected = true;
        }
      }
    }

    return info;
  }

  // ── Axis convention detection ─────────────────────────────────────────────
  // Some exporters use Z-up (Blender default). Detect by checking if
  // the Y-range is tiny compared to X/Z-range.

  function detectAxisConvention(geometry) {
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const sx = bb.max.x - bb.min.x;
    const sy = bb.max.y - bb.min.y;
    const sz = bb.max.z - bb.min.z;
    // Z-up: if Y range << Z range AND Z range is the "tall" axis
    if (sy < 0.01 * Math.max(sx, sz) && sz > sy * 10) return 'Z_UP';
    return 'Y_UP';
  }

  // ── Main class ────────────────────────────────────────────────────────────

  class TerrainLoader {
    /**
     * Load a File → terrain data (same shape as TerrainGenerator.generate()).
     */
    loadFile(file, voxelSize = 50) {
      const ext = file.name.split('.').pop().toLowerCase();

      // GeoTIFF: async path via geotiff.js
      if (ext === 'tif' || ext === 'tiff') {
        return this._loadGeoTIFF(file, voxelSize);
      }

      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            let geometry;
            let geoInfo = {};
            if (ext === 'obj') {
              geoInfo = parseGeoInfo(e.target.result);
              geometry = this._parseOBJ(e.target.result);
            } else if (ext === 'stl') {
              geometry = this._parseSTL(e.target.result);
            } else {
              reject(new Error('Unsupported format — use .obj, .stl, .tif or .tiff'));
              return;
            }
            resolve(this._processGeometry(geometry, voxelSize, file.name, geoInfo));
          } catch (err) { reject(err); }
        };
        reader.onerror = () => reject(new Error('File read error'));
        if (ext === 'stl') reader.readAsArrayBuffer(file);
        else reader.readAsText(file);
      });
    }

    // ── Parsers ─────────────────────────────────────────────────────────────

    _parseOBJ(text) {
      const loader = new THREE.OBJLoader();
      const obj = loader.parse(text);
      let geo = null;
      obj.traverse(child => {
        if (child.isMesh && !geo) geo = child.geometry.clone();
      });
      if (!geo) throw new Error('No mesh found in OBJ file');
      return geo;
    }

    _parseSTL(buffer) {
      return new THREE.STLLoader().parse(buffer);
    }

    // ── GeoTIFF / TIF loader ─────────────────────────────────────────────────

    async _loadGeoTIFF(file, voxelSize) {
      if (typeof GeoTIFF === 'undefined')
        throw new Error('GeoTIFF library missing. Run setup.bat to download geotiff.js, then reload.');

      const buf   = await file.arrayBuffer();
      const tiff  = await GeoTIFF.fromArrayBuffer(buf);
      const image = await tiff.getImage();

      const W = image.getWidth();
      const H = image.getHeight();
      const rasters  = await image.readRasters({ interleave: true });
      const elevData = rasters;   // Float32Array / Int16Array / Uint16Array

      // Geographic metadata
      const bbox    = image.getBoundingBox();   // [west, south, east, north]
      const fd      = image.getFileDirectory();
      const geoKeys = image.getGeoKeys();
      const epsg    = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey || 4326;
      const isGeo   = epsg === 4326 ||
                      (bbox[0] >= -180 && bbox[2] <= 180 && bbox[1] >= -90 && bbox[3] <= 90);

      const mps   = fd.ModelPixelScale || [1, 1, 0];
      const nodata = fd.GDAL_NODATA != null ? parseFloat(fd.GDAL_NODATA) : null;

      // Valid elevation range
      const valid  = v => v !== nodata && isFinite(v) && v > -10000 && v < 15000;
      let minE = Infinity, maxE = -Infinity;
      for (let i = 0; i < elevData.length; i++) {
        const v = elevData[i];
        if (!valid(v)) continue;
        if (v < minE) minE = v;
        if (v > maxE) maxE = v;
      }
      if (!isFinite(minE)) throw new Error('GeoTIFF: no valid elevation data found');
      const altRange = maxE - minE;

      // World size in metres
      let wsX, wsZ;
      if (isGeo) {
        const refLat = (bbox[1] + bbox[3]) / 2;
        wsX = (bbox[2] - bbox[0]) * 111320 * Math.cos(refLat * Math.PI / 180);
        wsZ = (bbox[3] - bbox[1]) * 110540;
      } else {
        wsX = Math.abs(bbox[2] - bbox[0]);
        wsZ = Math.abs(bbox[3] - bbox[1]);
      }
      const horizScale = 5000 / Math.max(wsX, wsZ, 1);
      wsX *= horizScale; wsZ *= horizScale;

      // Altitude scale — video game vertical exaggeration
      // Realistic proportions (1:1) look completely flat in 3D due to camera FOV.
      // We use up to 8x vertical exaggeration, capped at 2500m display height.
      const displayAltScale  = Math.min(horizScale * 8, 2500 / Math.max(altRange, 1));
      const maxHeight = altRange * displayAltScale;

      // Downsample to voxel grid via bilinear interpolation
      const dimX = Math.max(4, Math.ceil(wsX / voxelSize));
      const dimZ = Math.max(4, Math.ceil(wsZ / voxelSize));
      const heights = new Float32Array(dimX * dimZ);

      for (let gx = 0; gx < dimX; gx++) {
        for (let gz = 0; gz < dimZ; gz++) {
          const rx = (gx / (dimX - 1)) * (W - 1);
          const rz = (gz / (dimZ - 1)) * (H - 1);
          const x0 = Math.floor(rx), x1 = Math.min(x0 + 1, W - 1);
          const z0 = Math.floor(rz), z1 = Math.min(z0 + 1, H - 1);
          const fx = rx - x0, fz = rz - z0;
          const v00 = elevData[z0*W+x0], v10 = elevData[z0*W+x1];
          const v01 = elevData[z1*W+x0], v11 = elevData[z1*W+x1];
          let elev;
          if (valid(v00) && valid(v10) && valid(v01) && valid(v11)) {
            elev = v00*(1-fx)*(1-fz) + v10*fx*(1-fz) + v01*(1-fx)*fz + v11*fx*fz;
          } else {
            elev = [v00,v10,v01,v11].find(v => valid(v)) ?? minE;
          }
          heights[gx * dimZ + gz] = (elev - minE) * displayAltScale;
        }
      }

      // 4-pass Gaussian-weighted smoothing to remove DEM noise
      let h = heights;
      for (let pass = 0; pass < 4; pass++) {
        const s = new Float32Array(dimX * dimZ);
        const w = [1, 2, 1, 2, 4, 2, 1, 2, 1]; // 3×3 Gaussian weights, sum=16
        for (let x = 1; x < dimX-1; x++) {
          for (let z = 1; z < dimZ-1; z++) {
            let sum = 0;
            let k = 0;
            for (let dx = -1; dx <= 1; dx++)
              for (let dz = -1; dz <= 1; dz++, k++)
                sum += h[(x+dx)*dimZ+(z+dz)] * w[k];
            s[x*dimZ+z] = sum / 16;
          }
        }
        // Copy edges unchanged
        for (let x = 0; x < dimX; x++) { s[x*dimZ] = h[x*dimZ]; s[x*dimZ+dimZ-1] = h[x*dimZ+dimZ-1]; }
        for (let z = 0; z < dimZ; z++) { s[z] = h[z]; s[(dimX-1)*dimZ+z] = h[(dimX-1)*dimZ+z]; }
        h = s;
      }

      // Three.js mesh
      const mesh = this._buildMeshFromHeights(h, dimX, dimZ, wsX, wsZ, maxHeight);

      // VoxelGrid
      const dimY = Math.ceil(maxHeight / voxelSize) + 6;
      const grid = new JADO.VoxelGrid(dimX, dimY, dimZ, voxelSize);
      grid.applyHeightmap(h);
      grid.computeDistanceField(); // Computes 4-layer proximity gradient

      // Pixel size in metres for display
      const pixM = isGeo
        ? Math.round(mps[0] * 111320 * Math.cos(((bbox[1]+bbox[3])/2)*Math.PI/180))
        : Math.round(mps[0]);

      // Geographic reference for world↔latlon conversion
      const geoRef = {
        originLat: bbox[1],  // lat at world Z=0
        originLon: bbox[0],  // lon at world X=0
        mPerLat:   wsZ / (bbox[3] - bbox[1] || 1),
        mPerLon:   wsX / (bbox[2] - bbox[0] || 1),
      };

      const geoInfo = {
        hasGeoRef: true,
        lat: (bbox[1]+bbox[3])/2, lon: (bbox[0]+bbox[2])/2,
        minLat: bbox[1], maxLat: bbox[3],
        minLon: bbox[0], maxLon: bbox[2],
        elevMin: Math.round(minE), elevMax: Math.round(maxE),
        altRange: Math.round(altRange), elevUnit: 'm',
        crs: `EPSG:${epsg}`,
        source: fd.Software || fd.Artist || 'GeoTIFF DEM',
        pixelSizeM: pixM,
        rasterSize: `${W} × ${H} px`,
        convention: 'Y_UP', filename: file.name, autoDetected: false,
      };

      return { grid, mesh: mesh, heights: h, dimX, dimY, dimZ, voxelSize,
               worldSizeX: wsX, worldSizeZ: wsZ, maxHeight, geoInfo, geoRef };
    }

    // Build a coloured PlaneGeometry mesh from a flat heightmap
    // PlaneGeometry with (dimX-1, dimZ-1) segments has dimX*dimZ vertices.
    // After rotateX(-π/2): rows run along Z-axis, columns along X-axis.
    _buildMeshFromHeights(heights, dimX, dimZ, worldSizeX, worldSizeZ, maxHeight) {
      const geo = new THREE.PlaneGeometry(worldSizeX, worldSizeZ, dimX-1, dimZ-1);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      // PlaneGeometry vertex order after rotation:
      //   vertex i = col + row*dimX  (col=i%dimX, row=i/dimX)
      //   X maps to col, Z maps to row (flipped because of rotateX)
      for (let i = 0; i < pos.count; i++) {
        const col = i % dimX;
        const row = Math.floor(i / dimX);
        // Three.js PlaneGeometry rows go in +Z after rotation,
        // but our heightmap has row 0 at Z=0 (south), so flip row
        const hz  = (dimZ - 1) - row;
        const idx = col * dimZ + Math.max(0, Math.min(dimZ-1, hz));
        pos.setY(i, heights[idx] || 0);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const t = maxHeight > 0 ? pos.getY(i) / maxHeight : 0.5;
        const [r, g, b] = altitudeColor(Math.max(0, Math.min(1, t)));
        colors[i*3]=r; colors[i*3+1]=g; colors[i*3+2]=b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.MeshPhongMaterial({
        vertexColors: true, shininess: 8,
        specular: new THREE.Color(0x112211),
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.name = 'terrain';
      return mesh;
    }

    // ── Core processing ──────────────────────────────────────────────────────

    _processGeometry(geometry, voxelSize, filename, geoInfo = {}) {
      // Fix axis convention if Z-up
      const convention = detectAxisConvention(geometry);
      if (convention === 'Z_UP') {
        // Swap Y and Z so altitude is on Y
        geometry.applyMatrix4(new THREE.Matrix4().set(
          1, 0, 0, 0,
          0, 0, 1, 0,
          0, 1, 0, 0,
          0, 0, 0, 1
        ));
      }

      geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      const size = new THREE.Vector3(); bb.getSize(size);

      // ── Normalise to world space ──────────────────────────────────────────
      // If coordinates look like geographic (degrees), scale X/Z to metres
      // using rough degrees-to-metres conversion at the file's latitude
      const geographicXZ =
        geoInfo.hasGeoRef && geoInfo.autoDetected &&
        Math.abs(bb.max.x - bb.min.x) < 5 &&   // < 5° in X
        Math.abs(bb.max.z - bb.min.z) < 5;       // < 5° in Z

      let scaleX = 1, scaleZ = 1;
      if (geographicXZ) {
        const refLat = geoInfo.lat || 0;
        const mPerDegLon = 111320 * Math.cos(refLat * Math.PI / 180);
        const mPerDegLat = 110540;
        // Scale so 1 unit of file-X → metres
        scaleX = mPerDegLon;
        scaleZ = mPerDegLat;
      }

      // Translate so min is at origin
      geometry.applyMatrix4(new THREE.Matrix4().makeTranslation(
        -bb.min.x, -bb.min.y, -bb.min.z
      ));
      geometry.computeBoundingBox();
      const bb2 = geometry.boundingBox;

      // Target longest horizontal ≈ 5000 m
      const maxHoriz = Math.max(bb2.max.x * scaleX, bb2.max.z * scaleZ);
      const horizScale = maxHoriz > 0 ? 5000 / maxHoriz : 1;

      // Preserve aspect: scale X and Z by horizScale, Y by a similar but clamped factor
      // Heights shouldn't be exaggerated if geographic – cap altitude exaggeration
      const rawAltRange = bb2.max.y - bb2.min.y;
      let altScale = horizScale;
      if (geographicXZ && rawAltRange < 0.05) {
        // Elevation is in metres but lon/lat in degrees – keep elevation as-is and only scale XZ
        altScale = 1;
      }

      const scaleMatrix = new THREE.Matrix4().makeScale(
        horizScale * (geographicXZ ? scaleX : 1),
        altScale,
        horizScale * (geographicXZ ? scaleZ : 1)
      );
      geometry.applyMatrix4(scaleMatrix);
      geometry.computeBoundingBox();
      geometry.computeVertexNormals();

      const bb3 = geometry.boundingBox;
      const worldSizeX = bb3.max.x;
      const worldSizeZ = bb3.max.z;
      const rawMinY    = bb3.min.y;   // should be ~0 after translate
      const rawMaxY    = bb3.max.y;
      const altRange   = rawMaxY - rawMinY;
      const maxHeight  = Math.max(altRange, 1);

      // ── Apply RELATIVE vertex colours ────────────────────────────────────
      const pos    = geometry.attributes.position;
      const colors = new Float32Array(pos.count * 3);

      for (let i = 0; i < pos.count; i++) {
        const wy = pos.getY(i);
        // Normalise relative to the actual range of this file
        const t = altRange > 0 ? (wy - rawMinY) / altRange : 0.5;
        const [r, g, b] = altitudeColor(t);
        colors[i * 3]     = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      // ── Build mesh ───────────────────────────────────────────────────────
      const mat  = new THREE.MeshPhongMaterial({
        vertexColors: true,
        shininess: 6,
        specular: new THREE.Color(0x111111),
      });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.receiveShadow = true;
      mesh.castShadow    = false;
      mesh.name          = 'terrain';
      // Keep mesh at origin – geometry is already translated

      // ── Sample heightmap for VoxelGrid ──────────────────────────────────
      const voxelSize2 = voxelSize;
      const dimX = Math.max(4, Math.ceil(worldSizeX / voxelSize2));
      const dimZ = Math.max(4, Math.ceil(worldSizeZ / voxelSize2));
      const heights = this._sampleHeightmap(geometry, dimX, dimZ, voxelSize2, worldSizeX, worldSizeZ);

      const dimY = Math.ceil(maxHeight / voxelSize2) + 6;
      const grid = new JADO.VoxelGrid(dimX, dimY, dimZ, voxelSize2);
      grid.applyHeightmap(heights);
      grid.computeDistanceField();

      // ── Elevation unit conversion for display ────────────────────────────
      const elevMin = geoInfo.elevUnit === 'ft' ? Math.round(rawMinY * 0.3048) : Math.round(rawMinY);
      const elevMax = geoInfo.elevUnit === 'ft' ? Math.round(rawMaxY * 0.3048) : Math.round(rawMaxY);

      // ── Compose result ───────────────────────────────────────────────────
      return {
        grid, mesh, heights,
        dimX, dimY, dimZ, voxelSize: voxelSize2,
        worldSizeX, worldSizeZ, maxHeight,
        // Geo-info for HUD / panel display
        geoInfo: {
          ...geoInfo,
          elevMin, elevMax,
          altRange: Math.round(altRange),
          convention,
          filename,
        },
      };
    }

    // ── Heightmap sampling ───────────────────────────────────────────────────

    _sampleHeightmap(geometry, dimX, dimZ, voxelSize, worldSizeX, worldSizeZ) {
      const heights = new Float32Array(dimX * dimZ);
      const pos = geometry.attributes.position;

      for (let i = 0; i < pos.count; i++) {
        const wx = pos.getX(i);
        const wy = pos.getY(i);
        const wz = pos.getZ(i);
        const xi = Math.max(0, Math.min(dimX - 1, Math.floor(wx / voxelSize)));
        const zi = Math.max(0, Math.min(dimZ - 1, Math.floor(wz / voxelSize)));
        const idx = xi * dimZ + zi;
        if (wy > heights[idx]) heights[idx] = wy;
      }

      // Gap-fill: any zero cell with low neighbours gets neighbour average
      for (let x = 0; x < dimX; x++) {
        for (let z = 0; z < dimZ; z++) {
          if (heights[x * dimZ + z] > 0) continue;
          let sum = 0, cnt = 0;
          for (let dx = -1; dx <= 1; dx++)
            for (let dz = -1; dz <= 1; dz++) {
              const nx = x + dx, nz = z + dz;
              if (nx < 0 || nx >= dimX || nz < 0 || nz >= dimZ) continue;
              const v = heights[nx * dimZ + nz];
              if (v > 0) { sum += v; cnt++; }
            }
          if (cnt > 0) heights[x * dimZ + z] = sum / cnt;
        }
      }

      // Light 3×3 smooth to reduce hard edges
      const smoothed = new Float32Array(heights);
      for (let x = 1; x < dimX - 1; x++) {
        for (let z = 1; z < dimZ - 1; z++) {
          let s = 0;
          for (let dx = -1; dx <= 1; dx++)
            for (let dz = -1; dz <= 1; dz++)
              s += heights[(x + dx) * dimZ + (z + dz)];
          smoothed[x * dimZ + z] = s / 9;
        }
      }
      return smoothed;
    }
  }

  window.JADO.TerrainLoader = new TerrainLoader();
})();
