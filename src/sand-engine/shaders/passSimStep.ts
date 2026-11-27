/**
 * passSimStep.ts
 * Fused GPU simulation pass (`pass_sim_step.frag`) running on RGBA16F ping-pong
 * render targets:
 *   R = depression   [0..1]  (normalized by maxDepth = 0.25m)
 *   G = bermMass     [0..1]  (loose sand displaced outward; net h = G - R)
 *   B = compression  [0..1]  (grain compaction: darkens albedo, erases ripples, slows slump)
 *   A = microImprint [-1..+1] (tire tread chevrons / boot sole lugs)
 *
 * Executes in 1 single draw call per cascade:
 *   1. Zero-copy toroidal newly-exposed strip clear (+ 2-texel guard band)
 *   2. 30 Hz anisotropic 33° avalanche relaxation (alternating 4-tap kernel) + wind infill
 *   3. Swept oriented capsule SDF stamping for all active wheels & feet (64-byte brushes)
 */

import { COMMON_TOROIDAL_GLSL } from './commonToroidal';
import { SAND_DEFAULTS } from '../core/SandParams';

export const SIM_STEP_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const SIM_STEP_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uStateRead;
uniform sampler2D uBrushTex;
uniform sampler2D uParentCascade;
uniform vec2 uParentOrigin;
uniform float uParentSize;
uniform float uParentGuardWorld;
uniform float uHasParent;

uniform vec2 uMinCurr;
uniform vec2 uMaxCurr;
uniform vec2 uMinPrev;
uniform vec2 uMaxPrev;
uniform float uCascadeSize;
uniform float uResolution;
uniform float uGuardWorld;
uniform float uMaxDepth;

uniform int uBrushCount;
uniform float uDoRelax;
uniform float uRelaxDt;
uniform float uTickParity; // 0.0 = orthogonal 4-tap, 1.0 = diagonal 4-tap
uniform float uTanRepose;
uniform float uAvalancheRate;
uniform float uWindSpeed;
uniform vec2 uWindDir;
uniform float uMoisture;
uniform float uBiomeMud;

${COMMON_TOROIDAL_GLSL}

// Procedural tire chevron/block tread micro-imprint in [-1, +1] with dry-sand crumble or viscous mud shear
float evalTireTread(float uLat, float vScroll, float atlasId, vec2 worldXZ, float biomeMud) {
  float absU = abs(uLat);
  float centerGroove = smoothstep(0.07, 0.18, absU);
  float chevronPhase = vScroll * 10.2 - absU * 1.95 + atlasId * 0.7;
  float lug = sin(chevronPhase * 6.2831853);
  float sideBlock = sin((vScroll * 6.8 + sign(uLat) * 0.25) * 6.2831853);
  float shoulder = smoothstep(0.54, 0.85, absU);
  // Smooth longitudinal fluid mud channels with subtle organic soil irregularity (zero repeating cross-zigzags)
  float mudIrreg = sin(worldXZ.x * 2.3 + worldXZ.y * 1.9) * cos(worldXZ.x * 1.4 - worldXZ.y * 2.7);
  float mudRibs = sin(uLat * 11.5 + mudIrreg * 0.45) * 0.48
                + sin(uLat * 21.0 - mudIrreg * 0.35) * 0.24;
  float shearRibs = mix(sin(uLat * 24.0) * 0.24, mudRibs, biomeMud);
  float lugMix = mix(lug * centerGroove, sideBlock, shoulder);
  float pattern = mix(lugMix * 0.82 + shearRibs, shearRibs, biomeMud);

  // Dual-scale loose-sand grain crumble vs smooth viscous mud
  float gCoarse = fract(sin(dot(floor(worldXZ * 24.0), vec2(12.9898, 78.233))) * 43758.5453);
  float gFine = fract(sin(dot(floor(worldXZ * 58.0), vec2(39.346, 11.135))) * 43758.5453);
  float crumbleMix = mix(mix(0.56, 1.0, gCoarse * 0.6 + gFine * 0.4), 0.96, biomeMud);
  float edgeMask = 1.0 - smoothstep(0.76, 1.0, absU);
  return clamp(pattern * edgeMask * crumbleMix, -1.0, 1.0);
}

