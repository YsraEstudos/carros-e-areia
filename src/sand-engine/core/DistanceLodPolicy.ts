/**
 * DistanceLodPolicy.ts
 * Pure, engine-independent smart distance LOD policy governing:
 *  1. 3D scene object geometry/material LOD distances (rocks, trees, canopies, poles, grass)
 *  2. Far Shadow Cascade (Cascade 1, ±128m low-res) dirty-driven update scheduler
 *  3. Distance-adaptive Reflection LOD (CubeCamera mip bias, probe cadence, clip far,
 *     and dynamic wing-mirror viewport resolution & refresh interval)
 */

import { EnvironmentBiome, GraphicsQuality } from './SandParams';

export interface SceneObjectLodDistances {
  /** Desert sandstone rock: high -> medium poly & Lambert switch (m) */
  readonly rockLod1: number;
  /** Desert sandstone rock: medium -> 20-tri ultra-low poly switch (m) */
  readonly rockLod2: number;
  /** Mossy boulder: high -> low poly switch (m) */
  readonly mossyRockLod1: number;
  /** Rainy highway eucalyptus trunk & utility pole: high -> low poly + Lambert (m) */
  readonly trunkPoleLod1: number;
  /** Rainy highway canopy clusters: 3-card -> 1-card simplified crown (m) */
  readonly canopyLod1: number;
  /** Rainy highway roadside grass tufts: 3-card -> 1-card tuft (m) */
  readonly roadsideGrassLod1: number;
  /** Mud meadow 3D grass: 6-blade curved -> 3-blade lightweight tuft (m) */
  readonly mudGrassLod1: number;
  /** Desert scrub tufts: crossed -> single card (m) */
  readonly desertScrubLod1: number;
  /** Far shadow cascade map resolution (px) */
  readonly farShadowMapSize: number;
  /** Far shadow cascade half-extent (m) */
  readonly farShadowExtent: number;
}

const DESKTOP_ULTRA_LOD: SceneObjectLodDistances = Object.freeze({
  rockLod1: 42,
  rockLod2: 96,
  mossyRockLod1: 36,
  trunkPoleLod1: 52,
  canopyLod1: 58,
  roadsideGrassLod1: 36,
  mudGrassLod1: 22,
  desertScrubLod1: 44,
  farShadowMapSize: 512,
  farShadowExtent: 128,
});

const DESKTOP_HYBRID_LOD: SceneObjectLodDistances = Object.freeze({
  rockLod1: 34,
  rockLod2: 82,
  mossyRockLod1: 30,
  trunkPoleLod1: 44,
  canopyLod1: 50,
  roadsideGrassLod1: 30,
  mudGrassLod1: 18,
  desertScrubLod1: 36,
  farShadowMapSize: 512,
  farShadowExtent: 124,
});

const MOBILE_LOD: SceneObjectLodDistances = Object.freeze({
  rockLod1: 24,
  rockLod2: 64,
  mossyRockLod1: 22,
  trunkPoleLod1: 34,
  canopyLod1: 40,
  roadsideGrassLod1: 22,
  mudGrassLod1: 14,
  desertScrubLod1: 26,
  farShadowMapSize: 384,
  farShadowExtent: 112,
});

const LOW_LOD: SceneObjectLodDistances = Object.freeze({
  rockLod1: 20,
  rockLod2: 52,
  mossyRockLod1: 18,
  trunkPoleLod1: 28,
  canopyLod1: 34,
  roadsideGrassLod1: 18,
  mudGrassLod1: 12,
  desertScrubLod1: 22,
  farShadowMapSize: 384,
  farShadowExtent: 100,
});

export function getSceneObjectLodDistances(
  quality: GraphicsQuality,
  isMobile: boolean,
  isSoftwareGl: boolean,
): SceneObjectLodDistances {
  if (isSoftwareGl || quality === 'low') return LOW_LOD;
  if (isMobile) return MOBILE_LOD;
  return quality === 'ultra' ? DESKTOP_ULTRA_LOD : DESKTOP_HYBRID_LOD;
}

export interface ReflectionLodInput {
  camToVehicleDist: number;
  isCockpit: boolean;
  biome: EnvironmentBiome;
  quality: GraphicsQuality;
  isMobile: boolean;
  vehicleSpeedMs: number;
}

export interface ReflectionLodProfile {
  /** Extra hardware cubemap mip bias added as camera pulls away from the vehicle (0.0 close -> up to 1.8 far) */
  cubeMipBias: number;
  /** Multiplier on CubeCamera cooldown frames/ms when vehicle is distant on screen */
  cubeCooldownMult: number;
  /** Adaptive CubeCamera far clip plane tailored to biome visibility fog */
  cubeFar: number;
  /** Adaptive mirror refresh interval in ms (smoothly lowers Hz when vehicle/mirror is distant) */
  mirrorIntervalMs: number;
  /** Dynamic viewport scale (0.45..1.0) on existing mirror RT (zero reallocation!) */
  mirrorViewportScale: number;
  /** Adaptive mirror camera far clip plane tailored to biome visibility fog */
  mirrorFar: number;
}

/**
 * Zero-allocation computation of distance-adaptive reflection LOD parameters.
 * Close-up & cockpit views keep 100% sharp mirror resolution and crisp cubemap mips;
 * as the camera zooms away, reflection resolution, refresh rate, and mip detail scale
 * smoothly down to save GPU fill-rate & draw calls without visual loss.
 */
