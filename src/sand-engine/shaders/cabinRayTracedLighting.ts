/**
 * cabinRayTracedLighting.ts
 * Physically calibrated Real-Time Ray-Traced Rectangular Area-Light & Multi-Bounce
 * Path-Traced Global Illumination (GI) shader enhancement for the Ford F-150 Raptor R.
 *
 * Key physically-based properties (evaluated BEFORE ACES tone-mapping at `#include <lights_fragment_end>`):
 *  - Diffuse GI bounce is properly modulated by `diffuseColor.rgb` (albedo!), keeping the Raptor R's
 *    deep charcoal leather & headliner rich and moody while catching authentic colored multi-bounce fill.
 *  - Specular reflections from all 6 cabin emitters (12" SYNC 4 screen, 12" Digital Cluster, upper/lower
 *    dash LED light pipes, left/right door LED strips, overhead Dome area light, exterior headlight/hazard
 *    windshield bounce) are added to `reflectedLight.directSpecular` with dielectric Fresnel + GGX lobe,
 *    producing razor-crisp colored & screen reflections across woven carbon-fiber clearcoat, brushed chrome
 *    vents, gloss black bezels, steering wheel leather grain, and the Ford oval emblem!
 *
 * Uses `uCabinInvMatrix` (synced from `bodyGroup.matrixWorld.invert()` each frame) so every reflection
 * is 100% locked to Raptor R cabin space at any speed, turn, or rollover angle.
 */

import * as THREE from 'three';

export interface CabinRtLightingUniforms {
  uCabinInvMatrix: { value: THREE.Matrix4 };
  uRtEnabled: { value: number };
  uRtBounceGain: { value: number };
  uAmbientColor: { value: THREE.Color };
  uAmbientIntensity: { value: number };
  uDomeIntensity: { value: number };
  uSyncScreenColor: { value: THREE.Color };
  uSyncScreenIntensity: { value: number };
  uClusterIntensity: { value: number };
  uHeadlightBounce: { value: number };
  uHazardFlash: { value: number };
  uLightbarPower: { value: number };
  uTime: { value: number };
}

export interface CabinRtMaterialOptions {
  /** Specular mirror-like reflection responsiveness (0.15 headliner .. 1.45 gloss bezel/carbon/chrome) */
  specStrength: number;
  /** Diffuse multi-bounce GI responsiveness (0.35 dark plastic .. 1.05 leather/carbon) */
  giStrength: number;
  /** Micro-roughness for analytic area-light GGX lobe (0.08 gloss .. 0.60 leather) */
  areaRoughness: number;
  /** Shared shader program cache tier */
  cacheKey: string;
}

export function createCabinRtLightingUniforms(): CabinRtLightingUniforms {
  return {
    uCabinInvMatrix: { value: new THREE.Matrix4() },
    uRtEnabled: { value: 1.0 },
    uRtBounceGain: { value: 1.15 },
    uAmbientColor: { value: new THREE.Color(0xff5a14) },
    uAmbientIntensity: { value: 0.85 },
    uDomeIntensity: { value: 0.0 },
    uSyncScreenColor: { value: new THREE.Color(0x28c76f) },
    uSyncScreenIntensity: { value: 0.95 },
    uClusterIntensity: { value: 0.85 },
    uHeadlightBounce: { value: 0.65 },
    uHazardFlash: { value: 0.0 },
    uLightbarPower: { value: 0.0 },
    uTime: { value: 0.0 },
  };
}

/**
 * Injects physically calibrated body-local Ray-Traced Area-Light Specular + Path-Traced Multi-Bounce GI
 * into Three.js MeshStandardMaterial / MeshPhysicalMaterial inside `#include <lights_fragment_end>`
 * (linear HDR space, BEFORE ACES Filmic tone-mapping & sRGB output encoding!).
 */
export function applyCabinRayTracedLighting(
  mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
  uniforms: CabinRtLightingUniforms,
  opts: CabinRtMaterialOptions,
): void {
  const prevCache = mat.customProgramCacheKey?.() ?? '';
  mat.customProgramCacheKey = () => `${prevCache}_raptor_rt_cabin_v3_${opts.cacheKey}`;

  const prevCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prevCompile) {
      prevCompile(shader, renderer);
    }

    shader.uniforms.uCabinInvMatrix = uniforms.uCabinInvMatrix;
    shader.uniforms.uRtEnabled = uniforms.uRtEnabled;
    shader.uniforms.uRtBounceGain = uniforms.uRtBounceGain;
    shader.uniforms.uAmbientColor = uniforms.uAmbientColor;
    shader.uniforms.uAmbientIntensity = uniforms.uAmbientIntensity;
    shader.uniforms.uDomeIntensity = uniforms.uDomeIntensity;
    shader.uniforms.uSyncScreenColor = uniforms.uSyncScreenColor;
    shader.uniforms.uSyncScreenIntensity = uniforms.uSyncScreenIntensity;
    shader.uniforms.uClusterIntensity = uniforms.uClusterIntensity;
    shader.uniforms.uHeadlightBounce = uniforms.uHeadlightBounce;
    shader.uniforms.uHazardFlash = uniforms.uHazardFlash;
    shader.uniforms.uLightbarPower = uniforms.uLightbarPower;
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uRtSpecStrength = { value: opts.specStrength };
    shader.uniforms.uRtGiStrength = { value: opts.giStrength };
    shader.uniforms.uRtAreaRoughness = { value: opts.areaRoughness };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vRtWorldPos;
