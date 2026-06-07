# ✈ JADO — Joint All-Domain Operations Constructive Simulation System

> **Fully offline** aircraft war simulation with 3D terrain rendering, A\* pathfinding, DQN reinforcement learning, and physics-based electronic warfare.

---

## ⚡ Quick Start

### First Time (internet required once)
```
1. Double-click  setup.bat        ← downloads all libraries (~2 MB)
2. Double-click  run.bat          ← opens simulation in browser
```

### Every Time After
```
Double-click  run.bat             ← 100% offline, no internet needed
   — or —
Open  index.html  in any browser
```

> ✅ No Python. No Node. No installation. No internet after setup.

---

## 📸 System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  JADO SIM v1.0          ● STANDBY     THREATS: 0   AGENTS: 0   │
├──────────────┬──────────────────────────────┬───────────────────┤
│              │                              │                   │
│  MISSION     │    3D THEATER MAP            │   TELEMETRY       │
│  SETUP       │    (WebGL / Three.js)        │                   │
│              │                              │  Agent Status     │
│  ⛰ Terrain  │    ← Procedural or OBJ/STL   │  Pk% Gauges      │
│  ✈ Aircraft  │                              │  Altitude Chart   │
│  ⚠ Threats   │    Green  = Fastest path     │  Speed Chart      │
│  ⬛ Obstacles │    Yellow = Low-altitude     │  DQN-RL Stats     │
│  🌦 Weather  │    Cyan   = Balanced path    │  SITREP Log       │
│  ◎ Target    │                              │                   │
│  🗺 A* Plan  │                              │                   │
├──────────────┴──────────────────────────────┴───────────────────┤
│  ▶ RUN   ⏸ PAUSE   ↺ RESET  │ Speed: 1× 2× 5× 10× │ Export AAR│
└─────────────────────────────────────────────────────────────────┘
```

---

## 🎮 How to Run a Mission

| Step | Action |
|------|--------|
| **1. Load Terrain** | Drop an `.obj` / `.stl` file onto the dropzone — OR — click **⊕ Generate Procedural Terrain** |
| **2. Place Aircraft** | Select aircraft type → click **✈ Place Aircraft** → click on the 3D map |
| **3. Place Threats** | Select SAM/radar → click **⚠ Place Threat** → click on map (threat zone appears) |
| **4. Place Obstacles** | Optional mountain/building blocks for terrain masking |
| **5. Set Environment** | Choose weather (affects radar range), wind, ECM noise |
| **6. Set Target** | Click **◎ Set Target** → click destination on map |
| **7. Compute Paths** | Click **🗺 Compute Safe Corridors** → A\* runs 3 optimised routes |
| **8. Run Simulation** | Click **▶ RUN** → agents fly, RL trains, Pk% updates live |
| **9. Export Report** | Click **📥 Export AAR** → JSON after-action report downloaded |

---

## 🛩 Friendly Aircraft

| Aircraft | Speed | RCS (m²) | Jammer | Role |
|----------|-------|----------|--------|------|
| F-16C Falcon | 560 m/s | 1.2 | — | Strike |
| F-22A Raptor | 620 m/s | 0.0001 | — | Stealth Strike |
| EA-18G Growler | 490 m/s | 2.4 | **1.8 MW** | EW Support |
| B-2A Spirit | 250 m/s | 0.00001 | — | Heavy Strike |

> 💡 The **EA-18G Growler** activates its jammer during flight, reducing all nearby radar detection ranges.

---

## 🎯 Enemy Threats

| System | Range | Base Pk% | Type |
|--------|-------|----------|------|
| SA-10 Grumble (S-300) | 90 km | 72% | SAM (radar-guided) |
| SA-20 Gargoyle (S-400) | 120 km | 85% | SAM (radar-guided) |
| SA-15 Tor-M1 | 12 km | 55% | SHORAD (IR-guided) |
| EW Radar | 250 km | — | Detection only |
| MiG-31 Foxhound | 200 km | 65% | Airborne interceptor |

---

## 🗺 Path Planning — 3 Corridors

The A\* planner always computes three simultaneous routes:

| Corridor | Colour | Strategy |
|----------|--------|----------|
| **Fastest** | 🟢 Green | Shortest distance, avoids threats |
| **Low-Alt** | 🟡 Yellow | Hugs terrain for radar masking |
| **Balanced** | 🔵 Cyan | Speed + threat avoidance compromise |

Each agent is automatically assigned a corridor. Paths recompute instantly when you add obstacles or threats mid-mission.

---

## 🤖 DQN Reinforcement Learning

The simulation uses a **Deep Q-Network** built with TensorFlow.js. Agents train live in your browser during every mission.

### Network Architecture
```
Input (38) → Dense(128, ReLU) → Dense(64, ReLU) → Dense(32, ReLU) → Q-values (9)
```

### State Space (38 dimensions)
- Local 3×3×3 voxel window around agent (27 values)
- Altitude, heading (sin/cos), speed, flares, jammer status
- Corridor deviation
- 4 nearest threat distances

### Action Space (9 actions)
```
0 = Maintain heading    5 = Turn left + climb
1 = Turn left           6 = Turn right + descend
2 = Turn right          7 = Toggle jammer
3 = Climb               8 = Deploy flare
4 = Descend
```

### Reward Function
| Event | Reward |
|-------|--------|
| On corridor | +1.5 / tick |
| Off corridor | −1.0 / tick |
| Radar exposure | −8 × threat_level |
| Progress toward target | +20 × delta |
| Good terrain clearance (NOE) | +0.5 |
| Correct jammer use | +1.0 |
| Reached target | **+500** |
| Destroyed | **−100** |

### Training Details
- Experience replay buffer: 5,000 transitions
- Batch size: 32 | Gamma: 0.95 | Learning rate: 0.001
- Target network synced every 50 training steps
- ε-greedy: ε decays from **1.0 → 0.05** (agents start random, become tactical)
- **Model persists to browser `localStorage`** — loads automatically on next session

---

## 📡 Electronic Warfare Model

### Radar Detection Range
```
R_max = [ (Pt × Gt × Gr × λ² × RCS) / ((4π)³ × Pmin) ]^(1/4) × weather_factor
```

### Jamming Effect
```
Pt_effective = Pt / (1 + J/S_ratio)
```
Active jamming (EA-18G) reduces enemy radar range proportionally to jammer ERP.

### Probability of Kill (Pk)
```
Final Pk = Base_Pk
         × speed_factor        (faster aircraft harder to hit)
         × altitude_factor     (NOE reduces lock quality)
         × RCS_factor          (stealth dramatically reduces Pk)
         × flare_factor        (×0.2 vs IR missiles when flares deployed)
         × jamming_factor      (×(1 - jamming_effectiveness) vs radar missiles)
