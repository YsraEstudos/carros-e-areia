/**
 * SmokePhysics.ts
 * Pure, engine-agnostic volumetric smoke & desert dust simulation utilities:
 *  1. Deterministic tileable 2D Perlin-Worley volumetric cloud atlas generator (RGBA8):
 *       R = multi-octave billowing cloud density [0..255]
 *       G = normalized X derivative (for 3D volumetric normal reconstruction)
 *       B = normalized Y derivative (for 3D volumetric normal reconstruction)
 *       A = high-frequency wispy curl-erosion mask [0..255]
 *     Baked once on startup (~2 ms) so the GPU fragment shader achieves AAA volumetric
 *     cauliflower smoke in just 2 texture fetches with zero per-pixel FBM overhead.
 *  2. Physically calibrated wheel dust, tire drift smoke & twin-exhaust emission curves.
 */

import { EnvironmentBiome } from './SandParams';

export enum SmokeLayerType {
  DesertDust = 0,
  DriftSmoke = 1,
  Exhaust = 2,
}

export interface WheelSmokeSampleInput {
  speedMs: number;
  wheelSlip: number;
  lateralSpeedMs: number;
  moisture: number;
  boostActive: boolean;
  handbrake: boolean;
  isRear: boolean;
  biome?: EnvironmentBiome;
}

export interface WheelSmokeEmission {
  dustIntensity: number;
  driftSmokeIntensity: number;
  roostIntensity: number;
}

export interface ExhaustSmokeInput {
  throttle: number;
  rpm: number;
  boostActive: boolean;
  speedMs: number;
}

export interface ExhaustSmokeEmission {
  rateHz: number;
  opacity: number;
  ejectSpeedMs: number;
  darkness: number; // 0 = light warm vapor, 1 = dense dark turbo soot
  sizeMeters: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function hash2Periodic(ix: number, iy: number, period: number, seed: number): number {
  const px = ((ix % period) + period) % period;
  const py = ((iy % period) + period) % period;
  let n = (px * 374761393 + py * 668265263 + seed * 1442695041) | 0;
  n = (n ^ (n >> 13)) * 1274126177;
  n = n ^ (n >> 16);
  return (n >>> 0) / 4294967295;
}

function valueNoisePeriodic(
  u: number,
  v: number,
  freq: number,
  seed: number,
): number {
  const x = u * freq;
  const y = v * freq;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const n00 = hash2Periodic(ix, iy, freq, seed);
  const n10 = hash2Periodic(ix + 1, iy, freq, seed);
  const n01 = hash2Periodic(ix, iy + 1, freq, seed);
  const n11 = hash2Periodic(ix + 1, iy + 1, freq, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

/** Tileable inverted Worley cellular noise producing rounded billowy cloud puffs */
function worleyBillowPeriodic(
  u: number,
  v: number,
  cells: number,
  seed: number,
): number {
  const x = u * cells;
  const y = v * cells;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  let minDistSq = 4.0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const rx = hash2Periodic(ix + dx, iy + dy, cells, seed);
      const ry = hash2Periodic(ix + dx, iy + dy, cells, seed + 97);
      const ddx = dx + rx - fx;
      const ddy = dy + ry - fy;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < minDistSq) minDistSq = d2;
    }
  }
  return clamp(1.0 - Math.sqrt(minDistSq) * 0.92, 0, 1);
}

/**
 * Generates a tileable RGBA8 procedural volumetric smoke & curl-flow atlas:
 * R: smooth multi-octave billowing cloud/plume density [0..255]
 * G: divergence-free 2D curl flow X (dPsi/dy) mapped to [0..255] (128 = 0)
 * B: divergence-free 2D curl flow Y (-dPsi/dx) mapped to [0..255] (128 = 0)
 * A: wispy lacy edge-erosion filaments [0..255]
 */
