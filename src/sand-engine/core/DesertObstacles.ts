/**
 * DesertObstacles.ts
 * Deterministic Sahara sandstone rock outcrops, climbable articulated rock-garden slabs,
 * and smooth circle-vs-vehicle collision resolution (pure, engine-agnostic, zero Three.js imports).
 *
 * Two distinct geological layers:
 *  1. `CLIMBABLE_ROCK_SLABS`: Low-profile stratified sandstone ledges, stepped crawl ramps,
 *     and staggered cross-axle boulders right inside the proving basin so the 4x4 can physically
 *     drive OVER them, flexing its 4-corner suspension and showcasing 12 PSI vs 32 PSI tire grip.
 *     Both CPU wheel-grounding and 3D rock meshes evaluate the EXACT same analytical surface height!
 *  2. `DESERT_ROCK_OBSTACLES`: Larger perimeter sandstone outcrops framing the Sahara horizon
 *     with smooth elastic-damped bumper deflection.
 */

import { ScratchIndexList } from './BufferPool';
import { SpatialIndex2D, sortScratchIndicesAscending } from './SpatialIndex2D';

export interface DesertRockObstacle {
  x: number;
  z: number;
  /** Physical collision radius at ground level (meters) */
  radius: number;
  /** Visual horizontal scale multiplier */
  scaleXZ: number;
  /** Visual vertical scale multiplier */
  scaleY: number;
  /** Yaw rotation in radians */
  yaw: number;
  /** Palette index [0..3] */
  colorIndex: number;
  /** Optional precomputed world vertical bounds (meters) */
  yMin?: number;
  yMax?: number;
}

export interface RockCollisionOptions {
  /** Frame timestep in seconds for frame-rate independent contact scrape damping (defaults to 1/60) */
  dt?: number;
  /** Vehicle lowest world Y (meters); skips rock when airborne above rockYMax */
  vehicleMinY?: number;
  /** Vehicle highest world Y (meters); skips rock when strictly below rockYMin */
  vehicleMaxY?: number;
  /** Ground height sampler at rock (x, z) when obstacle lacks explicit yMin/yMax */
  sampleGroundY?: (x: number, z: number) => number;
}

export interface ClimbableRockSlab {
  id: string;
  x: number;
  z: number;
  /** Semi-axis length along rock local X (meters) */
  halfX: number;
  /** Semi-axis length along rock local Z (meters) */
  halfZ: number;
  /** Peak height above surrounding sand surface (meters, climbable 0.24..0.64m) */
  height: number;
  /** Yaw rotation in radians */
  yaw: number;
  /** Subtle rock surface crag seed */
  seed: number;
  /** Sandstone color palette index [0..3] */
  colorIndex: number;
}

export interface ClimbableRockSample {
  /** Final surface Y height (max of baseTerrainY and rock surface) */
  height: number;
  /** Height of rock above surrounding sand (0 if not on rock) */
  rockElevation: number;
  /** Smooth [0..1] rock contact mask (>0.35 means tire is on solid sandstone) */
  onRock: number;
}

export interface RockCollisionResult {
  collided: boolean;
  x: number;
  z: number;
  vx: number;
  vz: number;
  impactSpeed: number;
  normalX: number;
  normalZ: number;
  hitX: number;
  hitZ: number;
}

function makeSeededRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Generates the dedicated climbable Sahara sandstone rock-crawling & articulation course
 * plus several scattered low drive-over desert slabs.
 *
 * Course layout starts right at (14, 10) heading +Z through staggered left/right
 * cross-axle boulders, a stepped twin-tier sandstone ledge, and leads straight into
 * the uneven sandy mogul & washboard ridge around (14, 34..54)!
 */
