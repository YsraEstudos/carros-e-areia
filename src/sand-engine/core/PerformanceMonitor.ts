/**
 * PerformanceMonitor.ts
 * Pure, engine-agnostic, zero-GC real-time performance telemetry calculator.
 *
 * Tracks a rolling ring buffer of frame deltas, true main-thread CPU work times
 * (strictly separated from synchronous WebGL/GPU backpressure stalls), and
 * hardware GPU timer query durations to compute:
 *  - Live FPS & frame time (ms) without artificial caps (60 / 120 / 240 / 600+ Hz)
 *  - True rolling 1% Low FPS (average of the slowest 1% frames in the rolling window)
 *  - Honest Main-thread CPU utilization (%) & ms (never inflated by GPU-queue stalls!)
 *  - Honest GPU utilization (%) & ms (hardware EXT_disjoint_timer_query_webgl2 when exposed,
 *    accounting for GPU queue saturation, with a stall-aware calibrated fallback when absent)
 */

import { PerformanceBottleneck, splitRenderSubmitAndStall } from './FramePacingGovernor';

export interface PerformanceSnapshot {
  /** Smoothed instantaneous FPS (uncapped) */
  fps: number;
  /** Average frame-to-frame time in milliseconds */
  frameTimeMs: number;
  /** True 1% Low FPS over the rolling frame window */
  onePercentLowFps: number;
  /** Honest main-thread CPU work utilization (0..100%) */
  cpuUsagePct: number;
  /** Smoothed honest main-thread CPU work duration per frame (ms) */
  cpuWorkMs: number;
  /** Pure JS simulation + uniform update time per frame (ms) */
  jsCpuMs: number;
  /** WebGL render call duration including any synchronous driver/IPC wait (ms) */
  renderSubmitMs: number;
  /** Estimated synchronous GPU/IPC backpressure wait inside renderSubmitMs (ms) */
  gpuStallMs: number;
  /** GPU utilization (0..100%) */
  gpuUsagePct: number;
  /** GPU execution duration per frame (ms, hardware-measured or calibrated estimate) */
  gpuWorkMs: number;
  /** True when GPU% comes directly from WebGL2 EXT_disjoint_timer_query_webgl2 */
  gpuHardwareMeasured: boolean;
  /** Primary detected bottleneck ('balanced' | 'gpu' | 'cpu' | 'browser_throttle') */
  bottleneck: PerformanceBottleneck;
  /** True when uncapped mode was automatically paced via rAF to prevent GPU queue stalls */
  backpressureGuarded: boolean;
  /** Number of valid frames currently in the rolling window */
  sampleCount: number;
}