export function generateVolumetricSmokeAtlas(size = 256): Uint8Array {
  const total = size * size;
  const density = new Float32Array(total);
  const stream = new Float32Array(total);
  const wisp = new Float32Array(total);

  let minD = 1e9;
  let maxD = -1e9;
  let minS = 1e9;
  let maxS = -1e9;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;

      // Smooth organic domain warp for rolling aerodynamic billows
      const warpU = (valueNoisePeriodic(u, v, 3, 71) - 0.5) * 0.11;
      const warpV = (valueNoisePeriodic(u, v, 3, 97) - 0.5) * 0.11;
      const wu = (u + warpU + 1.0) % 1.0;
      const wv = (v + warpV + 1.0) % 1.0;

      // Clean cloud-lobe FBM + soft Worley billows (zero gritty high-frequency static)
      const p1 = valueNoisePeriodic(wu, wv, 3, 11);
      const p2 = valueNoisePeriodic(wu, wv, 6, 23);
      const p3 = valueNoisePeriodic(wu, wv, 12, 47);
      const fbm = p1 * 0.50 + p2 * 0.34 + p3 * 0.16;

      const w1 = worleyBillowPeriodic(wu, wv, 3, 131);
      const w2 = worleyBillowPeriodic(wu, wv, 6, 197);
      const worley = w1 * 0.58 + w2 * 0.42;

      const raw = clamp(fbm * 0.54 + worley * 0.52 - 0.06, 0, 1);
      const sculpted = Math.pow(raw, 1.08);
      const idx = y * size + x;
      density[idx] = sculpted;
      if (sculpted < minD) minD = sculpted;
      if (sculpted > maxD) maxD = sculpted;

      // Smooth periodic stream function Psi for divergence-free curl flow advection
      const psi =
        valueNoisePeriodic(u, v, 3, 211) * 0.62 +
        valueNoisePeriodic(u, v, 6, 277) * 0.28 +
        valueNoisePeriodic(u, v, 10, 353) * 0.10;
      stream[idx] = psi;
      if (psi < minS) minS = psi;
      if (psi > maxS) maxS = psi;

      // Soft lacy erosion filaments for realistic feathering edges
      const wf =
        valueNoisePeriodic(wu, wv, 5, 307) * 0.48 +
        worleyBillowPeriodic(wu, wv, 8, 401) * 0.34 +
        valueNoisePeriodic(u, v, 14, 509) * 0.18;
      wisp[idx] = clamp(wf, 0, 1);
    }
  }

  // Normalize density and stream potential to full [0..1]
  const invRangeD = 1.0 / Math.max(1e-4, maxD - minD);
  const invRangeS = 1.0 / Math.max(1e-4, maxS - minS);
  for (let i = 0; i < total; i++) {
    density[i] = clamp((density[i] - minD) * invRangeD, 0, 1);
    stream[i] = clamp((stream[i] - minS) * invRangeS, 0, 1);
  }

  const rgba = new Uint8Array(total * 4);
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const idx = y * size + x;

      // Periodic curl = (dPsi/dy, -dPsi/dx) -> divergence-free swirling vortex field
      const dPsiDx =
        ((stream[ym * size + xp] + 2 * stream[y * size + xp] + stream[yp * size + xp]) -
          (stream[ym * size + xm] + 2 * stream[y * size + xm] + stream[yp * size + xm])) *
        0.55;
      const dPsiDy =
        ((stream[yp * size + xm] + 2 * stream[yp * size + x] + stream[yp * size + xp]) -
          (stream[ym * size + xm] + 2 * stream[ym * size + x] + stream[ym * size + xp])) *
        0.55;

      const curlX = dPsiDy;
      const curlY = -dPsiDx;

      const o = idx * 4;
      rgba[o + 0] = Math.round(density[idx] * 255);
      rgba[o + 1] = Math.round(clamp(curlX * 0.5 + 0.5, 0, 1) * 255);
      rgba[o + 2] = Math.round(clamp(curlY * 0.5 + 0.5, 0, 1) * 255);
      rgba[o + 3] = Math.round(wisp[idx] * 255);
    }
  }

  return rgba;
}

/**
 * Computes physically grounded desert dust, tire drift smoke & ballistic sand roost intensities.
 * Dry loose desert sand kicks up a delicate low-speed roost mist even at crawl speeds, scaling smoothly
 * into wide rolling aerodynamic dust wakes at rally speeds.
 */
export function computeWheelSmokeEmission(
  input: WheelSmokeSampleInput,
): WheelSmokeEmission {
  const isMud = input.biome === 'mud_grass';
  const speed = Math.abs(input.speedMs);
  const lat = Math.abs(input.lateralSpeedMs);
  const slip = clamp(input.wheelSlip, 0, 1.5);
  const dryness = isMud
    ? 0.04
    : clamp(1.0 - input.moisture * 0.72, 0.22, 1.0);
  const rearBoost = input.isRear ? 1.25 : 0.72;

  const speedDust = clamp((speed - 0.9) / 12.0, 0, 1);
  const slipDust = slip * 0.88 + clamp(lat / 5.0, 0, 1.0) * 0.9;
  const boostDust = input.boostActive ? 0.32 : 0.0;
  const dustIntensity = clamp(
    (speedDust * 0.58 + slipDust * 0.65 + boostDust) * dryness * rearBoost,
    0,
    1.0,
  );

  // Thick tire drift smoke is suppressed on sloppy wet mud
  const driftTrigger =
    clamp((slip - 0.34) * 1.35, 0, 1) +
    clamp((lat - 2.2) / 5.5, 0, 1) * 0.85 +
    (input.handbrake && input.isRear && speed > 2.2 ? 0.85 : 0) +
    (input.boostActive && input.isRear ? 0.45 : 0);
  const driftScale = isMud ? 0.06 : 1.0;
  const driftSmokeIntensity = clamp(
    driftTrigger * (input.isRear ? 1.0 : 0.38) * driftScale,
    0,
    1.0,
  );

  // Heavy ballistic sand grains / muddy splash clods
  const roostIntensity = clamp(
    (slip * 0.72 + clamp(lat / 7.0, 0, 0.85) + (input.boostActive ? 0.28 : 0)) *
      (speed > 1.0 || slip > 0.22 ? rearBoost : 0) *
      (isMud ? 1.25 : 1.0),
    0,
    1.0,
  );

  return { dustIntensity, driftSmokeIntensity, roostIntensity };
}

/**
 * Computes twin-exhaust plume behavior from idle wisps to punchy Turbo Boost soot bursts.
 */
export function computeExhaustSmokeEmission(
  input: ExhaustSmokeInput,
): ExhaustSmokeEmission {
  const load = clamp(Math.abs(input.throttle), 0, 1);
  const rpmT = clamp((input.rpm - 900) / 5600, 0, 1);
  const boost = input.boostActive ? 1.0 : 0.0;

  return {
    rateHz: 5.0 + load * 11.0 + rpmT * 8.0 + boost * 13.0,
    opacity: clamp(0.11 + load * 0.14 + boost * 0.18, 0.08, 0.42),
    ejectSpeedMs: 2.2 + load * 3.8 + rpmT * 2.4 + boost * 5.2,
    darkness: clamp(0.28 + load * 0.32 + boost * 0.28, 0.22, 0.88),
    sizeMeters: 0.16 + load * 0.10 + boost * 0.14,
  };
}