export function computeReflectionLodProfileInto(
  input: ReflectionLodInput,
  out: ReflectionLodProfile,
): ReflectionLodProfile {
  const dist = Math.max(0, input.camToVehicleDist);
  const moving = input.vehicleSpeedMs >= 0.08;

  // Biome-aware horizon clip distance (matches exponential fog visibility so reflections never waste draws in fog)
  if (input.biome === 'rainy_highway') {
    out.cubeFar = input.isMobile ? 165 : 220;
    out.mirrorFar = input.isMobile ? 115 : 155;
  } else if (input.biome === 'mud_grass') {
    out.cubeFar = input.isMobile ? 240 : 340;
    out.mirrorFar = input.isMobile ? 140 : 185;
  } else {
    out.cubeFar = input.isMobile ? 380 : 540;
    out.mirrorFar = input.isMobile ? 170 : 230;
  }

  if (input.isCockpit) {
    out.cubeMipBias = 0.0;
    out.cubeCooldownMult = 1.0;
    out.mirrorIntervalMs = moving ? 16.2 : 48.0;
    out.mirrorViewportScale = 1.0;
    return out;
  }

  // Keep cubemap crisp (0.0 extra mip bias) across all normal chase & orbit views (<= 14.5m),
  // gently increasing mip bias only when zoomed far out (>= 14.5m..45m)
  const mipT = Math.max(0, Math.min(1, (dist - 14.5) / 30.5));
  const smoothMipT = mipT * mipT * (3.0 - 2.0 * mipT);
  out.cubeMipBias = smoothMipT * (input.isMobile ? 1.35 : 1.15);

  // Keep full 1.0x probe refresh responsiveness out to 15.5m; throttle only at long drone zoom-outs
  if (dist <= 15.5) {
    out.cubeCooldownMult = 1.0;
  } else if (dist <= 26.0) {
    out.cubeCooldownMult = 1.6;
  } else if (dist <= 38.0) {
    out.cubeCooldownMult = 3.0;
  } else {
    out.cubeCooldownMult = 4.2;
  }

  // Dynamic wing-mirror viewport resolution & Hz scaling for exterior cameras
  if (dist <= 6.8) {
    out.mirrorViewportScale = 1.0;
    out.mirrorIntervalMs = moving ? 16.2 : 48.0;
  } else if (dist <= 11.5) {
    out.mirrorViewportScale = input.quality === 'ultra' ? 0.78 : 0.68;
    out.mirrorIntervalMs = moving ? 28.0 : 66.0;
  } else {
    out.mirrorViewportScale = 0.52;
    out.mirrorIntervalMs = moving ? 46.0 : 96.0;
  }

  return out;
}

export interface FarShadowScheduleInput {
  nowMs: number;
  focusX: number;
  focusZ: number;
  sunDirX: number;
  sunDirY: number;
  sunDirZ: number;
  forceImmediate?: boolean;
}

/**
 * Dirty-driven scheduler for Far Shadow Cascade 1 (±112..128m low-res shadow map).
 * Only triggers a re-render when:
 *  - First frame / biome / quality / teleport (`markDirty()` or `forceImmediate`)
 *  - Sun direction changed beyond ~0.25 degrees
 *  - Focus traveled >= `recenterDistanceM` (default 12m) from the last snapped shadow origin
 * Result: 0.00 ms/frame when stationary or slowly maneuvering, and ~2-3 tiny 512² passes/sec at highway speed.
 */
export class FarShadowCascadeScheduler {
  private readonly recenterDistSq: number;
  private readonly minIntervalMs: number;
  private dirty = true;
  private lastUpdateMs = -1e9;
  private lastOriginX = NaN;
  private lastOriginZ = NaN;
  private lastSunX = NaN;
  private lastSunY = NaN;
  private lastSunZ = NaN;

  constructor(recenterDistanceM = 12.0, minIntervalMs = 120.0) {
    this.recenterDistSq = recenterDistanceM * recenterDistanceM;
    this.minIntervalMs = minIntervalMs;
  }

  public markDirty(): void {
    this.dirty = true;
  }

  public shouldUpdate(input: FarShadowScheduleInput): boolean {
    const dSunX = input.sunDirX - this.lastSunX;
    const dSunY = input.sunDirY - this.lastSunY;
    const dSunZ = input.sunDirZ - this.lastSunZ;
    const sunMoved =
      Number.isNaN(this.lastSunX) ||
      dSunX * dSunX + dSunY * dSunY + dSunZ * dSunZ > 3e-5;

    if (this.dirty || input.forceImmediate || sunMoved || Number.isNaN(this.lastOriginX)) {
      this.commit(input);
      return true;
    }

    const dx = input.focusX - this.lastOriginX;
    const dz = input.focusZ - this.lastOriginZ;
    const movedSq = dx * dx + dz * dz;
    if (movedSq >= this.recenterDistSq && input.nowMs - this.lastUpdateMs >= this.minIntervalMs) {
      this.commit(input);
      return true;
    }

    return false;
  }

  private commit(input: FarShadowScheduleInput): void {
    this.dirty = false;
    this.lastUpdateMs = input.nowMs;
    this.lastOriginX = input.focusX;
    this.lastOriginZ = input.focusZ;
    this.lastSunX = input.sunDirX;
    this.lastSunY = input.sunDirY;
    this.lastSunZ = input.sunDirZ;
  }
}
