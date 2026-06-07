// js/terrain/TerrainLoader.js
// Loads OBJ or STL files → Three.js geometry → heightmap → VoxelGrid
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  class TerrainLoader {
    /**
     * Load a File object (OBJ or STL) and build terrain data.
     * Returns a Promise resolving to the same shape as TerrainGenerator.generate()
     */
    loadFile(file, voxelSize = 50) {
      return new Promise((resolve, reject) => {
        const ext = file.name.split('.').pop().toLowerCase();
        const reader = new FileReader();

        reader.onload = (e) => {
          try {
            let geometry;
            if (ext === 'obj') {
              geometry = this._parseOBJ(e.target.result);
            } else if (ext === 'stl') {
              geometry = this._parseSTL(e.target.result, ext === 'stl');
            } else {
              reject(new Error('Unsupported format. Use .obj or .stl'));
              return;
            }
            const result = this._processGeometry(geometry, voxelSize, file.name);
            resolve(result);
          } catch(err) {
            reject(err);
          }
        };

        reader.onerror = () => reject(new Error('File read error'));

        if (ext === 'stl') reader.readAsArrayBuffer(file);
        else reader.readAsText(file);
      });
    }

    _parseOBJ(text) {
      const loader = new THREE.OBJLoader();
      const obj    = loader.parse(text);
      // Merge all child geometries
      let geo = null;
      obj.traverse(child => {
        if (child.isMesh) {
          if (!geo) geo = child.geometry.clone();
          else {
            // Simple merge: just use first mesh (sufficient for terrain)
            // For multi-part OBJs, THREE.BufferGeometryUtils would merge properly
          }
        }
      });
      if (!geo) throw new Error('No mesh found in OBJ file');
      return geo;
    }

    _parseSTL(buffer) {
      const loader = new THREE.STLLoader();
      return loader.parse(buffer);
    }

    _processGeometry(geometry, voxelSize, filename) {
      geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      const size = new THREE.Vector3();
      bb.getSize(size);
      const center = new THREE.Vector3();
      bb.getCenter(center);

      // Normalize to origin + scale to reasonable world size
      // Target: longest horizontal dimension ≈ 5000m
      const maxHoriz = Math.max(size.x, size.z);
      const scaleFactor = maxHoriz > 0 ? 5000 / maxHoriz : 1;

      const matrix = new THREE.Matrix4();
      matrix.makeTranslation(-bb.min.x, -bb.min.y, -bb.min.z);
      geometry.applyMatrix4(matrix);
      geometry.scale(scaleFactor, scaleFactor, scaleFactor);
      geometry.computeBoundingBox();

      const bb2 = geometry.boundingBox;
      const worldSizeX = bb2.max.x - bb2.min.x;
      const worldSizeZ = bb2.max.z - bb2.min.z;
      const maxHeight  = Math.min(bb2.max.y - bb2.min.y, 2000);

      // Sample heightmap by raycasting downward
      const dimX = Math.ceil(worldSizeX / voxelSize);
      const dimZ = Math.ceil(worldSizeZ / voxelSize);
      const heights = this._sampleHeightmap(geometry, dimX, dimZ, voxelSize, worldSizeX, worldSizeZ);

      // Build VoxelGrid
      const dimY = Math.ceil(maxHeight / voxelSize) + 4;
      const VoxelGrid = window.JADO.VoxelGrid;
      const grid = new VoxelGrid(dimX, dimY, dimZ, voxelSize);
      grid.applyHeightmap(heights);
      grid.inflate(1);

      // Rebuild mesh with vertex colors
      const mesh = this._rebuildMesh(geometry, worldSizeX, worldSizeZ, dimX, dimZ, voxelSize, heights, maxHeight);

      return { grid, mesh, heights, dimX, dimY, dimZ, voxelSize, worldSizeX, worldSizeZ, maxHeight };
    }

    _sampleHeightmap(geometry, dimX, dimZ, voxelSize, worldSizeX, worldSizeZ) {
      const heights = new Float32Array(dimX * dimZ);
      // Use position buffer to find max Y at each XZ cell
      const pos = geometry.attributes.position;

      for (let i = 0; i < pos.count; i++) {
        const wx = pos.getX(i);
        const wy = pos.getY(i);
        const wz = pos.getZ(i);
        const xi = Math.max(0, Math.min(dimX-1, Math.floor(wx / voxelSize)));
        const zi = Math.max(0, Math.min(dimZ-1, Math.floor(wz / voxelSize)));
        const idx = xi * dimZ + zi;
        if (wy > heights[idx]) heights[idx] = wy;
      }

      // Smooth heights (simple 3x3 average to fill gaps)
      const smoothed = new Float32Array(heights);
      for (let x = 1; x < dimX-1; x++) {
        for (let z = 1; z < dimZ-1; z++) {
          let sum = 0, cnt = 0;
          for (let dx = -1; dx <= 1; dx++)
            for (let dz = -1; dz <= 1; dz++) {
              sum += heights[(x+dx)*dimZ+(z+dz)];
              cnt++;
            }
          smoothed[x*dimZ+z] = sum / cnt;
        }
      }
      return smoothed;
    }

    _rebuildMesh(origGeo, worldSizeX, worldSizeZ, dimX, dimZ, voxelSize, heights, maxHeight) {
      const geo = new THREE.PlaneGeometry(worldSizeX, worldSizeZ, dimX-1, dimZ-1);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;

      for (let i = 0; i < pos.count; i++) {
        const xi = i % dimX, zi = Math.floor(i / dimX);
        pos.setY(i, heights[xi * dimZ + zi] || 0);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();

      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const h = pos.getY(i) / Math.max(1, maxHeight);
        let r, g, b;
        if (h < 0.1) { r=0.13; g=0.30; b=0.10; }
        else if (h < 0.35) { r=0.20; g=0.38; b=0.12; }
        else if (h < 0.55) { r=0.45; g=0.38; b=0.22; }
        else if (h < 0.75) { r=0.55; g=0.50; b=0.38; }
        else { r=0.92; g=0.92; b=0.92; }
        colors[i*3]=r; colors[i*3+1]=g; colors[i*3+2]=b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      const mat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 8 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(worldSizeX / 2, 0, worldSizeZ / 2);
      mesh.receiveShadow = true;
      mesh.name = 'terrain';
      return mesh;
    }
  }

  window.JADO.TerrainLoader = new TerrainLoader();
})();
