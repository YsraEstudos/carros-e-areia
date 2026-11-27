/**
 * VehicleReflectionSystem.ts
 * Dual real-time automotive reflection architecture:
 *  1. Time-Sliced Dynamic Cubemap Probe (`THREE.CubeCamera` + `WebGLCubeRenderTarget`)
 *     - Renders 1 face/frame in Hybrid (128px) or 2 faces/frame in Ultra (256px)
 *     - Full 6-face prime on initialization / biome / weather change
 *     - Automatic freeze when stationary to save GPU bandwidth
 *     - Triggers Three.js CubeUV PMREM convolution cleanly at cycle completion
 *     - Feeds Parallax-Corrected Cubemap (PCC) center & bounding box uniforms to paint & glass
 *  2. Real-Time Functional Wing Mirrors (Left & Right) + Interior Cabin Mirror
 *     - Dedicated rear-facing PerspectiveCameras mounted to wing mirror anchors
 *     - Interleaved L/R rendering in Hybrid (160x112), dual-mirror in Ultra (256x180)
 *     - Distance/visibility/detached-part culling so mirrors cost 0ms when off-screen or broken
 *     - Optical GLSL3 mirror ShaderMaterial with horizontal flip, subtle convex curvature,
 *       anti-glare blue-green tint, grazing Fresnel sheen, and cracked fallback when detached
 */

import * as THREE from 'three';
import { EnvironmentBiome, GraphicsQuality } from '../core/SandParams';
import { getGraphicsQualityBudget } from '../core/GraphicsQualityBudget';
import {
  BiomeReflectionBounds,
  ReflectionCubeScheduleDecision,
  ReflectionCubeScheduleInput,
  ReflectionCubeScheduler,
  computeBiomeReflectionBoundsInto,
} from '../core/ReflectionRayMath';
import {
  computeReflectionLodProfileInto,
  ReflectionLodInput,
  ReflectionLodProfile,
} from '../core/DistanceLodPolicy';

/** Layer index excluded from CubeCamera & rear-view mirror reflection captures (grass, particles, rain, scrub). */
export const ENV_DETAIL_EXCLUDED_LAYER = 2;
/** Layer index for Rivian cabin interior meshes: visible to mainCamera, completely skipped by all mirrors & CubeCamera. */
export const CABIN_INTERIOR_LAYER = 3;

export interface MirrorAnchorInfo {
  worldPos: THREE.Vector3;
  worldForward: THREE.Vector3;
  worldRight: THREE.Vector3;
  worldUp: THREE.Vector3;
  detached: boolean;
  yawOffsetRad?: number;
  pitchOffsetRad?: number;
  fold01?: number;
}

export interface VehicleReflectionUpdateParams {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  mainCamera: THREE.PerspectiveCamera;
  vehicleRoot: THREE.Object3D;
  vehiclePos: THREE.Vector3;
  /** Exact terrain/road height underneath the vehicle for flush ground-plane reflection projection */
  groundPlaneY: number;
  /** Vehicle body world matrix used for local-space self-body reflection occlusion */
  bodyWorldMatrix: THREE.Matrix4;
  biome: EnvironmentBiome;
  vehicleSpeedMs: number;
  leftMirror: MirrorAnchorInfo;
  rightMirror: MirrorAnchorInfo;
  interiorMirror: MirrorAnchorInfo;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  reflectionIntensity: number;
  /** Toggle custom shaders into linear HDR mode during HalfFloat capture */
  setLinearHdrOutput: (enabled: boolean) => void;
  /** Current linear HDR state to restore after capture */
  restoreLinearHdr: boolean;
  /** Force immediate full 6-face cube prime */
  forceFullPrime?: boolean;
  /** True when user is inside 1st-person cockpit so live mirrors render even on low/softwareGL */
  isCockpitMode?: boolean;
}

export interface ReflectionSharedUniforms {
  uEnvCubeRaw: { value: THREE.CubeTexture | null };
  uHasRawCube: { value: number };
  uRawCubeMaxMip: { value: number };
  uCubeCenter: { value: THREE.Vector3 };
  uCubeBoxHalf: { value: THREE.Vector3 };
  uCubeBoxMin: { value: THREE.Vector3 };
  uCubeBoxMax: { value: THREE.Vector3 };
  uVehicleInvMatrix: { value: THREE.Matrix4 };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSkyColor: { value: THREE.Color };
  uGroundColor: { value: THREE.Color };
  uPccEnabled: { value: number };
  uReflectGain: { value: number };
  uReflLodBias: { value: number };
  uChassisDust: { value: number };
  uBiomeMud: { value: number };
}