varying vec3 vRtWorldNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vec4 rtWp = modelMatrix * vec4( transformed, 1.0 );
vRtWorldPos = rtWp.xyz;
vRtWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vRtWorldPos;
varying vec3 vRtWorldNormal;

uniform mat4 uCabinInvMatrix;
uniform float uRtEnabled;
uniform float uRtBounceGain;
uniform vec3 uAmbientColor;
uniform float uAmbientIntensity;
uniform float uDomeIntensity;
uniform vec3 uSyncScreenColor;
uniform float uSyncScreenIntensity;
uniform float uClusterIntensity;
uniform float uHeadlightBounce;
uniform float uHazardFlash;
uniform float uLightbarPower;
uniform float uTime;
uniform float uRtSpecStrength;
uniform float uRtGiStrength;
uniform float uRtAreaRoughness;

struct RtAreaOut {
  vec3 diff;
  vec3 spec;
};

// Physically-based Karis Representative-Point Rectangular Area Light (separate Diffuse GI & Specular!)
RtAreaOut rtEvalRectAreaLight(
  vec3 P, vec3 N, vec3 V, vec3 R,
  vec3 lightPos, vec3 lightRight, vec3 lightUp, vec3 lightFwd,
  vec2 halfSize, vec3 lightColor, float rough
) {
  RtAreaOut res;
  float denom = dot( R, lightFwd );
  vec3 toPlane = lightPos - P;
  vec3 closestPt = lightPos;
  if ( abs( denom ) > 1e-4 ) {
    float t = dot( toPlane, lightFwd ) / denom;
    vec3 hitPt = P + R * max( t, 0.015 );
    vec3 d = hitPt - lightPos;
    float u = clamp( dot( d, lightRight ), -halfSize.x, halfSize.x );
    float v = clamp( dot( d, lightUp ), -halfSize.y, halfSize.y );
    closestPt = lightPos + lightRight * u + lightUp * v;
  } else {
    vec3 d = P - lightPos;
    float u = clamp( dot( d, lightRight ), -halfSize.x, halfSize.x );
    float v = clamp( dot( d, lightUp ), -halfSize.y, halfSize.y );
    closestPt = lightPos + lightRight * u + lightUp * v;
  }

  vec3 Lvec = closestPt - P;
  float dist = length( Lvec );
  vec3 L = Lvec / max( dist, 1e-4 );

  float emitterSide = smoothstep( -0.15, 0.35, dot( -L, lightFwd ) );
  float atten = 1.0 / ( 0.06 + dist * dist * 5.2 );

  vec3 H = normalize( L + V );
  float NdotL = max( dot( N, L ), 0.0 );
  float NdotH = max( dot( N, H ), 0.0 );
  float NdotV = max( dot( N, V ), 0.001 );
  float specPow = mix( 180.0, 18.0, clamp( rough, 0.0, 1.0 ) );
  float specNorm = mix( 2.2, 0.32, clamp( rough, 0.0, 1.0 ) );
  float spec = pow( NdotH, specPow ) * specNorm;
  float fresnel = 0.06 + 0.94 * pow( 1.0 - NdotV, 4.4 );

  vec3 centerDir = normalize( lightPos - P );
  float diffNdotL = max( dot( N, centerDir ) * 0.72 + 0.28, 0.0 );
  float centerDist = length( lightPos - P );
  float diffAtten = 1.0 / ( 0.14 + centerDist * centerDist * 4.5 );

  res.spec = lightColor * spec * fresnel * NdotL * atten * emitterSide * uRtSpecStrength;
  res.diff = lightColor * diffNdotL * diffAtten * ( 0.22 + 0.78 * emitterSide ) * uRtGiStrength;
  return res;
}

