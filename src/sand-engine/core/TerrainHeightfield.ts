/**
 * TerrainHeightfield.ts
 * Analytical desert dune heightfield mirrored identically between CPU physics
 * (zero GPU readback) and GLSL vertex/simulation shaders.
 *
 * Keeps the central proving ground gently rolling (so 150 km/h runs and tight
 * donuts stay fast, readable, and grounded) while rising into dramatic sculpted
 * dune ridges toward the perimeter.
 */

import { EnvironmentBiome } from './SandParams';
import { sampleRainyHighwayHeight } from './RainyHighwayModel';

export interface TerrainSample {
  height: number;
  normalX: number;
  normalY: number;
  normalZ: number;
}

function terrainSmoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Uneven wind-scoured sandy moguls & staggered cross-axle washboard undulations
 * mirrored identically in `commonToroidal.ts` (`getUnevenSandOffset(vec2 xz)`).
 *
 * Concentrated along the off-road articulation corridor (x ∈ [6..22], z ∈ [36..58])
 * plus subtle staggered sandy humps across the mid-basin so tires visibly compress,
 * droop, and reveal the real flotation difference between 12 PSI and 32 PSI!
 */
export function sampleUnevenSandOffset(x: number, z: number): number {
  let offset = 0;

  // Dedicated sandy mogul & cross-axle washboard zone directly after the climbable rock trail
  const mx = (x - 14.0) / 8.5;
  const mz = (z - 46.5) / 11.5;
  const mDistSq = mx * mx + mz * mz;
  if (mDistSq < 1.1025) {
    const mogulZone = 1.0 - terrainSmoothstep(0.55, 1.05, Math.sqrt(mDistSq));
    if (mogulZone > 1e-5) {
      offset +=
        (Math.sin(x * 1.15) * Math.sin(z * 0.85) * 0.24 +
          Math.cos(x * 0.68 - z * 1.25) * 0.13) *
        mogulZone;
    }
  }

  // Secondary undulating sandy washboard pocket on the west dune flank (-16, 4)
  const wx = (x + 16.5) / 9.0;
  const wz = (z - 4.0) / 10.5;
  const wDistSq = wx * wx + wz * wz;
  if (wDistSq < 1.1025) {
    const washZone = 1.0 - terrainSmoothstep(0.55, 1.05, Math.sqrt(wDistSq));
    if (washZone > 1e-5) {
      offset +=
        (Math.sin(z * 1.35 + Math.sin(x * 0.6) * 0.9) * 0.17 +
          Math.cos(x * 1.05 + z * 0.72) * 0.11) *
        washZone;
    }
  }

  // Subtle organic micro-unevenness beyond central spawn (r > 12m) so dunes feel alive
  const distSq = x * x + z * z;
  if (distSq > 144.0) {
    const outerMicroMask = terrainSmoothstep(12.0, 22.0, Math.sqrt(distSq));
    if (outerMicroMask > 1e-5) {
      offset +=
        (Math.sin(x * 0.38 + z * 0.27) * 0.085 +
          Math.cos(x * 0.54 - z * 0.46) * 0.065) *
        outerMicroMask;
    }
  }

  return offset;
}

/**
 * Exact base height h(x, z) in meters.
 * Mirrored verbatim in `commonToroidal.ts` (GLSL `getBaseTerrainHeight(vec2 xz)`).
 */
export function sampleBaseTerrainHeight(x: number, z: number): number {
  // Primary sweeping erg dunes (low-frequency rolling waves)
  const d1 = Math.sin(x * 0.028 + z * 0.014) * 1.35;
  const d2 = Math.cos(x * 0.017 - z * 0.031 + 0.8) * 1.05;

  // Keep central spawn (<18m), Sprint corridor, and Climbable Rock / Mogul trail smooth & playable
  const distSq = x * x + z * z;
  const dist = Math.sqrt(distSq);
  let crestContribution = 0;
  if (dist > 18.0) {
    const rx = Math.max(0, Math.abs(x - 14.0) - 6.5);
    const rz = Math.max(0, Math.abs(z - 33.0) - 24.5);
    const trailSafe = terrainSmoothstep(1.0, 10.0, Math.hypot(rx, rz));
    const sprintRx = Math.max(0, Math.abs(x - 1.5) - 5.5);
    const sprintRz = Math.max(0, Math.abs(z + 4.0) - 20.0);
    const sprintSafe = terrainSmoothstep(0.5, 7.0, Math.hypot(sprintRx, sprintRz));
    const crestEnv = terrainSmoothstep(18.0, 38.0, dist) * trailSafe * sprintSafe;
    if (crestEnv > 1e-5) {
      // Wind-carved asymmetric barchan / star dune crests across the surrounding Sahara basin
      const phase1 = x * 0.036 + z * 0.024 + Math.sin(z * 0.017) * 1.85;
      const wave1 = Math.sin(phase1 + 0.36 * Math.sin(phase1));
      const barchan1 = (1.0 - Math.sqrt(wave1 * wave1 + 0.045)) * 2.75;

      const phase2 = x * 0.021 - z * 0.038 + Math.cos(x * 0.015) * 1.45;
      const wave2 = Math.sin(phase2 - 0.30 * Math.sin(phase2));
      const barchan2 = (1.0 - Math.sqrt(wave2 * wave2 + 0.065)) * 1.65;

      crestContribution = (barchan1 + barchan2) * crestEnv;
    }
  }

  const phaseBase = x * 0.052 + z * 0.044 + Math.sin(z * 0.022) * 1.4;
  const ridge = Math.pow(0.5 + 0.5 * Math.sin(phaseBase), 1.65) * 0.55;

  // Medium sand swells
  const swell = Math.sin(x * 0.11 - z * 0.085) * 0.14 + Math.cos(x * 0.09 + z * 0.12) * 0.11;

  // Gentle bowl-like outer dune rise beyond 55m radius to frame the horizon naturally
  let outerRise = 0;
  if (dist > 52.0) {
    const rimT = Math.min(1, (dist - 52.0) / 140.0);
    outerRise = rimT * rimT * (3.0 - 2.0 * rimT) * 11.5;
  }

  // Slight flattening right at the central 18m spawn basin so Foot IK & donuts read clearly
  const centerFlat = 0.55 + 0.45 * Math.min(1.0, dist / 24.0);

  return (
    (d1 + d2 + ridge + swell) * centerFlat +
    crestContribution +
    outerRise +
    sampleUnevenSandOffset(x, z)
  );
}

