/**
 * automotiveRtReflections.ts
 * Lightweight pseudo-ray-traced automotive reflection shaders shared across
 * Rivian R1T clearcoat carpaint, dielectric glass, and metallic alloy/trim materials:
 *  - Asymmetric world-space ray-AABB slab intersection anchored flush to real groundPlaneY
 *  - Dual-lobe sharp cone-traced hardware cubemap (`uEnvCubeRaw`) for mirror clearcoat & glass
 *    paired with Three.js GGX PMREM (`envMap`) for rough metallic basecoat & diffuse IBL
 *  - Contact-hardening roughness cone widening proportional to ray travel distance
 *  - Analytical vehicle-body self-occlusion (eliminates sky bleed through chassis/underside)
 *  - Sébastien Lagarde physically based specular occlusion
 *  - Physical dielectric Schlick Fresnel & grazing glass reflectivity
 */

import * as THREE from 'three';
import type { ReflectionSharedUniforms } from '../adapters/VehicleReflectionSystem';

export function createFallbackReflectionUniforms(): ReflectionSharedUniforms {
  return {
    uEnvCubeRaw: { value: null },
    uHasRawCube: { value: 0.0 },
    uRawCubeMaxMip: { value: 6.0 },
    uCubeCenter: { value: new THREE.Vector3(0, 1.18, 0) },
    uCubeBoxHalf: { value: new THREE.Vector3(24, 14, 24) },
    uCubeBoxMin: { value: new THREE.Vector3(-24, 0, -24) },
    uCubeBoxMax: { value: new THREE.Vector3(24, 24, 24) },
    uVehicleInvMatrix: { value: new THREE.Matrix4() },
    uSunDir: { value: new THREE.Vector3(0.4, 0.35, 0.84) },
    uSunColor: { value: new THREE.Color(1.4, 1.1, 0.85) },
    uSkyColor: { value: new THREE.Color(0.55, 0.62, 0.72) },
    uGroundColor: { value: new THREE.Color(0.24, 0.20, 0.16) },
    uPccEnabled: { value: 0.0 },
    uReflectGain: { value: 1.05 },
    uReflLodBias: { value: 0.0 },
    uChassisDust: { value: 0.1 },
    uBiomeMud: { value: 0.0 },
  };
}

export function bindReflectionSharedUniforms(
  shaderUniforms: Record<string, THREE.IUniform>,
  shared: ReflectionSharedUniforms,
): void {
  shaderUniforms.uEnvCubeRaw = shared.uEnvCubeRaw;
  shaderUniforms.uHasRawCube = shared.uHasRawCube;
  shaderUniforms.uRawCubeMaxMip = shared.uRawCubeMaxMip;
  shaderUniforms.uCubeCenter = shared.uCubeCenter;
  shaderUniforms.uCubeBoxMin = shared.uCubeBoxMin;
  shaderUniforms.uCubeBoxMax = shared.uCubeBoxMax;
  shaderUniforms.uVehicleInvMatrix = shared.uVehicleInvMatrix;
  shaderUniforms.uSunDir = shared.uSunDir;
  shaderUniforms.uSunColor = shared.uSunColor;
  shaderUniforms.uSkyColor = shared.uSkyColor;
  shaderUniforms.uGroundColor = shared.uGroundColor;
  shaderUniforms.uPccEnabled = shared.uPccEnabled;
  shaderUniforms.uReflectGain = shared.uReflectGain;
  shaderUniforms.uReflLodBias = shared.uReflLodBias;
  shaderUniforms.uChassisDust = shared.uChassisDust;
  shaderUniforms.uBiomeMud = shared.uBiomeMud;
}

/**
 * Shared GLSL declarations & pure helper functions for asymmetric parallax-corrected
 * cone-traced cubemap reflections, Lagarde specular occlusion, and analytical self-body occlusion.
 */