```

### Line-of-Sight
Bresenham 3D ray marching through the voxel grid — terrain physically blocks radar detection. Flying in valleys or behind ridges provides real protection.

---

## 🌦 Environment Conditions

| Weather | Radar Range | Effect |
|---------|-------------|--------|
| Clear | 100% | No reduction |
| Overcast | 90% | Slight attenuation |
| Heavy Rain | 75% | Significant degradation |
| Storm | 60% | Heavy degradation |

---

## ⌨ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause simulation |
| `ESC` | Cancel placement mode |
| Mouse drag | Orbit 3D camera |
| Scroll wheel | Zoom in / out |

---

## 📁 Project Structure

```
AIRCRAFTsimulation/
│
├── index.html                  ← Launch this
├── setup.bat                   ← One-time library downloader
├── run.bat                     ← Shortcut launcher
├── README.md                   ← This file
│
├── css/
│   └── style.css               ← Dark military glassmorphism UI
│
├── lib/                        ← Downloaded by setup.bat (offline after this)
│   ├── three.min.js            ← Three.js 3D engine
│   ├── OrbitControls.js        ← Camera controls
│   ├── OBJLoader.js            ← OBJ terrain import
│   ├── STLLoader.js            ← STL terrain import
│   └── tf.min.js               ← TensorFlow.js (DQN RL)
│
└── js/
    ├── app.js                  ← Bootstrap / init
    ├── data/
    │   ├── UnitSpecs.js        ← Aircraft & threat specs
    │   └── TelemetryCache.js   ← Redis-equivalent pub/sub cache
    ├── terrain/
    │   ├── VoxelGrid.js        ← 3D voxel occupancy grid
    │   ├── TerrainGenerator.js ← Perlin noise procedural terrain
    │   └── TerrainLoader.js    ← OBJ/STL → heightmap → voxels
    ├── pathfinding/
    │   └── AStar3D.js          ← 3D A* with 3 corridor variants
    ├── ew/
    │   └── EWModel.js          ← Radar equation, LOS, Pk%
    ├── rl/
    │   ├── DQNAgent.js         ← TensorFlow.js DQN network
    │   └── RLEnvironment.js    ← Gymnasium-style env wrapper
    ├── simulation/
    │   ├── Agent.js            ← Aircraft physics & state
    │   └── SimController.js    ← 10 Hz tick loop
    ├── renderer/
    │   └── Renderer3D.js       ← Three.js scene management
    └── ui/
        ├── TelemetryPanel.js   ← Canvas charts & Pk gauges
        └── UIManager.js        ← All panel interactions
