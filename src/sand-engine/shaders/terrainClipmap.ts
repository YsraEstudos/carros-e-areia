/**
 * terrainClipmap.ts
 * Single-draw-call Nested-Ring Geometry Clipmap vertex shader with continuous
 * CDLOD morphing (zero seams / zero T-junctions) + Cascade 0/1 toroidal
 * displacement.
 *
 * Exports BOTH:
 *  - `TERRAIN_CLIPMAP_VERT`: Beauty pass vertex shader (computes shadow coords)
 *  - `TERRAIN_SHADOW_VERT` + `TERRAIN_SHADOW_FRAG`: Exact matching vertex
 *    displacement for Shadow Cascade 0 (`mesh.customDepthMaterial`) so berms
 *    cast true shadows into ruts under grazing sun!
 */

import { COMMON_TOROIDAL_GLSL } from './commonToroidal';

const CDLOD_DISPLACE_FUNCTION = /* glsl */ `
// Computes exact world-space displaced vertex position with continuous CDLOD
// ring-boundary morphing so odd outer vertices collapse cleanly onto even
// neighbors before sampling the terrain + toroidal cascades.
vec3 evalClipmapVertex(
  vec3 localPos,
  vec4 ringData,
  vec2 clipmapCenter,
  out float outMorph,
  out float outRingLevel,
  out float outBaseH
) {
  float gx = ringData.x;
  float gz = ringData.y;
  float cellSize = ringData.z;
  float halfExtent = ringData.w;

  // Determine ring level from cellSize (0..7)
  outRingLevel = log2(max(1.0, cellSize / max(0.001, uBaseCellSize)));

  // Continuous morph band on outer 28% of each ring (0.9995 guarantees exact 1.0 at boundary)
  float edgeFrac = max(abs(localPos.x), abs(localPos.z)) / max(0.001, halfExtent);
  float morph = smoothstep(0.72, 0.9995, edgeFrac);
  outMorph = morph;

  // Snap odd grid indices toward even coarser grid indices as morph -> 1.0
  float oddX = mod(abs(gx), 2.0);
  float oddZ = mod(abs(gz), 2.0);
  // Shift odd vertices toward zero/even neighbor consistently across positive & negative coords
  float dirX = gx >= 0.0 ? -1.0 : 1.0;
  float dirZ = gz >= 0.0 ? -1.0 : 1.0;

  vec2 morphedLocal = localPos.xz + vec2(oddX * dirX, oddZ * dirZ) * (morph * cellSize);
  vec2 worldXZ = clipmapCenter + morphedLocal;

  float baseH = getBiomeTerrainHeight(worldXZ, uBiomeRainy);
  outBaseH = baseH;

  // Watertight Nyquist vertex-displacement cutoff:
  // MUST be a purely continuous function of worldXZ (NEVER cellSize or ringLevel!)
  // so shared boundary vertices across every ring seam evaluate bit-identical height (0 cracks!).
  // Ring 0 spans 0..1.936m (4.4cm grid) and Ring 1 spans 1.936..3.872m (8.8cm grid).
  // Fading 2.45m -> 3.80m keeps all 4 tires in full 3D vertex relief while reaching exact 0.0
  // strictly inside Ring 1 before Ring 2 begins (3.872m), eliminating coarse-ring sawtooth.
  vec2 relClip = abs(worldXZ - clipmapCenter);
  float chebyshevDist = max(relClip.x, relClip.y);
  float vertexDispFade = 1.0 - smoothstep(2.45, 3.80, chebyshevDist);
  // Keep rigid paved asphalt undeformed by toroidal sand ruts while muddy shoulders still deform slightly
  float asphaltMask = uBiomeRainy >= 0.5 ? smoothstep(3.45, 4.40, abs(worldXZ.x)) * 0.45 : 1.0;

  float deformH = 0.0;
  if (vertexDispFade * asphaltMask > 0.001) {
    vec4 deformState = sampleCascadeBlended(
      worldXZ,
      uCascade0,
      uOrigin0,
      uSize0,
      uCascade1,
      uOrigin1,
      uSize1,
      uGuardWorld0,
      uGuardWorld1
    );
    deformH = getNetDeformHeight(deformState, uMaxDepth) * vertexDispFade * asphaltMask;
  }

  return vec3(worldXZ.x, baseH + deformH, worldXZ.y);
}
`;

