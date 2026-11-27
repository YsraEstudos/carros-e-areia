/**
 * terrainSand.ts
 * Photorealistic physically based desert sand fragment shader (`terrain_sand.frag`):
 *  1. Dual-texture multi-scale anti-tiling photographic sand pipeline:
 *     - `uSandMacroTex` (photographic bifurcating desert sand ripples + wind-sorted grit + mineral flecks)
 *       blended across 2 domain-warped rotated scales aligned with wind direction
 *     - `uSandGrainTex` (high-frequency fine quartz & mineral grain) for razor-sharp close-up fidelity
 *     - Central-difference photographic RNM normals extracted from both maps + granular berm crumble
 *  2. OpenPBR Energy-Preserving Oren-Nayar (EON) diffuse BRDF (Fujii / Portsmouth 2024)
 *     + warm quartz subsurface multiple-scattering + cool sky-blue trough fill
 *  3. Subtle organic bifurcating aeolian macro-ripples (zero synthetic corduroy stripes),
 *     naturally suppressed on steep slip-faces and erased by tire tracks/berms
 *  4. 5-level Reoriented Normal Mapping (RNM): macro dune + toroidal deform & crumbled
 *     microImprint + granular loose-berm clods + organic wind ripples + photographic grains
 *  5. Mid-range Parallax Occlusion Mapping (14m - 62m) on Cascade 1
 *  6. Dual-layer self-shadowing (Shadow Cascade 0 PCF + 6-tap heightfield horizon march)
 *  7. Derivative-filtered quartz crystal glints (Deliot & Belcour vs 2-octave mip) with
 *     subtle warm-gold/white crystalline micro-dispersion
 *  8. Sun-aligned Mie + Rayleigh desert aerial perspective fog & neutral ACES filmic tone mapping
 */

import { COMMON_TOROIDAL_GLSL } from './commonToroidal';

export const TERRAIN_SAND_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
precision highp sampler2DShadow;

in vec3 vWorldPos;
in float vMorph;
in float vRingLevel;
in vec4 vShadowCoord;
in vec4 vFarShadowCoord;
in vec3 vBaryHint;
in float vBaseHeight;

out vec4 fragColor;

uniform sampler2D uCascade0;
uniform sampler2D uCascade1;
uniform sampler2D uSandGrainTex;
uniform sampler2D uSandMacroTex;
uniform sampler2D uMudDetailTex;
uniform vec2 uOrigin0;
uniform vec2 uOrigin1;
uniform float uSize0;
uniform float uSize1;
uniform float uGuardWorld0;
uniform float uGuardWorld1;
uniform float uMaxDepth;
uniform float uCascadeRes;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundBounceColor;
uniform vec3 uFogColor;
uniform float uFogDensity;

uniform vec2 uWindDir;
uniform float uMoisture;
uniform float uTime;
uniform float uBiomeMud;       // 0.0 = Desert Sand, 1.0 = Sloppy Wet Mud & Grass
uniform float uBiomeRainy;     // 1.0 = Rainy Rural Highway (Wet Asphalt + Potholes + Shoulders)
uniform float uRainIntensity;  // 0.0..1.0 rainfall & puddle ripple intensity
uniform int uDebugView;        // 0=Beauty, 1=Toroidal RGBA, 2=Normals RNM, 3=Wireframe Clipmap
uniform int uGlintQuality;   // 0=Quality (Deliot-Belcour deriv), 1=Performance (2-oct mip)

// Optional Three.js directional shadow maps (Cascade 0 near high-res + Cascade 1 far ±125m low-res)
uniform sampler2DShadow uShadowMap;
uniform float uShadowEnabled;
uniform float uShadowFast;
uniform vec2 uShadowMapSize;
uniform sampler2DShadow uFarShadowMap;
uniform float uFarShadowEnabled;
uniform float uRainRippleMaxDist;

// Hero vehicle pose for grounded wheel contact AO, analytical shadow & active lamp ground bounce
uniform vec3 uVehiclePos;
uniform vec2 uVehicleFwd;
uniform vec3 uVehicleFwd3D;       // Full 3D chassis forward vector (with real pitch & roll)
uniform vec3 uVehicleRight3D;     // Full 3D chassis +X axis (with real pitch & roll)
uniform vec3 uVehicleUp3D;        // Full 3D chassis +Y axis (with real pitch & roll)
uniform float uVehicleClearanceY; // Chassis height above ground (meters, > 0 during jumps/airborne)
uniform float uVehicleUpright;    // 1.0 when upright on wheels, 0.0 when rolled on side or inverted
uniform vec2 uHeadlightPower;     // x = left headlight intensity, y = right headlight intensity (0 when broken/off)
uniform vec2 uBrakeLightPower;    // x = left taillight intensity, y = right taillight intensity
uniform float uReverseLightPower; // reverse light rear wash intensity
uniform float uLinearHdrOutput;   // 1.0 when HalfFloat HDR EffectComposer is active; 0.0 for direct fallback

${COMMON_TOROIDAL_GLSL}

const float PI = 3.14159265359;

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i + vec2(0.0, 0.0)), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm2(vec2 p) {
  float v = 0.0;
  float a = 0.52;
  const mat2 m = mat2(0.80, -0.60, 0.60, 0.80);
  v += a * valueNoise(p);
  p = m * p * 2.03 + vec2(17.1, 31.7);
  a *= 0.48;
  v += a * valueNoise(p);
  return v;
}

float fbm3(vec2 p) {
  float v = 0.0;
  float a = 0.50;
  const mat2 m = mat2(0.80, -0.60, 0.60, 0.80);
  v += a * valueNoise(p);
  p = m * p * 2.04 + vec2(17.1, 31.7);
  a *= 0.50;
  v += a * valueNoise(p);
  p = m * p * 2.07 + vec2(43.2, 11.9);
  a *= 0.48;
  v += a * valueNoise(p);
  return v;
}

// Reoriented Normal Mapping (RNM) in Y-up world space
vec3 blendRNM(vec3 n1, vec3 n2) {
  vec3 t = vec3(n1.x, n1.z, n1.y + 1.0);
  vec3 u = vec3(-n2.x, -n2.z, n2.y);
  vec3 r = t * dot(t, u) / max(0.001, t.z) - u;
  return normalize(vec3(r.x, r.z, r.y));
}

// Cook-Torrance GGX wet-film specular (for realistic liquid highlights on smeared mud ridges & puddles)
float evalGGX(float NdotH, float NdotV, float NdotL, float roughness) {
  float a = clamp(roughness * roughness, 0.0025, 1.0);
  float a2 = a * a;
  float d = (NdotH * NdotH) * (a2 - 1.0) + 1.0;
  float D = a2 / max(1e-4, PI * d * d);
  float k = (roughness + 1.0);
  k = (k * k) / 8.0;
  float gV = NdotV / max(1e-3, NdotV * (1.0 - k) + k);
  float gL = NdotL / max(1e-3, NdotL * (1.0 - k) + k);
  return min(10.0, D * gV * gL / max(1e-3, 4.0 * NdotV * NdotL));
}

// Procedural overcast cloud + dark treeline horizon reflection with distance-adaptive LOD
vec3 evalOvercastCloudReflection(vec3 R, vec3 skyCol, vec3 fogCol, vec3 sunDir, float distCam) {
  float elev = clamp(R.y, 0.0, 1.0);
  vec3 skyDome;
  if (distCam > 48.0) {
    // Cheap analytic overcast gradient beyond 48m (skips 3-octave fBm + valueNoise on distant puddles)
    skyDome = mix(skyCol * 0.72, mix(skyCol * 1.05, vec3(0.72, 0.77, 0.82), 0.45), smoothstep(0.05, 0.55, elev));
  } else {
    vec2 cloudUV = R.xz / max(0.14, R.y + 0.14);
    float c1 = fbm3(cloudUV * 0.58 + vec2(2.1, 5.4));
    float c2 = distCam < 28.0 ? valueNoise(cloudUV * 1.65 - vec2(4.7, 1.8)) : 0.5;
    float cloudDensity = smoothstep(0.24, 0.78, c1 * 0.68 + c2 * 0.32);
    vec3 cloudDark = skyCol * vec3(0.20, 0.24, 0.28);
    vec3 cloudBright = mix(skyCol * 1.15, vec3(0.76, 0.81, 0.86), 0.60);
    skyDome = mix(cloudBright, cloudDark, cloudDensity * 0.84);
  }
  float sunGlow = pow(max(0.0, dot(normalize(R), sunDir)), 8.0) * 0.26;
  skyDome += vec3(0.84, 0.87, 0.90) * sunGlow;
  // Crisp dark forest reflection near horizon contrasting with broken silver cloud reflections
  float treeBand = smoothstep(0.002, 0.025, elev) * (1.0 - smoothstep(0.055, 0.16, elev));
  vec3 horizonCol = mix(vec3(0.016, 0.018, 0.014), skyDome * 0.55, 0.35);
  horizonCol = mix(horizonCol, vec3(0.010, 0.016, 0.008), treeBand * 0.88);
  return mix(horizonCol, skyDome, smoothstep(0.04, 0.22, elev));
}

// Photographic multi-scale wet mud, silt pores & pebble/loam normal + surface masks
vec3 samplePhotographicMud(
  vec2 worldXZ,
  float depression,
  float bermMass,
  float grassCover,
  float distCam,
  out float outLoamVar,
  out float outSlickMask,
  out float outGravelGrit,
  out float outFineGrain
) {
  float atten = 1.0 - smoothstep(14.0, 62.0, distCam);
  float closeAtten = 1.0 - smoothstep(4.5, 24.0, distCam);

  // Domain warp eliminates any repeating texture tiling across wide mud flats
  vec2 warp = vec2(
    valueNoise(worldXZ * 0.23 + vec2(4.1, 7.3)) - 0.5,
    valueNoise(worldXZ * 0.23 + vec2(15.7, 2.9)) - 0.5
  ) * 0.18;

  const mat2 rot37 = mat2(0.7986, -0.6018, 0.6018, 0.7986);
  vec2 uvMacro = worldXZ * 0.46 + warp;
  vec2 uvDetail = (rot37 * worldXZ) * 1.52 - warp * 0.65 + vec2(0.31, 0.74);
  vec2 uvGrain = worldXZ * 2.85 + warp * 0.25;

  vec4 mMacro = texture(uMudDetailTex, uvMacro);
  vec4 mDetail = texture(uMudDetailTex, uvDetail);
  vec3 grainTex = texture(uSandGrainTex, uvGrain).rgb;
  float grainLum = dot(grainTex, vec3(0.299, 0.587, 0.114));

  // Precompute UV screen-space derivatives in uniform control flow for seam-free textureGrad inside branches
  vec2 dUvMacroX = dFdx(uvMacro);
  vec2 dUvMacroY = dFdy(uvMacro);
  vec2 dUvDetailX = dFdx(uvDetail);
  vec2 dUvDetailY = dFdy(uvDetail);
  vec2 dUvGrainX = dFdx(uvGrain);
  vec2 dUvGrainY = dFdy(uvGrain);

  outLoamVar = mMacro.r * 0.55 + mDetail.r * 0.45;
  outSlickMask = smoothstep(0.28, 0.76, mMacro.b * 0.62 + mDetail.b * 0.38);
  outGravelGrit = mDetail.a * 0.65 + grainLum * 0.35;
  outFineGrain = grainLum;

  // Skip 6 finite-difference taps & 3 close-range fBm octaves when far from camera
  if (atten <= 0.005) {
    return vec3(0.0, 1.0, 0.0);
  }

  // Central-difference height normals from procedural mud heightfield (G) + photographic mineral grain
  float epsM = 0.0065;
  float hMx = textureGrad(uMudDetailTex, uvMacro + vec2(epsM, 0.0), dUvMacroX, dUvMacroY).g
            - textureGrad(uMudDetailTex, uvMacro - vec2(epsM, 0.0), dUvMacroX, dUvMacroY).g;
  float hMz = textureGrad(uMudDetailTex, uvMacro + vec2(0.0, epsM), dUvMacroX, dUvMacroY).g
            - textureGrad(uMudDetailTex, uvMacro - vec2(0.0, epsM), dUvMacroX, dUvMacroY).g;

  float epsD = 0.0055;
  float hDx = textureGrad(uMudDetailTex, uvDetail + vec2(epsD, 0.0), dUvDetailX, dUvDetailY).g
            - textureGrad(uMudDetailTex, uvDetail - vec2(epsD, 0.0), dUvDetailX, dUvDetailY).g;
  float hDz = textureGrad(uMudDetailTex, uvDetail + vec2(0.0, epsD), dUvDetailX, dUvDetailY).g
            - textureGrad(uMudDetailTex, uvDetail - vec2(0.0, epsD), dUvDetailX, dUvDetailY).g;

  // Tire-pressed rut floors smear smooth, while displaced berms stay lumpy/cloddy and open mud retains crisp soil grit
  float rutFloorPolish = clamp(depression * 1.9 + outSlickMask * 0.22 - bermMass * 1.1, 0.0, 1.0);
  float bermClodBoost = clamp(bermMass * 3.4, 0.0, 1.65);
  float macroAmp = (mix(0.72, 0.22, rutFloorPolish) + bermClodBoost * 0.58) * atten;
  float detailAmp = (mix(0.66, 0.16, rutFloorPolish) + bermClodBoost * 0.72) * atten * (0.90 + 0.55 * grassCover);

  vec2 gradMacro = vec2(hMx, hMz) * macroAmp;
  vec2 gradDetLocal = vec2(hDx, hDz) * detailAmp;
  vec2 gradDetWorld = vec2(
    gradDetLocal.x * 0.7986 + gradDetLocal.y * 0.6018,
    -gradDetLocal.x * 0.6018 + gradDetLocal.y * 0.7986
  );

  vec2 grad = gradMacro + gradDetWorld;
  if (closeAtten > 0.005) {
    float epsG = 0.005;
    float gRx = dot(textureGrad(uSandGrainTex, uvGrain + vec2(epsG, 0.0), dUvGrainX, dUvGrainY).rgb, vec3(0.299, 0.587, 0.114)) - grainLum;
    float gUz = dot(textureGrad(uSandGrainTex, uvGrain + vec2(0.0, epsG), dUvGrainX, dUvGrainY).rgb, vec3(0.299, 0.587, 0.114)) - grainLum;
    float grainAmp = (mix(0.54, 0.14, rutFloorPolish) + bermClodBoost * 0.62) * closeAtten * (1.0 + grassCover * 0.95);
    vec2 gradGrain = vec2(gRx, gUz) * grainAmp;

    // High-frequency soil clods, tiny mud crumbs & grassy thatch micro-breakup
    float clodBump = (fbm2(worldXZ * 16.5) - 0.5) * (0.20 + bermClodBoost * 0.48) * closeAtten;
    float crumbBump = (valueNoise(worldXZ * 38.0) - 0.5) * (0.14 + bermClodBoost * 0.24) * closeAtten;
    float turfBump = grassCover > 0.01 ? (fbm2(worldXZ * 24.0) - 0.5) * grassCover * 0.48 * closeAtten : 0.0;
    grad += gradGrain + vec2(clodBump + crumbBump + turfBump, clodBump - crumbBump - turfBump);
  }
  return normalize(vec3(-grad.x, 1.0, -grad.y));
}

