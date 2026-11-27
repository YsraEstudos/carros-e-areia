/**
 * ReflectionRayMath.ts
 * Pure, engine-independent physical math for lightweight pseudo-ray-traced
 * automotive reflections:
 *  - Asymmetric world-space biome reflection proxy bounds anchored flush to the real ground plane
 *  - Analytical ray-AABB slab intersection for exact Parallax-Corrected Cubemap (PCC) projection
 *  - Contact-hardening distance-proportional roughness cone-traced mipmap selection
 *  - Sébastien Lagarde's physically based specular occlusion
 *  - Analytical vehicle-body OBB & underbody self-reflection occlusion
 *  - Exact dielectric Schlick Fresnel (clearcoat IOR 1.5, automotive glass IOR 1.52)
 */

import { EnvironmentBiome } from './SandParams';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface BiomeReflectionBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  probeCenterY: number;
}

export interface ParallaxRayHit {
  dirX: number;
  dirY: number;
  dirZ: number;
  hitDist: number;
  isGroundHit: boolean;
}

/**
 * Zero-allocation variant writing asymmetric world-space proxy AABB directly into `out`.
 */
export function computeBiomeReflectionBoundsInto(
  biome: EnvironmentBiome,
  vehicleX: number,
  groundPlaneY: number,
  vehicleZ: number,
  out: BiomeReflectionBounds,
): BiomeReflectionBounds {
  // Probe center sits at Rivian R1T beltline / mid-cabin height (~1.18m above ground)
  out.probeCenterY = groundPlaneY + 1.18;
  out.minY = groundPlaneY;

  if (biome === 'rainy_highway') {
    // Highway runs along Z: Eucalyptus trunks stand at +X (~5.5..9m), utility poles & verge at -X (~-5.5..-11m),
    // and overhanging eucalyptus foliage canopies sit ~11-13m above the wet asphalt.
    out.minX = Math.min(vehicleX - 4.5, -11.5);
    out.maxX = Math.max(vehicleX + 4.5, 9.2);
    out.maxY = groundPlaneY + 13.0;
    out.minZ = vehicleZ - 30.0;
    out.maxZ = vehicleZ + 30.0;
    return out;
  }

  if (biome === 'mud_grass') {
    // Countryside basin encircled by mossy boulders and woodland treeline
    out.minX = vehicleX - 32.0;
    out.maxX = vehicleX + 32.0;
    out.maxY = groundPlaneY + 22.0;
    out.minZ = vehicleZ - 32.0;
    out.maxZ = vehicleZ + 32.0;
    return out;
  }

  // Open Sahara desert dune basin + distant barchan ridge envelope
  out.minX = vehicleX - 38.0;
  out.maxX = vehicleX + 38.0;
  out.maxY = groundPlaneY + 42.0;
  out.minZ = vehicleZ - 38.0;
  out.maxZ = vehicleZ + 38.0;
  return out;
}

/**
 * Computes an asymmetric world-space proxy AABB matching the actual surrounding geometry
 * of each biome, with `minY` anchored flush to the real terrain/road surface (`groundPlaneY`)
 * so side-door and bumper reflections lock tightly onto the adjacent asphalt, sand, or mud.
 */
export function computeBiomeReflectionBounds(
  biome: EnvironmentBiome,
  vehicleX: number,
  groundPlaneY: number,
  vehicleZ: number,
): BiomeReflectionBounds {
  return computeBiomeReflectionBoundsInto(biome, vehicleX, groundPlaneY, vehicleZ, {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 0,
    maxY: 0,
    maxZ: 0,
    probeCenterY: 0,
  });
}

/**
 * Analytical ray-AABB slab exit intersection from `worldPos` along unit `reflectDir`
 * against asymmetric proxy box `[boxMin, boxMax]`, returning the parallax-corrected
 * cubemap lookup direction from `probeCenter`, exact travel distance, and ground-hit flag.
 */
