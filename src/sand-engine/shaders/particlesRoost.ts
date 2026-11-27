/**
 * particlesRoost.ts
 * Open-source / AAA-inspired GPU Volumetric Sand Dust & Ballistic Roost Shaders:
 *  1. `VOLUMETRIC_SMOKE_VERT / FRAG`:
 *     Single-draw-call InstancedBufferGeometry volumetric particle engine rendering
 *     desert dust wakes, tire drift smoke & twin-exhaust plumes:
 *     - Dual-phase divergence-free curl flowmap advection using pre-baked RGBA atlas
 *       (zero texture sliding, organic rolling eddies & lacy filament erosion)
 *     - Early-flight velocity-aligned stretch (roostertail streaks off tire lugs)
 *       relaxing into wide wind-sheared aerodynamic wakes
 *     - 2-tap directional Beer-Lambert + Powder-Sugar (`Nubis`) sun self-shadowing
 *       + Henyey-Greenstein golden forward scatter (no fake clay normal bumpiness)
 *     - Analytical soft-particle feathering against BOTH terrain heightfield AND truck OBB
 *     - Calibrated translucent opacity + ACES Filmic tone mapping matched to `terrainSand.ts`
 *  2. `ROOST_PARTICLES_VERT / FRAG`:
 *     Irregular chipped ballistic sand clods & grains with directional shading & ACES tone mapping.
 */

import { COMMON_TOROIDAL_GLSL } from './commonToroidal';