export function generateClimbableRockCourse(): ClimbableRockSlab[] {
  return [
    // === SECTION 1: Staggered Cross-Axle Articulation Boulders (tests 4-corner flex!) ===
    // Entry left-wheel sandstone ramp
    { id: 'crawl_01_L', x: 12.6, z: 14.2, halfX: 2.05, halfZ: 2.35, height: 0.34, yaw: 0.18, seed: 1.3, colorIndex: 0 },
    // Staggered right-wheel sandstone boulder (opposite corner lift!)
    { id: 'crawl_02_R', x: 15.5, z: 17.6, halfX: 2.15, halfZ: 2.45, height: 0.44, yaw: -0.24, seed: 2.7, colorIndex: 1 },
    // Left-wheel higher shelf
    { id: 'crawl_03_L', x: 12.4, z: 21.2, halfX: 2.25, halfZ: 2.55, height: 0.50, yaw: 0.31, seed: 4.1, colorIndex: 2 },
    // Right-wheel stepped outcrop
    { id: 'crawl_04_R', x: 15.7, z: 24.4, halfX: 2.20, halfZ: 2.50, height: 0.42, yaw: -0.15, seed: 5.5, colorIndex: 3 },

    // === SECTION 2: Wide Stepped Sandstone Shelf (full 4-wheel climb + PSI grip test!) ===
    { id: 'shelf_base', x: 14.1, z: 29.5, halfX: 4.35, halfZ: 3.95, height: 0.38, yaw: 0.08, seed: 7.2, colorIndex: 1 },
    { id: 'shelf_upper', x: 14.3, z: 30.6, halfX: 2.85, halfZ: 2.35, height: 0.62, yaw: -0.12, seed: 8.9, colorIndex: 0 },

    // === SECTION 3: Exit Slanted Rock Ledge leading straight onto Uneven Sand Moguls ===
    { id: 'exit_L', x: 12.8, z: 35.4, halfX: 2.35, halfZ: 2.40, height: 0.36, yaw: 0.42, seed: 10.4, colorIndex: 2 },
    { id: 'exit_R', x: 16.0, z: 37.8, halfX: 2.25, halfZ: 2.30, height: 0.32, yaw: -0.35, seed: 12.1, colorIndex: 3 },

    // === SCATTERED LOW CLIMBABLE ROCK OUTCROPS AROUND THE MAIN BASIN ===
    // Visible ahead-left of default spawn so players can spontaneously climb rocks anywhere
    { id: 'basin_NW_1', x: -12.5, z: 12.8, halfX: 2.65, halfZ: 2.30, height: 0.36, yaw: 0.55, seed: 14.6, colorIndex: 0 },
    { id: 'basin_NW_2', x: -15.2, z: 15.6, halfX: 2.30, halfZ: 2.55, height: 0.48, yaw: -0.40, seed: 16.2, colorIndex: 2 },
    // Ahead-center-right low flat sandstone shelf
    { id: 'basin_NE_1', x: 8.8, z: 22.4, halfX: 2.50, halfZ: 2.15, height: 0.30, yaw: 0.28, seed: 18.4, colorIndex: 1 },
    // South-west climbable rock garden cluster
    { id: 'basin_SW_1', x: -16.8, z: -13.5, halfX: 2.85, halfZ: 2.45, height: 0.44, yaw: -0.62, seed: 20.1, colorIndex: 3 },
    { id: 'basin_SW_2', x: -13.6, z: -16.4, halfX: 2.25, halfZ: 2.40, height: 0.34, yaw: 0.35, seed: 22.8, colorIndex: 0 },
  ];
}

/** Cached climbable rock slabs shared identically by VehicleRig physics and DesertEnvironment meshes */
export const CLIMBABLE_ROCK_SLABS: readonly ClimbableRockSlab[] =
  generateClimbableRockCourse();

/**
 * Evaluates the exact analytical elevation above sand (meters) of a single climbable rock slab
 * at world coordinate (x, z). Shared identically between 3D mesh generation and CPU wheel grounding
 * so tires sit 100% flush on sandstone ledges with zero floating or clipping.
 */