export const AUTOMOTIVE_RT_UNIFORMS_AND_HELPERS_GLSL = /* glsl */ `
uniform samplerCube uEnvCubeRaw;
uniform float uHasRawCube;
uniform float uRawCubeMaxMip;
uniform vec3 uCubeCenter;
uniform vec3 uCubeBoxMin;
uniform vec3 uCubeBoxMax;
uniform mat4 uVehicleInvMatrix;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uPccEnabled;
uniform float uReflectGain;
uniform float uReflLodBias;
uniform float uChassisDust;
uniform float uBiomeMud;

// Analytical asymmetric world-space ray-AABB slab intersection (minY anchored to real ground plane)
vec3 rivProjectParallaxRay(
  vec3 worldPos,
  vec3 reflectDir,
  out float hitDist,
  out float isGroundHit
) {
  vec3 R = normalize( reflectDir );
  vec3 p = clamp( worldPos, uCubeBoxMin + vec3( 0.04 ), uCubeBoxMax - vec3( 0.04 ) );
  vec3 safeR = vec3(
    abs( R.x ) < 1e-5 ? ( R.x < 0.0 ? -1e-5 : 1e-5 ) : R.x,
    abs( R.y ) < 1e-5 ? ( R.y < 0.0 ? -1e-5 : 1e-5 ) : R.y,
    abs( R.z ) < 1e-5 ? ( R.z < 0.0 ? -1e-5 : 1e-5 ) : R.z
  );
  vec3 t1 = ( uCubeBoxMin - p ) / safeR;
  vec3 t2 = ( uCubeBoxMax - p ) / safeR;
  vec3 tFar = max( t1, t2 );
  hitDist = max( 0.25, min( min( tFar.x, tFar.y ), tFar.z ) );
  isGroundHit = ( R.y < -1e-3 && tFar.y <= tFar.x + 1e-3 && tFar.y <= tFar.z + 1e-3 ) ? 1.0 : 0.0;
  vec3 hitPos = p + R * hitDist;
  return normalize( hitPos - uCubeCenter );
}

// Contact-hardening ray-traced cone mip level: nearby road/sand/tree reflections stay sharp,
// distant sky/clouds and far-camera reflections soften naturally via distance-adaptive uReflLodBias.
float rivConeTracedMip( float roughness, float hitDist, float isGroundHit ) {
  float r = clamp( roughness, 0.0, 1.0 );
  float distT = smoothstep( 1.0, 16.0, hitDist );
  float distScale = mix( mix( 0.44, 0.34, isGroundHit ), 0.92, distT );
  float perceptualR = r * ( 1.85 - 0.85 * r );
  return clamp( perceptualR * uRawCubeMaxMip * distScale + uReflLodBias, 0.0, uRawCubeMaxMip );
}

// Sébastien Lagarde physically based specular occlusion
float rivLagardeSpecOcc( float NdotV, float ao, float roughness ) {
  float r = max( roughness, 0.02 );
  return clamp( pow( clamp( NdotV, 0.0, 1.0 ) + ao, exp2( -16.0 * r - 1.0 ) ) - 1.0 + ao, 0.0, 1.0 );
}

// Analytical vehicle-body self-reflection occlusion in Rivian body-local space
float rivSelfBodyOcclusion( vec3 worldPos, vec3 worldN, vec3 worldR ) {
  vec3 lp = ( uVehicleInvMatrix * vec4( worldPos, 1.0 ) ).xyz;
  mat3 invRot = mat3( uVehicleInvMatrix );
  vec3 ln = normalize( invRot * worldN );
  vec3 lr = normalize( invRot * worldR );

  float underbodyOcc = mix( 0.28, 1.0, smoothstep( 0.24, 0.68, lp.y ) );
  float normalOcc = mix( 0.22, 1.0, smoothstep( -0.42, 0.22, ln.y ) );

  float inwardOcc = 1.0;
  if ( abs( lp.x ) > 0.72 && lp.y > 0.40 && lp.y < 1.85 && abs( lp.z ) < 2.55 ) {
    float towardCenterX = lp.x > 0.0 ? -lr.x : lr.x;
    inwardOcc = 1.0 - smoothstep( 0.25, 0.80, towardCenterX ) * 0.68;
  }

  float bedOcc = 1.0;
  if ( lp.z < -0.60 && lp.z > -2.35 && abs( lp.x ) < 0.72 && lp.y < 1.15 ) {
    bedOcc = mix( 0.35, 1.0, smoothstep( 0.10, 0.65, lr.y ) );
  }

  return clamp( min( underbodyOcc, normalOcc ) * inwardOcc * bedOcc, 0.14, 1.0 );
}

// Samples sharp cone-traced live scene cubemap with asymmetric PCC, self-occlusion & ground-bounce grounding
vec3 rivSampleRayTracedMirror(
  vec3 worldPos,
  vec3 worldN,
  vec3 viewW,
  float roughness,
  float ao,
  out float outSelfOcc
) {
  vec3 R = reflect( -viewW, worldN );
  float hitDist = 12.0;
  float isGroundHit = 0.0;
  vec3 pccDir = ( uPccEnabled > 0.5 )
    ? rivProjectParallaxRay( worldPos, R, hitDist, isGroundHit )
    : R;

  float coneMip = rivConeTracedMip( roughness, hitDist, isGroundHit );
  vec3 envCol = textureLod( uEnvCubeRaw, pccDir, coneMip ).rgb;

  // Prevent overly hot specular fireflies from raw HDR sun texels while preserving crisp highlights
  envCol = min( envCol, vec3( 5.5 ) );

  // Ground-contact horizon richness: downward ground hits pick up subtle contact occlusion close to tires
  float groundNearDark = isGroundHit * ( 1.0 - smoothstep( 0.55, 3.2, hitDist ) ) * 0.24;
  envCol *= ( 1.0 - groundNearDark );

  outSelfOcc = rivSelfBodyOcclusion( worldPos, worldN, R );
  float NdotV = clamp( dot( worldN, viewW ), 0.0, 1.0 );
  float specOcc = rivLagardeSpecOcc( NdotV, ao * outSelfOcc, roughness );

  // Replace self-occluded sky leak with physically grounded dark body/ground ambient bounce
  vec3 selfBounce = uGroundColor * ( 0.26 + 0.18 * clamp( worldN.y * 0.5 + 0.5, 0.0, 1.0 ) );
  return mix( selfBounce, envCol, specOcc );
}
`;