const MIRROR_VERT = /* glsl */ `
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

const MIRROR_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec3 vWorldPos;
in vec3 vWorldNormal;

uniform sampler2D uMirrorTex;
uniform vec2 uMirrorUvScale;
uniform float uLiveEnabled;
uniform float uConvexity;
uniform float uLinearHdrOutput;
uniform float uReflectGain;
uniform vec3 uSkyColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;

out vec4 fragColor;

void main() {
  // Subtle automotive convex mirror barrel curvature + true horizontal mirror flip
  vec2 centered = vUv * 2.0 - 1.0;
  float r2 = dot(centered, centered);
  vec2 warped = centered * (1.0 + uConvexity * r2);
  vec2 mirrorUv = vec2(1.0 - (warped.x * 0.5 + 0.5), warped.y * 0.5 + 0.5);

  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(vWorldNormal);
  float NdotV = max(dot(N, V), 0.05);
  float fresnel = 0.04 + 0.96 * pow(1.0 - NdotV, 5.0);

  vec3 col;
  if (uLiveEnabled > 0.5) {
    vec2 clampedUv = clamp(mirrorUv, vec2(0.01), vec2(0.99)) * uMirrorUvScale;
    vec3 liveSample = texture(uMirrorTex, clampedUv).rgb;
    // Slight realistic automotive anti-glare blue-green silvered glass tint
    col = liveSample * vec3(0.91, 0.96, 0.94) * (0.94 + 0.14 * uReflectGain);
  } else {
    // Low-tier / culled fallback: clean analytic horizon reflection so mirror never looks black
    vec3 R = reflect(-V, N);
    float skyT = smoothstep(-0.08, 0.25, R.y);
    vec3 groundCol = vec3(0.32, 0.20, 0.11);
    vec3 skyCol = mix(uSkyColor * 0.9, uSkyColor * 1.35, clamp(R.y, 0.0, 1.0));
    float sunSpec = pow(max(dot(R, normalize(uSunDir)), 0.0), 64.0) * 1.8;
    col = mix(groundCol, skyCol, skyT) + uSunColor * sunSpec;
  }

  // Subtle top-layer glass cover Fresnel sheen + clean beveled dark gasket edge
  float edgeX = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
  float edgeY = smoothstep(0.0, 0.05, vUv.y) * smoothstep(1.0, 0.95, vUv.y);
  float bezelMask = edgeX * edgeY;

  vec3 glassSheen = uSkyColor * (fresnel * 0.26);
  col = (col + glassSheen) * mix(0.22, 1.0, bezelMask);

  if (uLinearHdrOutput < 0.5) {
    col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
    col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  }

  fragColor = vec4(col, 1.0);
}
`;

// Pre-allocated scratch vectors (zero per-frame GC)
const _camToMirror = new THREE.Vector3();
const _mirrorTarget = new THREE.Vector3();
const _probeWorldPos = new THREE.Vector3();
const _boundsScratch: BiomeReflectionBounds = {
  minX: -24,
  minY: 0,
  minZ: -24,
  maxX: 24,
  maxY: 24,
  maxZ: 24,
  probeCenterY: 1.18,
};
const _reflLodInputScratch: ReflectionLodInput = {
  camToVehicleDist: 8,
  isCockpit: false,
  biome: 'rainy_highway',
  quality: 'hybrid',
  isMobile: false,
  vehicleSpeedMs: 0,
};
const _reflLodScratch: ReflectionLodProfile = {
  cubeMipBias: 0,
  cubeCooldownMult: 1,
  cubeFar: 220,
  mirrorIntervalMs: 16.2,
  mirrorViewportScale: 1,
  mirrorFar: 155,
};
const _cubeSchedInputScratch: ReflectionCubeScheduleInput = {
  nowMs: 0,
  probeX: 0,
  probeY: 1.18,
  probeZ: 0,
  groundPlaneY: 0,
  biome: 'desert',
  isLowTier: false,
  vehicleSpeedMs: 0,
  facesPerFrame: 2,
  minMovedDistSq: 0.64,
  fastMovedDistSq: 0.36,
  minCooldownFrames: 2,
  fastCooldownFrames: 2,
  cooldownMult: 1,
  minCycleIntervalMs: 48,
  pmremMinIntervalMs: 180,
  hasPmrem: false,
  forceFullPrime: false,
};
const _cubeSchedDecisionScratch: ReflectionCubeScheduleDecision = {
  action: 'idle',
  faceStart: 0,
  faceCount: 0,
  captureX: 0,
  captureY: 1.18,
  captureZ: 0,
  completesCycle: false,
  shouldBakePmrem: false,
};

export class VehicleReflectionSystem {
  public readonly sharedUniforms: ReflectionSharedUniforms = {
    uEnvCubeRaw: { value: null },
    uHasRawCube: { value: 0.0 },
    uRawCubeMaxMip: { value: 6.0 },
    uCubeCenter: { value: new THREE.Vector3(0, 1.18, 0) },
    uCubeBoxHalf: { value: new THREE.Vector3(24.0, 14.0, 24.0) },
    uCubeBoxMin: { value: new THREE.Vector3(-24.0, 0.0, -24.0) },
    uCubeBoxMax: { value: new THREE.Vector3(24.0, 24.0, 24.0) },
    uVehicleInvMatrix: { value: new THREE.Matrix4() },
    uSunDir: { value: new THREE.Vector3(0.4, 0.35, 0.84) },
    uSunColor: { value: new THREE.Color(1.4, 1.1, 0.85) },
    uSkyColor: { value: new THREE.Color(0.55, 0.62, 0.72) },
    uGroundColor: { value: new THREE.Color(0.24, 0.20, 0.16) },
    uPccEnabled: { value: 1.0 },
    uReflectGain: { value: 1.05 },
    uReflLodBias: { value: 0.0 },
    uChassisDust: { value: 0.18 },
    uBiomeMud: { value: 0.0 },
  };

  public readonly leftMirrorMaterial: THREE.ShaderMaterial;
  public readonly rightMirrorMaterial: THREE.ShaderMaterial;
  public readonly interiorMirrorMaterial: THREE.ShaderMaterial;
  private readonly mirrorMaterials: readonly THREE.ShaderMaterial[];

  private quality: GraphicsQuality = 'hybrid';
  private readonly isSoftwareGl: boolean;
  private readonly isMobile: boolean;

  private cubeRTs: [THREE.WebGLCubeRenderTarget | null, THREE.WebGLCubeRenderTarget | null] = [
    null,
    null,
  ];
  private cubeCameras: [THREE.CubeCamera | null, THREE.CubeCamera | null] = [null, null];
  private cubeReadIdx: 0 | 1 = 0;
  private pmremGenerator: THREE.PMREMGenerator | null = null;
  private pmremRT: THREE.WebGLCubeRenderTarget | null = null;
  private readonly cubeScheduler = new ReflectionCubeScheduler();