// Procedural desert hiking boot sole SDF & tread ribs
vec2 evalBootSole(vec2 localCoord, float halfWidth, float halfLen) {
  // localCoord.x = lateral, localCoord.y = longitudinal (+ = toe, - = heel)
  float ny = localCoord.y / max(0.05, halfLen);
  // Slightly wider forefoot, pinched arch, rounded heel
  float widthProfile = mix(0.86, 1.06, smoothstep(-0.2, 0.45, ny))
                     - 0.16 * exp(-pow((ny + 0.12) * 3.8, 2.0));
  float nx = localCoord.x / max(0.03, halfWidth * widthProfile);
  float r = length(vec2(nx, ny));
  float mask = 1.0 - smoothstep(0.72, 1.04, r);
  // Deep horizontal sole tread bars + heel cutout
  float lugs = sin(ny * 24.0) * 0.75 + cos(nx * 9.0) * 0.25;
  float archCut = 1.0 - 0.45 * exp(-pow((ny + 0.15) * 5.0, 2.0));
  return vec2(mask * archCut, lugs * mask);
}

void main() {
  float texelSize = uCascadeSize / uResolution;
  vec2 invRes = vec2(1.0 / uResolution);
  ivec2 pixelCoord = ivec2(gl_FragCoord.xy);
  ivec2 resI = ivec2(int(uResolution + 0.5));
  vec2 exactUv = (vec2(pixelCoord) + 0.5) * invRes;

  // Reconstruct exact world XZ mapped to this toroidal texel center
  vec2 worldXZ = toroidalUVToWorld(exactUv, uMinCurr, uCascadeSize);

  // 1. ZERO-COPY TOROIDAL CLEAR / PARENT-CASCADE PROMOTION
  bool inGuard =
    worldXZ.x < uMinCurr.x + uGuardWorld ||
    worldXZ.x >= uMaxCurr.x - uGuardWorld ||
    worldXZ.y < uMinCurr.y + uGuardWorld ||
    worldXZ.y >= uMaxCurr.y - uGuardWorld;

  bool outsidePrev =
    worldXZ.x < uMinPrev.x + uGuardWorld ||
    worldXZ.x >= uMaxPrev.x - uGuardWorld ||
    worldXZ.y < uMinPrev.y + uGuardWorld ||
    worldXZ.y >= uMaxPrev.y - uGuardWorld;

  vec4 state;
  if (inGuard) {
    // Strictly zero the 2-texel toroidal guard band so bilinear sampling and
    // neighbor avalanche lookups can never leak tracks across opposite window edges.
    state = vec4(0.0);
  } else if (outsidePrev) {
    if (uHasParent > 0.5) {
      // Promote existing tracks from Cascade 1 when Cascade 0 slides back over previously driven ground!
      // Prevents Cascade 0 from acting as a 32m square eraser when returning to old tracks.
      float parentW = computeCascadeWeight(worldXZ, uParentOrigin, uParentSize, uParentGuardWorld);
      if (parentW > 0.001) {
        state = texture(uParentCascade, worldToToroidalUV(worldXZ, uParentSize)) * parentW;
      } else {
        state = vec4(0.0);
      }
    } else {
      state = vec4(0.0);
    }
  } else {
    state = texelFetch(uStateRead, pixelCoord, 0);
  }

  // 2. ANISOTROPIC 33° AVALANCHE RELAXATION + WIND INFILL (30 Hz amortized, 4-tap alternating)
  // On coarse long-range Cascade 1 in dry desert sand, skip coarse-grid avalanche diffusion so tracks
  // stay crisp and never blur/flatten out over time (still allowing optional user-enabled wind infill).
  bool runDryAvalanche = (uBiomeMud >= 0.5) || (uCascadeSize < 50.0);
  if (uDoRelax > 0.5 && !inGuard && !outsidePrev && (runDryAvalanche || uWindSpeed > 0.001)) {
    vec2 offsets[4];
    float distMult = 1.0;
    if (uTickParity < 0.5) {
      // Even tick: orthogonal N, S, E, W
      offsets[0] = vec2(1.0, 0.0);
      offsets[1] = vec2(-1.0, 0.0);
      offsets[2] = vec2(0.0, 1.0);
      offsets[3] = vec2(0.0, -1.0);
      distMult = 1.0;
    } else {
      // Odd tick: diagonal NE, NW, SE, SW
      offsets[0] = vec2(1.0, 1.0);
      offsets[1] = vec2(-1.0, 1.0);
      offsets[2] = vec2(1.0, -1.0);
      offsets[3] = vec2(-1.0, -1.0);
      distMult = 1.41421356;
    }

    // Fetch all 4 neighbors first so undisturbed texels skip 5x getBaseTerrainHeight() (~95% of cascade!)
    vec4 nStates[4];
    float activeMass = state.r + state.g + abs(state.a);
    float avgImprint = 0.0;
    float avgR = 0.0;
    float avgG = 0.0;

    for (int k = 0; k < 4; k++) {
      ivec2 nCoord = (pixelCoord + ivec2(offsets[k]) + resI) % resI;
      vec4 ns = texelFetch(uStateRead, nCoord, 0);
      nStates[k] = ns;
      activeMass += ns.r + ns.g + abs(ns.a);
      avgImprint += ns.a * 0.25;
      avgR += ns.r * 0.25;
      avgG += ns.g * 0.25;
    }

    if (activeMass > 1e-4) {
      if (runDryAvalanche) {
        float baseCenter = getBaseTerrainHeight(worldXZ);
        float deformCenter = (state.g - state.r) * uMaxDepth;
        float Hc = baseCenter + deformCenter;

        // Damp sand holds a steeper angle (~38°); sloppy wet mud has low fluid repose (~15°)
        float tanRepose = mix(uTanRepose * (1.0 + uMoisture * 0.24), 0.27, uBiomeMud);
        float talusThresh = tanRepose * texelSize * distMult;

        // Anisotropy: loose berms / sloppy mud crests slump ~3x faster than compacted groove floors
        float baseMob = mix(0.42, 0.55, uBiomeMud);
        float centerMobility = mix(baseMob, 1.0, clamp(state.g * 2.8, 0.0, 1.0))
                             * (1.0 - state.b * mix(0.62, 0.42, uBiomeMud));

        float netHeightDelta = 0.0;
        for (int k = 0; k < 4; k++) {
          vec2 nWorld = worldXZ + offsets[k] * texelSize;
          vec4 nState = nStates[k];
          float Hn = getBaseTerrainHeight(nWorld) + (nState.g - nState.r) * uMaxDepth;
          float dH = Hc - Hn;

          if (dH > talusThresh) {
            // Outflow from center -> neighbor
            float excess = dH - talusThresh;
            netHeightDelta -= excess * centerMobility;
          } else if (-dH > talusThresh) {
            // Inflow from steeper neighbor -> center
            float nMobility = mix(baseMob, 1.0, clamp(nState.g * 2.8, 0.0, 1.0))
                            * (1.0 - nState.b * mix(0.62, 0.42, uBiomeMud));
            float excess = (-dH) - talusThresh;
            netHeightDelta += excess * nMobility;
          }
        }

        // Divide by 4 neighbors so total explicit step obeys CFL stability (<= 0.42 < 0.50)
        // preventing alternating checkerboard / zebra oscillation at any avalanche rate!
        float avgFlux = netHeightDelta * 0.25;
        float slumpScale = clamp(0.38 * uAvalancheRate * mix(1.0, 1.18, uBiomeMud) * (uRelaxDt * 30.0), 0.0, 0.42);
        float deltaNorm = (avgFlux * slumpScale) / max(0.01, uMaxDepth);

        if (deltaNorm < 0.0) {
          // Mass leaving center: drain loose bermMass first, gently soften rim
          float outflow = -deltaNorm;
          float fromBerm = min(state.g, outflow);
          state.g -= fromBerm;
          float rem = outflow - fromBerm;
          state.r = clamp(state.r + rem * mix(0.24, 0.14, uBiomeMud), 0.0, 1.0);
        } else if (deltaNorm > 0.0) {
          // Mass arriving into depression: fill depression first, remainder builds gentle berm
          float fillDep = min(state.r, deltaNorm);
          state.r -= fillDep;
          float rem = deltaNorm - fillDep;
          state.g = clamp(state.g + rem * 0.85, 0.0, 1.0);
        }
        // Subtle micro-imprint settling strictly during active avalanche slumping
        if (uWindSpeed <= 0.001 || uBiomeMud >= 0.5) {
          float slumpBlur = clamp(abs(deltaNorm) * mix(1.4, 3.2, uBiomeMud), 0.0, 0.16);
          state.a = mix(state.a, avgImprint, slumpBlur);
        }
      }

      // Viscous fluid settling applies ONLY to wet sloppy mud; dry sand stops naturally at its 33° angle of repose
      // so carved tire tracks and berms stay permanently sculpted instead of fading flat!
      if (uBiomeMud >= 0.5 && (state.r + state.g) > 0.004) {
        float visc = clamp(0.18 * (uRelaxDt * 30.0), 0.0, 0.24);
        state.r = mix(state.r, avgR, visc * 0.65);
        state.g = mix(state.g, avgG, visc * 0.85);
      }

      // Optional wind infill (0 by default; gentle slow drift only if user manually enables wind)
      if (uWindSpeed > 0.001 && uBiomeMud < 0.5) {
        vec2 upwindUv = fract(vUv - uWindDir * invRes);
        vec4 upwindState = texture(uStateRead, upwindUv);

        // Gentle micro-imprint softening under active wind
        float imprintErode = clamp(uWindSpeed * uRelaxDt * 0.035 * (1.0 - uMoisture * 0.55), 0.0, 0.08);
        state.a = mix(state.a, avgImprint * 0.85, imprintErode);
        state.a *= (1.0 - imprintErode * 0.45);

        // Very slow wind-blown infill from upwind rim into depression (tracks remain visible for minutes)
        float windFill = clamp(uWindSpeed * uRelaxDt * 0.0032 * (1.0 - uMoisture * 0.6), 0.0, 0.012);
        float upwindBerm = upwindState.g;
        state.r = max(0.0, state.r - windFill * (0.35 + upwindBerm * 1.1));
        state.g = max(0.0, state.g - windFill * 0.42);
        state.b = max(0.0, state.b - windFill * 0.22);
      }
    }
  }

  // 3. UNIFIED SWEPT SEGMENT SDF STAMPING (Wheels + Feet)
  int count = min(uBrushCount, ${SAND_DEFAULTS.MAX_BRUSHES});
  for (int i = 0; i < ${SAND_DEFAULTS.MAX_BRUSHES}; i++) {
    if (i >= count) break;

    vec4 b0 = texelFetch(uBrushTex, ivec2(0, i), 0); // posPrev.xyz, halfWidth
    vec4 b1 = texelFetch(uBrushTex, ivec2(1, i), 0); // posCurr.xyz, targetSinkage

    vec2 p0 = b0.xz;
    vec2 p1 = b1.xz;
    float halfWidth = max(0.04, b0.w);

    // Resolution-aware anti-aliased wheel width for coarser Cascade 1 so diagonal tracks stay smooth & deep!
    float coarseBlend = smoothstep(0.06, 0.20, texelSize);
    float effHalfWidth = max(halfWidth, texelSize * 1.52);

    // Fast AABB rejection per swept segment BEFORE fetching b2/b3 (eliminates 50% of brush texelFetches!)
    float maxRadius = effHalfWidth * 2.95 + texelSize;
    vec2 segMin = min(p0, p1) - vec2(maxRadius);
    vec2 segMax = max(p0, p1) + vec2(maxRadius);
    if (
      worldXZ.x < segMin.x || worldXZ.x > segMax.x ||
      worldXZ.y < segMin.y || worldXZ.y > segMax.y
    ) {
      continue;
    }

    vec4 b2 = texelFetch(uBrushTex, ivec2(2, i), 0); // slipRatio, treadPrev, treadCurr, lateralDrift
    vec4 b3 = texelFetch(uBrushTex, ivec2(3, i), 0); // brushType, atlasId, compressionWeight, massFactor

    float targetDepthNorm = clamp(b1.w / uMaxDepth, 0.0, 1.0);
    float slipRatio = b2.x;
    float treadPrev = b2.y;
    float treadCurr = b2.z;
    float lateralDrift = b2.w;
    float brushType = b3.x;
    float atlasId = b3.y;
    float compWeight = b3.z;
    float massFactor = b3.w;

    vec2 seg = p1 - p0;
    float segLenSq = dot(seg, seg);
    float segLen = sqrt(segLenSq);
    vec2 fwd = segLen > 1e-4 ? (seg / segLen) : vec2(0.0, 1.0);
    vec2 right = vec2(-fwd.y, fwd.x);

    vec2 rel = worldXZ - p0;
    float t = segLenSq > 1e-6 ? clamp(dot(rel, seg) / segLenSq, 0.0, 1.0) : 0.0;
    vec2 closest = p0 + seg * t;
    vec2 diff = worldXZ - closest;

    float dLat = dot(diff, right);
    float dPerp = abs(dLat);
    float capsuleDist = length(diff);

    if (brushType < 0.5) {
      // === WHEEL: Swept Oriented Capsule ===
      float effDist = capsuleDist;
      float uNorm = clamp(dLat / effHalfWidth, -1.0, 1.0);

      if (effDist < effHalfWidth * 1.24) {
        // C1-smooth sand & mud cross-section (zero sharp edge cliff; natural 26°-32° slumped rut shoulder)
        float r = clamp(effDist / (effHalfWidth * mix(1.22, 1.04, uBiomeMud)), 0.0, 1.0);
        float c = cos(r * 1.5707963);
        float sandProf = c * c * (1.22 - 0.22 * c);
        float mudProf = c * c * (1.36 - 0.36 * c);
        float profile = mix(sandProf, mudProf, uBiomeMud);

        float oldDep = state.r;
        // Compensate bilinear averaging on coarse Cascade 1 so perceived rut depth matches Cascade 0 seamlessly
        float sandDepthGain = mix(0.72, 0.86, coarseBlend);
        float desiredDep = targetDepthNorm * mix(sandDepthGain, 0.78, uBiomeMud) * profile;
        float newDep = max(oldDep, desiredDep);

        state.r = clamp(newDep, 0.0, 1.0);
        // Tire crushes pre-existing berms smoothly across the slumped wheel channel
        float bermKeep = smoothstep(effHalfWidth * 0.62, effHalfWidth * 1.18, effDist);
        state.g = max(0.0, state.g * mix(0.02, 1.0, bermKeep));
        // Compaction increases with contact pressure & repeated passes
        state.b = clamp(max(state.b, compWeight * profile), 0.0, 1.0);

        // Stamp subtle powdery tire tread (soft collapsed cross-ripples in dry fine sand)
        float treadV = mix(treadPrev, treadCurr, t);
        float treadVal = evalTireTread(uNorm, treadV, atlasId, worldXZ, uBiomeMud);
        float sandCrisp = mix(0.20, 0.54, uMoisture) * (1.0 - clamp(slipRatio * 0.68, 0.0, 0.86));
        float treadCrisp = mix(sandCrisp, 0.24, uBiomeMud);
        float imprintStrength = smoothstep(0.10, 0.38, profile) * treadCrisp;
        state.a = mix(state.a, treadVal, clamp(imprintStrength * 0.58, 0.0, 1.0));
      }

      // Directional volume conservation: sculpt rounded organically undulating sand berms along shoulders
      // plus a subtle curved bulldozed bow-wave crest directly in front of the tire's leading entry arc
      float dAlongClosest = dot(diff, fwd);
      float longSpanMask =
        smoothstep(effHalfWidth * 0.68, 0.0, max(0.0, dAlongClosest)) *
        smoothstep(effHalfWidth * 0.72, 0.0, max(0.0, -dAlongClosest));
      float bermCenter = effHalfWidth * mix(1.44, 1.62, uBiomeMud);
      float bermSigma = max(effHalfWidth * mix(0.64, 1.06, uBiomeMud), texelSize * 0.92);

      // Subtle leading bow-wave sand push directly in front of the advancing tire lugs
      float frontPush = 0.0;
      if (t > 0.82 && dAlongClosest > effHalfWidth * 0.55 && dAlongClosest < effHalfWidth * 2.15) {
        float bowDist = length(diff);
        float bowCenter = effHalfWidth * mix(1.36, 1.48, uBiomeMud);
        float bowSigma = max(effHalfWidth * 0.48, texelSize * 0.88);
        float bowArc = exp(-pow((bowDist - bowCenter) / bowSigma, 2.0));
        float bowFwdMask = smoothstep(0.15, 0.85, dAlongClosest / max(0.01, bowDist));
        frontPush = bowArc * bowFwdMask * mix(0.46, 0.34, uBiomeMud);
      }

      bool inLateralBerm =
        longSpanMask > 0.01 &&
        dPerp > effHalfWidth * 0.88 &&
        dPerp < effHalfWidth * mix(2.75, 3.05, uBiomeMud);

      if (inLateralBerm || frontPush > 0.01) {
        // Subtle organic lateral meander along the berm ridge (natural dry sand slumping)
        float rimWave = (sin(worldXZ.x * 2.4 + worldXZ.y * 1.8) * 0.55 + cos(worldXZ.x * 4.3 - worldXZ.y * 3.7) * 0.45)
                      * effHalfWidth * mix(0.16, 0.06, uBiomeMud);
        float gVal = inLateralBerm
          ? exp(-pow((dPerp - (bermCenter + rimWave)) / bermSigma, 2.0)) * longSpanMask
          : 0.0;
        // Directional drift asymmetry (outside of drift builds a fuller sand/mud spill)
        float sideSign = sign(dLat);
        float driftBias = 1.0 + clamp(sideSign * lateralDrift * 0.78, -0.45, 0.95);
        // Domain-warped organic granular slump / mud clod breakup along shoulders
        float clodWarp = 0.35 * sin(worldXZ.x * 1.4 - worldXZ.y * 1.7);
        float c1 = 0.5 + 0.5 * sin((worldXZ.x + clodWarp) * 3.1 + worldXZ.y * 2.4) * cos(worldXZ.x * 1.9 - (worldXZ.y - clodWarp) * 2.9);
        float c2 = 0.5 + 0.5 * sin(worldXZ.x * 7.4 - worldXZ.y * 6.1 + 1.1);
        float sandSpillMod = 0.60 + 0.34 * c1 + 0.14 * c2;
        float mudClodMod = 0.44 + 0.48 * c1 + 0.26 * c2;
        float clodMod = mix(sandSpillMod, mudClodMod, uBiomeMud);

        float bermGain = mix(0.38, 0.48, coarseBlend);
        float combinedBerm = max(gVal * driftBias, frontPush);
        float targetBerm = targetDepthNorm * mix(bermGain, 0.22, uBiomeMud) * massFactor * combinedBerm * clodMod;
        // Smooth monotonic upper envelope avoids frame-rate-dependent ridges inside overlapping stamps
        float headroom = max(0.0, 0.72 - state.g);
        float addBerm = min(headroom, max(0.0, targetBerm - state.g));
        state.g = clamp(state.g + addBerm, 0.0, 0.80);
        // Loose berm softens pre-existing tread marks on top of it
        state.a *= (1.0 - combinedBerm * 0.58);
      }
    } else {
      // === FOOT: Foot IK Driven Boot Sole Print + Toe-Off Crest ===
      vec2 footCenter = mix(p0, p1, 0.5);
      vec2 fRel = worldXZ - footCenter;
      float halfLen = max(halfWidth * 1.65, segLen * 0.5 + halfWidth * 1.35);
      vec2 localFoot = vec2(dot(fRel, right), dot(fRel, fwd));

      vec2 sole = evalBootSole(localFoot, halfWidth, halfLen);
      float mask = sole.x;
      float soleLugs = sole.y;

      if (mask > 0.01) {
        float desiredDep = targetDepthNorm * mask;
        state.r = clamp(max(state.r, desiredDep), 0.0, 1.0);
        state.g = max(0.0, state.g * (1.0 - mask * 0.9));
        state.b = clamp(max(state.b, compWeight * mask), 0.0, 1.0);
        state.a = mix(state.a, soleLugs, clamp(mask * 0.92, 0.0, 1.0));
      }

      // Small displaced rim around boot + push-off sand crest behind heel/toe-off
      float radialNorm = length(vec2(localFoot.x / (halfWidth * 1.25), localFoot.y / (halfLen * 1.2)));
      float rimGauss = exp(-pow((radialNorm - 1.12) / 0.28, 2.0));
      // Toe-off pushes extra loose sand crest toward -fwd (behind the foot)
      float pushCrest = exp(-pow((localFoot.y + halfLen * 1.05) / (halfWidth * 0.75), 2.0))
                      * exp(-pow(localFoot.x / (halfWidth * 1.1), 2.0))
                      * (0.45 + slipRatio * 0.85);
      float bermAdd = targetDepthNorm * (rimGauss * 0.42 + pushCrest * 0.58) * massFactor;
      state.g = clamp(max(state.g, bermAdd), 0.0, 0.75);
    }
  }

  fragColor = state;
}
`;
