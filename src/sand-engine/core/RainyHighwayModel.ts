/**
 * RainyHighwayModel.ts
 * Pure, engine-agnostic analytical model for the Rainy Rural Highway biome (`rainy_highway`),
 * mirrored identically between CPU wheel/suspension/collision physics and GLSL shaders.
 *
 * Coordinate convention:
 *  - Road centerline runs along X = 0, extending infinitely along +Z / -Z.
 *  - Asphalt carriageway: |x| <= 3.55 m (two rural lanes, white edge lines at |x| = 3.22 m).
 *  - Gravel / muddy shoulder: 3.55 m < |x| <= 5.20 m.
 *  - Shallow drainage swale + dry pale roadside grass paddock: |x| > 5.20 m.
 *  - Left shoulder (-X? Note: when facing +Z in right-handed Three.js, +X is LEFT of driver!).
 *    Wait: cross(fwd=(0,0,1), up=(0,1,0)) = (-1,0,0) = RIGHT! So +X is LEFT, -X is RIGHT!
 *    Therefore:
 *      - Driver sits at +X (left side of cabin, US/BR LHD).
 *      - Left side of road (overhanging eucalyptus trees in Image 1) is +X (x = +5.8 .. +13 m).
 *      - Right side of road (utility poles & wires in Image 1) is -X (x = -6.8 m).
 */

export const HIGHWAY_CONSTANTS = {
  /** Half-width of paved asphalt surface (total width 7.1 m) */
  ROAD_HALF_WIDTH: 3.55,
  /** Edge white line center X offset */
  EDGE_LINE_X: 3.22,
  /** Outer limit of muddy/gravel shoulder before roadside grass */
  SHOULDER_OUTER_X: 5.15,
  /** Repeating corridor tile length for infinite driving along Z */
  CORRIDOR_TILE_LENGTH: 160.0,
  /** Left-side fence X (+X is left when heading +Z) */
  FENCE_LEFT_X: 11.4,
  /** Right-side fence X (-X is right when heading +Z) */
  FENCE_RIGHT_X: -11.4,
  /** Right-side utility pole X */
  POLE_RIGHT_X: -6.8,
} as const;

export interface HighwayPotholeSample {
  /** Depression depth in meters (>= 0, up to ~0.11 m for sharp deep potholes) */
  depthM: number;
  /** Normalized pothole interior mask [0..1] */
  mask01: number;
  /** Cracked broken asphalt rim around pothole [0..1] */
  crackRim01: number;
  /** Water puddle standing depth [0..1] */
  waterFill01: number;
}

export interface HighwayObstacle {
  id: string;
  kind: 'eucalyptus' | 'utility_pole' | 'fence_post';
  x: number;
  z: number;
  radius: number;
  breakable: boolean;
}