export interface PerformanceFrameInput {
  /** Wall-clock delta between consecutive rendered frames in milliseconds */
  frameDeltaMs: number;
  /**
   * Main-thread CPU work duration for this frame in milliseconds.
   * When `jsCpuMs` & `renderSubmitMs` are supplied, `PerformanceMonitor` automatically
   * separates pure JS + command encoding from synchronous GPU-queue backpressure stalls.
   */
  cpuWorkMs: number;
  /** Optional pure JS simulation + scene update duration BEFORE renderer calls (ms) */
  jsCpuMs?: number;
  /** Optional duration spent inside WebGL render calls (encoding + driver sync wait, ms) */
  renderSubmitMs?: number;
  /** Optional pre-computed GPU backpressure stall duration (ms) */
  gpuStallMs?: number;
  /** Hardware GPU frame time in ms from EXT_disjoint_timer_query_webgl2, or null if unavailable */
  gpuFrameMs: number | null;
  /** True when running in uncapped / VSync-free frame pacing mode */
  uncappedMode: boolean;
  /** Normalized GPU render load hint (0.15..1.0) used only when hardware GPU timer is unavailable */
  gpuLoadHint?: number;
  /** Optional bottleneck diagnosis from FramePacingGovernor */
  bottleneck?: PerformanceBottleneck;
  /** Optional indicator that FramePacingGovernor engaged rAF backpressure guard */
  backpressureGuarded?: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class PerformanceMonitor {
  private readonly capacity: number;
  private readonly frameDeltas: Float32Array;
  private readonly sortScratch: Float32Array;

  private head = 0;
  private count = 0;

  private smoothedFrameMs = 16.667;
  private smoothedCpuMs = 2.0;
  private smoothedJsCpuMs = 1.0;
  private smoothedRenderSubmitMs = 1.0;
  private smoothedGpuStallMs = 0.0;
  private smoothedGpuMs = 0.0;
  private hasGpuHardwareSample = false;
  private smoothedGpuPct = 0.0;
  private lastBottleneck: PerformanceBottleneck = 'balanced';
  private lastBackpressureGuarded = false;
  private initialized = false;

  constructor(windowCapacity = 240) {
    this.capacity = Math.max(30, Math.round(windowCapacity));
    this.frameDeltas = new Float32Array(this.capacity);
    this.sortScratch = new Float32Array(this.capacity);
  }

  public reset(): void {
    this.head = 0;
    this.count = 0;
    this.smoothedFrameMs = 16.667;
    this.smoothedCpuMs = 2.0;
    this.smoothedJsCpuMs = 1.0;
    this.smoothedRenderSubmitMs = 1.0;
    this.smoothedGpuStallMs = 0.0;
    this.smoothedGpuMs = 0.0;
    this.smoothedGpuPct = 0.0;
    this.hasGpuHardwareSample = false;
    this.lastBottleneck = 'balanced';
    this.lastBackpressureGuarded = false;
    this.initialized = false;
  }

  /**
   * Records a completed frame into the zero-GC ring buffer.
   * Ignores extreme outliers (> 500ms, e.g. browser tab backgrounding) so 1% Low stays truthful.
   */
  public recordFrame(input: PerformanceFrameInput): void {
    if (!Number.isFinite(input.frameDeltaMs) || input.frameDeltaMs <= 0) return;

    // Ignore tab-sleep stalls (> 500ms) from corrupting the rolling window
    if (input.frameDeltaMs > 500) return;

    const frameMs = clamp(input.frameDeltaMs, 0.08, 500);
    const hasGranularTimings =
      input.jsCpuMs !== undefined &&
      input.renderSubmitMs !== undefined &&
      Number.isFinite(input.jsCpuMs) &&
      Number.isFinite(input.renderSubmitMs);

    let trueCpuMs: number;
    let jsCpuMs: number;
    let renderSubmitMs: number;
    let gpuStallMs: number;

    if (hasGranularTimings) {
      jsCpuMs = clamp(input.jsCpuMs!, 0, frameMs);
      renderSubmitMs = clamp(input.renderSubmitMs!, 0, frameMs);
      if (input.gpuStallMs !== undefined && Number.isFinite(input.gpuStallMs)) {
        gpuStallMs = clamp(input.gpuStallMs, 0, renderSubmitMs);
        trueCpuMs = clamp(jsCpuMs + Math.max(0, renderSubmitMs - gpuStallMs), 0, frameMs);
      } else {
        const split = splitRenderSubmitAndStall(jsCpuMs, renderSubmitMs, frameMs, input.gpuFrameMs);
        gpuStallMs = split.gpuStallMs;
        trueCpuMs = clamp(jsCpuMs + split.encodeCpuMs, 0, frameMs);
      }
    } else {
      trueCpuMs = clamp(Number.isFinite(input.cpuWorkMs) ? input.cpuWorkMs : 0, 0, frameMs);
      jsCpuMs = trueCpuMs;
      renderSubmitMs = 0;
      gpuStallMs = clamp(
        input.gpuStallMs !== undefined && Number.isFinite(input.gpuStallMs) ? input.gpuStallMs : 0,
        0,
        frameMs,
      );
    }

    this.frameDeltas[this.head] = frameMs;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }

    // Time-consistent exponential smoothing (~220ms half-life regardless of whether FPS is 30 or 400)
    const alpha = this.initialized ? clamp(1 - Math.exp(-frameMs / 220), 0.02, 0.35) : 1.0;
    this.smoothedFrameMs += (frameMs - this.smoothedFrameMs) * alpha;
    this.smoothedCpuMs += (trueCpuMs - this.smoothedCpuMs) * alpha;
    this.smoothedJsCpuMs += (jsCpuMs - this.smoothedJsCpuMs) * alpha;
    this.smoothedRenderSubmitMs += (renderSubmitMs - this.smoothedRenderSubmitMs) * alpha;
    this.smoothedGpuStallMs += (gpuStallMs - this.smoothedGpuStallMs) * alpha;

    if (input.gpuFrameMs !== null && Number.isFinite(input.gpuFrameMs) && input.gpuFrameMs > 0) {
      const gpuMs = clamp(input.gpuFrameMs, 0.02, 500);
      if (!this.hasGpuHardwareSample) {
        this.smoothedGpuMs = gpuMs;
      } else {
        this.smoothedGpuMs += (gpuMs - this.smoothedGpuMs) * alpha;
      }
      this.hasGpuHardwareSample = true;

      // True hardware GPU utilization matches WDDM / Task Manager / AMD Adrenalin:
      // active GPU execution time divided by the real wall-clock frame interval.
      // (e.g., 10.8ms GPU inside a 26.9ms frame = 40% real GPU duty, NOT 95%!)
      const hwPct = clamp((this.smoothedGpuMs / Math.max(0.1, this.smoothedFrameMs)) * 100, 1, 100);
      this.smoothedGpuPct = this.initialized
        ? this.smoothedGpuPct + (hwPct - this.smoothedGpuPct) * alpha
        : hwPct;
    } else if (!this.hasGpuHardwareSample) {
      // Honest calibrated fallback when browser/mobile driver hides EXT_disjoint_timer_query_webgl2:
      // Combines actual frame pacing saturation + pipeline load weight without inflating IPC waits to 95%.
      const loadHint = clamp(input.gpuLoadHint ?? 0.55, 0.12, 1.0);
      const cpuFrac = clamp(trueCpuMs / Math.max(0.1, frameMs), 0, 1);
      const stallFrac = clamp(gpuStallMs / Math.max(0.1, frameMs), 0, 1);
      let estGpuPct: number;

      if (stallFrac >= 0.25) {
        // Command-buffer backpressure: blend pipeline load with stall ratio conservatively
        estGpuPct = clamp((0.36 + loadHint * 0.28 + stallFrac * 0.24) * 100, 42, 88);
      } else if (input.uncappedMode) {
        // In unlocked mode, if true JS CPU isn't pegging the thread, GPU is the primary limiter
        const gpuBoundFrac = clamp(1 - cpuFrac * 0.72, 0.18, 0.99);
        estGpuPct = clamp((gpuBoundFrac * 0.72 + loadHint * 0.28) * 100, 8, 99);
      } else {
        // In VSync mode, estimate GPU occupancy from frame duration relative to 60Hz interval + pipeline weight
        const frameBudgetPressure = clamp(frameMs / 16.667, 0.12, 1.0);
        const nonCpuRatio = clamp(1 - cpuFrac * 0.55, 0.2, 1.0);
        estGpuPct = clamp(
          (frameBudgetPressure * 0.58 + loadHint * 0.42) * nonCpuRatio * 100,
          6,
          99,
        );
      }
      const estGpuMs = (estGpuPct / 100) * Math.min(this.smoothedFrameMs, 33.33);
      this.smoothedGpuMs = this.initialized
        ? this.smoothedGpuMs + (estGpuMs - this.smoothedGpuMs) * alpha
        : estGpuMs;
      this.smoothedGpuPct = this.initialized
        ? this.smoothedGpuPct + (estGpuPct - this.smoothedGpuPct) * alpha
        : estGpuPct;
    }

    if (input.bottleneck) {
      this.lastBottleneck = input.bottleneck;
    } else if (this.smoothedCpuMs > this.smoothedFrameMs * 0.65) {
      this.lastBottleneck = 'cpu';
    } else if (
      this.hasGpuHardwareSample
        ? this.smoothedGpuPct >= 78
        : this.smoothedGpuStallMs >= 8.0 || this.smoothedGpuPct >= 82
    ) {
      this.lastBottleneck = 'gpu';
    } else if (this.smoothedFrameMs >= 24.0 && this.smoothedCpuMs < this.smoothedFrameMs * 0.5 && this.smoothedGpuPct < 65) {
      this.lastBottleneck = 'browser_throttle';
    } else {
      this.lastBottleneck = 'balanced';
    }

    if (input.backpressureGuarded !== undefined) {
      this.lastBackpressureGuarded = input.backpressureGuarded;
    }

    this.initialized = true;
  }