export const TERRAIN_CLIPMAP_VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec4 aRingData; // (gx, gz, cellSize, ringHalfExtent)

uniform sampler2D uCascade0;
uniform sampler2D uCascade1;
uniform vec2 uOrigin0;
uniform vec2 uOrigin1;
uniform float uSize0;
uniform float uSize1;
uniform float uGuardWorld0;
uniform float uGuardWorld1;
uniform float uMaxDepth;
uniform vec2 uClipmapCenter;
uniform float uBaseCellSize;
uniform float uBiomeRainy;

// Shadow Cascade 0 (near high-res) & Cascade 1 (far ±125m low-res) matrices
uniform mat4 uShadowMatrix;
uniform float uShadowEnabled;
uniform mat4 uFarShadowMatrix;
uniform float uFarShadowEnabled;

out vec3 vWorldPos;
out float vMorph;
out float vRingLevel;
out vec4 vShadowCoord;
out vec4 vFarShadowCoord;
out vec3 vBaryHint;
out float vBaseHeight;

${COMMON_TOROIDAL_GLSL}
${CDLOD_DISPLACE_FUNCTION}

void main() {
  float morph;
  float ringLevel;
  float baseH;
  vec3 worldPos = evalClipmapVertex(position, aRingData, uClipmapCenter, morph, ringLevel, baseH);

  vWorldPos = worldPos;
  vMorph = morph;
  vRingLevel = ringLevel;
  vBaryHint = vec3(aRingData.x, aRingData.y, aRingData.z);
  vBaseHeight = baseH;

  if (uShadowEnabled > 0.5) {
    vShadowCoord = uShadowMatrix * vec4(worldPos, 1.0);
  } else {
    vShadowCoord = vec4(0.0);
  }
  if (uFarShadowEnabled > 0.5) {
    vFarShadowCoord = uFarShadowMatrix * vec4(worldPos, 1.0);
  } else {
    vFarShadowCoord = vec4(0.0);
  }

  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

/**
 * Shadow Cascade 0 depth material shaders (GLSL3) so the clipmap writes its
 * exact vertex-displaced berms & grooves into the directional light shadow map.
 */
export const TERRAIN_SHADOW_VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec4 aRingData;

uniform sampler2D uCascade0;
uniform sampler2D uCascade1;
uniform vec2 uOrigin0;
uniform vec2 uOrigin1;
uniform float uSize0;
uniform float uSize1;
uniform float uGuardWorld0;
uniform float uGuardWorld1;
uniform float uMaxDepth;
uniform vec2 uClipmapCenter;
uniform float uBaseCellSize;
uniform float uBiomeRainy;

out vec2 vHighPrecisionZW;

${COMMON_TOROIDAL_GLSL}
${CDLOD_DISPLACE_FUNCTION}

void main() {
  float morph;
  float ringLevel;
  float baseH;
  vec3 worldPos = evalClipmapVertex(position, aRingData, uClipmapCenter, morph, ringLevel, baseH);
  vec4 clipPos = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  vHighPrecisionZW = clipPos.zw;
  gl_Position = clipPos;
}
`;

export const TERRAIN_SHADOW_FRAG = /* glsl */ `
precision highp float;
in vec2 vHighPrecisionZW;
out vec4 fragColor;

vec4 packDepthToRGBA(const in float v) {
  const vec4 bitShift = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
  const vec4 bitMask = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
  vec4 res = fract(v * bitShift);
  res -= res.xxyz * bitMask;
  return res;
}

void main() {
  float fragCoordZ = 0.5 * vHighPrecisionZW.x / vHighPrecisionZW.y + 0.5;
  fragColor = packDepthToRGBA(fragCoordZ);
}
`;