export function evalSingleClimbableRockElevation(
  slab: ClimbableRockSlab,
  x: number,
  z: number,
): number {
  const dx = x - slab.x;
  const dz = z - slab.z;
  const c = Math.cos(-slab.yaw);
  const s = Math.sin(-slab.yaw);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;

  const nx = lx / slab.halfX;
  const nz = lz / slab.halfZ;
  const r2 = nx * nx + nz * nz;
  if (r2 >= 1.24) return 0;

  // Angular fractured desert sandstone footprint (blend Euclidean & superellipse + multi-harmonic rock facets)
  const rEuclid = Math.sqrt(r2);
  const rBox = Math.pow(Math.pow(Math.abs(nx), 3.2) + Math.pow(Math.abs(nz), 3.2), 1 / 3.2);
  const baseDist = rEuclid * 0.52 + rBox * 0.48;

  const ang = Math.atan2(nz, nx);
  // Smoothly envelope facetNoise to 0 before r2 = 1.24 so outer rock edges never form abrupt vertical steps
  const facetEnv = 1.0 - smoothstep(0.72, 1.18, r2);
  const facetNoise =
    (0.11 * Math.sin(ang * 3.0 + slab.seed) +
      0.075 * Math.cos(ang * 5.0 - slab.seed * 1.6) +
      0.045 * Math.sin(ang * 7.0 + slab.seed * 2.4)) *
    facetEnv;
  const r = baseDist - facetNoise;
  if (r >= 1.0) return 0;

  // Climbable beveled ramp flanks transitioning to terraced sedimentary tabletop
  const baseRamp = 1.0 - smoothstep(0.32, 0.99, Math.max(0, r));

  // Crisp 3-tier sedimentary sandstone bedding ledges along flanks (distinct visual rock strata!)
  const strataLevels = 3.0;
  const sVal = baseRamp * strataLevels;
  const sFloor = Math.floor(sVal);
  const sFrac = sVal - sFloor;
  const terraced = (sFloor + smoothstep(0.18, 0.82, sFrac)) / strataLevels;
  const steppedRamp = baseRamp * 0.58 + terraced * 0.42;

  // Natural fractured sandstone tabletop tilt & craggy rock face undulations
  const slabTilt = (nx * Math.cos(slab.seed) + nz * Math.sin(slab.seed)) * 0.08 * baseRamp;
  const cragRelief =
    (Math.sin(lx * 1.9 + slab.seed) * Math.cos(lz * 1.7 - slab.seed * 0.8) * 0.055 +
      Math.sin((lx * 2.7 - lz * 2.2) + slab.seed * 1.9) * 0.032 +
      Math.cos((lx * 4.1 + lz * 3.5) - slab.seed) * 0.016) *
    steppedRamp;

  return Math.max(0, slab.height * steppedRamp + slabTilt + cragRelief);
}

const CLIMBABLE_QUERY_SCRATCH = new ScratchIndexList(16);
const ROCK_QUERY_SCRATCH = new ScratchIndexList(16);

const climbableSlabIndexCache = new WeakMap<
  readonly ClimbableRockSlab[],
  { length: number; index: SpatialIndex2D<ClimbableRockSlab> }
>();

const rockObstacleIndexCache = new WeakMap<
  readonly DesertRockObstacle[],
  { length: number; index: SpatialIndex2D<DesertRockObstacle> }
>();

function writeClimbableSlabBounds(slab: ClimbableRockSlab, out4: Float64Array): void {
  const bound = Math.hypot(slab.halfX, slab.halfZ) * 1.25;
  out4[0] = slab.x - bound;
  out4[1] = slab.z - bound;
  out4[2] = slab.x + bound;
  out4[3] = slab.z + bound;
}

function writeRockObstacleBounds(obs: DesertRockObstacle, out4: Float64Array): void {
  const r = obs.radius;
  out4[0] = obs.x - r;
  out4[1] = obs.z - r;
  out4[2] = obs.x + r;
  out4[3] = obs.z + r;
}

function getClimbableSlabIndex(
  slabs: readonly ClimbableRockSlab[],
): SpatialIndex2D<ClimbableRockSlab> {
  const cached = climbableSlabIndexCache.get(slabs);
  if (cached && cached.length === slabs.length) {
    return cached.index;
  }
  const index = cached?.index ?? new SpatialIndex2D<ClimbableRockSlab>();
  index.build(slabs, writeClimbableSlabBounds, 8);
  climbableSlabIndexCache.set(slabs, { length: slabs.length, index });
  return index;
}

function getRockObstacleIndex(
  obstacles: readonly DesertRockObstacle[],
): SpatialIndex2D<DesertRockObstacle> {
  const cached = rockObstacleIndexCache.get(obstacles);
  if (cached && cached.length === obstacles.length) {
    return cached.index;
  }
  const index = cached?.index ?? new SpatialIndex2D<DesertRockObstacle>();
  index.build(obstacles, writeRockObstacleBounds, 8);
  rockObstacleIndexCache.set(obstacles, { length: obstacles.length, index });
  return index;
}

/**
 * Zero-allocation variant of `sampleClimbableRockSurface` using the Flatbush spatial index.
 */
