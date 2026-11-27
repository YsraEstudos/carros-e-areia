/**
 * SimulationLod.ts
 * Distance- and focus-tiered Simulation & Physics LOD cadence controller.
 * Decouples simulation update rates (60 Hz / 30 Hz / 15 Hz / sleep) from unlocked
 * render FPS (120-400+ FPS) so distant runners, particles, and debris do not scale
 * CPU cost linearly with refresh rate.
 */

export type SimulationLodTier = 'full' | 'medium' | 'low' | 'sleep';

export interface SimulationLodRates {
  fullHz: number;
  mediumHz: number;
  lowHz: number;
}

export interface SimulationLodThresholds {
  mediumDistM: number;
  lowDistM: number;
  sleepDistM: number;
}

export interface LodCadenceState {
  accumSec: number;
  pendingDt: number;
  steps: number;
}

export const DEFAULT_SIMULATION_LOD_RATES: SimulationLodRates = {
  fullHz: 60,
  mediumHz: 30,
  lowHz: 15,
};

export const DEFAULT_SIMULATION_LOD_THRESHOLDS: SimulationLodThresholds = {
  mediumDistM: 28,
  lowDistM: 60,
  sleepDistM: 120,
};

export function createLodCadenceState(): LodCadenceState {
  return { accumSec: 0, pendingDt: 0, steps: 0 };
}

/**
 * Classifies an entity's simulation tier from squared distance to camera/vehicle focus,
 * focus override flag, and frustum visibility.
 */
export function selectSimulationTier(
  distSq: number,
  isFocus: boolean,
  visible = true,
  thresholds: SimulationLodThresholds = DEFAULT_SIMULATION_LOD_THRESHOLDS,
): SimulationLodTier {
  if (isFocus) return 'full';
  const medSq = thresholds.mediumDistM * thresholds.mediumDistM;
  const lowSq = thresholds.lowDistM * thresholds.lowDistM;
  const sleepSq = thresholds.sleepDistM * thresholds.sleepDistM;

  if (!visible) {
    return distSq >= lowSq ? 'sleep' : 'low';
  }
  if (distSq >= sleepSq) return 'sleep';
  if (distSq >= lowSq) return 'low';
  if (distSq >= medSq) return 'medium';
  return 'full';
}

/**
 * Accumulates render frame `dt` and returns the accumulated simulation timestep `consumedDt`
 * (> 0) only when the tier's fixed cadence interval has elapsed; otherwise returns `0`.
 * Guarantees time conservation across 15 / 30 / 60 Hz tiers even at 400+ FPS.
 */
export function consumeLodStepDt(
  state: LodCadenceState,
  frameDt: number,
  tier: SimulationLodTier,
  rates: SimulationLodRates = DEFAULT_SIMULATION_LOD_RATES,
  maxPendingDt = 0.2,
): number {
  const safeDt = frameDt > 0 ? (frameDt < 0.25 ? frameDt : 0.25) : 0;
  if (safeDt <= 0 || tier === 'sleep') {
    state.accumSec = 0;
    return 0;
  }

  const hz =
    tier === 'full'
      ? rates.fullHz
      : tier === 'medium'
        ? rates.mediumHz
        : rates.lowHz;
  const interval = hz > 0 ? 1.0 / hz : 0;

  state.accumSec += safeDt;
  state.pendingDt = Math.min(maxPendingDt, state.pendingDt + safeDt);

  if (state.accumSec + 1e-6 >= interval) {
    const consumedDt = state.pendingDt;
    state.pendingDt = 0;
    state.accumSec = interval > 0 ? Math.min(interval * 0.5, state.accumSec - interval) : 0;
    if (state.accumSec < 0) state.accumSec = 0;
    state.steps++;
    return consumedDt;
  }

  return 0;
}