export const VOLUMETRIC_SMOKE_VERT = /* glsl */ `
precision highp float;

// Per-instance attributes (zero-GC circular ring buffer)
in vec3 aOrigin;     // spawn world pos
in vec3 aVelocity;   // initial velocity (m/s)
in vec4 aParams;     // x=spawnTime, y=lifetime, z=baseSizeMeters, w=seed [0..1]
in vec4 aStyle;      // x=smokeType (0=dust,1=drift,2=exhaust), y=opacity, z=growthMult, w=spinRate

uniform float uTime;
uniform vec2 uWindVec;
uniform vec3 uSunDir;
uniform vec3 uVehiclePos;
uniform vec2 uVehicleFwd;

out vec2 vUv;
out float vLifeFrac;
out float vAge;
out float vSeed;
out float vType;
out float vOpacity;
out vec3 vWorldPos;
out float vCamDist;
out vec2 vLightUvDir;
out float vQuadTop;
out float vGroundY;

${COMMON_TOROIDAL_GLSL}

vec2 evalQuadOffset2D(
  vec2 q,
  float cs,
  float sn,
  float wakeAspectX,
  float wakeAspectY,
  vec2 velDir,
  float earlyStretch,
  float earlyFlight
) {
  vec2 tumbled = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
  vec2 wakeQuad = vec2(tumbled.x * wakeAspectX, tumbled.y * wakeAspectY);

  vec2 velPerp = vec2(-velDir.y, velDir.x);
  float projAlong = dot(tumbled, velDir) * earlyStretch;
  float projPerp = dot(tumbled, velPerp) * 0.78;
  vec2 velQuad = velDir * projAlong + velPerp * projPerp;

  return mix(wakeQuad, velQuad, earlyFlight);
}

void main() {
  float age = uTime - aParams.x;
  float life = max(0.05, aParams.y);
  vAge = age;
  vLifeFrac = age / life;
  vSeed = aParams.w;
  vType = aStyle.x;
  vOpacity = aStyle.y;

  // Dead or inactive instance: collapse cleanly to 0 rasterized fragments (zero overdraw!)
  if (age < 0.0 || age > life || vOpacity <= 0.001) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vUv = vec2(0.0);
    vWorldPos = vec3(0.0);
    vCamDist = 1000.0;
    vLightUvDir = vec2(0.0, 1.0);
    vQuadTop = 0.5;
    vGroundY = 0.0;
    return;
  }

  // Type-specific aerodynamic drag & thermal/wake buoyancy:
  // Exhaust decelerates rapidly; desert dust carries momentum into trailing wake and hugs the dunes
  float dragK = (vType > 1.5) ? 3.5 : ((vType > 0.5) ? 2.1 : 1.55);
  float dragT = (1.0 - exp(-age * dragK)) / dragK;
  vec3 instVel = aVelocity * exp(-age * dragK);

  // Multi-harmonic vortex curl drift spreads wake organically downwind
  float phase = vSeed * 6.2831853 + age * 1.40;
  float curlAmp = (vType > 1.5) ? 0.24 : 0.34;
  vec3 curlOffset = vec3(
    sin(phase + aOrigin.z * 0.42) * curlAmp * pow(age, 0.88),
    sin(phase * 1.28 + vSeed * 4.0) * 0.07 * age,
    cos(phase * 0.83 + aOrigin.x * 0.42) * curlAmp * pow(age, 0.88)
  );

  // Buoyant rise: desert dust stays low over dunes while exhaust rises slightly faster
  float riseRate = (vType > 1.5) ? 0.48 : ((vType > 0.5) ? 0.26 : 0.14);
  float riseY = riseRate * pow(age, 0.76) * (0.72 + 0.52 * vSeed);

  float windMult = (vType > 1.5) ? 1.05 : 1.38;
  vec3 windOffset = vec3(uWindVec.x, 0.0, uWindVec.y) * (age * windMult * (0.60 + 0.65 * vLifeFrac));

  vec3 centerWorld = aOrigin + aVelocity * dragT + windOffset + curlOffset + vec3(0.0, riseY, 0.0);

  // Keep puff smoothly seated above desert dune floor
  float groundY = getBaseTerrainHeight(centerWorld.xz);
  vGroundY = groundY;
  float baseScale = aParams.z;
  float expand = mix(0.42, aStyle.z, pow(vLifeFrac, 0.60));
  float worldSize = baseScale * expand;
  float minLift = (vType > 1.5) ? worldSize * 0.14 : worldSize * 0.15;
  centerWorld.y = max(centerWorld.y, groundY + minLift);

  // Camera-aligned billboard basis in world space
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  // Subtle organic tumble + early velocity-aligned roostertail stretch
  float rotAng = vSeed * 6.2831853 + aStyle.w * pow(age, 0.70) * 0.46;
  float cs = cos(rotAng);
  float sn = sin(rotAng);

  vec2 velCam = vec2(dot(instVel, camRight), dot(instVel, camUp));
  float velMag = length(velCam);
  vec2 velDir = (velMag > 0.05) ? (velCam / velMag) : vec2(1.0, 0.0);

  float allowVelStretch = (vType < 0.5 || vType > 1.5) ? 1.0 : 0.45;
  float earlyFlight = allowVelStretch
    * (1.0 - smoothstep(0.06, 0.36, vLifeFrac))
    * smoothstep(0.75, 4.0, velMag);
  float earlyStretch = 1.48 + clamp(velMag * 0.08, 0.0, 0.65);

  float wakeAspectX = (vType < 0.5) ? (1.36 + 0.42 * vLifeFrac) : (vType < 1.5 ? 1.18 + 0.24 * vLifeFrac : 1.04);
  float wakeAspectY = (vType < 0.5) ? 0.94 : 1.0;

  vec2 localQuad = position.xy; // [-0.5 .. +0.5]
  vec2 offsetCam = evalQuadOffset2D(
    localQuad, cs, sn, wakeAspectX, wakeAspectY, velDir, earlyStretch, earlyFlight
  );
  vec2 basisU = evalQuadOffset2D(
    vec2(1.0, 0.0), cs, sn, wakeAspectX, wakeAspectY, velDir, earlyStretch, earlyFlight
  );
  vec2 basisV = evalQuadOffset2D(
    vec2(0.0, 1.0), cs, sn, wakeAspectX, wakeAspectY, velDir, earlyStretch, earlyFlight
  );

  vec3 worldOffset = (camRight * offsetCam.x + camUp * offsetCam.y) * worldSize;
  vec3 worldPos = centerWorld + worldOffset;
  vWorldPos = worldPos;
  vUv = uv;

  vec3 quadWorldU = normalize(camRight * basisU.x + camUp * basisU.y);
  vec3 quadWorldV = normalize(camRight * basisV.x + camUp * basisV.y);
  vLightUvDir = vec2(dot(uSunDir, quadWorldU), dot(uSunDir, quadWorldV));
  vQuadTop = clamp((worldOffset.y / max(0.18, worldSize)) + 0.5, 0.0, 1.0);

  vec4 mvPos = viewMatrix * vec4(worldPos, 1.0);
  vCamDist = max(0.2, -mvPos.z);
  gl_Position = projectionMatrix * mvPos;
}
`;

export const VOLUMETRIC_SMOKE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;