/**
 * Biome-aware terrain elevation: returns the crowned wet rural highway + potholes
 * for `rainy_highway`, and the Sahara erg / mud basin heightfield for `desert` & `mud_grass`.
 */
export function sampleTerrainHeightForBiome(
  x: number,
  z: number,
  biome: EnvironmentBiome = 'desert',
): number {
  if (biome === 'rainy_highway') {
    return sampleRainyHighwayHeight(x, z);
  }
  return sampleBaseTerrainHeight(x, z);
}

/**
 * Analytical / finite-difference height + unit surface normal for CPU grounding
 * (wheels, chassis suspension, Foot IK, and roost grain collisions).
 */
export function sampleBaseTerrain(
  x: number,
  z: number,
  eps = 0.25,
  biome: EnvironmentBiome = 'desert',
): TerrainSample {
  const hC = sampleTerrainHeightForBiome(x, z, biome);
  const hL = sampleTerrainHeightForBiome(x - eps, z, biome);
  const hR = sampleTerrainHeightForBiome(x + eps, z, biome);
  const hD = sampleTerrainHeightForBiome(x, z - eps, biome);
  const hU = sampleTerrainHeightForBiome(x, z + eps, biome);

  const dhdx = (hR - hL) / (2 * eps);
  const dhdz = (hU - hD) / (2 * eps);

  const nx = -dhdx;
  const ny = 1.0;
  const nz = -dhdz;
  const invLen = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);

  return {
    height: hC,
    normalX: nx * invLen,
    normalY: ny * invLen,
    normalZ: nz * invLen,
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Deterministic mud-vs-grass biome zone mask for the 'mud_grass' environment.
 * Returns [0..1]:
 *   0.0 = open sloppy mud track / rally basin (central clearing + winding muddy trails)
 *   1.0 = lush grassy meadow shoulder & wild grass islands
 * Mirrored verbatim in `commonToroidal.ts` (`getMudGrassZoneMask(vec2 xz)`).
 */
export function sampleMudGrassZoneMask(x: number, z: number): number {
  // Organic wavy clearing + two intersecting muddy rally trail corridors
  const meanderA = Math.sin(x * 0.065 + z * 0.025) * 3.8 + Math.cos(z * 0.11) * 1.4;
  const meanderB = Math.cos(z * 0.055 - x * 0.03) * 4.2 + Math.sin(x * 0.09) * 1.5;

  // Main central muddy crossing & circular drift basin around (-4..+4)
  const distCenter = Math.hypot(x + 1.5, z + 1.0);
  const centralClearing = 1.0 - smoothstep(5.5, 10.8, distCenter);

  // Winding mud trails cutting cleanly across the grassy meadow (matches crossing ruts + grass shoulder)
  const trailADist = Math.abs(z - meanderA * 0.72);
  const trailBDist = Math.abs(x - meanderB * 0.78);
  const trailA = 1.0 - smoothstep(3.1, 6.2, trailADist);
  const trailB = 1.0 - smoothstep(2.9, 6.0, trailBDist);

  // Subtle organic meadow edge breakup
  const edgeWave =
    Math.sin(x * 0.34 + z * 0.29) * 0.14 +
    Math.cos(x * 0.62 - z * 0.51) * 0.09;

  const mudOpen = Math.max(centralClearing, Math.max(trailA, trailB));
  const grass = smoothstep(0.18, 0.72, 1.0 - mudOpen + edgeWave);
  return Math.max(0, Math.min(1, grass));
}

/**
 * Subtle natural muddy depression factor [0..1] where shallow rainwater pools can collect
 * even before tires cut deep ruts, mirrored in GLSL `getMudHollowFactor(vec2 xz)`.
 */
export function sampleMudHollowFactor(x: number, z: number): number {
  const h = sampleBaseTerrainHeight(x, z);
  const lowBasin = 1.0 - smoothstep(0.0, 1.9, h);
  const warpX = x + Math.sin(z * 0.52 + 0.7) * 1.15 + Math.cos(z * 1.35) * 0.42;
  const warpZ = z + Math.cos(x * 0.47 - 0.5) * 1.15 + Math.sin(x * 1.28) * 0.42;
  const n1 = 0.5 + 0.5 * Math.sin(warpX * 0.52 + warpZ * 0.39 + 1.4);
  const n2 = 0.5 + 0.5 * Math.cos(warpX * 0.96 - warpZ * 0.81 + 0.3);
  const n3 = 0.5 + 0.5 * Math.sin(warpX * 2.15 + warpZ * 1.75);
  const n4 = 0.5 + 0.5 * Math.cos(warpX * 3.7 - warpZ * 3.1);
  const pocket = n1 * 0.42 + n2 * 0.30 + n3 * 0.18 + n4 * 0.10;
  return Math.max(0, Math.min(1, lowBasin * smoothstep(0.74, 0.91, pocket)));
}
