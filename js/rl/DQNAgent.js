// js/rl/DQNAgent.js
// Deep Q-Network agent using TensorFlow.js
// State: 38-dim float32 | Actions: 9 discrete | Training: experience replay + target network
(function() {
  'use strict';
  window.JADO = window.JADO || {};

  // ── Action definitions ──────────────────────────────────────
  const ACTIONS = [
    { name: 'STRAIGHT',          dHeading:  0,  dAlt:    0 },
    { name: 'TURN_LEFT',         dHeading: -20, dAlt:    0 },
    { name: 'TURN_RIGHT',        dHeading: +20, dAlt:    0 },
    { name: 'CLIMB',             dHeading:  0,  dAlt: +100 },
    { name: 'DESCEND',           dHeading:  0,  dAlt: -100 },
    { name: 'TURN_LEFT_CLIMB',   dHeading: -15, dAlt:  +80 },
    { name: 'TURN_RIGHT_DESCEND',dHeading: +15, dAlt:  -80 },
    { name: 'JAMMER_TOGGLE',     dHeading:  0,  dAlt:    0, jammerToggle: true },
    { name: 'DEPLOY_FLARE',      dHeading:  0,  dAlt:    0, flare: true },
  ];

  class DQNAgent {
    /**
     * @param {number} stateSize   - size of observation vector (default 38)
     * @param {number} actionSize  - number of discrete actions (default 9)
     */
    constructor(stateSize = 38, actionSize = 9) {
      this.stateSize   = stateSize;
      this.actionSize  = actionSize;

      // Hyperparameters
      this.gamma        = 0.95;    // discount factor
      this.epsilon      = 1.0;     // exploration rate
      this.epsilonMin   = 0.05;
      this.epsilonDecay = 0.998;   // per training step
      this.lr           = 0.001;
      this.batchSize    = 32;
      this.memorySize   = 5000;
      this.targetUpdateFreq = 50;  // target network update interval

      // Experience replay buffer
      this._memory     = [];
      this._memPtr     = 0;        // circular buffer pointer
      this._trainStep  = 0;
      this._episodeReward = 0;
      this._avgReward  = 0;
      this._episodes   = 0;

      // Build online + target networks
      this.model       = this._buildNetwork();
      this.targetModel = this._buildNetwork();
      this._syncTarget(); // start in sync

      // Training state
      this._training   = false;
      this._ready      = true; // tf is synchronous after initial load
    }

    _buildNetwork() {
      const m = tf.sequential();
      m.add(tf.layers.dense({ inputShape: [this.stateSize], units: 128, activation: 'relu',
        kernelInitializer: 'glorotUniform' }));
      m.add(tf.layers.dense({ units: 64, activation: 'relu' }));
      m.add(tf.layers.dense({ units: 32, activation: 'relu' }));
      m.add(tf.layers.dense({ units: this.actionSize, activation: 'linear' }));
      m.compile({
        optimizer: tf.train.adam(this.lr),
        loss: 'meanSquaredError',
      });
      return m;
    }

    _syncTarget() {
      this.targetModel.setWeights(this.model.getWeights());
    }

    // ── Action selection (ε-greedy) ──────────────────────────────

    act(state) {
      if (Math.random() < this.epsilon) {
        return Math.floor(Math.random() * this.actionSize); // explore
      }
      // Exploit: argmax Q(s,a)
      return tf.tidy(() => {
        const s = tf.tensor2d([state], [1, this.stateSize]);
        const q = this.model.predict(s);
        return q.argMax(1).dataSync()[0];
      });
    }

    getActionSpec(actionIdx) { return ACTIONS[actionIdx] || ACTIONS[0]; }

    // ── Experience replay storage ────────────────────────────────

    remember(state, action, reward, nextState, done) {
      const exp = { state: Float32Array.from(state), action, reward,
                    nextState: Float32Array.from(nextState), done };
      if (this._memory.length < this.memorySize) {
        this._memory.push(exp);
      } else {
        this._memory[this._memPtr % this.memorySize] = exp;
        this._memPtr++;
      }
      this._episodeReward += reward;
    }

    endEpisode() {
      this._episodes++;
      this._avgReward = this._avgReward * 0.9 + this._episodeReward * 0.1;
      this._episodeReward = 0;
    }

    // ── Training step ────────────────────────────────────────────

    async train() {
      if (this._memory.length < this.batchSize) return;
      if (this._training) return;
      this._training = true;

      try {
        // Sample random mini-batch
        const batch = this._sampleBatch();
        await this._trainOnBatch(batch);

        // Epsilon decay
        if (this.epsilon > this.epsilonMin) {
          this.epsilon *= this.epsilonDecay;
        }

        this._trainStep++;

        // Periodic target network sync
        if (this._trainStep % this.targetUpdateFreq === 0) {
          this._syncTarget();
        }
      } finally {
        this._training = false;
      }
    }

    _sampleBatch() {
      const batch = [];
      const n = this._memory.length;
      for (let i = 0; i < this.batchSize; i++) {
        batch.push(this._memory[Math.floor(Math.random() * n)]);
      }
      return batch;
    }

    async _trainOnBatch(batch) {
      const states     = batch.map(e => Array.from(e.state));
      const nextStates = batch.map(e => Array.from(e.nextState));

      await tf.tidy(() => {
        const sTensor  = tf.tensor2d(states,     [this.batchSize, this.stateSize]);
        const nsTensor = tf.tensor2d(nextStates, [this.batchSize, this.stateSize]);

        const currentQs = this.model.predict(sTensor);
        const nextQs    = this.targetModel.predict(nsTensor);

        const currentQData = currentQs.arraySync();
        const nextQData    = nextQs.arraySync();

        const xData = states;
        const yData = currentQData.map((qRow, i) => {
          const exp = batch[i];
          const target = exp.done
            ? exp.reward
            : exp.reward + this.gamma * Math.max(...nextQData[i]);
          const updated = [...qRow];
          updated[exp.action] = target;
          return updated;
        });

        const xT = tf.tensor2d(xData, [this.batchSize, this.stateSize]);
        const yT = tf.tensor2d(yData, [this.batchSize, this.actionSize]);

        return this.model.fit(xT, yT, { epochs: 1, verbose: 0 });
      });
    }

    // ── Persistence (localStorage) ───────────────────────────────

    async save() {
      try {
        await this.model.save('localstorage://jado-dqn-model');
        localStorage.setItem('jado-dqn-meta', JSON.stringify({
          epsilon: this.epsilon,
          trainStep: this._trainStep,
          episodes: this._episodes,
          avgReward: this._avgReward,
        }));
        return true;
      } catch(e) { console.warn('DQN save failed:', e); return false; }
    }

    async load() {
      try {
        this.model = await tf.loadLayersModel('localstorage://jado-dqn-model');
        this.model.compile({ optimizer: tf.train.adam(this.lr), loss: 'meanSquaredError' });
        this._syncTarget();
        const meta = JSON.parse(localStorage.getItem('jado-dqn-meta') || '{}');
        this.epsilon    = meta.epsilon    || this.epsilon;
        this._trainStep = meta.trainStep  || 0;
        this._episodes  = meta.episodes   || 0;
        this._avgReward = meta.avgReward  || 0;
        return true;
      } catch(e) { return false; }
    }

    // ── Stats for UI ─────────────────────────────────────────────

    getStats() {
      return {
        epsilon:    this.epsilon.toFixed(3),
        episodes:   this._episodes,
        avgReward:  this._avgReward.toFixed(2),
        memory:     this._memory.length,
        trainSteps: this._trainStep,
      };
    }
  }

  DQNAgent.ACTIONS = ACTIONS;
  window.JADO.DQNAgent = DQNAgent;
})();