in vec2 vUv;
in float vLifeFrac;
in float vAge;
in float vSeed;
in float vType;
in float vOpacity;
in vec3 vWorldPos;
in float vCamDist;
in vec2 vLightUvDir;
in float vQuadTop;
in float vGroundY;

uniform sampler2D uSmokeAtlas;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundBounceColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uDustColor;
uniform vec3 uVehiclePos;
uniform vec2 uVehicleFwd;
uniform float uBrakeLightPower;
uniform float uLinearHdrOutput;

out vec4 fragColor;

void main() {
  if (vLifeFrac < 0.0 || vLifeFrac > 1.0) discard;

  vec2 centered = vUv - vec2(0.5);
  float r2 = dot(centered, centered);
  if (r2 > 0.25) discard;
  float r = sqrt(r2) * 2.0; // [0..1]

  // === 1. DUAL-PHASE CURL FLOWMAP ADVECTION (ZERO TEXTURE SLIDING) ===
  vec2 seedBias = vec2(vSeed * 1.73, fract(vSeed * 3.17));
  float flowTime = vAge * 0.55 + vSeed * 0.85;
  float ph0 = fract(flowTime);
  float ph1 = fract(ph0 + 0.5);
  float phaseBlend = abs(ph0 * 2.0 - 1.0);

  // Sample multi-lobe curl flow across 1.15x tile so each puff shows rich swirling eddies
  vec2 baseAtlasUv = vUv * 1.15 + seedBias;
  vec2 flowVec = texture(uSmokeAtlas, baseAtlasUv).gb * 2.0 - 1.0;
  float flowAmp = 0.11 + 0.17 * pow(vLifeFrac, 0.78);

  vec2 uv0 = baseAtlasUv - flowVec * ((ph0 - 0.5) * flowAmp);
  vec2 uv1 = baseAtlasUv - flowVec * ((ph1 - 0.5) * flowAmp) + vec2(0.37, 0.61);

  vec4 advected = mix(
    texture(uSmokeAtlas, uv0),
    texture(uSmokeAtlas, uv1),
    phaseBlend
  );

  vec2 wispUv = vUv * 2.35 - seedBias * 0.72 - flowVec * (flowAmp * 0.85) + vec2(-0.08, -0.18) * vLifeFrac;
  vec4 fineSample = texture(uSmokeAtlas, wispUv);

  float macroDensity = advected.r * 0.68 + fineSample.r * 0.32;
  float wispFilaments = advected.a * 0.42 + fineSample.a * 0.58;

  float isExhaust = smoothstep(1.3, 1.8, vType);
  float isDrift = smoothstep(0.3, 0.8, vType) * (1.0 - isExhaust);

  // Feather ONLY the outer quad safety margin so turbulent cloud lobes carve the real silhouette!
  float outerMargin = smoothstep(0.99, 0.62, r);
  float radialEnvelope = smoothstep(0.95, 0.18, r + (0.48 - macroDensity) * 0.36);

  float erodeThresh = mix(0.24, 0.68, pow(vLifeFrac, 1.12));
  float billowField = macroDensity * 0.62 + wispFilaments * 0.38 + (1.0 - r) * 0.24;
  float cloudShape = smoothstep(erodeThresh - 0.15, erodeThresh + 0.18, billowField);

  float density = outerMargin * radialEnvelope * cloudShape;
  if (density < 0.004) discard;

  // Smooth emergence & airy dissipation tail
  float fadeIn = smoothstep(0.0, mix(0.09, 0.04, isExhaust), vLifeFrac);
  float fadeOut = pow(1.0 - smoothstep(0.14, 1.0, vLifeFrac), mix(1.45, 1.40, isExhaust));

  // === 2. ANALYTICAL SOFT-PARTICLE FEATHERING (TERRAIN + TRUCK CAB/BED OBB) ===
  float softGround = smoothstep(-0.18, mix(0.22, 0.07, isExhaust), vWorldPos.y - vGroundY);
  float softCamera = smoothstep(1.0, 3.2, vCamDist);

  vec2 relXZ = vWorldPos.xz - uVehiclePos.xz;
  float fwdLen = length(uVehicleFwd);
  vec2 vehFwd = (fwdLen > 0.01) ? (uVehicleFwd / fwdLen) : vec2(0.0, 1.0);
  vec2 vehRight = vec2(vehFwd.y, -vehFwd.x);
  float localZ = dot(relXZ, vehFwd);
  float localX = abs(dot(relXZ, vehRight));
  float localY = vWorldPos.y - uVehiclePos.y;

  float outX = smoothstep(0.86, 1.24, localX);
  float outZ = max(smoothstep(-2.45, -2.85, localZ), smoothstep(2.35, 2.75, localZ));
  float outY = max(smoothstep(1.68, 2.15, localY), smoothstep(0.36, 0.12, localY));
  float outsideTruck = clamp(max(outX, max(outZ, outY)), 0.16, 1.0);
  outsideTruck = mix(outsideTruck, 1.0, isExhaust * 0.88);

  // Calibrated translucent opacity: visible swirling wisps without opaque cotton blocks
  float typeOpacityScale = mix(0.46, 0.52, isDrift);
  typeOpacityScale = mix(typeOpacityScale, 0.44, isExhaust);
  float maxAlpha = mix(0.24, 0.30, isDrift);
  maxAlpha = mix(maxAlpha, 0.25, isExhaust);

  float alpha = clamp(
    pow(density, 0.88) * fadeIn * fadeOut * softGround * softCamera * outsideTruck * vOpacity * typeOpacityScale,
    0.0,
    maxAlpha
  );
  if (alpha < 0.004) discard;

  // === 3. 2-TAP DIRECTIONAL BEER-LAMBERT + POWDER-SUGAR SUN SELF-SHADOWING ===
  float stepScale = 0.85 + 0.25 * vLifeFrac;
  vec2 tap1Uv = vUv + vLightUvDir * (0.095 * stepScale);
  vec2 tap2Uv = vUv + vLightUvDir * (0.215 * stepScale);

  float mask1 = smoothstep(1.05, 0.25, length(tap1Uv - vec2(0.5)) * 2.0);
  float mask2 = smoothstep(1.05, 0.25, length(tap2Uv - vec2(0.5)) * 2.0);

  vec2 sunFlowShift = -flowVec * ((ph0 - 0.5) * flowAmp * 0.6);
  float occ1 = texture(uSmokeAtlas, tap1Uv * 1.15 + seedBias + sunFlowShift).r * mask1;
  float occ2 = texture(uSmokeAtlas, tap2Uv * 1.15 + seedBias + sunFlowShift).r * mask2;

  float thicknessGain = mix(1.95, 2.15, max(isDrift, isExhaust)) * (1.0 - 0.35 * vLifeFrac);
  float sunOpticalDepth = (occ1 * 0.62 + occ2 * 0.38) * thicknessGain * clamp(vOpacity, 0.30, 1.0);

  float beer = exp(-sunOpticalDepth * 2.25);
  float powder = 1.0 - exp(-density * 3.4) * 0.48;
  float sunTransmit = clamp(beer * powder * 1.12, 0.20, 1.0);

  // Henyey-Greenstein forward-scattering rim ONLY when backlit toward sun (avoid milky front wash)
  vec3 V = normalize(cameraPosition - vWorldPos);
  float cosTheta = dot(-V, normalize(uSunDir));
  float g = 0.68;
  float hgPhase = (1.0 - g * g) / (4.0 * 3.14159265 * pow(max(0.10, 1.0 + g * g - 2.0 * g * cosTheta), 1.5));
  float rimTranslucency = pow(clamp(1.0 - density * 0.72, 0.0, 1.0), 1.30);
  float silverLining = clamp(hgPhase * 0.65, 0.0, 1.1) * (0.16 + 0.84 * rimTranslucency);

  // Calibrated rich terracotta-ochre sand dust albedos (prevents ACES white-cream washout!)
  vec3 dustAlbedo = uDustColor * vec3(0.86, 0.64, 0.46);
  vec3 driftAlbedo = mix(dustAlbedo, vec3(0.54, 0.46, 0.38), 0.55);
  vec3 exhaustAlbedo = mix(
    vec3(0.24, 0.22, 0.21),
    vec3(0.46, 0.44, 0.42),
    smoothstep(0.06, 0.55, vLifeFrac)
  );

  vec3 baseAlbedo = mix(
    mix(dustAlbedo, driftAlbedo, isDrift),
    exhaustAlbedo,
    isExhaust
  );
  baseAlbedo *= mix(0.92, 1.08, vSeed);

  vec3 shadowFoldTint = mix(vec3(0.42, 0.27, 0.18), vec3(0.38, 0.38, 0.40), isExhaust);
  vec3 litCrestTint   = mix(vec3(0.96, 0.82, 0.66), vec3(0.88, 0.84, 0.78), isExhaust);

  vec3 directLight = uSunColor * mix(shadowFoldTint, litCrestTint, sunTransmit) * (0.78 + 0.26 * vQuadTop)
                   + uSunColor * (silverLining * mix(0.22, 0.10, isExhaust));
  vec3 ambientLight = mix(uGroundBounceColor * 0.56, uSkyColor * 0.48, vQuadTop)
                    * (0.30 + 0.22 * rimTranslucency);

  vec3 color = baseAlbedo * (directLight + ambientLight);

  // Subtle crimson brake-light scatter into rear trailing dust & exhaust plumes
  if (uBrakeLightPower > 0.05 && localZ < -2.0 && localZ > -7.5 && localX < 2.4) {
    float rearDist = length(vec3(localX * 0.7, localY - 1.0, localZ + 2.5));
    float brakeScatter = (1.0 / (1.0 + rearDist * rearDist * 0.65)) * uBrakeLightPower;
    color += vec3(1.15, 0.12, 0.05) * (brakeScatter * (0.28 + 0.42 * rimTranslucency));
  }

  // Matching desert aerial perspective fog from terrainSand.ts
  float fogFactor = 1.0 - exp(-pow(vCamDist * uFogDensity * 0.72, 1.72));
  float sunFogAlign = max(dot(-V, normalize(uSunDir)), 0.0);
  vec3 mieHorizon = mix(uFogColor, uFogColor * vec3(1.18, 0.96, 0.78) + vec3(0.11, 0.048, 0.012), pow(sunFogAlign, 3.0) * 0.78);
  color = mix(color, mieHorizon, clamp(fogFactor, 0.0, 1.0));

  if (uLinearHdrOutput < 0.5) {
    // Matching ACES filmic tone mapping + sRGB encode (fallback when HDR composer is off)
    color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
    color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));
  }

  fragColor = vec4(color, alpha);
}
`;

export const ROOST_PARTICLES_VERT = /* glsl */ `
precision highp float;