  private leftMirrorRT: THREE.WebGLRenderTarget | null = null;
  private rightMirrorRT: THREE.WebGLRenderTarget | null = null;
  private interiorMirrorRT: THREE.WebGLRenderTarget | null = null;
  private readonly leftMirrorCam: THREE.PerspectiveCamera;
  private readonly rightMirrorCam: THREE.PerspectiveCamera;
  private readonly interiorMirrorCam: THREE.PerspectiveCamera;
  private mirrorToggleParity = 0;
  private mirrorsRenderedThisFrame = 0;
  private lastLeftMirrorMs = -1e6;
  private lastRightMirrorMs = -1e6;
  private lastInteriorMirrorMs = -1e6;
  private lastLeftMirrorAdjustSig = NaN;
  private lastRightMirrorAdjustSig = NaN;
  private lastInteriorMirrorAdjustSig = NaN;
  private currentCubeFar: [number, number] = [940, 940];
  private currentMirrorFar = 260;

  private readonly fallbackTex: THREE.DataTexture;

  constructor(isSoftwareGl: boolean, initialQuality: GraphicsQuality, isMobile = false) {
    this.isSoftwareGl = isSoftwareGl;
    this.isMobile = isMobile;
    this.quality = isSoftwareGl ? 'low' : initialQuality;

    this.fallbackTex = new THREE.DataTexture(
      new Uint8Array([90, 110, 130, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    this.fallbackTex.needsUpdate = true;

    // Aspect matching Rivian R1T wing mirrors (~0.166 x 0.157) & wide interior mirror (~0.236 x 0.065)
    this.leftMirrorCam = new THREE.PerspectiveCamera(44, 160 / 150, 0.25, 260);
    this.rightMirrorCam = new THREE.PerspectiveCamera(44, 160 / 150, 0.25, 260);
    this.interiorMirrorCam = new THREE.PerspectiveCamera(34, 216 / 60, 0.35, 260);
    // Keep mirror cameras strictly on Layer 0 so grass/smoke/particles on ENV_DETAIL_EXCLUDED_LAYER are skipped
    this.leftMirrorCam.layers.set(0);
    this.rightMirrorCam.layers.set(0);
    this.interiorMirrorCam.layers.set(0);

    this.leftMirrorMaterial = this.createMirrorMaterial(0.05);
    this.rightMirrorMaterial = this.createMirrorMaterial(0.07);
    this.interiorMirrorMaterial = this.createMirrorMaterial(0.015);
    this.mirrorMaterials = [
      this.leftMirrorMaterial,
      this.rightMirrorMaterial,
      this.interiorMirrorMaterial,
    ];

    this.rebuildTargets();
  }

  private createMirrorMaterial(convexity: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      vertexShader: MIRROR_VERT,
      fragmentShader: MIRROR_FRAG,
      uniforms: {
        uMirrorTex: { value: this.fallbackTex },
        uMirrorUvScale: { value: new THREE.Vector2(1, 1) },
        uLiveEnabled: { value: 0.0 },
        uConvexity: { value: convexity },
        uLinearHdrOutput: { value: 0.0 },
        uReflectGain: { value: 1.05 },
        uSkyColor: { value: new THREE.Color(0.30, 0.48, 0.78) },
        uSunColor: { value: new THREE.Color(1.9, 1.25, 0.76) },
        uSunDir: { value: new THREE.Vector3(0.5, 0.25, 0.8) },
      },
    });
  }

  public setQuality(next: GraphicsQuality): void {
    const effective: GraphicsQuality = this.isSoftwareGl ? 'low' : next;
    if (effective === this.quality) return;
    this.quality = effective;
    this.rebuildTargets();
  }

  public markDirty(): void {
    this.cubeScheduler.markDirty();
  }

  public getDynamicEnvMap(): THREE.Texture | null {
    return this.pmremRT ? this.pmremRT.texture : null;
  }

  public getMirrorsActiveCount(): number {
    return this.mirrorsRenderedThisFrame;
  }

  public getProbeModeLabel(): string {
    if (this.quality === 'low') return 'Cube 128² Estático';
    return this.quality === 'ultra' ? 'Cube 256²×2 (3 faces/f)' : 'Cube 128²×2 (2 faces/f)';
  }

  private ensureMirrorTargets(): void {
    if (this.leftMirrorRT && this.rightMirrorRT && this.interiorMirrorRT) return;
    const budget = getGraphicsQualityBudget(this.quality, this.isMobile, this.isSoftwareGl);
    const rtType = this.quality === 'low' ? THREE.UnsignedByteType : THREE.HalfFloatType;
    const mirrorW = budget.mirrorWingWidth;
    const mirrorH = budget.mirrorWingHeight;
    const intW = budget.mirrorInteriorWidth;
    const intH = budget.mirrorInteriorHeight;
    const rtOpts: THREE.RenderTargetOptions = {
      type: rtType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    };
    this.leftMirrorRT = new THREE.WebGLRenderTarget(mirrorW, mirrorH, rtOpts);
    this.rightMirrorRT = new THREE.WebGLRenderTarget(mirrorW, mirrorH, rtOpts);
    this.interiorMirrorRT = new THREE.WebGLRenderTarget(intW, intH, rtOpts);

    this.leftMirrorCam.aspect = mirrorW / mirrorH;
    this.leftMirrorCam.far = budget.mirrorFar;
    this.leftMirrorCam.updateProjectionMatrix();
    this.rightMirrorCam.aspect = mirrorW / mirrorH;
    this.rightMirrorCam.far = budget.mirrorFar;
    this.rightMirrorCam.updateProjectionMatrix();
    this.interiorMirrorCam.aspect = intW / intH;
    this.interiorMirrorCam.far = budget.mirrorFar;
    this.interiorMirrorCam.updateProjectionMatrix();

    this.leftMirrorMaterial.uniforms.uMirrorTex.value = this.leftMirrorRT.texture;
    this.rightMirrorMaterial.uniforms.uMirrorTex.value = this.rightMirrorRT.texture;
    this.interiorMirrorMaterial.uniforms.uMirrorTex.value = this.interiorMirrorRT.texture;
  }

  private rebuildTargets(): void {
    for (let i = 0; i < 2; i++) {
      const rt = this.cubeRTs[i];
      if (rt) {
        rt.dispose();
        this.cubeRTs[i] = null;
      }
      this.cubeCameras[i] = null;
    }
    if (this.pmremRT) {
      this.pmremRT.dispose();
      this.pmremRT = null;
    }
    if (this.leftMirrorRT) {
      this.leftMirrorRT.dispose();
      this.leftMirrorRT = null;
    }
    if (this.rightMirrorRT) {
      this.rightMirrorRT.dispose();
      this.rightMirrorRT = null;
    }
    if (this.interiorMirrorRT) {
      this.interiorMirrorRT.dispose();
      this.interiorMirrorRT = null;
    }

    // Mirror RenderTargets are lazily allocated on first cockpit/near-mirror frame in ensureMirrorTargets()
    this.leftMirrorMaterial.uniforms.uMirrorTex.value = this.fallbackTex;
    this.rightMirrorMaterial.uniforms.uMirrorTex.value = this.fallbackTex;
    this.interiorMirrorMaterial.uniforms.uMirrorTex.value = this.fallbackTex;
    this.leftMirrorMaterial.uniforms.uLiveEnabled.value = 0.0;
    this.rightMirrorMaterial.uniforms.uLiveEnabled.value = 0.0;
    this.interiorMirrorMaterial.uniforms.uLiveEnabled.value = 0.0;

    // Allocate linear HalfFloat mipmapped CubeCamera probes:
    //  - low / SoftwareGL: single 128² captured ONCE on init / biome / weather / sun change (0ms/frame steady state!)
    //  - hybrid: ping-pong double-buffered 128²×2 (2 faces/frame, atomic swap + complete mipmaps)
    //  - ultra: ping-pong double-buffered 256²×2 (3 faces/frame, atomic swap + complete mipmaps)
    const cubeSize = this.quality === 'ultra' ? 256 : 128;
    const bufferCount = this.quality === 'low' ? 1 : 2;
    for (let i = 0; i < bufferCount; i++) {
      const rt = new THREE.WebGLCubeRenderTarget(cubeSize, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });
      const cam = new THREE.CubeCamera(0.35, 940, rt);
      // Keep all 6 CubeCamera sub-cameras on Layer 0 so dense grass/particles/rain are excluded from reflection captures
      cam.layers.set(0);
      for (const child of cam.children) {
        child.layers.set(0);
      }
      this.cubeRTs[i] = rt;
      this.cubeCameras[i] = cam;
    }
    this.cubeReadIdx = 0;
    this.currentCubeFar[0] = 940;
    this.currentCubeFar[1] = 940;
    this.cubeScheduler.reset();
    this.lastLeftMirrorMs = -1e6;
    this.lastRightMirrorMs = -1e6;
    this.lastInteriorMirrorMs = -1e6;
    this.sharedUniforms.uEnvCubeRaw.value = this.cubeRTs[0] ? this.cubeRTs[0].texture : null;
    this.sharedUniforms.uHasRawCube.value = 0.0;
    this.sharedUniforms.uRawCubeMaxMip.value = Math.log2(cubeSize);
    this.sharedUniforms.uPccEnabled.value = 1.0;
    this.sharedUniforms.uReflLodBias.value = 0.0;
  }