export interface HighwayObstacleHit {
  hit: boolean;
  obstacle: HighwayObstacle | null;
  pushX: number;
  pushZ: number;
  normalX: number;
  normalZ: number;
  penetration: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function fract(x: number): number {
  return x - Math.floor(x);
}

function hash21(px: number, py: number): number {
  const h = Math.sin(px * 127.1 + py * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

const POTHOLE_HEIGHT_SCRATCH: HighwayPotholeSample = {
  depthM: 0,
  mask01: 0,
  crackRim01: 0,
  waterFill01: 0,
};

/**
 * Deterministic pothole & broken-asphalt cluster field along the rural highway (zero-alloc `*Into` variant).
 * Mirrored identically in GLSL `sampleHighwayPothole(vec2 xz)` so CPU wheel hits
 * line up millimeter-for-millimeter with rendered water-filled potholes!
 */
export function sampleHighwayPotholeInto(
  x: number,
  z: number,
  out: HighwayPotholeSample,
): HighwayPotholeSample {
  const absX = Math.abs(x);
  if (absX > HIGHWAY_CONSTANTS.ROAD_HALF_WIDTH + 0.35) {
    out.depthM = 0;
    out.mask01 = 0;
    out.crackRim01 = 0;
    out.waterFill01 = 0;
    return out;
  }

  let bestMask = 0;
  let bestDepth = 0;
  let bestRim = 0;

  // Evaluate 2 staggered deterministic cell lattices along Z so potholes form natural clusters
  // Cell lattice A: larger broken edge / wheel-track potholes (especially right lane -X like Image 2)
  const cellLenA = 9.5;
  const cellIdxA = Math.floor(z / cellLenA);
  for (let dz = -1; dz <= 1; dz++) {
    const ci = cellIdxA + dz;
    const r0 = hash21(ci * 1.37, 11.4);
    if (r0 < 0.22) continue;

    const r1 = hash21(ci * 2.13, 27.9);
    const r2 = hash21(ci * 3.71, 5.2);
    const r3 = hash21(ci * 5.19, 19.8);

    // Bias ~68% to right lane / edge (-X in +Z heading) and ~32% to left lane (+X), matching Image 2!
    const onRightSide = r1 < 0.68;
    const cx = onRightSide
      ? -(0.75 + r2 * 2.35)
      : 0.65 + r2 * 2.15;
    const cz = (ci + 0.18 + r3 * 0.64) * cellLenA;
    if (Math.abs(cz) < 4.2) continue;

    const rx = 0.34 + hash21(ci, 41.3) * 0.42;
    const rz = 0.55 + hash21(ci, 63.7) * 0.95;

    // Fast AABB rejection before expensive atan2/sin/cos/hypot (max jag = 1.30, max normDist = 1.55 -> 2.02*r)
    const dx = x - cx;
    const dzLocal = z - cz;
    if (Math.abs(dx) > rx * 2.05 || Math.abs(dzLocal) > rz * 2.05) continue;

    const angle = Math.atan2(dzLocal, dx);
    const jag =
      1.0 +
      0.19 * Math.sin(angle * 3.0 + ci * 1.7) +
      0.11 * Math.cos(angle * 5.0 - ci * 2.3);
    const invJag = 1.0 / jag;
    const normDist = Math.hypot((dx * invJag) / rx, (dzLocal * invJag) / rz);

    if (normDist < 1.55) {
      const m = 1.0 - smoothstep(0.45, 1.0, normDist);
      const rim = smoothstep(0.75, 1.02, normDist) * (1.0 - smoothstep(1.02, 1.48, normDist));
      const d = m * (0.062 + 0.044 * hash21(ci, 88.1));
      if (m > bestMask) bestMask = m;
      if (d > bestDepth) bestDepth = d;
      if (rim > bestRim) bestRim = rim;
    }
  }

  // Cell lattice B: secondary smaller satellite cracks & shallow wheel-rut depressions
  const cellLenB = 5.4;
  const cellIdxB = Math.floor(z / cellLenB);
  for (let dz = -1; dz <= 1; dz++) {
    const ci = cellIdxB + dz;
    const r0 = hash21(ci * 4.17, 73.1);
    if (r0 < 0.42) continue;
    const r1 = hash21(ci * 1.93, 91.5);
    const r2 = hash21(ci * 3.11, 14.6);
    const cx = (r1 * 2 - 1) * 2.95;
    const cz = (ci + 0.15 + r2 * 0.70) * cellLenB;
    if (Math.abs(cz) < 3.8) continue;

    const rx = 0.22 + hash21(ci, 52.4) * 0.28;
    const rz = 0.34 + hash21(ci, 31.8) * 0.48;
    const dx = x - cx;
    const dzLocal = z - cz;
    if (Math.abs(dx) > rx * 1.72 || Math.abs(dzLocal) > rz * 1.72) continue;

    const angle = Math.atan2(dzLocal, dx);
    const jag = 1.0 + 0.16 * Math.sin(angle * 4.0 + ci * 2.9);
    const invJag = 1.0 / jag;
    const normDist = Math.hypot((dx * invJag) / rx, (dzLocal * invJag) / rz);
    if (normDist < 1.45) {
      const m = 1.0 - smoothstep(0.42, 1.0, normDist);
      const rim = smoothstep(0.76, 1.02, normDist) * (1.0 - smoothstep(1.02, 1.42, normDist));
      const d = m * 0.046;
      if (m * 0.85 > bestMask) bestMask = m * 0.85;
      if (d > bestDepth) bestDepth = d;
      if (rim * 0.85 > bestRim) bestRim = rim * 0.85;
    }
  }

  const onRoad = 1.0 - smoothstep(HIGHWAY_CONSTANTS.ROAD_HALF_WIDTH - 0.1, HIGHWAY_CONSTANTS.ROAD_HALF_WIDTH + 0.3, absX);
  const mask01 = clamp01(bestMask * onRoad);
  out.mask01 = mask01;
  out.depthM = bestDepth * onRoad;
  out.crackRim01 = clamp01(bestRim * onRoad);
  out.waterFill01 = clamp01(smoothstep(0.22, 0.72, mask01));
  return out;
}

export function sampleHighwayPothole(x: number, z: number): HighwayPotholeSample {
  return sampleHighwayPotholeInto(x, z, {
    depthM: 0,
    mask01: 0,
    crackRim01: 0,
    waterFill01: 0,
  });
}

/**
 * Exact analytical base terrain elevation for the Rainy Rural Highway (`rainy_highway`).
 * Mirrored verbatim in GLSL `getRainyHighwayHeight(vec2 xz)` so truck tires, road, shoulders,
 * roadside drainage ditches, and flat rural pasture align with zero floating or clipping.
 */
export function sampleRainyHighwayHeight(x: number, z: number): number {
  const absX = Math.abs(x);

  // Subtle realistic rural highway longitudinal grade (gentle low rolling plains)
  const grade =
    Math.sin(z * 0.011) * 0.36 +
    Math.cos(z * 0.0055 + 0.9) * 0.24;

  // Classic crowned asphalt profile (+0.055m at centerline draining gently toward edges)
  const roadCrown = (1.0 - smoothstep(0.0, HIGHWAY_CONSTANTS.ROAD_HALF_WIDTH, absX)) * 0.055;

  // Shallow roadside earth/grass drainage swale at |x| = 5.2..9.5m, rising slightly to flat paddock
  const swaleCenter = (absX - 6.8) / 2.2;
  const swale = -0.22 * Math.exp(-swaleCenter * swaleCenter);

  // Subtle natural rural field micro-undulation outside the highway shoulders
  const fieldMask = smoothstep(HIGHWAY_CONSTANTS.SHOULDER_OUTER_X, 11.0, absX);
  const paddockWave =
    (Math.sin(x * 0.045 + z * 0.022) * 0.28 +
      Math.cos(x * 0.028 - z * 0.036) * 0.22) *
    fieldMask;

  // Physical pothole depression in asphalt (felt directly by all 4 independent suspension springs!)
  const pothole = sampleHighwayPotholeInto(x, z, POTHOLE_HEIGHT_SCRATCH);

  return grade + roadCrown + swale + paddockWave - pothole.depthM;
}

/**
 * Generates deterministic solid roadside obstacles (eucalyptus trunks on +X left shoulder,
 * utility poles on -X right shoulder, and fence posts on both sides) for a Z interval around
 * the vehicle. Mirrors the exact positions placed in `RainyHighwayEnvironment.ts`!
 */
export function getRainyHighwayObstaclesNear(zCenter: number, halfSpan = 48): HighwayObstacle[] {
  const out: HighwayObstacle[] = [];
  const zMin = zCenter - halfSpan;
  const zMax = zCenter + halfSpan;

  // 1. Tall Eucalyptus trees lining left side (+X) — staggered natural grove matching Images 1 & 3
  const treeSpacing = 12.5;
  const iStartT = Math.floor(zMin / treeSpacing);
  const iEndT = Math.ceil(zMax / treeSpacing);
  for (let i = iStartT; i <= iEndT; i++) {
    const rSkip = hash21(i * 1.73, 3.1);
    if (rSkip < 0.14) continue; // occasional natural clearing gap
    const rX = hash21(i * 2.41, 17.3);
    const rZ = hash21(i * 3.19, 29.7);
    const tx = 6.1 + rX * 3.8; // +X = left side of highway when driving +Z
    const tz = i * treeSpacing + (rZ - 0.5) * 4.4;
    const rad = 0.42 + hash21(i * 5.07, 41.2) * 0.22;
    out.push({
      id: `euc_${i}`,
      kind: 'eucalyptus',
      x: tx,
      z: tz,
      radius: rad,
      breakable: false,
    });
  }

  // 2. Utility poles along right side (-X) every 36m (matching Image 1 right shoulder)
  const poleSpacing = 36.0;
  const iStartP = Math.floor(zMin / poleSpacing);
  const iEndP = Math.ceil(zMax / poleSpacing);
  for (let i = iStartP; i <= iEndP; i++) {
    const pz = i * poleSpacing + 14.0;
    out.push({
      id: `pole_${i}`,
      kind: 'utility_pole',
      x: HIGHWAY_CONSTANTS.POLE_RIGHT_X,
      z: pz,
      radius: 0.24,
      breakable: false,
    });
  }

  // 3. Wooden fence posts along left and right paddock borders (x = +-11.4m every 7.5m)
  const postSpacing = 7.5;
  const iStartF = Math.floor(zMin / postSpacing);
  const iEndF = Math.ceil(zMax / postSpacing);
  for (let i = iStartF; i <= iEndF; i++) {
    const fz = i * postSpacing;
    out.push({
      id: `fenceL_${i}`,
      kind: 'fence_post',
      x: HIGHWAY_CONSTANTS.FENCE_LEFT_X,
      z: fz,
      radius: 0.14,
      breakable: true,
    });
    out.push({
      id: `fenceR_${i}`,
      kind: 'fence_post',
      x: HIGHWAY_CONSTANTS.FENCE_RIGHT_X,
      z: fz,
      radius: 0.14,
      breakable: true,
    });
  }

  return out;
}

/**
 * Resolves vehicle-vs-roadside-obstacle collision (eucalyptus trunks, utility poles, fence posts)
 * in XZ plane. Returns push-out vector, normal, and hit obstacle metadata for damage & audio!
 */
const NO_HIGHWAY_HIT: HighwayObstacleHit = {
  hit: false,
  obstacle: null,
  pushX: 0,
  pushZ: 0,
  normalX: 0,
  normalZ: 1,
  penetration: 0,
};

const CAPSULE_PROBE_Z: readonly number[] = [1.52, 0.0, -1.52];
const CAPSULE_PROBE_R: readonly number[] = [1.12, 1.15, 1.12];

/**
 * Zero-allocation analytical roadside obstacle test for a single sphere (vehX, vehZ, vehRadius).
 * Only constructs a HighwayObstacle object/id string when an actual penetration occurs!
 */
export function resolveHighwayObstacleCollisions(
  vehX: number,
  vehZ: number,
  vehRadius: number,
  brokenFenceIds?: ReadonlySet<string>,
): HighwayObstacleHit {
  // Fast lane corridor skip: no roadside obstacles exist within |x| < 5.4 - vehRadius
  if (Math.abs(vehX) < 5.3 - vehRadius) {
    return NO_HIGHWAY_HIT;
  }

  let bestPen = 0;
  let bestKind: HighwayObstacle['kind'] | null = null;
  let bestIdx = 0;
  let bestSideLeft = true;
  let bestObsX = 0;
  let bestObsZ = 0;
  let bestObsR = 0;
  let bestNx = 0;
  let bestNz = 1;

  // 1. Eucalyptus trunks on +X left shoulder (x in [6.1..9.9])
  if (vehX > 5.2 - vehRadius && vehX < 10.7 + vehRadius) {
    const treeSpacing = 12.5;
    const iStart = Math.floor((vehZ - 6.0 - vehRadius) / treeSpacing);
    const iEnd = Math.ceil((vehZ + 6.0 + vehRadius) / treeSpacing);
    for (let i = iStart; i <= iEnd; i++) {
      if (hash21(i * 1.73, 3.1) < 0.14) continue;
      const tx = 6.1 + hash21(i * 2.41, 17.3) * 3.8;
      const tz = i * treeSpacing + (hash21(i * 3.19, 29.7) - 0.5) * 4.4;
      const rad = 0.42 + hash21(i * 5.07, 41.2) * 0.22;
      const dx = vehX - tx;
      const dz = vehZ - tz;
      const minDist = vehRadius + rad;
      const distSq = dx * dx + dz * dz;
      if (distSq < minDist * minDist) {
        const dist = Math.sqrt(Math.max(1e-6, distSq));
        const pen = minDist - dist;
        if (pen > bestPen) {
          bestPen = pen;
          bestKind = 'eucalyptus';
          bestIdx = i;
          bestObsX = tx;
          bestObsZ = tz;
          bestObsR = rad;
          bestNx = dx / dist;
          bestNz = dz / dist;
        }
      }
    }
  }

  // 2. Utility poles on -X right shoulder (x = POLE_RIGHT_X)
  const poleX = HIGHWAY_CONSTANTS.POLE_RIGHT_X;
  const poleMinDist = vehRadius + 0.24;
  if (Math.abs(vehX - poleX) < poleMinDist) {
    const poleSpacing = 36.0;
    const iStart = Math.floor((vehZ - 14.0 - poleMinDist) / poleSpacing);
    const iEnd = Math.ceil((vehZ - 14.0 + poleMinDist) / poleSpacing);
    const minDistSq = poleMinDist * poleMinDist;
    for (let i = iStart; i <= iEnd; i++) {
      const pz = i * poleSpacing + 14.0;
      const dx = vehX - poleX;
      const dz = vehZ - pz;
      const distSq = dx * dx + dz * dz;
      if (distSq < minDistSq) {
        const dist = Math.sqrt(Math.max(1e-6, distSq));
        const pen = poleMinDist - dist;
        if (pen > bestPen) {
          bestPen = pen;
          bestKind = 'utility_pole';
          bestIdx = i;
          bestObsX = poleX;
          bestObsZ = pz;
          bestObsR = 0.24;
          bestNx = dx / dist;
          bestNz = dz / dist;
        }
      }
    }
  }

  // 3. Wooden fence posts along left and right paddock borders (x = +-11.4m every 7.5m)
  const fenceMinDist = vehRadius + 0.14;
  const nearLeftFence = Math.abs(vehX - HIGHWAY_CONSTANTS.FENCE_LEFT_X) < fenceMinDist;
  const nearRightFence = Math.abs(vehX - HIGHWAY_CONSTANTS.FENCE_RIGHT_X) < fenceMinDist;
  if (nearLeftFence || nearRightFence) {
    const postSpacing = 7.5;
    const iStart = Math.floor((vehZ - fenceMinDist) / postSpacing);
    const iEnd = Math.ceil((vehZ + fenceMinDist) / postSpacing);
    const minDistSq = fenceMinDist * fenceMinDist;
    const fx = nearLeftFence ? HIGHWAY_CONSTANTS.FENCE_LEFT_X : HIGHWAY_CONSTANTS.FENCE_RIGHT_X;
    const isLeft = nearLeftFence;
    for (let i = iStart; i <= iEnd; i++) {
      const fz = i * postSpacing;
      const dx = vehX - fx;
      const dz = vehZ - fz;
      const distSq = dx * dx + dz * dz;
      if (distSq < minDistSq) {
        const id = isLeft ? `fenceL_${i}` : `fenceR_${i}`;
        if (brokenFenceIds && brokenFenceIds.has(id)) continue;
        const dist = Math.sqrt(Math.max(1e-6, distSq));
        const pen = fenceMinDist - dist;
        if (pen > bestPen) {
          bestPen = pen;
          bestKind = 'fence_post';
          bestIdx = i;
          bestSideLeft = isLeft;
          bestObsX = fx;
          bestObsZ = fz;
          bestObsR = 0.14;
          bestNx = dx / dist;
          bestNz = dz / dist;
        }
      }
    }
  }

  if (!bestKind || bestPen <= 0) {
    return NO_HIGHWAY_HIT;
  }

  const breakable = bestKind === 'fence_post';
  const id =
    bestKind === 'eucalyptus'
      ? `euc_${bestIdx}`
      : bestKind === 'utility_pole'
        ? `pole_${bestIdx}`
        : bestSideLeft
          ? `fenceL_${bestIdx}`
          : `fenceR_${bestIdx}`;
  const pushScale = breakable ? 0.25 : 1.0;

  return {
    hit: true,
    obstacle: {
      id,
      kind: bestKind,
      x: bestObsX,
      z: bestObsZ,
      radius: bestObsR,
      breakable,
    },
    pushX: bestNx * bestPen * pushScale,
    pushZ: bestNz * bestPen * pushScale,
    normalX: bestNx,
    normalZ: bestNz,
    penetration: bestPen,
  };
}

/**
 * 3-sphere vehicle hull collision (front bumper/hood, cab center, rear bed) against roadside
 * eucalyptus trunks, utility poles, and breakable fence posts so front-end crashes trigger at
 * the true bumper surface with zero hood clipping — zero per-frame allocations!
 */
export function resolveVehicleCapsuleHighwayCollision(
  vehX: number,
  vehZ: number,
  headingRad: number,
  brokenFenceIds?: ReadonlySet<string>,
): HighwayObstacleHit {
  // Fast asphalt center rejection: if vehicle center is well inside road lanes, no probe can reach shoulder obstacles
  if (Math.abs(vehX) < 2.55) {
    return NO_HIGHWAY_HIT;
  }

  const sinH = Math.sin(headingRad);
  const cosH = Math.cos(headingRad);
  let bestHit: HighwayObstacleHit = NO_HIGHWAY_HIT;

  for (let i = 0; i < 3; i++) {
    const zOff = CAPSULE_PROBE_Z[i];
    const radius = CAPSULE_PROBE_R[i];
    const px = vehX + sinH * zOff;
    const pz = vehZ + cosH * zOff;
    const h = resolveHighwayObstacleCollisions(px, pz, radius, brokenFenceIds);
    if (h.hit && h.penetration > bestHit.penetration) {
      bestHit = h;
    }
  }
  return bestHit;
}

/** Helper exported for deterministic unit tests */
export function isOnPavedHighway(x: number): boolean {
  return Math.abs(x) <= HIGHWAY_CONSTANTS.ROAD_HALF_WIDTH;
}

export interface WetHighwayGripResult {
  lateralGripScale: number;
  rollingDragScale: number;
  inPotholeWater: boolean;
}

const GRIP_POTHOLE_SCRATCH: HighwayPotholeSample = {
  depthM: 0,
  mask01: 0,
  crackRim01: 0,
  waterFill01: 0,
};

/** Zero-allocation wet highway grip & aquaplaning evaluator (`*Into` variant). */
export function computeWetHighwayGripInto(
  x: number,
  z: number,
  speedMs: number,
  rainIntensity: number,
  out: WetHighwayGripResult,
): WetHighwayGripResult {
  const absX = Math.abs(x);
  if (absX <= HIGHWAY_CONSTANTS.ROAD_HALF_WIDTH) {
    const pothole = sampleHighwayPotholeInto(x, z, GRIP_POTHOLE_SCRATCH);
    const speedNorm = clamp01((Math.abs(speedMs) - 10) / 26);
    const aquaDrop = (0.14 + pothole.waterFill01 * 0.28) * speedNorm * clamp01(rainIntensity);
    out.lateralGripScale = Math.max(0.45, 0.92 - aquaDrop);
    out.rollingDragScale = 0.34 + pothole.waterFill01 * 0.45;
    out.inPotholeWater = pothole.waterFill01 > 0.35;
    return out;
  }
  if (absX <= HIGHWAY_CONSTANTS.SHOULDER_OUTER_X) {
    out.lateralGripScale = 0.66;
    out.rollingDragScale = 0.78;
    out.inPotholeWater = false;
    return out;
  }
  out.lateralGripScale = 0.58;
  out.rollingDragScale = 0.95;
  out.inPotholeWater = false;
  return out;
}

/** Deterministic road-surface friction & aquaplaning grip factor on wet rural highway */
export function computeWetHighwayGrip(
  x: number,
  z: number,
  speedMs: number,
  rainIntensity: number,
): WetHighwayGripResult {
  return computeWetHighwayGripInto(x, z, speedMs, rainIntensity, {
    lateralGripScale: 0.92,
    rollingDragScale: 0.34,
    inPotholeWater: false,
  });
}

export { fract };
