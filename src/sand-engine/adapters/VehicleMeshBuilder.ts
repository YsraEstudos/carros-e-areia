/**
 * VehicleMeshBuilder.ts
 * Photorealistic Metallic Crimson Ford F-150 Raptor R (SuperCrew 4x4)
 * with subdivided deformable sheet-metal body panels, V8 engine bay,
 * hollowed cabin shell (ready for full Phase 3 cockpit interior),
 * iconic C-clamp LED DRLs, embossed FORD honeycomb grille with 3 amber markers,
 * red front tow hooks, vented black hood scoop, perforated running boards,
 * machined-face Raptor beadlock wheels with raised white-letter BFG tires,
 * and detachable rigid-body crash subassemblies.
 *
 * 100% procedural PBR geometry + CanvasTexture details (zero external fetches).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  DamageZone,
  DeformMeshBounds,
  DetachablePartId,
} from '../core/VehicleCrashPhysics';
import { ReflectionSharedUniforms } from './VehicleReflectionSystem';
import {
  buildRaptorCockpitInterior,
  RaptorCockpitRig,
} from './RaptorCockpitBuilder';
import {
  CabinRtLightingUniforms,
  createCabinRtLightingUniforms,
} from '../shaders/cabinRayTracedLighting';
import { createFallbackReflectionUniforms } from '../shaders/automotiveRtReflections';

export interface WheelMountSpec {
  x: number;
  z: number;
  isFront: boolean;
  isLeft: boolean;
}

export interface WheelVisualAssembly {
  steerPivot: THREE.Group;
  camberGroup: THREE.Group;
  spinGroup: THREE.Group;
  lowerArm: THREE.Mesh;
  upperArm: THREE.Mesh;
  coilGroup: THREE.Group;
}

export interface DeformableMeshRecord {
  id: string;
  mesh: THREE.Mesh;
  /** Center of panel in bodyGroup local space for fast proximity filtering */
  center: THREE.Vector3;
  /** Influence radius threshold */
  extentRadius: number;
  zoneHint: DamageZone;
  restPositions: Float32Array;
  restNormals: Float32Array;
  restColors: Float32Array;
  innerCoreClamp?: DeformMeshBounds;
  /** Optional transform from vehicle bodyGroup space into mesh local vertex space (used by GLB panels) */
  bodyToLocal?: THREE.Matrix4;
  /** Enables authentic longitudinal hood accordion V-buckle on frontal crashes */
  isHood?: boolean;
  /** Identifies matte black plastic bumpers / arch cladding so scrapes never brighten trim */
  isPlasticTrim?: boolean;
}

export interface TrophyTruckVisuals {
  bodyGroup: THREE.Group;
  hoodPivot: THREE.Group;
  steeringWheel: THREE.Group;
  whipAntenna: THREE.Group;
  brakeLightMatLeft: THREE.MeshStandardMaterial;
  brakeLightMatRight: THREE.MeshStandardMaterial;
  reverseLightMat: THREE.MeshStandardMaterial;
  headlightLensMatLeft: THREE.MeshStandardMaterial;
  headlightLensMatRight: THREE.MeshStandardMaterial;
  ledDrlMat: THREE.MeshStandardMaterial;
  ledDrlMatLeft?: THREE.MeshStandardMaterial;
  ledDrlMatRight?: THREE.MeshStandardMaterial;
  amberMarkerMat: THREE.MeshStandardMaterial;
  hazardLampMat: THREE.MeshStandardMaterial;
  lightbarLedMat: THREE.MeshStandardMaterial;
  boostGlowMat: THREE.MeshStandardMaterial;
  forwardBeamSpot: THREE.SpotLight;
  windshieldMesh: THREE.Mesh;
  rearGlassMesh: THREE.Mesh;
  leftMirrorPivot: THREE.Group;
  rightMirrorPivot: THREE.Group;
  leftMirrorLensMesh: THREE.Mesh;
  rightMirrorLensMesh: THREE.Mesh;
  interiorMirrorLensMesh: THREE.Mesh;
  intactGlassMat: THREE.MeshPhysicalMaterial;
  crackedGlassMat: THREE.MeshPhysicalMaterial;
  shatteredGlassMat: THREE.MeshPhysicalMaterial;
  intactRearGlassMat: THREE.MeshPhysicalMaterial;
  crackedRearGlassMat: THREE.MeshPhysicalMaterial;
  reflectiveMaterials: Array<{
    material: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
    baseEnvIntensity: number;
  }>;
  contactShadow: THREE.Mesh;
  wheelAssemblies: WheelVisualAssembly[];
  deformableMeshes: DeformableMeshRecord[];
  detachableGroups: Record<DetachablePartId, THREE.Group>;
  cockpit: RaptorCockpitRig;
  setTextureAnisotropy?: (maxAnisotropy: number) => void;
  setUnderHoodVisible?: (visible: boolean) => void;
  resetVisualDamage: () => void;
  dispose: () => void;
}

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function ensureVertexColorAttribute(geo: THREE.BufferGeometry): Float32Array {
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  colors.fill(1.0);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return colors;
}

function ensureScrapeAttribute(geo: THREE.BufferGeometry): Float32Array {
  if (geo.attributes.aScrape) {
    return geo.attributes.aScrape.array as Float32Array;
  }
  const count = geo.attributes.position.count;
  const scrapes = new Float32Array(count);
  geo.setAttribute('aScrape', new THREE.BufferAttribute(scrapes, 1));
  return scrapes;
}

/**
 * Rapid Red / Metallic Crimson Raptor R clearcoat automotive paint textures.
 * Rich glossy deep crimson with subtle metallic flake sheen and crisp character crease.
 */
function createRaptorRedPaintTextures(): {
  albedo: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
} {
  const w = 512;
  const h = 512;

  const cCol = document.createElement('canvas');
  cCol.width = w;
  cCol.height = h;
  const ctxC = cCol.getContext('2d')!;

  const cRough = document.createElement('canvas');
  cRough.width = w;
  cRough.height = h;
  const ctxR = cRough.getContext('2d')!;

  // Rich Ford Rapid Red / Metallic Crimson vertical tonal depth
  const baseGrad = ctxC.createLinearGradient(0, 0, 0, h);
  baseGrad.addColorStop(0.0, '#a61c15');
  baseGrad.addColorStop(0.35, '#8f150f');
  baseGrad.addColorStop(0.75, '#72100b');
  baseGrad.addColorStop(1.0, '#550b08');
  ctxC.fillStyle = baseGrad;
  ctxC.fillRect(0, 0, w, h);

  // Sleek wet-gloss clearcoat roughness (very smooth upper panels, slight road-spray sheen at rocker)
  const roughGrad = ctxR.createLinearGradient(0, 0, 0, h);
  roughGrad.addColorStop(0.0, 'rgb(34,34,34)');
  roughGrad.addColorStop(0.74, 'rgb(44,44,44)');
  roughGrad.addColorStop(0.92, 'rgb(74,74,74)');
  roughGrad.addColorStop(1.0, 'rgb(104,104,104)');
  ctxR.fillStyle = roughGrad;
  ctxR.fillRect(0, 0, w, h);

  // Subtle fine metallic flake variation
  for (let i = 0; i < 1200; i++) {
    const x = hash2(i, 1.3) * w;
    const y = hash2(i, 4.7) * h;
    const bright = hash2(i, 7.8) > 0.45 ? 255 : 0;
    ctxC.fillStyle = `rgba(${bright}, ${Math.round(bright * 0.25)}, ${Math.round(bright * 0.18)}, 0.024)`;
    ctxC.fillRect(x, y, 1.4, 1.4);
  }

  // Sculpted F-150 upper beltline swage crease & lower rocker accent
  ctxC.fillStyle = 'rgba(28, 3, 2, 0.22)';
  ctxC.fillRect(0, h * 0.34, w, 3);
  ctxC.fillStyle = 'rgba(255, 130, 105, 0.14)';
  ctxC.fillRect(0, h * 0.34 + 3, w, 2);

  ctxC.fillStyle = 'rgba(22, 2, 2, 0.20)';
  ctxC.fillRect(0, h * 0.80, w, 4);

  const albedo = new THREE.CanvasTexture(cCol);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = THREE.RepeatWrapping;
  albedo.wrapT = THREE.ClampToEdgeWrapping;
  albedo.anisotropy = 8;

  const roughness = new THREE.CanvasTexture(cRough);
  roughness.wrapS = THREE.RepeatWrapping;
  roughness.wrapT = THREE.ClampToEdgeWrapping;
  roughness.anisotropy = 8;

  return { albedo, roughness };
}