export function projectParallaxReflectionRay(
  worldPos: Vec3Like,
  reflectDir: Vec3Like,
  boxMin: Vec3Like,
  boxMax: Vec3Like,
  probeCenter: Vec3Like,
): ParallaxRayHit {
  const rLen = Math.hypot(reflectDir.x, reflectDir.y, reflectDir.z);
  const rx = rLen > 1e-6 ? reflectDir.x / rLen : 0;
  const ry = rLen > 1e-6 ? reflectDir.y / rLen : 1;
  const rz = rLen > 1e-6 ? reflectDir.z / rLen : 0;

  // Clamp origin safely inside proxy box (inset 0.04m) so suspension dip or rollover never produces negative t
  const epsInset = 0.04;
  const px = Math.max(boxMin.x + epsInset, Math.min(boxMax.x - epsInset, worldPos.x));
  const py = Math.max(boxMin.y + epsInset, Math.min(boxMax.y - epsInset, worldPos.y));
  const pz = Math.max(boxMin.z + epsInset, Math.min(boxMax.z - epsInset, worldPos.z));

  const safeX = Math.abs(rx) < 1e-5 ? (rx < 0 ? -1e-5 : 1e-5) : rx;
  const safeY = Math.abs(ry) < 1e-5 ? (ry < 0 ? -1e-5 : 1e-5) : ry;
  const safeZ = Math.abs(rz) < 1e-5 ? (rz < 0 ? -1e-5 : 1e-5) : rz;

  const tx1 = (boxMin.x - px) / safeX;
  const tx2 = (boxMax.x - px) / safeX;
  const ty1 = (boxMin.y - py) / safeY;
  const ty2 = (boxMax.y - py) / safeY;
  const tz1 = (boxMin.z - pz) / safeZ;
  const tz2 = (boxMax.z - pz) / safeZ;

  const tFarX = Math.max(tx1, tx2);
  const tFarY = Math.max(ty1, ty2);
  const tFarZ = Math.max(tz1, tz2);

  const hitDist = Math.max(0.25, Math.min(tFarX, tFarY, tFarZ));
  const hitX = px + rx * hitDist;
  const hitY = py + ry * hitDist;
  const hitZ = pz + rz * hitDist;

  // Ray hit the real ground plane if Y was the winning exit slab and ray pointed downward
  const isGroundHit = ry < -1e-3 && tFarY <= tFarX + 1e-3 && tFarY <= tFarZ + 1e-3;

  const dx = hitX - probeCenter.x;
  const dy = hitY - probeCenter.y;
  const dz = hitZ - probeCenter.z;
  const dLen = Math.hypot(dx, dy, dz);

  if (dLen < 1e-6) {
    return { dirX: rx, dirY: ry, dirZ: rz, hitDist, isGroundHit };
  }

  return {
    dirX: dx / dLen,
    dirY: dy / dLen,
    dirZ: dz / dLen,
    hitDist,
    isGroundHit,
  };
}

/**
 * Contact-hardening ray-traced cone mip selection:
 * Nearby hits (adjacent road/sand/curbs at 0.5-3m) stay razor sharp, while distant hits
 * (clouds/sky/far trees) widen smoothly according to surface roughness.
 */
export function computeConeTracedMipLevel(
  roughness: number,
  hitDistance: number,
  maxMip: number,
  isGroundHit: boolean,
): number {
  const r = Math.max(0, Math.min(1, roughness));
  const clampedMax = Math.max(0, maxMip);
  // Smoothstep distance factor over 1.2m..18.0m
  const tRaw = Math.max(0, Math.min(1, (hitDistance - 1.2) / (18.0 - 1.2)));
  const smoothT = tRaw * tRaw * (3 - 2 * tRaw);
  const minDistScale = isGroundHit ? 0.42 : 0.52;
  const distFactor = minDistScale + (1.0 - minDistScale) * smoothT;
  const perceptualRough = r * (2.0 - r);
  return Math.max(0, Math.min(clampedMax, perceptualRough * clampedMax * distFactor));
}

/**
 * Sébastien Lagarde's physically based specular occlusion (Frostbite / Moving Frostbite to PBR).
 * Prevents glowing environment reflections inside wheel arches, bumper crevices, and underbody shadows.
 */