// Photorealistic multi-scale Sahara quartz & mineral grain lookup (sRGB->Linear decoded, zero dark blotches, zero aliasing)
vec4 samplePhotographicSand(
  vec2 worldXZ,
  vec2 windDir,
  float distCam,
  float pixelFootprint,
  float disturbMask,
  out vec3 outPhotoNormal,
  out float outGritContrast
) {
  vec2 wPerp = vec2(-windDir.y, windDir.x);
  vec2 windSpace = vec2(dot(worldXZ, windDir), dot(worldXZ, wPerp));

  vec2 warp = vec2(
    valueNoise(worldXZ * 0.09 + vec2(3.7, 8.2)) - 0.5,
    valueNoise(worldXZ * 0.09 + vec2(19.4, 5.1)) - 0.5
  );

  // Domain-warped rotated dual-octave wind-ripple & sorted mineral grit photo sampling
  const mat2 rot29 = mat2(0.8746, -0.4848, 0.4848, 0.8746);
  vec2 uvMacroA = windSpace * 0.42 + warp * 0.22;
  vec2 uvMacroB = (rot29 * windSpace) * 0.19 + vec2(0.37, 0.71) - warp * 0.14;
  float macroPatchMix = smoothstep(0.20, 0.80, valueNoise(worldXZ * 0.075 + vec2(5.1, 9.3)));

  // Softly mip-filter coarse photo speckles beyond 4m so Chase view reads as silky wind-planed Sahara dunes
  float macroMipBias = smoothstep(2.5, 9.0, distCam) * 1.45;
  vec3 sMacroRawA = texture(uSandMacroTex, uvMacroA, macroMipBias).rgb;
  vec3 sMacroRawB = texture(uSandMacroTex, uvMacroB, macroMipBias).rgb;
  vec3 sMacroMixed = mix(sMacroRawA, sMacroRawB, 0.36 + 0.28 * macroPatchMix);
  vec3 macroLin = pow(max(sMacroMixed, vec3(0.001)), vec3(2.2));
  float lumMacro = dot(macroLin, vec3(0.299, 0.587, 0.114));

  // Dual-scale quartz & mineral grains: Mid-range (2..14m) + Ultra-close crisp individual grains (GoPro <4.5m)
  const mat2 rot41 = mat2(0.7547, -0.6561, 0.6561, 0.7547);
  vec2 uvMid = worldXZ * 2.15 + warp * 0.05;
  vec2 uvUltra = (rot41 * worldXZ) * 6.80 + vec2(0.23, 0.77);

  vec3 sMidRaw = texture(uSandGrainTex, uvMid).rgb;
  vec3 fineMidLin = pow(max(sMidRaw, vec3(0.001)), vec3(2.2));

  // Precompute UV screen-space gradients in uniform control flow for seam-free textureGrad inside branches
  float macroBiasScale = exp2(macroMipBias);
  vec2 dUvMacroX = dFdx(uvMacroA) * macroBiasScale;
  vec2 dUvMacroY = dFdy(uvMacroA) * macroBiasScale;
  vec2 dUvMidX = dFdx(uvMid);
  vec2 dUvMidY = dFdy(uvMid);
  vec2 dUvUltraX = dFdx(uvUltra);
  vec2 dUvUltraY = dFdy(uvUltra);

  float ultraWeight = 1.0 - smoothstep(1.1, 4.4, distCam);
  vec3 sUltraRaw = sMidRaw;
  vec3 fineLin = fineMidLin;
  if (ultraWeight > 0.005) {
    sUltraRaw = textureGrad(uSandGrainTex, uvUltra, dUvUltraX, dUvUltraY).rgb;
    vec3 fineUltraLin = pow(max(sUltraRaw, vec3(0.001)), vec3(2.2));
    fineLin = mix(fineMidLin, fineUltraLin, ultraWeight * 0.68);
  }
  float lumFine = dot(fineLin, vec3(0.299, 0.587, 0.114));

  // Harmonize photographic linear sand into luminous Sahara golden-terracotta quartz (never flat clay, never murky rust)
  float midTexAtten = 1.0 - smoothstep(0.045, 0.16, pixelFootprint);
  float closeColorKeep = 1.0 - smoothstep(3.2, 11.5, distCam);
  float detailKeep = clamp(midTexAtten * (0.28 + 0.72 * closeColorKeep), 0.0, 1.0);

  vec3 macroGraded = macroLin * vec3(1.16, 0.80, 0.48);
  vec3 fineGraded = fineLin * vec3(1.16, 0.86, 0.60);
  float closeGrainBlend = mix(0.26, 0.72, 1.0 - smoothstep(2.0, 11.0, distCam));
  float fineMix = clamp(mix(closeGrainBlend, max(closeGrainBlend, 0.76), 1.0 - disturbMask), 0.0, 0.92);
  vec3 photoCol = mix(macroGraded, fineGraded, fineMix);

  // Silky wind-sorted anchor blends smoothly past 8m so mid/far dunes never look peppery or grainy
  vec3 anchorSahara = vec3(0.495, 0.242, 0.098);
  float meanLum = max(0.05, dot(photoCol, vec3(0.299, 0.587, 0.114)));
  float subtleMidLum = clamp((meanLum - 0.28) * mix(0.26, 0.65, closeColorKeep), -0.10, 0.16);
  vec3 boostedPhoto = mix(anchorSahara * (1.0 + subtleMidLum * 0.45), photoCol * (0.98 + subtleMidLum), 0.22 + 0.78 * detailKeep);

  float grainLum = mix(lumMacro, lumFine, fineMix);
  outGritContrast = clamp((grainLum - 0.28) * 1.40, -0.36, 0.36);

  // Central-difference photographic RNM normals — skip distant texture fetches when faded out
  float macroNormalStr = mix(0.04, 0.32, 1.0 - smoothstep(3.0, 14.0, distCam)) * mix(0.25, 1.0, disturbMask) * midTexAtten;
  vec3 nMacroPhoto = vec3(0.0, 1.0, 0.0);
  if (macroNormalStr > 0.005) {
    float epsM = 0.008;
    float mLx = dot(textureGrad(uSandMacroTex, uvMacroA - vec2(epsM, 0.0), dUvMacroX, dUvMacroY).rgb, vec3(0.299, 0.587, 0.114));
    float mRx = dot(textureGrad(uSandMacroTex, uvMacroA + vec2(epsM, 0.0), dUvMacroX, dUvMacroY).rgb, vec3(0.299, 0.587, 0.114));
    float mDz = dot(textureGrad(uSandMacroTex, uvMacroA - vec2(0.0, epsM), dUvMacroX, dUvMacroY).rgb, vec3(0.299, 0.587, 0.114));
    float mUz = dot(textureGrad(uSandMacroTex, uvMacroA + vec2(0.0, epsM), dUvMacroX, dUvMacroY).rgb, vec3(0.299, 0.587, 0.114));
    vec2 gradWind = vec2(mRx - mLx, mUz - mDz);
    vec2 gradMacroWorld = windDir * gradWind.x + wPerp * gradWind.y;
    nMacroPhoto = normalize(vec3(-gradMacroWorld.x * macroNormalStr, 1.0, -gradMacroWorld.y * macroNormalStr));
  }

  float midGrainFade = (1.0 - smoothstep(2.5, 9.5, distCam)) * (1.0 - smoothstep(0.020, 0.065, pixelFootprint));
  float ultraGrainFade = ultraWeight * (1.0 - smoothstep(0.009, 0.030, pixelFootprint));
  vec2 gradFine = vec2(0.0);
  float epsF = 0.007;
  if (midGrainFade > 0.005) {
    float midLumRaw = dot(sMidRaw, vec3(0.299, 0.587, 0.114));
    float fRx = dot(textureGrad(uSandGrainTex, uvMid + vec2(epsF, 0.0), dUvMidX, dUvMidY).rgb, vec3(0.299, 0.587, 0.114)) - midLumRaw;
    float fUz = dot(textureGrad(uSandGrainTex, uvMid + vec2(0.0, epsF), dUvMidX, dUvMidY).rgb, vec3(0.299, 0.587, 0.114)) - midLumRaw;
    gradFine += vec2(fRx, fUz) * (0.42 * midGrainFade);
  }
  if (ultraGrainFade > 0.005) {
    float ultraLumRaw = dot(sUltraRaw, vec3(0.299, 0.587, 0.114));
    float uRx = dot(textureGrad(uSandGrainTex, uvUltra + vec2(epsF, 0.0), dUvUltraX, dUvUltraY).rgb, vec3(0.299, 0.587, 0.114)) - ultraLumRaw;
    float uUz = dot(textureGrad(uSandGrainTex, uvUltra + vec2(0.0, epsF), dUvUltraX, dUvUltraY).rgb, vec3(0.299, 0.587, 0.114)) - ultraLumRaw;
    vec2 gradUltraWorld = vec2(uRx * 0.7547 + uUz * 0.6561, -uRx * 0.6561 + uUz * 0.7547);
    gradFine += gradUltraWorld * (0.64 * ultraGrainFade);
  }

  vec3 nFinePhoto = normalize(vec3(-gradFine.x, 1.0, -gradFine.y));
  outPhotoNormal = blendRNM(nMacroPhoto, nFinePhoto);
  return vec4(boostedPhoto, clamp(grainLum * 1.45, 0.0, 1.0));
}

// Energy-Preserving Oren-Nayar (EON) diffuse BRDF (Fujii / Portsmouth 2024 / OpenPBR)
vec3 evalEONDiffuse(vec3 albedo, float roughness, vec3 N, vec3 V, vec3 L) {
  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 1e-4);
  if (NdotL <= 0.0) return vec3(0.0);

  float r = clamp(roughness, 0.0, 1.0);
  float s = dot(L, V) - NdotL * NdotV;
  float t = s > 0.0 ? max(NdotL, NdotV) : 1.0;

  const float C1 = 0.5 - 2.0 / (3.0 * PI);
  float A = 1.0 / (1.0 + C1 * r);
  float B = r * A;

  float fSS = A + B * (s / max(t, 1e-4));

  float E_L = A + B * (0.5 * (1.0 - NdotL) * (1.0 - NdotL));
  float E_V = A + B * (0.5 * (1.0 - NdotV) * (1.0 - NdotV));
  float E_avg = A + (2.0 / 3.0 - 28.0 / (15.0 * PI)) * B;
  vec3 rhoMS = (albedo * albedo) * (E_avg / max(vec3(0.05), vec3(1.0) - albedo * (1.0 - E_avg)));
  vec3 fMS = rhoMS * max(0.0, 1.0 - E_L) * max(0.0, 1.0 - E_V) / max(0.05, PI * (1.0 - E_avg));

  return (albedo * fSS + fMS * 1.05) * NdotL;
}