  public update(params: VehicleReflectionUpdateParams): void {
    const {
      renderer,
      scene,
      mainCamera,
      vehicleRoot,
      vehiclePos,
      groundPlaneY,
      bodyWorldMatrix,
      biome,
      vehicleSpeedMs,
      leftMirror,
      rightMirror,
      sunDir,
      sunColor,
      skyColor,
      groundColor,
      reflectionIntensity,
      setLinearHdrOutput,
      restoreLinearHdr,
      forceFullPrime,
    } = params;

    this.sharedUniforms.uVehicleInvMatrix.value.copy(bodyWorldMatrix).invert();
    this.sharedUniforms.uSunDir.value.copy(sunDir);
    this.sharedUniforms.uSunColor.value.copy(sunColor);
    this.sharedUniforms.uSkyColor.value.copy(skyColor);
    this.sharedUniforms.uGroundColor.value.copy(groundColor);
    this.sharedUniforms.uReflectGain.value = reflectionIntensity;

    // Always keep mirror fallback uniforms synced (zero per-frame array allocation)
    const mirrorMats = this.mirrorMaterials;
    for (let i = 0; i < mirrorMats.length; i++) {
      const mu = mirrorMats[i].uniforms;
      mu.uLinearHdrOutput.value = restoreLinearHdr ? 1.0 : 0.0;
      mu.uReflectGain.value = reflectionIntensity;
      mu.uSkyColor.value.copy(skyColor);
      mu.uSunColor.value.copy(sunColor);
      mu.uSunDir.value.copy(sunDir);
    }

    const isCockpit = Boolean(params.isCockpitMode);
    const budget = getGraphicsQualityBudget(this.quality, this.isMobile, this.isSoftwareGl);

    // Distance-adaptive Smart Reflection LOD (zero per-frame allocations)
    _reflLodInputScratch.camToVehicleDist = mainCamera.position.distanceTo(vehiclePos);
    _reflLodInputScratch.isCockpit = isCockpit;
    _reflLodInputScratch.biome = biome;
    _reflLodInputScratch.quality = this.quality;
    _reflLodInputScratch.isMobile = this.isMobile;
    _reflLodInputScratch.vehicleSpeedMs = vehicleSpeedMs;
    const reflLod = computeReflectionLodProfileInto(_reflLodInputScratch, _reflLodScratch);
    this.sharedUniforms.uReflLodBias.value = reflLod.cubeMipBias;

    const nowMs = performance.now();
    const probeY = groundPlaneY + 1.18;
    this.cubeScheduler.seedInitialBoundsIfUnpublished(
      vehiclePos.x,
      probeY,
      vehiclePos.z,
      groundPlaneY,
      biome,
    );

    const hasDoubleBuffer = this.quality !== 'low' && this.cubeRTs[1] !== null && this.cubeCameras[1] !== null;
    const writeIdx: 0 | 1 = hasDoubleBuffer ? (this.cubeReadIdx === 0 ? 1 : 0) : 0;
    const writeRT = this.cubeRTs[writeIdx];
    const writeCam = this.cubeCameras[writeIdx];

    const schedIn = _cubeSchedInputScratch;
    schedIn.nowMs = nowMs;
    schedIn.probeX = vehiclePos.x;
    schedIn.probeY = probeY;
    schedIn.probeZ = vehiclePos.z;
    schedIn.groundPlaneY = groundPlaneY;
    schedIn.biome = biome;
    schedIn.isLowTier = this.quality === 'low';
    schedIn.vehicleSpeedMs = vehicleSpeedMs;
    schedIn.facesPerFrame = budget.cubeFacesPerFrame;
    schedIn.minMovedDistSq = budget.cubeMinMovedDistSq;
    schedIn.fastMovedDistSq = budget.cubeFastMovedDistSq;
    schedIn.minCooldownFrames = budget.cubeMinCooldownFrames;
    schedIn.fastCooldownFrames = budget.cubeFastCooldownFrames;
    schedIn.cooldownMult = reflLod.cubeCooldownMult;
    schedIn.minCycleIntervalMs = this.quality === 'ultra' ? 32.0 : 48.0;
    schedIn.pmremMinIntervalMs = 180.0;
    schedIn.hasPmrem = this.pmremRT !== null;
    schedIn.forceFullPrime = Boolean(forceFullPrime);

    const cubeDecision = this.cubeScheduler.evaluateInto(schedIn, _cubeSchedDecisionScratch);
    const shouldUpdateCube = writeRT !== null && writeCam !== null && cubeDecision.action !== 'idle';
    const runMirrors = this.quality !== 'low' || isCockpit;

    // Sync PCC center & biome bounding box strictly from the PUBLISHED probe origin (matches readCubeRT 1:1!)
    this.syncPublishedProbeUniforms();

    this.mirrorsRenderedThisFrame = 0;
    if (!shouldUpdateCube && !runMirrors) {
      return;
    }

    // Check wall-clock mirror refresh budgets BEFORE touching WebGL render state
    // so uncapped 120–400+ FPS skips redundant mirror passes cleanly with 0 state churn!
    const wantLeft =
      runMirrors &&
      !leftMirror.detached &&
      (isCockpit || this.isMirrorRelevant(mainCamera, leftMirror));
    const wantRight =
      runMirrors &&
      !rightMirror.detached &&
      (isCockpit || this.isMirrorRelevant(mainCamera, rightMirror));
    const wantInterior = runMirrors && isCockpit;

    const mirrorMinIntervalMs = reflLod.mirrorIntervalMs;
    const leftAdjSig =
      (leftMirror.yawOffsetRad ?? 0) * 100 +
      (leftMirror.pitchOffsetRad ?? 0) * 10 +
      (leftMirror.fold01 ?? 0);
    const rightAdjSig =
      (rightMirror.yawOffsetRad ?? 0) * 100 +
      (rightMirror.pitchOffsetRad ?? 0) * 10 +
      (rightMirror.fold01 ?? 0);
    const intAdjSig =
      (params.interiorMirror.yawOffsetRad ?? 0) * 100 +
      (params.interiorMirror.pitchOffsetRad ?? 0) * 10;

    const leftDue =
      wantLeft &&
      (this.leftMirrorMaterial.uniforms.uLiveEnabled.value < 0.5 ||
        Math.abs(leftAdjSig - this.lastLeftMirrorAdjustSig) > 1e-4 ||
        nowMs - this.lastLeftMirrorMs >= mirrorMinIntervalMs);
    const rightDue =
      wantRight &&
      (this.rightMirrorMaterial.uniforms.uLiveEnabled.value < 0.5 ||
        Math.abs(rightAdjSig - this.lastRightMirrorAdjustSig) > 1e-4 ||
        nowMs - this.lastRightMirrorMs >= mirrorMinIntervalMs);
    const interiorDue =
      wantInterior &&
      (this.interiorMirrorMaterial.uniforms.uLiveEnabled.value < 0.5 ||
        Math.abs(intAdjSig - this.lastInteriorMirrorAdjustSig) > 1e-4 ||
        nowMs - this.lastInteriorMirrorMs >= mirrorMinIntervalMs);

    if (leftMirror.detached) {
      this.leftMirrorMaterial.uniforms.uLiveEnabled.value = 0.0;
    }
    if (rightMirror.detached) {
      this.rightMirrorMaterial.uniforms.uLiveEnabled.value = 0.0;
    }

    if (!shouldUpdateCube && !leftDue && !rightDue && !interiorDue) {
      if (!isCockpit && this.leftMirrorRT && !leftMirror.detached && this.quality !== 'low') {
        this.interiorMirrorMaterial.uniforms.uMirrorTex.value = this.leftMirrorRT.texture;
        this.interiorMirrorMaterial.uniforms.uMirrorUvScale.value.copy(
          this.leftMirrorMaterial.uniforms.uMirrorUvScale.value,
        );
        this.interiorMirrorMaterial.uniforms.uLiveEnabled.value = 1.0;
      }
      return;
    }

    // Save renderer state
    const prevRT = renderer.getRenderTarget();
    const prevCubeFace = renderer.getActiveCubeFace();
    const prevMipLevel = renderer.getActiveMipmapLevel();
    const prevShadowAutoUpdate = renderer.shadowMap.autoUpdate;

    renderer.shadowMap.autoUpdate = false;

    // === 1. DOUBLE-BUFFERED HARDWARE-MIPMAPPED LINEAR HDR CUBEMAP PROBE ===
    if (shouldUpdateCube && writeRT && writeCam) {
      // Dirty-checked adaptive CubeCamera far plane on writeCam
      if (Math.abs(this.currentCubeFar[writeIdx] - reflLod.cubeFar) > 1.0) {
        this.currentCubeFar[writeIdx] = reflLod.cubeFar;
        const cams = writeCam.children as THREE.PerspectiveCamera[];
        for (let i = 0; i < cams.length; i++) {
          cams[i].far = reflLod.cubeFar;
          cams[i].updateProjectionMatrix();
        }
      }

      if (cubeDecision.action === 'prime' || cubeDecision.action === 'slice') {
        setLinearHdrOutput(true);
        _probeWorldPos.set(
          cubeDecision.captureX,
          cubeDecision.captureY,
          cubeDecision.captureZ,
        );
        writeCam.position.copy(_probeWorldPos);
        writeCam.updateMatrixWorld(true);
        if (writeCam.coordinateSystem !== renderer.coordinateSystem) {
          writeCam.coordinateSystem = renderer.coordinateSystem;
          writeCam.updateCoordinateSystem();
        }

        const prevVehVis = vehicleRoot.visible;
        vehicleRoot.visible = false;

        if (cubeDecision.action === 'prime') {
          writeRT.texture.mipmapsAutoUpdate = true;
          writeCam.update(renderer, scene);
        } else {
          const cameras = writeCam.children as THREE.PerspectiveCamera[];
          writeRT.texture.mipmapsAutoUpdate = false;
          for (let f = 0; f < cubeDecision.faceCount; f++) {
            const faceIdx = cubeDecision.faceStart + f;
            if (faceIdx === 5) {
              // Generate complete hardware mipmaps across all 6 faces cleanly once the final face finishes!
              writeRT.texture.mipmapsAutoUpdate = true;
            }
            renderer.setRenderTarget(writeRT, faceIdx, 0);
            renderer.render(scene, cameras[faceIdx]);
          }
          writeRT.texture.mipmapsAutoUpdate = true;
        }

        vehicleRoot.visible = prevVehVis;
      }

      const publishedNow = this.cubeScheduler.commit(schedIn, cubeDecision);
      if (publishedNow) {
        if (hasDoubleBuffer) {
          this.cubeReadIdx = writeIdx;
        }
        const readRT = this.cubeRTs[this.cubeReadIdx]!;
        this.sharedUniforms.uEnvCubeRaw.value = readRT.texture;
        this.sharedUniforms.uHasRawCube.value = 1.0;
        this.syncPublishedProbeUniforms();
      }

      const readRT = this.cubeRTs[this.cubeReadIdx];
      if (readRT && (cubeDecision.shouldBakePmrem || !this.pmremRT)) {
        if (!this.pmremGenerator) {
          this.pmremGenerator = new THREE.PMREMGenerator(renderer);
          this.pmremGenerator.compileCubemapShader();
        }
        const prevToneMapping = renderer.toneMapping;
        renderer.toneMapping = THREE.NoToneMapping;
        this.pmremRT = this.pmremGenerator.fromCubemap(readRT.texture, this.pmremRT);
        renderer.toneMapping = prevToneMapping;
      }
    }

    // === 2. REAL-TIME WING MIRRORS + DEDICATED CENTRAL INTERIOR REARVIEW MIRROR ===
    if (leftDue || rightDue || interiorDue) {
      // Match mirror capture color space to mirror render target type (HalfFloat on Hybrid/Ultra, UnsignedByte on Low)
      setLinearHdrOutput(this.quality !== 'low');
      this.ensureMirrorTargets();

      const desiredMirrorFar = Math.min(budget.mirrorFar, reflLod.mirrorFar);
      if (Math.abs(this.currentMirrorFar - desiredMirrorFar) > 1.0) {
        this.currentMirrorFar = desiredMirrorFar;
        this.leftMirrorCam.far = desiredMirrorFar;
        this.leftMirrorCam.updateProjectionMatrix();
        this.rightMirrorCam.far = desiredMirrorFar;
        this.rightMirrorCam.updateProjectionMatrix();
        this.interiorMirrorCam.far = desiredMirrorFar;
        this.interiorMirrorCam.updateProjectionMatrix();
      }

      const canRenderLeft = leftDue && this.leftMirrorRT !== null;
      const canRenderRight = rightDue && this.rightMirrorRT !== null;
      const canRenderInterior = interiorDue && this.interiorMirrorRT !== null;

      const renderBoth = !budget.interleaveCockpitMirrors;
      // In Hybrid/Low cockpit mode, interleave Left Wing Mirror & Central Interior Mirror (1 mirror pass/frame)
      // while priming BOTH on first cockpit frames so neither ever shows blank glass!
      const renderLeftNow =
        canRenderLeft &&
        (renderBoth ||
          (isCockpit &&
            (this.mirrorToggleParity === 0 ||
              !canRenderInterior ||
              this.leftMirrorMaterial.uniforms.uLiveEnabled.value < 0.5)) ||
          (!isCockpit && (this.mirrorToggleParity === 0 || !canRenderRight)));
      const renderInteriorNow =
        canRenderInterior &&
        (renderBoth ||
          this.mirrorToggleParity === 1 ||
          !canRenderLeft ||
          this.interiorMirrorMaterial.uniforms.uLiveEnabled.value < 0.5);
      const renderRightNow =
        canRenderRight &&
        (renderBoth || (!isCockpit && (this.mirrorToggleParity === 1 || !canRenderLeft)));
      this.mirrorToggleParity = 1 - this.mirrorToggleParity;

      const vpScale = reflLod.mirrorViewportScale;

      if (renderLeftNow && this.leftMirrorRT) {
        this.leftMirrorMaterial.uniforms.uMirrorTex.value = this.fallbackTex;
        // Frame metallic red Raptor rear flank in inner third + wet rural road & eucalyptus trees in outer two-thirds!
        this.renderSingleMirror(
          renderer,
          scene,
          this.leftMirrorCam,
          this.leftMirrorRT,
          this.leftMirrorMaterial,
          leftMirror,
          0.16,
          vpScale,
        );
        this.leftMirrorMaterial.uniforms.uMirrorTex.value = this.leftMirrorRT.texture;
        this.leftMirrorMaterial.uniforms.uLiveEnabled.value = 1.0;
        this.lastLeftMirrorMs = nowMs;
        this.lastLeftMirrorAdjustSig = leftAdjSig;
        this.mirrorsRenderedThisFrame++;
      }

      if (renderInteriorNow && this.interiorMirrorRT) {
        this.interiorMirrorMaterial.uniforms.uMirrorTex.value = this.fallbackTex;
        this.renderInteriorMirror(
          renderer,
          scene,
          this.interiorMirrorCam,
          this.interiorMirrorRT,
          this.interiorMirrorMaterial,
          params.interiorMirror,
          vpScale,
        );
        this.interiorMirrorMaterial.uniforms.uMirrorTex.value = this.interiorMirrorRT.texture;
        this.interiorMirrorMaterial.uniforms.uLiveEnabled.value = 1.0;
        this.lastInteriorMirrorMs = nowMs;
        this.lastInteriorMirrorAdjustSig = intAdjSig;
        this.mirrorsRenderedThisFrame++;
      } else if (!isCockpit && this.leftMirrorRT && !leftMirror.detached && this.quality !== 'low') {
        this.interiorMirrorMaterial.uniforms.uMirrorTex.value = this.leftMirrorRT.texture;
        this.interiorMirrorMaterial.uniforms.uMirrorUvScale.value.copy(
          this.leftMirrorMaterial.uniforms.uMirrorUvScale.value,
        );
        this.interiorMirrorMaterial.uniforms.uLiveEnabled.value = 1.0;
      }

      if (renderRightNow && this.rightMirrorRT) {
        this.rightMirrorMaterial.uniforms.uMirrorTex.value = this.fallbackTex;
        this.renderSingleMirror(
          renderer,
          scene,
          this.rightMirrorCam,
          this.rightMirrorRT,
          this.rightMirrorMaterial,
          rightMirror,
          -0.06,
          vpScale,
        );
        this.rightMirrorMaterial.uniforms.uMirrorTex.value = this.rightMirrorRT.texture;
        this.rightMirrorMaterial.uniforms.uLiveEnabled.value = 1.0;
        this.lastRightMirrorMs = nowMs;
        this.lastRightMirrorAdjustSig = rightAdjSig;
        this.mirrorsRenderedThisFrame++;
      }
    }

    // Restore renderer state cleanly
    renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
    setLinearHdrOutput(restoreLinearHdr);
    renderer.setRenderTarget(prevRT, prevCubeFace, prevMipLevel);
  }