export function computeLagardeSpecularOcclusion(
  nDotV: number,
  ao: number,
  roughness: number,
): number {
  const ndv = Math.max(0, Math.min(1, nDotV));
  const occ = Math.max(0, Math.min(1, ao));
  const r = Math.max(0.02, Math.min(1, roughness));
  const exponent = Math.pow(2.0, -16.0 * r - 1.0);
  const specOcc = Math.pow(ndv + occ, exponent) - 1.0 + occ;
  return Math.max(0, Math.min(1, specOcc));
}

/**
 * Analytical vehicle-body self-reflection occlusion in Rivian body-local space.
 * Because the CubeCamera hides the vehicle during capture, rays bouncing off lower rockers,
 * wheel wells, recessed bumpers, or the underside of mirrors would otherwise leak bright sky
 * right through the truck's own chassis. Returns visibility factor `0..1` (0 = occluded by own body/ground).
 */
export function computeSelfBodyOcclusion(
  localPos: Vec3Like,
  localNormal: Vec3Like,
  localReflectDir: Vec3Like,
): number {
  // 1. Underbody & low-rocker horizon cutoff (below 0.52m local height, rays pointing downward or inward see shadow)
  const lowHeightT = Math.max(0, Math.min(1, (localPos.y - 0.24) / (0.68 - 0.24)));
  const underbodyOcc = 0.28 + 0.72 * (lowHeightT * lowHeightT * (3 - 2 * lowHeightT));

  // 2. Downward-facing normal self-shadowing (undercarriage, mirror undersides, bumper lips)
  const normUpT = Math.max(0, Math.min(1, (localNormal.y + 0.42) / 0.64));
  const normalOcc = 0.22 + 0.78 * (normUpT * normUpT * (3 - 2 * normUpT));

  // 3. Inward-pointing ray toward Rivian chassis core (X in [-0.88, 0.88], Y in [0.45, 1.78], Z in [-2.4, 2.3])
  // If a ray originates near/outside the body and points straight back toward the vehicle centerline, attenuate it.
  let inwardOcc = 1.0;
  const distFromCenterX = Math.abs(localPos.x);
  if (distFromCenterX > 0.72 && localPos.y > 0.4 && localPos.y < 1.85 && Math.abs(localPos.z) < 2.55) {
    const towardCenterX = localPos.x > 0 ? -localReflectDir.x : localReflectDir.x;
    if (towardCenterX > 0.25) {
      const block = Math.max(0, Math.min(1, (towardCenterX - 0.25) / 0.55));
      inwardOcc = 1.0 - block * 0.68;
    }
  }

  // 4. Bed cavity / recessed interior shelf attenuation (behind cabin Z < -0.55, low inside bed)
  let bedOcc = 1.0;
  if (localPos.z < -0.6 && localPos.z > -2.35 && Math.abs(localPos.x) < 0.72 && localPos.y < 1.15) {
    const skyOpen = Math.max(0, Math.min(1, (localReflectDir.y - 0.1) / 0.55));
    bedOcc = 0.35 + 0.65 * skyOpen;
  }

  return Math.max(0.12, Math.min(1.0, Math.min(underbodyOcc, normalOcc) * inwardOcc * bedOcc));
}

/**
 * Exact Schlick dielectric Fresnel approximation for automotive clearcoat (IOR ~1.5 -> F0 = 0.04)
 * and tempered automotive glass (IOR ~1.52 -> F0 = 0.043).
 */
export function computeDielectricFresnel(nDotV: number, ior = 1.5): number {
  const clampedIor = Math.max(1.0, ior);
  const r0 = (clampedIor - 1.0) / (clampedIor + 1.0);
  const f0 = r0 * r0;
  const oneMinus = Math.max(0, Math.min(1, 1.0 - Math.max(0, Math.min(1, nDotV))));
  const p5 = oneMinus * oneMinus * oneMinus * oneMinus * oneMinus;
  return f0 + (1.0 - f0) * p5;
}