// Physically-based Analytic Linear Tube LED Light Pipe (tight localized halo + razor-sharp specular ribbon!)
RtAreaOut rtEvalTubeLight(
  vec3 P, vec3 N, vec3 V, vec3 R,
  vec3 A, vec3 B, vec3 lightColor, float rough
) {
  RtAreaOut res;
  vec3 AB = B - A;
  float abLenSq = max( dot( AB, AB ), 1e-4 );
  vec3 L0 = A - P;
  float RdotLd = dot( R, AB );
  float denom = max( abLenSq - RdotLd * RdotLd, 1e-4 );
  float t = clamp( ( dot( R, L0 ) * RdotLd - dot( L0, AB ) ) / denom, 0.0, 1.0 );
  vec3 closestPt = A + AB * t;

  vec3 Lvec = closestPt - P;
  float dist = length( Lvec );
  vec3 L = Lvec / max( dist, 1e-4 );

  vec3 H = normalize( L + V );
  float NdotL = max( dot( N, L ), 0.0 );
  float NdotH = max( dot( N, H ), 0.0 );
  float NdotV = max( dot( N, V ), 0.001 );
  float specPow = mix( 160.0, 16.0, clamp( rough, 0.0, 1.0 ) );
  float specNorm = mix( 1.85, 0.28, clamp( rough, 0.0, 1.0 ) );
  float spec = pow( NdotH, specPow ) * specNorm;
  float fresnel = 0.08 + 0.92 * pow( 1.0 - NdotV, 4.0 );
  // Tight inverse-square falloff so LED strips create crisp luxury reflections without washing out ceiling!
  float specAtten = 1.0 / ( 0.025 + dist * dist * 9.5 );

  float tDiff = clamp( dot( P - A, AB ) / abLenSq, 0.0, 1.0 );
  vec3 diffPt = A + AB * tDiff;
  vec3 dVec = diffPt - P;
  float dDist = length( dVec );
  vec3 dDir = dVec / max( dDist, 1e-4 );
  float diffNdotL = max( dot( N, dDir ) * 0.72 + 0.28, 0.0 );
  float diffAtten = 1.0 / ( 0.035 + dDist * dDist * 14.0 );
  float rangeWindow = 1.0 - smoothstep( 0.42, 0.95, dDist );

  res.spec = lightColor * spec * fresnel * ( 0.15 + 0.85 * NdotL ) * specAtten * uRtSpecStrength;
  res.diff = lightColor * diffNdotL * diffAtten * rangeWindow * uRtGiStrength;
  return res;
}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
// --- Physically Calibrated Raptor R Ray-Traced Area-Light & Path-Traced Multi-Bounce GI ---
if ( uRtEnabled > 0.01 ) {
  mat3 cabInvRot = mat3( uCabinInvMatrix );
  vec3 P = ( uCabinInvMatrix * vec4( vRtWorldPos, 1.0 ) ).xyz;
  vec3 N = normalize( cabInvRot * normalize( vRtWorldNormal ) );
  vec3 camCab = ( uCabinInvMatrix * vec4( cameraPosition, 1.0 ) ).xyz;
  vec3 V = normalize( camCab - P );
  vec3 R = reflect( -V, N );
  float rough = clamp( uRtAreaRoughness, 0.06, 0.72 );
  float gain = uRtEnabled * uRtBounceGain;

  vec3 totalDiff = vec3( 0.0 );
  vec3 totalSpec = vec3( 0.0 );
  RtAreaOut tmp;

  // 1. 12" SYNC 4 Touchscreen Rect Area Light (reflects crisp screen glow onto bezel, vents, carbon & console!)
  if ( uSyncScreenIntensity > 0.01 ) {
    tmp = rtEvalRectAreaLight(
      P, N, V, R,
      vec3( -0.04, 1.305, 0.916 ),
      vec3( 0.998, 0.0, -0.06 ),
      vec3( 0.0, 0.998, 0.06 ),
      vec3( 0.06, 0.06, -0.996 ),
      vec2( 0.18, 0.12 ),
      uSyncScreenColor * ( 0.38 * uSyncScreenIntensity ),
      rough
    );
    totalDiff += tmp.diff;
    totalSpec += tmp.spec;
  }

  // 2. 12" Digital Cluster Rect Area Light (reflects crisp white/cool glow onto steering wheel spokes & Ford hub!)
  if ( uClusterIntensity > 0.01 ) {
    tmp = rtEvalRectAreaLight(
      P, N, V, R,
      vec3( 0.40, 1.325, 0.966 ),
      vec3( 1.0, 0.0, 0.0 ),
      vec3( 0.0, 0.998, 0.05 ),
      vec3( 0.0, 0.05, -0.998 ),
      vec2( 0.18, 0.07 ),
      vec3( 0.50, 0.64, 0.85 ) * ( 0.34 * uClusterIntensity ),
      rough
    );
    totalDiff += tmp.diff;
    totalSpec += tmp.spec;
  }

  // 3. Recessed Dashboard, Carbon-Fiber & Door Ambient LED Light Pipes (tight automotive glow!)
  if ( uAmbientIntensity > 0.01 ) {
    vec3 ambCol = uAmbientColor * ( 0.56 * uAmbientIntensity );
    // Passenger carbon-fiber upper & lower accent pipes
    tmp = rtEvalTubeLight( P, N, V, R, vec3( -0.28, 1.396, 0.926 ), vec3( -0.80, 1.396, 0.926 ), ambCol, rough );
    totalDiff += tmp.diff; totalSpec += tmp.spec;
    tmp = rtEvalTubeLight( P, N, V, R, vec3( -0.28, 1.233, 0.936 ), vec3( -0.80, 1.233, 0.936 ), ambCol * 0.85, rough );
    totalDiff += tmp.diff; totalSpec += tmp.spec;
    // SYNC 4 upper/lower & cluster brow subtle halo
    tmp = rtEvalTubeLight( P, N, V, R, vec3( 0.58, 1.416, 0.946 ), vec3( -0.24, 1.436, 0.922 ), ambCol * 0.72, rough );
    totalDiff += tmp.diff; totalSpec += tmp.spec;
    // Driver & Passenger Door Card LED Strips
    tmp = rtEvalTubeLight( P, N, V, R, vec3( 0.766, 1.318, 0.96 ), vec3( 0.766, 1.318, 0.32 ), ambCol * 0.78, rough );
    totalDiff += tmp.diff; totalSpec += tmp.spec;
    tmp = rtEvalTubeLight( P, N, V, R, vec3( -0.766, 1.318, 0.96 ), vec3( -0.766, 1.318, 0.32 ), ambCol * 0.62, rough );
    totalDiff += tmp.diff; totalSpec += tmp.spec;

    // Subtle Multi-Bounce Path-Traced Grazing Rim Reflection on leather/chrome/carbon
    float fresnelRim = pow( 1.0 - max( dot( N, V ), 0.0 ), 3.4 );
    float cabMidMask = smoothstep( 1.82, 1.45, P.y ); // keeps dark headliner moody!
    totalSpec += uAmbientColor * ( 0.065 * uAmbientIntensity * fresnelRim * cabMidMask * uRtSpecStrength );
    totalDiff += uAmbientColor * ( 0.045 * uAmbientIntensity * cabMidMask * uRtGiStrength );
  }

  // 4. Overhead Dome / Map Soft Area Light + Warm Multi-Bounce Cabin Fill
  if ( uDomeIntensity > 0.01 ) {
    tmp = rtEvalRectAreaLight(
      P, N, V, R,
      vec3( -0.02, 1.855, 0.70 ),
      vec3( 1.0, 0.0, 0.0 ),
      vec3( 0.0, 0.0, 1.0 ),
      vec3( 0.0, -1.0, 0.0 ),
      vec2( 0.14, 0.07 ),
      vec3( 1.0, 0.91, 0.76 ) * ( 1.45 * uDomeIntensity ),
      rough
    );
    totalDiff += tmp.diff * 1.35;
    totalSpec += tmp.spec * 1.15;
    // Soft multi-bounce warm fill reflecting upward off seats/dash so leather textures read richly!
    totalDiff += vec3( 0.95, 0.86, 0.72 ) * ( 0.18 * uDomeIntensity * uRtGiStrength );
  }

  // 5. Exterior Headlight / Lightbar / Blinking Hazard Windshield Reflection Bounce
  float frontExposure = smoothstep( 0.45, 1.15, P.z ) * clamp( N.y * 0.55 + N.z * 0.45 + 0.25, 0.0, 1.0 );
  if ( uHeadlightBounce > 0.01 || uLightbarPower > 0.01 ) {
    float extSpec = pow( max( dot( R, normalize( vec3( 0.0, 0.20, 0.98 ) ) ), 0.0 ), mix( 48.0, 8.0, rough ) );
    totalSpec += vec3( 0.76, 0.88, 1.0 ) * extSpec * ( uHeadlightBounce * 0.10 + uLightbarPower * 0.16 ) * frontExposure * uRtSpecStrength;
    totalDiff += vec3( 0.72, 0.84, 1.0 ) * ( uHeadlightBounce * 0.06 + uLightbarPower * 0.12 ) * frontExposure * uRtGiStrength;
  }
  if ( uHazardFlash > 0.01 ) {
    float hazSpec = pow( max( dot( R, normalize( vec3( 0.25, 0.15, 0.95 ) ) ), 0.0 ), 14.0 );
    totalSpec += vec3( 1.0, 0.44, 0.04 ) * uHazardFlash * 0.18 * hazSpec * uRtSpecStrength;
    totalDiff += vec3( 1.0, 0.44, 0.04 ) * uHazardFlash * 0.12 * frontExposure * uRtGiStrength;
  }

  // Physically correct energy integration: Diffuse GI scales by surface albedo; Specular reflects directly!
  reflectedLight.directDiffuse += totalDiff * diffuseColor.rgb * gain;
  reflectedLight.directSpecular += totalSpec * gain;
}`,
      );
  };
}
