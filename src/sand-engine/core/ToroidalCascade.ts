/**
 * ToroidalCascade.ts
 * Zero-copy toroidal addressing state for a single deformation cascade.
 *
 * Key invariant:
 *   uv = fract(worldXZ / cascadeSize)
 *
 * When the focal anchor (vehicle / camera target) advances, existing texels are
 * NEVER copied or shifted. The origin snaps strictly to integer multiples of
 * texelSize, and the simulation shader clears only the newly exposed world
 * strip (plus a 2-texel guard band at the outer cascade boundary) in the same
 * pass as brush stamping.
 */

import { SAND_DEFAULTS } from './SandParams';

export interface ToroidalWindow {
  originX: number;
  originZ: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface ToroidalStepResult {
  moved: boolean;
  teleported: boolean;
  deltaTexelsX: number;
  deltaTexelsZ: number;
  prev: ToroidalWindow;
  curr: ToroidalWindow;
}

function fract(v: number): number {
  return v - Math.floor(v);
}

export class ToroidalCascade {
  public readonly size: number;
  public readonly resolution: number;
  public readonly texelSize: number;
  public readonly guardWorldWidth: number;

  private originX = 0;
  private originZ = 0;
  private prevOriginX = 0;
  private prevOriginZ = 0;
  private initialized = false;

  constructor(
    size: number,
    resolution: number = SAND_DEFAULTS.CASCADE_RESOLUTION,
    guardTexels: number = SAND_DEFAULTS.TOROIDAL_GUARD_TEXELS,
  ) {
    this.size = size;
    this.resolution = resolution;
    this.texelSize = size / resolution;
    this.guardWorldWidth = guardTexels * this.texelSize;
  }

  /** Snaps any world coordinate to an integer multiple of texelSize (prevents texel swimming). */
  public snapToTexel(worldCoord: number): number {
    return Math.round(worldCoord / this.texelSize) * this.texelSize;
  }

  /** Advances the toroidal window to track (targetX, targetZ). */
  public updateFocus(targetX: number, targetZ: number): ToroidalStepResult {
    const snappedX = this.snapToTexel(targetX);
    const snappedZ = this.snapToTexel(targetZ);

    if (!this.initialized) {
      this.originX = snappedX;
      this.originZ = snappedZ;
      // Force full initial clear by placing prev far outside curr
      this.prevOriginX = snappedX + this.size * 4;
      this.prevOriginZ = snappedZ + this.size * 4;
      this.initialized = true;
      return {
        moved: true,
        teleported: true,
        deltaTexelsX: this.resolution,
        deltaTexelsZ: this.resolution,
        prev: this.buildWindow(this.prevOriginX, this.prevOriginZ),
        curr: this.buildWindow(this.originX, this.originZ),
      };
    }

    this.prevOriginX = this.originX;
    this.prevOriginZ = this.originZ;
    this.originX = snappedX;
    this.originZ = snappedZ;

    const dx = this.originX - this.prevOriginX;
    const dz = this.originZ - this.prevOriginZ;
    const deltaTexelsX = Math.round(dx / this.texelSize);
    const deltaTexelsZ = Math.round(dz / this.texelSize);
    const moved = deltaTexelsX !== 0 || deltaTexelsZ !== 0;
    const teleported =
      Math.abs(dx) >= this.size - this.guardWorldWidth ||
      Math.abs(dz) >= this.size - this.guardWorldWidth;

    return {
      moved,
      teleported,
      deltaTexelsX,
      deltaTexelsZ,
      prev: this.buildWindow(this.prevOriginX, this.prevOriginZ),
      curr: this.buildWindow(this.originX, this.originZ),
    };
  }

  /** Resets cascade state so the next simulation pass clears all texels cleanly. */
  public forceFullClear(): void {
    this.prevOriginX = this.originX + this.size * 4;
    this.prevOriginZ = this.originZ + this.size * 4;
  }

  public getCurrentWindow(): ToroidalWindow {
    return this.buildWindow(this.originX, this.originZ);
  }

  public getPreviousWindow(): ToroidalWindow {
    return this.buildWindow(this.prevOriginX, this.prevOriginZ);
  }

  private buildWindow(ox: number, oz: number): ToroidalWindow {
    const half = this.size * 0.5;
    return {
      originX: ox,
      originZ: oz,
      minX: ox - half,
      minZ: oz - half,
      maxX: ox + half,
      maxZ: oz + half,
    };
  }

  /**
   * Maps a world XZ position to toroidal texture UV in [0, 1).
   * Exact CPU counterpart of GLSL `worldToToroidalUV()`.
   */
  public worldToToroidalUV(worldX: number, worldZ: number): [number, number] {
    return [fract(worldX / this.size), fract(worldZ / this.size)];
  }

  /**
   * Reconstructs the exact current world XZ coordinate represented by a texel at `uv` in [0, 1).
   * Exact CPU counterpart of GLSL `toroidalUVToWorld()`.
   */
  public toroidalUVToWorld(u: number, v: number): [number, number] {
    const win = this.getCurrentWindow();
    const baseU = fract(win.minX / this.size);
    const baseV = fract(win.minZ / this.size);
    const relU = fract(u - baseU);
    const relV = fract(v - baseV);
    return [win.minX + relU * this.size, win.minZ + relV * this.size];
  }

  /**
   * Determines whether a texel at `uv` must be cleared to zero on this pass because
   * it belongs to the newly exposed strip outside `prev` or inside the outer guard band.
   */
  public shouldClearTexel(u: number, v: number): boolean {
    const [wx, wz] = this.toroidalUVToWorld(u, v);
    const curr = this.getCurrentWindow();
    const prev = this.getPreviousWindow();
    const g = this.guardWorldWidth;

    // Clear outer guard band of the current window to prevent toroidal wrap bleed
    if (
      wx < curr.minX + g ||
      wx >= curr.maxX - g ||
      wz < curr.minZ + g ||
      wz >= curr.maxZ - g
    ) {
      return true;
    }

    // Clear if this world coordinate was outside the previous window's valid interior
    if (
      wx < prev.minX + g ||
      wx >= prev.maxX - g ||
      wz < prev.minZ + g ||
      wz >= prev.maxZ - g
    ) {
      return true;
    }

    return false;
  }

  /**
   * Computes smooth crossfade weight in [0, 1] for Cascade 0 (1 = full Cascade 0,
   * 0 = fully transitioned to Cascade 1 over the outer `crossfadeFraction` margin).
   */
  public computeCascadeWeight(
    worldX: number,
    worldZ: number,
    crossfadeFraction: number = SAND_DEFAULTS.CASCADE_CROSSFADE_FRACTION,
  ): number {
    const half = this.size * 0.5;
    const nx = Math.abs(worldX - this.originX) / half;
    const nz = Math.abs(worldZ - this.originZ) / half;
    const edgeDist = Math.max(nx, nz);

    const fadeStart = 1.0 - crossfadeFraction;
    const fadeEnd = 1.0 - (this.guardWorldWidth / half) * 1.5;

    if (edgeDist <= fadeStart) return 1.0;
    if (edgeDist >= fadeEnd) return 0.0;
    const t = (edgeDist - fadeStart) / Math.max(1e-5, fadeEnd - fadeStart);
    // Smoothstep falloff
    return 1.0 - t * t * (3.0 - 2.0 * t);
  }
}