export function sampleClimbableRockSurfaceInto(
  x: number,
  z: number,
  baseTerrainY: number,
  slabs: readonly ClimbableRockSlab[] = CLIMBABLE_ROCK_SLABS,
  out: ClimbableRockSample,
): ClimbableRockSample {
  let maxRockElev = 0;
  if (slabs.length > 0) {
    const index = getClimbableSlabIndex(slabs);
    index.queryBoxInto(x, z, x, z, CLIMBABLE_QUERY_SCRATCH);
    const hits = CLIMBABLE_QUERY_SCRATCH.data;
    const hitCount = CLIMBABLE_QUERY_SCRATCH.length;
    for (let q = 0; q < hitCount; q++) {
      const slab = slabs[hits[q]];
      const elev = evalSingleClimbableRockElevation(slab, x, z);
      if (elev > maxRockElev) {
        maxRockElev = elev;
      }
    }
  }

  out.height = baseTerrainY + maxRockElev;
  out.rockElevation = maxRockElev;
  out.onRock = smoothstep(0.035, 0.12, maxRockElev);
  return out;
}

/**
 * Samples the combined climbable rock surface at world (x, z).
 * Returns the maximum surface height above baseTerrainY and a smooth [0..1] rock contact mask.
 */
export function sampleClimbableRockSurface(
  x: number,
  z: number,
  baseTerrainY: number,
  slabs: readonly ClimbableRockSlab[] = CLIMBABLE_ROCK_SLABS,
): ClimbableRockSample {
  return sampleClimbableRockSurfaceInto(x, z, baseTerrainY, slabs, {
    height: baseTerrainY,
    rockElevation: 0,
    onRock: 0,
  });
}

/**
 * Generates deterministic weathered Sahara sandstone perimeter outcrops around the proving ground.
 * Keeps the central proving corridor (r < 17.5 m), the Sprint straight corridor,
 * AND the Climbable Rock & Uneven Sand Articulation Trail (x ∈ [8, 22], z ∈ [8, 56]) completely clear.
 */
export function generateDesertRockObstacles(count = 26): DesertRockObstacle[] {
  const rand = makeSeededRng(202607);
  const rocks: DesertRockObstacle[] = [];

  for (let i = 0; i < count; i++) {
    // Golden-angle spiral distribution with organic radial bands (20m .. 82m)
    const goldenAng = i * 2.3999632 + (rand() - 0.5) * 0.24;
    const band = i % 3;
    const baseDist =
      band === 0
        ? 20.5 + rand() * 13.0
        : band === 1
          ? 35.0 + rand() * 19.0
          : 54.0 + rand() * 28.0;

    let x = Math.cos(goldenAng) * baseDist;
    let z = Math.sin(goldenAng) * baseDist;

    // Keep the Sprint 150 km/h launch corridor near x ∈ [-4, 6], z ∈ [-24, 16] clear
    if (Math.abs(x - 1.5) < 5.5 && z > -26 && z < 16) {
      x += x >= 1.5 ? 7.5 : -7.5;
    }

    // Keep the Climbable Rock & Uneven Sand Articulation Course (x ∈ [7, 22], z ∈ [6, 58]) clear
    if (x > 6.5 && x < 22.5 && z > 6.0 && z < 58.0) {
      x = x < 14.5 ? 4.5 - rand() * 4.0 : 25.0 + rand() * 5.0;
    }

    // Keep scattered basin climbable rocks clear of perimeter blocker rocks
    let overlapsClimbable = false;
    for (let k = 0; k < CLIMBABLE_ROCK_SLABS.length; k++) {
      const s = CLIMBABLE_ROCK_SLABS[k];
      if (Math.hypot(x - s.x, z - s.z) < Math.max(s.halfX, s.halfZ) + 4.2) {
        overlapsClimbable = true;
        break;
      }
    }
    if (overlapsClimbable) {
      x *= 1.38;
      z *= 1.38;
    }

    const scaleXZ = 1.15 + rand() * 1.65;
    const scaleY = 0.65 + rand() * 0.95;
    const radius = scaleXZ * 0.92;

    rocks.push({
      x,
      z,
      radius,
      scaleXZ,
      scaleY,
      yaw: rand() * Math.PI * 2,
      colorIndex: i % 4,
    });
  }

  return rocks;
}

/** Cached default desert rock layout shared between DesertEnvironment and VehicleRig */
export const DESERT_ROCK_OBSTACLES: readonly DesertRockObstacle[] =
  generateDesertRockObstacles(26);