// 2-scale asymmetric bifurcating aeolian desert wind ripples (~34cm primary + ~12cm near-field micro)
// Strictly Nyquist band-limited with fwidth() so zero distant shimmering or corduroy moiré!
vec3 evalWindRippleNormal(
  vec2 worldXZ,
  vec2 windDir,
  float distCam,
  float distAtten,
  out float outCrest,
  out float outLeeShadow
) {
  vec2 perp = vec2(-windDir.y, windDir.x);
  float rawAlong = dot(worldXZ, windDir);
  float rawAcross = dot(worldXZ, perp);

  // Subtle natural wind-sheltered smooth pockets (~18% calm slip flats, ~82% rippling windward sand)
  float macroPatch = fbm3(vec2(rawAlong * 0.038, rawAcross * 0.022) + vec2(3.1, 7.9));
  float localDrift = fbm2(vec2(rawAlong * 0.11, rawAcross * 0.065) + vec2(12.7, 4.3));
  float patchFade = smoothstep(0.18, 0.66, macroPatch * 0.64 + localDrift * 0.36);

  if (patchFade * distAtten < 0.004) {
    outCrest = 0.0;
    outLeeShadow = 0.0;
    return vec3(0.0, 1.0, 0.0);
  }

  // Graceful long-sweeping aeolian flow warping (erg dunes never look pinched/corrugated)
  float wLarge = (fbm2(worldXZ * 0.026 + vec2(2.3, 6.1)) - 0.5) * 1.55;
  float wMed   = (fbm2(worldXZ * 0.10 + vec2(11.3, 4.7)) - 0.5) * 0.34;
  float wSmall = (valueNoise(vec2(rawAlong * 0.32, rawAcross * 0.18) + vec2(5.4, 9.2)) - 0.5) * 0.09;
  float alongA = rawAlong + wLarge + wMed + wSmall;
  float alongB = rawAlong + wLarge * 0.90 - wMed * 0.72 + (valueNoise(worldXZ * 0.16 + vec2(17.1, 2.8)) - 0.5) * 0.22;

  // Long flowing crest envelopes (crests run 3-6m smoothly before softly tapering & Y-forking)
  float envA = smoothstep(0.18, 0.74, fbm2(vec2(alongA * 0.62, rawAcross * 0.16) + vec2(4.2, 8.6)));
  float envB = smoothstep(0.18, 0.74, fbm2(vec2(alongB * 0.56, rawAcross * 0.15) + vec2(19.4, 3.1)));

  // Primary wind-ripple train (~36cm wavelength: silky clean across Chase & dune mid-ground)
  float pA = alongA * 17.2 + sin(rawAcross * 0.42 + wMed * 2.2) * 1.15;
  float pB = alongB * 14.4 - sin(rawAcross * 0.36 - wMed * 1.8) * 1.05 + 2.1;
  float primaryAA = 1.0 - smoothstep(0.65, 1.85, fwidth(pA));

  // Asymmetric sawtooth wave: gentle windward back -> crisp steeper leeward micro-face
  float asymA = pA + 0.38 * sin(pA);
  float asymB = pB + 0.35 * sin(pB);
  float hA = sin(asymA) * envA;
  float hB = sin(asymB) * envB;
  float dA = cos(asymA) * (1.0 + 0.38 * cos(pA)) * 0.155 * envA;
  float dB = cos(asymB) * (1.0 + 0.35 * cos(pB)) * 0.132 * envB;

  float forkBlend = smoothstep(0.22, 0.78, valueNoise(vec2(rawAlong * 0.16, rawAcross * 0.09) + vec2(14.2, 1.9)));
  float hPrim = mix(hA, hB, forkBlend);
  float derivPrim = mix(dA, dB, forkBlend) * primaryAA;

  // Secondary close-up micro-ripples (~12cm spacing, GoPro & foreground Chase crispness)
  float pMicro = alongA * 50.0 + sin(rawAcross * 1.15 + wSmall * 4.5) * 0.9;
  float microAA = (1.0 - smoothstep(0.55, 1.70, fwidth(pMicro))) * (1.0 - smoothstep(3.5, 10.5, distCam));
  float asymMicro = pMicro + 0.32 * sin(pMicro);
  float envMicro = smoothstep(0.28, 0.78, valueNoise(vec2(alongA * 1.6, rawAcross * 0.55) + vec2(7.1, 13.4)));
  float derivMicro = cos(asymMicro) * (1.0 + 0.32 * cos(pMicro)) * 0.088 * envMicro * microAA;

  float derivAlong = derivPrim + derivMicro;
  float derivAcross = (valueNoise(worldXZ * 1.05) - 0.5) * 0.028 * patchFade * primaryAA;

  float leeSlope = mix(-cos(asymA) * envA, -cos(asymB) * envB, forkBlend);
  outLeeShadow = clamp(smoothstep(0.18, 0.92, leeSlope) * patchFade * primaryAA, 0.0, 1.0);
  outCrest = clamp(hPrim * 0.5 + 0.5, 0.0, 1.0) * patchFade * primaryAA;

  float amp = patchFade * distAtten;
  vec2 gradXZ = (windDir * derivAlong + perp * derivAcross) * amp;
  return normalize(vec3(-gradXZ.x, 1.0, -gradXZ.y));
}

// Dry crumbly sand grains & cascading downslope avalanche streaks on pushed berms & rut walls
vec3 evalGranularBermBreakup(
  vec3 worldPos,
  vec3 macroN,
  float bermMass,
  float depression,
  float distCam,
  out float outClodShade
) {
  float atten = 1.0 - smoothstep(3.5, 16.0, distCam);
  float steepMask = clamp((1.0 - macroN.y) * 1.65, 0.0, 1.0);
  float activeMask = clamp(bermMass * 1.65 + steepMask * 0.65 + depression * 0.28, 0.0, 1.0) * atten;
  if (activeMask < 0.02) {
    outClodShade = 0.0;
    return vec3(0.0, 1.0, 0.0);
  }

  vec2 p1 = worldPos.xz * 9.5;
  vec2 p2 = worldPos.xz * 26.0;
  vec2 p3 = worldPos.xz * 62.0;
  float eps = 0.07;

  // Derivative band-limiting prevents any distant shimmer on curved tire berms
  float p2Fade = 1.0 - smoothstep(0.32, 1.25, max(length(dFdx(p2)), length(dFdy(p2))));
  float p3Fade = 1.0 - smoothstep(0.30, 1.15, max(length(dFdx(p3)), length(dFdy(p3))));

  float c0 = valueNoise(p1) * 0.54 + valueNoise(p2) * (0.30 * p2Fade) + valueNoise(p3) * (0.16 * p3Fade);
  float cx = valueNoise(p1 + vec2(eps, 0.0)) * 0.54 + valueNoise(p2 + vec2(eps * 2.0, 0.0)) * (0.30 * p2Fade) + valueNoise(p3 + vec2(eps * 3.0, 0.0)) * (0.16 * p3Fade);
  float cz = valueNoise(p1 + vec2(0.0, eps)) * 0.54 + valueNoise(p2 + vec2(0.0, eps * 2.0)) * (0.30 * p2Fade) + valueNoise(p3 + vec2(0.0, eps * 3.0)) * (0.16 * p3Fade);

  // Micro-avalanche slip striations running downslope along steep pushed berm walls
  vec2 slopeDir = normalize(macroN.xz + vec2(1e-5, 0.0));
  vec2 slopePerp = vec2(-slopeDir.y, slopeDir.x);
  float streakCoord = dot(worldPos.xz, slopePerp) * 30.0 + valueNoise(worldPos.xz * 7.2) * 2.4;
  float streakAA = 1.0 - smoothstep(0.45, 1.45, fwidth(streakCoord));
  float chuteGrad = cos(streakCoord) * smoothstep(0.04, 0.22, 1.0 - macroN.y) * streakAA * 0.14;

  vec2 grad = vec2(cx - c0, cz - c0) + slopePerp * chuteGrad;
  float amp = activeMask * mix(0.28, 0.16, uMoisture);

  outClodShade = (c0 - 0.5) * 0.34 * activeMask;
  return normalize(vec3(-grad.x * amp, 1.0, -grad.y * amp));
}

// Band-limited near-field sunlit quartz micro-glints (zero distant pixel-popping snow!)
vec3 evalQuartzGlints(
  vec2 worldXZ,
  vec3 N,
  vec3 V,
  vec3 L,
  float churnBoost,
  float distCam,
  float pixelFootprint
) {
  // Strictly fade glints out before pixels become coarser than individual silica facets
  float distFade = 1.0 - smoothstep(2.4, 10.5, distCam);
  float footprintFade = 1.0 - smoothstep(0.008, 0.028, pixelFootprint);
  float totalFade = distFade * footprintFade;
  if (totalFade <= 0.004) return vec3(0.0);

  float NdotL = max(dot(N, L), 0.0);
  if (NdotL < 0.05) return vec3(0.0);

  vec3 H = normalize(L + V);
  float NdotH = max(dot(N, H), 0.0);

  float targetCellWorld = clamp(pixelFootprint * 3.8, 0.007, 0.045);
  float logCell = log2(targetCellWorld);
  float oct0 = floor(logCell);
  float octFrac = fract(logCell);

  vec3 glintSum = vec3(0.0);
  int octaves = (uGlintQuality == 0) ? 2 : 1;

  for (int o = 0; o < 2; o++) {
    if (o >= octaves) break;
    float cellSize = pow(2.0, oct0 + float(o));
    float octWeight = (octaves == 1) ? 1.0 : ((o == 0) ? (1.0 - octFrac) : octFrac);

    vec2 p = worldXZ / cellSize;
    vec2 cell = floor(p);
    vec2 f = fract(p);

    vec2 rnd = hash22(cell + float(o) * 41.7);
    vec2 rnd2 = hash22(cell + vec2(19.1, 73.4) + float(o) * 13.0);

    // Random crystalline micro-facet orientation around surface normal
    float phi = rnd.x * 6.2831853;
    float tilt = mix(0.06, 0.42, rnd.y);
    vec3 facetLocal = normalize(vec3(cos(phi) * tilt, 1.0, sin(phi) * tilt));
    vec3 facetN = blendRNM(N, facetLocal);

    float align = max(dot(facetN, H), 0.0);
    float specSpark = pow(align, (uGlintQuality == 0) ? 42.0 : 28.0);

    vec2 centerOff = 0.25 + 0.50 * rnd2;
    float cellDist = length(f - centerOff);
    // Soft anti-aliased micro-facet lobe (never sub-pixel binary dots)
    float dotMask = smoothstep(0.46, 0.10, cellDist);

    vec3 crystalTint = mix(vec3(1.0, 0.80, 0.52), vec3(1.0, 0.94, 0.80), rnd2.y);
    glintSum += crystalTint * (specSpark * dotMask * octWeight);
  }

  float sunLit = smoothstep(0.06, 0.30, NdotL);
  float specEnvelope = 0.22 + 0.78 * pow(NdotH, 3.0);
  return glintSum * (sunLit * specEnvelope * totalFade * (0.52 + churnBoost * 0.22));
}