  /**
   * Computes current FPS, true 1% Low FPS, honest CPU%, and GPU% snapshot.
   * Safe to call at UI telemetry frequency (~5–6 Hz) with zero heap allocations.
   */
  public getSnapshot(): PerformanceSnapshot {
    if (this.count === 0) {
      return {
        fps: 0,
        frameTimeMs: 0,
        onePercentLowFps: 0,
        cpuUsagePct: 0,
        cpuWorkMs: 0,
        jsCpuMs: 0,
        renderSubmitMs: 0,
        gpuStallMs: 0,
        gpuUsagePct: 0,
        gpuWorkMs: 0,
        gpuHardwareMeasured: false,
        bottleneck: 'balanced',
        backpressureGuarded: false,
        sampleCount: 0,
      };
    }

    const n = this.count;
    const fps = 1000 / Math.max(0.08, this.smoothedFrameMs);

    // Copy active window into pre-allocated scratch buffer and sort ascending
    const scratch = this.sortScratch.subarray(0, n);
    for (let i = 0; i < n; i++) {
      scratch[i] = this.frameDeltas[i];
    }
    scratch.sort();

    // Average the slowest 1% of frames (highest frame deltas at the end of sorted array)
    const lowCount = Math.max(1, Math.ceil(n * 0.01));
    let slowestSumMs = 0;
    for (let i = n - lowCount; i < n; i++) {
      slowestSumMs += scratch[i];
    }
    const avgSlowestMs = slowestSumMs / lowCount;
    const rawOnePercentLow = 1000 / Math.max(0.08, avgSlowestMs);
    const onePercentLowFps = Math.min(fps, rawOnePercentLow);

    const cpuUsagePct = clamp(
      (this.smoothedCpuMs / Math.max(0.1, this.smoothedFrameMs)) * 100,
      0,
      100,
    );
    const gpuUsagePct = clamp(this.smoothedGpuPct, 0, 100);

    return {
      fps: Math.round(fps),
      frameTimeMs: Number(this.smoothedFrameMs.toFixed(2)),
      onePercentLowFps: Math.max(1, Math.round(onePercentLowFps)),
      cpuUsagePct: Math.round(cpuUsagePct),
      cpuWorkMs: Number(this.smoothedCpuMs.toFixed(2)),
      jsCpuMs: Number(this.smoothedJsCpuMs.toFixed(2)),
      renderSubmitMs: Number(this.smoothedRenderSubmitMs.toFixed(2)),
      gpuStallMs: Number(this.smoothedGpuStallMs.toFixed(2)),
      gpuUsagePct: Math.round(gpuUsagePct),
      gpuWorkMs: Number(this.smoothedGpuMs.toFixed(2)),
      gpuHardwareMeasured: this.hasGpuHardwareSample,
      bottleneck: this.lastBottleneck,
      backpressureGuarded: this.lastBackpressureGuarded,
      sampleCount: n,
    };
  }
}
