/**
 * windshieldRain.ts
 * Custom GLSL3 windshield & side-window raindrop + active dual-wiper sweep clearing shader
 * + interior-visible spiderweb crash crack overlay!
 *
 * Matches Reference Image 1:
 *  - Crystal-clear wiped dual-fan windshield arc when wipers sweep
 *  - Refractive raindrop beads & gravity streaks in unwiped corners and side door windows
 *  - Dramatic spiderweb crack lines visible from INSIDE the cockpit when windshield is damaged
 */

import * as THREE from 'three';

export interface WindshieldRainUniforms {
  uTime: { value: number };
  uRainIntensity: { value: number };
  uSpeedMs: { value: number };
  uWiperLeftAngle: { value: number };
  uWiperRightAngle: { value: number };
  uWipeFreshness: { value: number };
  uCrackLevel: { value: number }; // 0 = intact, 1 = spiderweb, 2 = shattered
  uIsSideWindow: { value: number }; // 0 = front windshield (with wiper arcs), 1 = side door glass
  uFogTint: { value: THREE.Color };
}

const RAIN_GLASS_VERT = /* glsl */ `
precision highp float;
out vec2 vUv;
out vec3 vWorldPos;
out vec3 vWorldNormal;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RAIN_GLASS_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
in vec3 vWorldPos;
in vec3 vWorldNormal;

uniform float uTime;
uniform float uRainIntensity;
uniform float uSpeedMs;
uniform float uWiperLeftAngle;
uniform float uWiperRightAngle;
uniform float uWipeFreshness;
uniform float uCrackLevel;
uniform float uIsSideWindow;
uniform vec3 uFogTint;

out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Multi-layer procedural refractive raindrop bead layer
vec2 rainDropLayer(vec2 uv, float t, float scaleX, float scaleY, float slideSpeed) {
  vec2 grid = vec2(scaleX, scaleY);
  vec2 st = uv * grid;
  float colId = floor(st.x);
  float colSeed = hash21(vec2(colId, scaleX * 1.7));

  // Slow gravity slide downward (or backward on side window when driving)
  st.y += t * slideSpeed * (0.45 + colSeed * 0.75) + colSeed * 7.3;

  vec2 id = floor(st);
  vec2 f = fract(st) - 0.5;
  float rnd = hash21(id + vec2(scaleY, 13.7));

  // Random horizontal wobble within cell
  float xOff = (rnd - 0.5) * 0.52;
  float yOff = (fract(rnd * 37.1) - 0.5) * 0.44;
  vec2 d = (f - vec2(xOff, yOff)) * vec2(1.0, 1.38);
  float dist = length(d);

  // Sharp refractive bead rim + dark bottom meniscus
  float radius = 0.08 + 0.14 * fract(rnd * 19.3);
  float drop = smoothstep(radius, radius * 0.35, dist) * step(0.42, rnd);

  // Subtle vertical streak tail above sliding drop
  float tailDist = abs(f.x - xOff);
  float tailMask = smoothstep(radius * 0.42, 0.0, tailDist) *
                   smoothstep(0.0, 0.45, f.y - yOff) *
                   (1.0 - smoothstep(0.45, 0.55, f.y - yOff)) *
                   step(0.68, rnd);

  // Fake refraction highlight (bright top crescent, dark lower edge)
  float spec = smoothstep(radius * 0.65, radius * 0.1, length(d - vec2(-0.02, 0.035))) * drop;
  return vec2(max(drop, tailMask * 0.42), spec);
}

// Spiderweb impact crack pattern (visible from inside cockpit when windshield damaged!)
float windshieldCrackPattern(vec2 uv, vec2 center, float radius, float seed) {
  vec2 p = (uv - center) * vec2(1.75, 1.0);
  float dist = length(p);
  if (dist > radius) return 0.0;

  float ang = atan(p.y, p.x);
  // Radial fracture spokes
  float spokeCount = 15.0;
  float spokeId = floor((ang + 3.14159) / (6.28318 / spokeCount));
  float spokeAng = (spokeId + 0.5 + (hash21(vec2(spokeId, seed)) - 0.5) * 0.38) * (6.28318 / spokeCount) - 3.14159;
  float angDiff = abs(sin((ang - spokeAng) * 0.5)) * dist;
  float radialLine = (1.0 - smoothstep(0.0018, 0.0055, angDiff)) * (1.0 - smoothstep(radius * 0.55, radius, dist));

  // Concentric spiderweb fracture rings
  float ringPhase = fract(dist * 16.0 + sin(ang * 5.0 + seed) * 0.18);
  float ringLine = (1.0 - smoothstep(0.04, 0.11, abs(ringPhase - 0.5))) *
                   smoothstep(0.02, 0.08, dist) *
                   (1.0 - smoothstep(radius * 0.45, radius * 0.85, dist));

  // Crushed white impact bullseye
  float bullseye = (1.0 - smoothstep(0.015, 0.065, dist)) * 0.72;
  return clamp(max(max(radialLine, ringLine * 0.82), bullseye), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  float rain = clamp(uRainIntensity, 0.0, 1.0);

  // Fast early-out for dry uncracked side windows (0 texture/noise cost in Desert & Sunny biomes)
  if (rain < 0.01 && uCrackLevel < 0.5 && uIsSideWindow >= 0.5) {
    discard;
  }

  // Compute swept wiper clear mask on front windshield (two overlapping bottom-hinged fan arcs!)
  // NOTE: PlaneGeometry seen from inside (+Z normal facing -Z): uv.x=0 is right (-X), uv.x=1 is left (+X) OR flipped.
  // Making the dual wiper pivots symmetric around uv.x = 0.28 and 0.74 guarantees clean wiped zone directly ahead of driver!
  float unwipedMask = 1.0;
  if (rain >= 0.01 && uIsSideWindow < 0.5) {
    // Two fan pivots near bottom cowl (matching the 3D articulated wiper arms!)
    vec2 pLeft = vec2(0.73, -0.06);
    vec2 pRight = vec2(0.28, -0.06);
    float rLeft = length((uv - pLeft) * vec2(1.48, 1.0));
    float rRight = length((uv - pRight) * vec2(1.48, 1.0));

    float inArcL = smoothstep(0.88, 0.81, rLeft) * smoothstep(0.11, 0.16, rLeft);
    float inArcR = smoothstep(0.86, 0.79, rRight) * smoothstep(0.11, 0.16, rRight);
    float sweptZone = clamp(max(inArcL, inArcR), 0.0, 1.0);

    // Subtle angular trail behind passing wiper blade so fresh wipe visibly clears droplets!
    float clearFactor = sweptZone * clamp(uWipeFreshness, 0.0, 1.0) * 0.94;
    unwipedMask = 1.0 - clearFactor;
  }

  // Multi-scale raindrop beads — skipped completely when dry or inside freshly wiped arc
  float dropMask = 0.0;
  float dropSpec = 0.0;
  float edgeMist = 0.0;
  if (rain >= 0.01 && unwipedMask > 0.01) {
    float slideSpeed = 0.16 + clamp(uSpeedMs / 35.0, 0.0, 1.0) * 0.45;
    vec2 d1 = rainDropLayer(uv, uTime, 22.0, 12.0, slideSpeed * 0.65);
    vec2 d2 = rainDropLayer(uv + vec2(0.37, 0.19), uTime * 0.85, 42.0, 24.0, slideSpeed * 0.35);
    vec2 d3 = rainDropLayer(uv + vec2(0.71, 0.53), uTime * 0.3, 68.0, 38.0, 0.04);

    dropMask = clamp(d1.x * 0.95 + d2.x * 0.72 + d3.x * 0.48, 0.0, 1.0) * rain * unwipedMask;
    dropSpec = clamp(d1.y + d2.y * 0.85 + d3.y * 0.5, 0.0, 1.0) * rain * unwipedMask;

    // Fine water film mist along extreme unwiped edges
    edgeMist = (1.0 - smoothstep(0.0, 0.12, uv.x) * smoothstep(1.0, 0.88, uv.x) * smoothstep(0.0, 0.14, uv.y)) *
               rain * unwipedMask * 0.16;
  }

  // Interior-visible spiderweb crash cracks (Phase 5 damage integration!)
  float crackMask = 0.0;
  if (uCrackLevel > 0.5) {
    crackMask = max(crackMask, windshieldCrackPattern(uv, vec2(0.62, 0.52), 0.52, 3.1));
    if (uCrackLevel > 1.5) {
      crackMask = max(crackMask, windshieldCrackPattern(uv, vec2(0.30, 0.44), 0.58, 9.7));
      crackMask = max(crackMask, windshieldCrackPattern(uv, vec2(0.50, 0.28), 0.44, 15.3));
    }
  }

  // Subtle dark automotive frit perimeter on front windshield
  float frit = 0.0;
  if (uIsSideWindow < 0.5) {
    float edgeDist = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    frit = (1.0 - smoothstep(0.012, 0.032, edgeDist)) * 0.65;
  }

  // Compose optical raindrop tint (dark refractive outline + bright misty sky highlight)
  vec3 dropColor = mix(vec3(0.08, 0.10, 0.12), uFogTint * 1.18, 0.35 + dropSpec * 0.65);
  vec3 crackColor = vec3(0.86, 0.91, 0.96);

  vec3 finalRgb = mix(dropColor, vec3(0.03, 0.035, 0.04), frit);
  finalRgb = mix(finalRgb, crackColor, crackMask);

  float alpha = clamp(
    dropMask * 0.46 +
    dropSpec * 0.38 +
    edgeMist +
    frit * 0.85 +
    crackMask * 0.86,
    0.0,
    0.95
  );

  // Keep swept clear windshield completely transparent (no haze!)
  if (alpha < 0.01) discard;

  fragColor = vec4(finalRgb, alpha);
}
`;

export function createWindshieldRainMaterial(
  isSideWindow: boolean,
): {
  material: THREE.ShaderMaterial;
  uniforms: WindshieldRainUniforms;
} {
  const uniforms: WindshieldRainUniforms = {
    uTime: { value: 0 },
    uRainIntensity: { value: 0.78 },
    uSpeedMs: { value: 0 },
    uWiperLeftAngle: { value: 0.28 },
    uWiperRightAngle: { value: 0.26 },
    uWipeFreshness: { value: 0.92 },
    uCrackLevel: { value: 0 },
    uIsSideWindow: { value: isSideWindow ? 1.0 : 0.0 },
    uFogTint: { value: new THREE.Color(0.76, 0.77, 0.76) },
  };

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: RAIN_GLASS_VERT,
    fragmentShader: RAIN_GLASS_FRAG,
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  return { material, uniforms };
}