  private isMirrorRelevant(
    mainCamera: THREE.PerspectiveCamera,
    anchor: MirrorAnchorInfo,
  ): boolean {
    const budget = getGraphicsQualityBudget(this.quality, this.isMobile, this.isSoftwareGl);
    const maxDist = budget.mirrorMaxExteriorDist;
    if (maxDist <= 0.1) return false;
    _camToMirror.subVectors(mainCamera.position, anchor.worldPos);
    const distSq = _camToMirror.lengthSq();
    if (distSq > maxDist * maxDist) return false;
    // Mirror lens faces backward (-worldForward); render if main camera is generally behind or beside it
    const dist = Math.sqrt(Math.max(distSq, 1e-4));
    const rearFacingDot = _camToMirror.dot(anchor.worldForward) / dist;
    return rearFacingDot < 0.35;
  }

  private applyMirrorViewportScale(
    target: THREE.WebGLRenderTarget,
    material: THREE.ShaderMaterial,
    viewportScale: number,
  ): void {
    const s = Math.max(0.45, Math.min(1.0, viewportScale));
    const w = Math.max(32, Math.min(target.width, Math.round(target.width * s)));
    const h = Math.max(24, Math.min(target.height, Math.round(target.height * s)));
    target.viewport.set(0, 0, w, h);
    material.uniforms.uMirrorUvScale.value.set(w / target.width, h / target.height);
  }