// 6-tap footprint-adaptive directional heightfield horizon march for silky, shimmer-free rut shadows
float evalMicroSelfShadow(
  vec2 worldXZ,
  float centerDeformH,
  vec3 sunDir,
  float distCam,
  float w0,
  float texel1,
  float pixelFootprint
) {
  if (distCam > 105.0 || sunDir.y > 0.92) return 1.0;

  vec2 horizDir = normalize(sunDir.xz + vec2(1e-5));
  float sunSlope = max(0.068, sunDir.y / max(0.14, length(sunDir.xz)));

  float occluded = 0.0;
  // Scale march step seamlessly into Cascade 1 & pixel footprint so distant shadows stay silky smooth
  float baseStep = mix(max(0.088, texel1 * 0.56), 0.052, w0);
  float stepLen = max(baseStep, pixelFootprint * 0.52);

  for (int i = 1; i <= 6; i++) {
    float fi = float(i);
    float d = stepLen * fi * (1.0 + fi * 0.22);
    vec2 sampleXZ = worldXZ + horizDir * d;
    vec4 s = sampleCascadeBlended(
      sampleXZ,
      uCascade0, uOrigin0, uSize0,
      uCascade1, uOrigin1, uSize1,
      uGuardWorld0, uGuardWorld1
    );
    float sampleH = getNetDeformHeight(s, uMaxDepth);
    float rayH = centerDeformH + d * sunSlope;
    float diff = sampleH - rayH;
    // Footprint-widened soft penumbra eliminates jagged staircase shadows on distant curved tracks
    float penumbra = 0.030 + pixelFootprint * 0.20 + fi * 0.0055;
    if (diff > 0.002) {
      occluded = max(occluded, smoothstep(0.002, penumbra, diff) * (1.0 - fi * 0.065));
    }
  }

  float fade = 1.0 - smoothstep(68.0, 105.0, distCam);
  float grazingSoft = 1.0 - smoothstep(0.22, 0.78, pixelFootprint) * 0.30;
  return 1.0 - occluded * (uBiomeMud >= 0.5 ? 0.64 : 0.84) * fade * grazingSoft;
}

// Exact continuous analytical ray-vs-OBB soft contact-hardening shadow (zero slice banding!)
float rayBoxSoftShadow(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax, float penumbraRate) {
  vec3 safeRd = vec3(
    abs(rd.x) < 1e-5 ? (rd.x < 0.0 ? -1e-5 : 1e-5) : rd.x,
    abs(rd.y) < 1e-5 ? (rd.y < 0.0 ? -1e-5 : 1e-5) : rd.y,
    abs(rd.z) < 1e-5 ? (rd.z < 0.0 ? -1e-5 : 1e-5) : rd.z
  );
  vec3 t0 = (bMin - ro) / safeRd;
  vec3 t1 = (bMax - ro) / safeRd;
  vec3 tNearV = min(t0, t1);
  vec3 tFarV  = max(t0, t1);
  float tNear = max(max(tNearV.x, tNearV.y), tNearV.z);
  float tFar  = min(min(tFarV.x,  tFarV.y),  tFarV.z);

  float inFront = smoothstep(-0.25, 0.20, tFar);
  float tBest = clamp(0.5 * (tNear + tFar), 0.0, 24.0);
  vec3 pBest = ro + rd * tBest;
  vec3 dOut = max(max(bMin - pBest, pBest - bMax), vec3(0.0));
  float missDist = length(dOut);
  float penumbra = 0.08 + tBest * penumbraRate;
  return (1.0 - smoothstep(0.0, penumbra, missDist)) * inFront;
}

// Analytical directional vehicle cast shadow + grounded 4-wheel contact occlusion
// Continuous contact-hardening golden-hour truck shadow stretching smoothly across dunes on all GPUs
float evalAnalyticalVehicleShadow(vec3 worldPos, vec3 sunDir, float shadowMapVis) {
  vec2 relGround = worldPos.xz - uVehiclePos.xz;
  float relDistSq = dot(relGround, relGround);
  // Lossless early-out: when hardware PCF shadow map is active, underBodyAO reaches 0 at
  // |gRight| > 1.54 or |gFwd| > 3.10 and wheelAO reaches 0 beyond ~2.5m (max radius < 3.6m -> r^2 < 13.0).
  // Skipping all contact math for r^2 > 16.0 eliminates 2 exp() + 4-wheel length() loop on >95% of pixels!
  if (uShadowEnabled >= 0.5 && relDistSq > 16.0) {
    return shadowMapVis;
  }

  vec2 fwd = normalize(uVehicleFwd + vec2(1e-5, 0.0));
  vec2 right = vec2(fwd.y, -fwd.x);

  float gRight = dot(relGround, right);
  float gFwd = dot(relGround, fwd);

  // Attenuate ground contact occlusion cleanly by chassis clearance above terrain & uprightness
  float clearance = max(uVehicleClearanceY, 0.0);
  float upright = clamp(uVehicleUpright, 0.0, 1.0);
  float bodyHeightFade = exp(-clearance * 1.45) * mix(0.55, 1.0, upright);
  float wheelHeightFade = upright * exp(-clearance * 2.35);

  // Soft grounded under-chassis occlusion directly beneath the Rivian R1T pickup
  vec2 dBody = max(abs(vec2(gRight, gFwd)) - vec2(0.92, 2.48), vec2(0.0));
  float underBodyAO = 1.0 - smoothstep(0.62, 0.0, length(dBody)) * (0.68 * bodyHeightFade);

  // Tight grounded 4-wheel tire contact shadows (disabled when rolled over or airborne)
  float wheelAO = 1.0;
  if (wheelHeightFade > 0.01) {
    for (int wi = 0; wi < 4; wi++) {
      float sx = (wi == 0 || wi == 2) ? 0.84 : -0.84;
      float sz = (wi < 2) ? 1.725 : -1.725;
      vec2 wd = vec2((gRight - sx) / 0.26, (gFwd - sz) / 0.46);
      wheelAO = min(wheelAO, 1.0 - smoothstep(1.28, 0.22, length(wd)) * (0.84 * wheelHeightFade));
    }
  }
  float contactVis = min(underBodyAO, wheelAO);

  // If hardware PCF shadow map is active, combine it with height-aware wheel contact grounding
  if (uShadowEnabled >= 0.5) {
    return min(shadowMapVis, mix(1.0, contactVis, 0.68));
  }

  float rayDist = max(0.0, length(relGround) - 1.2);
  float castFade = 1.0 - smoothstep(14.0, 28.0, rayDist);
  if (castFade <= 0.001) return contactVis;

  // Exact 3D ray-vs-OBB in rotated chassis space (detaches cleanly during jumps & rollovers)
  vec3 comPos = uVehiclePos + vec3(0.0, 0.86, 0.0);
  vec3 relCom = worldPos - comPos;
  vec3 ro = vec3(
    dot(relCom, uVehicleRight3D),
    clamp(dot(relCom, uVehicleUp3D) + 0.86, -10.0, 6.0),
    dot(relCom, uVehicleFwd3D)
  );
  vec3 sunClamped = normalize(vec3(sunDir.x, max(0.11, sunDir.y), sunDir.z));
  vec3 rd = normalize(vec3(
    dot(sunClamped, uVehicleRight3D),
    dot(sunClamped, uVehicleUp3D),
    dot(sunClamped, uVehicleFwd3D)
  ));

  float chassisHit = rayBoxSoftShadow(ro, rd, vec3(-0.98, 0.22, -2.85), vec3(0.98, 1.24, 2.60), 0.085);
  float cabHit     = rayBoxSoftShadow(ro, rd, vec3(-0.84, 1.18, -0.55), vec3(0.84, 1.92, 0.98), 0.095);
  float shadowDensity = max(chassisHit, cabHit * 0.94);

  float castVis = 1.0 - shadowDensity * castFade * 0.84;
  return min(contactVis, castVis);
}

// Analytical real-time vehicle lamp projection onto terrain (3D pitch/roll-aware headlights + rear brake/reverse)
vec3 evalVehicleLampTerrainLight(vec3 worldPos, vec3 N, vec3 albedo, float roughness, vec3 V) {
  float activeSum = uHeadlightPower.x + uHeadlightPower.y + uBrakeLightPower.x + uBrakeLightPower.y + uReverseLightPower;
  if (activeSum <= 0.01) return vec3(0.0);

  vec2 relXZ = worldPos.xz - uVehiclePos.xz;
  if (dot(relXZ, relXZ) > 1024.0) return vec3(0.0);

  // Transform fragment position into full 3D chassis-local space (respecting real pitch, roll, jumps & rollovers)
  vec3 comPos = uVehiclePos + vec3(0.0, 0.86, 0.0);
  vec3 relCom = worldPos - comPos;
  float localX = dot(relCom, uVehicleRight3D);
  float localY = dot(relCom, uVehicleUp3D) + 0.86;
  float localZ = dot(relCom, uVehicleFwd3D);

  vec3 accum = vec3(0.0);

  // Dual forward warm-LED Rivian stadium headlights (left at x=+0.62, right at x=-0.62, z=+2.50, y=+1.08)
  for (int i = 0; i < 2; i++) {
    float pwr = (i == 0) ? uHeadlightPower.x : uHeadlightPower.y;
    if (pwr <= 0.01) continue;
    float lx = (i == 0) ? 0.62 : -0.62;
    vec3 toP = vec3(localX - lx, localY - 1.08, localZ - 2.50);
    if (toP.z < -0.2 || toP.z > 28.0) continue;
    float dist = length(toP);
    vec3 dir = toP / max(dist, 0.05);
    // Slight downward tilt (-0.17) in chassis frame so beam pitches/rolls authentically with the truck
    vec3 beamAxis = normalize(vec3(0.0, -0.17, 1.0));
    float cosAng = dot(dir, beamAxis);
    float cone = smoothstep(0.68, 0.94, cosAng);
    float atten = 1.0 / (1.0 + dist * dist * 0.055);
    vec3 lightDirW = normalize(-(uVehicleRight3D * dir.x + uVehicleUp3D * dir.y + uVehicleFwd3D * dir.z));
    float ndl = max(dot(N, lightDirW), 0.14);
    float wetSpec = pow(max(dot(N, normalize(lightDirW + V)), 0.0), mix(42.0, 8.0, roughness)) * (1.0 - roughness) * 0.45;
    vec3 lampCol = vec3(1.18, 1.04, 0.82);
    accum += lampCol * (albedo * ndl + wetSpec) * (cone * atten * pwr * 2.15);
  }

  // Rear crimson brake light + crisp white reverse bounce onto sand/mud/puddles behind tailgate
  if (localZ < -1.8 && localZ > -10.5 && abs(localX) < 5.5) {
    for (int j = 0; j < 2; j++) {
      float bp = (j == 0) ? uBrakeLightPower.x : uBrakeLightPower.y;
      if (bp <= 0.01) continue;
      float rx = (j == 0) ? 0.78 : -0.78;
      vec3 toRear = vec3(localX - rx, localY - 1.16, localZ + 2.82);
      float d = length(toRear);
      float backCone = smoothstep(-0.15, 0.65, -toRear.z / max(d, 0.05));
      float atten = 1.0 / (1.0 + d * d * 0.42);
      vec3 redCol = vec3(1.45, 0.14, 0.06);
      accum += redCol * (albedo + vec3(0.08) * (1.0 - roughness)) * (backCone * atten * bp * 0.75);
    }
    if (uReverseLightPower > 0.01) {
      vec3 toRev = vec3(localX, localY - 1.12, localZ + 2.82);
      float d = length(toRev);
      float backCone = smoothstep(0.0, 0.72, -toRev.z / max(d, 0.05));
      float atten = 1.0 / (1.0 + d * d * 0.30);
      accum += vec3(1.15, 1.12, 1.02) * (albedo + vec3(0.10) * (1.0 - roughness)) * (backCone * atten * uReverseLightPower * 0.82);
    }
  }

  return accum;
}

// 2-Cascade Smart Distance Shadow Sampling:
//  - Cascade 0 (Near ±15..28m): crisp 4-tap or 9-tap hardware PCF around the vehicle
//  - Cascade 1 (Far ±112..128m): single ultra-cheap hardware 2x2 PCF tap blended smoothly at Cascade 0 edge
float evalShadowMapPCF(vec4 shadowCoord, vec4 farShadowCoord) {
  if (uShadowEnabled < 0.5) return 1.0;

  vec3 proj = shadowCoord.xyz / max(1e-5, shadowCoord.w);
  float nearEdge = max(abs(proj.x - 0.5), abs(proj.y - 0.5)) * 2.0;
  bool inNear = nearEdge < 0.98 && proj.z >= 0.0 && proj.z <= 1.0;

  float nearShadow = 1.0;
  if (inNear) {
    float currentDepth = proj.z - (uBiomeMud >= 0.5 ? 0.0014 : 0.0008);
    vec2 texel = (1.0 / max(vec2(1.0), uShadowMapSize)) * (uBiomeMud >= 0.5 ? 1.85 : 1.0);
    float s = 0.0;
    if (uShadowFast >= 0.5) {
      // 4-tap rotated hardware-PCF box (sampler2DShadow already filters 2x2 per tap -> 16 hw samples)
      vec2 o = texel * 0.78;
      s += texture(uShadowMap, vec3(proj.xy + vec2(-o.x, -o.y), currentDepth));
      s += texture(uShadowMap, vec3(proj.xy + vec2( o.x, -o.y), currentDepth));
      s += texture(uShadowMap, vec3(proj.xy + vec2(-o.x,  o.y), currentDepth));
      s += texture(uShadowMap, vec3(proj.xy + vec2( o.x,  o.y), currentDepth));
      s *= 0.25;
    } else {
      for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
          s += texture(uShadowMap, vec3(proj.xy + vec2(float(x), float(y)) * texel, currentDepth));
        }
      }
      s /= 9.0;
    }
    nearShadow = s;
  }

  // Fast path inside near cascade core: skip far cascade texture fetch completely!
  if (inNear && nearEdge <= 0.74) {
    return nearShadow;
  }

  float farShadow = 1.0;
  if (uFarShadowEnabled >= 0.5) {
    vec3 fProj = farShadowCoord.xyz / max(1e-5, farShadowCoord.w);
    float farEdge = max(abs(fProj.x - 0.5), abs(fProj.y - 0.5)) * 2.0;
    if (farEdge < 0.99 && fProj.z >= 0.0 && fProj.z <= 1.0) {
      float farDepth = fProj.z - (uBiomeMud >= 0.5 ? 0.0022 : 0.0016);
      float rawFar = texture(uFarShadowMap, vec3(fProj.xy, farDepth));
      float farFade = 1.0 - smoothstep(0.86, 0.99, farEdge);
      farShadow = mix(1.0, rawFar, farFade);
    }
  }

  if (!inNear) {
    return farShadow;
  }
  float cascadeBlend = smoothstep(0.74, 0.97, nearEdge);
  return mix(nearShadow, farShadow, cascadeBlend);
}