in vec3 aOrigin;     // spawn world pos
in vec3 aVelocity;   // initial velocity (m/s)
in vec4 aParams;     // x=spawnTime, y=lifetime, z=size, w=seed

uniform float uTime;
uniform float uGravity;
uniform vec2 uWindVec;
uniform float uPixelRatio;

out float vLifeFrac;
out float vSeed;
out vec2 vRotCS;

void main() {
  float age = uTime - aParams.x;
  float life = max(0.01, aParams.y);
  vLifeFrac = age / life;
  vSeed = aParams.w;

  if (age < 0.0 || age > life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vRotCS = vec2(1.0, 0.0);
    return;
  }

  float ang = vSeed * 6.2831853 + vLifeFrac * 3.5;
  vRotCS = vec2(cos(ang), sin(ang));

  // Ballistic trajectory with mild wind push and air drag
  float dragT = (1.0 - exp(-age * 1.25)) / 1.25;
  vec3 worldPos = aOrigin
    + aVelocity * dragT
    + vec3(uWindVec.x, 0.0, uWindVec.y) * (age * age * 0.42)
    + vec3(0.0, -0.5 * uGravity * age * age, 0.0);

  vec4 mvPos = viewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPos;

  float sizeAtten = (aParams.z * uPixelRatio * 255.0) / max(1.0, -mvPos.z);
  float fadeSize = 1.0 - smoothstep(0.60, 1.0, vLifeFrac);
  gl_PointSize = clamp(sizeAtten * fadeSize, 1.6, 10.5);
}
`;

export const ROOST_PARTICLES_FRAG = /* glsl */ `
precision highp float;