  private renderSingleMirror(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    mirrorCam: THREE.PerspectiveCamera,
    target: THREE.WebGLRenderTarget,
    material: THREE.ShaderMaterial,
    anchor: MirrorAnchorInfo,
    outwardBias: number,
    viewportScale: number,
  ): void {
    const yawOff = anchor.yawOffsetRad ?? 0;
    const pitchOff = anchor.pitchOffsetRad ?? 0;
    const fold = anchor.fold01 ?? 0;
    const sideSign = outwardBias >= 0 ? 1 : -1;
    // Folding swings mirror gaze inward toward cabin/door; manual yaw/pitch pans & tilts reflection!
    const totalYaw = outwardBias * 0.85 + yawOff - sideSign * fold * 1.05;
    const totalPitch = -0.055 + pitchOff;

    // Place camera cleanly behind the wing mirror housing looking backward along the crimson flank & wet road
    mirrorCam.position
      .copy(anchor.worldPos)
      .addScaledVector(anchor.worldForward, -0.22)
      .addScaledVector(anchor.worldRight, outwardBias * 0.72)
      .addScaledVector(anchor.worldUp, 0.04);

    const cosY = Math.cos(totalYaw);
    const sinY = Math.sin(totalYaw);
    const cosP = Math.cos(totalPitch);
    const sinP = Math.sin(totalPitch);
    const dist = 18.0;

    _mirrorTarget
      .copy(mirrorCam.position)
      .addScaledVector(anchor.worldForward, -cosY * cosP * dist)
      .addScaledVector(anchor.worldRight, sinY * cosP * dist)
      .addScaledVector(anchor.worldUp, sinP * dist);

    mirrorCam.up.copy(anchor.worldUp);
    mirrorCam.lookAt(_mirrorTarget);
    mirrorCam.updateMatrixWorld(true);

    this.applyMirrorViewportScale(target, material, viewportScale);
    renderer.setRenderTarget(target);
    renderer.render(scene, mirrorCam);
  }