function createOrangePeelNormalMap(): THREE.DataTexture {
  const size = 256;
  const heights = new Float32Array(size * size);

  const samplePeriodic = (x: number, y: number, freq: number, seed: number): number => {
    const gx = (x / size) * freq;
    const gy = (y / size) * freq;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);

    const x0 = ((ix % freq) + freq) % freq;
    const x1 = (x0 + 1) % freq;
    const y0 = ((iy % freq) + freq) % freq;
    const y1 = (y0 + 1) % freq;

    const n00 = hash2(x0 + seed, y0 + seed * 1.7);
    const n10 = hash2(x1 + seed, y0 + seed * 1.7);
    const n01 = hash2(x0 + seed, y1 + seed * 1.7);
    const n11 = hash2(x1 + seed, y1 + seed * 1.7);
    const nx0 = n00 + (n10 - n00) * ux;
    const nx1 = n01 + (n11 - n01) * ux;
    return nx0 + (nx1 - nx0) * uy;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      heights[y * size + x] =
        samplePeriodic(x, y, 16, 11.3) * 0.55 +
        samplePeriodic(x, y, 32, 37.9) * 0.3 +
        samplePeriodic(x, y, 64, 71.1) * 0.15;
    }
  }

  const data = new Uint8Array(size * size * 4);
  const strength = 1.25;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const dx = (heights[y * size + xp] - heights[y * size + xm]) * strength;
      const dy = (heights[yp * size + x] - heights[ym * size + x]) * strength;
      const invLen = 1 / Math.hypot(dx, dy, 1);
      const idx = (y * size + x) * 4;
      data[idx + 0] = Math.round((-dx * invLen * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round((-dy * invLen * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round((invLen * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Clean transparent automotive front glass with subtle ceramic frit border & rain gloss.
 * Keeps cab interior clearly visible from outside just like Reference Image 3!
 */
function createWindshieldGlassTextures(): {
  albedo: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
} {
  const w = 512;
  const h = 256;

  const cA = document.createElement('canvas');
  cA.width = w;
  cA.height = h;
  const ctxA = cA.getContext('2d')!;

  const cR = document.createElement('canvas');
  cR.width = w;
  cR.height = h;
  const ctxR = cR.getContext('2d')!;

  const gradA = ctxA.createLinearGradient(0, 0, 0, h);
  gradA.addColorStop(0.0, '#12181d');
  gradA.addColorStop(0.14, '#1b2429');
  gradA.addColorStop(1.0, '#182026');
  ctxA.fillStyle = gradA;
  ctxA.fillRect(0, 0, w, h);

  // Very clean optical glass
  ctxR.fillStyle = 'rgb(14,14,14)';
  ctxR.fillRect(0, 0, w, h);

  // Dark ceramic frit dot border around windshield perimeter
  ctxA.strokeStyle = '#06080a';
  ctxA.lineWidth = 14;
  ctxA.strokeRect(0, 0, w, h);

  const albedo = new THREE.CanvasTexture(cA);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.anisotropy = 8;

  const roughness = new THREE.CanvasTexture(cR);
  roughness.anisotropy = 8;

  return { albedo, roughness };
}

function enhanceAutomotivePaintMaterial(
  mat: THREE.MeshPhysicalMaterial,
  sharedUniforms: ReflectionSharedUniforms | undefined,
  cacheSuffix: string,
  rtUniforms?: CabinRtLightingUniforms,
): void {
  const uniforms = sharedUniforms ?? createFallbackReflectionUniforms();
  const rt = rtUniforms ?? createCabinRtLightingUniforms();

  mat.customProgramCacheKey = () => `duneflow_raptor_paint_v5_rt_${cacheSuffix}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCubeCenter = uniforms.uCubeCenter;
    shader.uniforms.uCubeBoxHalf = uniforms.uCubeBoxHalf;
    shader.uniforms.uPccEnabled = uniforms.uPccEnabled;
    shader.uniforms.uReflectGain = uniforms.uReflectGain;
    shader.uniforms.uChassisDust = uniforms.uChassisDust;
    shader.uniforms.uBiomeMud = uniforms.uBiomeMud;
    shader.uniforms.uRtEnabled = rt.uRtEnabled;
    shader.uniforms.uRtBounceGain = rt.uRtBounceGain;
    shader.uniforms.uAmbientColor = rt.uAmbientColor;
    shader.uniforms.uAmbientIntensity = rt.uAmbientIntensity;
    shader.uniforms.uHeadlightBounce = rt.uHeadlightBounce;
    shader.uniforms.uHazardFlash = rt.uHazardFlash;
    shader.uniforms.uLightbarPower = rt.uLightbarPower;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aScrape;
varying vec3 vAutoWorldPos;
varying vec3 vAutoLocalPos;
varying vec3 vAutoWorldNormal;
varying float vAutoScrape;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vec4 autoWp = modelMatrix * vec4( transformed, 1.0 );
vAutoWorldPos = autoWp.xyz;
vAutoLocalPos = position;
vAutoWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
vAutoScrape = clamp( aScrape, 0.0, 1.0 );`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vAutoWorldPos;
varying vec3 vAutoLocalPos;
varying vec3 vAutoWorldNormal;
varying float vAutoScrape;
uniform vec3 uCubeCenter;
uniform vec3 uCubeBoxHalf;
uniform float uPccEnabled;
uniform float uReflectGain;
uniform float uChassisDust;
uniform float uBiomeMud;
uniform float uRtEnabled;
uniform float uRtBounceGain;
uniform vec3 uAmbientColor;
uniform float uAmbientIntensity;
uniform float uHeadlightBounce;
uniform float uHazardFlash;
uniform float uLightbarPower;

float autoHash31( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}
vec3 autoHash33( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yxx ) * p.zyx );
}`,
      )
      .replace(
        '#include <envmap_physical_pars_fragment>',
        THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
          'reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );',
          `reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );
if ( uPccEnabled > 0.5 ) {
  vec3 pccMin = uCubeCenter - uCubeBoxHalf;
  vec3 pccMax = uCubeCenter + uCubeBoxHalf;
  vec3 safeRef = vec3(
    abs( reflectVec.x ) < 1e-4 ? 1e-4 : reflectVec.x,
    abs( reflectVec.y ) < 1e-4 ? 1e-4 : reflectVec.y,
    abs( reflectVec.z ) < 1e-4 ? 1e-4 : reflectVec.z
  );
  vec3 tMax = ( pccMax - vAutoWorldPos ) / safeRef;
  vec3 tMin = ( pccMin - vAutoWorldPos ) / safeRef;
  vec3 tFar = max( tMax, tMin );
  float hitDist = min( min( tFar.x, tFar.y ), tFar.z );
  vec3 hitPos = vAutoWorldPos + reflectVec * max( hitDist, 0.6 );
  reflectVec = normalize( hitPos - uCubeCenter );
}`,
        ),
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
// Rapid Red / Metallic Crimson automotive flop (deep ruby at grazing, luminous scarlet-crimson head-on)
vec3 autoViewW = normalize( cameraPosition - vAutoWorldPos );
vec3 autoNormW = normalize( vAutoWorldNormal );
float autoNdotV = clamp( dot( autoNormW, autoViewW ), 0.0, 1.0 );
vec3 flopTint = mix( vec3( 0.62, 0.18, 0.16 ), vec3( 1.12, 0.94, 0.90 ), pow( autoNdotV, 0.72 ) );
diffuseColor.rgb *= flopTint;

// Subtle lower-body dust/mud patina (kept restrained so wet highway Raptor stays glossy red!)
float dustHeight = 1.0 - smoothstep( 0.44, 1.02, vAutoLocalPos.y );
float dustNoise = autoHash31( floor( vAutoLocalPos * 14.0 ) ) * 0.45 + autoHash31( floor( vAutoLocalPos * 4.5 ) ) * 0.55;
float autoDustMask = clamp( dustHeight * max( 0.0, uChassisDust - 0.10 ) * ( 0.55 + 0.75 * dustNoise ), 0.0, 0.58 );
vec3 biomePatina = mix( vec3( 0.52, 0.34, 0.18 ), vec3( 0.12, 0.09, 0.06 ), uBiomeMud );
diffuseColor.rgb = mix( diffuseColor.rgb, biomePatina, autoDustMask * 0.58 );

// Exposed brushed bare-steel crash scrapes
float scrapeStreak = 0.78 + 0.36 * autoHash31( floor( vAutoLocalPos * vec3( 46.0, 220.0, 46.0 ) ) );
float autoScrapeMask = smoothstep( 0.08, 0.78, vAutoScrape * scrapeStreak );
float primerRim = smoothstep( 0.03, 0.24, vAutoScrape ) * ( 1.0 - autoScrapeMask ) * 0.55;
vec3 primerCol = vec3( 0.34, 0.33, 0.32 );
vec3 bareSteelCol = vec3( 0.72, 0.74, 0.78 );
diffuseColor.rgb = mix( diffuseColor.rgb, primerCol, primerRim );
diffuseColor.rgb = mix( diffuseColor.rgb, bareSteelCol, autoScrapeMask );`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix( roughnessFactor, 0.86, autoDustMask * 0.72 );
roughnessFactor = mix( roughnessFactor, 0.28, autoScrapeMask );`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
metalnessFactor = mix( metalnessFactor, 0.92, autoScrapeMask );`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
float flakeFootprint = length( fwidth( vAutoLocalPos ) );
float flakeFade = ( 1.0 - smoothstep( 0.004, 0.022, flakeFootprint ) ) * ( 1.0 - autoDustMask ) * ( 1.0 - autoScrapeMask );
if ( flakeFade > 0.01 ) {
  vec3 flakeCell = floor( vAutoLocalPos * 160.0 );
  vec3 rndF = autoHash33( flakeCell );
  vec3 flakeN = normalize( autoNormW + ( rndF - 0.5 ) * 0.48 );
  vec3 flakeRef = reflect( -autoViewW, flakeN );
  float flakeSpark = pow( max( dot( flakeN, autoViewW ), 0.0 ), 12.0 ) * smoothstep( 0.64, 0.96, rndF.x );
  vec3 flakeCol = vec3( 1.0, 0.44, 0.30 ) * ( flakeSpark * flakeFade * 0.30 * ( 0.5 + 0.5 * clamp( flakeRef.y, 0.0, 1.0 ) ) );
  reflectedLight.directSpecular += flakeCol;
}

float cavitySpecOcc = smoothstep( -0.35, 0.25, autoNormW.y ) * 0.52 + 0.48;
float cleanClearcoat = ( 1.0 - autoDustMask * 0.72 ) * ( 1.0 - autoScrapeMask * 0.92 );
reflectedLight.indirectSpecular *= uReflectGain * cavitySpecOcc * mix( 0.62, 1.08, max( cleanClearcoat, autoScrapeMask ) );
#ifdef USE_CLEARCOAT
  clearcoatSpecularIndirect *= uReflectGain * cavitySpecOcc * cleanClearcoat * 1.15;
#endif

// Ray-Traced / Path-Traced Exterior Clearcoat Bounce (Headlights, Roof Lightbar, Hazard, Cabin Ambient Spill!)
if ( uRtEnabled > 0.01 ) {
  float fresnelExt = 0.12 + 0.88 * pow( 1.0 - autoNdotV, 3.6 );
  float rtGainExt = uRtEnabled * uRtBounceGain * cleanClearcoat;
  vec3 extBounce = vec3( 0.0 );
  // Front hood & fender wet clearcoat reflection from headlights + roof lightbar
  float frontZone = smoothstep( 0.85, 2.35, vAutoLocalPos.z );
  float roofZone = smoothstep( 1.35, 2.05, vAutoLocalPos.y ) * smoothstep( -0.4, 1.8, vAutoLocalPos.z );
  extBounce += vec3( 0.78, 0.88, 1.0 ) * ( uHeadlightBounce * 0.16 * frontZone + uLightbarPower * 0.28 * ( frontZone * 0.6 + roofZone ) ) * fresnelExt;
  // Blinking Amber Hazard specular reflection along front fenders, hood corners & mirror doors
  float cornerZone = smoothstep( 0.55, 2.45, vAutoLocalPos.z ) * smoothstep( 0.45, 0.96, abs( vAutoLocalPos.x ) );
  extBounce += vec3( 1.0, 0.48, 0.05 ) * ( uHazardFlash * 0.34 * cornerZone * ( 0.35 + 0.65 * fresnelExt ) );
  // Subtle cabin ambient LED window spill reflecting off door beltline & A-pillar clearcoat!
  float cabBeltZone = smoothstep( -0.45, 0.95, vAutoLocalPos.z ) * smoothstep( 1.05, 1.55, vAutoLocalPos.y ) * ( 1.0 - smoothstep( 1.65, 2.05, vAutoLocalPos.y ) );
  extBounce += uAmbientColor * ( uAmbientIntensity * 0.14 * cabBeltZone * fresnelExt );
  reflectedLight.directSpecular += extBounce * rtGainExt;
}`,
      );
  };
}

function createCrackedGlassTexture(heavyShatter: boolean): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#141c24');
  grad.addColorStop(0.5, '#0b1015');
  grad.addColorStop(1, '#090d12');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const centers = heavyShatter
    ? [
        { x: w * 0.34, y: h * 0.42, r: 175 },
        { x: w * 0.68, y: h * 0.34, r: 155 },
        { x: w * 0.52, y: h * 0.64, r: 130 },
      ]
    : [{ x: w * 0.38, y: h * 0.46, r: 135 }];

  for (let ci = 0; ci < centers.length; ci++) {
    const center = centers[ci];
    const rays = heavyShatter ? 24 : 15;
    for (let r = 0; r < rays; r++) {
      const ang = (r / rays) * Math.PI * 2 + (hash2(r, ci + 1) - 0.5) * 0.24;
      ctx.strokeStyle =
        r % 2 === 0 ? 'rgba(235, 244, 255, 0.85)' : 'rgba(180, 206, 232, 0.62)';
      ctx.lineWidth = r % 3 === 0 ? 2.1 : 1.25;
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      const steps = 6;
      for (let s = 1; s <= steps; s++) {
        const rad = (s / steps) * center.r * (0.65 + hash2(r + s, ci) * 0.5);
        const jitter = (hash2(s * 7, r * 3 + ci) - 0.5) * 0.14;
        ctx.lineTo(
          center.x + Math.cos(ang + jitter) * rad,
          center.y + Math.sin(ang + jitter) * rad,
        );
      }
      ctx.stroke();
    }

    const rings = heavyShatter ? 6 : 4;
    for (let k = 1; k <= rings; k++) {
      const ringR = (k / rings) * center.r * 0.72;
      ctx.strokeStyle =
        k <= 2 ? 'rgba(240, 248, 255, 0.88)' : 'rgba(205, 222, 238, 0.55)';
      ctx.lineWidth = k === 1 ? 1.8 : 1.1;
      ctx.beginPath();
      const segs = 18;
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const rr = ringR * (0.85 + hash2(s, k + ci * 5) * 0.28);
        const x = center.x + Math.cos(a) * rr;
        const y = center.y + Math.sin(a) * rr;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    const crush = ctx.createRadialGradient(center.x, center.y, 1, center.x, center.y, 26);
    crush.addColorStop(0, 'rgba(235, 242, 248, 0.85)');
    crush.addColorStop(0.5, 'rgba(180, 198, 214, 0.38)');
    crush.addColorStop(1, 'rgba(180, 198, 214, 0.0)');
    ctx.fillStyle = crush;
    ctx.fillRect(center.x - 28, center.y - 28, 56, 56);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createRaptorHoneycombGrilleTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#07080a';
  ctx.fillRect(0, 0, w, h);

  // Heavy Raptor matte-black angular hexagonal honeycomb mesh
  ctx.strokeStyle = '#26292e';
  ctx.lineWidth = 4.2;
  const r = 13;
  const dx = r * 1.72;
  const dy = r * 1.48;
  for (let row = -1; row < h / dy + 2; row++) {
    for (let col = -1; col < w / dx + 2; col++) {
      const cx = col * dx + (row % 2 === 0 ? 0 : dx * 0.5);
      const cy = row * dy;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function createRunningBoardTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#1b1d21';
  ctx.fillRect(0, 0, w, h);

  // Cast aluminum Raptor tread slots & embossed grip dimples
  for (let i = 0; i < 18; i++) {
    const x = 18 + i * 27;
    ctx.fillStyle = '#08090b';
    ctx.beginPath();
    ctx.roundRect(x, 22, 16, 32, 6);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(x, 72, 16, 32, 6);
    ctx.fill();

    ctx.strokeStyle = '#363a42';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(x - 1, 21, 18, 34);
    ctx.strokeRect(x - 1, 71, 18, 34);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createRaptorSideDecalTexture(isLeft: boolean): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  // Both outward-facing PlaneGeometry flanks read left-to-right; align RAPTOR toward the rear corner!
  ctx.font = 'italic 900 58px sans-serif';
  ctx.textBaseline = 'middle';
  if (isLeft) {
    // Left side (+X, ry=+PI/2): left of texture = rear (-Z), right = front (+Z)
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(18, 16, 18, 0.78)';
    ctx.fillText('RAPTOR', 28, 82);
    ctx.fillStyle = 'rgba(218, 42, 22, 0.94)';
    ctx.fillText('R', 268, 82);
  } else {
    // Right side (-X, ry=-PI/2): right of texture = rear (-Z), left = front (+Z)
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(18, 16, 18, 0.78)';
    ctx.fillText('RAPTOR', w - 28, 82);
    ctx.fillStyle = 'rgba(218, 42, 22, 0.94)';
    ctx.fillText('R', w - 270, 82);
  }

  // Subtle matte-black angular hash graphics trailing forward along upper bedside
  ctx.strokeStyle = 'rgba(14, 14, 16, 0.52)';
  ctx.lineWidth = 4;
  for (let i = 0; i < 14; i++) {
    const x = 44 + i * 28;
    ctx.beginPath();
    ctx.moveTo(x, 130 + (i % 3) * 8);
    ctx.lineTo(x + 26, 112 + (i % 3) * 8);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createFenderHashGraphicTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  // Signature Raptor R thin horizontal black vent-trail hash bars behind front wheel arch
  for (let i = 0; i < 20; i++) {
    const y = 24 + i * 10.5;
    const len = Math.max(24, w * (0.94 - (i / 20) * 0.72));
    const alpha = Math.max(0.28, 0.84 - (i / 20) * 0.42);
    ctx.fillStyle = `rgba(14, 14, 16, ${alpha.toFixed(2)})`;
    ctx.fillRect(0, y, len, 4.5);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createLicensePlateTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 112;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#e4e6ea';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#1c1f24';
  ctx.lineWidth = 6;
  ctx.strokeRect(5, 5, w - 10, h - 10);

  ctx.fillStyle = '#8e1810';
  ctx.fillRect(9, 9, w - 18, 22);
  ctx.fillStyle = '#f8f2ec';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('FORD PERFORMANCE · V8', w / 2, 20);

  ctx.fillStyle = '#15171b';
  ctx.font = 'bold 36px monospace';
  ctx.fillText('RPT 700R', w / 2, 68);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createRearGlassTexture(cracked = false): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#161f28');
  grad.addColorStop(0.55, '#0e141b');
  grad.addColorStop(1, '#0b1015');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);

  // Subtle rear defroster filaments + power sliding center glass seam
  ctx.strokeStyle = 'rgba(130, 145, 160, 0.22)';
  ctx.lineWidth = 1.3;
  for (let i = 0; i < 11; i++) {
    const y = 34 + i * 18;
    ctx.beginPath();
    ctx.moveTo(28, y);
    ctx.lineTo(484, y);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(12, 14, 18, 0.65)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(182, 10);
  ctx.lineTo(182, 246);
  ctx.moveTo(330, 10);
  ctx.lineTo(330, 246);
  ctx.stroke();

  if (cracked) {
    ctx.strokeStyle = 'rgba(230, 240, 250, 0.82)';
    ctx.lineWidth = 1.6;
    const cx = 310;
    const cy = 112;
    for (let r = 0; r < 18; r++) {
      const a = (r / 18) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + Math.cos(a) * (95 + hash2(r, 9) * 80),
        cy + Math.sin(a) * (70 + hash2(r, 3) * 55),
      );
      ctx.stroke();
    }
    for (let k = 1; k <= 4; k++) {
      ctx.beginPath();
      ctx.arc(cx, cy, k * 24, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createBedDeckTexture(): { albedo: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const w = 512;
  const h = 512;
  const cA = document.createElement('canvas');
  cA.width = w;
  cA.height = h;
  const ctxA = cA.getContext('2d')!;
  const cB = document.createElement('canvas');
  cB.width = w;
  cB.height = h;
  const ctxB = cB.getContext('2d')!;

  // Matte-black ToughBed spray-in bedliner
  ctxA.fillStyle = '#191a1d';
  ctxA.fillRect(0, 0, w, h);
  ctxB.fillStyle = '#404040';
  ctxB.fillRect(0, 0, w, h);

  const ribCount = 16;
  const ribW = w / ribCount;
  for (let i = 0; i < ribCount; i++) {
    const x = i * ribW;
    ctxA.fillStyle = '#222428';
    ctxA.fillRect(x + ribW * 0.18, 0, ribW * 0.64, h);
    ctxB.fillStyle = '#c4c4c4';
    ctxB.fillRect(x + ribW * 0.18, 0, ribW * 0.64, h);
  }

  for (let i = 0; i < 600; i++) {
    const x = hash2(i, 3.1) * w;
    const y = hash2(i, 8.4) * h;
    ctxA.fillStyle = i % 2 === 0 ? 'rgba(48, 50, 56, 0.18)' : 'rgba(8, 9, 10, 0.24)';
    ctxA.fillRect(x, y, 2.5, 2.5);
  }

  const albedo = new THREE.CanvasTexture(cA);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = THREE.RepeatWrapping;
  albedo.wrapT = THREE.RepeatWrapping;
  albedo.anisotropy = 8;

  const bump = new THREE.CanvasTexture(cB);
  bump.wrapS = THREE.RepeatWrapping;
  bump.wrapT = THREE.RepeatWrapping;
  bump.anisotropy = 4;

  return { albedo, bump };
}

/**
 * BFGoodrich All-Terrain T/A KO2 tire texture with crisp raised WHITE sidewall lettering
 * matching Reference Image 3!
 */
function createRaptorTireTextures(): {
  albedo: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
} {
  const w = 1024;
  const h = 512;
  const cA = document.createElement('canvas');
  cA.width = w;
  cA.height = h;
  const ctxA = cA.getContext('2d')!;
  const cB = document.createElement('canvas');
  cB.width = w;
  cB.height = h;
  const ctxB = cB.getContext('2d')!;

  // Rich dark wet charcoal-black tire rubber
  ctxA.fillStyle = '#17181a';
  ctxA.fillRect(0, 0, w, h);
  ctxB.fillStyle = '#606060';
  ctxB.fillRect(0, 0, w, h);

  // Sidewall molding bead rings
  for (const ry of [h * 0.08, h * 0.125, h * 0.875, h * 0.92]) {
    ctxA.fillStyle = '#101113';
    ctxA.fillRect(0, ry, w, 4);
    ctxB.fillStyle = '#c8c8c8';
    ctxB.fillRect(0, ry, w, 4);
  }

  // Aggressive KO2 interlocking tread blocks & serrated shoulder armor
  for (let i = 0; i < 48; i++) {
    const x = (i / 48) * w;
    ctxA.fillStyle = '#1f2124';
    ctxA.fillRect(x + 6, h * 0.27, 13, h * 0.46);
    ctxB.fillStyle = '#e6e6e6';
    ctxB.fillRect(x + 6, h * 0.28, 13, h * 0.44);
    ctxB.fillStyle = '#1c1c1c';
    ctxB.fillRect(x, h * 0.27, 6, h * 0.46);

    ctxA.fillStyle = '#1c1e21';
    ctxA.fillRect(x + 3, h * 0.195, 12, h * 0.075);
    ctxA.fillRect(x + 3, h * 0.73, 12, h * 0.075);
    ctxB.fillStyle = '#dedede';
    ctxB.fillRect(x + 3, h * 0.195, 12, h * 0.075);
    ctxB.fillRect(x + 3, h * 0.73, 12, h * 0.075);
  }

  // Crisp bright raised WHITE sidewall lettering (iconic look in Reference Image 3!)
  ctxA.font = '900 25px sans-serif';
  ctxA.textAlign = 'center';
  ctxA.textBaseline = 'middle';
  ctxA.fillStyle = 'rgba(240, 243, 246, 0.92)';
  ctxB.font = '900 25px sans-serif';
  ctxB.textAlign = 'center';
  ctxB.textBaseline = 'middle';
  ctxB.fillStyle = '#f2f2f2';

  const sidewallLabels = [
    { x: w * 0.25, text: 'BFGoodrich   ALL-TERRAIN T/A' },
    { x: w * 0.75, text: '37×12.5R17   BAJA CHAMPION' },
  ];
  for (const lbl of sidewallLabels) {
    ctxA.fillText(lbl.text, lbl.x, h * 0.155);
    ctxB.fillText(lbl.text, lbl.x, h * 0.155);
    ctxA.save();
    ctxA.translate(lbl.x, h * 0.845);
    ctxA.scale(1, -1);
    ctxA.fillText(lbl.text, 0, 0);
    ctxA.restore();
    ctxB.save();
    ctxB.translate(lbl.x, h * 0.845);
    ctxB.scale(1, -1);
    ctxB.fillText(lbl.text, 0, 0);
    ctxB.restore();
  }

  const albedo = new THREE.CanvasTexture(cA);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = THREE.RepeatWrapping;
  albedo.wrapT = THREE.ClampToEdgeWrapping;
  albedo.anisotropy = 8;

  const bump = new THREE.CanvasTexture(cB);
  bump.wrapS = THREE.RepeatWrapping;
  bump.wrapT = THREE.ClampToEdgeWrapping;
  bump.anisotropy = 4;

  return { albedo, bump };
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 512);

  const grad = ctx.createRadialGradient(128, 256, 22, 128, 256, 122);
  grad.addColorStop(0.0, 'rgba(6, 7, 9, 0.78)');
  grad.addColorStop(0.55, 'rgba(10, 11, 14, 0.46)');
  grad.addColorStop(0.84, 'rgba(14, 15, 18, 0.16)');
  grad.addColorStop(1.0, 'rgba(14, 15, 18, 0.0)');

  ctx.save();
  ctx.translate(128, 256);
  ctx.scale(1.0, 1.95);
  ctx.translate(-128, -256);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 512);
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createStrutBetween(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  mat: THREE.Material,
  radialSegments = 10,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(radius, radius, len, radialSegments);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Builds the iconic Ford F-150 Raptor R 6-twin-spoke machined-face / dark-pocket beadlock wheel
 * wrapped in chunky 37" BFGoodrich All-Terrain KO2 rubber (matches Reference Image 3!).
 */
function buildRaptorBeadlockWheel(
  tireRadius: number,
  tireWidth: number,
  isLeft: boolean,
  materials: {
    tireRubber: THREE.MeshStandardMaterial;
    tireLug: THREE.MeshStandardMaterial;
    rimPocket: THREE.MeshStandardMaterial;
    rimMachined: THREE.MeshStandardMaterial;
    steelDark: THREE.MeshStandardMaterial;
    chrome: THREE.MeshStandardMaterial;
    brakeDisc: THREE.MeshStandardMaterial;
    caliper: THREE.MeshStandardMaterial;
  },
  trackGeo: (g: THREE.BufferGeometry) => void,
  sharedTemplates?: SharedRaptorWheelTemplates,
): { spinGroup: THREE.Group; hubAssembly: THREE.Group } {
  const tpl = sharedTemplates
    ? isLeft
      ? sharedTemplates.left
      : sharedTemplates.right
    : buildSingleSideWheelTemplate(tireRadius, tireWidth, isLeft ? 1 : -1, trackGeo);

  const spinGroup = new THREE.Group();
  const hubAssembly = new THREE.Group();

  const carcassMesh = new THREE.Mesh(tpl.carcass, materials.tireRubber);
  carcassMesh.castShadow = true;
  carcassMesh.receiveShadow = true;
  spinGroup.add(carcassMesh);

  const lugsMesh = new THREE.Mesh(tpl.lugs, materials.tireLug);
  lugsMesh.castShadow = true;
  lugsMesh.receiveShadow = true;
  spinGroup.add(lugsMesh);

  spinGroup.add(new THREE.Mesh(tpl.rimPocket, materials.rimPocket));

  const machinedMesh = new THREE.Mesh(tpl.rimMachined, materials.rimMachined);
  machinedMesh.castShadow = true;
  spinGroup.add(machinedMesh);

  spinGroup.add(new THREE.Mesh(tpl.steelDark, materials.steelDark));
  spinGroup.add(new THREE.Mesh(tpl.chrome, materials.chrome));
  spinGroup.add(new THREE.Mesh(tpl.rotor, materials.brakeDisc));

  hubAssembly.add(new THREE.Mesh(tpl.caliper, materials.caliper));

  return { spinGroup, hubAssembly };
}

interface WheelSideGeometries {
  carcass: THREE.BufferGeometry;
  lugs: THREE.BufferGeometry;
  rimPocket: THREE.BufferGeometry;
  rimMachined: THREE.BufferGeometry;
  steelDark: THREE.BufferGeometry;
  chrome: THREE.BufferGeometry;
  rotor: THREE.BufferGeometry;
  caliper: THREE.BufferGeometry;
}

interface SharedRaptorWheelTemplates {
  left: WheelSideGeometries;
  right: WheelSideGeometries;
}

function normalizeGeometryForMerge(
  src: THREE.BufferGeometry,
  matrix?: THREE.Matrix4,
  keepUv = true,
  keepColor = false,
  keepScrape = false,
): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  if (matrix) g.applyMatrix4(matrix);
  if (!g.attributes.normal) g.computeVertexNormals();
  const count = g.attributes.position.count;
  if (keepUv) {
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
  } else if (g.attributes.uv) {
    g.deleteAttribute('uv');
  }
  if (!keepColor && g.attributes.color) g.deleteAttribute('color');
  if (!keepScrape && g.attributes.aScrape) g.deleteAttribute('aScrape');
  // Delete any non-standard attributes so mergeGeometries never fails on mismatch
  for (const attrName of Object.keys(g.attributes)) {
    if (
      attrName !== 'position' &&
      attrName !== 'normal' &&
      (!keepUv || attrName !== 'uv') &&
      (!keepColor || attrName !== 'color') &&
      (!keepScrape || attrName !== 'aScrape')
    ) {
      g.deleteAttribute(attrName);
    }
  }
  return g;
}

function mergeBakedGeos(
  geos: THREE.BufferGeometry[],
  trackGeo: (g: THREE.BufferGeometry) => void,
): THREE.BufferGeometry {
  const merged = mergeGeometries(geos, false);
  for (let i = 0; i < geos.length; i++) geos[i].dispose();
  if (!merged) {
    throw new Error('mergeBakedGeos failed to merge compatible wheel geometries');
  }
  trackGeo(merged);
  return merged;
}

function buildSingleSideWheelTemplate(
  tireRadius: number,
  tireWidth: number,
  outSign: 1 | -1,
  trackGeo: (g: THREE.BufferGeometry) => void,
): WheelSideGeometries {
  const rimRadius = tireRadius * 0.56;
  const hw = tireWidth * 0.5;
  const dummy = new THREE.Object3D();

  // 1. Sculpted tire carcass
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(rimRadius * 0.96, -hw * 0.8),
    new THREE.Vector2(rimRadius * 1.08, -hw * 0.94),
    new THREE.Vector2(tireRadius * 0.79, -hw * 1.02),
    new THREE.Vector2(tireRadius * 0.92, -hw * 0.97),
    new THREE.Vector2(tireRadius * 0.978, -hw * 0.8),
    new THREE.Vector2(tireRadius * 0.988, -hw * 0.42),
    new THREE.Vector2(tireRadius * 0.992, 0),
    new THREE.Vector2(tireRadius * 0.988, hw * 0.42),
    new THREE.Vector2(tireRadius * 0.978, hw * 0.8),
    new THREE.Vector2(tireRadius * 0.92, hw * 0.97),
    new THREE.Vector2(tireRadius * 0.79, hw * 1.02),
    new THREE.Vector2(rimRadius * 1.08, hw * 0.94),
    new THREE.Vector2(rimRadius * 0.96, hw * 0.8),
  ];
  const carcass = new THREE.LatheGeometry(profile, 32);
  carcass.rotateZ(Math.PI / 2);
  trackGeo(carcass);

  // 2. Merged KO2 shoulder & tread lug blocks (78 blocks -> 1 shared BufferGeometry)
  const lugCount = 26;
  const shoulderGeo = new THREE.BoxGeometry(tireWidth * 0.34, 0.026, 0.058);
  const lugGeos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < lugCount; i++) {
    const aL = (i / lugCount) * Math.PI * 2;
    const aR = ((i + 0.5) / lugCount) * Math.PI * 2;
    const aC = ((i + 0.25) / lugCount) * Math.PI * 2;
    const rOuter = tireRadius * 0.986;

    dummy.position.set(tireWidth * 0.32, Math.cos(aL) * rOuter, Math.sin(aL) * rOuter);
    dummy.rotation.set(aL, 0.24, -0.09);
    dummy.scale.set(1.0, 1.0, 1.0);
    dummy.updateMatrix();
    lugGeos.push(normalizeGeometryForMerge(shoulderGeo, dummy.matrix, true));

    dummy.position.set(-tireWidth * 0.32, Math.cos(aR) * rOuter, Math.sin(aR) * rOuter);
    dummy.rotation.set(aR, -0.24, 0.09);
    dummy.scale.set(1.0, 1.0, 1.0);
    dummy.updateMatrix();
    lugGeos.push(normalizeGeometryForMerge(shoulderGeo, dummy.matrix, true));

    dummy.position.set(0, Math.cos(aC) * (rOuter + 0.002), Math.sin(aC) * (rOuter + 0.002));
    dummy.rotation.set(aC, i % 2 === 0 ? 0.34 : -0.34, 0);
    dummy.scale.set(0.86, 0.92, 0.94);
    dummy.updateMatrix();
    lugGeos.push(normalizeGeometryForMerge(shoulderGeo, dummy.matrix, true));
  }
  shoulderGeo.dispose();
  const lugs = mergeBakedGeos(lugGeos, trackGeo);

  // 3. Dark anthracite rim pocket group (barrel + back disc + 6 twin-pocket arms -> 1 draw call)
  const pocketGeos: THREE.BufferGeometry[] = [];
  const barrelGeo = new THREE.CylinderGeometry(
    rimRadius * 0.97,
    rimRadius * 0.97,
    tireWidth * 0.76,
    24,
    1,
    true,
  );
  barrelGeo.rotateZ(Math.PI / 2);
  pocketGeos.push(normalizeGeometryForMerge(barrelGeo, undefined, true));
  barrelGeo.dispose();

  const backDiscGeo = new THREE.CylinderGeometry(rimRadius * 0.88, rimRadius * 0.88, 0.028, 24);
  backDiscGeo.rotateZ(Math.PI / 2);
  backDiscGeo.translate(outSign * hw * 0.44, 0, 0);
  pocketGeos.push(normalizeGeometryForMerge(backDiscGeo, undefined, true));
  backDiscGeo.dispose();

  const spokePocketGeo = new THREE.BoxGeometry(0.042, rimRadius * 0.62, 0.064);
  const pivotObj = new THREE.Object3D();
  const childObj = new THREE.Object3D();
  pivotObj.add(childObj);
  for (let s = 0; s < 6; s++) {
    const baseAng = (s / 6) * Math.PI * 2;
    pivotObj.position.set(0, 0, 0);
    pivotObj.rotation.set(baseAng, 0, 0);
    childObj.position.set(outSign * hw * 0.56, rimRadius * 0.5, 0);
    childObj.rotation.set(0, 0, 0);
    pivotObj.updateMatrixWorld(true);
    pocketGeos.push(normalizeGeometryForMerge(spokePocketGeo, childObj.matrixWorld, true));
  }
  spokePocketGeo.dispose();
  const rimPocket = mergeBakedGeos(pocketGeos, trackGeo);

  // 4. Machined-silver beadlock lip + 12 Y-spoke legs + center cap ring -> 1 draw call
  const machinedGeos: THREE.BufferGeometry[] = [];
  const lipGeo = new THREE.TorusGeometry(rimRadius * 0.94, 0.025, 10, 28);
  lipGeo.rotateY(Math.PI / 2);
  lipGeo.translate(outSign * hw * 0.74, 0, 0);
  machinedGeos.push(normalizeGeometryForMerge(lipGeo, undefined, true));
  lipGeo.dispose();

  const spokeLegGeo = new THREE.BoxGeometry(0.036, rimRadius * 0.62, 0.038);
  for (let s = 0; s < 6; s++) {
    const baseAng = (s / 6) * Math.PI * 2;
    for (const spread of [-1, 1]) {
      pivotObj.rotation.set(baseAng + spread * 0.14, 0, 0);
      childObj.position.set(outSign * hw * 0.64, rimRadius * 0.54, spread * 0.018);
      childObj.rotation.set(spread * 0.16, 0, -outSign * 0.12);
      pivotObj.updateMatrixWorld(true);
      machinedGeos.push(normalizeGeometryForMerge(spokeLegGeo, childObj.matrixWorld, true));
    }
  }
  spokeLegGeo.dispose();

  const capRingGeo = new THREE.TorusGeometry(rimRadius * 0.25, 0.009, 8, 18);
  capRingGeo.rotateY(Math.PI / 2);
  capRingGeo.translate(outSign * (hw * 0.62 + 0.055), 0, 0);
  machinedGeos.push(normalizeGeometryForMerge(capRingGeo, undefined, true));
  capRingGeo.dispose();
  const rimMachined = mergeBakedGeos(machinedGeos, trackGeo);

  // 5. Dark steel center hub cap + 18 perimeter beadlock bolts -> 1 draw call
  const steelGeos: THREE.BufferGeometry[] = [];
  const hubGeo = new THREE.CylinderGeometry(rimRadius * 0.27, rimRadius * 0.32, 0.11, 16);
  hubGeo.rotateZ(Math.PI / 2);
  hubGeo.translate(outSign * hw * 0.62, 0, 0);
  steelGeos.push(normalizeGeometryForMerge(hubGeo, undefined, true));
  hubGeo.dispose();

  const beadBoltGeo = new THREE.CylinderGeometry(0.0075, 0.0075, 0.018, 6);
  beadBoltGeo.rotateZ(Math.PI / 2);
  const boltCount = 18;
  for (let b = 0; b < boltCount; b++) {
    const ba = (b / boltCount) * Math.PI * 2;
    dummy.position.set(
      outSign * (hw * 0.74 + 0.02),
      Math.cos(ba) * rimRadius * 0.94,
      Math.sin(ba) * rimRadius * 0.94,
    );
    dummy.rotation.set(ba, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    steelGeos.push(normalizeGeometryForMerge(beadBoltGeo, dummy.matrix, true));
  }
  beadBoltGeo.dispose();
  const steelDark = mergeBakedGeos(steelGeos, trackGeo);

  // 6. 6 Chrome lug nuts -> 1 draw call
  const chromeGeos: THREE.BufferGeometry[] = [];
  const lugNutGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.04, 6);
  lugNutGeo.rotateZ(Math.PI / 2);
  for (let l = 0; l < 6; l++) {
    const ang = ((l + 0.5) / 6) * Math.PI * 2;
    dummy.position.set(
      outSign * hw * 0.64,
      Math.cos(ang) * rimRadius * 0.35,
      Math.sin(ang) * rimRadius * 0.35,
    );
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    chromeGeos.push(normalizeGeometryForMerge(lugNutGeo, dummy.matrix, true));
  }
  lugNutGeo.dispose();
  const chrome = mergeBakedGeos(chromeGeos, trackGeo);

  // 7. Vented rotor & brake caliper
  const rotor = new THREE.CylinderGeometry(rimRadius * 0.72, rimRadius * 0.72, 0.026, 22);
  rotor.rotateZ(Math.PI / 2);
  rotor.translate(-outSign * hw * 0.18, 0, 0);
  trackGeo(rotor);

  const caliper = new THREE.BoxGeometry(0.075, 0.145, 0.095);
  caliper.translate(-outSign * hw * 0.22, 0.05, -rimRadius * 0.5);
  trackGeo(caliper);

  return { carcass, lugs, rimPocket, rimMachined, steelDark, chrome, rotor, caliper };
}

/**
 * Safely merges static direct-child THREE.Mesh objects inside a group by (material, shadow flags,
 * renderOrder, vertex-color presence), skipping deformable/animated/mirror meshes.
 */
function mergeStaticMeshesInGroup(
  group: THREE.Group,
  excludedMeshes: ReadonlySet<THREE.Object3D>,
  trackGeo: (g: THREE.BufferGeometry) => void,
): void {
  const buckets = new Map<string, THREE.Mesh[]>();
  const children = group.children;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (
      !(c instanceof THREE.Mesh) ||
      c instanceof THREE.InstancedMesh ||
      excludedMeshes.has(c) ||
      Array.isArray(c.material) ||
      c.children.length > 0
    ) {
      continue;
    }
    const mat = c.material;
    const hasColor = Boolean(c.geometry.attributes.color);
    const hasScrape = Boolean(c.geometry.attributes.aScrape);
    const key = `${mat.uuid}|${c.castShadow ? 1 : 0}|${c.receiveShadow ? 1 : 0}|${c.renderOrder}|${hasColor ? 1 : 0}|${hasScrape ? 1 : 0}`;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(c);
  }

  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const first = list[0];
    const keepColor = Boolean(first.geometry.attributes.color);
    const keepScrape = Boolean(first.geometry.attributes.aScrape);
    const baked: THREE.BufferGeometry[] = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      m.updateMatrix();
      baked.push(normalizeGeometryForMerge(m.geometry, m.matrix, true, keepColor, keepScrape));
    }
    const merged = mergeGeometries(baked, false);
    for (let i = 0; i < baked.length; i++) baked[i].dispose();
    if (!merged) continue;
    trackGeo(merged);

    const mergedMesh = new THREE.Mesh(merged, first.material);
    mergedMesh.castShadow = first.castShadow;
    mergedMesh.receiveShadow = first.receiveShadow;
    mergedMesh.renderOrder = first.renderOrder;
    for (let i = 0; i < list.length; i++) {
      group.remove(list[i]);
    }
    group.add(mergedMesh);
  }
}

/**
 * Sculpted Ford F-150 Raptor R muscular hood geometry with raised center power-dome
 * (hinge at z=1.24, y=1.38 so hood pops open & detaches cleanly in front collisions).
 */
function createRaptorHoodGeometry(): THREE.BufferGeometry {
  const segX = 16;
  const segZ = 14;
  const width = 1.66;
  const length = 1.18; // extends forward z = 0 .. +1.18 from cowl hinge at z=1.24 -> nose at z=2.42
  const geo = new THREE.BoxGeometry(width, 0.068, length, segX, 2, segZ);
  geo.translate(0, 0, length * 0.5);

  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    const nx = x / (width * 0.5); // -1 .. 1
    const nz = Math.max(0, Math.min(1, z / length));

    const widthTaper = 1.0 - nz * 0.045;
    const sx = x * widthTaper;

    // Flat muscular F-150 hood profile with crisp front nose downturn + raised central V8 power-dome
    const noseDrop = -Math.pow(nz, 2.3) * 0.088;
    const edgeDrop = -(nx * nx) * 0.036;
    const powerDome =
      Math.abs(nx) < 0.54
        ? Math.cos((nx / 0.54) * Math.PI * 0.5) *
          (0.056 * Math.sin(Math.min(1, nz * 1.12) * Math.PI * 0.88))
        : 0;

    pos.setXYZ(i, sx, y + noseDrop + edgeDrop + powerDome, z);
    uv.setXY(i, (nx * 0.5 + 0.5) * 0.9, 0.72 + (1 - nz) * 0.22);
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Adds bold 3D geometric "F O R D" block lettering to a parent group facing +Z (front grille)
 * or -Z (rear tailgate applique).
 */
function addFordBlockLetters(
  parent: THREE.Object3D,
  mat: THREE.Material,
  zPos: number,
  yCenter: number,
  letterH: number,
  totalWidth: number,
  depth: number,
  facingRear: boolean,
  trackGeo: <T extends THREE.BufferGeometry>(g: T) => T,
): void {
  const dir = facingRear ? -1 : 1; // Reading L->R from viewer's perspective: front faces +Z (viewer looks toward -Z, so left is +X!), rear faces -Z (viewer looks toward +Z, so left is -X!)
  // Wait: from front looking at truck facing +Z, viewer's LEFT is truck's RIGHT (-X), viewer's RIGHT is truck's LEFT (+X)!
  // Let's verify: Camera at (0, 1.2, +5) looking at (0, 1.2, 0): camera right is (-1, 0, 0) = -X? Wait:
  // camForward = (0, 0, -1), camUp = (0, 1, 0), camRight = cross(fwd, up) = (0,0,-1) x (0,1,0) = (+1, 0, 0)!
  // So viewer's LEFT when looking at the front grille is -X, and viewer's RIGHT is +X!
  // Let's double check: at (0, 0, 5) looking at (0, 0, 0), +X is to the RIGHT on screen, -X is to the LEFT on screen!
  // Wait: in Three.js standard camera at (0, 0, +5) looking at (0,0,0), +X IS to the RIGHT!
  // So reading "F O R D" left-to-right from the front means: F at -X, O at -X/3, R at +X/3, D at +X!
  // And from the rear (camera at (0, 0, -5) looking at (0,0,0)), camForward=(0,0,+1), camRight=(-1,0,0), so viewer's LEFT is +X and RIGHT is -X!
  // Therefore: for front (+Z), x goes from -halfW to +halfW (signX = +1). For rear (-Z), x goes from +halfW to -halfW (signX = -1)!
  const signX = facingRear ? -1 : 1;
  const letterW = totalWidth * 0.215;
  const stepX = totalWidth * 0.258;
  const startX = -1.5 * stepX * signX;
  const barT = letterH * 0.24;

  const box = (x: number, y: number, w: number, h: number) => {
    const geo = trackGeo(new THREE.BoxGeometry(w, h, depth));
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, yCenter + y, zPos);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
  };

  // F
  const fx = startX;
  box(fx - signX * (letterW * 0.38), 0, barT, letterH);
  box(fx, letterH * 0.38, letterW, barT);
  box(fx - signX * (letterW * 0.08), 0.01 * letterH, letterW * 0.82, barT * 0.92);

  // O
  const ox = startX + stepX * signX;
  box(ox - signX * (letterW * 0.38), 0, barT, letterH);
  box(ox + signX * (letterW * 0.38), 0, barT, letterH);
  box(ox, letterH * 0.38, letterW, barT);
  box(ox, -letterH * 0.38, letterW, barT);

  // R
  const rx = startX + 2 * stepX * signX;
  box(rx - signX * (letterW * 0.38), 0, barT, letterH);
  box(rx, letterH * 0.38, letterW, barT);
  box(rx, 0.02 * letterH, letterW * 0.94, barT * 0.92);
  box(rx + signX * (letterW * 0.38), letterH * 0.2, barT, letterH * 0.56);
  // Diagonal leg of R
  const legGeo = trackGeo(new THREE.BoxGeometry(barT * 0.95, letterH * 0.52, depth));
  const leg = new THREE.Mesh(legGeo, mat);
  leg.position.set(rx + signX * (letterW * 0.2), yCenter - letterH * 0.24, zPos);
  leg.rotation.z = signX * 0.52;
  leg.castShadow = true;
  parent.add(leg);

  // D
  const dx = startX + 3 * stepX * signX;
  box(dx - signX * (letterW * 0.38), 0, barT, letterH);
  box(dx + signX * (letterW * 0.34), 0, barT, letterH * 0.78);
  box(dx - signX * (letterW * 0.05), letterH * 0.38, letterW * 0.9, barT);
  box(dx - signX * (letterW * 0.05), -letterH * 0.38, letterW * 0.9, barT);

  void dir;
}

export function buildTrophyTruckVisuals(
  root: THREE.Group,
  wheelSpecs: WheelMountSpec[],
  tireRadius: number,
  tireWidth: number,
  reflectionUniforms?: ReflectionSharedUniforms,
): TrophyTruckVisuals {
  const disposableGeos: THREE.BufferGeometry[] = [];
  const disposableMats: THREE.Material[] = [];
  const disposableTex: THREE.Texture[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    disposableGeos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    disposableMats.push(m);
    return m;
  };
  const trackTex = <T extends THREE.Texture>(t: T): T => {
    disposableTex.push(t);
    return t;
  };

  // --- Procedural PBR Textures ---
  const paintTex = createRaptorRedPaintTextures();
  trackTex(paintTex.albedo);
  trackTex(paintTex.roughness);

  const rearGlassTex = createRearGlassTexture(false);
  const rearGlassCrackedTex = createRearGlassTexture(true);
  trackTex(rearGlassTex);
  trackTex(rearGlassCrackedTex);

  const crackedGlassTex1 = createCrackedGlassTexture(false);
  const crackedGlassTex2 = createCrackedGlassTexture(true);
  trackTex(crackedGlassTex1);
  trackTex(crackedGlassTex2);

  const bedTex = createBedDeckTexture();
  trackTex(bedTex.albedo);
  trackTex(bedTex.bump);

  const tireTex = createRaptorTireTextures();
  trackTex(tireTex.albedo);
  trackTex(tireTex.bump);

  const shadowTex = createContactShadowTexture();
  trackTex(shadowTex);

  const grilleTex = createRaptorHoneycombGrilleTexture();
  trackTex(grilleTex);

  const runningBoardTex = createRunningBoardTexture();
  trackTex(runningBoardTex);

  const leftDecalTex = createRaptorSideDecalTexture(true);
  const rightDecalTex = createRaptorSideDecalTexture(false);
  const fenderHashTex = createFenderHashGraphicTexture();
  trackTex(leftDecalTex);
  trackTex(rightDecalTex);
  trackTex(fenderHashTex);

  const plateTex = createLicensePlateTexture();
  trackTex(plateTex);

  const orangePeelNormal = createOrangePeelNormalMap();
  trackTex(orangePeelNormal);

  const windshieldTex = createWindshieldGlassTextures();
  trackTex(windshieldTex.albedo);
  trackTex(windshieldTex.roughness);

  const sharedRtUniforms = createCabinRtLightingUniforms();

  // --- Calibrated Rapid Red / Metallic Crimson Raptor R PBR Materials ---
  const bodyPaintMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: paintTex.albedo,
      roughnessMap: paintTex.roughness,
      roughness: 0.24,
      metalness: 0.5,
      clearcoat: 1.0,
      clearcoatRoughness: 0.042,
      clearcoatNormalMap: orangePeelNormal,
      clearcoatNormalScale: new THREE.Vector2(0.032, 0.032),
      ior: 1.52,
      reflectivity: 0.94,
      envMapIntensity: 1.24,
      vertexColors: true,
    }),
  );
  enhanceAutomotivePaintMaterial(bodyPaintMat, reflectionUniforms, 'raptor_body', sharedRtUniforms);

  const pillarPaintMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x8d150f,
      roughness: 0.22,
      metalness: 0.48,
      clearcoat: 0.98,
      clearcoatRoughness: 0.048,
      clearcoatNormalMap: orangePeelNormal,
      clearcoatNormalScale: new THREE.Vector2(0.028, 0.028),
      ior: 1.52,
      reflectivity: 0.92,
      envMapIntensity: 1.18,
      vertexColors: true,
    }),
  );
  enhanceAutomotivePaintMaterial(pillarPaintMat, reflectionUniforms, 'raptor_pillar', sharedRtUniforms);

  const glossBlackTrimMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x101216,
      roughness: 0.14,
      metalness: 0.18,
      clearcoat: 0.9,
      clearcoatRoughness: 0.06,
      envMapIntensity: 1.1,
    }),
  );

  const matteFlareMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1e2024,
      roughness: 0.78,
      metalness: 0.12,
      envMapIntensity: 0.55,
    }),
  );

  const bumperGunmetalMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x2c3037,
      roughness: 0.46,
      metalness: 0.58,
      envMapIntensity: 0.85,
      vertexColors: true,
    }),
  );

  const fordLetterMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x22252b,
      roughness: 0.52,
      metalness: 0.32,
      envMapIntensity: 0.72,
    }),
  );

  const grilleMeshMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: grilleTex,
      roughness: 0.62,
      metalness: 0.28,
      envMapIntensity: 0.42,
    }),
  );

  const runningBoardMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: runningBoardTex,
      roughness: 0.62,
      metalness: 0.52,
      envMapIntensity: 0.62,
    }),
  );

  const licensePlateMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: plateTex,
      roughness: 0.42,
      metalness: 0.22,
      envMapIntensity: 0.45,
    }),
  );

  // Iconic Raptor C-clamp DRLs (bright warm-white / pale amber glow!)
  const ledDrlMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xfff8e6,
      emissive: 0xffefbe,
      emissiveIntensity: 2.3,
      roughness: 0.12,
      metalness: 0.05,
    }),
  );

  // Iconic 3 Amber Raptor Grille Clearance Lights + Fender Markers
  const amberMarkerMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff8b14,
      emissive: 0xff7808,
      emissiveIntensity: 2.1,
      roughness: 0.16,
      metalness: 0.05,
    }),
  );

  // Dedicated Turn-Signal / Hazard Flasher Amber LED Material (front C-clamp bars, mirrors, bumper corners!)
  const hazardLampMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff9414,
      emissive: 0xff7000,
      emissiveIntensity: 0.85,
      roughness: 0.15,
      metalness: 0.05,
    }),
  );

  // Roof Off-Road LED Lightbar Lens Material (controlled from SYNC 4 Luzes tab / overhead switch!)
  const lightbarLedMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xdbeafe,
      emissive: 0xe6f2ff,
      emissiveIntensity: 0.0,
      roughness: 0.12,
      metalness: 0.1,
    }),
  );

  const raptorRBadgeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xe62e14,
      emissive: 0xc21e0a,
      emissiveIntensity: 0.45,
      roughness: 0.26,
      metalness: 0.25,
    }),
  );

  // Vivid Code-Orange / Red Raptor R Front Tow Hooks
  const towHookRedMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xe03214,
      roughness: 0.34,
      metalness: 0.38,
      envMapIntensity: 0.72,
    }),
  );

  const heavySteelMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1a1c20,
      roughness: 0.66,
      metalness: 0.44,
      vertexColors: true,
    }),
  );
  const underbodyIronMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x222428,
      roughness: 0.84,
      metalness: 0.32,
    }),
  );
  const bedDeckMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: bedTex.albedo,
      bumpMap: bedTex.bump,
      bumpScale: 0.014,
      roughness: 0.86,
      metalness: 0.18,
    }),
  );
  const rubberTrimMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x151618,
      roughness: 0.88,
      metalness: 0.04,
    }),
  );
  const brushedAlumMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xa2a9b2,
      roughness: 0.32,
      metalness: 0.82,
      envMapIntensity: 1.05,
    }),
  );
  const chromeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd6dce4,
      roughness: 0.09,
      metalness: 0.96,
      envMapIntensity: 1.38,
    }),
  );
  const foxBlueShockMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1b66c2,
      roughness: 0.34,
      metalness: 0.65,
    }),
  );

  // Clear lightly-tinted front windshield & front door glass (reveals dark interior cleanly like Image 3!)
  const intactGlassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: windshieldTex.albedo,
      roughnessMap: windshieldTex.roughness,
      roughness: 0.06,
      metalness: 0.04,
      ior: 1.52,
      reflectivity: 0.95,
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      envMapIntensity: 1.48,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    }),
  );
  const crackedGlassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: crackedGlassTex1,
      roughness: 0.24,
      metalness: 0.06,
      ior: 1.52,
      clearcoat: 0.65,
      clearcoatRoughness: 0.14,
      envMapIntensity: 1.05,
      transparent: true,
      opacity: 0.84,
      side: THREE.DoubleSide,
    }),
  );
  const shatteredGlassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: crackedGlassTex2,
      roughness: 0.38,
      metalness: 0.05,
      ior: 1.52,
      clearcoat: 0.38,
      envMapIntensity: 0.78,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
    }),
  );

  const rearPrivacyGlassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x182026,
      roughness: 0.06,
      metalness: 0.04,
      ior: 1.52,
      reflectivity: 0.92,
      clearcoat: 1.0,
      clearcoatRoughness: 0.025,
      envMapIntensity: 1.38,
      transparent: true,
      opacity: 0.68,
    }),
  );

  const intactRearGlassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: rearGlassTex,
      roughness: 0.05,
      metalness: 0.04,
      ior: 1.52,
      reflectivity: 0.94,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      envMapIntensity: 1.38,
      transparent: true,
      opacity: 0.74,
    }),
  );
  const crackedRearGlassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: rearGlassCrackedTex,
      roughness: 0.3,
      metalness: 0.06,
      ior: 1.52,
      clearcoat: 0.45,
      envMapIntensity: 0.92,
      transparent: true,
      opacity: 0.92,
    }),
  );

  const interiorDarkMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x18191c,
      roughness: 0.86,
      metalness: 0.06,
    }),
  );
  const interiorLeatherMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x222428,
      roughness: 0.74,
      metalness: 0.08,
    }),
  );

  const tireRubberMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tireTex.albedo,
      bumpMap: tireTex.bump,
      bumpScale: 0.02,
      roughness: 0.76,
      metalness: 0.04,
    }),
  );
  const tireLugMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x18191c,
      roughness: 0.8,
      metalness: 0.04,
    }),
  );
  const rimPocketMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x202328,
      roughness: 0.38,
      metalness: 0.76,
      envMapIntensity: 0.7,
    }),
  );
  const rimMachinedMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xc8cfd8,
      roughness: 0.18,
      metalness: 0.92,
      envMapIntensity: 1.15,
    }),
  );
  const brakeDiscMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x868a90,
      roughness: 0.32,
      metalness: 0.82,
      envMapIntensity: 0.55,
    }),
  );
  const caliperMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x2a2d32,
      roughness: 0.42,
      metalness: 0.55,
    }),
  );

  const headlightLensMatLeft = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xf4f8ff,
      emissive: 0xeaf4ff,
      emissiveIntensity: 2.2,
      roughness: 0.1,
      metalness: 0.08,
    }),
  );
  const headlightLensMatRight = trackMat(headlightLensMatLeft.clone());
  const brakeLightMatLeft = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x991610,
      emissive: 0xe61c12,
      emissiveIntensity: 0.95,
      roughness: 0.2,
      metalness: 0.1,
    }),
  );
  const brakeLightMatRight = trackMat(brakeLightMatLeft.clone());
  const reverseLightMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd8dcd8,
      emissive: 0xfff8e6,
      emissiveIntensity: 0.0,
      roughness: 0.22,
      metalness: 0.1,
    }),
  );
  const boostGlowMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1a1816,
      emissive: 0xff6a16,
      emissiveIntensity: 0.0,
      roughness: 0.4,
      metalness: 0.2,
    }),
  );

  const leftBedDecalMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: leftDecalTex,
      transparent: true,
      roughness: 0.72,
      metalness: 0.08,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
  );
  const rightBedDecalMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: rightDecalTex,
      transparent: true,
      roughness: 0.72,
      metalness: 0.08,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
  );
  const fenderHashMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: fenderHashTex,
      transparent: true,
      roughness: 0.75,
      metalness: 0.06,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
  );

  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const deformableMeshes: DeformableMeshRecord[] = [];

  const registerDeformable = (
    id: string,
    mesh: THREE.Mesh,
    zoneHint: DamageZone,
    center: THREE.Vector3,
    extentRadius: number,
    innerCoreClamp?: DeformMeshBounds,
  ) => {
    const geo = mesh.geometry;
    geo.computeVertexNormals();
    const restColors = ensureVertexColorAttribute(geo).slice();
    ensureScrapeAttribute(geo);
    const restPositions = (geo.attributes.position.array as Float32Array).slice();
    const restNormals = (geo.attributes.normal.array as Float32Array).slice();
    deformableMeshes.push({
      id,
      mesh,
      center,
      extentRadius,
      zoneHint,
      restPositions,
      restNormals,
      restColors,
      innerCoreClamp,
    });
  };

  const addPart = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    castShadow = true,
  ): THREE.Mesh => {
    trackGeo(geo);
    if ((mat as THREE.MeshStandardMaterial).vertexColors && !geo.attributes.color) {
      ensureVertexColorAttribute(geo);
    }
    if (mat === bodyPaintMat || mat === pillarPaintMat) {
      ensureScrapeAttribute(geo);
    }
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = castShadow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  const normalizeBodyUVs = (geo: THREE.BufferGeometry, yMin: number, yMax: number) => {
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    if (!pos || !uv) return;
    const invSpan = 1 / Math.max(0.01, yMax - yMin);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const v = Math.max(0, Math.min(1, (y - yMin) * invSpan));
      uv.setXY(i, z * 0.45, v);
    }
    uv.needsUpdate = true;
  };

  // =========================================================================
  // 1. HEAVY F-150 RAPTOR R LADDER FRAME, FOX LIVE-VALVE SUSPENSION & 5.2L V8
  // =========================================================================
  for (const side of [-1, 1]) {
    addPart(bodyGroup, new THREE.BoxGeometry(0.11, 0.14, 4.86), underbodyIronMat, side * 0.45, 0.56, -0.02);
  }
  for (const cz of [-2.3, -1.59, -0.58, 0.52, 1.56, 2.24]) {
    addPart(bodyGroup, new THREE.BoxGeometry(0.98, 0.1, 0.1), underbodyIronMat, 0, 0.55, cz);
  }
  addPart(bodyGroup, new THREE.BoxGeometry(0.76, 0.14, 1.48), underbodyIronMat, 0, 0.52, 0.35);
  addPart(bodyGroup, new THREE.BoxGeometry(0.84, 0.22, 0.72), underbodyIronMat, 0, 0.62, -1.04);

  // Under-hood 5.2L Supercharged Predator V8 Engine Block & Radiator (exposed when hood pops/detaches!)
  addPart(bodyGroup, new THREE.BoxGeometry(0.98, 0.44, 0.08), brushedAlumMat, 0, 0.98, 2.24);
  addPart(bodyGroup, new THREE.BoxGeometry(0.62, 0.38, 0.68), underbodyIronMat, 0, 0.98, 1.72);
  addPart(bodyGroup, new THREE.BoxGeometry(0.38, 0.16, 0.54), heavySteelMat, 0, 1.22, 1.72); // Supercharger housing
  addPart(bodyGroup, new THREE.BoxGeometry(0.32, 0.04, 0.48), brushedAlumMat, 0, 1.31, 1.72); // Supercharger lid
  for (const side of [-1, 1]) {
    addPart(bodyGroup, new THREE.BoxGeometry(0.18, 0.12, 0.6), towHookRedMat, side * 0.28, 1.14, 1.72, 0, 0, side * 0.22); // Red V8 valve covers
  }

  // Rear 5-Link Live Axle + Differential
  const rearAxleGeo = new THREE.CylinderGeometry(0.056, 0.056, 1.76, 14);
  rearAxleGeo.rotateZ(Math.PI / 2);
  addPart(bodyGroup, rearAxleGeo, underbodyIronMat, 0, 0.49, -1.59);
  const diffSphereGeo = new THREE.SphereGeometry(0.165, 16, 12);
  diffSphereGeo.scale(1.0, 0.94, 0.88);
  addPart(bodyGroup, diffSphereGeo, underbodyIronMat, -0.08, 0.49, -1.59);

  const driveShaft = createStrutBetween(
    new THREE.Vector3(-0.06, 0.5, -1.52),
    new THREE.Vector3(0.0, 0.56, -0.15),
    0.042,
    brushedAlumMat,
    10,
  );
  trackGeo(driveShaft.geometry);
  bodyGroup.add(driveShaft);

  for (const side of [-1, 1]) {
    const shock = createStrutBetween(
      new THREE.Vector3(side * 0.62, 0.49, -1.56),
      new THREE.Vector3(side * 0.46, 0.84, -1.36),
      0.034,
      foxBlueShockMat,
      10,
    );
    trackGeo(shock.geometry);
    bodyGroup.add(shock);
  }

  // Front Brushed Aluminum Raptor Skid Plate (prominently visible under bumper like Image 3!)
  addPart(bodyGroup, new THREE.BoxGeometry(0.96, 0.042, 0.86), brushedAlumMat, 0, 0.56, 2.08, -0.44, 0, 0);
  addPart(bodyGroup, new THREE.BoxGeometry(0.84, 0.14, 0.05), brushedAlumMat, 0, 0.62, 2.44, -0.32, 0, 0);

  // =========================================================================
  // 2. SUPERCREW 4-DOOR DEFORMABLE CAB SHELL, CLEAR FRONT GLASS & RUNNING BOARDS
  // =========================================================================
  addPart(bodyGroup, new THREE.BoxGeometry(1.62, 0.16, 1.62), underbodyIronMat, 0, 0.78, 0.44, 0, 0, 0, false);

  const cabCoreClamp: DeformMeshBounds = {
    minX: -0.66,
    maxX: 0.66,
    minY: 0.74,
    maxY: 1.94,
    minZ: -0.34,
    maxZ: 1.24,
  };

  let leftStepGroup: THREE.Group | null = null;
  let rightStepGroup: THREE.Group | null = null;

  for (const side of [-1, 1]) {
    // Sculpted F-150 SuperCrew 4-Door Lower Body Flanks (subdivided for realistic side dents!)
    const sideDoorGeo = new THREE.BoxGeometry(0.15, 0.64, 1.66, 2, 8, 18);
    sideDoorGeo.translate(side * 0.87, 1.04, 0.44);
    normalizeBodyUVs(sideDoorGeo, 0.7, 1.38);
    const doorMesh = addPart(bodyGroup, sideDoorGeo, bodyPaintMat, 0, 0, 0);
    registerDeformable(
      side > 0 ? 'leftDoorPanel' : 'rightDoorPanel',
      doorMesh,
      side > 0 ? 'left' : 'right',
      new THREE.Vector3(side * 0.87, 1.04, 0.44),
      1.38,
      cabCoreClamp,
    );

    // Subtle dark vertical door-gap seam lines (front, middle B-pillar, rear)
    for (const dz of [1.14, 0.24, -0.36]) {
      addPart(bodyGroup, new THREE.BoxGeometry(0.014, 0.62, 0.012), rubberTrimMat, side * 0.946, 1.04, dz, 0, 0, 0, false);
    }

    // Body-Color Raptor Door Handles (Front & Rear Doors — matching Image 3!)
    addPart(bodyGroup, new THREE.BoxGeometry(0.032, 0.036, 0.15), pillarPaintMat, side * 0.954, 1.22, 0.36);
    addPart(bodyGroup, new THREE.BoxGeometry(0.032, 0.036, 0.15), pillarPaintMat, side * 0.954, 1.22, -0.22);
    addPart(bodyGroup, new THREE.BoxGeometry(0.016, 0.044, 0.16), rubberTrimMat, side * 0.945, 1.22, 0.36, 0, 0, 0, false);
    addPart(bodyGroup, new THREE.BoxGeometry(0.016, 0.044, 0.16), rubberTrimMat, side * 0.945, 1.22, -0.22, 0, 0, 0, false);

    // Cast-Aluminum Matte-Black Perforated Raptor Running Boards / Side Steps (detachable on hard side impacts!)
    const stepGroup = new THREE.Group();
    stepGroup.position.set(side * 0.99, 0.58, 0.38);
    bodyGroup.add(stepGroup);
    addPart(stepGroup, new THREE.BoxGeometry(0.22, 0.042, 1.48), runningBoardMat, 0, 0, 0);
    addPart(stepGroup, new THREE.BoxGeometry(0.032, 0.056, 1.48), heavySteelMat, side * 0.11, -0.005, 0);
    // Mounting brackets to chassis frame
    for (const bz of [-0.52, 0.06, 0.54]) {
      addPart(stepGroup, new THREE.BoxGeometry(0.46, 0.036, 0.06), heavySteelMat, -side * 0.25, -0.02, bz);
    }
    if (side > 0) leftStepGroup = stepGroup;
    else rightStepGroup = stepGroup;
  }

  // Full High-Detail 3D Ford F-150 Raptor R Cockpit Interior (Phase 3)
  const cockpit = buildRaptorCockpitInterior(bodyGroup, sharedRtUniforms);
  const steeringWheel = cockpit.steeringWheel;
  const interiorMirrorLensMesh = cockpit.interiorMirrorLensMesh;

  // Rear cab bulkhead + Sculpted Raptor Leather Seats (positioned cleanly behind cockpit eye at z=0.15)
  addPart(bodyGroup, new THREE.BoxGeometry(1.54, 0.44, 0.06), interiorDarkMat, 0, 1.14, -0.32, 0, 0, 0, false);
  for (const sx of [-0.4, 0.4]) {
    addPart(bodyGroup, new THREE.BoxGeometry(0.48, 0.12, 0.46), interiorLeatherMat, sx, 1.02, 0.24, 0, 0, 0, false);
    addPart(bodyGroup, new THREE.BoxGeometry(0.46, 0.54, 0.12), interiorLeatherMat, sx, 1.38, 0.04, -0.14, 0, 0, false);
    addPart(bodyGroup, new THREE.BoxGeometry(0.24, 0.19, 0.10), interiorLeatherMat, sx, 1.74, -0.01, -0.05, 0, 0, false);
    // Rear Crew Cab Bench Headrests
    addPart(bodyGroup, new THREE.BoxGeometry(0.26, 0.16, 0.1), interiorLeatherMat, sx, 1.70, -0.24, 0, 0, 0, false);
  }
  addPart(bodyGroup, new THREE.BoxGeometry(1.48, 0.38, 0.16), interiorLeatherMat, 0, 1.34, -0.22, -0.12, 0, 0, false);

  // Sloped Modern F-150 Pillars & Side Windows
  for (const side of [-1, 1]) {
    const aPillar = createStrutBetween(
      new THREE.Vector3(side * 0.90, 1.35, 1.24),
      new THREE.Vector3(side * 0.77, 1.99, 0.76),
      0.048,
      pillarPaintMat,
      8,
    );
    // Gloss-black modern B-pillar divider between front & rear doors (exact match to Image 3!)
    const bPillar = createStrutBetween(
      new THREE.Vector3(side * 0.91, 1.35, 0.24),
      new THREE.Vector3(side * 0.78, 1.99, 0.24),
      0.056,
      glossBlackTrimMat,
      8,
    );
    const cPillar = addPart(
      bodyGroup,
      new THREE.BoxGeometry(0.085, 0.66, 0.145),
      pillarPaintMat,
      side * 0.84,
      1.67,
      -0.32,
      -0.05,
      0,
      side * 0.195,
    );
    const cantRail = addPart(
      bodyGroup,
      new THREE.BoxGeometry(0.082, 0.068, 1.10),
      pillarPaintMat,
      side * 0.785,
      1.99,
      0.22,
    );
    void cPillar;
    void cantRail;
    trackGeo(aPillar.geometry);
    trackGeo(bPillar.geometry);
    bodyGroup.add(aPillar, bPillar);

    // Matte-black window weatherstrip beltline trim
    addPart(bodyGroup, new THREE.BoxGeometry(0.045, 0.03, 1.56), rubberTrimMat, side * 0.915, 1.36, 0.44);

    // Side window panes (front door = clear lightly-tinted glass; rear door = factory privacy glass!)
    const tumbleRad = side * 0.195;
    addPart(
      bodyGroup,
      new THREE.BoxGeometry(0.016, 0.58, 0.80),
      intactGlassMat,
      side * 0.84,
      1.66,
      0.66,
      0,
      0,
      tumbleRad,
      false,
    );
    addPart(
      bodyGroup,
      new THREE.BoxGeometry(0.016, 0.58, 0.54),
      rearPrivacyGlassMat,
      side * 0.84,
      1.66,
      -0.05,
      0,
      0,
      tumbleRad,
      false,
    );
  }

  // Front Sloped Windshield (dynamic intact/cracked/shattered material swap)
  const windshieldMesh = addPart(
    bodyGroup,
    new THREE.BoxGeometry(1.56, 0.78, 0.022),
    intactGlassMat,
    0,
    1.68,
    1.0,
    -0.62,
    0,
    0,
    false,
  );
  // Upper windshield crimson header & matte-black cowl apron (articulated wipers built in RaptorCockpitBuilder)
  addPart(bodyGroup, new THREE.BoxGeometry(1.56, 0.065, 0.095), pillarPaintMat, 0, 1.99, 0.76);
  addPart(bodyGroup, new THREE.BoxGeometry(1.66, 0.048, 0.14), rubberTrimMat, 0, 1.37, 1.24);

  // Rear Cab Backplate & Sliding Defroster Window
  addPart(bodyGroup, new THREE.BoxGeometry(1.68, 0.14, 0.08), pillarPaintMat, 0, 1.4, -0.36);
  addPart(bodyGroup, new THREE.BoxGeometry(1.56, 0.1, 0.08), pillarPaintMat, 0, 1.96, -0.32);
  addPart(bodyGroup, new THREE.BoxGeometry(0.2, 0.62, 0.08), pillarPaintMat, 0.74, 1.67, -0.34, 0, 0, 0.17);
  addPart(bodyGroup, new THREE.BoxGeometry(0.2, 0.62, 0.08), pillarPaintMat, -0.74, 1.67, -0.34, 0, 0, -0.17);
  addPart(bodyGroup, new THREE.BoxGeometry(1.32, 0.54, 0.04), rubberTrimMat, 0, 1.68, -0.34);
  // High-mount LED 3rd brake light / cargo lamp on rear cab header
  addPart(bodyGroup, new THREE.BoxGeometry(0.32, 0.04, 0.036), brakeLightMatLeft, 0, 1.98, -0.355, 0, 0, 0, false);
  const rearGlassMesh = addPart(
    bodyGroup,
    new THREE.BoxGeometry(1.24, 0.46, 0.02),
    intactRearGlassMat,
    0,
    1.68,
    -0.354,
    0,
    0,
    0,
    false,
  );

  // Deformable Smooth Crowned Metallic Crimson Roof (NO safari rack!)
  const roofSubGeo = new THREE.BoxGeometry(1.58, 0.068, 1.12, 16, 2, 14);
  const roofPos = roofSubGeo.attributes.position;
  for (let i = 0; i < roofPos.count; i++) {
    const rx = roofPos.getX(i) / 0.79;
    const crown = (1 - rx * rx) * 0.048;
    roofPos.setY(i, roofPos.getY(i) + crown);
  }
  roofPos.needsUpdate = true;
  roofSubGeo.translate(0, 2.02, 0.22);
  const roofMesh = addPart(bodyGroup, roofSubGeo, pillarPaintMat, 0, 0, 0);
  registerDeformable(
    'cabRoof',
    roofMesh,
    'roof',
    new THREE.Vector3(0, 2.04, 0.22),
    1.35,
    { minX: -0.7, maxX: 0.7, minY: 1.86, maxY: 2.3, minZ: -0.32, maxZ: 0.8 },
  );

  // Low-profile Roof Off-Road LED Lightbar + Satellite Pods (toggleable from SYNC 4 Luzes!)
  const lightBarGroup = new THREE.Group();
  lightBarGroup.position.set(0, 2.045, 0.72);
  bodyGroup.add(lightBarGroup);
  // Sleek matte-black aero aluminum lightbar housing perched just above windshield header
  addPart(lightBarGroup, new THREE.BoxGeometry(1.16, 0.048, 0.078), glossBlackTrimMat, 0, 0.0, 0.0);
  addPart(lightBarGroup, new THREE.BoxGeometry(1.08, 0.030, 0.018), lightbarLedMat, 0, 0.0, 0.042, 0, 0, 0, false);
  // Side mounting brackets + rear roof satellite pods
  addPart(lightBarGroup, new THREE.BoxGeometry(0.04, 0.055, 0.09), matteFlareMat, 0.59, -0.018, -0.01);
  addPart(lightBarGroup, new THREE.BoxGeometry(0.04, 0.055, 0.09), matteFlareMat, -0.59, -0.018, -0.01);
  addPart(lightBarGroup, new THREE.BoxGeometry(0.06, 0.042, 0.16), glossBlackTrimMat, 0.46, 0.03, -0.90);
  addPart(lightBarGroup, new THREE.BoxGeometry(0.05, 0.032, 0.12), glossBlackTrimMat, -0.42, 0.03, -0.62);

  // Kept empty/tucked anchor for backward compatibility with DetachablePartId ('roofBoards')
  const roofBoardsGroup = new THREE.Group();
  roofBoardsGroup.position.set(0, 2.05, 0.22);
  bodyGroup.add(roofBoardsGroup);

  // Single lightweight exterior forward SpotLight (dual road beam cones are analytically projected in terrain shader!)
  const forwardBeamSpot = new THREE.SpotLight(0xedf5ff, 0.0, 56, Math.PI * 0.28, 0.58, 1.25);
  forwardBeamSpot.position.set(0, 1.35, 2.55);
  forwardBeamSpot.target.position.set(0, 0.35, 24.0);
  bodyGroup.add(forwardBeamSpot);
  bodyGroup.add(forwardBeamSpot.target);

  // Detachable Sculpted Crimson Raptor Wing Mirrors with Articulated Power-Fold Pivots!
  const leftMirrorGroup = new THREE.Group();
  leftMirrorGroup.position.set(0.91, 1.32, 0.91);
  bodyGroup.add(leftMirrorGroup);
  addPart(leftMirrorGroup, new THREE.BoxGeometry(0.14, 0.052, 0.068), matteFlareMat, 0.05, 0.0, 0.0);
  const leftMirrorPivot = new THREE.Group();
  leftMirrorPivot.position.set(0.08, 0.0, 0.0);
  leftMirrorGroup.add(leftMirrorPivot);
  addPart(leftMirrorPivot, new THREE.BoxGeometry(0.255, 0.165, 0.072), pillarPaintMat, 0.105, 0.052, 0.0, 0, 0.32, 0);
  addPart(leftMirrorPivot, new THREE.BoxGeometry(0.260, 0.042, 0.076), matteFlareMat, 0.105, -0.010, 0.0, 0, 0.32, 0);
  addPart(leftMirrorPivot, new THREE.BoxGeometry(0.14, 0.014, 0.02), hazardLampMat, 0.125, 0.024, 0.038, 0, 0.32, 0, false);
  const leftMirrorLensMesh = addPart(
    leftMirrorPivot,
    new THREE.PlaneGeometry(0.232, 0.142),
    chromeMat,
    0.092,
    0.052,
    -0.039,
    0,
    Math.PI + 0.32,
    0,
    false,
  );

  const rightMirrorGroup = new THREE.Group();
  rightMirrorGroup.position.set(-0.91, 1.32, 0.91);
  bodyGroup.add(rightMirrorGroup);
  addPart(rightMirrorGroup, new THREE.BoxGeometry(0.14, 0.052, 0.068), matteFlareMat, -0.05, 0.0, 0.0);
  const rightMirrorPivot = new THREE.Group();
  rightMirrorPivot.position.set(-0.08, 0.0, 0.0);
  rightMirrorGroup.add(rightMirrorPivot);
  addPart(rightMirrorPivot, new THREE.BoxGeometry(0.255, 0.165, 0.072), pillarPaintMat, -0.105, 0.052, 0.0, 0, -0.32, 0);
  addPart(rightMirrorPivot, new THREE.BoxGeometry(0.260, 0.042, 0.076), matteFlareMat, -0.105, -0.010, 0.0, 0, -0.32, 0);
  addPart(rightMirrorPivot, new THREE.BoxGeometry(0.14, 0.014, 0.02), hazardLampMat, -0.125, 0.024, 0.038, 0, -0.32, 0, false);
  const rightMirrorLensMesh = addPart(
    rightMirrorPivot,
    new THREE.PlaneGeometry(0.232, 0.142),
    chromeMat,
    -0.092,
    0.052,
    -0.039,
    0,
    Math.PI - 0.32,
    0,
    false,
  );

  // Interior Cabin Rearview Mirror is built in RaptorCockpitBuilder and bound via interiorMirrorLensMesh

  // =========================================================================
  // 3. RAPTOR R HOOD + VENTED SCOOP + WIDE FLARES + FENDER VENTS + FRONT FASCIA
  // =========================================================================
  const hoodPivot = new THREE.Group();
  hoodPivot.position.set(0, 1.37, 1.24);
  bodyGroup.add(hoodPivot);

  const hoodDetachGroup = new THREE.Group();
  hoodPivot.add(hoodDetachGroup);

  const hoodGeo = createRaptorHoodGeometry();
  const hoodMesh = addPart(hoodDetachGroup, hoodGeo, bodyPaintMat, 0, 0, 0);
  registerDeformable(
    'hoodSkin',
    hoodMesh,
    'front',
    new THREE.Vector3(0, 1.36, 1.84),
    1.18,
    { minX: -0.72, maxX: 0.72, minY: -0.16, maxY: 0.2, minZ: 0.04, maxZ: 1.15 },
  );

  // Iconic Large Matte-Black Raptor R Hood Heat-Extractor Vent Scoop (exact signature feature in Image 3!)
  addPart(hoodDetachGroup, new THREE.BoxGeometry(0.72, 0.044, 0.56), matteFlareMat, 0, 0.068, 0.42, 0.03, 0, 0);
  addPart(hoodDetachGroup, new THREE.BoxGeometry(0.62, 0.046, 0.46), glossBlackTrimMat, 0, 0.076, 0.42, 0.03, 0, 0);
  // Three sculpted recessed louver intake gills inside the hood vent
  for (const lz of [0.27, 0.42, 0.57]) {
    addPart(hoodDetachGroup, new THREE.BoxGeometry(0.54, 0.018, 0.075), heavySteelMat, 0, 0.102, lz, 0.22, 0, 0);
  }
  // Subtle matte-black & dark-copper double hood stripes forward of the scoop (matches Image 3!)
  for (const side of [-1, 1]) {
    addPart(hoodDetachGroup, new THREE.BoxGeometry(0.065, 0.008, 0.48), matteFlareMat, side * 0.46, 0.032, 0.74, 0.11, 0, 0, false);
    addPart(hoodDetachGroup, new THREE.BoxGeometry(0.018, 0.009, 0.46), towHookRedMat, side * 0.51, 0.028, 0.74, 0.11, 0, 0, false);
  }

  // Wide Matte-Black Sculpted Raptor Wheel Arch Flares
  const archRIn = tireRadius + 0.095;
  const archROut = archRIn + 0.105;
  const flareShape = new THREE.Shape();
  const archSegs = 20;
  for (let i = 0; i <= archSegs; i++) {
    const a = (i / archSegs) * Math.PI;
    const x = Math.cos(a) * archROut;
    const y = Math.sin(a) * archROut * 0.90;
    if (i === 0) flareShape.moveTo(x, y);
    else flareShape.lineTo(x, y);
  }
  for (let i = archSegs; i >= 0; i--) {
    const a = (i / archSegs) * Math.PI;
    flareShape.lineTo(Math.cos(a) * archRIn, Math.sin(a) * archRIn * 0.90);
  }
  flareShape.closePath();

  const flareGeoBase = new THREE.ExtrudeGeometry(flareShape, {
    depth: 0.175,
    bevelEnabled: true,
    bevelThickness: 0.022,
    bevelSize: 0.016,
    bevelSegments: 2,
  });
  flareGeoBase.rotateY(-Math.PI / 2);
  trackGeo(flareGeoBase);

  for (const side of [-1, 1]) {
    // Deformable Sculpted Front Side Fenders
    const frontFenderGeo = new THREE.BoxGeometry(0.24, 0.36, 1.20, 3, 6, 14);
    frontFenderGeo.translate(side * 0.87, 1.18, 1.82);
    normalizeBodyUVs(frontFenderGeo, 0.72, 1.38);
    const ffMesh = addPart(bodyGroup, frontFenderGeo, bodyPaintMat, 0, 0, 0);
    registerDeformable(
      side > 0 ? 'frontLeftFender' : 'frontRightFender',
      ffMesh,
      'front',
      new THREE.Vector3(side * 0.87, 1.18, 1.82),
      1.15,
      { minX: -0.6, maxX: 0.6, minY: 0.84, maxY: 1.3, minZ: 1.24, maxZ: 2.26 },
    );

    // Lower front fender quarter behind wheel arch (closes cleanly to door)
    addPart(bodyGroup, new THREE.BoxGeometry(0.18, 0.42, 0.24), bodyPaintMat, side * 0.88, 0.94, 1.18);

    // Iconic Raptor Front Fender Side Air-Extractor Vent Louver + Black Hash Graphics (Image 3!)
    addPart(bodyGroup, new THREE.BoxGeometry(0.05, 0.14, 0.22), matteFlareMat, side * 0.985, 1.27, 1.24, 0.18, 0, 0);
    addPart(bodyGroup, new THREE.BoxGeometry(0.032, 0.11, 0.16), glossBlackTrimMat, side * 1.005, 1.27, 1.24, 0.18, 0, 0, false);
    const hashPlane = addPart(
      bodyGroup,
      new THREE.PlaneGeometry(0.24, 0.28),
      fenderHashMat,
      side * 0.996,
      1.12,
      1.20,
      0,
      side > 0 ? Math.PI / 2 : -Math.PI / 2,
      0,
      false,
    );
    void hashPlane;

    // Wide Front & Rear Matte-Black Raptor Flares
    const flareMesh = new THREE.Mesh(flareGeoBase, matteFlareMat);
    flareMesh.position.set(side > 0 ? 1.13 : -0.955, 0.56, 1.59);
    flareMesh.castShadow = true;
    flareMesh.receiveShadow = true;
    bodyGroup.add(flareMesh);

    // Vertical Amber LED Side-Marker on leading edge of front wheel flare (exact match to Image 3!)
    addPart(bodyGroup, new THREE.BoxGeometry(0.048, 0.11, 0.036), amberMarkerMat, side * 1.095, 0.84, 2.13, 0, 0, 0, false);

    const rearFlareMesh = new THREE.Mesh(flareGeoBase, matteFlareMat);
    rearFlareMesh.position.set(side > 0 ? 1.13 : -0.955, 0.56, -1.59);
    rearFlareMesh.scale.set(0.98, 0.94, 0.98);
    rearFlareMesh.castShadow = true;
    rearFlareMesh.receiveShadow = true;
    bodyGroup.add(rearFlareMesh);

    // Vertical Red LED Side-Marker on trailing edge of rear wheel flare
    addPart(bodyGroup, new THREE.BoxGeometry(0.046, 0.10, 0.034), brakeLightMatLeft, side * 1.09, 0.84, -2.11, 0, 0, 0, false);

    // Dark Wheel Well Liners
    const wellLinerGeo = new THREE.CylinderGeometry(archRIn * 0.98, archRIn * 0.98, 0.46, 16, 1, true, 0, Math.PI);
    wellLinerGeo.rotateZ(Math.PI / 2);
    wellLinerGeo.rotateX(-Math.PI / 2);
    addPart(bodyGroup, wellLinerGeo, rubberTrimMat, side * 0.84, 0.58, 1.59, 0, 0, 0, false);
    addPart(bodyGroup, new THREE.BoxGeometry(0.04, 0.58, 1.12), rubberTrimMat, side * 0.62, 0.88, 1.59, 0, 0, 0, false);

    const rearLinerGeo = new THREE.CylinderGeometry(archRIn * 0.96, archRIn * 0.96, 0.44, 16, 1, true, 0, Math.PI);
    rearLinerGeo.rotateZ(Math.PI / 2);
    rearLinerGeo.rotateX(-Math.PI / 2);
    addPart(bodyGroup, rearLinerGeo, rubberTrimMat, side * 0.84, 0.56, -1.59, 0, 0, 0, false);
    addPart(bodyGroup, new THREE.BoxGeometry(0.04, 0.52, 1.18), rubberTrimMat, side * 0.62, 0.82, -1.59, 0, 0, 0, false);
  }

  // Tall Thin Black Radio Whip Antenna mounted on RIGHT Front Fender (-X, exact match to Image 3!)
  const whipAntenna = new THREE.Group();
  whipAntenna.position.set(-0.90, 1.38, 1.24);
  bodyGroup.add(whipAntenna);
  addPart(whipAntenna, new THREE.CylinderGeometry(0.015, 0.018, 0.035, 8), matteFlareMat, 0, 0.015, 0, 0, 0, 0, false);
  addPart(whipAntenna, new THREE.CylinderGeometry(0.0032, 0.006, 0.78, 6), rubberTrimMat, 0, 0.40, 0, 0, 0, 0, false);

  // Deformable Front Crimson Fascia Surround (around grille & below headlights)
  const frontFasciaGeo = new THREE.BoxGeometry(1.82, 0.48, 0.14, 12, 6, 2);
  frontFasciaGeo.translate(0, 1.07, 2.38);
  normalizeBodyUVs(frontFasciaGeo, 0.72, 1.38);
  const frontFasciaMesh = addPart(bodyGroup, frontFasciaGeo, bodyPaintMat, 0, 0, 0);
  registerDeformable(
    'frontFascia',
    frontFasciaMesh,
    'front',
    new THREE.Vector3(0, 1.07, 2.38),
    1.1,
    { minX: -0.74, maxX: 0.74, minY: 0.84, maxY: 1.28, minZ: 2.08, maxZ: 2.32 },
  );

  // Iconic Wide Matte-Black Raptor R Honeycomb Grille (detachable assembly with 3D "FORD" + 3 Amber Markers + Red "R")
  const frontGrilleGroup = new THREE.Group();
  frontGrilleGroup.position.set(0, 1.09, 2.45);
  bodyGroup.add(frontGrilleGroup);
  addPart(frontGrilleGroup, new THREE.BoxGeometry(1.26, 0.44, 0.075), matteFlareMat, 0, 0, -0.015);
  addPart(frontGrilleGroup, new THREE.BoxGeometry(1.18, 0.37, 0.022), grilleMeshMat, 0, -0.01, 0.020, 0, 0, 0, false);
  // Sculpted matte-black upper & lower grille surround ribs
  addPart(frontGrilleGroup, new THREE.BoxGeometry(1.26, 0.044, 0.06), matteFlareMat, 0, 0.21, 0.005);
  addPart(frontGrilleGroup, new THREE.BoxGeometry(1.24, 0.036, 0.06), matteFlareMat, 0, -0.215, 0.005);
  // Bold 3D "F O R D" letters spanning across grille center!
  addFordBlockLetters(frontGrilleGroup, fordLetterMat, 0.038, -0.01, 0.18, 1.06, 0.038, false, trackGeo);
  // 3 Iconic Glowing Amber LED Clearance Marker Lights centered on upper grille lip!
  for (const mx of [-0.24, 0.0, 0.24]) {
    addPart(frontGrilleGroup, new THREE.BoxGeometry(0.11, 0.022, 0.024), amberMarkerMat, mx, 0.212, 0.035, 0, 0, 0, false);
  }
  // Signature Small Vivid Red-Orange "R" Badge in lower right corner of front grille (under "D", matching Image 3!)
  addPart(frontGrilleGroup, new THREE.BoxGeometry(0.062, 0.056, 0.024), raptorRBadgeMat, 0.49, -0.145, 0.036, 0, 0, 0, false);

  // Iconic Raptor C-Clamp Headlight Clusters (Outer White/Amber C-Clamp DRL + Dual Stacked Square LED Projectors!)
  for (const side of [-1, 1]) {
    const hlMat = side > 0 ? headlightLensMatLeft : headlightLensMatRight;
    const cx = side * 0.775;
    // Dark smoked headlight housing bucket
    addPart(bodyGroup, new THREE.BoxGeometry(0.32, 0.39, 0.14), glossBlackTrimMat, cx, 1.11, 2.39);
    addPart(bodyGroup, new THREE.BoxGeometry(0.28, 0.34, 0.04), rubberTrimMat, cx, 1.11, 2.45, 0, 0, 0, false);

    // Signature Outer C-Clamp Glowing DRL Light Guide (matches Image 3 exactly!)
    // Top horizontal bar
    addPart(bodyGroup, new THREE.BoxGeometry(0.29, 0.034, 0.024), ledDrlMat, cx - side * 0.01, 1.275, 2.466, 0, 0, 0, false);
    // Outer vertical glowing bar (wraps slightly around front corner!)
    addPart(bodyGroup, new THREE.BoxGeometry(0.044, 0.33, 0.052), ledDrlMat, cx + side * 0.132, 1.11, 2.448, 0, 0, 0, false);
    // Inner secondary vertical light blade
    addPart(bodyGroup, new THREE.BoxGeometry(0.024, 0.23, 0.024), ledDrlMat, cx + side * 0.075, 1.09, 2.464, 0, 0, 0, false);
    // Horizontal glowing amber/warm turn-signal / hazard bar between upper & lower projectors
    addPart(bodyGroup, new THREE.BoxGeometry(0.14, 0.022, 0.024), hazardLampMat, cx - side * 0.05, 1.095, 2.466, 0, 0, 0, false);

    // Dual Stacked Square LED Projector Lenses (Top & Bottom)
    addPart(bodyGroup, new THREE.BoxGeometry(0.092, 0.088, 0.024), hlMat, cx - side * 0.02, 1.18, 2.462, 0, 0, 0, false);
    addPart(bodyGroup, new THREE.BoxGeometry(0.092, 0.088, 0.024), hlMat, cx - side * 0.02, 1.00, 2.462, 0, 0, 0, false);

    // Clear glossy polycarbonate headlamp outer lens
    addPart(bodyGroup, new THREE.BoxGeometry(0.31, 0.37, 0.012), intactGlassMat, cx, 1.11, 2.478, 0, 0, 0, false);
  }

  // Detachable Modular Charcoal-Gunmetal Raptor R Steel Front Bumper + Red Tow Hooks + Corner Fog Pockets
  const frontBumperGroup = new THREE.Group();
  frontBumperGroup.position.set(0, 0.74, 2.49);
  bodyGroup.add(frontBumperGroup);

  // Main center steel bumper beam (subdivided deformable!)
  const bumperMainGeo = new THREE.BoxGeometry(1.94, 0.22, 0.22, 12, 4, 4);
  const bumperMainMesh = addPart(frontBumperGroup, bumperMainGeo, bumperGunmetalMat, 0, 0.01, 0.0);
  registerDeformable('frontBullbar', bumperMainMesh, 'front', new THREE.Vector3(0, 0.75, 2.49), 1.18);

  // Center recessed intercooler air slot + vertical bars
  addPart(frontBumperGroup, new THREE.BoxGeometry(0.66, 0.14, 0.04), rubberTrimMat, 0, -0.01, 0.098, 0, 0, 0, false);
  for (const bx of [-0.18, 0.0, 0.18]) {
    addPart(frontBumperGroup, new THREE.BoxGeometry(0.028, 0.14, 0.05), bumperGunmetalMat, bx, -0.01, 0.105, 0, 0, 0, false);
  }

  for (const side of [-1, 1]) {
    // Swept angled outer steel bumper wings wrapping into front fender flares
    addPart(frontBumperGroup, new THREE.BoxGeometry(0.28, 0.21, 0.34), bumperGunmetalMat, side * 0.96, 0.02, -0.14, 0, side * 0.34, 0);
    // Corner recessed Rigid-style LED fog lamp pocket (amber + white)
    addPart(frontBumperGroup, new THREE.BoxGeometry(0.24, 0.088, 0.04), rubberTrimMat, side * 0.72, 0.02, 0.098, 0, -side * 0.08, 0, false);
    const hlMat = side > 0 ? headlightLensMatLeft : headlightLensMatRight;
    addPart(frontBumperGroup, new THREE.BoxGeometry(0.075, 0.048, 0.024), hazardLampMat, side * 0.77, 0.02, 0.114, 0, -side * 0.08, 0, false);
    addPart(frontBumperGroup, new THREE.BoxGeometry(0.068, 0.048, 0.024), hlMat, side * 0.67, 0.02, 0.114, 0, -side * 0.08, 0, false);

    // ICONIC VIVID RED-ORANGE RAPTOR R FRONT TOW HOOKS (prominently visible in Image 3!)
    const hookGeo = new THREE.TorusGeometry(0.058, 0.022, 10, 16);
    addPart(frontBumperGroup, hookGeo, towHookRedMat, side * 0.45, -0.13, 0.06, Math.PI * 0.42, 0, 0);
    addPart(frontBumperGroup, new THREE.BoxGeometry(0.055, 0.055, 0.12), towHookRedMat, side * 0.45, -0.11, -0.02);
  }

  // =========================================================================
  // 4. SCULPTED F-150 RAPTOR PICKUP BED, TAILGATE WITH MATTE "FORD" APPLIQUE & LED TAILLIGHTS
  // =========================================================================
  addPart(bodyGroup, new THREE.BoxGeometry(1.90, 0.11, 2.16), bodyPaintMat, 0, 0.88, -1.48);
  addPart(bodyGroup, new THREE.BoxGeometry(1.72, 0.04, 2.04), bedDeckMat, 0, 0.94, -1.48);

  for (const side of [-1, 1]) {
    // High sculpted metallic crimson pickup bed flanks (flush with cab doors!)
    const bedWallGeo = new THREE.BoxGeometry(0.14, 0.54, 2.18, 2, 6, 18);
    bedWallGeo.translate(side * 0.89, 1.12, -1.48);
    normalizeBodyUVs(bedWallGeo, 0.7, 1.38);
    const bedWallMesh = addPart(bodyGroup, bedWallGeo, bodyPaintMat, 0, 0, 0);
    registerDeformable(
      side > 0 ? 'bedLeftWall' : 'bedRightWall',
      bedWallMesh,
      side > 0 ? 'left' : 'right',
      new THREE.Vector3(side * 0.89, 1.12, -1.48),
      1.38,
      { minX: -0.76, maxX: 0.76, minY: 0.9, maxY: 1.38, minZ: -2.48, maxZ: -0.44 },
    );

    // Matte-black bed side rail cap along top edge
    addPart(bodyGroup, new THREE.BoxGeometry(0.15, 0.036, 2.20), matteFlareMat, side * 0.89, 1.40, -1.48);

    // Subtle matte-black "RAPTOR" bedside rear-quarter graphic decal (visible in Image 3!)
    addPart(
      bodyGroup,
      new THREE.PlaneGeometry(0.92, 0.44),
      side > 0 ? leftBedDecalMat : rightBedDecalMat,
      side * 0.964,
      1.20,
      -2.06,
      0,
      side > 0 ? Math.PI / 2 : -Math.PI / 2,
      0,
      false,
    );
  }

  // Front bed headboard wall behind cab
  addPart(bodyGroup, new THREE.BoxGeometry(1.86, 0.50, 0.07), bedDeckMat, 0, 1.14, -0.42);

  // Deformable & Detachable Sculpted Tailgate with Signature Wide Matte-Black "FORD" Applique Panel
  const tailgateGroup = new THREE.Group();
  bodyGroup.add(tailgateGroup);
  const tailgateGeo = new THREE.BoxGeometry(1.84, 0.52, 0.082, 14, 6, 2);
  tailgateGeo.translate(0, 1.12, -2.54);
  normalizeBodyUVs(tailgateGeo, 0.7, 1.38);
  const tailgateMesh = addPart(tailgateGroup, tailgateGeo, bodyPaintMat, 0, 0, 0);
  registerDeformable(
    'tailgate',
    tailgateMesh,
    'rear',
    new THREE.Vector3(0, 1.12, -2.54),
    1.15,
    { minX: -0.8, maxX: 0.8, minY: 0.9, maxY: 1.38, minZ: -2.44, maxZ: -1.8 },
  );

  // Matte-black tailgate top lip & wide Raptor center applique panel + 3D "FORD" lettering
  addPart(tailgateGroup, new THREE.BoxGeometry(1.88, 0.038, 0.095), matteFlareMat, 0, 1.39, -2.54);
  addPart(tailgateGroup, new THREE.BoxGeometry(1.48, 0.25, 0.026), matteFlareMat, 0, 1.14, -2.586);
  addFordBlockLetters(tailgateGroup, fordLetterMat, -2.605, 1.14, 0.145, 1.18, 0.024, true, trackGeo);
  // Tailgate latch handle & small red "R" lower-left badge
  addPart(tailgateGroup, new THREE.BoxGeometry(0.18, 0.044, 0.028), glossBlackTrimMat, 0, 1.31, -2.586);
  addPart(tailgateGroup, new THREE.BoxGeometry(0.056, 0.048, 0.02), raptorRBadgeMat, -0.62, 1.06, -2.60, 0, 0, 0, false);

  // Modern Wrap-Around Vertical C-Clamp Raptor LED Taillights
  for (const side of [-1, 1]) {
    const blMat = side > 0 ? brakeLightMatLeft : brakeLightMatRight;
    addPart(bodyGroup, new THREE.BoxGeometry(0.19, 0.44, 0.14), glossBlackTrimMat, side * 0.87, 1.14, -2.52);
    // Vertical glowing red outer C-clamp taillight bar
    addPart(bodyGroup, new THREE.BoxGeometry(0.042, 0.39, 0.04), blMat, side * 0.93, 1.14, -2.585, 0, 0, 0, false);
    addPart(bodyGroup, new THREE.BoxGeometry(0.14, 0.042, 0.04), blMat, side * 0.87, 1.315, -2.585, 0, 0, 0, false);
    addPart(bodyGroup, new THREE.BoxGeometry(0.14, 0.042, 0.04), blMat, side * 0.87, 0.965, -2.585, 0, 0, 0, false);
    // Inner glowing red brake block + crisp white reverse lamp
    addPart(bodyGroup, new THREE.BoxGeometry(0.088, 0.13, 0.03), blMat, side * 0.84, 1.20, -2.582, 0, 0, 0, false);
    addPart(bodyGroup, new THREE.BoxGeometry(0.088, 0.095, 0.03), reverseLightMat, side * 0.84, 1.06, -2.582, 0, 0, 0, false);
  }

  // License Plate tucked into rear bumper recess
  addPart(bodyGroup, new THREE.BoxGeometry(0.37, 0.16, 0.022), heavySteelMat, 0, 0.74, -2.56);
  addPart(bodyGroup, new THREE.BoxGeometry(0.34, 0.14, 0.012), licensePlateMat, 0, 0.74, -2.574, 0, Math.PI, 0, false);

  // Build shared merged Raptor beadlock wheel templates ONCE and reuse across all 5 wheels!
  const sharedWheelTemplates: SharedRaptorWheelTemplates = {
    left: buildSingleSideWheelTemplate(tireRadius, tireWidth, 1, trackGeo),
    right: buildSingleSideWheelTemplate(tireRadius, tireWidth, -1, trackGeo),
  };

  // Under-bed Tucked Spare Tire (reuses shared wheel template scaled to 0.78 width x 0.82 radius)
  const spareWheel = buildRaptorBeadlockWheel(
    tireRadius,
    tireWidth,
    true,
    {
      tireRubber: tireRubberMat,
      tireLug: tireLugMat,
      rimPocket: rimPocketMat,
      rimMachined: rimMachinedMat,
      steelDark: heavySteelMat,
      chrome: chromeMat,
      brakeDisc: brakeDiscMat,
      caliper: caliperMat,
    },
    trackGeo,
    sharedWheelTemplates,
  );
  const spareTireGroup = new THREE.Group();
  spareTireGroup.position.set(0, 0.62, -1.96);
  bodyGroup.add(spareTireGroup);
  spareWheel.spinGroup.rotation.z = Math.PI / 2;
  spareWheel.spinGroup.scale.set(0.78, 0.82, 0.82);
  spareTireGroup.add(spareWheel.spinGroup);

  // Detachable Gunmetal Raptor Steel Rear Bumper + Dual Satin Exhaust Tips + Red Rear Tow Loops
  const rearBumperGroup = new THREE.Group();
  rearBumperGroup.position.set(0, 0.72, -2.56);
  bodyGroup.add(rearBumperGroup);
  const rearBumperGeo = new THREE.BoxGeometry(1.94, 0.18, 0.18, 10, 3, 3);
  const rearBumperMesh = addPart(rearBumperGroup, rearBumperGeo, bumperGunmetalMat, 0, 0, 0);
  registerDeformable('rearBumper', rearBumperMesh, 'rear', new THREE.Vector3(0, 0.72, -2.56), 1.1);
  // Textured black step pad on top of rear bumper
  addPart(rearBumperGroup, new THREE.BoxGeometry(1.88, 0.025, 0.16), rubberTrimMat, 0, 0.095, 0);
  // Center receiver hitch + symmetric rear red recovery loops
  addPart(rearBumperGroup, new THREE.BoxGeometry(0.14, 0.12, 0.14), heavySteelMat, 0, -0.09, -0.04);
  for (const side of [-1, 1]) {
    addPart(rearBumperGroup, new THREE.TorusGeometry(0.044, 0.015, 8, 12), towHookRedMat, side * 0.34, -0.09, -0.04, 0, Math.PI / 2, 0);
  }

  // Dual Matte-Satin Large-Bore Raptor Exhaust Tips
  for (const side of [-1, 1]) {
    const exPipeGeo = new THREE.CylinderGeometry(0.058, 0.062, 0.44, 14);
    exPipeGeo.rotateX(Math.PI / 2);
    addPart(bodyGroup, exPipeGeo, heavySteelMat, side * 0.62, 0.60, -2.42);
    addPart(bodyGroup, new THREE.TorusGeometry(0.056, 0.011, 8, 16), brushedAlumMat, side * 0.62, 0.60, -2.64, 0, 0, 0, false);
    const coreGeo = new THREE.CylinderGeometry(0.044, 0.044, 0.04, 12);
    coreGeo.rotateX(Math.PI / 2);
    addPart(bodyGroup, coreGeo, boostGlowMat, side * 0.62, 0.60, -2.62, 0, 0, 0, false);
  }

  // =========================================================================
  // 5. CONTACT SHADOW & 4 INDEPENDENT FOX LIVE-VALVE SUSPENSION WHEEL ASSEMBLIES
  // =========================================================================
  const contactShadowGeo = trackGeo(new THREE.PlaneGeometry(2.62, 5.52));
  contactShadowGeo.rotateX(-Math.PI / 2);
  const contactShadowMat = trackMat(
    new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: 0.56,
      depthWrite: false,
    }),
  );
  const contactShadow = new THREE.Mesh(contactShadowGeo, contactShadowMat);
  contactShadow.position.y = 0.03;
  root.add(contactShadow);

  const wheelAssemblies: WheelVisualAssembly[] = [];

  for (const spec of wheelSpecs) {
    const steerPivot = new THREE.Group();
    steerPivot.position.set(spec.x, tireRadius, spec.z);
    root.add(steerPivot);

    const camberGroup = new THREE.Group();
    steerPivot.add(camberGroup);

    const { spinGroup, hubAssembly } = buildRaptorBeadlockWheel(
      tireRadius,
      tireWidth,
      spec.isLeft,
      {
        tireRubber: tireRubberMat,
        tireLug: tireLugMat,
        rimPocket: rimPocketMat,
        rimMachined: rimMachinedMat,
        steelDark: heavySteelMat,
        chrome: chromeMat,
        brakeDisc: brakeDiscMat,
        caliper: caliperMat,
      },
      trackGeo,
      sharedWheelTemplates,
    );
    camberGroup.add(hubAssembly);
    camberGroup.add(spinGroup);

    const dir = spec.isLeft ? 1 : -1;
    const armLen = Math.max(0.32, Math.abs(spec.x) - 0.45);

    const lowerArmGeo = trackGeo(new THREE.BoxGeometry(armLen, 0.068, 0.14));
    lowerArmGeo.translate(dir * armLen * 0.5, 0, 0);
    const lowerArm = new THREE.Mesh(lowerArmGeo, underbodyIronMat);
    lowerArm.position.set(dir * 0.45, 0.48, spec.z);
    lowerArm.castShadow = true;
    root.add(lowerArm);

    const upperArmGeo = trackGeo(new THREE.BoxGeometry(armLen * 0.92, 0.05, 0.1));
    upperArmGeo.translate(dir * armLen * 0.46, 0, 0);
    const upperArm = new THREE.Mesh(upperArmGeo, heavySteelMat);
    upperArm.position.set(dir * 0.45, 0.68, spec.z);
    upperArm.castShadow = true;
    root.add(upperArm);

    const coilGroup = new THREE.Group();
    coilGroup.position.set(dir * (Math.abs(spec.x) - 0.3), spec.isFront ? 0.66 : 0.6, spec.z);
    root.add(coilGroup);

    // Anodized FOX Live-Valve Blue Coilover Shocks
    const shockH = spec.isFront ? 0.38 : 0.3;
    addPart(coilGroup, new THREE.CylinderGeometry(0.016, 0.016, shockH * 1.05, 10), chromeMat, 0, -shockH * 0.06, 0, 0, 0, 0, false);
    addPart(coilGroup, new THREE.CylinderGeometry(0.032, 0.032, shockH * 0.68, 12), foxBlueShockMat, 0, shockH * 0.14, 0, 0, 0, 0, false);
    addPart(coilGroup, new THREE.CylinderGeometry(0.022, 0.022, shockH * 0.54, 10), foxBlueShockMat, 0, shockH * 0.18, spec.isFront ? -0.065 : 0.065, 0, 0, 0, false);
    for (let c = -2; c <= 2; c++) {
      const springRing = new THREE.TorusGeometry(0.056, 0.011, 6, 16);
      springRing.rotateX(Math.PI / 2);
      addPart(coilGroup, springRing, towHookRedMat, 0, c * (shockH * 0.145), 0, 0, 0, 0, false);
    }
    mergeStaticMeshesInGroup(coilGroup, new Set(), trackGeo);

    wheelAssemblies.push({
      steerPivot,
      camberGroup,
      spinGroup,
      lowerArm,
      upperArm,
      coilGroup,
    });
  }

  const detachableGroups: Record<DetachablePartId, THREE.Group> = {
    frontBumper: frontBumperGroup,
    frontGrille: frontGrilleGroup,
    rearBumper: rearBumperGroup,
    tailgate: tailgateGroup,
    hood: hoodDetachGroup,
    leftMirror: leftMirrorGroup,
    rightMirror: rightMirrorGroup,
    leftStep: leftStepGroup!,
    rightStep: rightStepGroup!,
    spareTire: spareTireGroup,
    roofBoards: roofBoardsGroup,
    lightBar: lightBarGroup,
  };

  // Static mesh batching: merge non-deformable direct child meshes by material in bodyGroup & detachable subassemblies
  const mergeExclusions = new Set<THREE.Object3D>([
    windshieldMesh,
    rearGlassMesh,
    leftMirrorLensMesh,
    rightMirrorLensMesh,
    interiorMirrorLensMesh,
  ]);
  for (let i = 0; i < deformableMeshes.length; i++) {
    mergeExclusions.add(deformableMeshes[i].mesh);
  }
  mergeStaticMeshesInGroup(bodyGroup, mergeExclusions, trackGeo);
  mergeStaticMeshesInGroup(frontBumperGroup, mergeExclusions, trackGeo);
  mergeStaticMeshesInGroup(frontGrilleGroup, mergeExclusions, trackGeo);
  mergeStaticMeshesInGroup(rearBumperGroup, mergeExclusions, trackGeo);
  mergeStaticMeshesInGroup(tailgateGroup, mergeExclusions, trackGeo);
  mergeStaticMeshesInGroup(hoodDetachGroup, mergeExclusions, trackGeo);
  mergeStaticMeshesInGroup(leftStepGroup!, mergeExclusions, trackGeo);
  mergeStaticMeshesInGroup(rightStepGroup!, mergeExclusions, trackGeo);
  mergeStaticMeshesInGroup(roofBoardsGroup, mergeExclusions, trackGeo);
  mergeStaticMeshesInGroup(lightBarGroup, mergeExclusions, trackGeo);

  const resetVisualDamage = () => {
    for (let i = 0; i < deformableMeshes.length; i++) {
      const rec = deformableMeshes[i];
      const geo = rec.mesh.geometry;
      (geo.attributes.position.array as Float32Array).set(rec.restPositions);
      (geo.attributes.normal.array as Float32Array).set(rec.restNormals);
      (geo.attributes.color.array as Float32Array).set(rec.restColors);
      if (geo.attributes.aScrape) {
        (geo.attributes.aScrape.array as Float32Array).fill(0);
        geo.attributes.aScrape.needsUpdate = true;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.normal.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
    }

    hoodPivot.rotation.set(0, 0, 0);
    windshieldMesh.material = intactGlassMat;
    rearGlassMesh.material = intactRearGlassMat;
    headlightLensMatLeft.emissiveIntensity = 2.2;
    headlightLensMatRight.emissiveIntensity = 2.2;
    headlightLensMatLeft.color.setHex(0xf4f8ff);
    headlightLensMatRight.color.setHex(0xf4f8ff);

    const keys = Object.keys(detachableGroups) as DetachablePartId[];
    for (const k of keys) {
      detachableGroups[k].visible = true;
    }
    for (const asm of wheelAssemblies) {
      asm.camberGroup.rotation.set(0, 0, 0);
    }
  };

  const reflectiveMaterials: Array<{
    material: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
    baseEnvIntensity: number;
  }> = [
    { material: bodyPaintMat, baseEnvIntensity: 1.24 },
    { material: pillarPaintMat, baseEnvIntensity: 1.18 },
    { material: glossBlackTrimMat, baseEnvIntensity: 1.1 },
    { material: bumperGunmetalMat, baseEnvIntensity: 0.85 },
    { material: intactGlassMat, baseEnvIntensity: 1.48 },
    { material: crackedGlassMat, baseEnvIntensity: 1.05 },
    { material: shatteredGlassMat, baseEnvIntensity: 0.78 },
    { material: rearPrivacyGlassMat, baseEnvIntensity: 1.38 },
    { material: intactRearGlassMat, baseEnvIntensity: 1.38 },
    { material: crackedRearGlassMat, baseEnvIntensity: 0.92 },
    { material: chromeMat, baseEnvIntensity: 1.38 },
    { material: brushedAlumMat, baseEnvIntensity: 1.05 },
    { material: rimPocketMat, baseEnvIntensity: 0.7 },
    { material: rimMachinedMat, baseEnvIntensity: 1.15 },
    { material: brakeDiscMat, baseEnvIntensity: 0.82 },
  ];

  return {
    bodyGroup,
    hoodPivot,
    steeringWheel,
    whipAntenna,
    brakeLightMatLeft,
    brakeLightMatRight,
    reverseLightMat,
    headlightLensMatLeft,
    headlightLensMatRight,
    ledDrlMat,
    amberMarkerMat,
    hazardLampMat,
    lightbarLedMat,
    boostGlowMat,
    forwardBeamSpot,
    windshieldMesh,
    rearGlassMesh,
    leftMirrorPivot,
    rightMirrorPivot,
    leftMirrorLensMesh,
    rightMirrorLensMesh,
    interiorMirrorLensMesh,
    intactGlassMat,
    crackedGlassMat,
    shatteredGlassMat,
    intactRearGlassMat,
    crackedRearGlassMat,
    reflectiveMaterials,
    contactShadow,
    wheelAssemblies,
    deformableMeshes,
    detachableGroups,
    cockpit,
    resetVisualDamage,
    dispose: () => {
      cockpit.dispose();
      for (const g of disposableGeos) g.dispose();
      for (const m of disposableMats) m.dispose();
      for (const t of disposableTex) t.dispose();
    },
  };
}
