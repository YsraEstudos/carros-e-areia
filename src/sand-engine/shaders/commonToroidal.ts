/**
 * commonToroidal.ts
 * Portable GLSL 3.00 include (`common_toroidal.glsl`) shared across:
 *  - Simulation ping-pong pass (`pass_sim_step.frag`)
 *  - Nested-ring CDLOD Clipmap vertex pass (`terrain_clipmap.vert`)
 *  - Shadow Cascade 0 depth pass (`terrain_depth.vert`)
 *  - Physically based sand surface pass (`terrain_sand.frag`)
 */

export const COMMON_TOROIDAL_GLSL = /* glsl */ `
// Exact GLSL mirror of CPU TerrainHeightfield.ts sampleUnevenSandOffset(x, z)
float getUnevenSandOffset(vec2 xz) {
  float x = xz.x;
  float z = xz.y;

  float crossAxleMoguls = 0.0;
  vec2 mRel = vec2((x - 14.0) / 8.5, (z - 46.5) / 11.5);
  float mDistSq = dot(mRel, mRel);
  if (mDistSq < 1.1025) {
    float mogulZone = 1.0 - smoothstep(0.55, 1.05, sqrt(mDistSq));
    crossAxleMoguls =
      (sin(x * 1.15) * sin(z * 0.85) * 0.24 +
       cos(x * 0.68 - z * 1.25) * 0.13) *
      mogulZone;
  }

  float washboard = 0.0;
  vec2 wRel = vec2((x + 16.5) / 9.0, (z - 4.0) / 10.5);
  float wDistSq = dot(wRel, wRel);
  if (wDistSq < 1.1025) {
    float washZone = 1.0 - smoothstep(0.55, 1.05, sqrt(wDistSq));
    washboard =
      (sin(z * 1.35 + sin(x * 0.6) * 0.9) * 0.17 +
       cos(x * 1.05 + z * 0.72) * 0.11) *
      washZone;
  }

  float microUndulation = 0.0;
  float distSq = dot(xz, xz);
  if (distSq > 144.0) {
    float outerMicroMask = smoothstep(12.0, 22.0, sqrt(distSq));
    microUndulation =
      (sin(x * 0.38 + z * 0.27) * 0.085 +
       cos(x * 0.54 - z * 0.46) * 0.065) *
      outerMicroMask;
  }

  return crossAxleMoguls + washboard + microUndulation;
}

// Exact GLSL mirror of CPU TerrainHeightfield.ts (zero GPU readback)
float getBaseTerrainHeight(vec2 xz) {
  float x = xz.x;
  float z = xz.y;

  float d1 = sin(x * 0.028 + z * 0.014) * 1.35;
  float d2 = cos(x * 0.017 - z * 0.031 + 0.8) * 1.05;

  float dist = length(xz);
  float barchanContrib = 0.0;
  if (dist > 18.0) {
    float rx = max(0.0, abs(x - 14.0) - 6.5);
    float rz = max(0.0, abs(z - 33.0) - 24.5);
    float trailSafe = smoothstep(1.0, 10.0, length(vec2(rx, rz)));
    float sprintRx = max(0.0, abs(x - 1.5) - 5.5);
    float sprintRz = max(0.0, abs(z + 4.0) - 20.0);
    float sprintSafe = smoothstep(0.5, 7.0, length(vec2(sprintRx, sprintRz)));
    float crestEnv = smoothstep(18.0, 38.0, dist) * trailSafe * sprintSafe;
    if (crestEnv > 1e-5) {
      float phase1 = x * 0.036 + z * 0.024 + sin(z * 0.017) * 1.85;
      float wave1 = sin(phase1 + 0.36 * sin(phase1));
      float barchan1 = (1.0 - sqrt(wave1 * wave1 + 0.045)) * 2.75;

      float phase2 = x * 0.021 - z * 0.038 + cos(x * 0.015) * 1.45;
      float wave2 = sin(phase2 - 0.30 * sin(phase2));
      float barchan2 = (1.0 - sqrt(wave2 * wave2 + 0.065)) * 1.65;
      barchanContrib = (barchan1 + barchan2) * crestEnv;
    }
  }

  float phaseBase = x * 0.052 + z * 0.044 + sin(z * 0.022) * 1.4;
  float ridge = pow(max(0.0, 0.5 + 0.5 * sin(phaseBase)), 1.65) * 0.55;

  float swell = sin(x * 0.11 - z * 0.085) * 0.14 + cos(x * 0.09 + z * 0.12) * 0.11;

  float outerRise = 0.0;
  if (dist > 52.0) {
    float rimT = clamp((dist - 52.0) / 140.0, 0.0, 1.0);
    outerRise = rimT * rimT * (3.0 - 2.0 * rimT) * 11.5;
  }

  float centerFlat = 0.55 + 0.45 * min(1.0, dist / 24.0);

  return (d1 + d2 + ridge + swell) * centerFlat + barchanContrib + outerRise + getUnevenSandOffset(xz);
}

vec3 getBaseTerrainNormal(vec2 xz) {
  const float eps = 0.25;
  float hL = getBaseTerrainHeight(xz - vec2(eps, 0.0));
  float hR = getBaseTerrainHeight(xz + vec2(eps, 0.0));
  float hD = getBaseTerrainHeight(xz - vec2(0.0, eps));
  float hU = getBaseTerrainHeight(xz + vec2(0.0, eps));
  return normalize(vec3(hL - hR, 2.0 * eps, hD - hU));
}

// Zero-copy toroidal addressing: uv = fract(worldXZ / cascadeSize)
vec2 worldToToroidalUV(vec2 worldXZ, float cascadeSize) {
  return fract(worldXZ / cascadeSize);
}

// Reconstruct exact world XZ currently mapped to texel uv in [0, 1)
vec2 toroidalUVToWorld(vec2 uv, vec2 minCurr, float cascadeSize) {
  vec2 baseUV = fract(minCurr / cascadeSize);
  vec2 relUV = fract(uv - baseUV);
  return minCurr + relUV * cascadeSize;
}

// Smooth 22% outer crossfade weight for a toroidal cascade
float computeCascadeWeight(vec2 worldXZ, vec2 origin, float cascadeSize, float guardWorld) {
  float halfSize = cascadeSize * 0.5;
  vec2 rel = abs(worldXZ - origin) / halfSize;
  float edgeDist = max(rel.x, rel.y);
  float fadeStart = 0.78;
  float fadeEnd = 1.0 - (guardWorld / halfSize) * 1.5;
  return 1.0 - smoothstep(fadeStart, fadeEnd, edgeDist);
}

// Blended state from Cascade 0 (12m detail) + Cascade 1 (64m range)
vec4 sampleCascadeBlended(
  vec2 worldXZ,
  sampler2D cascade0,
  vec2 origin0,
  float size0,
  sampler2D cascade1,
  vec2 origin1,
  float size1,
  float guardWorld0,
  float guardWorld1
) {
  float w0 = computeCascadeWeight(worldXZ, origin0, size0, guardWorld0);
  float w1 = computeCascadeWeight(worldXZ, origin1, size1, guardWorld1);

  vec4 s1 = vec4(0.0);
  if (w1 > 0.001) {
    s1 = texture(cascade1, worldToToroidalUV(worldXZ, size1)) * w1;
  }
  if (w0 <= 0.001) {
    return s1;
  }

  vec4 s0 = texture(cascade0, worldToToroidalUV(worldXZ, size0));
  return mix(s1, s0, w0);
}

// Net vertical sand deformation in meters: h = (bermMass - depression) * maxDepth
float getNetDeformHeight(vec4 state, float maxDepth) {
  return (state.g - state.r) * maxDepth;
}

// Exact GLSL mirror of TerrainHeightfield.ts sampleMudGrassZoneMask(x, z)
// 0.0 = open sloppy mud track / clearing, 1.0 = lush wild grass shoulder
float getMudGrassZoneMask(vec2 xz) {
  float x = xz.x;
  float z = xz.y;
  float meanderA = sin(x * 0.065 + z * 0.025) * 3.8 + cos(z * 0.11) * 1.4;
  float meanderB = cos(z * 0.055 - x * 0.03) * 4.2 + sin(x * 0.09) * 1.5;

  float distCenter = length(xz + vec2(1.5, 1.0));
  float centralClearing = 1.0 - smoothstep(5.5, 10.8, distCenter);

  float trailADist = abs(z - meanderA * 0.72);
  float trailBDist = abs(x - meanderB * 0.78);
  float trailA = 1.0 - smoothstep(3.1, 6.2, trailADist);
  float trailB = 1.0 - smoothstep(2.9, 6.0, trailBDist);

  float edgeWave =
    sin(x * 0.34 + z * 0.29) * 0.14 +
    cos(x * 0.62 - z * 0.51) * 0.09;

  float mudOpen = max(centralClearing, max(trailA, trailB));
  return clamp(smoothstep(0.18, 0.72, 1.0 - mudOpen + edgeWave), 0.0, 1.0);
}

// Subtle low basin puddle pockets (mirrored from TerrainHeightfield.ts)
float getMudHollowFactorWithBaseH(vec2 xz, float h) {
  float lowBasin = 1.0 - smoothstep(0.0, 1.9, h);
  if (lowBasin <= 0.001) return 0.0;
  vec2 w = xz + vec2(
    sin(xz.y * 0.52 + 0.7) * 1.15 + cos(xz.y * 1.35) * 0.42,
    cos(xz.x * 0.47 - 0.5) * 1.15 + sin(xz.x * 1.28) * 0.42
  );
  float n1 = 0.5 + 0.5 * sin(w.x * 0.52 + w.y * 0.39 + 1.4);
  float n2 = 0.5 + 0.5 * cos(w.x * 0.96 - w.y * 0.81 + 0.3);
  float n3 = 0.5 + 0.5 * sin(w.x * 2.15 + w.y * 1.75);
  float n4 = 0.5 + 0.5 * cos(w.x * 3.7 - w.y * 3.1);
  float pocket = n1 * 0.42 + n2 * 0.30 + n3 * 0.18 + n4 * 0.10;
  return clamp(lowBasin * smoothstep(0.74, 0.91, pocket), 0.0, 1.0);
}

float getMudHollowFactor(vec2 xz) {
  return getMudHollowFactorWithBaseH(xz, getBaseTerrainHeight(xz));
}

// ============================================================================
// EXACT GLSL MIRROR OF RainyHighwayModel.ts (zero GPU readback)
// ============================================================================
float hwHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Returns vec4(depthM, mask01, crackRim01, waterFill01)
vec4 sampleHighwayPotholeGLSL(vec2 xz) {
  float x = xz.x;
  float z = xz.y;
  float absX = abs(x);
  if (absX > 3.90) {
    return vec4(0.0);
  }

  float bestMask = 0.0;
  float bestDepth = 0.0;
  float bestRim = 0.0;

  // Cell lattice A: larger broken wheel-track / edge potholes
  const float cellLenA = 9.5;
  float cellIdxA = floor(z / cellLenA);
  for (int dz = -1; dz <= 1; dz++) {
    float ci = cellIdxA + float(dz);
    float r0 = hwHash21(vec2(ci * 1.37, 11.4));
    if (r0 < 0.22) continue;

    float r1 = hwHash21(vec2(ci * 2.13, 27.9));
    float r2 = hwHash21(vec2(ci * 3.71, 5.2));
    float r3 = hwHash21(vec2(ci * 5.19, 19.8));

    float cx = (r1 < 0.68) ? -(0.75 + r2 * 2.35) : (0.65 + r2 * 2.15);
    float cz = (ci + 0.18 + r3 * 0.64) * cellLenA;
    if (abs(cz) < 4.2) continue;

    float rx = 0.34 + hwHash21(vec2(ci, 41.3)) * 0.42;
    float rz = 0.55 + hwHash21(vec2(ci, 63.7)) * 0.95;

    float dx = x - cx;
    float dzL = z - cz;
    // Fast conservative AABB rejection before atan/sin/cos/length (max jag = 1.30, 1.55*1.30 = 2.015)
    if (abs(dx) > rx * 2.05 || abs(dzL) > rz * 2.05) continue;

    float ang = atan(dzL, dx);
    float jag = 1.0 + 0.19 * sin(ang * 3.0 + ci * 1.7) + 0.11 * cos(ang * 5.0 - ci * 2.3);
    float normDist = length(vec2(dx / (rx * jag), dzL / (rz * jag)));

    if (normDist < 1.55) {
      float m = 1.0 - smoothstep(0.45, 1.0, normDist);
      float rim = smoothstep(0.75, 1.02, normDist) * (1.0 - smoothstep(1.02, 1.48, normDist));
      float d = m * (0.062 + 0.044 * hwHash21(vec2(ci, 88.1)));
      bestMask = max(bestMask, m);
      bestDepth = max(bestDepth, d);
      bestRim = max(bestRim, rim);
    }
  }

  // Cell lattice B: secondary smaller cracks & shallow depressions
  const float cellLenB = 5.4;
  float cellIdxB = floor(z / cellLenB);
  for (int dz = -1; dz <= 1; dz++) {
    float ci = cellIdxB + float(dz);
    float r0 = hwHash21(vec2(ci * 4.17, 73.1));
    if (r0 < 0.42) continue;

    float r1 = hwHash21(vec2(ci * 1.93, 91.5));
    float r2 = hwHash21(vec2(ci * 3.11, 14.6));
    float cx = (r1 * 2.0 - 1.0) * 2.95;
    float cz = (ci + 0.15 + r2 * 0.70) * cellLenB;
    if (abs(cz) < 3.8) continue;

    float rx = 0.22 + hwHash21(vec2(ci, 52.4)) * 0.28;
    float rz = 0.34 + hwHash21(vec2(ci, 31.8)) * 0.48;
    float dx = x - cx;
    float dzL = z - cz;
    // Fast conservative AABB rejection before atan/sin/length (max jag = 1.16, 1.45*1.16 = 1.682)
    if (abs(dx) > rx * 1.72 || abs(dzL) > rz * 1.72) continue;

    float ang = atan(dzL, dx);
    float jag = 1.0 + 0.16 * sin(ang * 4.0 + ci * 2.9);
    float normDist = length(vec2(dx / (rx * jag), dzL / (rz * jag)));

    if (normDist < 1.45) {
      float m = 1.0 - smoothstep(0.42, 1.0, normDist);
      float rim = smoothstep(0.76, 1.02, normDist) * (1.0 - smoothstep(1.02, 1.42, normDist));
      float d = m * 0.046;
      bestMask = max(bestMask, m * 0.85);
      bestDepth = max(bestDepth, d);
      bestRim = max(bestRim, rim * 0.85);
    }
  }

  float onRoad = 1.0 - smoothstep(3.45, 3.85, absX);
  float mask01 = clamp(bestMask * onRoad, 0.0, 1.0);
  float depthM = bestDepth * onRoad;
  float crackRim01 = clamp(bestRim * onRoad, 0.0, 1.0);
  float waterFill01 = clamp(smoothstep(0.22, 0.72, mask01), 0.0, 1.0);
  return vec4(depthM, mask01, crackRim01, waterFill01);
}

float getRainyHighwayHeight(vec2 xz) {
  float x = xz.x;
  float z = xz.y;
  float absX = abs(x);

  float grade = sin(z * 0.011) * 0.36 + cos(z * 0.0055 + 0.9) * 0.24;
  float roadCrown = (1.0 - smoothstep(0.0, 3.55, absX)) * 0.055;

  float swaleCenter = (absX - 6.8) / 2.2;
  float swale = -0.22 * exp(-swaleCenter * swaleCenter);

  float fieldMask = smoothstep(5.15, 11.0, absX);
  float paddockWave = (sin(x * 0.045 + z * 0.022) * 0.28 + cos(x * 0.028 - z * 0.036) * 0.22) * fieldMask;

  vec4 ph = sampleHighwayPotholeGLSL(xz);
  return grade + roadCrown + swale + paddockWave - ph.x;
}

float getBiomeTerrainHeight(vec2 xz, float biomeRainy) {
  if (biomeRainy >= 0.5) {
    return getRainyHighwayHeight(xz);
  }
  return getBaseTerrainHeight(xz);
}

vec3 getBiomeTerrainNormal(vec2 xz, float biomeRainy) {
  const float eps = 0.22;
  float hL = getBiomeTerrainHeight(xz - vec2(eps, 0.0), biomeRainy);
  float hR = getBiomeTerrainHeight(xz + vec2(eps, 0.0), biomeRainy);
  float hD = getBiomeTerrainHeight(xz - vec2(0.0, eps), biomeRainy);
  float hU = getBiomeTerrainHeight(xz + vec2(0.0, eps), biomeRainy);
  return normalize(vec3(hL - hR, 2.0 * eps, hD - hU));
}
`;