  private renderInteriorMirror(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    mirrorCam: THREE.PerspectiveCamera,
    target: THREE.WebGLRenderTarget,
    material: THREE.ShaderMaterial,
    anchor: MirrorAnchorInfo,
    viewportScale: number,
  ): void {
    const yawOff = anchor.yawOffsetRad ?? 0;
    const pitchOff = anchor.pitchOffsetRad ?? 0;
    const totalPitch = -0.012 + pitchOff;

    // Place rear-view camera cleanly behind rear cab window (z ≈ -1.34) looking backward over Rivian bed & road behind
    mirrorCam.position
      .copy(anchor.worldPos)
      .addScaledVector(anchor.worldForward, -1.95)
      .addScaledVector(anchor.worldUp, -0.04);

    const cosY = Math.cos(yawOff);
    const sinY = Math.sin(yawOff);
    const cosP = Math.cos(totalPitch);
    const sinP = Math.sin(totalPitch);
    const dist = 22.0;

    _mirrorTarget
      .copy(mirrorCam.position)
      .addScaledVector(anchor.worldForward, -cosY * cosP * dist)
      .addScaledVector(anchor.worldRight, sinY * cosP * dist)
      .addScaledVector(anchor.worldUp, sinP * dist);

    mirrorCam.up.copy(anchor.worldUp);
    mirrorCam.lookAt(_mirrorTarget);
    mirrorCam.updateMatrixWorld(true);

    this.applyMirrorViewportScale(target, material, viewportScale);
    renderer.setRenderTarget(target);
    renderer.render(scene, mirrorCam);
  }

