/**
 * ShadowUpdateScheduler.ts
 * Pure, engine-independent dirty-driven + wall-clock cadence scheduler for
 * directional shadow map updates (`renderer.shadowMap.autoUpdate = false`).
 *
 * Eliminates 75%–100% of redundant shadow-map geometry passes at high / unlocked
 * FPS (120–400+ FPS) and when parked/stationary, with zero visual degradation:
 *  - Forces an immediate shadow update whenever sun direction, shadow frustum/size,
 *    biome, quality, or vehicle state changes via `markDirty()`.
 *  - While stationary (vehicle still, no active crash debris, no moving runners),
 *    runs at 0 Hz (zero shadow draw calls!).
 *  - While moving, updates smoothly at wall-clock cadence (60 Hz normal, up to 90 Hz
 *    at high speed > 8 m/s) so shadows never lag on 60–90 Hz motion while never
 *    burning 4–6× redundant shadow passes per display refresh at 240–400 FPS.
 */

export interface ShadowScheduleInput {
  nowMs: number;
  vehicleX: number;
  vehicleY: number;
  vehicleZ: number;
  vehicleFwdX: number;
  vehicleFwdY: number;
  vehicleFwdZ: number;
  vehicleSpeedMs: number;
  sunDirX: number;
  sunDirY: number;
  sunDirZ: number;
  hasMovingRunners: boolean;
  hasActiveDebris: boolean;
  forceImmediate?: boolean;
}

export class ShadowUpdateScheduler {
  private dirty = true;
  private hasRenderedOnce = false;
  private lastUpdateMs = -Infinity;

  private lastVehX = NaN;
  private lastVehY = NaN;
  private lastVehZ = NaN;
  private lastFwdX = NaN;
  private lastFwdY = NaN;
  private lastFwdZ = NaN;
  private lastSunX = NaN;
  private lastSunY = NaN;
  private lastSunZ = NaN;

  public markDirty(): void {
    this.dirty = true;
  }

  public reset(): void {
    this.dirty = true;
    this.hasRenderedOnce = false;
    this.lastUpdateMs = -Infinity;
    this.lastVehX = NaN;
    this.lastVehY = NaN;
    this.lastVehZ = NaN;
    this.lastFwdX = NaN;
    this.lastFwdY = NaN;
    this.lastFwdZ = NaN;
    this.lastSunX = NaN;
    this.lastSunY = NaN;
    this.lastSunZ = NaN;
  }

  public hasRendered(): boolean {
    return this.hasRenderedOnce;
  }

  public shouldUpdate(input: ShadowScheduleInput): boolean {
    const {
      nowMs,
      vehicleX,
      vehicleY,
      vehicleZ,
      vehicleFwdX,
      vehicleFwdY,
      vehicleFwdZ,
      vehicleSpeedMs,
      sunDirX,
      sunDirY,
      sunDirZ,
      hasMovingRunners,
      hasActiveDebris,
      forceImmediate,
    } = input;

    const sunChanged =
      !this.hasRenderedOnce ||
      Math.abs(sunDirX - this.lastSunX) > 1e-4 ||
      Math.abs(sunDirY - this.lastSunY) > 1e-4 ||
      Math.abs(sunDirZ - this.lastSunZ) > 1e-4;

    if (forceImmediate || this.dirty || !this.hasRenderedOnce || sunChanged) {
      this.commit(input);
      return true;
    }

    const dx = vehicleX - this.lastVehX;
    const dy = vehicleY - this.lastVehY;
    const dz = vehicleZ - this.lastVehZ;
    const posDistSq = dx * dx + dy * dy + dz * dz;

    const dfx = vehicleFwdX - this.lastFwdX;
    const dfy = vehicleFwdY - this.lastFwdY;
    const dfz = vehicleFwdZ - this.lastFwdZ;
    const fwdDeltaSq = dfx * dfx + dfy * dfy + dfz * dfz;

    // Detect meaningful caster motion (1.5 cm translation or ~0.23 deg orientation change)
    const vehicleMoved = posDistSq > 0.000225 || fwdDeltaSq > 0.000016;
    const dynamicCastersActive = vehicleMoved || hasActiveDebris || hasMovingRunners;

    if (!dynamicCastersActive) {
      return false;
    }

    const elapsedMs = nowMs - this.lastUpdateMs;
    // Cap shadow re-renders by wall clock so uncapped 180–400+ FPS never wastes GPU/CPU
    // drawing identical shadow maps 4–6× per display refresh:
    //  - Fast driving (> 8 m/s) or flying debris: up to ~90 Hz (11 ms)
    //  - Normal driving / moving runners: up to 60 Hz (16.2 ms)
    const minIntervalMs =
      vehicleSpeedMs > 8.0 || hasActiveDebris ? 11.0 : 16.2;

    // Also allow instant update on large teleport / jump (> 1.5m since last shadow pass)
    if (elapsedMs >= minIntervalMs || posDistSq > 2.25) {
      this.commit(input);
      return true;
    }

    return false;
  }

  private commit(input: ShadowScheduleInput): void {
    this.dirty = false;
    this.hasRenderedOnce = true;
    this.lastUpdateMs = input.nowMs;
    this.lastVehX = input.vehicleX;
    this.lastVehY = input.vehicleY;
    this.lastVehZ = input.vehicleZ;
    this.lastFwdX = input.vehicleFwdX;
    this.lastFwdY = input.vehicleFwdY;
    this.lastFwdZ = input.vehicleFwdZ;
    this.lastSunX = input.sunDirX;
    this.lastSunY = input.sunDirY;
    this.lastSunZ = input.sunDirZ;
  }
}
