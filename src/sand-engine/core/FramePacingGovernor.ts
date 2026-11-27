/**
 * FramePacingGovernor.ts
 * Pure, engine-agnostic, zero-GC frame pacing, GPU backpressure guard,
 * WebGL2 timer-query IPC rate limiter, and bottleneck classifier.
 *
 * Solves two systemic Chromium/Edge/WebGL2 pathologies:
 *  1. Uncapped MessageChannel command-buffer flooding: posting 0ms macrotasks
 *     faster than the GPU drains frames fills Chromium's shared-memory WebGL
 *     command ring and blocks the main thread synchronously for 2-4 GPU frames
 *     (e.g. 3 x 13.6ms = 40.5ms -> 18 FPS), which also triggers Edge Efficiency
 *     Mode (EcoQoS) in cross-origin iframes.
 *  2. Per-frame gl.getParameter(GPU_DISJOINT_EXT) synchronous IPC stalls:
 *     rate-limits timer query acquisition & polling to ~4-5 Hz after a 4-frame
 *     GPU pipeline maturity delay, cutting Renderer->GPU Mojo IPC calls by >95%.
 */

import { GraphicsQuality } from './SandParams';

export type PerformanceBottleneck = 'balanced' | 'gpu' | 'cpu' | 'browser_throttle';
export type FrameScheduleMode = 'raf' | 'message_channel';

export interface FramePacingSample {
  /** Wall-clock delta between consecutive frames (ms) */
  frameDeltaMs: number;
  /** Pure JS simulation + scene/uniform update duration BEFORE renderer calls (ms) */
  jsCpuMs: number;
  /** Wall-clock duration spent inside renderMainScene (WebGL command encoding + driver/IPC sync wait, ms) */
  renderSubmitMs: number;
  /** Hardware GPU frame time from EXT_disjoint_timer_query_webgl2, or null if unavailable */
  gpuHardwareMs: number | null;
  /** True when user enabled unlocked ("Livre") FPS mode */
  uncappedRequested: boolean;
  /** True when running on SwiftShader / software WebGL */
  isSoftwareGl: boolean;
  /** True when document.hidden is true */
  documentHidden: boolean;
  /** Active graphics quality tier */
  graphicsQuality: GraphicsQuality;
}

export interface FramePacingDecision {
  /** Recommended scheduler for the NEXT tick */
  scheduleMode: FrameScheduleMode;
  /** True when uncapped mode was requested but automatically paced via rAF to prevent GPU command-buffer stalls */
  backpressureGuarded: boolean;
  /** Estimated portion of renderSubmitMs that was synchronous GPU/IPC backpressure wait (ms) */
  estimatedGpuStallMs: number;
  /** Honest main-thread CPU duration (jsCpuMs + actual JS-side WebGL command encoding, excluding GPU stall, ms) */
  trueCpuWorkMs: number;
  /** Primary bottleneck classification for diagnostics */
  bottleneck: PerformanceBottleneck;
  /** Lossless GTAO update cadence (1 = every frame, 2 = every 2nd frame, 3 = every 3rd frame) */
  gtaoCadence: 1 | 2 | 3;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Estimates how much of `renderSubmitMs` was real JS-side Three.js command encoding
 * vs synchronous Chromium/ANGLE GPU-command-buffer or swapchain backpressure stall.
 *
 * Typical Three.js scene (~80-160 draw calls) encodes in ~0.8-3.2 ms on JS main thread.
 * When `renderSubmitMs` jumps to 15-45 ms while `jsCpuMs` is < 4 ms, the excess time
 * is synchronous GPU-queue blocking and must NEVER be misreported as 73% CPU usage.
 */
export function splitRenderSubmitAndStall(
  jsCpuMs: number,
  renderSubmitMs: number,
  frameDeltaMs: number,
  gpuHardwareMs: number | null,
): { encodeCpuMs: number; gpuStallMs: number } {
  const safeJs = Number.isFinite(jsCpuMs) && jsCpuMs > 0 ? jsCpuMs : 0;
  const safeRender = Number.isFinite(renderSubmitMs) && renderSubmitMs > 0 ? renderSubmitMs : 0;
  const safeFrame = Number.isFinite(frameDeltaMs) && frameDeltaMs > 0 ? frameDeltaMs : 16.667;

  // Expected normal JS-side WebGL draw-call encoding ceiling scales mildly with JS speed
  // (slower CPUs / EcoQoS take slightly more encoding time, up to 3.8ms; fast CPUs < 2.2ms).
  const encodeCeilingMs = clamp(2.2 + safeJs * 0.45, 2.2, 4.2);

  if (safeRender <= encodeCeilingMs) {
    return { encodeCpuMs: safeRender, gpuStallMs: 0 };
  }

  // If hardware GPU time is known and renderSubmit exceeds normal encode + small margin,
  // or renderSubmit dominates while pure JS work is tiny, the excess is GPU/driver wait.
  const gpuPressured =
    (gpuHardwareMs !== null && gpuHardwareMs >= 8.0) ||
    safeRender > encodeCeilingMs * 1.45 ||
    (safeRender > 6.5 && safeJs < safeRender * 0.35);

  if (!gpuPressured) {
    // High JS-bound scene traversal (e.g. heavy CPU stall on a slow core)
    const encodePart = Math.min(safeRender, Math.max(encodeCeilingMs, safeRender * 0.72));
    return {
      encodeCpuMs: encodePart,
      gpuStallMs: Math.max(0, safeRender - encodePart),
    };
  }

  const encodeCpuMs = Math.min(safeRender, encodeCeilingMs);
  const gpuStallMs = clamp(safeRender - encodeCpuMs, 0, safeFrame);
  return { encodeCpuMs, gpuStallMs };
}

export class FramePacingGovernor {
  private smoothedFrameMs = 16.667;
  private smoothedJsCpuMs = 1.2;
  private smoothedRenderSubmitMs = 2.0;
  private smoothedGpuStallMs = 0.0;
  private smoothedGpuMs = 0.0;
  private hasHwGpu = false;
  private initialized = false;

