/**
 * SleepController.ts
 * Per-cascade hysteresis controller that suspends the 30 Hz avalanche/wind
 * relaxation dispatch when activeBrushCount == 0 and residual slope energy
 * stays below epsilon for `sleepTimeoutSec` (default 3.0 s), dropping GPU
 * simulation cost to 0.00 ms while parked.
 */

import { SAND_DEFAULTS } from './SandParams';

export interface SleepStepInput {
  dt: number;
  activeBrushCount: number;
  cascadeMoved: boolean;
  /** Estimated normalized residual slope/berm energy (decays during active relaxation) */
  injectedEnergy: number;
  windSpeed: number;
  autoSleepEnabled: boolean;
}

export interface SleepStateSnapshot {
  sleeping: boolean;
  idleSeconds: number;
  residualEnergy: number;
}

export class SleepController {
  private sleeping = false;
  private idleSeconds = 0;
  private residualEnergy = 0;

  private readonly timeoutSec: number;
  private readonly epsilon: number;

  constructor(
    timeoutSec: number = SAND_DEFAULTS.SLEEP_TIMEOUT_SECONDS,
    epsilon: number = SAND_DEFAULTS.SLEEP_ENERGY_EPSILON,
  ) {
    this.timeoutSec = timeoutSec;
    this.epsilon = epsilon;
  }

  public wake(initialEnergy = 0.25): void {
    this.sleeping = false;
    this.idleSeconds = 0;
    this.residualEnergy = Math.max(this.residualEnergy, initialEnergy);
  }

  public update(input: SleepStepInput): SleepStateSnapshot {
    if (!input.autoSleepEnabled) {
      this.sleeping = false;
      this.idleSeconds = 0;
      this.residualEnergy = Math.max(this.residualEnergy, input.injectedEnergy);
      return this.getSnapshot();
    }

    const hasActivity = input.activeBrushCount > 0 || input.cascadeMoved;

    if (hasActivity) {
      this.sleeping = false;
      this.idleSeconds = 0;
      this.residualEnergy = Math.min(
        1.0,
        Math.max(this.residualEnergy, 0.25 + input.injectedEnergy),
      );
      return this.getSnapshot();
    }

    if (this.sleeping) {
      return this.getSnapshot();
    }

    // Exponential decay of residual berm slumping energy during relaxation
    const decayRate = 1.65 + input.windSpeed * 0.25;
    this.residualEnergy *= Math.exp(-decayRate * input.dt);

    if (this.residualEnergy < this.epsilon) {
      this.residualEnergy = 0;
      this.idleSeconds += input.dt;
      if (this.idleSeconds >= this.timeoutSec) {
        this.sleeping = true;
      }
    } else {
      this.idleSeconds = 0;
    }

    return this.getSnapshot();
  }

  public isSleeping(): boolean {
    return this.sleeping;
  }

  public getSnapshot(): SleepStateSnapshot {
    return {
      sleeping: this.sleeping,
      idleSeconds: this.idleSeconds,
      residualEnergy: this.residualEnergy,
    };
  }
}
