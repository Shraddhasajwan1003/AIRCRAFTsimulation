// js/data/MapDatabase.js
// Offline IndexedDB Storage for Mathematical Voxel Maps
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  class MapDatabase {
    constructor() {
      this.dbName = 'JadoMapDB';
      this.storeName = 'maps';
      this.db = null;
    }

    async init() {
      if (this.db) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, 1);
        
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
            // Create basic spatial indexes
            store.createIndex('minLat', 'minLat', { unique: false });
            store.createIndex('maxLat', 'maxLat', { unique: false });
            store.createIndex('minLon', 'minLon', { unique: false });
            store.createIndex('maxLon', 'maxLon', { unique: false });
          }
        };
        
        request.onsuccess = (e) => {
          this.db = e.target.result;
          resolve();
        };
        
        request.onerror = (e) => {
          console.error('[MapDB] IndexedDB Error:', e);
          reject(e);
        };
      });
    }

    async saveMap(terrainData) {
      await this.init();
      return new Promise((resolve, reject) => {
        const { geoInfo, heights, dimX, dimY, dimZ, voxelSize, worldSizeX, worldSizeZ, maxHeight, geoRef } = terrainData;
        
        if (!geoInfo || !geoInfo.hasGeoRef) {
          return reject(new Error('Map has no geographic reference and cannot be saved.'));
        }

        // Generate a clean ID based on coordinates
        const cleanLat = geoInfo.lat.toFixed(4);
        const cleanLon = geoInfo.lon.toFixed(4);
        const id = `MAP_${cleanLat}N_${cleanLon}E_${Date.now()}`;

        const mapRecord = {
          id,
          name: geoInfo.filename || `Terrain ${cleanLat}, ${cleanLon}`,
          minLat: geoInfo.minLat,
          maxLat: geoInfo.maxLat,
          minLon: geoInfo.minLon,
          maxLon: geoInfo.maxLon,
          geoInfo,
          geoRef,
          heights, // Float32Array natively supported by IndexedDB structured cloning!
          dimX, dimY, dimZ, voxelSize,
          worldSizeX, worldSizeZ, maxHeight,
          timestamp: Date.now()
        };

        const tx = this.db.transaction([this.storeName], 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.put(mapRecord);

        req.onsuccess = () => resolve(id);
        req.onerror = (e) => reject(e);
      });
    }

    // Advanced spatial query: Find the map containing this precise coordinate
    async findMapByLatLon(lat, lon) {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        
        // IndexedDB doesn't natively support multi-dimensional spatial bounding queries perfectly,
        // so we retrieve all records and filter in JS (perfectly fine since # of maps < 1000)
        const req = store.getAll(); 
        
        req.onsuccess = (e) => {
          const maps = e.target.result;
          for (const map of maps) {
            // Buffer the bounds slightly to be generous
            const pad = 0.001;
            if (lat >= map.minLat - pad && lat <= map.maxLat + pad &&
                lon >= map.minLon - pad && lon <= map.maxLon + pad) {
              return resolve(map);
            }
          }
          resolve(null); // No map found for this coordinate
        };
        req.onerror = (e) => reject(e);
      });
    }

    async getMapById(id) {
       await this.init();
       return new Promise((resolve, reject) => {
         const tx = this.db.transaction([this.storeName], 'readonly');
         const req = tx.objectStore(this.storeName).get(id);
         req.onsuccess = (e) => resolve(e.target.result);
         req.onerror = (e) => reject(e);
       });
    }

    async getAllMapHeaders() {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.getAll();
        req.onsuccess = (e) => {
          // Strip out the massive binary height array for fast UI lists
          const maps = e.target.result.map(m => ({
            id: m.id, 
            name: m.name, 
            lat: m.geoInfo.lat, 
            lon: m.geoInfo.lon,
            timestamp: m.timestamp
          }));
          // Sort by newest
          resolve(maps.sort((a, b) => b.timestamp - a.timestamp));
        };
        req.onerror = (e) => reject(e);
      });
    }
    
    async deleteMap(id) {
       await this.init();
       return new Promise((resolve, reject) => {
         const tx = this.db.transaction([this.storeName], 'readwrite');
         const req = tx.objectStore(this.storeName).delete(id);
         req.onsuccess = () => resolve();
         req.onerror = (e) => reject(e);
       });
    }
  }

  window.JADO.MapDatabase = MapDatabase;
})();