  // Hysteresis state for uncapped backpressure guard (prevents rapid rAF <-> MessageChannel flapping)
  private backpressureGuarded = false;
  private consecutiveStallFrames = 0;
  private consecutiveFastFrames = 0;

  // Hysteresis state for adaptive GTAO cadence in Hybrid mode
  private currentGtaoCadence: 1 | 2 | 3 = 1;
  private gtaoCadenceHoldFrames = 0;

  private readonly decisionScratch: FramePacingDecision = {
    scheduleMode: 'raf',
    backpressureGuarded: false,
    estimatedGpuStallMs: 0,
    trueCpuWorkMs: 0,
    bottleneck: 'balanced',
    gtaoCadence: 1,
  };

  public reset(): void {
    this.smoothedFrameMs = 16.667;
    this.smoothedJsCpuMs = 1.2;
    this.smoothedRenderSubmitMs = 2.0;
    this.smoothedGpuStallMs = 0.0;
    this.smoothedGpuMs = 0.0;
    this.hasHwGpu = false;
    this.initialized = false;
    this.backpressureGuarded = false;
    this.consecutiveStallFrames = 0;
    this.consecutiveFastFrames = 0;
    this.currentGtaoCadence = 1;
    this.gtaoCadenceHoldFrames = 0;
  }