in float vLifeFrac;
in float vSeed;
in vec2 vRotCS;

uniform vec3 uSunColor;
uniform vec3 uSandColor;
uniform float uLinearHdrOutput;

out vec4 fragColor;

void main() {
  if (vLifeFrac < 0.0 || vLifeFrac > 1.0) discard;

  // Irregular chipped sand clod silhouette (zero atan/sin/cos in fragment: Chebyshev 3rd+5th harmonics)
  vec2 c = gl_PointCoord - vec2(0.5);
  vec2 rc = vec2(c.x * vRotCS.x - c.y * vRotCS.y, c.x * vRotCS.y + c.y * vRotCS.x);
  rc.x *= 1.25;

  float distSq = dot(rc, rc);
  if (distSq > 0.2304) discard; // conservative bound (0.48^2)
  float dist = sqrt(distSq);
  vec2 dir = rc / max(1e-4, dist);
  float x2 = dir.x * dir.x;
  float y2 = dir.y * dir.y;
  float s3 = dir.y * (3.0 - 4.0 * y2);
  float c5 = dir.x * (16.0 * x2 * x2 - 20.0 * x2 + 5.0);
  float jaggedRadius = 0.34 + 0.09 * s3 + 0.05 * c5;
  if (dist > jaggedRadius) discard;

  float clodMask = smoothstep(jaggedRadius, jaggedRadius * 0.35, dist);
  float lifeFade = 1.0 - smoothstep(0.50, 1.0, vLifeFrac);
  float alpha = clodMask * lifeFade * 0.88;

  // Subtle top-to-bottom sunlit grain shading
  float topShade = clamp(0.68 - rc.y * 0.85, 0.42, 1.08);
  vec3 litClod = uSandColor * (0.72 + 0.34 * vSeed) * (vec3(0.28, 0.24, 0.22) + uSunColor * 0.58) * topShade;
  if (uLinearHdrOutput < 0.5) {
    litClod = (litClod * (2.51 * litClod + 0.03)) / (litClod * (2.43 * litClod + 0.59) + 0.14);
    litClod = pow(clamp(litClod, 0.0, 1.0), vec3(1.0 / 2.2));
  }

  fragColor = vec4(litClod, alpha);
}
`;

export const SPARK_PARTICLES_VERT = /* glsl */ `
precision highp float;

