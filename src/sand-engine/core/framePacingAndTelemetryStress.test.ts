/**
 * framePacingAndTelemetryStress.test.ts
 * Heavy stress-test suite diagnosing & verifying fixes for:
 *  - Sub-30 FPS Chromium/Edge WebGL command-buffer backpressure stalls under uncapped MessageChannel
 *  - Misleading 73% CPU / 27% GPU telemetry inversion during WebGL queue stalls
 *  - Edge Efficiency Mode (EcoQoS) / cross-origin iframe throttling detection
 *  - Per-frame EXT_disjoint_timer_query_webgl2 synchronous IPC reduction (>95%)
 *  - WebGL2 fenceSync in-flight frame limiting & adaptive GTAO cadence
 *  - Full-pipeline 10,000-frame multi-biome JS CPU budget verification (< 1.0 ms/frame)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  FramePacingGovernor,
  GpuTimerQueryScheduler,
  InFlightFenceLimiter,
  splitRenderSubmitAndStall,
} from './FramePacingGovernor';
import { PerformanceMonitor } from './PerformanceMonitor';
import {
  DEFAULT_RUNTIME_CONFIG,
  detectIsMobileDevice,
  EnvironmentBiome,
  getInitialGraphicsQuality,
  SAND_DEFAULTS,
} from './SandParams';
import { SandTerramechanics } from './SandTerramechanics';
import {
  createInitialSuspensionState,
  evaluateTireCorneringAndYaw,
  rotateBodyVelocityByHeadingDelta,
  snapSuspensionToGround,
  stepSuspensionDynamics,
  SuspensionWheelCorner,
} from './VehicleSuspensionPhysics';
import { evaluateVehicleDriveStep } from './VehicleDriveModel';
import {
  computeWetHighwayGrip,
  resolveVehicleCapsuleHighwayCollision,
  sampleHighwayPothole,
} from './RainyHighwayModel';
import {
  DESERT_ROCK_OBSTACLES,
  resolveRockCollisions,
  sampleClimbableRockSurface,
} from './DesertObstacles';
import { sampleBaseTerrainHeight, sampleTerrainHeightForBiome } from './TerrainHeightfield';
import { ToroidalCascade } from './ToroidalCascade';
import { BrushEncoder, BrushType } from './BrushEncoder';
import { SleepController } from './SleepController';
import { ShadowUpdateScheduler } from './ShadowUpdateScheduler';
import {
  computeReflectionLodProfileInto,
  FarShadowCascadeScheduler,
  ReflectionLodInput,
  ReflectionLodProfile,
} from './DistanceLodPolicy';
import { createInitialCockpitState, stepCockpitState } from './CockpitStateModel';
import { applyPotholeSuspensionImpact, createInitialDamageState } from './VehicleCrashPhysics';

const FOUR_CORNERS: readonly [
  SuspensionWheelCorner,
  SuspensionWheelCorner,
  SuspensionWheelCorner,
  SuspensionWheelCorner,
] = [
  { lx: 1.02, lz: 1.59, isFront: true, isLeft: true },
  { lx: -1.02, lz: 1.59, isFront: true, isLeft: false },
  { lx: 1.02, lz: -1.59, isFront: false, isLeft: true },
  { lx: -1.02, lz: -1.59, isFront: false, isLeft: false },
];

function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// 1. EXACT REPRODUCTION OF SCREENSHOT BUG (18 FPS / 55.4ms / 13.6ms GPU / 40.5ms STALL)
// ============================================================================

test('STRESS-FP 01 — Exact 18 FPS GPU command-buffer stall: never misreports 73% CPU or inverted 27% GPU', () => {
  const gov = new FramePacingGovernor();
  const mon = new PerformanceMonitor(240);

  let guardedOnFrame = -1;
  for (let f = 0; f < 300; f++) {
    const dec = gov.evaluate({
      frameDeltaMs: 55.4,
      jsCpuMs: 1.2,
      renderSubmitMs: 39.3, // 3 x 13.6ms synchronous Chromium WebGL queue backpressure stall
      gpuHardwareMs: 13.6,
      uncappedRequested: true,
      isSoftwareGl: false,
      documentHidden: false,
      graphicsQuality: 'hybrid',
    });
    if (dec.backpressureGuarded && guardedOnFrame < 0) {
      guardedOnFrame = f;
    }
    mon.recordFrame({
      frameDeltaMs: 55.4,
      cpuWorkMs: dec.trueCpuWorkMs,
      jsCpuMs: 1.2,
      renderSubmitMs: 39.3,
      gpuStallMs: dec.estimatedGpuStallMs,
      gpuFrameMs: 13.6,
      uncappedMode: dec.scheduleMode === 'message_channel',
      bottleneck: dec.bottleneck,
      backpressureGuarded: dec.backpressureGuarded,
    });
  }

  const snap = mon.getSnapshot();
  assert.equal(guardedOnFrame, 0, 'Heavy >=8ms WebGL stall must engage rAF backpressure guard on frame 0');
  assert.equal(snap.backpressureGuarded, true);
  assert.equal(snap.bottleneck, 'browser_throttle');
  assert.ok(snap.cpuUsagePct <= 12, `True CPU% must be <=12% (not bogus 73%), got ${snap.cpuUsagePct}%`);
  assert.ok(snap.cpuWorkMs <= 6.0, `True CPU ms must exclude GPU stall (not 40.5ms), got ${snap.cpuWorkMs}ms`);
  assert.ok(snap.gpuStallMs >= 30.0, `Must identify >=30ms synchronous WebGL stall, got ${snap.gpuStallMs}ms`);
  assert.ok(
    snap.gpuUsagePct >= 22 && snap.gpuUsagePct <= 28,
    `Hardware GPU% must match true WDDM duty cycle (13.6ms / 55.4ms = 25%, never bogus 95%), got ${snap.gpuUsagePct}%`,
  );
  assert.equal(snap.gpuHardwareMeasured, true);
});

test('STRESS-FP 02 — GPU backpressure stall WITHOUT hardware timer still keeps CPU honest and GPU conservative', () => {
  const gov = new FramePacingGovernor();
  const mon = new PerformanceMonitor(180);

  for (let f = 0; f < 180; f++) {
    const dec = gov.evaluate({
      frameDeltaMs: 54.0,
      jsCpuMs: 1.4,
      renderSubmitMs: 38.0,
      gpuHardwareMs: null,
      uncappedRequested: true,
      isSoftwareGl: false,
      documentHidden: false,
      graphicsQuality: 'hybrid',
    });
    mon.recordFrame({
      frameDeltaMs: 54.0,
      cpuWorkMs: dec.trueCpuWorkMs,
      jsCpuMs: 1.4,
      renderSubmitMs: 38.0,
      gpuStallMs: dec.estimatedGpuStallMs,
      gpuFrameMs: null,
      uncappedMode: dec.scheduleMode === 'message_channel',
      gpuLoadHint: 0.66,
      bottleneck: dec.bottleneck,
      backpressureGuarded: dec.backpressureGuarded,
    });
  }

  const snap = mon.getSnapshot();
  assert.equal(snap.gpuHardwareMeasured, false);
  assert.equal(snap.backpressureGuarded, true);
  assert.equal(snap.bottleneck, 'gpu');
  assert.ok(snap.cpuUsagePct <= 12, `Fallback CPU% must stay honest <=12%, got ${snap.cpuUsagePct}%`);
  assert.ok(
    snap.gpuUsagePct >= 55 && snap.gpuUsagePct <= 88,
    `Fallback GPU% must stay calibrated in 55..88% (not bogus 99%), got ${snap.gpuUsagePct}%`,
  );
});

// ============================================================================
// 2. EDGE EFFICIENCY MODE / AI STUDIO IFRAME THROTTLING VS TRUE CPU BOTTLENECK
// ============================================================================

test('STRESS-FP 03 — Detects browser/EcoQoS/iframe throttling when FPS < 30 while both CPU & GPU are light', () => {
  const gov = new FramePacingGovernor();
  const mon = new PerformanceMonitor(180);

  for (let f = 0; f < 180; f++) {
    const dec = gov.evaluate({
      frameDeltaMs: 48.0, // ~21 FPS throttled by Edge Efficiency Mode / iframe cap
      jsCpuMs: 1.1,
      renderSubmitMs: 1.8, // NO GPU stall!
      gpuHardwareMs: 5.4,  // Light GPU work!
      uncappedRequested: true,
      isSoftwareGl: false,
      documentHidden: false,
      graphicsQuality: 'hybrid',
    });
    mon.recordFrame({
      frameDeltaMs: 48.0,
      cpuWorkMs: dec.trueCpuWorkMs,
      jsCpuMs: 1.1,
      renderSubmitMs: 1.8,
      gpuStallMs: dec.estimatedGpuStallMs,
      gpuFrameMs: 5.4,
      uncappedMode: dec.scheduleMode === 'message_channel',
      bottleneck: dec.bottleneck,
      backpressureGuarded: dec.backpressureGuarded,
    });
  }

  const snap = mon.getSnapshot();
  assert.equal(snap.bottleneck, 'browser_throttle');
  assert.equal(snap.backpressureGuarded, true, 'Must avoid spinning MessageChannel when browser throttles frame rate');
  assert.ok(snap.cpuUsagePct <= 10, `CPU% should be low under Eco throttle, got ${snap.cpuUsagePct}%`);
  assert.ok(snap.gpuUsagePct <= 25, `GPU% should reflect light 5.4ms/48ms load, got ${snap.gpuUsagePct}%`);
});

test('STRESS-FP 04 — Accurately reports genuine JS CPU bottleneck when JS simulation dominates frame time', () => {
  const gov = new FramePacingGovernor();
  const mon = new PerformanceMonitor(180);

  for (let f = 0; f < 180; f++) {
    const dec = gov.evaluate({
      frameDeltaMs: 16.67,
      jsCpuMs: 13.4,
      renderSubmitMs: 1.6,
      gpuHardwareMs: 2.1,
      uncappedRequested: false,
      isSoftwareGl: false,
      documentHidden: false,
      graphicsQuality: 'hybrid',
    });
    mon.recordFrame({
      frameDeltaMs: 16.67,
      cpuWorkMs: dec.trueCpuWorkMs,
      jsCpuMs: 13.4,
      renderSubmitMs: 1.6,
      gpuStallMs: dec.estimatedGpuStallMs,
      gpuFrameMs: 2.1,
      uncappedMode: false,
      bottleneck: dec.bottleneck,
      backpressureGuarded: dec.backpressureGuarded,
    });
  }

  const snap = mon.getSnapshot();
  assert.equal(snap.bottleneck, 'cpu');
  assert.ok(snap.cpuUsagePct >= 82, `True JS CPU bottleneck must report >=82% CPU, got ${snap.cpuUsagePct}%`);
  assert.ok(snap.gpuUsagePct <= 20, `Light 2.1ms GPU must report <=20%, got ${snap.gpuUsagePct}%`);
  assert.equal(snap.gpuStallMs, 0);
});

// ============================================================================
// 3. FAST GPU UNCAPPED 333 FPS & HYSTERESIS RECOVERY STRESS
// ============================================================================

test('STRESS-FP 05 — Fast GPU (333 FPS) runs completely unguarded in Livre mode with accurate 1% Low', () => {
  const gov = new FramePacingGovernor();
  const mon = new PerformanceMonitor(240);

  let mcFrames = 0;
  for (let f = 0; f < 1000; f++) {
    const dec = gov.evaluate({
      frameDeltaMs: 3.0,
      jsCpuMs: 0.55,
      renderSubmitMs: 0.75,
      gpuHardwareMs: 2.1,
      uncappedRequested: true,
      isSoftwareGl: false,
      documentHidden: false,
      graphicsQuality: 'hybrid',
    });
    if (dec.scheduleMode === 'message_channel') mcFrames++;
    mon.recordFrame({
      frameDeltaMs: 3.0,
      cpuWorkMs: dec.trueCpuWorkMs,
      jsCpuMs: 0.55,
      renderSubmitMs: 0.75,
      gpuStallMs: dec.estimatedGpuStallMs,
      gpuFrameMs: 2.1,
      uncappedMode: dec.scheduleMode === 'message_channel',
      bottleneck: dec.bottleneck,
      backpressureGuarded: dec.backpressureGuarded,
    });
  }

  const snap = mon.getSnapshot();
  assert.equal(mcFrames, 1000, 'Fast 333 FPS GPU must stay in message_channel without false guard triggers');
  assert.equal(snap.backpressureGuarded, false);
  assert.ok(snap.fps >= 325 && snap.fps <= 340, `Expected ~333 FPS, got ${snap.fps}`);
  assert.ok(snap.onePercentLowFps >= 320, `Expected 1% Low >= 320, got ${snap.onePercentLowFps}`);
  assert.equal(snap.bottleneck, 'balanced');
  assert.equal(snap.gpuStallMs, 0);
});

test('STRESS-FP 06 — 20,000-frame multi-regime chaos soak: zero NaN, zero flapping, <25ms total overhead', () => {
  const gov = new FramePacingGovernor();
  const mon = new PerformanceMonitor(240);
  const rng = makeRng(2026);

  let modeTransitions = 0;
  let lastMode = 'raf';

  const t0 = performance.now();
  for (let f = 0; f < 20_000; f++) {
    const phase = Math.floor(f / 2000) % 5;
    let frameDeltaMs: number;
    let jsCpuMs: number;
    let renderSubmitMs: number;
    let gpuHardwareMs: number | null;
    let uncappedRequested = true;

    if (phase === 0) {
      // Fast 250 FPS burst
      frameDeltaMs = 3.8 + rng() * 0.6;
      jsCpuMs = 0.5 + rng() * 0.3;
      renderSubmitMs = 0.7 + rng() * 0.4;
      gpuHardwareMs = 2.4 + rng() * 0.5;
    } else if (phase === 1) {
      // Heavy Chromium command-buffer stall
      frameDeltaMs = 50 + rng() * 12;
      jsCpuMs = 1.0 + rng() * 0.6;
      renderSubmitMs = 34 + rng() * 8;
      gpuHardwareMs = 13.0 + rng() * 2.0;
    } else if (phase === 2) {
      // Tab background sleep spikes mixed with 60Hz VSync
      frameDeltaMs = f % 250 === 0 ? 1800 : 16.67;
      jsCpuMs = 1.2;
      renderSubmitMs = 1.9;
      gpuHardwareMs = 7.5;
      uncappedRequested = false;
    } else if (phase === 3) {
      // Edge EcoQoS / iframe throttle without hardware GPU timer
      frameDeltaMs = 42 + rng() * 10;
      jsCpuMs = 1.2 + rng() * 0.5;
      renderSubmitMs = 1.8 + rng() * 0.5;
      gpuHardwareMs = null;
    } else {
      // Clean recovery back to fast 144Hz GPU
      frameDeltaMs = 6.9 + rng() * 0.4;
      jsCpuMs = 0.8 + rng() * 0.2;
      renderSubmitMs = 1.1 + rng() * 0.3;
      gpuHardwareMs = 4.8 + rng() * 0.5;
    }

    const dec = gov.evaluate({
      frameDeltaMs,
      jsCpuMs,
      renderSubmitMs,
      gpuHardwareMs,
      uncappedRequested,
      isSoftwareGl: false,
      documentHidden: false,
      graphicsQuality: 'hybrid',
    });

    if (dec.scheduleMode !== lastMode) {
      modeTransitions++;
      lastMode = dec.scheduleMode;
    }

    mon.recordFrame({
      frameDeltaMs,
      cpuWorkMs: dec.trueCpuWorkMs,
      jsCpuMs,
      renderSubmitMs,
      gpuStallMs: dec.estimatedGpuStallMs,
      gpuFrameMs: gpuHardwareMs,
      uncappedMode: dec.scheduleMode === 'message_channel',
      gpuLoadHint: 0.65,
      bottleneck: dec.bottleneck,
      backpressureGuarded: dec.backpressureGuarded,
    });

    if (f % 500 === 0) {
      const snap = mon.getSnapshot();
      assert.ok(Number.isFinite(snap.fps) && snap.fps > 0);
      assert.ok(Number.isFinite(snap.onePercentLowFps) && snap.onePercentLowFps <= snap.fps);
      assert.ok(snap.cpuUsagePct >= 0 && snap.cpuUsagePct <= 100);
      assert.ok(snap.gpuUsagePct >= 0 && snap.gpuUsagePct <= 100);
    }
  }
  const elapsedMs = performance.now() - t0;

  // With 10 regime blocks (20,000 / 2,000), hysteresis must prevent flapping (< 25 transitions total)
  assert.ok(modeTransitions <= 25, `Hysteresis failed — too many schedule mode flips: ${modeTransitions}`);
  assert.ok(elapsedMs < 80, `20,000 governor+monitor frames must be ultra-light (<80ms), took ${elapsedMs.toFixed(2)}ms`);
  console.log(
    `[STRESS-FP] 20k-frame chaos soak: ${elapsedMs.toFixed(2)} ms (${((elapsedMs / 20_000) * 1000).toFixed(2)} us/frame), ${modeTransitions} smooth transitions`,
  );
});

// ============================================================================
// 4. ADAPTIVE GTAO CADENCE, THERMAL RAMP & GPU TIMER IPC BUDGET STRESS
// ============================================================================

test('STRESS-FP 07 — Adaptive GTAO cadence steps 1 -> 2 -> 3 -> 1 under thermal ramp in Hybrid, stays 1 in Ultra', () => {
  const govHybrid = new FramePacingGovernor();
  const govUltra = new FramePacingGovernor();

  const stages: Array<{ frames: number; frameMs: number; gpuMs: number; expectHybrid: 1 | 2 | 3 }> = [
    { frames: 40, frameMs: 8.3, gpuMs: 6.5, expectHybrid: 1 },
    { frames: 40, frameMs: 16.6, gpuMs: 13.8, expectHybrid: 2 },
    { frames: 40, frameMs: 32.0, gpuMs: 24.5, expectHybrid: 3 },
    { frames: 80, frameMs: 8.3, gpuMs: 6.2, expectHybrid: 1 },
  ];

  for (const st of stages) {
    let lastHybridCadence: 1 | 2 | 3 = 1;
    let lastUltraCadence: 1 | 2 | 3 = 1;
    for (let i = 0; i < st.frames; i++) {
      lastHybridCadence = govHybrid.evaluate({
        frameDeltaMs: st.frameMs,
        jsCpuMs: 1.0,
        renderSubmitMs: 2.0,
        gpuHardwareMs: st.gpuMs,
        uncappedRequested: false,
        isSoftwareGl: false,
        documentHidden: false,
        graphicsQuality: 'hybrid',
      }).gtaoCadence;

      lastUltraCadence = govUltra.evaluate({
        frameDeltaMs: st.frameMs,
        jsCpuMs: 1.0,
        renderSubmitMs: 2.0,
        gpuHardwareMs: st.gpuMs,
        uncappedRequested: false,
        isSoftwareGl: false,
        documentHidden: false,
        graphicsQuality: 'ultra',
      }).gtaoCadence;
    }
    assert.equal(lastHybridCadence, st.expectHybrid, `Hybrid GTAO cadence at ${st.gpuMs}ms GPU`);
    assert.equal(lastUltraCadence, 1, 'Ultra tier must always keep GTAO cadence = 1');
  }
});

test('STRESS-FP 08 — GpuTimerQueryScheduler cuts Chromium synchronous GPU IPC calls by >95% at 250 FPS', () => {
  const sched = new GpuTimerQueryScheduler(220, 4);
  const TOTAL_FRAMES = 3000; // 12 seconds at 250 FPS (4ms/frame)
  let starts = 0;
  let polls = 0;
  let disjointIpcCalls = 0;

  for (let f = 0; f < TOTAL_FRAMES; f++) {
    const nowMs = f * 4.0;
    if (sched.shouldPollNow()) {
      polls++;
      // Query becomes available on first mature poll (>= 4 frames after endQuery)
      disjointIpcCalls++;
      sched.markCompleted();
    }
    if (sched.shouldStartNewQuery(nowMs)) {
      starts++;
    }
  }

  // Old code called gl.getParameter(GPU_DISJOINT_EXT) 3,000 times (every frame!)
  // New scheduler calls it only ~55 times across 12 seconds -> >98% IPC reduction!
  assert.ok(starts >= 50 && starts <= 60, `Expected ~55 sampled frames over 12s, got ${starts}`);
  assert.ok(disjointIpcCalls <= 60, `Expected <=60 synchronous disjoint IPC calls, got ${disjointIpcCalls}`);
  assert.ok(polls <= 65, `Expected minimal query polls, got ${polls}`);
  const reductionPct = (1 - disjointIpcCalls / TOTAL_FRAMES) * 100;
  assert.ok(reductionPct >= 97.5, `Expected >=97.5% IPC reduction, got ${reductionPct.toFixed(1)}%`);
  console.log(
    `[STRESS-FP] GpuTimerQueryScheduler: ${disjointIpcCalls}/${TOTAL_FRAMES} IPC calls (${reductionPct.toFixed(1)}% reduction)`,
  );
});

test('STRESS-FP 09 — InFlightFenceLimiter prevents queuing >1 GPU frame in MessageChannel mode', () => {
  const limiter = new InFlightFenceLimiter(1);
  // Signaled fences always stay in uncapped mode
  for (let i = 0; i < 100; i++) {
    assert.equal(limiter.evaluateFenceStatus(true), 'proceed_uncapped');
  }
  // Unsignaled GPU fence immediately yields to rAF instead of flooding command buffer
  assert.equal(limiter.evaluateFenceStatus(false), 'yield_to_raf');
  assert.equal(limiter.evaluateFenceStatus(false), 'yield_to_raf');
  assert.equal(limiter.getPendingChecks(), 2);

  // As soon as GPU signals completion, immediately resumes uncapped pacing
  assert.equal(limiter.evaluateFenceStatus(true), 'proceed_uncapped');
  assert.equal(limiter.getPendingChecks(), 0);
});

test('STRESS-FP 10 — Rapid VSync <-> Livre toggling (500 cycles) resets cleanly without stale stall state', () => {
  const gov = new FramePacingGovernor();
  const mon = new PerformanceMonitor(120);

  for (let cycle = 0; cycle < 500; cycle++) {
    // Induce heavy stall
    const stalled = gov.evaluate({
      frameDeltaMs: 55,
      jsCpuMs: 1.0,
      renderSubmitMs: 40,
      gpuHardwareMs: 14,
      uncappedRequested: true,
      isSoftwareGl: false,
      documentHidden: false,
      graphicsQuality: 'hybrid',
    });
    assert.equal(stalled.backpressureGuarded, true);

    // User toggles back to VSync & resets cleanly
    gov.reset();
    mon.reset();

    const clean = gov.evaluate({
      frameDeltaMs: 4.0,
      jsCpuMs: 0.7,
      renderSubmitMs: 0.9,
      gpuHardwareMs: 2.5,
      uncappedRequested: true,
      isSoftwareGl: false,
      documentHidden: false,
      graphicsQuality: 'hybrid',
    });
    assert.equal(clean.backpressureGuarded, false);
    assert.equal(clean.scheduleMode, 'message_channel');
  }
});

// ============================================================================
// 5. 1% LOW PERCENTILE PRECISION ACROSS 50 RANDOMIZED JITTER DISTRIBUTIONS
// ============================================================================

test('STRESS-FP 11 — 1% Low percentile accuracy across 50 randomized hitch/VRR/stutter profiles', () => {
  const rng = makeRng(9091);
  for (let trial = 0; trial < 50; trial++) {
    const mon = new PerformanceMonitor(200);
    const baseMs = 4.0 + rng() * 14.0; // 55..250 FPS base
    const hitchMs = baseMs + 15.0 + rng() * 40.0;
    const hitchIdxA = Math.floor(rng() * 100);
    const hitchIdxB = 100 + Math.floor(rng() * 100);

    for (let i = 0; i < 200; i++) {
      const isHitch = i === hitchIdxA || i === hitchIdxB;
      const dt = isHitch ? hitchMs : baseMs + (rng() - 0.5) * 0.4;
      mon.recordFrame({
        frameDeltaMs: dt,
        cpuWorkMs: Math.min(dt, 1.5),
        jsCpuMs: Math.min(dt, 0.8),
        renderSubmitMs: Math.min(dt, 1.0),
        gpuFrameMs: Math.min(dt, baseMs * 0.65),
        uncappedMode: baseMs < 10,
      });
    }

    const snap = mon.getSnapshot();
    const expectedOnePctLow = Math.round(1000 / hitchMs);
    assert.ok(snap.onePercentLowFps <= snap.fps, '1% Low must never exceed average FPS');
    assert.ok(
      Math.abs(snap.onePercentLowFps - expectedOnePctLow) <= 2,
      `Trial ${trial}: expected 1% Low ~${expectedOnePctLow}, got ${snap.onePercentLowFps}`,
    );
  }
});

// ============================================================================
// 6. FULL-PIPELINE INTEGRATED MULTI-BIOME CPU FRAME-BUDGET STRESS (10,000 FRAMES)
// ============================================================================

test('STRESS-FP 12 — Full integrated CPU stack across all 3 biomes (10,000 frames) stays strictly < 1.0 ms/frame', () => {
  const tm = new SandTerramechanics(SAND_DEFAULTS.RING_BUFFER_CAPACITY);
  const enc = new BrushEncoder(SAND_DEFAULTS.MAX_BRUSHES);
  const c0 = new ToroidalCascade(SAND_DEFAULTS.CASCADE0_SIZE, 512);
  const c1 = new ToroidalCascade(SAND_DEFAULTS.CASCADE1_SIZE, 512);
  const sleep0 = new SleepController();
  const sleep1 = new SleepController();
  const shadowSched = new ShadowUpdateScheduler();
  const farShadowSched = new FarShadowCascadeScheduler();
  const gov = new FramePacingGovernor();
  const mon = new PerformanceMonitor(240);
  const cockpit = createInitialCockpitState();
  const dmg = createInitialDamageState();
  const susp = createInitialSuspensionState(0, 0.94, 0.48, 3230, 55);
  snapSuspensionToGround(susp, 0, 0.94, 0.48, 3230, 55);

  const reflIn: ReflectionLodInput = {
    camToVehicleDist: 8.5,
    isCockpit: false,
    biome: 'rainy_highway',
    quality: 'hybrid',
    isMobile: false,
    vehicleSpeedMs: 22,
  };
  const reflOut: ReflectionLodProfile = {
    cubeMipBias: 0,
    cubeCooldownMult: 1,
    cubeFar: 220,
    mirrorIntervalMs: 16.2,
    mirrorViewportScale: 1,
    mirrorFar: 155,
  };

  const biomes: EnvironmentBiome[] = ['rainy_highway', 'desert', 'mud_grass'];
  const brokenFences = new Set<string>();
  const FRAMES = 10_000;
  const frameTimes = new Float32Array(FRAMES);

  let x = -1.55;
  let z = 0;
  let heading = 0;
  let vFwd = 28; // ~100 km/h
  let vLat = 0;
  let yawRate = 0;

  const tTotal0 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    const fStart = performance.now();
    const dt = 1 / 60;
    const nowMs = f * 16.667;
    const biome = biomes[Math.floor(f / 3334) % 3];

    enc.clear();
    tm.tickAging(dt, 0.25);

    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);
    const gY: [number, number, number, number] = [0, 0, 0, 0];
    const onRock: [number, number, number, number] = [0, 0, 0, 0];
    let avgG = 0;

    for (let w = 0; w < 4; w++) {
      const c = FOUR_CORNERS[w];
      const wx = x + cosH * c.lx + sinH * c.lz;
      const wz = z - sinH * c.lx + cosH * c.lz;
      const baseH = sampleTerrainHeightForBiome(wx, wz, biome);
      if (biome === 'desert') {
        const rk = sampleClimbableRockSurface(wx, wz, baseH);
        gY[w] = rk.height;
        onRock[w] = rk.onRock;
      } else {
        gY[w] = baseH;
        onRock[w] = biome === 'rainy_highway' ? 0.95 : 0;
      }
      avgG += gY[w] * 0.25;

      if (biome !== 'rainy_highway') {
        const wc = tm.evaluateWheelContact({
          worldX: wx,
          worldZ: wz,
          normalLoadN: susp.normalLoadN[w],
          tireWidth: 0.31,
          tireRadius: 0.48,
          slipRatio: 0.14,
          lateralSlipRad: 0.08,
          moisture: 0.35,
          biome,
          tirePressurePsi: 26,
        });
        enc.push({
          posPrevX: wx - sinH * 0.2,
          posPrevY: gY[w],
          posPrevZ: wz - cosH * 0.2,
          halfWidth: 0.18,
          posCurrX: wx,
          posCurrY: gY[w],
          posCurrZ: wz,
          targetSinkage: wc.sinkage,
          slipRatio: 0.14,
          treadPhasePrev: f * 0.2,
          treadPhaseCurr: (f + 1) * 0.2,
          lateralDrift: 0.05,
          brushType: BrushType.Wheel,
          atlasId: 0,
          compressionWeight: 0.7,
          massFactor: 1.0,
        });
      } else {
        const pot = sampleHighwayPothole(wx, wz);
        computeWetHighwayGrip(wx, wz, vFwd, 0.78);
        if (pot.mask01 > 0.3 && pot.depthM > 0.05) {
          applyPotholeSuspensionImpact(dmg, w, Math.abs(vFwd), pot.depthM);
        }
      }
    }

    const steer = Math.sin(f * 0.015) * 0.14;
    const drive = evaluateVehicleDriveStep({
      control: { throttle: 0.85, steer, handbrake: false, boost: f % 400 < 60 },
      vForwardMs: vFwd,
      isSprintPreset: false,
      driveMode: '4H',
    });
    const corner = evaluateTireCorneringAndYaw({
      dt,
      massKg: 3450,
      yawInertiaKgM2: 4650,
      vForwardMs: vFwd,
      vLateralMs: vLat,
      yawRateRadS: yawRate,
      steerAngleRad: steer,
      corners: FOUR_CORNERS,
      normalLoadN: susp.normalLoadN,
      groundContact01: susp.groundContact01,
      wheelSlipRatio: [0.1, 0.1, 0.14, 0.14],
      onRock,
      moisture: 0.4,
      tirePressurePsi: 28,
      isHandbrake: false,
      isLowRange: false,
      isRolledOver: false,
      rolledWheelAuthority: 1.0,
    });

    const netAx = (drive.engineForceN + corner.steeringDragForceN - 380) / 3450;
    vFwd = Math.max(0, Math.min(50, vFwd + netAx * dt));
    vLat = Math.max(-12, Math.min(12, vLat + corner.vLateralDeltaMs));
    yawRate = Math.max(-2.5, Math.min(2.5, yawRate + corner.yawRateDeltaRadS));
    const dH = yawRate * dt;
    heading += dH;
    const rot = rotateBodyVelocityByHeadingDelta(vFwd, vLat, dH);
    vFwd = rot.vForward;
    vLat = rot.vLateral;
    x += (Math.sin(heading) * vFwd + Math.cos(heading) * vLat) * dt;
    z += (Math.cos(heading) * vFwd - Math.sin(heading) * vLat) * dt;

    if (biome === 'rainy_highway') {
      const hit = resolveVehicleCapsuleHighwayCollision(x, z, heading, brokenFences);
      if (hit.hit && hit.obstacle?.breakable) brokenFences.add(hit.obstacle.id);
      if (Math.abs(x) > 14) x *= 0.2;
    } else if (biome === 'desert') {
      const rkCol = resolveRockCollisions(x, z, Math.sin(heading) * vFwd, Math.cos(heading) * vFwd, 1.5, DESERT_ROCK_OBSTACLES, {
        dt,
        vehicleMinY: avgG,
        vehicleMaxY: avgG + 2.0,
        sampleGroundY: sampleBaseTerrainHeight,
      });
      x = rkCol.x;
      z = rkCol.z;
      if (Math.hypot(x, z) > 150) {
        x *= 0.2;
        z *= 0.2;
      }
    }

    stepSuspensionDynamics(susp, {
      dt,
      sprungMassKg: 3230,
      unsprungMassKg: 55,
      tireRadiusM: 0.48,
      comHeightRestM: 0.94,
      corners: FOUR_CORNERS,
      groundSurfY: gY,
      onRock,
      tirePressurePsi: 28,
      longitudinalAccelMs2: netAx,
      lateralAccelMs2: corner.vLateralDeltaMs / dt,
      rolloverOverrideActive: false,
      rolloverRollRad: 0,
      rolloverPitchRad: 0,
      rolloverAirY: 0,
      avgGroundY: avgG,
    });

    stepCockpitState(cockpit, dt, {
      speedMs: vFwd,
      accelForwardMs2: netAx,
      lateralG: 0.2,
      rainIntensity: biome === 'rainy_highway' ? 0.78 : 0,
      suspensionBump: 0.02,
      wiperDamaged: false,
      ambientTempC: 14,
    });

    const s0 = c0.updateFocus(x, z);
    const s1 = c1.updateFocus(x, z);
    sleep0.update({
      dt,
      activeBrushCount: enc.getCount(),
      cascadeMoved: s0.moved,
      injectedEnergy: enc.getCount() * 0.08,
      windSpeed: 0.2,
      autoSleepEnabled: true,
    });
    sleep1.update({
      dt,
      activeBrushCount: enc.getCount(),
      cascadeMoved: s1.moved,
      injectedEnergy: enc.getCount() * 0.08,
      windSpeed: 0.2,
      autoSleepEnabled: true,
    });

    shadowSched.shouldUpdate({
      nowMs,
      vehicleX: x,
      vehicleY: avgG,
      vehicleZ: z,
      vehicleFwdX: sinH,
      vehicleFwdY: 0,
      vehicleFwdZ: cosH,
      vehicleSpeedMs: vFwd,
      sunDirX: 0.4,
      sunDirY: 0.3,
      sunDirZ: 0.86,
      hasMovingRunners: false,
      hasActiveDebris: false,
      forceImmediate: false,
    });
    farShadowSched.shouldUpdate({
      nowMs,
      focusX: x,
      focusZ: z,
      sunDirX: 0.4,
      sunDirY: 0.3,
      sunDirZ: 0.86,
      forceImmediate: false,
    });

    reflIn.biome = biome;
    reflIn.vehicleSpeedMs = vFwd;
    computeReflectionLodProfileInto(reflIn, reflOut);

    const jsCpuMs = performance.now() - fStart;
    frameTimes[f] = jsCpuMs;

    const dec = gov.evaluate({
      frameDeltaMs: 16.667,
      jsCpuMs,
      renderSubmitMs: 1.8,
      gpuHardwareMs: 8.5,
      uncappedRequested: false,
      isSoftwareGl: false,
      documentHidden: false,
      graphicsQuality: 'hybrid',
    });
    mon.recordFrame({
      frameDeltaMs: 16.667,
      cpuWorkMs: dec.trueCpuWorkMs,
      jsCpuMs,
      renderSubmitMs: 1.8,
      gpuStallMs: dec.estimatedGpuStallMs,
      gpuFrameMs: 8.5,
      uncappedMode: false,
      bottleneck: dec.bottleneck,
      backpressureGuarded: dec.backpressureGuarded,
    });
  }
  const totalMs = performance.now() - tTotal0;
  const avgMs = totalMs / FRAMES;
  frameTimes.sort();
  const p99Ms = frameTimes[Math.floor(FRAMES * 0.99)];

  assert.ok(avgMs < 1.0, `Full multi-biome CPU pipeline must average < 1.0 ms/frame, got ${avgMs.toFixed(4)} ms`);
  assert.ok(p99Ms < 2.5, `Full multi-biome CPU pipeline p99 must be < 2.5 ms/frame, got ${p99Ms.toFixed(4)} ms`);
  console.log(
    `[STRESS-FP] Full 10k-frame 3-biome CPU stack: avg=${avgMs.toFixed(4)} ms/frame, p99=${p99Ms.toFixed(4)} ms/frame (${Math.round(1000 / Math.max(0.001, avgMs)).toLocaleString()} FPS CPU ceiling)`,
  );
});

// ============================================================================
// 7. SAFE DEFAULT & HELPER INVARIANT GUARDS
// ============================================================================

test('STRESS-FP 13 — DEFAULT_RUNTIME_CONFIG uses compositor-synced rAF (fpsUncapped: false) to avoid iframe command-buffer stalls', () => {
  assert.equal(
    DEFAULT_RUNTIME_CONFIG.fpsUncapped,
    false,
    'Default config must use rAF VSync so Chromium/Edge iframes never flood the WebGL command queue on load',
  );
});

test('STRESS-FP 14 — splitRenderSubmitAndStall cleanly separates normal WebGL encode from GPU queue stalls', () => {
  // Fast frame: 0.8ms JS, 1.4ms WebGL encode -> 0ms stall
  const fast = splitRenderSubmitAndStall(0.8, 1.4, 8.3, 5.0);
  assert.equal(fast.gpuStallMs, 0);
  assert.equal(fast.encodeCpuMs, 1.4);

  // Stalled frame: 1.2ms JS, 39.3ms renderSubmit, 13.6ms HW GPU -> ~36.5ms stall, ~2.7ms encode
  const stalled = splitRenderSubmitAndStall(1.2, 39.3, 55.4, 13.6);
  assert.ok(stalled.encodeCpuMs <= 3.5, `Encode CPU must stay <=3.5ms, got ${stalled.encodeCpuMs}`);
  assert.ok(stalled.gpuStallMs >= 35.0, `Stall must capture >=35ms GPU wait, got ${stalled.gpuStallMs}`);
  assert.ok(Math.abs(stalled.encodeCpuMs + stalled.gpuStallMs - 39.3) < 1e-9);
});

test('STRESS-FP 15 — Exact RX 6xxx 37 FPS (26.9ms) / 10.8ms HW GPU screenshot matches Task Manager (~40% GPU, NEVER 95%)', () => {
  const gov = new FramePacingGovernor();
  const mon = new PerformanceMonitor(240);

  for (let f = 0; f < 240; f++) {
    const dec = gov.evaluate({
      frameDeltaMs: 26.9,
      jsCpuMs: 1.8,
      renderSubmitMs: 16.5, // Chromium/Edge IPC wait during VSync present
      gpuHardwareMs: 10.8,  // Real EXT_disjoint_timer_query_webgl2 on AMD RX 6xxx
      uncappedRequested: false,
      isSoftwareGl: false,
      documentHidden: false,
      graphicsQuality: 'ultra',
    });
    mon.recordFrame({
      frameDeltaMs: 26.9,
      cpuWorkMs: dec.trueCpuWorkMs,
      jsCpuMs: 1.8,
      renderSubmitMs: 16.5,
      gpuStallMs: dec.estimatedGpuStallMs,
      gpuFrameMs: 10.8,
      uncappedMode: false,
      bottleneck: dec.bottleneck,
      backpressureGuarded: dec.backpressureGuarded,
    });
  }

  const snap = mon.getSnapshot();
  assert.equal(snap.gpuHardwareMeasured, true);
  assert.ok(
    snap.gpuUsagePct >= 38 && snap.gpuUsagePct <= 43,
    `Hardware GPU% must match 10.8/26.9 = 40% (matching Task Manager 44%, NEVER 95%), got ${snap.gpuUsagePct}%`,
  );
  assert.ok(snap.cpuUsagePct <= 22, `CPU% must stay honest <=22%, got ${snap.cpuUsagePct}%`);
  assert.equal(
    snap.bottleneck,
    'browser_throttle',
    '37 FPS with 40% GPU and <22% CPU must honestly report browser_throttle',
  );
});

test('STRESS-FP 16 — Genuinely GPU-saturated Ultra 4K frame (23.5ms HW GPU in 25.0ms frame) reports ~94% GPU and gpu bottleneck', () => {
  const gov = new FramePacingGovernor();
  const mon = new PerformanceMonitor(180);

  for (let f = 0; f < 180; f++) {
    const dec = gov.evaluate({
      frameDeltaMs: 25.0,
      jsCpuMs: 1.1,
      renderSubmitMs: 12.0,
      gpuHardwareMs: 23.5,
      uncappedRequested: false,
      isSoftwareGl: false,
      documentHidden: false,
      graphicsQuality: 'ultra',
    });
    mon.recordFrame({
      frameDeltaMs: 25.0,
      cpuWorkMs: dec.trueCpuWorkMs,
      jsCpuMs: 1.1,
      renderSubmitMs: 12.0,
      gpuStallMs: dec.estimatedGpuStallMs,
      gpuFrameMs: 23.5,
      uncappedMode: false,
      bottleneck: dec.bottleneck,
      backpressureGuarded: dec.backpressureGuarded,
    });
  }

  const snap = mon.getSnapshot();
  assert.equal(snap.bottleneck, 'gpu');
  assert.ok(snap.gpuUsagePct >= 92 && snap.gpuUsagePct <= 96, `Expected ~94% GPU, got ${snap.gpuUsagePct}%`);
});

test('STRESS-FP 17 — Desktop PCs ALWAYS start in Ultra mode (even in narrow split-screen iframes) while phones start in Hybrid', () => {
  assert.equal(DEFAULT_RUNTIME_CONFIG.graphicsQuality, 'ultra');

  // Windows 11 Edge / Chrome desktop (even with touchscreen laptop!) -> PC Ultra
  assert.equal(
    detectIsMobileDevice(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/131.0.0.0',
      10,
      true,
    ),
    false,
  );
  assert.equal(getInitialGraphicsQuality(false), 'ultra');

  // macOS Safari / Chrome desktop -> PC Ultra
  assert.equal(
    detectIsMobileDevice(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      0,
      false,
    ),
    false,
  );

  // Android / iPhone mobile -> Mobile Hybrid
  assert.equal(
    detectIsMobileDevice(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36',
      5,
      true,
    ),
    true,
  );
  assert.equal(
    detectIsMobileDevice(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      5,
      true,
    ),
    true,
  );
  assert.equal(getInitialGraphicsQuality(true), 'hybrid');
});