```

---

## 🏗 Architecture Notes

### Why TelemetryCache instead of Redis?
The `TelemetryCache` class replicates the Redis API (`hmset`, `hgetall`, `keys(pattern)`, `subscribe`) as an in-memory JavaScript Map. This gives identical architectural separation between the simulation loop (writer) and the UI (reader) without requiring a Redis server binary.

### Why TensorFlow.js instead of Python/PyTorch?
TF.js runs the DQN neural network directly in the browser's V8 engine with WebGL acceleration — no Python runtime, no installation. The model architecture, training loop, and hyperparameters are identical to the PyTorch PPO blueprint.

### Why Three.js instead of PyOpenGL?
Three.js gives OpenGL-class 3D rendering (WebGL) with zero OS dependencies, works offline from file://, and supports the same rendering pipeline (depth test, vertex buffers, shadow maps, point lights).

---

## 🔧 Troubleshooting

| Problem | Solution |
|---------|----------|
| Blank screen / errors in browser | Run `setup.bat` first — check `lib/` has 5 files |
| "THREE is not defined" | `lib/three.min.js` missing — re-run `setup.bat` |
| "tf is not defined" | `lib/tf.min.js` missing — re-run `setup.bat` |
| A* finds no path | Start or target may be inside terrain — move aircraft/target |
| Terrain looks flat | Increase terrain resolution to 25m in the dropdown |
| Agents not moving | Click **🗺 Compute Safe Corridors** before **▶ RUN** |
| Chrome blocks file:// | Use Edge, Firefox, or run a local server |

---

## 📊 After-Action Report (AAR)

Clicking **📥 Export AAR** downloads a JSON file containing:

```json
{
  "missionId": "mission_...",
  "timestamp": "2026-...",
  "duration_ticks": 450,
  "duration_seconds": 45,
  "stats": {
    "ticksTotal": 450,
    "agentsAlive": 1,
    "agentsKilled": 1,
    "missilesFired": 8,
    "missileKills": 1
  },
  "agents": [
    {
      "id": "FRIENDLY_F22A_01",
      "type": "F-22A Raptor",
      "survived": true,
      "peakPk": "34.2%",
      "corridorType": "fastest",
      "flightPath": [...]
    }
  ],
  "rlStats": {
    "epsilon": "0.847",
    "episodes": 3,
    "avgReward": "124.5"
  }
}
```

---

## 📌 Version

| Component | Version |
|-----------|---------|
| Three.js | r134 |
| TensorFlow.js | 4.10.0 |
| System | v1.0 |
| Classification | INTERNAL / SIMULATION |

---

*JADO Constructive Simulation System — Built for offline secure terminal deployment.*