/**
 * Replaces Three.js's default `envmap_physical_pars_fragment` reflectVec lookup with
 * our asymmetric world-space ground+corridor PCC projection (works on both basecoat PMREM and glass).
 */
export function buildAsymmetricPccEnvMapChunk(worldPosVarName: string): string {
  return THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
    'reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );',
    `reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );
if ( uPccEnabled > 0.5 ) {
  float _pccDist = 10.0;
  float _pccGround = 0.0;
  reflectVec = rivProjectParallaxRay( ${worldPosVarName}, reflectVec, _pccDist, _pccGround );
}`,
  );
}

export interface RivianGlassRtOptions {
  baseOpacity: number;
  grazingOpacity: number;
  tintColorHex?: number;
  reflectionBoost?: number;
  ior?: number;
}

/**
 * Enhances automotive glass (`window glass`, windshield, rear glass, side windows, trim glass)
 * with sharp cone-traced live-scene cubemap reflections, asymmetric ground/corridor PCC,
 * physical dielectric Schlick Fresnel (IOR 1.56), and grazing-angle opacity ramp.
 */
export function applyRivianGlassRtReflections(
  mat: THREE.MeshPhysicalMaterial,
  sharedUniforms: ReflectionSharedUniforms | undefined,
  cacheSuffix: string,
  opts: RivianGlassRtOptions,
): void {
  const uniforms = sharedUniforms ?? createFallbackReflectionUniforms();
  const f0 = Math.pow(((opts.ior ?? 1.56) - 1.0) / ((opts.ior ?? 1.56) + 1.0), 2);
  const reflBoost = opts.reflectionBoost ?? 1.38;

  mat.customProgramCacheKey = () => `duneflow_rivian_rt_glass_v3_${cacheSuffix}`;
  mat.onBeforeCompile = (shader) => {
    bindReflectionSharedUniforms(shader.uniforms, uniforms);
    shader.uniforms.uGlassBaseOpacity = { value: opts.baseOpacity };
    shader.uniforms.uGlassGrazingOpacity = { value: opts.grazingOpacity };
    shader.uniforms.uGlassF0 = { value: f0 };
    shader.uniforms.uGlassReflBoost = { value: reflBoost };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vRivGlassWorldPos;
varying vec3 vRivGlassWorldNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vec4 rivGlassWp = modelMatrix * vec4( transformed, 1.0 );
vRivGlassWorldPos = rivGlassWp.xyz;
vRivGlassWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vRivGlassWorldPos;
varying vec3 vRivGlassWorldNormal;
uniform float uGlassBaseOpacity;
uniform float uGlassGrazingOpacity;
uniform float uGlassF0;
uniform float uGlassReflBoost;
${AUTOMOTIVE_RT_UNIFORMS_AND_HELPERS_GLSL}`,
      )
      .replace(
        '#include <envmap_physical_pars_fragment>',
        buildAsymmetricPccEnvMapChunk('vRivGlassWorldPos'),
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
{
  vec3 glassViewW = normalize( cameraPosition - vRivGlassWorldPos );
  vec3 glassN = normalize( transformDirectionByInverseViewMatrix( normal, viewMatrix ) );
  if ( !gl_FrontFacing ) glassN = -glassN;
  float glassNdotV = clamp( dot( glassN, glassViewW ), 0.0, 1.0 );

  if ( uHasRawCube > 0.5 ) {
    float glassSelfOcc = 1.0;
    vec3 sharpGlassEnv = rivSampleRayTracedMirror(
      vRivGlassWorldPos,
      glassN,
      glassViewW,
      max( roughnessFactor, 0.015 ),
      0.96,
      glassSelfOcc
    );
    radiance = mix( radiance, sharpGlassEnv * uReflectGain * uGlassReflBoost, 0.94 );
    #ifdef USE_CLEARCOAT
      clearcoatRadiance = sharpGlassEnv * uReflectGain * ( uGlassReflBoost * 1.12 );
    #endif
  }
  // Physically realistic tempered automotive glass: clear head-on, mirrored at shallow grazing angles
  diffuseColor.a = clamp( mix( uGlassBaseOpacity, uGlassGrazingOpacity, pow( 1.0 - glassNdotV, 2.0 ) ), 0.12, 0.96 );
}`,
      );
  };
}

