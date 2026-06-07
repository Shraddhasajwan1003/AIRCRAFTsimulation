// js/data/TelemetryCache.js
// Redis-equivalent in-memory telemetry store with pub/sub
// This is the central nervous system for real-time data sharing
// between the simulation loop and the UI (mirrors Redis architecture)
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  class TelemetryCache {
    constructor() {
      this._store   = new Map();
      this._expiry  = new Map();
      this._listeners = [];          // [{pattern, regex, callback}]
      this._stats   = { sets: 0, gets: 0, hits: 0 };

      // Prune expired keys every 15 seconds
      setInterval(() => this._prune(), 15000);
    }

    // ── Core KV operations ──────────────────────────────────────

    set(key, value, ttlMs = null) {
      this._store.set(key, value);
      if (ttlMs !== null) this._expiry.set(key, Date.now() + ttlMs);
      else this._expiry.delete(key);
      this._stats.sets++;
      this._notifyListeners(key, value);
    }

    get(key) {
      this._stats.gets++;
      if (this._isExpired(key)) { this._del(key); return null; }
      const v = this._store.get(key);
      if (v !== undefined) this._stats.hits++;
      return v !== undefined ? v : null;
    }

    del(key) { this._del(key); }
    _del(key) { this._store.delete(key); this._expiry.delete(key); }

    exists(key) { return !this._isExpired(key) && this._store.has(key); }

    // ── Hash map operations (mirrors Redis HSET/HGET) ───────────

    hmset(key, mapping, ttlMs = null) {
      const existing = this._store.get(key) || {};
      const merged = Object.assign({}, existing, mapping);
      this.set(key, merged, ttlMs);
    }

    hset(key, field, value) {
      const obj = this._store.get(key) || {};
      obj[field] = value;
      this._store.set(key, obj);
      this._notifyListeners(key, obj);
    }

    hget(key, field) {
      const obj = this.get(key);
      return obj ? obj[field] : null;
    }

    hgetall(key) { return this.get(key); }

    hincrby(key, field, delta) {
      const obj = this._store.get(key) || {};
      obj[field] = (parseFloat(obj[field]) || 0) + delta;
      this._store.set(key, obj);
    }

    // ── Pattern matching (mirrors Redis KEYS pattern) ───────────

    keys(pattern) {
      const regex = TelemetryCache._patternToRegex(pattern);
      const result = [];
      for (const key of this._store.keys()) {
        if (!this._isExpired(key) && regex.test(key)) result.push(key);
      }
      return result;
    }

    static _patternToRegex(pattern) {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                             .replace(/\*/g, '.*')
                             .replace(/\?/g, '.');
      return new RegExp('^' + escaped + '$');
    }

    // ── Pub/Sub (mirrors Redis SUBSCRIBE/PUBLISH) ────────────────

    subscribe(pattern, callback) {
      this._listeners.push({
        pattern,
        regex: TelemetryCache._patternToRegex(pattern),
        callback
      });
    }

    unsubscribe(pattern) {
      this._listeners = this._listeners.filter(l => l.pattern !== pattern);
    }

    _notifyListeners(key, value) {
      for (const { regex, callback } of this._listeners) {
        if (regex.test(key)) {
          try { callback(key, value); } catch(e) { /* silent */ }
        }
      }
    }

    // ── Helpers ─────────────────────────────────────────────────

    _isExpired(key) {
      const exp = this._expiry.get(key);
      return exp !== undefined && Date.now() > exp;
    }

    _prune() {
      const now = Date.now();
      for (const [key, exp] of this._expiry) {
        if (now > exp) { this._store.delete(key); this._expiry.delete(key); }
      }
    }

    clear() { this._store.clear(); this._expiry.clear(); }

    stats() {
      return { ...this._stats, keys: this._store.size };
    }

    // ── Domain-specific helpers (mission telemetry) ─────────────

    setAgentPos(missionId, agentId, x, y, z, heading, alive, pk = 0) {
      this.hmset(
        `mission:${missionId}:agent:${agentId}`,
        { x, y, z, heading, alive: alive ? 1 : 0, pk, ts: Date.now() }
      );
    }

    getAgent(missionId, agentId) {
      return this.hgetall(`mission:${missionId}:agent:${agentId}`);
    }

    getAllAgents(missionId) {
      const keys = this.keys(`mission:${missionId}:agent:*`);
      const result = {};
      for (const key of keys) {
        const agentId = key.split(':').pop();
        result[agentId] = this.hgetall(key);
      }
      return result;
    }

    addThreatZone(missionId, threatId, cx, cy, cz, radius, type, active = 1) {
      this.hmset(
        `mission:${missionId}:threat:${threatId}`,
        { cx, cy, cz, radius, type, active }
      );
    }

    getActiveThreatZones(missionId) {
      return this.keys(`mission:${missionId}:threat:*`)
        .map(k => this.hgetall(k))
        .filter(t => t && t.active);
    }

    setCorridors(missionId, corridors) {
      this.set(`mission:${missionId}:corridors`, corridors);
    }

    getCorridors(missionId) {
      return this.get(`mission:${missionId}:corridors`);
    }

    // Append agent telemetry history for charts (capped at 200 samples)
    pushHistory(missionId, agentId, field, value) {
      const key = `mission:${missionId}:history:${agentId}:${field}`;
      let arr = this.get(key) || [];
      arr.push(value);
      if (arr.length > 200) arr = arr.slice(arr.length - 200);
      this.set(key, arr);
    }

    getHistory(missionId, agentId, field) {
      return this.get(`mission:${missionId}:history:${agentId}:${field}`) || [];
    }

    clearMission(missionId) {
      const keys = this.keys(`mission:${missionId}:*`);
      keys.forEach(k => this._del(k));
    }
  }

  window.JADO.TelemetryCache = TelemetryCache;
})();