/**
 * Zero-allocation variant of `resolveRockCollisions` accelerated via Flatbush 2D spatial index.
 */
export function resolveRockCollisionsInto(
  x: number,
  z: number,
  vx: number,
  vz: number,
  vehicleRadius: number,
  obstacles: readonly DesertRockObstacle[],
  options: RockCollisionOptions | undefined,
  out: RockCollisionResult,
): RockCollisionResult {
  let outX = x;
  let outZ = z;
  let outVx = vx;
  let outVz = vz;
  let collided = false;
  let maxImpact = 0;
  let bestNx = 0;
  let bestNz = 0;
  let bestHitX = x;
  let bestHitZ = z;

  if (obstacles.length > 0) {
    const dt = Math.max(0.001, options?.dt ?? 1 / 60);
    const scrapeDamp = Math.pow(0.88, dt * 60);
    const checkVertical =
      options?.vehicleMinY !== undefined && options?.vehicleMaxY !== undefined;

    const index = getRockObstacleIndex(obstacles);
    const searchPad = vehicleRadius + 1.5;
    index.queryBoxInto(
      x - searchPad,
      z - searchPad,
      x + searchPad,
      z + searchPad,
      ROCK_QUERY_SCRATCH,
    );
    sortScratchIndicesAscending(ROCK_QUERY_SCRATCH);

    const hits = ROCK_QUERY_SCRATCH.data;
    const hitCount = ROCK_QUERY_SCRATCH.length;
    for (let q = 0; q < hitCount; q++) {
      const obs = obstacles[hits[q]];
      const minDist = vehicleRadius + obs.radius;
      const dx = outX - obs.x;
      const dz = outZ - obs.z;
      const distSq = dx * dx + dz * dz;

      if (distSq < minDist * minDist) {
        if (checkVertical) {
          const baseY =
            obs.yMin !== undefined && obs.yMax !== undefined
              ? 0
              : options?.sampleGroundY
                ? options.sampleGroundY(obs.x, obs.z)
                : 0;
          const rockYMin = obs.yMin ?? baseY - obs.scaleY * 0.9;
          const rockYMax = obs.yMax ?? baseY + obs.scaleY * 0.85;
          if (options!.vehicleMinY! > rockYMax || options!.vehicleMaxY! < rockYMin) {
            continue;
          }
        }

        const dist = Math.sqrt(distSq);
        const nx = dist > 1e-5 ? dx / dist : 1.0;
        const nz = dist > 1e-5 ? dz / dist : 0.0;
        const pen = minDist - dist;

        outX += nx * pen;
        outZ += nz * pen;
        collided = true;

        const vn = outVx * nx + outVz * nz;
        if (vn < 0) {
          const imp = -vn;
          if (imp >= maxImpact) {
            maxImpact = imp;
            bestNx = nx;
            bestNz = nz;
            bestHitX = obs.x + nx * obs.radius;
            bestHitZ = obs.z + nz * obs.radius;
          }
          const restitution = 0.28;
          outVx -= (1 + restitution) * vn * nx;
          outVz -= (1 + restitution) * vn * nz;
          outVx *= scrapeDamp;
          outVz *= scrapeDamp;
        }
      }
    }
  }

  out.collided = collided;
  out.x = outX;
  out.z = outZ;
  out.vx = outVx;
  out.vz = outVz;
  out.impactSpeed = maxImpact;
  out.normalX = bestNx;
  out.normalZ = bestNz;
  out.hitX = bestHitX;
  out.hitZ = bestHitZ;
  return out;
}

/**
 * Resolves smooth elastic-damped 3D-bounded cylinder collision between the heavy 4x4 chassis
 * and tall Sahara sandstone outcrops, checking vertical clearance (yMin/yMax) and applying
 * frame-rate independent scrape damping while preserving tangential slide momentum.
 */
export function resolveRockCollisions(
  x: number,
  z: number,
  vx: number,
  vz: number,
  vehicleRadius: number,
  obstacles: readonly DesertRockObstacle[],
  options?: RockCollisionOptions,
): RockCollisionResult {
  return resolveRockCollisionsInto(x, z, vx, vz, vehicleRadius, obstacles, options, {
    collided: false,
    x,
    z,
    vx,
    vz,
    impactSpeed: 0,
    normalX: 0,
    normalZ: 0,
    hitX: x,
    hitZ: z,
  });
}