  private syncPublishedProbeUniforms(): void {
    const s = this.cubeScheduler;
    const bounds = computeBiomeReflectionBoundsInto(
      s.publishedBiome,
      s.publishedX,
      s.publishedGroundY,
      s.publishedZ,
      _boundsScratch,
    );
    this.sharedUniforms.uCubeCenter.value.set(s.publishedX, s.publishedY, s.publishedZ);
    this.sharedUniforms.uCubeBoxMin.value.set(bounds.minX, bounds.minY, bounds.minZ);
    this.sharedUniforms.uCubeBoxMax.value.set(bounds.maxX, bounds.maxY, bounds.maxZ);
    this.sharedUniforms.uCubeBoxHalf.value.set(
      (bounds.maxX - bounds.minX) * 0.5,
      (bounds.maxY - bounds.minY) * 0.5,
      (bounds.maxZ - bounds.minZ) * 0.5,
    );
  }

  public dispose(): void {
    for (let i = 0; i < 2; i++) {
      const rt = this.cubeRTs[i];
      if (rt) {
        rt.dispose();
        this.cubeRTs[i] = null;
      }
      this.cubeCameras[i] = null;
    }
    if (this.pmremRT) {
      this.pmremRT.dispose();
      this.pmremRT = null;
    }
    if (this.pmremGenerator) {
      this.pmremGenerator.dispose();
      this.pmremGenerator = null;
    }
    if (this.leftMirrorRT) {
      this.leftMirrorRT.dispose();
      this.leftMirrorRT = null;
    }
    if (this.rightMirrorRT) {
      this.rightMirrorRT.dispose();
      this.rightMirrorRT = null;
    }
    if (this.interiorMirrorRT) {
      this.interiorMirrorRT.dispose();
      this.interiorMirrorRT = null;
    }
    this.leftMirrorMaterial.dispose();
    this.rightMirrorMaterial.dispose();
    this.interiorMirrorMaterial.dispose();
    this.fallbackTex.dispose();
  }
}