  /**
   * Evaluates the latest completed frame and returns a zero-GC pacing & diagnostic decision.
   */
  public evaluate(sample: FramePacingSample): Readonly<FramePacingDecision> {
    const out = this.decisionScratch;

    const rawFrameMs =
      Number.isFinite(sample.frameDeltaMs) && sample.frameDeltaMs > 0
        ? sample.frameDeltaMs
        : 16.667;
    const isOutlierSleep = rawFrameMs > 500;
    const frameMs = clamp(rawFrameMs, 0.25, 250);
    const jsCpuMs = clamp(Number.isFinite(sample.jsCpuMs) ? sample.jsCpuMs : 0, 0, frameMs);
    const renderSubmitMs = clamp(
      Number.isFinite(sample.renderSubmitMs) ? sample.renderSubmitMs : 0,
      0,
      frameMs,
    );
    const hwGpuMs =
      sample.gpuHardwareMs !== null &&
      Number.isFinite(sample.gpuHardwareMs) &&
      sample.gpuHardwareMs > 0
        ? clamp(sample.gpuHardwareMs, 0.05, 250)
        : null;

    const { encodeCpuMs, gpuStallMs } = splitRenderSubmitAndStall(
      jsCpuMs,
      renderSubmitMs,
      frameMs,
      hwGpuMs,
    );
    const trueCpuWorkMs = clamp(jsCpuMs + encodeCpuMs, 0, frameMs);

    if (!isOutlierSleep) {
      const alpha = this.initialized ? clamp(1 - Math.exp(-frameMs / 180), 0.04, 0.35) : 1.0;
      this.smoothedFrameMs += (frameMs - this.smoothedFrameMs) * alpha;
      this.smoothedJsCpuMs += (jsCpuMs - this.smoothedJsCpuMs) * alpha;
      this.smoothedRenderSubmitMs += (renderSubmitMs - this.smoothedRenderSubmitMs) * alpha;
      this.smoothedGpuStallMs += (gpuStallMs - this.smoothedGpuStallMs) * alpha;
      if (hwGpuMs !== null) {
        this.smoothedGpuMs = this.hasHwGpu
          ? this.smoothedGpuMs + (hwGpuMs - this.smoothedGpuMs) * alpha
          : hwGpuMs;
        this.hasHwGpu = true;
      }
      this.initialized = true;
    }

    // 1. Backpressure Guard for Uncapped ("Livre") mode
    const canEverUncap = !sample.isSoftwareGl && !sample.documentHidden && sample.uncappedRequested;
    if (!canEverUncap) {
      this.backpressureGuarded = false;
      this.consecutiveStallFrames = 0;
      this.consecutiveFastFrames = 0;
      out.scheduleMode = 'raf';
      out.backpressureGuarded = false;
    } else {
      // Detect GPU command-buffer saturation or sub-70fps hardware/browser pacing where
      // raw 0ms MessageChannel loops can only queue up frames and cause 40ms/18fps deadlocks!
      const instantStall = gpuStallMs >= 4.5 || renderSubmitMs >= 8.5;
      const slowGpuOrBrowser =
        (this.hasHwGpu && this.smoothedGpuMs >= 11.5) ||
        this.smoothedFrameMs >= 14.5 ||
        this.smoothedGpuStallMs >= 3.5;

      if (instantStall || slowGpuOrBrowser) {
        this.consecutiveStallFrames++;
        this.consecutiveFastFrames = 0;
        // Engage guard immediately on heavy stall (>= 8ms) or after 3 consecutive pressured frames
        if (gpuStallMs >= 8.0 || this.consecutiveStallFrames >= 3) {
          this.backpressureGuarded = true;
        }
      } else {
        this.consecutiveStallFrames = 0;
        const clearlyFast =
          this.smoothedFrameMs < 11.2 &&
          this.smoothedGpuStallMs < 1.2 &&
          (!this.hasHwGpu || this.smoothedGpuMs < 9.5);
        if (clearlyFast) {
          this.consecutiveFastFrames++;
          // Require 24 clean frames of headroom before releasing backpressure guard
          if (this.consecutiveFastFrames >= 24) {
            this.backpressureGuarded = false;
          }
        }
      }

      out.backpressureGuarded = this.backpressureGuarded;
      out.scheduleMode = this.backpressureGuarded ? 'raf' : 'message_channel';
    }

    // 2. Honest Bottleneck Classification
    const safeSmoothedFrameMs = Math.max(0.1, this.smoothedFrameMs);
    const trueCpuSmoothed = this.smoothedJsCpuMs + Math.min(this.smoothedRenderSubmitMs, 3.8);
    const cpuDuty = trueCpuSmoothed / safeSmoothedFrameMs;
    const hwGpuDuty = this.hasHwGpu ? this.smoothedGpuMs / safeSmoothedFrameMs : 0;

    if (this.smoothedJsCpuMs >= 9.0 || (trueCpuSmoothed >= 11.0 && cpuDuty > 0.58)) {
      out.bottleneck = 'cpu';
    } else if (
      this.hasHwGpu
        ? (hwGpuDuty >= 0.78 && this.smoothedFrameMs >= 14.0) || this.smoothedGpuMs >= 16.5
        : this.smoothedGpuStallMs >= 8.0 && this.smoothedFrameMs >= 20.0
    ) {
      out.bottleneck = 'gpu';
    } else if (
      this.smoothedFrameMs >= 24.0 &&
      cpuDuty < 0.5 &&
      this.smoothedJsCpuMs < 6.5 &&
      (this.hasHwGpu ? hwGpuDuty < 0.65 : this.smoothedGpuStallMs < 8.0)
    ) {
      // Frame rate < 42 FPS even though BOTH JS CPU and hardware GPU have ample headroom ->
      // browser/OS Efficiency Mode (EcoQoS), cross-origin iframe compositor cap, or battery-saver cap!
      out.bottleneck = 'browser_throttle';
    } else {
      out.bottleneck = 'balanced';
    }

    // 3. Lossless Adaptive GTAO Cadence (keeps GTAO enabled with zero visual cuts)
    if (sample.graphicsQuality === 'ultra' || sample.graphicsQuality === 'low' || sample.isSoftwareGl) {
      this.currentGtaoCadence = 1;
      this.gtaoCadenceHoldFrames = 0;
    } else {
      const pressureMs = Math.max(
        this.hasHwGpu ? this.smoothedGpuMs : 0,
        this.smoothedFrameMs > 20 ? this.smoothedFrameMs * 0.65 : 0,
        this.smoothedGpuStallMs,
      );
      let desired: 1 | 2 | 3 = 1;
      if (pressureMs >= 19.0 || this.smoothedFrameMs >= 30.0) {
        desired = 3;
      } else if (pressureMs >= 11.0 || this.smoothedFrameMs >= 19.5) {
        desired = 2;
      }

      if (desired > this.currentGtaoCadence) {
        // Step up relief quickly when GPU is stressed
        this.gtaoCadenceHoldFrames++;
        if (this.gtaoCadenceHoldFrames >= 6) {
          this.currentGtaoCadence = desired;
          this.gtaoCadenceHoldFrames = 0;
        }
      } else if (desired < this.currentGtaoCadence) {
        // Step back to full cadence smoothly after 30 calm frames
        this.gtaoCadenceHoldFrames++;
        if (this.gtaoCadenceHoldFrames >= 30) {
          this.currentGtaoCadence = desired;
          this.gtaoCadenceHoldFrames = 0;
        }
      } else {
        this.gtaoCadenceHoldFrames = 0;
      }
    }

    out.estimatedGpuStallMs = gpuStallMs;
    out.trueCpuWorkMs = trueCpuWorkMs;
    out.gtaoCadence = this.currentGtaoCadence;
    return out;
  }
}

/**
 * Pure IPC-budget policy for EXT_disjoint_timer_query_webgl2.
 * Ensures we NEVER hammer Chromium's GPU process with per-frame synchronous
 * `gl.getParameter(GPU_DISJOINT_EXT)` roundtrips (cuts IPC calls by >95%).
 */
export class GpuTimerQueryScheduler {
  private readonly sampleIntervalMs: number;
  private readonly minMaturityFrames: number;
  private lastSampleStartMs = -1e6;
  private framesSinceEnd = 0;
  private queryInFlight = false;