in vec3 aOrigin;
in vec3 aVelocity;
in vec4 aParams; // x=spawnTime, y=lifetime, z=size, w=seed

uniform float uTime;
uniform float uGravity;
uniform float uPixelRatio;

out float vLifeFrac;
out float vSeed;
out vec2 vVelScreen;

void main() {
  float age = uTime - aParams.x;
  float life = max(0.01, aParams.y);
  vLifeFrac = age / life;
  vSeed = aParams.w;

  if (age < 0.0 || age > life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vVelScreen = vec2(1.0, 0.0);
    return;
  }

  float dragT = (1.0 - exp(-age * 1.4)) / 1.4;
  vec3 velNow = aVelocity * exp(-age * 1.4) + vec3(0.0, -uGravity * age, 0.0);
  vec3 worldPos = aOrigin + aVelocity * dragT + vec3(0.0, -0.5 * uGravity * age * age, 0.0);

  vec4 mvPos = viewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPos;

  vec3 mvVel = (viewMatrix * vec4(velNow, 0.0)).xyz;
  float vLen = length(mvVel.xy);
  vVelScreen = (vLen > 0.001) ? (mvVel.xy / vLen) : vec2(0.0, 1.0);

  float fadeSize = 1.0 - smoothstep(0.35, 1.0, vLifeFrac);
  float ptSize = (aParams.z * uPixelRatio * 290.0) / max(1.0, -mvPos.z);
  gl_PointSize = clamp(ptSize * (0.4 + 0.8 * fadeSize), 2.2, 12.0);
}
`;

export const SPARK_PARTICLES_FRAG = /* glsl */ `
precision highp float;

uniform float uLinearHdrOutput;

in float vLifeFrac;
in float vSeed;
in vec2 vVelScreen;

out vec4 fragColor;

void main() {
  if (vLifeFrac < 0.0 || vLifeFrac > 1.0) discard;

  vec2 c = gl_PointCoord - vec2(0.5);
  // Orient streak cleanly along screen-space velocity vector
  vec2 dir = vec2(vVelScreen.x, -vVelScreen.y);
  vec2 perp = vec2(-dir.y, dir.x);
  float along = dot(c, dir) * 0.55;
  float across = dot(c, perp) * 2.2;
  float dist = length(vec2(along, across));
  if (dist > 0.48) discard;

  float core = smoothstep(0.48, 0.04, dist);
  float hot = pow(core, 2.2);
  float cool = pow(1.0 - vLifeFrac, 1.35);

  vec3 orangeEmber = vec3(1.0, 0.42, 0.06);
  vec3 whiteHot = vec3(1.0, 0.95, 0.82);
  vec3 col = mix(orangeEmber, whiteHot, clamp(hot * (1.0 - vLifeFrac * 0.65), 0.0, 1.0)) * 1.45;
  float alpha = core * cool * (0.78 + 0.22 * vSeed);

  if (uLinearHdrOutput < 0.5) {
    col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
    col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  }

  fragColor = vec4(col, alpha);
}
`;