/**
 * Enhances exterior metallic trim & alloy wheel rims (`SF_wheelpaint.3`, `gunmetal`, `aluminum`)
 * with asymmetric ground/corridor PCC, Lagarde specular occlusion, and sharp grazing reflections.
 */
export function applyRivianMetalRtReflections(
  mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
  sharedUniforms: ReflectionSharedUniforms | undefined,
  cacheSuffix: string,
  sharpBlend = 0.52,
): void {
  const uniforms = sharedUniforms ?? createFallbackReflectionUniforms();

  mat.customProgramCacheKey = () => `duneflow_rivian_rt_metal_v3_${cacheSuffix}`;
  mat.onBeforeCompile = (shader) => {
    bindReflectionSharedUniforms(shader.uniforms, uniforms);
    shader.uniforms.uMetalSharpBlend = { value: sharpBlend };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vRivMetalWorldPos;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vRivMetalWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vRivMetalWorldPos;
uniform float uMetalSharpBlend;
${AUTOMOTIVE_RT_UNIFORMS_AND_HELPERS_GLSL}`,
      )
      .replace(
        '#include <envmap_physical_pars_fragment>',
        buildAsymmetricPccEnvMapChunk('vRivMetalWorldPos'),
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
{
  vec3 mViewW = normalize( cameraPosition - vRivMetalWorldPos );
  vec3 mN = normalize( transformDirectionByInverseViewMatrix( normal, viewMatrix ) );
  float mNdotV = clamp( dot( mN, mViewW ), 0.0, 1.0 );
  float mSelfOcc = 1.0;
  if ( uHasRawCube > 0.5 && roughnessFactor < 0.48 ) {
    vec3 sharpEnv = rivSampleRayTracedMirror( vRivMetalWorldPos, mN, mViewW, max( roughnessFactor, 0.04 ), 0.88, mSelfOcc );
    float smoothGate = ( 1.0 - smoothstep( 0.14, 0.48, roughnessFactor ) ) * uMetalSharpBlend;
    radiance = mix( radiance, sharpEnv * uReflectGain, smoothGate );
    #ifdef USE_CLEARCOAT
      clearcoatRadiance = mix( clearcoatRadiance, sharpEnv * uReflectGain, min( 0.92, smoothGate + 0.35 ) );
    #endif
  } else {
    float occ = rivLagardeSpecOcc( mNdotV, 0.86, roughnessFactor );
    radiance *= occ;
  }
}`,
      );
  };
}