  constructor(sampleIntervalMs = 220, minMaturityFrames = 4) {
    this.sampleIntervalMs = Math.max(50, sampleIntervalMs);
    this.minMaturityFrames = Math.max(2, Math.round(minMaturityFrames));
  }

  public reset(): void {
    this.lastSampleStartMs = -1e6;
    this.framesSinceEnd = 0;
    this.queryInFlight = false;
  }

  /** Returns true only when an in-flight query has aged enough frames to safely poll without stalling */
  public shouldPollNow(): boolean {
    if (!this.queryInFlight) return false;
    this.framesSinceEnd++;
    return this.framesSinceEnd >= this.minMaturityFrames;
  }

  /** Call when QUERY_RESULT_AVAILABLE returned true and query was consumed/deleted */
  public markCompleted(): void {
    this.queryInFlight = false;
    this.framesSinceEnd = 0;
  }

  /** Returns true at ~4-5 Hz when no query is currently pending */
  public shouldStartNewQuery(nowMs: number): boolean {
    if (this.queryInFlight) return false;
    if (nowMs - this.lastSampleStartMs < this.sampleIntervalMs) return false;
    this.lastSampleStartMs = nowMs;
    this.queryInFlight = true;
    this.framesSinceEnd = 0;
    return true;
  }

  public isInFlight(): boolean {
    return this.queryInFlight;
  }
}

/**
 * Pure state machine for the WebGL2 fenceSync in-flight frame limiter used in uncapped mode.
 * Guarantees at most 1 GPU frame is queued ahead in MessageChannel mode.
 */
export class InFlightFenceLimiter {
  private pendingChecks = 0;
  private readonly maxUnsignaledChecks: number;

  constructor(maxUnsignaledChecks = 1) {
    this.maxUnsignaledChecks = Math.max(1, Math.round(maxUnsignaledChecks));
  }

  public reset(): void {
    this.pendingChecks = 0;
  }

  /**
   * Evaluates whether the previous frame's GPU fence has signaled.
   * Returns `'proceed_uncapped'` if GPU drained the previous frame, or `'yield_to_raf'`
   * if the GPU is still busy so we yield cleanly instead of flooding Chromium's queue.
   */
  public evaluateFenceStatus(signaled: boolean): 'proceed_uncapped' | 'yield_to_raf' {
    if (signaled) {
      this.pendingChecks = 0;
      return 'proceed_uncapped';
    }
    this.pendingChecks++;
    if (this.pendingChecks >= this.maxUnsignaledChecks) {
      return 'yield_to_raf';
    }
    return 'proceed_uncapped';
  }

  public getPendingChecks(): number {
    return this.pendingChecks;
  }
}