void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);
  float distCam = length(cameraPosition - vWorldPos);
  vec2 sampleXZ = vWorldPos.xz;

  // Hardware screen-space world pixel footprint (meters/pixel) for band-limited anti-shimmering
  vec2 dXZdx = dFdx(sampleXZ);
  vec2 dXZdy = dFdy(sampleXZ);
  float pixelFootprint = clamp(max(length(dXZdx), length(dXZdy)), 0.008, 0.85);

  // === RAINY RURAL HIGHWAY BIOME PIPELINE (skips ALL toroidal cascade texture fetches!) ===
  if (uBiomeRainy >= 0.5 && uDebugView != 1) {
    vec3 N_base = getBiomeTerrainNormal(sampleXZ, uBiomeRainy);
    float absX = abs(sampleXZ.x);
    float roadEdgeWarp = absX < 6.5 ? (fbm2(sampleXZ * 0.85 + vec2(3.1, 7.4)) - 0.5) * 0.16 : 0.0;
    float asphaltMask = 1.0 - smoothstep(3.46, 3.64, absX + roadEdgeWarp);
    float shoulderMask = (1.0 - asphaltMask) * (1.0 - smoothstep(4.65, 5.45, absX + roadEdgeWarp * 1.6));
    float pastureMask = clamp(1.0 - asphaltMask - shoulderMask, 0.0, 1.0);

    float nearFade = 1.0 - smoothstep(10.0, 48.0, distCam);
    float potholeMask = 0.0;
    float crackRim = 0.0;
    float puddleWater = 0.0;
    float wheelTrack = 0.0;
    float paintMask = 0.0;
    vec3 asphaltCol = vec3(0.0);

    if (asphaltMask > 0.005) {
      vec4 ph = sampleHighwayPotholeGLSL(sampleXZ);
      potholeMask = ph.y * asphaltMask;
      crackRim = ph.z * asphaltMask;
      puddleWater = ph.w * asphaltMask;

      // Fine mineral asphalt aggregate grain + longitudinal tire-polish wheel tracks
      float aggCoarse = fbm3(sampleXZ * 3.2 + vec2(1.7, 5.3));
      float aggFine = nearFade > 0.01 ? valueNoise(sampleXZ * 26.0 + vec2(8.1, 2.4)) : 0.5;
      float aggMicro = nearFade > 0.15 ? valueNoise(sampleXZ * 68.0) : 0.5;
      float roadWear = fbm2(vec2(sampleXZ.x * 0.55, sampleXZ.y * 0.08 + 4.2));

      // Wheel-track polish channels around x = +-1.55m (slightly darker, glossier wet film)
      float wheelTrackL = exp(-pow((sampleXZ.x - 1.55) / 0.72, 2.0));
      float wheelTrackR = exp(-pow((sampleXZ.x + 1.55) / 0.72, 2.0));
      wheelTrack = clamp(wheelTrackL + wheelTrackR, 0.0, 1.0);

      // Subtle longitudinal asphalt tar-crack network near pothole rims & shoulders
      float crackZone = clamp(crackRim * 1.2 + smoothstep(2.4, 3.5, absX) * 0.5, 0.0, 1.0);
      float crackDark = 0.0;
      if (crackZone > 0.01) {
        float crackLine = smoothstep(0.46, 0.50, abs(fbm3(sampleXZ * 1.45 + vec2(9.2, 2.1)) - 0.5) * 2.0);
        crackDark = (1.0 - crackLine) * crackZone;
      }

      // Painted rural highway markings (crisp solid white edges at |x|=3.22m, dashed center at x=0)
      float edgeLineDist = abs(absX - 3.22);
      float edgeLine = (1.0 - smoothstep(0.052, 0.072, edgeLineDist)) * asphaltMask;
      float centerX = 1.0 - smoothstep(0.044, 0.062, absX);
      float dashCycle = fract(sampleXZ.y / 6.8);
      float centerDash = centerX * step(0.14, dashCycle) * (1.0 - step(0.47, dashCycle)) * asphaltMask;
      float rawPaint = max(edgeLine, centerDash);
      if (rawPaint > 0.005) {
        float paintWear = smoothstep(0.18, 0.76, fbm2(sampleXZ * 3.8 + vec2(1.3, 6.9)));
        paintMask = rawPaint * (1.0 - potholeMask * 0.92) * mix(0.76, 1.0, paintWear);
      }

      // Asphalt base linear albedo (dark wet slate-charcoal, matching Images 1, 2, 3)
      vec3 asphaltDark = vec3(0.022, 0.024, 0.028);
      vec3 asphaltMid  = vec3(0.044, 0.047, 0.052);
      asphaltCol = mix(asphaltDark, asphaltMid, aggCoarse * 0.62 + roadWear * 0.38);
      asphaltCol *= mix(0.84, 1.14, aggFine * 0.65 + aggMicro * 0.35);
      asphaltCol = mix(asphaltCol, asphaltDark * 0.78, wheelTrack * 0.38);
      vec3 brokenEdgeCol = vec3(0.014, 0.013, 0.012) * mix(0.75, 1.25, aggFine);
      asphaltCol = mix(asphaltCol, brokenEdgeCol, clamp(crackRim * 0.90 + crackDark * 0.55, 0.0, 0.92));
      vec3 potholeFloorCol = vec3(0.008, 0.009, 0.010);
      asphaltCol = mix(asphaltCol, potholeFloorCol, potholeMask * 0.94);
      vec3 paintCol = vec3(0.46, 0.48, 0.50);
      asphaltCol = mix(asphaltCol, paintCol, paintMask * 0.88);
    }

    // Muddy damp gravel/earth shoulder (3.55..5.15m) — only evaluated when shoulderMask > 0
    vec3 shoulderCol = vec3(0.0);
    float shPuddle = 0.0;
    if (shoulderMask > 0.005) {
      float shNoise = fbm3(sampleXZ * 1.65 + vec2(4.7, 2.9));
      float pebble = nearFade > 0.01 ? valueNoise(sampleXZ * 19.0) : 0.5;
      vec3 wetEarth = vec3(0.068, 0.048, 0.030);
      vec3 dampGravel = vec3(0.115, 0.088, 0.060);
      shoulderCol = mix(wetEarth, dampGravel, shNoise) * mix(0.80, 1.18, pebble);
      shPuddle = smoothstep(0.62, 0.85, fbm2(sampleXZ * 0.55 + vec2(2.2, 8.8))) * shoulderMask;
      shoulderCol *= mix(1.0, 0.42, shPuddle);
    }

    // Dry pale winter/autumn rural grass & flat paddock floor — only evaluated when pastureMask > 0
    vec3 pastureCol = vec3(0.0);
    if (pastureMask > 0.005) {
      float padMacro = fbm3(sampleXZ * 0.14 + vec2(6.1, 3.3));
      float padTuft = nearFade > 0.01 ? fbm2(sampleXZ * 2.8 + vec2(1.9, 7.5)) : 0.5;
      float padBlade = nearFade > 0.05 ? valueNoise(sampleXZ * 18.0) : 0.5;
      vec3 dryStraw = vec3(0.175, 0.148, 0.102);
      vec3 mutedSage = vec3(0.112, 0.105, 0.072);
      vec3 dampSoil = vec3(0.062, 0.049, 0.034);
      pastureCol = mix(mutedSage, dryStraw, padMacro * 0.65 + padTuft * 0.35);
      pastureCol = mix(pastureCol, dampSoil, smoothstep(0.55, 0.92, valueNoise(sampleXZ * 1.1)) * 0.34);
      pastureCol *= mix(0.76, 1.22, padBlade);
    }

    vec3 albedo = asphaltCol * asphaltMask + shoulderCol * shoulderMask + pastureCol * pastureMask;

    // Animated raindrop concentric ripple normals ONLY on wet asphalt & puddles within adaptive distance
    float waterSheet = max(puddleWater, shPuddle * 0.72);
    vec2 rainRippleGrad = vec2(0.0);
    if (distCam < uRainRippleMaxDist && uRainIntensity > 0.05 && (asphaltMask > 0.02 || waterSheet > 0.02)) {
      float ripFade = (1.0 - smoothstep(uRainRippleMaxDist * 0.42, uRainRippleMaxDist, distCam)) * uRainIntensity;
      vec2 rGrid = sampleXZ * 2.4;
      vec2 rCell = floor(rGrid);
      vec2 rFrac = fract(rGrid);
      bool skipCorners = distCam > 13.0;
      for (int ox = -1; ox <= 1; ox++) {
        for (int oy = -1; oy <= 1; oy++) {
          if (skipCorners && ox != 0 && oy != 0) continue;
          vec2 c = rCell + vec2(float(ox), float(oy));
          vec2 rnd = hash22(c + vec2(17.3, 41.9));
          float tPhase = fract(uTime * (0.95 + rnd.x * 0.65) + rnd.y);
          vec2 d = (vec2(float(ox), float(oy)) + (0.2 + 0.6 * rnd)) - rFrac;
          float distR = length(d);
          float ringR = tPhase * 0.68;
          float env = exp(-abs(distR - ringR) * 18.0) * (1.0 - tPhase) * smoothstep(0.02, 0.12, distR);
          float wave = sin((distR - ringR) * 44.0) * env;
          rainRippleGrad += normalize(d + vec2(1e-4)) * wave * ripFade;
        }
      }
    }

    // Surface micro-normal: skip near-field noise taps when faded out or off-road
    float bumpScale = mix(0.085, 0.022, wheelTrack) * nearFade * asphaltMask;
    float crackBump = (crackRim > 0.01 && nearFade > 0.01) ? (fbm2(sampleXZ * 14.0) - 0.5) * crackRim * 0.42 * nearFade : 0.0;
    float offroadBump = (asphaltMask < 0.99 && nearFade > 0.01) ? (fbm2(sampleXZ * 8.5) - 0.5) * (1.0 - asphaltMask) * 0.28 * nearFade : 0.0;
    vec2 microGrad = vec2(crackBump + offroadBump, -crackBump + offroadBump);
    if (bumpScale > 0.001) {
      microGrad.x += (valueNoise(sampleXZ * 32.0 + vec2(0.1, 0.0)) - valueNoise(sampleXZ * 32.0 - vec2(0.1, 0.0))) * bumpScale;
      microGrad.y += (valueNoise(sampleXZ * 32.0 + vec2(0.0, 0.1)) - valueNoise(sampleXZ * 32.0 - vec2(0.0, 0.1))) * bumpScale;
    }
    vec2 rippleFinal = rainRippleGrad * mix(0.012 * asphaltMask, 0.048, waterSheet);
    vec3 N_micro = normalize(vec3(-(microGrad.x * (1.0 - waterSheet * 0.92) + rippleFinal.x), 1.0, -(microGrad.y * (1.0 - waterSheet * 0.92) + rippleFinal.y)));
    vec3 N = blendRNM(N_base, N_micro);
    if (waterSheet > 0.05) {
      vec3 N_flatWater = normalize(vec3(-rippleFinal.x, 1.0, -rippleFinal.y));
      N = normalize(mix(N, N_flatWater, waterSheet * 0.92));
    }

    if (uDebugView == 2) {
      vec3 nCol = N * 0.5 + 0.5;
      float fogT = 1.0 - exp(-pow(distCam * uFogDensity, 2.0));
      fragColor = vec4(mix(nCol, uFogColor, clamp(fogT, 0.0, 1.0)), 1.0);
      return;
    }

    // Wet roughness: 0.020 on pothole water, 0.09..0.19 wet sheen asphalt (shinier in wheel tracks), 0.72..0.94 off-road
    float rainWet = clamp(0.42 + uRainIntensity * 0.58, 0.0, 1.0);
    float asphaltRough = mix(0.32, mix(0.165, 0.085, wheelTrack), rainWet);
    asphaltRough = mix(asphaltRough, 0.42, crackRim * 0.75);
    asphaltRough = mix(asphaltRough, 0.24, paintMask * 0.45);
    float offroadRough = mix(0.68, 0.92, pastureMask);
    float baseRough = mix(offroadRough, asphaltRough, asphaltMask);
    float roughness = mix(baseRough, 0.018, waterSheet);

    vec3 L = uSunDir;
    float shadowMapVis = evalShadowMapPCF(vShadowCoord, vFarShadowCoord);
    float vehicleShadowVis = evalAnalyticalVehicleShadow(vWorldPos, L, shadowMapVis);
    float shadowVis = vehicleShadowVis;

    vec3 directDiffuse = evalEONDiffuse(albedo, roughness, N, V, L) * uSunColor * 0.82 * mix(0.42, 1.0, shadowVis);
    float hemiT = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 indirectLight = mix(uGroundBounceColor * 0.65, uSkyColor * 0.86, hemiT) * albedo * 0.64;

    // Wet Fresnel sky/mist/treeline reflection with smart distance LOD (full detail near, analytic far)
    vec3 H = normalize(L + V);
    float NdotH = max(dot(N, H), 0.0);
    float NdotV = max(dot(N, V), 1e-3);
    float NdotL = max(dot(N, L), 0.0);

    float F0 = mix(0.028, 0.022, waterSheet);
    float oneMinusNV = clamp(1.0 - NdotV, 0.0, 1.0);
    float wetFresnel = F0 + (1.0 - F0) * pow(oneMinusNV, 4.6);
    float ggx = evalGGX(NdotH, NdotV, NdotL, roughness);
    vec3 sunSpec = uSunColor * (ggx * wetFresnel * NdotL * shadowVis * mix(0.12, 0.95, asphaltMask) * 0.55);

    vec3 R = reflect(-V, N);
    // Mist-brightened overcast sky reflection with eucalyptus dark canopy band on left (+X)
    vec3 mistSkyRefl = mix(uFogColor * 1.12, uSkyColor * 1.24, smoothstep(0.0, 0.35, max(0.0, R.y)));
    float leftCanopyRefl = smoothstep(0.6, 3.5, sampleXZ.x) * (1.0 - smoothstep(0.08, 0.32, max(0.0, R.y)));
    if (leftCanopyRefl > 0.002) {
      float canopyNoise = distCam < 54.0
        ? (0.55 + 0.45 * fbm2(vec2(sampleXZ.y * 0.14, sampleXZ.x * 0.45)))
        : 0.77;
      mistSkyRefl = mix(mistSkyRefl, vec3(0.08, 0.09, 0.08), leftCanopyRefl * canopyNoise * 0.52);
    }

    // Subtle warm sunrise rose/peach reflection streak along left wheel track (exact Image 2 signature!)
    float laneDx = (sampleXZ.x - 1.55) / 1.18;
    float warmLaneBand = exp(-(laneDx * laneDx)) * asphaltMask;
    float grazingView = pow(oneMinusNV, 1.65);
    vec3 warmMorningGlow = vec3(1.18, 0.78, 0.58) * (warmLaneBand * grazingView * 0.88 * rainWet);
    mistSkyRefl += warmMorningGlow;

    // Grounded dark vehicle reflection silhouette on wet asphalt right beneath the Raptor (Image 3!)
    float vehReflOcc = 1.0;
    vec2 relVeh = sampleXZ - uVehiclePos.xz;
    if (dot(relVeh, relVeh) < 16.0) {
      vec2 vFwd = normalize(uVehicleFwd + vec2(1e-5, 0.0));
      vec2 vRight = vec2(vFwd.y, -vFwd.x);
      float vLocalX = dot(relVeh, vRight);
      float vLocalZ = dot(relVeh, vFwd);
      vec2 vehBoxD = max(abs(vec2(vLocalX, vLocalZ)) - vec2(1.02, 2.45), vec2(0.0));
      vehReflOcc = 1.0 - smoothstep(0.85, 0.0, length(vehBoxD)) * 0.78 * exp(-max(0.0, uVehicleClearanceY) * 1.5);
    }

    // Keep broken pothole collar dark & rough while puddle interior mirrors the cold misty sky sharply
    float distReflLod = 1.0 - smoothstep(26.0, 82.0, distCam) * 0.34;
    float glossWeight = mix(0.04, mix(0.84, 1.12, waterSheet), max(asphaltMask * rainWet, waterSheet)) * distReflLod;
    glossWeight *= (1.0 - crackRim * 0.75);
    float surfGloss = pow(1.0 - clamp(roughness, 0.0, 0.85), 1.40);
    vec3 wetReflect = mistSkyRefl * (wetFresnel * glossWeight * surfGloss * mix(0.45, 1.0, shadowVis) * vehReflOcc);

    vec3 lampLight = evalVehicleLampTerrainLight(vWorldPos, N, albedo, roughness, V);
    vec3 color = directDiffuse + indirectLight + sunSpec + wetReflect + lampLight;

    if (uDebugView == 3) {
      vec2 cellFrac = abs(fract(vBaryHint.xy) - 0.5);
      float wireLine = smoothstep(0.44, 0.5, max(cellFrac.x, cellFrac.y));
      vec3 ringPalette = 0.5 + 0.5 * cos(vec3(0.0, 2.09, 4.18) + vRingLevel * 0.85);
      color = mix(color * 0.72, ringPalette, wireLine * 0.82);
    }

    // Thick cold misty morning fog (fades distant highway into soft pearl-grey mist like Images 1 & 2)
    float fogFactor = 1.0 - exp(-pow(distCam * uFogDensity, 1.65));
    color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

    if (uLinearHdrOutput < 0.5) {
      color *= 1.0;
      color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
      color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));
    }

    fragColor = vec4(color, 1.0);
    return;
  }

  // Toroidal cascade state (evaluated only for deformable Sand / Mud biomes or Debug View 1)
  float w0 = computeCascadeWeight(sampleXZ, uOrigin0, uSize0, uGuardWorld0);
  float w1 = computeCascadeWeight(sampleXZ, uOrigin1, uSize1, uGuardWorld1);
  bool inCascade = (w0 > 0.001 || w1 > 0.001);
  vec4 state = inCascade ? sampleCascadeBlended(
    sampleXZ,
    uCascade0, uOrigin0, uSize0,
    uCascade1, uOrigin1, uSize1,
    uGuardWorld0, uGuardWorld1
  ) : vec4(0.0);

  float depression = state.r;
  float bermMass = state.g;
  float compression = state.b;
  float microImprint = state.a;
  float centerDeformH = getNetDeformHeight(state, uMaxDepth);

  // Debug View 1: Toroidal RGBA Inspector
  if (uDebugView == 1) {
    vec3 dbg = vec3(depression * 1.45, bermMass * 1.6, compression * 1.25);
    dbg += vec3(0.25, 0.18, 0.05) * max(0.0, microImprint) * 0.5;
    float border0 = smoothstep(0.05, 0.0, abs(w0 - 0.5));
    vec2 uvGrid = abs(fract(sampleXZ / 2.0) - 0.5);
    float grid = smoothstep(0.47, 0.5, max(uvGrid.x, uvGrid.y)) * 0.15;
    vec3 baseTint = vec3(0.09, 0.08, 0.075) + grid;
    vec3 col = mix(baseTint, dbg + baseTint * 0.35, clamp(depression + bermMass + compression, 0.0, 1.0));
    col = mix(col, vec3(0.95, 0.65, 0.2), border0 * 0.7);
    float fogT = 1.0 - exp(-pow(distCam * uFogDensity, 2.0));
    fragColor = vec4(mix(col, uFogColor, clamp(fogT, 0.0, 1.0)), 1.0);
    return;
  }

  // Disturbance mask: 1 = undisturbed natural floor, 0 = freshly tracked / berms
  float disturbMask = 1.0 - clamp(compression * 1.45 + bermMass * 1.85 + depression * 1.15, 0.0, 1.0);
  vec3 N_base = getBiomeTerrainNormal(sampleXZ, uBiomeRainy);

  float cascadeRes = max(64.0, uCascadeRes);
  float texel0 = uSize0 / cascadeRes;
  float texel1 = uSize1 / cascadeRes;
  float sampleStep = mix(texel1 * 0.72, texel0 * 1.22, w0);

  // === SLOPPY WET MUD & GRASS BIOME PIPELINE (photorealistic warm earthy loam + puddles) ===
  if (uBiomeMud >= 0.5) {
    float rawGrassZone = getMudGrassZoneMask(sampleXZ);
    float tearMud = smoothstep(0.025, 0.14, depression + bermMass * 0.8 + compression * 0.35);
    float grassCover = rawGrassZone * (1.0 - tearMud);

    // Footprint-filtered smooth viscous mud deform normals (skip 4 cascade taps outside active cascade bounds)
    vec3 N_deformMud = vec3(0.0, 1.0, 0.0);
    float cavityAO = 1.0;
    if (inCascade) {
      float mudStep = max(sampleStep * 1.80, pixelFootprint * 0.72);
      vec4 mL = sampleCascadeBlended(sampleXZ - vec2(mudStep, 0.0), uCascade0, uOrigin0, uSize0, uCascade1, uOrigin1, uSize1, uGuardWorld0, uGuardWorld1);
      vec4 mR = sampleCascadeBlended(sampleXZ + vec2(mudStep, 0.0), uCascade0, uOrigin0, uSize0, uCascade1, uOrigin1, uSize1, uGuardWorld0, uGuardWorld1);
      vec4 mD = sampleCascadeBlended(sampleXZ - vec2(0.0, mudStep), uCascade0, uOrigin0, uSize0, uCascade1, uOrigin1, uSize1, uGuardWorld0, uGuardWorld1);
      vec4 mU = sampleCascadeBlended(sampleXZ + vec2(0.0, mudStep), uCascade0, uOrigin0, uSize0, uCascade1, uOrigin1, uSize1, uGuardWorld0, uGuardWorld1);
      float mhL = getNetDeformHeight(mL, uMaxDepth);
      float mhR = getNetDeformHeight(mR, uMaxDepth);
      float mhD = getNetDeformHeight(mD, uMaxDepth);
      float mhU = getNetDeformHeight(mU, uMaxDepth);

      float mudImprintDepth = 0.0020 * (1.0 - smoothstep(12.0, 30.0, distCam));
      float dhdx = clamp(((mhR - mhL) + (mR.a - mL.a) * mudImprintDepth) / (2.0 * mudStep), -1.35, 1.35);
      float dhdz = clamp(((mhU - mhD) + (mU.a - mD.a) * mudImprintDepth) / (2.0 * mudStep), -1.35, 1.35);
      N_deformMud = normalize(vec3(-dhdx * 1.02, 1.0, -dhdz * 1.02));

      float laplacian = (mhL + mhR + mhD + mhU - 4.0 * centerDeformH) / max(1e-4, mudStep * mudStep);
      cavityAO = clamp(1.0 - max(0.0, laplacian * 0.090) - depression * 0.48, 0.18, 1.0);
    }

    float loamVar;
    float slickMask;
    float siltGrit;
    float fineGrain;
    vec3 N_mudMicro = samplePhotographicMud(
      sampleXZ,
      depression,
      bermMass,
      grassCover,
      distCam,
      loamVar,
      slickMask,
      siltGrit,
      fineGrain
    );
    vec3 N_macroMud = blendRNM(N_base, N_deformMud);
    vec3 N_mud = blendRNM(N_macroMud, N_mudMicro);

    // Organic irregular rainwater puddles with crisp wet shoreline + water pooling inside deep rut troughs
    float flatBottomMask = smoothstep(0.86, 0.982, N_macroMud.y);
    float hollow = getMudHollowFactorWithBaseH(sampleXZ, vBaseHeight);
    float shoreNoise = (fbm3(sampleXZ * 1.75 + vec2(5.1, 2.7)) - 0.5) * 0.32;
    float rutPool = smoothstep(0.11, 0.34, depression) * smoothstep(0.18, 0.015, bermMass);
    float bermCut = smoothstep(0.06, 0.0, bermMass);
    float grassCut = smoothstep(0.22, 0.02, rawGrassZone);
    float puddleRangeFade = 1.0 - smoothstep(26.0, 56.0, distCam) * 0.62;
    float hollowSignal = clamp(hollow * 1.15 + shoreNoise * 0.40, 0.0, 1.0) * flatBottomMask * bermCut * grassCut * puddleRangeFade;
    float rutWaterSignal = rutPool * smoothstep(0.76, 0.96, N_macroMud.y) * grassCut * (0.82 + 0.18 * valueNoise(sampleXZ * 2.6));
    float waterSignal = max(hollowSignal, rutWaterSignal);
    float puddleMask = smoothstep(0.36, 0.48, waterSignal);
    float puddleMeniscus = smoothstep(0.16, 0.37, waterSignal) * (1.0 - puddleMask);

    // Rainwater surface with fine wind capillary ripples for crisp broken mirror reflections
    vec3 N_puddle = normalize(vec3(
      sin(sampleXZ.x * 22.0 + sampleXZ.y * 13.0 + uTime * 1.4) * 0.0085
        + (valueNoise(sampleXZ * 6.5) - 0.5) * 0.0095,
      1.0,
      cos(sampleXZ.y * 19.0 - sampleXZ.x * 15.0 + uTime * 1.1) * 0.0085
        + (valueNoise(sampleXZ * 6.5 + vec2(4.2, 9.1)) - 0.5) * 0.0095
    ));
    vec3 N = normalize(mix(N_mud, N_puddle, puddleMask * 0.97));

    if (uDebugView == 2) {
      vec3 nCol = N * 0.5 + 0.5;
      float fogT = 1.0 - exp(-pow(distCam * uFogDensity, 2.0));
      fragColor = vec4(mix(nCol, uFogColor, clamp(fogT, 0.0, 1.0)), 1.0);
      return;
    }

    // Photorealistic warm earthy umber mud + textured wild olive-moss pasture floor
    // Skip turf-only procedural octaves on pure mud/puddles and skip berm clod octaves where bermMass == 0
    float wetPatch = smoothstep(0.22, 0.76, fbm3(sampleXZ * 0.34 + vec2(11.2, 4.7)));
    float oldTrackHint = smoothstep(0.55, 0.92, fbm2(vec2(sampleXZ.x * 0.28 + sin(sampleXZ.y * 0.18) * 1.4, sampleXZ.y * 0.08)));
    float bermClodNoise = (bermMass > 0.002) ? fbm2(sampleXZ * 13.5 + vec2(6.2, 1.8)) : 0.5;
    float pebbleMicro = valueNoise(sampleXZ * 34.0);

    vec3 deepWetRutMud   = vec3(0.015, 0.010, 0.006); // deep saturated warm espresso mud in ruts
    vec3 moistSmearedMud = vec3(0.056, 0.038, 0.022); // rich warm earthy brown wet mud
    vec3 siltyShoulder   = vec3(0.080, 0.057, 0.035); // slightly drier taupe-brown edge near grass
    vec3 darkTopsoil     = vec3(0.011, 0.009, 0.005); // dark humic earth under grass roots
    vec3 meadowTurf      = darkTopsoil;
    if (grassCover > 0.002) {
      float patchMacro = fbm3(sampleXZ * 0.16 + vec2(3.4, 9.1));
      float meadowVar = fbm3(sampleXZ * 0.42 + vec2(8.7, 2.3));
      float turfFiber = fbm2(sampleXZ * 6.5 + vec2(2.3, 8.1));
      float bladeStubble = valueNoise(sampleXZ * 22.0);
      float thatchMicro = fbm2(sampleXZ * 26.0);
      float midClumpAO = mix(1.0, 0.56 + 0.44 * fbm3(sampleXZ * 1.12 + vec2(1.9, 6.3)), smoothstep(14.0, 44.0, distCam));
      meadowTurf = mix(vec3(0.009, 0.019, 0.004), vec3(0.026, 0.041, 0.008), patchMacro * 0.50 + meadowVar * 0.50);
      meadowTurf = mix(meadowTurf, vec3(0.042, 0.038, 0.011), smoothstep(0.54, 0.88, turfFiber) * 0.34);
      meadowTurf *= mix(0.64, 1.24, bladeStubble) * midClumpAO;
      meadowTurf = mix(meadowTurf, darkTopsoil, smoothstep(0.36, 0.84, thatchMicro) * 0.58);
    }

    float shoulderT = smoothstep(0.04, 0.48, rawGrassZone) * (1.0 - tearMud);
    vec3 baseMudAlbedo = mix(moistSmearedMud, siltyShoulder, shoulderT * 0.58);
    baseMudAlbedo = mix(baseMudAlbedo, deepWetRutMud * 1.38, (wetPatch * 0.44 + slickMask * 0.24 + oldTrackHint * 0.16));
    baseMudAlbedo *= mix(0.68, 1.24, loamVar);
    baseMudAlbedo *= mix(0.82, 1.16, siltGrit);
    baseMudAlbedo *= mix(0.86, 1.12, fineGrain);
    baseMudAlbedo *= mix(0.86, 1.16, pebbleMicro);

    // Sheared ruts & compacted mud grooves expose darker water-logged subsurface clay
    float wetSheared = clamp(depression * 2.25 + compression * 0.94, 0.0, 1.0);
    vec3 mudAlbedo = mix(baseMudAlbedo, deepWetRutMud, wetSheared * 0.84);

    // Displaced mud berm crests catch clumpy mottled earthy brown tones
    vec3 bermClodCol = moistSmearedMud * mix(0.64, 1.32, bermClodNoise);
    mudAlbedo = mix(mudAlbedo, bermClodCol, clamp(bermMass * 0.92, 0.0, 0.60) * (1.0 - wetSheared * 0.40));

    // Subtle longitudinal sheared mud smear striations inside grooves
    mudAlbedo *= (1.0 + clamp(microImprint, -1.0, 1.0) * 0.035);

    // Blend seamlessly into dark soil -> fibrous organic moss/thatch grass floor under grass tufts
    vec3 meadowTornSoil = darkTopsoil * mix(0.82, 1.16, loamVar);
    mudAlbedo = mix(mudAlbedo, meadowTornSoil, smoothstep(0.22, 0.62, rawGrassZone));
    vec3 grassFloor = mix(darkTopsoil, meadowTurf, smoothstep(0.16, 0.68, grassCover));
    vec3 albedo = mix(mudAlbedo, grassFloor, grassCover);

    // Turbid dark brown rainwater bed beneath sharp wet shoreline
    vec3 turbidWaterTint = mix(albedo * 0.42, vec3(0.008, 0.006, 0.004), 0.62);
    albedo = mix(albedo * mix(1.0, 0.36, puddleMeniscus), turbidWaterTint, puddleMask * 0.92);

    // Wetness roughness: 0.09-0.22 satin clay sheen on sheared mud, rougher 0.30-0.46 cloddy berms, 0.015 on puddles
    float mudWetness = clamp(
      wetSheared * 0.92 + bermMass * 0.32 + slickMask * 0.46 + wetPatch * 0.34 + puddleMeniscus * 0.86 + uMoisture * 0.28,
      0.0,
      1.0
    ) * (1.0 - smoothstep(0.32, 0.75, rawGrassZone) * 0.74);
    float mudRough = mix(0.46, 0.09, mudWetness);
    mudRough = mix(mudRough, 0.38, clamp(bermMass * 1.4, 0.0, 0.55) * (1.0 - bermClodNoise * 0.45));
    float surfRough = mix(mudRough, 0.96, grassCover);
    float roughness = mix(surfRough, 0.015, puddleMask);

    vec3 L = uSunDir;
    float shadowMapVis = evalShadowMapPCF(vShadowCoord, vFarShadowCoord);
    float microShadowVis = inCascade ? evalMicroSelfShadow(sampleXZ, centerDeformH, L, distCam, w0, texel1, pixelFootprint) : 1.0;
    float shadowVis = min(shadowMapVis, microShadowVis);

    vec3 shadowTint = mix(vec3(0.34, 0.35, 0.38), vec3(1.0), shadowVis);
    vec3 directDiffuse = evalEONDiffuse(albedo, roughness, N, V, L) * uSunColor * 1.02 * shadowTint;

    float hemiT = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 indirectLight = mix(uGroundBounceColor * 0.76, uSkyColor * 0.68, hemiT) * albedo * (0.48 * cavityAO);

    // Cook-Torrance GGX Specular + True Physical Water Fresnel (microfacet grazing attenuation keeps distant mud earthy)
    vec3 H = normalize(L + V);
    float NdotH = max(dot(N, H), 0.0);
    float NdotV = max(dot(N, V), 1e-3);
    float NdotL = max(dot(N, L), 0.0);

    float F0 = mix(0.025, 0.020, puddleMask);
    float omNV = clamp(1.0 - NdotV, 0.0, 1.0);
    float omNV2 = omNV * omNV;
    float wetFresnel = F0 + (1.0 - F0) * (omNV2 * omNV2 * omNV);
    float grazingRoughAtten = mix(smoothstep(0.05, 0.34, NdotV), 1.0, puddleMask);
    float wetSpecMask = mix(1.0, 0.02, grassCover);
    float rutSheenBoost = 1.0 + smoothstep(0.08, 0.36, depression) * (1.0 - smoothstep(14.0, 32.0, distCam)) * 0.65;
    float ggx = evalGGX(NdotH, NdotV, NdotL, roughness);
    vec3 sunSpec = uSunColor * (ggx * wetFresnel * NdotL * shadowVis * wetSpecMask * 0.68 * rutSheenBoost);

    // Localized overcast sky + treeline reflection on wet sheared ridges & rainwater puddles
    vec3 R = reflect(-V, N);
    vec3 envReflect = evalOvercastCloudReflection(R, uSkyColor, uFogColor, L, distCam);
    float glossCurve = pow(1.0 - clamp(roughness, 0.0, 0.85), 1.95);
    float nearFilmFade = 1.0 - smoothstep(18.0, 44.0, distCam) * 0.72;
    float filmReflect = mix(0.06, 0.44, mudWetness) * glossCurve * nearFilmFade * grazingRoughAtten * (1.0 - grassCover * 0.97) * rutSheenBoost;
    float puddleReflect = mix(filmReflect, 0.82 * (1.0 - smoothstep(30.0, 68.0, distCam) * 0.48), puddleMask);
    vec3 skyMirror = envReflect * (wetFresnel * puddleReflect * mix(0.55, 1.0, shadowVis) * mix(0.76, 1.0, cavityAO));

    vec3 lampLight = evalVehicleLampTerrainLight(vWorldPos, N, albedo, roughness, V);
    vec3 color = directDiffuse * mix(1.0, cavityAO, 0.88) + indirectLight + sunSpec + skyMirror + lampLight;

    if (uDebugView == 3) {
      vec2 cellFrac = abs(fract(vBaryHint.xy) - 0.5);
      float wireLine = smoothstep(0.44, 0.5, max(cellFrac.x, cellFrac.y));
      vec3 ringPalette = 0.5 + 0.5 * cos(vec3(0.0, 2.09, 4.18) + vRingLevel * 0.85);
      color = mix(color * 0.72, ringPalette, wireLine * 0.82);
    }

    float mudFogDist = distCam * uFogDensity;
    float fogFactor = 1.0 - exp(-(mudFogDist * mudFogDist));
    color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

    if (uLinearHdrOutput < 0.5) {
      color *= 1.0;
      color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
      color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));
    }

    fragColor = vec4(color, 1.0);
    return;
  }

  // === PHOTOREALISTIC SAHARA QUARTZ SAND SAMPLE ===
  vec3 N_photoGrain;
  float gritContrast;
  vec4 photoSample = samplePhotographicSand(
    sampleXZ,
    uWindDir,
    distCam,
    pixelFootprint,
    disturbMask,
    N_photoGrain,
    gritContrast
  );
  vec3 grainLinearAlbedo = photoSample.rgb;
  float grainLum = photoSample.a;

  // Band-limited footprint-filtered sand deform normals (skip 4 cascade taps outside active cascades):
  float crumble = mix(0.48, 0.88, uMoisture) * (0.78 + 0.34 * grainLum);
  vec3 N_deform = vec3(0.0, 1.0, 0.0);
  float cavityAO = 1.0;
  if (inCascade) {
    float baseSandStep = mix(texel1 * 0.82, texel0 * 1.42, w0);
    float sandStep = max(baseSandStep, pixelFootprint * 0.68);
    vec4 dL = sampleCascadeBlended(sampleXZ - vec2(sandStep, 0.0), uCascade0, uOrigin0, uSize0, uCascade1, uOrigin1, uSize1, uGuardWorld0, uGuardWorld1);
    vec4 dR = sampleCascadeBlended(sampleXZ + vec2(sandStep, 0.0), uCascade0, uOrigin0, uSize0, uCascade1, uOrigin1, uSize1, uGuardWorld0, uGuardWorld1);
    vec4 dD = sampleCascadeBlended(sampleXZ - vec2(0.0, sandStep), uCascade0, uOrigin0, uSize0, uCascade1, uOrigin1, uSize1, uGuardWorld0, uGuardWorld1);
    vec4 dU = sampleCascadeBlended(sampleXZ + vec2(0.0, sandStep), uCascade0, uOrigin0, uSize0, uCascade1, uOrigin1, uSize1, uGuardWorld0, uGuardWorld1);
    float shL = getNetDeformHeight(dL, uMaxDepth);
    float shR = getNetDeformHeight(dR, uMaxDepth);
    float shD = getNetDeformHeight(dD, uMaxDepth);
    float shU = getNetDeformHeight(dU, uMaxDepth);

    float imprintDepth = 0.0040 * crumble * (1.0 - smoothstep(5.5, 17.5, distCam));
    float dhdx = clamp(((shR - shL) + (dR.a - dL.a) * imprintDepth) / (2.0 * sandStep), -2.2, 2.2);
    float dhdz = clamp(((shU - shD) + (dU.a - dD.a) * imprintDepth) / (2.0 * sandStep), -2.2, 2.2);
    float nyquistSlopeAtten = 1.0 - smoothstep(0.14, 0.68, pixelFootprint) * 0.50;
    float slopeGain = mix(1.75, 1.34, w0) * nyquistSlopeAtten;
    N_deform = normalize(vec3(-dhdx * slopeGain, 1.0, -dhdz * slopeGain));

    // Crisp directional rut bottom contact occlusion without harsh dark paint rings
    float laplacian = (shL + shR + shD + shU - 4.0 * centerDeformH) / max(1e-4, sandStep * sandStep);
    cavityAO = clamp(1.0 - max(0.0, laplacian * 0.028) - depression * 0.085, 0.76, 1.0);
  }

  // Asymmetric bifurcating aeolian wind ripples cleanly erased inside tire ruts & loose berms
  float trackEraseMask = 1.0 - smoothstep(0.012, 0.16, depression * 2.5 + bermMass * 2.9 + compression * 1.40);
  float rippleDistAtten = 1.0 - smoothstep(14.0, 52.0, distCam);
  float slipFaceMask = smoothstep(0.84, 0.96, N_base.y);
  float rippleCrest;
  float rippleLeeShadow;
  vec3 N_ripples = evalWindRippleNormal(
    sampleXZ,
    uWindDir,
    distCam,
    rippleDistAtten * slipFaceMask * trackEraseMask,
    rippleCrest,
    rippleLeeShadow
  );

  // Combine Macro + Sculpted Deform + Granular Berm Breakup + Wind Ripples + Photographic Grain
  vec3 N_macro = blendRNM(N_base, N_deform);
  float clodShade;
  vec3 N_bermCrumble = evalGranularBermBreakup(vWorldPos, N_macro, bermMass, depression, distCam, clodShade);
  vec3 N_detail = blendRNM(N_photoGrain, N_bermCrumble);
  vec3 N = blendRNM(blendRNM(N_macro, N_ripples), N_detail);

  // Debug View 2: World-space RNM Normal Visualization
  if (uDebugView == 2) {
    vec3 nCol = N * 0.5 + 0.5;
    float fogT = 1.0 - exp(-pow(distCam * uFogDensity, 2.0));
    fragColor = vec4(mix(nCol, uFogColor, clamp(fogT, 0.0, 1.0)), 1.0);
    return;
  }

  // === PHOTOREALISTIC NAMIB / SAHARA IRON-OXIDE ALBEDO & AEOLIAN STRATIFICATION ===
  float macroStrata = fbm2(sampleXZ * 0.020 + vec2(1.7, 5.4));
  vec2 wPerp = vec2(-uWindDir.y, uWindDir.x);
  vec2 driftUV = vec2(dot(sampleXZ, uWindDir) * 0.032, dot(sampleXZ, wPerp) * 0.14);
  float windDriftSheet = fbm2(driftUV + vec2(macroStrata * 1.3, 2.8));
  float baseH = vBaseHeight;
  float crestMask = smoothstep(0.45, 3.1, baseH);
  float troughMask = 1.0 - smoothstep(-1.1, 1.5, baseH);

  // Natural windblown Sahara palette: luminous golden-apricot silica crests -> warm sandstone mid -> burnt ochre troughs
  vec3 sunlitApricotGold = vec3(1.12, 0.96, 0.80);
  vec3 richSaharaSand    = vec3(0.94, 0.78, 0.62);
  vec3 troughBurntOchre  = vec3(0.76, 0.60, 0.48);

  float strataBlend = smoothstep(0.14, 0.86, macroStrata * 0.52 + windDriftSheet * 0.48);
  vec3 duneTint = mix(sunlitApricotGold, richSaharaSand, strataBlend);
  duneTint = mix(duneTint, sunlitApricotGold * 1.06, crestMask * 0.42);
  duneTint = mix(duneTint, troughBurntOchre, troughMask * 0.34);

  vec3 baseAlbedo = grainLinearAlbedo * duneTint;

  // Aeolian mineral sorting along ripple crests & fine close-up grit luminance
  baseAlbedo *= mix(vec3(1.04, 1.01, 0.98), vec3(0.91, 0.88, 0.86), rippleCrest * trackEraseMask * slipFaceMask * 0.44);
  baseAlbedo *= (1.0 + gritContrast * 0.11 * (1.0 - smoothstep(2.8, 9.5, distCam)));

  // Overturned loose sand berm ridges scatter bright dry sunlit silica dust & coarse grain clods
  vec3 bermTint = baseAlbedo * vec3(1.18, 1.11, 1.00) + vec3(0.030, 0.018, 0.008);
  vec3 albedo = mix(baseAlbedo, bermTint, clamp(bermMass * 0.94, 0.0, 0.55));
  albedo *= (1.0 + clodShade * 0.15);

  // Subtle subsurface compaction & damp tread imprint inside deep ruts
  float darkenFactor = clamp((depression * 0.35 + compression * 0.65) * (0.06 + uMoisture * 0.22), 0.0, 0.26);
  albedo *= (1.0 - uMoisture * 0.10);
  albedo *= (1.0 - darkenFactor);
  albedo *= (1.0 + clamp(microImprint, -1.0, 1.0) * 0.042 * crumble);

  // Dry quartz sand stays authentically matte (0.86..0.96) instead of waxy plastic
  float grainRoughMod = mix(0.04, -0.05, smoothstep(0.32, 0.85, grainLum));
  float baseRoughness = clamp(
    mix(0.91, 0.62, uMoisture * (0.35 + 0.65 * compression)) + grainRoughMod + bermMass * 0.03,
    0.50,
    0.97
  );

  // Kaplanyan / Toksvig Screen-Space Specular AA
  vec3 dNdx = dFdx(N);
  vec3 dNdy = dFdy(N);
  float normalVar = clamp(dot(dNdx, dNdx) + dot(dNdy, dNdy), 0.0, 0.5);
  float roughness = clamp(sqrt(baseRoughness * baseRoughness + normalVar * 0.85), 0.50, 0.98);

  // === CINEMATIC RAKING-SUN LIGHTING, COOL SKY SHADOW FILL & TRANSLUCENT QUARTZ SCATTER ===
  vec3 L = uSunDir;
  float shadowMapVis = evalShadowMapPCF(vShadowCoord, vFarShadowCoord);
  float vehicleShadowVis = evalAnalyticalVehicleShadow(vWorldPos, L, shadowMapVis);
  float microShadowVis = inCascade ? evalMicroSelfShadow(sampleXZ, centerDeformH, L, distCam, w0, texel1, pixelFootprint) : 1.0;
  float leeRippleOcc = 1.0 - rippleLeeShadow * trackEraseMask * slipFaceMask * 0.24 * smoothstep(0.02, 0.22, max(dot(N, L), 0.0));
  float shadowVis = min(vehicleShadowVis, microShadowVis);

  // Physically block direct sun inside shadows so cool sky bounce & warm sand scatter carve crisp 3D relief
  float directShadowFactor = mix(0.05, 1.0, shadowVis) * leeRippleOcc;
  vec3 directDiffuse = evalEONDiffuse(albedo, roughness, N, V, L) * uSunColor * 1.16 * directShadowFactor;

  // Translucent warm iron-oxide quartz subsurface multiple-scattering along sunlit crests & rut walls
  float slopeWrap = clamp((dot(N, L) + 0.26) / 1.26, 0.0, 1.0);
  float trackWallScatter = slopeWrap * (0.068 + bermMass * 0.115 + depression * 0.070 + crestMask * 0.045) * mix(0.20, 1.0, shadowVis);
  vec3 sssBounce = albedo * uSunColor * vec3(1.04, 0.54, 0.24) * (trackWallScatter * (1.0 - uMoisture * 0.42));

  // Physically contrasted Hemisphere fill: cool desert azure sky overhead vs warm sunlit sand bounce
  float hemiT = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 warmBounceFloor = max(uGroundBounceColor, vec3(0.54, 0.27, 0.12));
  vec3 skyFill = mix(uSkyColor * 0.58, uFogColor * 0.44, 0.24);
  float shadowCoolBoost = mix(1.28, 0.92, shadowVis);
  vec3 indirectLight = mix(warmBounceFloor * 0.86, skyFill * shadowCoolBoost, hemiT) * albedo * (0.41 * cavityAO);

  // Subtle broad matte silica forward scatter (removes waxy plastic specular on dry curves & berms)
  vec3 H = normalize(L + V);
  float NdotH = max(dot(N, H), 0.0);
  float NdotV = max(dot(N, V), 0.0);
  float NdotL = max(dot(N, L), 0.0);
  float specAA = 1.0 / (1.0 + normalVar * 14.0);
  float oceanSpecExp = mix(12.0, 44.0, uMoisture) * mix(1.0, 0.45, clamp(normalVar * 4.0, 0.0, 1.0));
  float oceanSpec = pow(NdotH, oceanSpecExp) * mix(0.022, 0.14, uMoisture) * specAA * smoothstep(0.02, 0.32, NdotL) * shadowVis;

  // Powdery golden backlit velvet rim on sunlit dune crests & track shoulders
  float rim = pow(1.0 - NdotV, 3.2) * (0.12 + bermMass * 0.18 + crestMask * 0.06) * (0.28 + 0.72 * NdotL) * mix(0.20, 1.0, shadowVis);
  vec3 rimColor = uSunColor * vec3(1.02, 0.78, 0.48) * rim;

  // Band-limited close-range sunlit quartz micro-glints (zero distant shimmering)
  float churnBoost = clamp(bermMass * 0.95 + trackEraseMask * 0.45 + grainLum * 0.35, 0.0, 1.45);
  vec3 glints = evalQuartzGlints(sampleXZ, N, V, L, churnBoost, distCam, pixelFootprint) * shadowVis;
  vec3 glintColor = uSunColor * glints * 0.96;

  vec3 lampLight = evalVehicleLampTerrainLight(vWorldPos, N, albedo, roughness, V);

  vec3 color =
    directDiffuse * mix(1.0, cavityAO, 0.62) +
    sssBounce +
    indirectLight +
    uSunColor * oceanSpec +
    rimColor +
    glintColor +
    lampLight;

  // Debug View 3: Wireframe Clipmap Ring Overlay
  if (uDebugView == 3) {
    vec2 cellFrac = abs(fract(vBaryHint.xy) - 0.5);
    float wireLine = smoothstep(0.44, 0.5, max(cellFrac.x, cellFrac.y));
    vec3 ringPalette = 0.5 + 0.5 * cos(vec3(0.0, 2.09, 4.18) + vRingLevel * 0.85);
    color = mix(color * 0.72, ringPalette, wireLine * 0.82);
    color = mix(color, vec3(1.0, 0.85, 0.3), vMorph * wireLine * 0.5);
  }

  // Sun-aligned Mie + Rayleigh golden-hour Sahara atmospheric perspective fog
  float fogFactor = 1.0 - exp(-pow(distCam * uFogDensity * 0.72, 1.72));
  float sunAlign = max(dot(-V, L), 0.0);
  float sunAlign3 = sunAlign * sunAlign * sunAlign;
  vec3 mieHorizon = mix(uFogColor, uFogColor * vec3(1.18, 0.96, 0.78) + vec3(0.11, 0.048, 0.012), sunAlign3 * 0.78);
  color = mix(color, mieHorizon, clamp(fogFactor, 0.0, 1.0));

  if (uLinearHdrOutput < 0.5) {
    // Filmic ACES tone mapping + sRGB encode (direct fallback when HDR composer is off)
    color *= 1.02;
    color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
    color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));
  }

  fragColor = vec4(color, 1.0);
}
`;

