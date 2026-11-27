/**
 * WebSandAdapter.ts
 * WebGL2 / Three.js production prototype adapter for the portable `sand-engine/`.
 *
 * Manages:
 *  - 2 x 512x512 RGBA16F toroidal ping-pong render targets (8 MB VRAM total)
 *  - Zero-copy 64-byte SandBrush DataTexture upload (4 x 64 RGBA FloatType)
 *  - 30 Hz amortized anisotropic 33° avalanche + wind infill + per-cascade Auto-Sleep
 *  - 1-draw-call Nested-Ring Geometry Clipmap + Shadow Cascade 0 vertex displacement
 *  - GPU circular ring buffers for 4,096 ballistic roost grains + 240 dust plumes
 *  - 1 Desert Baja Rally Buggy + 4 Foot-IK Desert Runners (Marco 6 benchmark)
 *  - EXT_disjoint_timer_query_webgl2 GPU timing + CPU terramechanics timing
 *  - Software-WebGL (`isSoftwareGl`) detection & fenceSync `afterDraw()` pacing
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  CameraMode,
  computeEffectivePixelRatio,
  DEFAULT_RUNTIME_CONFIG,
  detectIsMobileDevice,
  GraphicsQuality,
  SAND_DEFAULTS,
  SandRuntimeConfig,
  WEATHER_PRESET_SPECS,
} from '../core/SandParams';
import {
  BootProgressState,
  computeUnifiedBootProgress,
} from '../core/AppRuntimeMode';
import { getGraphicsQualityBudget } from '../core/GraphicsQualityBudget';
import sandGrainAlbedoUrl from '../../assets/images/sand_grain_albedo_1795181775275.jpg';
import sandMacroAlbedoUrl from '../../assets/images/desert_sand_ripples_albedo_1795187181939.jpg';
import { ToroidalCascade } from '../core/ToroidalCascade';
import { BrushEncoder } from '../core/BrushEncoder';
import { SandTerramechanics } from '../core/SandTerramechanics';
import { SleepController } from '../core/SleepController';
import { sampleTerrainHeightForBiome } from '../core/TerrainHeightfield';
import { sampleClimbableRockSurface } from '../core/DesertObstacles';
import {
  computePortraitCameraAdjust,
  EMPTY_VEHICLE_INPUT,
  EMPTY_VIRTUAL_FLAGS,
  getNextCameraMode,
  VehicleControlInput,
  VirtualControlFlags,
} from '../core/VehicleDriveModel';
import { ensureMeshBvhPatched } from './MeshBvhSetup';
import {
  CockpitRuntimeState,
  createInitialCockpitState,
  cycleHeadlightMode,
  cycleWiperMode,
  handleCabinSwitchAction,
  handleSyncScreenTouchUV,
  stepCockpitState,
} from '../core/CockpitStateModel';
import { CockpitDisplayRenderer } from './CockpitDisplayRenderer';

import { SIM_STEP_FRAG, SIM_STEP_VERT } from '../shaders/passSimStep';
import {
  TERRAIN_CLIPMAP_VERT,
  TERRAIN_SHADOW_FRAG,
  TERRAIN_SHADOW_VERT,
} from '../shaders/terrainClipmap';
import { TERRAIN_SAND_FRAG } from '../shaders/terrainSand';
import {
  ROOST_PARTICLES_FRAG,
  ROOST_PARTICLES_VERT,
  SPARK_PARTICLES_FRAG,
  SPARK_PARTICLES_VERT,
} from '../shaders/particlesRoost';
import { SmokeLayerType } from '../core/SmokePhysics';

import { buildNestedRingClipmap, ClipmapStats } from './ClipmapGeometry';
import {
  VehicleCrashAudioSignal,
  VehicleInput,
  VehicleRig,
  VehicleSmokeSignal,
  VehicleSparkSignal,
  VehicleTelemetry,
} from './VehicleRig';
import { preloadRivianGlb } from './RivianVehicleBuilder';
import {
  getRivianLoadSnapshot,
  RivianPreloadProgress,
  subscribeRivianLoadProgress,
} from './rivianAssetPreload';
import { RunnerRig } from './RunnerRig';
import { createDesertEnvironment, DesertLightingRig } from './DesertEnvironment';
import {
  VolumetricPuffParams,
  VolumetricSmokeSystem,
} from './VolumetricSmokeSystem';
import type { GrassUpdateParams } from './GrassFieldSystem';
import type { RainyHighwayUpdateParams } from './RainyHighwayEnvironment';
import { VehicleAudioEngine, VehicleAudioState } from './VehicleAudioEngine';
import {
  CABIN_INTERIOR_LAYER,
  ENV_DETAIL_EXCLUDED_LAYER,
  MirrorAnchorInfo,
  VehicleReflectionSystem,
  VehicleReflectionUpdateParams,
} from './VehicleReflectionSystem';
import {
  PostProcessingPipeline,
  PostProcessRenderParams,
} from './PostProcessingPipeline';
import { generateMudDetailTexture } from '../core/MudTextureGenerator';
import { CockpitDisplayTelemetry } from './CockpitDisplayRenderer';
import {
  PerformanceFrameInput,
  PerformanceMonitor,
  PerformanceSnapshot,
} from '../core/PerformanceMonitor';
import {
  FramePacingGovernor,
  FramePacingSample,
  GpuTimerQueryScheduler,
  InFlightFenceLimiter,
} from '../core/FramePacingGovernor';
import {
  ShadowScheduleInput,
  ShadowUpdateScheduler,
} from '../core/ShadowUpdateScheduler';
import {
  FarShadowCascadeScheduler,
  FarShadowScheduleInput,
} from '../core/DistanceLodPolicy';

export interface SandEngineTelemetry {
  fps: number;
  fpsUncapped: boolean;
  perf: PerformanceSnapshot;
  cpuPhysicsMs: number;
  gpuSimMs: number;
  gpuTotalMs: number;
  gpuQuerySupported: boolean;
  isSoftwareGl: boolean;
  graphicsQuality: GraphicsQuality;
  mirrorsActive: number;
  probeMode: string;
  postProcessingActive: boolean;
  activeBrushes: number;
  activeTracksInRing: number;
  ringBufferCapacity: number;
  cascadeResolution: number;
  cascade0Sleeping: boolean;
  cascade1Sleeping: boolean;
  cascade0Origin: [number, number];
  cascade1Origin: [number, number];
  vramMB: number;
  clipmapStats: ClipmapStats;
  vehicle: VehicleTelemetry;
  avgFootSinkageCm: number;
  activeInput: VehicleControlInput;
  vehiclePos: [number, number];
}

interface CascadeGpuPair {
  cascade: ToroidalCascade;
  sleep: SleepController;
  rtA: THREE.WebGLRenderTarget;
  rtB: THREE.WebGLRenderTarget;
  readIsA: boolean;
  tickParity: number;
}

class GpuParticleRing {
  public readonly points: THREE.Points;
  public readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly capacity: number;
  private readonly origins: Float32Array;
  private readonly velocities: Float32Array;
  private readonly params: Float32Array;
  private head = 0;
  private dirtyStart = -1;
  private dirtyCount = 0;
  private readonly originAttr: THREE.BufferAttribute;
  private readonly velocityAttr: THREE.BufferAttribute;
  private readonly paramsAttr: THREE.BufferAttribute;

  constructor(
    capacity: number,
    vertexShader: string,
    fragmentShader: string,
    uniforms: Record<string, THREE.IUniform>,
    blending: THREE.Blending = THREE.NormalBlending,
  ) {
    this.capacity = capacity;
    this.origins = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);
    const dummyPos = new Float32Array(capacity * 3);

    // Initialize spawnTime far in the past so unallocated slots stay culled
    for (let i = 0; i < capacity; i++) {
      this.params[i * 4 + 0] = -1000;
      this.params[i * 4 + 1] = 0.01;
    }

    this.originAttr = new THREE.BufferAttribute(this.origins, 3);
    this.originAttr.setUsage(THREE.DynamicDrawUsage);
    this.velocityAttr = new THREE.BufferAttribute(this.velocities, 3);
    this.velocityAttr.setUsage(THREE.DynamicDrawUsage);
    this.paramsAttr = new THREE.BufferAttribute(this.params, 4);
    this.paramsAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(dummyPos, 3));
    this.geometry.setAttribute('aOrigin', this.originAttr);
    this.geometry.setAttribute('aVelocity', this.velocityAttr);
    this.geometry.setAttribute('aParams', this.paramsAttr);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000);

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms,
      transparent: true,
      depthWrite: false,
      blending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.updateMatrix();
    this.points.visible = false;
    this.points.renderOrder = 2;
  }

  private maxExpireTime = -1;

  public emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    spawnTime: number,
    lifetime: number,
    size: number,
  ): void {
    const i = this.head;
    if (this.dirtyCount === 0) {
      this.dirtyStart = i;
    }
    this.dirtyCount = Math.min(this.capacity, this.dirtyCount + 1);
    this.head = (this.head + 1) % this.capacity;

    const i3 = i * 3;
    const i4 = i * 4;
    this.origins[i3 + 0] = x;
    this.origins[i3 + 1] = y;
    this.origins[i3 + 2] = z;

    this.velocities[i3 + 0] = vx;
    this.velocities[i3 + 1] = vy;
    this.velocities[i3 + 2] = vz;

    this.params[i4 + 0] = spawnTime;
    this.params[i4 + 1] = lifetime;
    this.params[i4 + 2] = size;
    this.params[i4 + 3] = Math.random();

    const expire = spawnTime + lifetime;
    if (expire > this.maxExpireTime) {
      this.maxExpireTime = expire;
    }
    this.points.visible = true;
  }

  public syncVisibility(currentTime: number): void {
    this.points.visible = currentTime <= this.maxExpireTime;
  }

  private addRingRanges(attr: THREE.BufferAttribute, stride: number, start: number, count: number): void {
    attr.clearUpdateRanges();
    if (count >= this.capacity) {
      attr.addUpdateRange(0, this.capacity * stride);
    } else if (start + count <= this.capacity) {
      attr.addUpdateRange(start * stride, count * stride);
    } else {
      const firstLen = this.capacity - start;
      const secondLen = count - firstLen;
      attr.addUpdateRange(start * stride, firstLen * stride);
      attr.addUpdateRange(0, secondLen * stride);
    }
    attr.needsUpdate = true;
  }

  public flush(): void {
    if (this.dirtyCount <= 0) return;
    const start = this.dirtyStart >= 0 ? this.dirtyStart : 0;
    const count = this.dirtyCount;
    this.addRingRanges(this.originAttr, 3, start, count);
    this.addRingRanges(this.velocityAttr, 3, start, count);
    this.addRingRanges(this.paramsAttr, 4, start, count);
    this.dirtyStart = -1;
    this.dirtyCount = 0;
  }

  public clear(): void {
    for (let i = 0; i < this.capacity; i++) {
      this.params[i * 4 + 0] = -1000;
    }
    this.dirtyStart = 0;
    this.dirtyCount = this.capacity;
    this.maxExpireTime = -1;
    this.points.visible = false;
    this.flush();
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function detectSoftwareGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

// Pre-allocated scratch vectors (zero GC in render loop)
const _camDesiredPos = new THREE.Vector3();
const _camDesiredTarget = new THREE.Vector3();
const _camCurrentTarget = new THREE.Vector3();
const _camUp = new THREE.Vector3(0, 1, 0);
const _vehFwd = new THREE.Vector3();
const _wheelFocus = new THREE.Vector3();
const _footFocus = new THREE.Vector3();
const _followDelta = new THREE.Vector3();
const _windDirVec = new THREE.Vector2();
const _shadowBiasMat = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
);
const _shadowProjView = new THREE.Matrix4();
const _leftMirrorAnchor: MirrorAnchorInfo = {
  worldPos: new THREE.Vector3(),
  worldForward: new THREE.Vector3(0, 0, 1),
  worldRight: new THREE.Vector3(1, 0, 0),
  worldUp: new THREE.Vector3(0, 1, 0),
  detached: false,
};
const _rightMirrorAnchor: MirrorAnchorInfo = {
  worldPos: new THREE.Vector3(),
  worldForward: new THREE.Vector3(0, 0, 1),
  worldRight: new THREE.Vector3(1, 0, 0),
  worldUp: new THREE.Vector3(0, 1, 0),
  detached: false,
};
const _interiorMirrorAnchor: MirrorAnchorInfo = {
  worldPos: new THREE.Vector3(),
  worldForward: new THREE.Vector3(0, 0, 1),
  worldRight: new THREE.Vector3(1, 0, 0),
  worldUp: new THREE.Vector3(0, 1, 0),
  detached: false,
};

export class WebSandAdapter {
  private readonly container: HTMLElement;
  private readonly isSoftwareGl: boolean;
  private readonly isMobile: boolean;
  private readonly cascadeResolution: number;
  private readonly cascadeVramMB: number;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly lighting: DesertLightingRig;

  private readonly simScene: THREE.Scene;
  private readonly simCamera: THREE.OrthographicCamera;
  private readonly simQuadGeo: THREE.PlaneGeometry;
  private readonly simMaterial: THREE.ShaderMaterial;

  private readonly cascade0: CascadeGpuPair;
  private readonly cascade1: CascadeGpuPair;
  private readonly brushEncoder: BrushEncoder;
  private readonly brushTex: THREE.DataTexture;
  private readonly terramechanics: SandTerramechanics;

  private readonly clipmapGeo: THREE.BufferGeometry;
  private readonly clipmapStats: ClipmapStats;
  private readonly terrainMaterial: THREE.ShaderMaterial;
  private readonly terrainDepthMaterial: THREE.ShaderMaterial;
  private readonly terrainMesh: THREE.Mesh;
  private readonly shadowFallbackRT: THREE.WebGLRenderTarget;

  private readonly reflections: VehicleReflectionSystem;
  private readonly postProcessing: PostProcessingPipeline;
  private readonly vehicle: VehicleRig;
  private readonly runners: RunnerRig[];
  private readonly roostParticles: GpuParticleRing;
  private readonly sparkParticles: GpuParticleRing;
  private readonly smokeSystem: VolumetricSmokeSystem;
  private readonly audio: VehicleAudioEngine;
  private readonly cockpitState: CockpitRuntimeState = createInitialCockpitState();
  private readonly cockpitDisplays: CockpitDisplayRenderer = new CockpitDisplayRenderer();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly cockpitRaycastTargets: THREE.Object3D[] = [];
  private readonly cockpitSwitchMeshes: THREE.Object3D[] = [];
  private cachedCanvasRect: DOMRect | null = null;
  private lastCockpitHoverMs = 0;
  private cockpitPointerDown = false;
  private cockpitPointerDragged = false;
  private cockpitDownX = 0;
  private cockpitDownY = 0;

  private config: SandRuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG };
  private readonly keysPressed = new Set<string>();
  private virtualFlags: VirtualControlFlags = { ...EMPTY_VIRTUAL_FLAGS };
  private lastActiveInput: VehicleControlInput = { ...EMPTY_VEHICLE_INPUT };
  private onTelemetry?: (t: SandEngineTelemetry) => void;
  private onManualOverride?: () => void;
  private onCameraCycle?: (next: CameraMode) => void;
  private onConfigSync?: (patch: Partial<SandRuntimeConfig>) => void;
  private onBootProgress?: (progress: BootProgressState) => void;

  private readonly frameTimer = new THREE.Timer();
  private readonly perfMonitor = new PerformanceMonitor(240);
  private readonly shadowScheduler = new ShadowUpdateScheduler();
  private readonly farShadowScheduler = new FarShadowCascadeScheduler(12.0, 120.0);
  private shadowNeedsRenderThisFrame = true;
  private farShadowNeedsRenderThisFrame = true;
  private lastBoundShadowTex: THREE.Texture | null = null;
  private lastBoundFarShadowTex: THREE.Texture | null = null;
  private lastLinearHdrOutput: boolean | null = null;
  private sceneGeometryDynamicThisFrame = true;
  private lastGtaoVehX = NaN;
  private lastGtaoVehY = NaN;
  private lastGtaoVehZ = NaN;
  private lastGtaoHeading = NaN;
  private frameHandle = 0;
  private uncapChannel: MessageChannel | null = null;
  private uncapScheduled = false;
  private lastTickWallMs = 0;
  private disposed = false;
  private sandTexturesRequested = false;
  private mudDetailBaked = false;
  private readonly bootStartWallMs = performance.now();
  private vehicleLoadedWallMs: number | null = null;
  private sceneReady = false;
  private vehicleReady = false;
  private loopStarted = false;
  private bootLoadError: string | null = null;
  private latestPreloadProgress: RivianPreloadProgress = getRivianLoadSnapshot();
  private unsubscribePreload: (() => void) | null = null;
  private isWarmupStep = false;
  private currentShadowExtent = 18;
  private userFreeCameraActive = false;
  private readonly prevFollowPos = new THREE.Vector3();
  private hasPrevFollowPos = false;
  private simTime = 0;
  private relaxAccum = 0;
  private relaxAltCascade = 0;
  private telemetryAccum = 0;
  private fpsSmoothed = 60;
  private cpuPhysicsSmoothedMs = 0.08;
  private gpuSimSmoothedMs = 0;
  private gpuTotalSmoothedMs = 0;
  private lastActiveBrushes = 0;
  private lastAvgFootSinkCm = 3.2;
  private lastVehicleTelemetry: VehicleTelemetry = {
    speedKmh: 0,
    avgSinkageCm: 0.0,
    maxSinkageCm: 0.0,
    avgSlipRatio: 0,
    trackCompactionPct: 0,
    rollingDragN: 0,
    bulldozingN: 0,
    driftAngleDeg: 0,
    gear: 'N',
    rpm: 920,
    boostActive: false,
    braking: false,
    integrityPct: 100,
    rollDeg: 0,
    isTipping: false,
    isRolledOver: false,
    rollCount: 0,
    detachedCount: 0,
    windshieldCrackLevel: 0,
  };

  // Pre-allocated scratch payloads to eliminate per-frame GC allocations in stepSimulation / updateCameraAndUniforms
  private readonly smokePuffScratch: VolumetricPuffParams = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    spawnTime: 0,
    lifetime: 1,
    baseSize: 0.5,
    type: SmokeLayerType.DesertDust,
    opacity: 0.5,
    growthMult: 1,
    spinRate: 0,
  };
  private readonly audioStateScratch: VehicleAudioState = {
    rpm: 920,
    throttle: 0,
    speedMs: 0,
    avgSinkageM: 0,
    avgSlip: 0,
    driftDeg: 0,
    boostActive: false,
    windSpeed: 0,
    biome: 'rainy_highway',
    isLowRange: false,
    cabinMusicPlaying: false,
    cabinMediaSource: 'spotify',
    cabinTrackIndex: 0,
    isCockpitView: false,
    engineHealth01: 1,
  };
  private readonly cockpitStepInputScratch = {
    speedMs: 0,
    accelForwardMs2: 0,
    lateralG: 0,
    rainIntensity: 0,
    suspensionBump: 0,
    wiperDamaged: false,
    ambientTempC: 11,
  };
  private readonly cockpitDisplayTelScratch: CockpitDisplayTelemetry = {
    speedKmh: 0,
    rpm: 700,
    gear: '1',
    driveMode: '4H',
    biome: 'rainy_highway',
    pitchDeg: 0,
    rollDeg: 0,
    damage: null as unknown as CockpitDisplayTelemetry['damage'],
    timeSec: 0,
  };
  private readonly manualInputScratch: VehicleControlInput = {
    throttle: 0,
    steer: 0,
    handbrake: false,
    boost: false,
  };
  private readonly activeInputTelemetryScratch: VehicleControlInput = {
    throttle: 0,
    steer: 0,
    handbrake: false,
    boost: false,
  };
  private readonly runnerLodConfigScratch = {
    focusX: 0,
    focusZ: 0,
    isFocus: false,
    visible: false,
  };
  private grassParamsScratch!: GrassUpdateParams;
  private rainyCorridorParamsScratch!: RainyHighwayUpdateParams;
  private smokeEnvScratch!: Parameters<VolumetricSmokeSystem['syncEnvironment']>[0];
  private reflectionUpdateScratch!: VehicleReflectionUpdateParams;
  private postProcessParamsScratch!: PostProcessRenderParams;
  private readonly shadowScheduleScratch: ShadowScheduleInput = {
    nowMs: 0,
    vehicleX: 0,
    vehicleY: 0,
    vehicleZ: 0,
    vehicleFwdX: 0,
    vehicleFwdY: 0,
    vehicleFwdZ: 1,
    vehicleSpeedMs: 0,
    sunDirX: 0,
    sunDirY: 1,
    sunDirZ: 0,
    hasMovingRunners: false,
    hasActiveDebris: false,
    forceImmediate: false,
  };
  private readonly farShadowScheduleScratch: FarShadowScheduleInput = {
    nowMs: 0,
    focusX: 0,
    focusZ: 0,
    sunDirX: 0,
    sunDirY: 1,
    sunDirZ: 0,
    forceImmediate: false,
  };
  private readonly sleepInputScratch = {
    dt: 0.016,
    activeBrushCount: 0,
    cascadeMoved: false,
    injectedEnergy: 0,
    windSpeed: 0,
    autoSleepEnabled: true,
  };
  private readonly perfFrameScratch: PerformanceFrameInput = {
    frameDeltaMs: 16.667,
    cpuWorkMs: 0,
    jsCpuMs: 0,
    renderSubmitMs: 0,
    gpuStallMs: 0,
    gpuFrameMs: null,
    uncappedMode: false,
    gpuLoadHint: 0.5,
    bottleneck: 'balanced',
    backpressureGuarded: false,
  };
  private readonly pacingGovernor = new FramePacingGovernor();
  private readonly pacingSampleScratch: FramePacingSample = {
    frameDeltaMs: 16.667,
    jsCpuMs: 0,
    renderSubmitMs: 0,
    gpuHardwareMs: null,
    uncappedRequested: false,
    isSoftwareGl: false,
    documentHidden: false,
    graphicsQuality: 'ultra',
  };
  private readonly simQueryScheduler = new GpuTimerQueryScheduler(240, 4);
  private readonly frameQueryScheduler = new GpuTimerQueryScheduler(220, 4);
  private readonly inFlightFenceLimiter = new InFlightFenceLimiter(1);
  private uncappedFenceSync: WebGLSync | null = null;
  private currentGtaoCadence: 1 | 2 | 3 = 1;
  private lastSimRenderSubmitMs = 0;

  // Optional EXT_disjoint_timer_query_webgl2 profiling
  private timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private pendingSimQuery: WebGLQuery | null = null;
  private pendingFrameQuery: WebGLQuery | null = null;
  private pendingSandGrainTex: THREE.Texture | null = null;
  private pendingSandMacroTex: THREE.Texture | null = null;

  constructor(
    container: HTMLElement,
    initialConfig: SandRuntimeConfig,
    callbacks: {
      onTelemetry?: (t: SandEngineTelemetry) => void;
      onManualOverride?: () => void;
      onCameraCycle?: (next: CameraMode) => void;
      onConfigSync?: (patch: Partial<SandRuntimeConfig>) => void;
      onBootProgress?: (progress: BootProgressState) => void;
    },
  ) {
    this.container = container;
    this.config = { ...initialConfig };
    this.onTelemetry = callbacks.onTelemetry;
    this.onManualOverride = callbacks.onManualOverride;
    this.onCameraCycle = callbacks.onCameraCycle;
    this.onConfigSync = callbacks.onConfigSync;
    this.onBootProgress = callbacks.onBootProgress;
    this.isSoftwareGl = detectSoftwareGl();
    ensureMeshBvhPatched();
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;

    // Subscribe to t=0ms Rivian R1T download/decode stream progress
    this.unsubscribePreload = subscribeRivianLoadProgress((progress) => {
      this.latestPreloadProgress = progress;
      if (progress.errorMessage && !this.bootLoadError) {
        this.bootLoadError = progress.errorMessage;
      }
      this.emitBootProgress();
    });
    void preloadRivianGlb();

    // 1. WebGL2 Renderer with software-WebGL guard, ACES Filmic pipeline & disabled unused stencil buffer
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    const initialWidth = Math.max(1, container.clientWidth);
    const initialHeight = Math.max(1, container.clientHeight);
    const isCoarseTouch =
      typeof window !== 'undefined' &&
      Boolean(window.matchMedia?.('(pointer: coarse)').matches);
    this.isMobile =
      typeof navigator !== 'undefined' &&
      detectIsMobileDevice(
        navigator.userAgent || '',
        navigator.maxTouchPoints || 0,
        isCoarseTouch,
      );
    this.renderer.setPixelRatio(
      computeEffectivePixelRatio(
        initialWidth,
        window.devicePixelRatio || 1,
        this.isSoftwareGl,
        this.config.graphicsQuality,
      ),
    );
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setSize(initialWidth, initialHeight);
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.cursor = 'grab';
    container.appendChild(this.renderer.domElement);

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    // Ensure float/half-float FBO + linear filtering extensions are active in WebGL2
    const hasHalfFloatRender = Boolean(
      gl.getExtension('EXT_color_buffer_float') ||
        gl.getExtension('EXT_color_buffer_half_float'),
    );
    gl.getExtension('OES_texture_half_float_linear');
    gl.getExtension('OES_texture_float_linear');

    // Optional hardware GPU timestamp query (Marco 6 profiling)
    if (!this.isSoftwareGl) {
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (ext) {
        this.timerExt = ext;
      }
    }

    // Handle WebGL context loss gracefully & block long-press browser context menus on the canvas
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.addEventListener('contextmenu', this.handleCanvasContextMenu);

    // 2. Scene, Camera, OrbitControls & Desert Environment
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      54,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.15,
      1200,
    );
    this.camera.position.set(-8.5, 4.4, -10.5);
    // Main camera sees Layer 0, ENV_DETAIL_EXCLUDED_LAYER (grass/particles/rain), and CABIN_INTERIOR_LAYER
    // while CubeCamera & mirror cameras stay strictly on Layer 0!
    this.camera.layers.enable(ENV_DETAIL_EXCLUDED_LAYER);
    this.camera.layers.enable(CABIN_INTERIOR_LAYER);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.08;
    this.controls.enableRotate = true;
    this.controls.enableZoom = true;
    this.controls.enablePan = true;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 1.05;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.minDistance = 2.0;
    this.controls.maxDistance = 95;
    // Always keep OrbitControls enabled so user can freely drag/rotate/zoom immediately from frame 1!
    this.controls.enabled = true;
    this.controls.addEventListener('start', this.handleOrbitStart);
    this.controls.addEventListener('end', this.handleOrbitEnd);
    this.renderer.domElement.addEventListener('wheel', this.handleCanvasWheel, {
      passive: true,
    });

    this.lighting = createDesertEnvironment(
      this.scene,
      this.renderer,
      this.isSoftwareGl,
      this.isMobile,
    );
    this.lighting.setReflectionExcludedLayer(ENV_DETAIL_EXCLUDED_LAYER);

    // 3. Core CPU Modules (Toroidal Cascades, 64-byte BrushEncoder, Bekker Terramechanics)
    const rtType = hasHalfFloatRender ? THREE.HalfFloatType : THREE.UnsignedByteType;
    // Adaptive toroidal cascade resolution: 512² on mobile & softwareGL (8 MB), 1024² on desktop GPU (32 MB)
    const cascadeRes = this.isSoftwareGl || this.isMobile ? SAND_DEFAULTS.CASCADE_RESOLUTION : 1024;
    this.cascadeResolution = cascadeRes;
    const bytesPerTexel = rtType === THREE.HalfFloatType ? 8 : 4;
    this.cascadeVramMB = Number(
      ((2 * 2 * cascadeRes * cascadeRes * bytesPerTexel) / (1024 * 1024)).toFixed(1),
    );
    this.cascade0 = this.createCascadePair(
      SAND_DEFAULTS.CASCADE0_SIZE,
      cascadeRes,
      rtType,
    );
    this.cascade1 = this.createCascadePair(
      SAND_DEFAULTS.CASCADE1_SIZE,
      cascadeRes,
      rtType,
    );

    this.brushEncoder = new BrushEncoder(SAND_DEFAULTS.MAX_BRUSHES);
    this.brushTex = new THREE.DataTexture(
      this.brushEncoder.buffer,
      4,
      SAND_DEFAULTS.MAX_BRUSHES,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.brushTex.minFilter = THREE.NearestFilter;
    this.brushTex.magFilter = THREE.NearestFilter;
    this.brushTex.needsUpdate = true;

    this.terramechanics = new SandTerramechanics(SAND_DEFAULTS.RING_BUFFER_CAPACITY);

    // 4. Fullscreen Quad Simulation Pipeline (`pass_sim_step.frag`)
    this.simScene = new THREE.Scene();
    this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.simQuadGeo = new THREE.PlaneGeometry(2, 2);
    this.simMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SIM_STEP_VERT,
      fragmentShader: SIM_STEP_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uStateRead: { value: null },
        uBrushTex: { value: this.brushTex },
        uParentCascade: { value: this.brushTex },
        uParentOrigin: { value: new THREE.Vector2() },
        uParentSize: { value: SAND_DEFAULTS.CASCADE1_SIZE },
        uParentGuardWorld: { value: this.cascade1.cascade.guardWorldWidth },
        uHasParent: { value: 0 },
        uMinCurr: { value: new THREE.Vector2() },
        uMaxCurr: { value: new THREE.Vector2() },
        uMinPrev: { value: new THREE.Vector2() },
        uMaxPrev: { value: new THREE.Vector2() },
        uCascadeSize: { value: SAND_DEFAULTS.CASCADE0_SIZE },
        uResolution: { value: cascadeRes },
        uGuardWorld: { value: this.cascade0.cascade.guardWorldWidth },
        uMaxDepth: { value: SAND_DEFAULTS.MAX_DEPTH_METERS },
        uBrushCount: { value: 0 },
        uDoRelax: { value: 0 },
        uRelaxDt: { value: 1 / 30 },
        uTickParity: { value: 0 },
        uTanRepose: { value: SAND_DEFAULTS.TAN_ANGLE_OF_REPOSE },
        uAvalancheRate: { value: this.config.avalancheRate },
        uWindSpeed: { value: this.config.windSpeed },
        uWindDir: { value: new THREE.Vector2(0.84, 0.53) },
        uMoisture: { value: this.config.moisture },
        uBiomeMud: { value: this.config.biome === 'mud_grass' ? 1.0 : 0.0 },
      },
    });
    const simQuad = new THREE.Mesh(this.simQuadGeo, this.simMaterial);
    simQuad.matrixAutoUpdate = false;
    simQuad.updateMatrix();
    this.simScene.add(simQuad);

    // 5. Single-Draw-Call Nested-Ring Geometry Clipmap + Shadow Cascade 0 Displacement
    const builtClipmap = buildNestedRingClipmap(88, 8, 0.044);
    this.clipmapGeo = builtClipmap.geometry;
    this.clipmapStats = builtClipmap.stats;

    const sharedClipmapUniforms: Record<string, THREE.IUniform> = {
      uCascade0: { value: this.getReadTarget(this.cascade0).texture },
      uCascade1: { value: this.getReadTarget(this.cascade1).texture },
      uOrigin0: { value: new THREE.Vector2() },
      uOrigin1: { value: new THREE.Vector2() },
      uSize0: { value: SAND_DEFAULTS.CASCADE0_SIZE },
      uSize1: { value: SAND_DEFAULTS.CASCADE1_SIZE },
      uGuardWorld0: { value: this.cascade0.cascade.guardWorldWidth },
      uGuardWorld1: { value: this.cascade1.cascade.guardWorldWidth },
      uMaxDepth: { value: SAND_DEFAULTS.MAX_DEPTH_METERS },
      uClipmapCenter: { value: new THREE.Vector2() },
      uBaseCellSize: { value: this.clipmapStats.baseCellSize },
      uBiomeRainy: { value: this.config.biome === 'rainy_highway' ? 1.0 : 0.0 },
    };

    // 5b. Load dual photographic seamless desert sand textures (fine mineral grain + macro wind ripples)
    const fallbackSandData = new Uint8Array([
      214, 186, 146, 255, 202, 174, 134, 255,
      206, 178, 138, 255, 220, 192, 152, 255,
    ]);
    const fallbackSandTex = new THREE.DataTexture(
      fallbackSandData,
      2,
      2,
      THREE.RGBAFormat,
    );
    fallbackSandTex.wrapS = THREE.RepeatWrapping;
    fallbackSandTex.wrapT = THREE.RepeatWrapping;
    fallbackSandTex.magFilter = THREE.LinearFilter;
    fallbackSandTex.minFilter = THREE.LinearFilter;
    fallbackSandTex.needsUpdate = true;

    const fallbackMacroTex = new THREE.DataTexture(
      new Uint8Array([
        210, 182, 142, 255, 196, 168, 128, 255,
        200, 172, 132, 255, 218, 190, 150, 255,
      ]),
      2,
      2,
      THREE.RGBAFormat,
    );
    fallbackMacroTex.wrapS = THREE.RepeatWrapping;
    fallbackMacroTex.wrapT = THREE.RepeatWrapping;
    fallbackMacroTex.magFilter = THREE.LinearFilter;
    fallbackMacroTex.minFilter = THREE.LinearFilter;
    fallbackMacroTex.needsUpdate = true;

    // 5b. Lightweight 2x2 placeholders for Desert sand & Mud detail maps.
    // Photographic desert JPEGs and the 256x256 procedural mud texture are loaded/baked lazily
    // only when switching to `desert` or `mud_grass`, keeping default `rainy_highway` boot
    // network bandwidth and CPU threads 100% free for the Rivian R1T GLB.
    const mudFallbackTex = new THREE.DataTexture(
      new Uint8Array([
        118, 96, 74, 255, 108, 88, 66, 255,
        112, 92, 70, 255, 124, 102, 78, 255,
      ]),
      2,
      2,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    mudFallbackTex.wrapS = THREE.RepeatWrapping;
    mudFallbackTex.wrapT = THREE.RepeatWrapping;
    mudFallbackTex.magFilter = THREE.LinearFilter;
    mudFallbackTex.minFilter = THREE.LinearFilter;
    mudFallbackTex.needsUpdate = true;

    // 1x1 hardware-comparison DepthTexture fallback so sampler2DShadow uShadowMap is always WebGL2-complete
    const fallbackDepthTex = new THREE.DepthTexture(1, 1);
    fallbackDepthTex.format = THREE.DepthFormat;
    fallbackDepthTex.type = THREE.UnsignedIntType;
    fallbackDepthTex.compareFunction = THREE.LessEqualCompare;
    fallbackDepthTex.minFilter = THREE.LinearFilter;
    fallbackDepthTex.magFilter = THREE.LinearFilter;
    this.shadowFallbackRT = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: fallbackDepthTex,
    });
    {
      const prevRT = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.shadowFallbackRT);
      this.renderer.clearDepth();
      this.renderer.setRenderTarget(prevRT);
    }

    this.terrainMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: TERRAIN_CLIPMAP_VERT,
      fragmentShader: TERRAIN_SAND_FRAG,
      uniforms: {
        ...sharedClipmapUniforms,
        uCascadeRes: { value: cascadeRes },
        uSandGrainTex: { value: fallbackSandTex },
        uSandMacroTex: { value: fallbackMacroTex },
        uMudDetailTex: { value: mudFallbackTex },
        uSunDir: { value: new THREE.Vector3(0.5, 0.3, 0.8) },
        uSunColor: { value: new THREE.Color(1.6, 1.25, 0.8) },
        uSkyColor: { value: new THREE.Color(0.48, 0.65, 0.88) },
        uGroundBounceColor: { value: new THREE.Color(0.58, 0.38, 0.22) },
        uFogColor: { value: new THREE.Color(0xd9b38c) },
        uFogDensity: { value: 0.0046 },
        uWindDir: { value: new THREE.Vector2(0.84, 0.53) },
        uMoisture: { value: this.config.moisture },
        uTime: { value: 0 },
        uBiomeMud: { value: this.config.biome === 'mud_grass' ? 1.0 : 0.0 },
        uRainIntensity: { value: this.config.rainIntensity },
        uDebugView: { value: 0 },
        uGlintQuality: { value: 0 },
        uShadowMatrix: { value: new THREE.Matrix4() },
        uShadowMap: { value: fallbackDepthTex },
        uShadowEnabled: { value: 0 },
        uShadowMapSize: { value: new THREE.Vector2(1024, 1024) },
        uShadowFast: { value: 1.0 },
        uFarShadowMatrix: { value: new THREE.Matrix4() },
        uFarShadowMap: { value: fallbackDepthTex },
        uFarShadowEnabled: { value: 0 },
        uRainRippleMaxDist: { value: 22.0 },
        uVehiclePos: { value: new THREE.Vector3() },
        uVehicleFwd: { value: new THREE.Vector2(0, 1) },
        uVehicleFwd3D: { value: new THREE.Vector3(0, 0, 1) },
        uVehicleRight3D: { value: new THREE.Vector3(1, 0, 0) },
        uVehicleUp3D: { value: new THREE.Vector3(0, 1, 0) },
        uVehicleClearanceY: { value: 0.0 },
        uVehicleUpright: { value: 1.0 },
        uHeadlightPower: { value: new THREE.Vector2(0.16, 0.16) },
        uBrakeLightPower: { value: new THREE.Vector2(0.22, 0.22) },
        uReverseLightPower: { value: 0.0 },
        uLinearHdrOutput: { value: 0.0 },
      },
    });

    this.terrainDepthMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: TERRAIN_SHADOW_VERT,
      fragmentShader: TERRAIN_SHADOW_FRAG,
      uniforms: sharedClipmapUniforms,
    });

    this.terrainMesh = new THREE.Mesh(this.clipmapGeo, this.terrainMaterial);
    this.terrainMesh.frustumCulled = false;
    this.terrainMesh.matrixAutoUpdate = false;
    this.terrainMesh.updateMatrix();
    // Terrain receives crisp PCF shadows from the vehicle/runners, while sand-on-sand rut & berm
    // shadows come cleanly from footprint-filtered heightfield horizon marching (zero shadow-map
    // texel swimming and skips an entire 50k-triangle terrain depth shadow pass every frame).
    this.terrainMesh.castShadow = false;
    this.terrainMesh.receiveShadow = !this.isSoftwareGl;
    this.terrainMesh.customDepthMaterial = this.terrainDepthMaterial;
    this.scene.add(this.terrainMesh);

    // 6. Dynamic Reflections + Functional Rearview Mirrors + Hero Vehicle + 4 Foot-IK Runners
    this.reflections = new VehicleReflectionSystem(
      this.isSoftwareGl,
      this.config.graphicsQuality,
      this.isMobile,
    );
    const initialQualityBudget = getGraphicsQualityBudget(
      this.config.graphicsQuality,
      this.isMobile,
      this.isSoftwareGl,
    );
    this.vehicle = new VehicleRig(
      this.reflections.sharedUniforms,
      () => {
        if (this.disposed) return;
        this.vehicleLoadedWallMs = performance.now();
        this.vehicle.attachMirrorMaterials(
          this.reflections.leftMirrorMaterial,
          this.reflections.rightMirrorMaterial,
          this.reflections.interiorMirrorMaterial,
        );
        this.vehicle.setGraphicsQuality(
          this.config.graphicsQuality,
          this.isMobile,
          this.isSoftwareGl,
        );
        const loadedCockpit = this.vehicle.getCockpitRig();
        loadedCockpit.setClusterTexture(this.cockpitDisplays.clusterTexture);
        loadedCockpit.setSyncTexture(this.cockpitDisplays.syncTexture);
        this.cockpitSwitchMeshes.length = 0;
        this.cockpitSwitchMeshes.push(...loadedCockpit.interactiveSwitches.map((s) => s.mesh));
        this.cockpitRaycastTargets.length = 0;
        this.cockpitRaycastTargets.push(loadedCockpit.syncScreenMesh, ...this.cockpitSwitchMeshes);
        this.vehicle.updateHeadlightsForWeather(this.config.weatherPreset);
        this.vehicle.syncCockpitLightingAndMirrors(
          this.cockpitState,
          this.config.weatherPreset,
          this.simTime,
        );
        this.vehicle.setReflectionEnvironment(
          this.reflections.getDynamicEnvMap() ?? this.lighting.getEnvironmentTexture(),
          this.config.reflectionIntensity,
        );
        // Mark shadow & GTAO caches dirty so newly loaded Rivian GLB immediately casts crisp shadow & AO
        this.shadowScheduler.markDirty();
        this.farShadowScheduler.markDirty();
        this.shadowNeedsRenderThisFrame = this.renderer.shadowMap.enabled;
        this.farShadowNeedsRenderThisFrame = this.renderer.shadowMap.enabled;
        this.postProcessing.invalidateGtaoCache();
        this.vehicleReady = true;
        this.completeSynchronizedBootIfReady();
      },
      initialQualityBudget.maxTextureAnisotropy,
      (err) => {
        if (this.disposed) return;
        this.bootLoadError =
          err instanceof Error ? err.message : 'Falha ao carregar o veículo Rivian R1T.';
        this.emitBootProgress();
      },
    );
    this.vehicle.attachMirrorMaterials(
      this.reflections.leftMirrorMaterial,
      this.reflections.rightMirrorMaterial,
      this.reflections.interiorMirrorMaterial,
    );
    const cockpitRig = this.vehicle.getCockpitRig();
    cockpitRig.setClusterTexture(this.cockpitDisplays.clusterTexture);
    cockpitRig.setSyncTexture(this.cockpitDisplays.syncTexture);
    this.cockpitSwitchMeshes.push(...cockpitRig.interactiveSwitches.map((s) => s.mesh));
    this.cockpitRaycastTargets.push(cockpitRig.syncScreenMesh, ...this.cockpitSwitchMeshes);
    this.vehicle.setCockpitActive(this.config.cameraMode === 'cockpit');
    this.scene.add(this.vehicle.root, this.vehicle.debrisContainer);

    this.postProcessing = new PostProcessingPipeline(
      this.renderer,
      this.scene,
      this.camera,
      Math.max(1, container.clientWidth),
      Math.max(1, container.clientHeight),
      this.isSoftwareGl,
      this.config.graphicsQuality,
      this.isMobile,
    );

    this.runners = [
      // Foot-IK runners orbiting outside the central chase vista (brought right beside vehicle in foot_ik_walk mode)
      new RunnerRig({
        centerX: 18.5,
        centerZ: 16.5,
        orbitRadius: 4.5,
        startAngle: 0.4,
        speedMs: 2.35,
        jacketColor: 0x2d6d7a,
        bodyMassKg: 78,
      }),
      new RunnerRig({
        centerX: -22.5,
        centerZ: 18.5,
        orbitRadius: 5.4,
        startAngle: 2.1,
        speedMs: 3.1,
        jacketColor: 0xb8892c,
        bodyMassKg: 74,
      }),
      new RunnerRig({
        centerX: 24.0,
        centerZ: -18.0,
        orbitRadius: 6.2,
        startAngle: 4.0,
        speedMs: 3.4,
        jacketColor: 0x7d3d32,
        bodyMassKg: 82,
      }),
      new RunnerRig({
        centerX: -21.5,
        centerZ: -20.0,
        orbitRadius: 5.8,
        startAngle: 5.2,
        speedMs: 2.8,
        jacketColor: 0x456b4d,
        bodyMassKg: 70,
      }),
    ];
    for (const r of this.runners) {
      this.scene.add(r.root);
    }

    // 7. Tri-Layer GPU Particle System:
    //    - 4,096 ballistic sand roost grains (GpuParticleRing)
    //    - 512 incandescent molten metallic crash sparks (Additive GpuParticleRing)
    //    - Single-draw-call Instanced Volumetric Smoke & Desert Dust System (480 GPU / 260 SW-GL puffs)
    const pixelRatio = this.renderer.getPixelRatio();
    this.roostParticles = new GpuParticleRing(
      4096,
      ROOST_PARTICLES_VERT,
      ROOST_PARTICLES_FRAG,
      {
        uTime: { value: 0 },
        uGravity: { value: 12.8 },
        uWindVec: { value: new THREE.Vector2(1.0, 0.5) },
        uPixelRatio: { value: pixelRatio },
        uSunColor: { value: new THREE.Color(1.4, 1.15, 0.85) },
        uSandColor: { value: new THREE.Color(0.79, 0.64, 0.45) },
        uLinearHdrOutput: { value: 0.0 },
      },
    );
    this.sparkParticles = new GpuParticleRing(
      512,
      SPARK_PARTICLES_VERT,
      SPARK_PARTICLES_FRAG,
      {
        uTime: { value: 0 },
        uGravity: { value: 11.5 },
        uPixelRatio: { value: pixelRatio },
        uLinearHdrOutput: { value: 0.0 },
      },
      THREE.AdditiveBlending,
    );
    this.smokeSystem = new VolumetricSmokeSystem(this.isSoftwareGl || this.isMobile ? 260 : 480);
    // Exclude particles & volumetric smoke from CubeCamera & rear-view mirror reflection captures
    this.roostParticles.points.layers.set(ENV_DETAIL_EXCLUDED_LAYER);
    this.sparkParticles.points.layers.set(ENV_DETAIL_EXCLUDED_LAYER);
    this.smokeSystem.mesh.layers.set(ENV_DETAIL_EXCLUDED_LAYER);
    this.scene.add(this.roostParticles.points, this.sparkParticles.points, this.smokeSystem.mesh);

    this.audio = new VehicleAudioEngine();
    this.audio.setEnabled(this.config.audioEnabled);

    this.grassParamsScratch = {
      time: 0,
      windDirX: 1,
      windDirZ: 0,
      windSpeed: 0,
      vehicleX: 0,
      vehicleZ: 0,
      cascade0Tex: this.getReadTarget(this.cascade0).texture,
      origin0X: 0,
      origin0Z: 0,
      size0: this.cascade0.cascade.size,
      guardWorld0: this.cascade0.cascade.guardWorldWidth,
      cascade1Tex: this.getReadTarget(this.cascade1).texture,
      origin1X: 0,
      origin1Z: 0,
      size1: this.cascade1.cascade.size,
      guardWorld1: this.cascade1.cascade.guardWorldWidth,
    };
    this.rainyCorridorParamsScratch = {
      focusPos: this.vehicle.position,
      cameraPos: this.camera.position,
      time: 0,
      rainIntensity: 0,
      sunDir: this.lighting.sunDirection,
      fogColor: this.lighting.fogColorLinear,
      brokenFenceIds: this.vehicle.getBrokenFenceIds(),
    };
    this.smokeEnvScratch = {
      time: 0,
      windVecX: 1,
      windVecZ: 0,
      sunDir: this.lighting.sunDirection,
      sunColor: this.lighting.sunColorLinear,
      skyColor: this.lighting.skyColorLinear,
      groundBounce: this.lighting.groundBounceLinear,
      fogColor: this.lighting.fogColorLinear,
      fogDensity: this.lighting.fog.density,
      vehiclePos: this.vehicle.position,
      vehicleFwdX: 0,
      vehicleFwdZ: 1,
      brakeLightPower: 0,
    };
    this.reflectionUpdateScratch = {
      renderer: this.renderer,
      scene: this.scene,
      mainCamera: this.camera,
      vehicleRoot: this.vehicle.root,
      vehiclePos: this.vehicle.position,
      groundPlaneY: 0,
      bodyWorldMatrix: this.vehicle.bodyGroup.matrixWorld,
      biome: this.config.biome,
      vehicleSpeedMs: 0,
      leftMirror: _leftMirrorAnchor,
      rightMirror: _rightMirrorAnchor,
      interiorMirror: _interiorMirrorAnchor,
      sunDir: this.lighting.sunDirection,
      sunColor: this.lighting.sunColorLinear,
      skyColor: this.lighting.skyColorLinear,
      groundColor: this.lighting.groundBounceLinear,
      reflectionIntensity: this.config.reflectionIntensity,
      setLinearHdrOutput: this.setAllLinearHdrOutput,
      restoreLinearHdr: false,
      forceFullPrime: false,
      isCockpitMode: false,
    };
    this.postProcessParamsScratch = {
      sunDirWorld: this.lighting.sunDirection,
      sunGlowColor: this.lighting.sunGlowLinear,
      groundBounce: this.lighting.groundBounceLinear,
      aoIntensity: this.config.aoIntensity,
      exposure: this.config.exposure,
      toneMappingMode: this.config.toneMappingMode,
      sceneGeometryDynamic: true,
      gtaoCadence: 1,
    };

    // 8. Input & Resize Listeners
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleWindowBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('pointerdown', this.handleAudioUnlock, { passive: true });
    this.renderer.domElement.addEventListener('pointerdown', this.handleCockpitPointerDown);
    window.addEventListener('pointermove', this.handleCockpitPointerMove);
    window.addEventListener('pointerup', this.handleCockpitPointerUp);
    this.cachedCanvasRect = this.renderer.domElement.getBoundingClientRect();

    // 9. Apply initial biome, weather & quasi-PT graphics pipeline, then pre-warm simulation tracks
    this.lighting.setBiome(this.config.biome);
    this.ensureBiomeTerrainTextures(this.config.biome);
    this.syncGraphicsSettings(true);
    this.warmupScene();
    this.updateCameraAndUniforms(0.016);

    // Initialize zero-delay MessageChannel scheduler for unlocked/VSync-free FPS on real GPUs (PC & Mobile)
    if (!this.isSoftwareGl && typeof MessageChannel !== 'undefined') {
      this.uncapChannel = new MessageChannel();
      this.uncapChannel.port1.onmessage = () => {
        this.uncapScheduled = false;
        this.tick();
      };
    }

    // 10. Mark scenery ready and reveal synchronously ONLY once BOTH scenery AND Rivian R1T are compiled & rendered
    this.sceneReady = true;
    this.emitBootProgress();
    this.completeSynchronizedBootIfReady();
  }

  private emitBootProgress(): void {
    if (this.disposed || !this.onBootProgress) return;
    this.onBootProgress(
      computeUnifiedBootProgress({
        downloadRatio: this.latestPreloadProgress.downloadRatio,
        loadedBytes: this.latestPreloadProgress.loadedBytes,
        totalBytes: this.latestPreloadProgress.totalBytes,
        parseCompleted: this.latestPreloadProgress.parseCompleted,
        sceneReady: this.sceneReady,
        vehicleReady: this.vehicleReady && this.loopStarted,
        errorMessage: this.bootLoadError,
      }),
    );
  }

  private completeSynchronizedBootIfReady(): void {
    if (this.disposed || this.loopStarted || !this.sceneReady || !this.vehicleReady) {
      return;
    }
    this.loopStarted = true;

    // Compile all shaders TOGETHER (scenery + vehicle + mirrors + shadows) and render the complete
    // first frame BEFORE clearing the loading gate so the world and car appear simultaneously!
    this.updateCameraAndUniforms(0.016);
    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }
    this.renderMainScene(!this.isSoftwareGl);

    if (typeof window !== 'undefined') {
      const readyNow = performance.now();
      (window as unknown as { __SAND_ENGINE_LOAD_TIMING__?: unknown }).__SAND_ENGINE_LOAD_TIMING__ = {
        timeToVehicleMs: Math.round((this.vehicleLoadedWallMs ?? readyNow) - this.bootStartWallMs),
        timeToSynchronizedRevealMs: Math.round(readyNow - this.bootStartWallMs),
      };
    }

    this.emitBootProgress();
    this.emitTelemetryNow();
    this.frameTimer.reset();
    this.lastTickWallMs = 0;
    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.tick();
    }
  }

  private ensureBiomeTerrainTextures(biome: SandRuntimeConfig['biome']): void {
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();

    if ((biome === 'desert' || biome === 'mud_grass') && !this.sandTexturesRequested) {
      this.sandTexturesRequested = true;
      const texLoader = new THREE.TextureLoader();

      const sandGrainTex = texLoader.load(sandGrainAlbedoUrl, (loaded) => {
        if (this.disposed) {
          loaded.dispose();
          return;
        }
        this.pendingSandGrainTex = null;
        loaded.wrapS = THREE.RepeatWrapping;
        loaded.wrapT = THREE.RepeatWrapping;
        loaded.anisotropy = maxAniso;
        loaded.generateMipmaps = true;
        loaded.minFilter = THREE.LinearMipmapLinearFilter;
        loaded.magFilter = THREE.LinearFilter;
        loaded.needsUpdate = true;
        const prev = this.terrainMaterial.uniforms.uSandGrainTex.value as THREE.Texture | null;
        this.terrainMaterial.uniforms.uSandGrainTex.value = loaded;
        if (prev && prev !== loaded) prev.dispose();
      });
      sandGrainTex.wrapS = THREE.RepeatWrapping;
      sandGrainTex.wrapT = THREE.RepeatWrapping;
      sandGrainTex.anisotropy = maxAniso;
      this.pendingSandGrainTex = sandGrainTex;

      const sandMacroTex = texLoader.load(sandMacroAlbedoUrl, (loaded) => {
        if (this.disposed) {
          loaded.dispose();
          return;
        }
        this.pendingSandMacroTex = null;
        loaded.wrapS = THREE.RepeatWrapping;
        loaded.wrapT = THREE.RepeatWrapping;
        loaded.anisotropy = maxAniso;
        loaded.generateMipmaps = true;
        loaded.minFilter = THREE.LinearMipmapLinearFilter;
        loaded.magFilter = THREE.LinearFilter;
        loaded.needsUpdate = true;
        const prev = this.terrainMaterial.uniforms.uSandMacroTex.value as THREE.Texture | null;
        this.terrainMaterial.uniforms.uSandMacroTex.value = loaded;
        if (prev && prev !== loaded) prev.dispose();
      });
      sandMacroTex.wrapS = THREE.RepeatWrapping;
      sandMacroTex.wrapT = THREE.RepeatWrapping;
      sandMacroTex.anisotropy = maxAniso;
      this.pendingSandMacroTex = sandMacroTex;
    }

    if (biome === 'mud_grass' && !this.mudDetailBaked) {
      this.mudDetailBaked = true;
      const mudDetailSize = 256;
      const mudDetailBytes = generateMudDetailTexture(mudDetailSize);
      const mudDetailTex = new THREE.DataTexture(
        mudDetailBytes,
        mudDetailSize,
        mudDetailSize,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
      );
      mudDetailTex.wrapS = THREE.RepeatWrapping;
      mudDetailTex.wrapT = THREE.RepeatWrapping;
      mudDetailTex.generateMipmaps = true;
      mudDetailTex.minFilter = THREE.LinearMipmapLinearFilter;
      mudDetailTex.magFilter = THREE.LinearFilter;
      mudDetailTex.anisotropy = maxAniso;
      mudDetailTex.needsUpdate = true;
      const prevMud = this.terrainMaterial.uniforms.uMudDetailTex.value as THREE.Texture | null;
      this.terrainMaterial.uniforms.uMudDetailTex.value = mudDetailTex;
      if (prevMud && prevMud !== mudDetailTex) prevMud.dispose();
    }
  }

  private readonly setAllLinearHdrOutput = (enabled: boolean): void => {
    if (this.lastLinearHdrOutput === enabled) return;
    this.lastLinearHdrOutput = enabled;
    const val = enabled ? 1.0 : 0.0;
    this.lighting.setLinearHdrOutput(enabled);
    this.terrainMaterial.uniforms.uLinearHdrOutput.value = val;
    this.smokeSystem.setLinearHdrOutput(enabled);
    this.roostParticles.material.uniforms.uLinearHdrOutput.value = val;
    this.sparkParticles.material.uniforms.uLinearHdrOutput.value = val;
  };

  private syncGraphicsSettings(markProbeDirty = false): void {
    const q = this.config.graphicsQuality;
    const budget = getGraphicsQualityBudget(q, this.isMobile, this.isSoftwareGl);

    // Sync quality-aware pixelRatio identically across WebGLRenderer, EffectComposer & GPU particles
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const pr = computeEffectivePixelRatio(
      w,
      window.devicePixelRatio || 1,
      this.isSoftwareGl,
      q,
    );
    if (Math.abs(this.renderer.getPixelRatio() - pr) > 0.001) {
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(w, h);
      this.roostParticles.material.uniforms.uPixelRatio.value = pr;
      this.sparkParticles.material.uniforms.uPixelRatio.value = pr;
    }

    this.lighting.setShadowQuality(q);
    this.shadowScheduler.markDirty();
    this.farShadowScheduler.markDirty();
    this.lastBoundShadowTex = null;
    this.lastBoundFarShadowTex = null;
    this.lighting.setWeather(this.config.weatherPreset);
    this.lighting.setEnvironmentIntensity(this.config.reflectionIntensity);
    this.reflections.setQuality(q);
    this.postProcessing.setQuality(q);
    this.postProcessing.resize(w, h);
    if (markProbeDirty) {
      this.reflections.markDirty();
    }

    const sm = this.lighting.sunLight.shadow.mapSize;
    this.terrainMaterial.uniforms.uShadowMapSize.value.set(sm.width, sm.height);
    this.terrainMaterial.uniforms.uShadowFast.value = budget.terrainFastShadowPcf ? 1.0 : 0.0;
    this.terrainMaterial.uniforms.uRainRippleMaxDist.value = budget.rainRippleMaxDist;

    this.vehicle.setGraphicsQuality(q, this.isMobile, this.isSoftwareGl);
    this.vehicle.updateHeadlightsForWeather(this.config.weatherPreset);
    this.vehicle.setReflectionEnvironment(
      this.reflections.getDynamicEnvMap() ?? this.lighting.getEnvironmentTexture(),
      this.config.reflectionIntensity,
    );
    this.lastLinearHdrOutput = null;
    this.setAllLinearHdrOutput(this.postProcessing.isActive());
  }

  private renderMainScene(forceProbePrime = false): void {
    const useHdrComposer = this.postProcessing.isActive();

    // Update dynamic CubeCamera probe + functional rear-facing wing mirrors (zero-alloc scratch)
    this.vehicle.getMirrorAnchors(
      _leftMirrorAnchor,
      _rightMirrorAnchor,
      _interiorMirrorAnchor,
    );
    this.vehicle.bodyGroup.updateMatrixWorld();
    const ru = this.reflectionUpdateScratch;
    ru.groundPlaneY = this.vehicle.getGroundHeight();
    ru.bodyWorldMatrix = this.vehicle.bodyGroup.matrixWorld;
    ru.biome = this.config.biome;
    ru.vehicleSpeedMs = this.lastVehicleTelemetry.speedKmh / 3.6;
    ru.reflectionIntensity = this.config.reflectionIntensity;
    ru.restoreLinearHdr = useHdrComposer;
    ru.forceFullPrime = forceProbePrime;
    ru.isCockpitMode = this.config.cameraMode === 'cockpit';
    this.reflections.update(ru);

    this.vehicle.setReflectionEnvironment(
      this.reflections.getDynamicEnvMap() ?? this.lighting.getEnvironmentTexture(),
      this.config.reflectionIntensity,
    );
    this.setAllLinearHdrOutput(useHdrComposer);

    // Trigger independent per-cascade directional shadow map updates right before main scene render
    if (this.renderer.shadowMap.enabled) {
      const renderNear = this.shadowNeedsRenderThisFrame || forceProbePrime;
      const renderFar = this.farShadowNeedsRenderThisFrame || forceProbePrime;
      if (renderNear || renderFar) {
        if (renderNear) {
          this.lighting.sunLight.shadow.needsUpdate = true;
          this.shadowNeedsRenderThisFrame = false;
        }
        if (renderFar) {
          this.lighting.farSunLight.shadow.needsUpdate = true;
          this.farShadowNeedsRenderThisFrame = false;
        }
        this.renderer.shadowMap.needsUpdate = true;
      }
    }

    const pp = this.postProcessParamsScratch;
    pp.aoIntensity = this.config.aoIntensity;
    pp.exposure = this.config.exposure;
    pp.toneMappingMode = this.config.toneMappingMode;
    pp.sceneGeometryDynamic = this.sceneGeometryDynamicThisFrame || forceProbePrime;
    pp.gtaoCadence = forceProbePrime ? 1 : this.currentGtaoCadence;
    this.postProcessing.render(pp);
  }

  private createCascadePair(
    size: number,
    resolution: number,
    type: THREE.TextureDataType,
  ): CascadeGpuPair {
    const opts: THREE.RenderTargetOptions = {
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    };
    const rtA = new THREE.WebGLRenderTarget(resolution, resolution, opts);
    const rtB = new THREE.WebGLRenderTarget(resolution, resolution, opts);

    // Zero-initialize both ping-pong buffers
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(rtA);
    this.renderer.clear();
    this.renderer.setRenderTarget(rtB);
    this.renderer.clear();
    this.renderer.setRenderTarget(prevTarget);

    return {
      cascade: new ToroidalCascade(size, resolution),
      sleep: new SleepController(),
      rtA,
      rtB,
      readIsA: true,
      tickParity: 0,
    };
  }

  private getReadTarget(pair: CascadeGpuPair): THREE.WebGLRenderTarget {
    return pair.readIsA ? pair.rtA : pair.rtB;
  }

  private getWriteTarget(pair: CascadeGpuPair): THREE.WebGLRenderTarget {
    return pair.readIsA ? pair.rtB : pair.rtA;
  }

  private swapCascade(pair: CascadeGpuPair): void {
    pair.readIsA = !pair.readIsA;
  }

  private warmupScene(): void {
    // In rainy_highway, spawn cleanly on the right wet asphalt lane facing straight down +Z highway
    if (this.config.biome === 'rainy_highway') {
      this.vehicle.reset(-1.55, 0.0, 0.0, 'rainy_highway');
      this.lastActiveInput = { ...EMPTY_VEHICLE_INPUT };
      this.snapCameraToMode();
      this.emitTelemetryNow();
      return;
    }

    // Carve an initial curved rally track (plus crossing ruts in mud_grass) during warmup
    // so frame 1 showcases deep tracks, berms, puddles, and roost while handing control to the player
    const savedMode = this.config.stressMode;
    this.config.stressMode = 'donuts';
    const isMud = this.config.biome === 'mud_grass';

    if (isMud) {
      // First short diagonal cross-rut through the central mud basin (matches overlapping mud ruts in photo)
      this.vehicle.reset(-7.2, 0.8, 0.22, this.config.biome);
      const crossSteps = this.isSoftwareGl ? 6 : 22;
      const crossDt = this.isSoftwareGl ? 1 / 12 : 1 / 30;
      for (let i = 0; i < crossSteps; i++) {
        this.stepSimulation(crossDt, true);
      }
    }

    this.vehicle.reset(-4.5, -3.5, 0.58, this.config.biome);
    const totalSteps = this.isSoftwareGl ? 12 : 48;
    const stepDt = this.isSoftwareGl ? 1 / 12 : 1 / 30;
    const smokeLeadSteps = this.isSoftwareGl ? 6 : 26;
    for (let i = 0; i < totalSteps; i++) {
      const suppressParticles = i < totalSteps - smokeLeadSteps;
      this.stepSimulation(stepDt, suppressParticles);
    }
    this.config.stressMode = savedMode;
    if (savedMode === 'manual') {
      // Ease velocity slightly so the truck settles calmly at the end of its carved curve, ready for WASD
      this.vehicle.velocity.multiplyScalar(0.35);
      this.lastActiveInput = { ...EMPTY_VEHICLE_INPUT };
    }
    this.snapCameraToMode();
    this.emitTelemetryNow();
  }

  public setConfig(next: Partial<SandRuntimeConfig>): void {
    const prevCamera = this.config.cameraMode;
    const prevStress = this.config.stressMode;
    const prevBiome = this.config.biome;
    const prevQuality = this.config.graphicsQuality;
    const prevWeather = this.config.weatherPreset;
    const prevRefl = this.config.reflectionIntensity;
    const prevSunElev = this.config.sunElevationDeg;
    const prevSunAz = this.config.sunAzimuthDeg;
    const prevFpsUncapped = this.config.fpsUncapped;
    this.config = { ...this.config, ...next };
    this.audio.setEnabled(this.config.audioEnabled);
    if (next.audioEnabled === true) {
      this.audio.unlockFromGesture();
    }

    if (prevFpsUncapped !== this.config.fpsUncapped) {
      this.lastTickWallMs = 0;
      this.perfMonitor.reset();
      this.pacingGovernor.reset();
      this.inFlightFenceLimiter.reset();
      this.clearUncappedFence();
      this.emitTelemetryNow();
    }

    if (next.wiperMode !== undefined) {
      this.cockpitState.wiperMode = next.wiperMode;
      this.cockpitState.screenDirty = true;
    }

    this.controls.enabled = this.config.cameraMode !== 'cockpit';

    const qualityOrWeatherChanged =
      prevQuality !== this.config.graphicsQuality ||
      prevWeather !== this.config.weatherPreset;
    const sunMoved =
      Math.abs(prevSunElev - this.config.sunElevationDeg) > 0.5 ||
      Math.abs(prevSunAz - this.config.sunAzimuthDeg) > 0.5;

    if (qualityOrWeatherChanged || prevRefl !== this.config.reflectionIntensity) {
      this.syncGraphicsSettings(qualityOrWeatherChanged);
    }
    if (sunMoved) {
      this.reflections.markDirty();
      this.shadowScheduler.markDirty();
      this.farShadowScheduler.markDirty();
    }

    if (prevBiome !== this.config.biome) {
      this.shadowScheduler.markDirty();
      this.farShadowScheduler.markDirty();
      this.postProcessing.invalidateGtaoCache();
      this.lighting.setBiome(this.config.biome);
      this.ensureBiomeTerrainTextures(this.config.biome);
      const syncPatch: Partial<SandRuntimeConfig> = {};
      if (this.config.biome === 'rainy_highway' && next.weatherPreset === undefined) {
        const spec = WEATHER_PRESET_SPECS.rainy_mist;
        this.config.weatherPreset = 'rainy_mist';
        this.config.sunElevationDeg = spec.sunElevationDeg;
        this.config.sunAzimuthDeg = spec.sunAzimuthDeg;
        this.config.exposure = spec.exposure;
        syncPatch.weatherPreset = 'rainy_mist';
        syncPatch.sunElevationDeg = spec.sunElevationDeg;
        syncPatch.sunAzimuthDeg = spec.sunAzimuthDeg;
        syncPatch.exposure = spec.exposure;
      } else if (this.config.biome === 'mud_grass' && next.weatherPreset === undefined) {
        const spec = WEATHER_PRESET_SPECS.humid_overcast;
        this.config.weatherPreset = 'humid_overcast';
        this.config.exposure = spec.exposure;
        syncPatch.weatherPreset = 'humid_overcast';
        syncPatch.exposure = spec.exposure;
      } else if (
        this.config.biome === 'desert' &&
        (prevWeather === 'humid_overcast' || prevWeather === 'rainy_mist') &&
        next.weatherPreset === undefined
      ) {
        const spec = WEATHER_PRESET_SPECS.golden_hour;
        this.config.weatherPreset = 'golden_hour';
        this.config.sunElevationDeg = spec.sunElevationDeg;
        this.config.sunAzimuthDeg = spec.sunAzimuthDeg;
        this.config.exposure = spec.exposure;
        syncPatch.weatherPreset = 'golden_hour';
        syncPatch.sunElevationDeg = spec.sunElevationDeg;
        syncPatch.sunAzimuthDeg = spec.sunAzimuthDeg;
        syncPatch.exposure = spec.exposure;
      }
      if (Object.keys(syncPatch).length > 0) {
        this.onConfigSync?.(syncPatch);
      }
      this.syncGraphicsSettings(true);
      this.clearSand();
      this.warmupScene();
      this.updateCameraAndUniforms(0.016);
      this.renderMainScene(true);
    }

    if (prevStress !== this.config.stressMode) {
      if (this.config.stressMode === 'foot_ik_walk') {
        // Bring foreground runner close to vehicle and park vehicle cleanly
        this.runners[0].setOrbitCenter(
          this.vehicle.position.x + 3.2,
          this.vehicle.position.z + 2.8,
        );
      } else if (this.config.stressMode === 'sprint_150') {
        this.vehicle.reset(0, -18, 0.15);
        this.prevFollowPos.copy(this.vehicle.position);
      } else if (this.config.stressMode === 'rollover_crash') {
        this.vehicle.setupRolloverCrashShowcase(this.config.biome);
        this.prevFollowPos.copy(this.vehicle.position);
        this.snapCameraToMode();
        this.lastVehicleTelemetry.speedKmh = this.vehicle.velocity.length() * 3.6;
        this.emitTelemetryNow();
        this.renderMainScene(false);
      }
      this.cascade0.sleep.wake(0.6);
      this.cascade1.sleep.wake(0.6);
    }

    if (prevCamera !== this.config.cameraMode) {
      const isCockpit = this.config.cameraMode === 'cockpit';
      this.vehicle.setCockpitActive(isCockpit);
      if (isCockpit) {
        this.cockpitDisplayTelScratch.speedKmh = this.lastVehicleTelemetry.speedKmh;
        this.cockpitDisplayTelScratch.rpm = this.lastVehicleTelemetry.rpm;
        this.cockpitDisplayTelScratch.gear = this.lastVehicleTelemetry.gear;
        this.cockpitDisplayTelScratch.driveMode = this.config.driveMode;
        this.cockpitDisplayTelScratch.biome = this.config.biome;
        this.cockpitDisplayTelScratch.pitchDeg = this.vehicle.getPitchDeg();
        this.cockpitDisplayTelScratch.rollDeg = this.lastVehicleTelemetry.rollDeg;
        this.cockpitDisplayTelScratch.damage = this.vehicle.getDamageState();
        this.cockpitDisplayTelScratch.timeSec = this.simTime;
        this.cockpitDisplays.update(this.cockpitState, this.cockpitDisplayTelScratch, true);
      }
      this.userFreeCameraActive = this.config.cameraMode === 'orbit';
      if (this.config.cameraMode === 'orbit') {
        this.controls.target.copy(this.vehicle.position);
        this.controls.target.y += 0.9;
        this.prevFollowPos.copy(this.vehicle.position);
        this.hasPrevFollowPos = true;
      } else {
        this.snapCameraToMode();
        this.updateCameraAndUniforms(0.016);
        this.renderMainScene(false);
      }
    } else if (qualityOrWeatherChanged) {
      this.updateCameraAndUniforms(0.016);
      this.renderMainScene(true);
    }

    if (!this.config.autoSleepEnabled) {
      this.cascade0.sleep.wake(0.3);
      this.cascade1.sleep.wake(0.3);
    }
  }

  /** Marco 1 Stress Test: Instant 500m world teleport verifying zero wrapped track leaks */
  public teleport500m(): void {
    const targetX = this.vehicle.position.x + 500;
    const targetZ = this.vehicle.position.z;
    this.vehicle.reset(targetX, targetZ, 0.3);
    for (let i = 0; i < this.runners.length; i++) {
      const ang = (i / this.runners.length) * Math.PI * 2;
      this.runners[i].setOrbitCenter(
        targetX + Math.cos(ang) * 8.5,
        targetZ + Math.sin(ang) * 8.5,
      );
    }
    this.terramechanics.clearTracks();
    this.roostParticles.clear();
    this.sparkParticles.clear();
    this.smokeSystem.clear();
    this.cascade0.sleep.wake(0.8);
    this.cascade1.sleep.wake(0.8);
    this.shadowScheduler.markDirty();
    this.farShadowScheduler.markDirty();
    this.postProcessing.invalidateGtaoCache();
    this.snapCameraToMode();
  }

  /** Resets all sand deformations cleanly to undisturbed wind-rippled dunes */
  public clearSand(): void {
    this.cascade0.cascade.forceFullClear();
    this.cascade1.cascade.forceFullClear();
    this.cascade0.sleep.wake(0.4);
    this.cascade1.sleep.wake(0.4);
    this.terramechanics.clearTracks();
    this.roostParticles.clear();
    this.sparkParticles.clear();
    this.smokeSystem.clear();
    // Run one immediate clear pass on Cascade 1 FIRST, then Cascade 0 (so Cascade 0 promotes 0.0)
    this.brushEncoder.clear();
    this.dispatchCascadeSim(this.cascade1, false, 0, true, null);
    this.dispatchCascadeSim(this.cascade0, false, 0, true, this.cascade1);
  }

  /** Flips an overturned truck back onto all 4 wheels in-place while keeping dents & missing parts */
  public rightVehicle(): void {
    this.vehicle.rightOverturnedVehicle();
    if (this.config.stressMode === 'rollover_crash') {
      this.config.stressMode = 'manual';
      this.onManualOverride?.();
    }
    this.lastVehicleTelemetry.speedKmh = this.vehicle.velocity.length() * 3.6;
    this.lastVehicleTelemetry.integrityPct = this.vehicle.getIntegrityPct();
    this.lastVehicleTelemetry.detachedCount = this.vehicle.getDetachedCount();
    this.lastVehicleTelemetry.rollDeg = 0;
    this.lastVehicleTelemetry.isTipping = false;
    this.lastVehicleTelemetry.isRolledOver = false;
    this.cascade0.sleep.wake(0.4);
    this.cascade1.sleep.wake(0.4);
    this.shadowScheduler.markDirty();
    this.farShadowScheduler.markDirty();
    this.postProcessing.invalidateGtaoCache();
    this.updateCameraAndUniforms(0.016);
    this.emitTelemetryNow();
    this.renderMainScene(false);
  }

  /** Repositions the Raptor R cleanly upright & factory-restored (body, glass, wipers, radiator, engine & tires) */
  public resetVehicle(): void {
    this.vehicle.reset(this.vehicle.position.x, this.vehicle.position.z, this.vehicle.heading, this.config.biome);
    this.shadowScheduler.markDirty();
    this.farShadowScheduler.markDirty();
    this.postProcessing.invalidateGtaoCache();
    this.cockpitState.wiperDamaged = false;
    this.cockpitState.screenDirty = true;
    this.smokeSystem.clear();
    this.lastVehicleTelemetry.speedKmh = 0;
    this.lastVehicleTelemetry.integrityPct = 100;
    this.lastVehicleTelemetry.rollDeg = 0;
    this.lastVehicleTelemetry.isTipping = false;
    this.lastVehicleTelemetry.isRolledOver = false;
    this.lastVehicleTelemetry.rollCount = 0;
    this.lastVehicleTelemetry.detachedCount = 0;
    this.lastVehicleTelemetry.windshieldCrackLevel = 0;
    this.cockpitDisplays.update(
      this.cockpitState,
      {
        speedKmh: 0,
        rpm: 700,
        gear: '1',
        driveMode: this.config.driveMode,
        biome: this.config.biome,
        pitchDeg: 0,
        rollDeg: 0,
        damage: this.vehicle.getDamageState(),
        timeSec: this.simTime,
      },
      true,
    );
    this.cascade0.sleep.wake(0.4);
    this.cascade1.sleep.wake(0.4);
    this.snapCameraToMode();
    this.updateCameraAndUniforms(0.016);
    this.emitTelemetryNow();
    this.renderMainScene(true);
  }

  /** Positions the 4x4 cleanly at the entrance of the Sahara sandstone rock-crawling & uneven sand course in 4L */
  public goToRockTrail(): void {
    const switchingBiome = this.config.biome !== 'desert';
    const syncPatch: Partial<SandRuntimeConfig> = {
      biome: 'desert',
      stressMode: 'manual',
      driveMode: '4L',
    };
    if (
      switchingBiome &&
      (this.config.weatherPreset === 'humid_overcast' || this.config.weatherPreset === 'rainy_mist')
    ) {
      const spec = WEATHER_PRESET_SPECS.golden_hour;
      syncPatch.weatherPreset = 'golden_hour';
      syncPatch.sunElevationDeg = spec.sunElevationDeg;
      syncPatch.sunAzimuthDeg = spec.sunAzimuthDeg;
      syncPatch.exposure = spec.exposure;
    }
    this.config = {
      ...this.config,
      ...syncPatch,
    };
    this.onConfigSync?.(syncPatch);
    if (switchingBiome) {
      this.lighting.setBiome('desert');
      this.syncGraphicsSettings(true);
      this.clearSand();
    }
    this.vehicle.reset(14.0, 11.4, 0.02, 'desert');
    this.shadowScheduler.markDirty();
    this.farShadowScheduler.markDirty();
    this.postProcessing.invalidateGtaoCache();
    this.roostParticles.clear();
    this.smokeSystem.clear();
    this.cascade0.sleep.wake(0.6);
    this.cascade1.sleep.wake(0.6);
    this.snapCameraToMode();
    this.updateCameraAndUniforms(0.016);
    this.emitTelemetryNow();
    this.renderMainScene(true);
  }

  /** Cycles active camera preset cleanly (used by C key and mobile top-bar camera button) */
  public cycleCamera(): CameraMode {
    const next = getNextCameraMode(this.config.cameraMode);
    this.setConfig({ cameraMode: next });
    this.onCameraCycle?.(next);
    return next;
  }

  /** Updates independent multi-touch virtual control flags (merged seamlessly with keyboard) */
  public setVirtualControl(patch: Partial<VirtualControlFlags>): void {
    this.audio.unlockFromGesture();
    Object.assign(this.virtualFlags, patch);
    const vf = this.virtualFlags;
    const vSteer =
      Math.abs(vf.analogSteer) > 0.02
        ? Math.max(-1, Math.min(1, vf.analogSteer))
        : (vf.left ? 1 : 0) - (vf.right ? 1 : 0);
    const vThrottle = (vf.accelerate || vf.boost ? 1 : 0) - (vf.brake ? 1 : 0);
    const anyActive =
      Math.abs(vThrottle) > 0.05 ||
      Math.abs(vSteer) > 0.05 ||
      vf.handbrake ||
      vf.boost;
    if (anyActive && this.config.stressMode !== 'manual') {
      this.config.stressMode = 'manual';
      this.onManualOverride?.();
    }
  }

  private getFocusPoint(out: THREE.Vector3): THREE.Vector3 {
    if (this.config.cameraMode === 'foot_ik') {
      return out.copy(this.runners[0].position);
    }
    return out.copy(this.vehicle.position);
  }

  private snapCameraToMode(): void {
    this.getFocusPoint(_camCurrentTarget);
    this.vehicle.getForwardVector(_vehFwd);
    const mode = this.config.cameraMode;

    if (mode === 'cockpit') {
      this.camera.fov = 70;
      this.camera.near = 0.06;
      this.camera.updateProjectionMatrix();
      this.controls.enabled = false;
      this.vehicle.getCockpitCamPose(
        this.camera.position,
        _camCurrentTarget,
        _camUp,
        this.cockpitState.headPitchRad,
        this.cockpitState.headRollRad,
        this.cockpitState.headHeaveM,
        this.cockpitState.lookYawRad,
        this.cockpitState.lookPitchRad,
      );
      this.camera.up.copy(_camUp);
    } else {
      if (this.camera.near !== 0.15) {
        this.camera.near = 0.15;
        this.camera.updateProjectionMatrix();
      }
      this.camera.up.set(0, 1, 0);
      this.controls.enabled = true;
    }

    if (mode === 'fender') {
      this.camera.fov = 58;
      this.camera.updateProjectionMatrix();
      this.vehicle.getFenderCamPose(this.camera.position, _camCurrentTarget);
    } else if (mode === 'cockpit') {
      // Already posed above via getCockpitCamPose
    } else if (mode === 'gopro_rear') {
      const fov = this.vehicle.getGoProRearCamPose(
        this.camera.position,
        _camCurrentTarget,
        this.simTime,
        this.camera.aspect,
        this.lastVehicleTelemetry.boostActive,
      );
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
      const baseH = sampleTerrainHeightForBiome(this.camera.position.x, this.camera.position.z, this.config.biome);
      const surfH =
        this.config.biome === 'desert'
          ? sampleClimbableRockSurface(this.camera.position.x, this.camera.position.z, baseH).height
          : baseH;
      if (this.camera.position.y < surfH + 0.24) {
        this.camera.position.y = surfH + 0.24;
      }
    } else if (mode === 'wheel_closeup') {
      this.vehicle.getFrontLeftWheelWorldPos(_wheelFocus);
      this.camera.position.set(
        _wheelFocus.x - _vehFwd.x * 2.2 + _vehFwd.z * 1.45,
        _wheelFocus.y + 0.92,
        _wheelFocus.z - _vehFwd.z * 2.2 - _vehFwd.x * 1.45,
      );
      _camCurrentTarget.copy(_wheelFocus);
      _camCurrentTarget.y += 0.15;
    } else if (mode === 'foot_ik') {
      this.runners[0].getFocusFootWorldPos(_footFocus);
      this.camera.position.set(
        _footFocus.x + 1.85,
        _footFocus.y + 0.85,
        _footFocus.z + 1.85,
      );
      _camCurrentTarget.copy(_footFocus);
      _camCurrentTarget.y += 0.28;
    } else {
      // Dramatic 3/4 desert hero chase framing adapted cleanly for both widescreen and portrait phones
      const pAdj = computePortraitCameraAdjust(this.camera.aspect);
      const back = 7.4 + pAdj.extraBackDist;
      const side = 3.1 * pAdj.sideOffsetScale;
      const height = 3.05 + pAdj.extraHeight;
      this.camera.fov = 54 + pAdj.fovBonusDeg;
      this.camera.updateProjectionMatrix();
      this.camera.position.set(
        this.vehicle.position.x - _vehFwd.x * back + _vehFwd.z * side,
        this.vehicle.position.y + height,
        this.vehicle.position.z - _vehFwd.z * back - _vehFwd.x * side,
      );
      _camCurrentTarget.set(
        this.vehicle.position.x + _vehFwd.x * 1.4,
        this.vehicle.position.y + 0.95,
        this.vehicle.position.z + _vehFwd.z * 1.4,
      );
    }

    this.camera.lookAt(_camCurrentTarget);
    this.controls.target.copy(_camCurrentTarget);
    this.prevFollowPos.copy(this.vehicle.position);
    this.hasPrevFollowPos = true;
    this.userFreeCameraActive = mode === 'orbit';
  }

  private readManualInput(): VehicleInput {
    const up = this.keysPressed.has('KeyW') || this.keysPressed.has('ArrowUp');
    const down = this.keysPressed.has('KeyS') || this.keysPressed.has('ArrowDown');
    const left = this.keysPressed.has('KeyA') || this.keysPressed.has('ArrowLeft');
    const right = this.keysPressed.has('KeyD') || this.keysPressed.has('ArrowRight');
    const handbrake = this.keysPressed.has('Space');
    const boost =
      this.keysPressed.has('ShiftLeft') || this.keysPressed.has('ShiftRight');

    const vf = this.virtualFlags;
    const vSteer =
      Math.abs(vf.analogSteer) > 0.02
        ? Math.max(-1, Math.min(1, vf.analogSteer))
        : (vf.left ? 1 : 0) - (vf.right ? 1 : 0);
    const vThrottle = (vf.accelerate || vf.boost ? 1 : 0) - (vf.brake ? 1 : 0);

    const out = this.manualInputScratch;
    out.throttle = Math.max(-1, Math.min(1, (up ? 1 : 0) - (down ? 1 : 0) + vThrottle));
    out.steer = Math.max(-1, Math.min(1, (left ? 1 : 0) - (right ? 1 : 0) + vSteer));
    out.handbrake = handbrake || vf.handbrake;
    out.boost = boost || vf.boost;
    return out;
  }

  // Bound zero-GC simulation callbacks (replaces 4 closure allocations per frame)
  private readonly handleEmitRoost = (
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    intensity: number,
  ): void => {
    if (this.isWarmupStep) return;
    const isMudBiome = this.config.biome === 'mud_grass';
    const grainCount = Math.max(
      1,
      Math.min(isMudBiome ? 10 : 8, Math.round(intensity * (isMudBiome ? 7 : 6))),
    );
    for (let k = 0; k < grainCount; k++) {
      this.roostParticles.emit(
        x + (Math.random() - 0.5) * 0.20,
        y + Math.random() * 0.06,
        z + (Math.random() - 0.5) * 0.20,
        vx + (Math.random() - 0.5) * 1.9,
        vy + Math.random() * 1.15,
        vz + (Math.random() - 0.5) * 1.9,
        this.simTime,
        (isMudBiome ? 0.36 : 0.42) + Math.random() * 0.34,
        (isMudBiome ? 0.032 : 0.020) + Math.random() * (isMudBiome ? 0.036 : 0.024),
      );
    }
  };

  private readonly handleEmitSmoke = (sig: VehicleSmokeSignal): void => {
    if (this.isWarmupStep) return;
    const p = this.smokePuffScratch;
    p.x = sig.x;
    p.y = sig.y;
    p.z = sig.z;
    p.vx = sig.vx;
    p.vy = sig.vy;
    p.vz = sig.vz;
    p.spawnTime = this.simTime;
    p.lifetime = sig.lifetime;
    p.baseSize = sig.baseSize;
    p.type = sig.type;
    p.opacity = sig.opacity;
    p.growthMult = sig.growthMult;
    p.spinRate = sig.spinRate;
    this.smokeSystem.emitPuff(p);
  };

  private readonly handleEmitSpark = (sig: VehicleSparkSignal): void => {
    if (this.isWarmupStep) return;
    this.sparkParticles.emit(
      sig.x,
      sig.y,
      sig.z,
      sig.vx,
      sig.vy,
      sig.vz,
      this.simTime,
      0.24 + Math.random() * 0.32,
      (0.025 + Math.random() * 0.025) * (0.7 + sig.intensity * 0.5),
    );
  };

  private readonly handleCrashAudio = (sig: VehicleCrashAudioSignal): void => {
    if (this.isWarmupStep) return;
    this.audio.triggerCrashImpact(sig.severity, sig.onRock, sig.glassCracked);
  };

  private stepSimulation(rawDt: number, isWarmup = false): void {
    const dt = Math.min(0.033, Math.max(0.00025, rawDt)) * this.config.timeScale;
    this.simTime += dt;
    this.isWarmupStep = isWarmup;

    const windRad = THREE.MathUtils.degToRad(this.config.windAngleDeg);
    _windDirVec.set(Math.cos(windRad), Math.sin(windRad)).normalize();

    // === 1. CPU TERRAMECHANICS + VEHICLE + 4 FOOT-IK RUNNERS (Budget <= 0.15 ms) ===
    const cpuStart = performance.now();
    this.brushEncoder.clear();
    this.terramechanics.tickAging(dt, this.config.windSpeed);

    const manualInput = this.readManualInput();
    const vehicleInput = this.vehicle.resolveInput(
      this.config.stressMode,
      manualInput,
      dt,
    );
    this.lastActiveInput = vehicleInput;

    Object.assign(
      this.lastVehicleTelemetry,
      this.vehicle.step(
        dt,
        vehicleInput,
        this.config.stressMode,
        this.config.moisture,
        this.terramechanics,
        this.brushEncoder,
        this.handleEmitRoost,
        this.handleEmitSmoke,
        this.config.biome,
        this.config.driveMode,
        this.config.tirePressurePsi,
        this.handleEmitSpark,
        this.handleCrashAudio,
      ),
    );

    const dmgState = this.vehicle.getDamageState();
    const isCockpitView = this.config.cameraMode === 'cockpit';
    if (!isWarmup) {
      const a = this.audioStateScratch;
      a.rpm = this.lastVehicleTelemetry.rpm;
      a.throttle = vehicleInput.throttle;
      a.speedMs = this.lastVehicleTelemetry.speedKmh / 3.6;
      a.avgSinkageM = this.lastVehicleTelemetry.avgSinkageCm / 100;
      a.avgSlip = this.lastVehicleTelemetry.avgSlipRatio;
      a.driftDeg = this.lastVehicleTelemetry.driftAngleDeg;
      a.boostActive = this.lastVehicleTelemetry.boostActive;
      a.windSpeed = this.config.windSpeed;
      a.biome = this.config.biome;
      a.isLowRange = this.config.driveMode === '4L';
      a.cabinMusicPlaying = this.cockpitState.isPlaying;
      a.cabinMediaSource = this.cockpitState.mediaSource;
      a.cabinTrackIndex = this.cockpitState.trackIndex;
      a.isCockpitView = isCockpitView;
      a.engineHealth01 = dmgState.engineHealth01;
      this.audio.update(a, dt);
    }

    // Gently spring cockpit glance offsets back toward center when not actively dragging
    if (!this.cockpitPointerDown) {
      const springBack = 1 - Math.exp(-5.0 * dt);
      this.cockpitState.lookYawRad += (0 - this.cockpitState.lookYawRad) * springBack;
      this.cockpitState.lookPitchRad += (0 - this.cockpitState.lookPitchRad) * springBack;
    }

    // Step Ford Raptor R cockpit wipers, odometer, SYNC 4 playback timer & G-force head spring
    const activeRain = this.config.biome === 'rainy_highway' ? this.config.rainIntensity : 0.0;
    const motion = this.vehicle.getCockpitMotionSignals();
    const cs = this.cockpitStepInputScratch;
    cs.speedMs = motion.speedMs;
    cs.accelForwardMs2 = motion.accelForwardMs2;
    cs.lateralG = motion.lateralG;
    cs.rainIntensity = activeRain;
    cs.suspensionBump = motion.suspensionBump;
    cs.wiperDamaged = dmgState.wiperDamaged;
    cs.ambientTempC = this.config.biome === 'rainy_highway' ? 11 : this.config.biome === 'mud_grass' ? 18 : 34;
    stepCockpitState(this.cockpitState, dt, cs);

    this.vehicle.updateCockpitVisuals(
      this.simTime,
      activeRain,
      this.cockpitState.wiperLeftAngleRad,
      this.cockpitState.wiperRightAngleRad,
      this.cockpitState.wiperWipeFreshness,
    );

    // Only redraw & upload 1024x384 / 768x512 Canvas2D cockpit displays when inside 1st-person cockpit (or warmup)
    if (isCockpitView || isWarmup) {
      const dtel = this.cockpitDisplayTelScratch;
      dtel.speedKmh = this.lastVehicleTelemetry.speedKmh;
      dtel.rpm = this.lastVehicleTelemetry.rpm;
      dtel.gear = this.lastVehicleTelemetry.gear;
      dtel.driveMode = this.config.driveMode;
      dtel.biome = this.config.biome;
      dtel.pitchDeg = this.vehicle.getPitchDeg();
      dtel.rollDeg = this.lastVehicleTelemetry.rollDeg;
      dtel.damage = dmgState;
      dtel.timeSec = this.simTime;
      this.cockpitDisplays.update(this.cockpitState, dtel, isWarmup);
    }

    // Step all 4 articulated Foot-IK runners (in pure desert driving modes keep Sahara dunes pristine unless Foot IK is active)
    let footSinkSum = 0;
    const showRunners =
      this.config.biome === 'mud_grass' ||
      this.config.stressMode === 'foot_ik_walk' ||
      this.config.cameraMode === 'foot_ik';
    const runNpcs = this.config.stressMode !== 'avalanche_park' && showRunners;
    const lodCfg = this.runnerLodConfigScratch;
    lodCfg.focusX = this.vehicle.position.x;
    lodCfg.focusZ = this.vehicle.position.z;
    lodCfg.visible = showRunners;
    for (let i = 0; i < this.runners.length; i++) {
      this.runners[i].root.visible = showRunners;
      if (runNpcs) {
        lodCfg.isFocus = this.config.cameraMode === 'foot_ik' && i === 0;
        const res = this.runners[i].step(
          dt,
          this.config.moisture,
          this.terramechanics,
          this.brushEncoder,
          this.handleEmitRoost,
          this.config.biome,
          lodCfg,
        );
        footSinkSum += res.avgFootSinkageCm;
      }
    }
    if (runNpcs && this.runners.length > 0) {
      this.lastAvgFootSinkCm = footSinkSum / this.runners.length;
    }

    const cpuElapsedMs = performance.now() - cpuStart;
    this.cpuPhysicsSmoothedMs += (cpuElapsedMs - this.cpuPhysicsSmoothedMs) * 0.12;

    const brushCount = this.brushEncoder.getCount();
    this.lastActiveBrushes = brushCount;
    if (brushCount > 0) {
      this.brushTex.needsUpdate = true;
    }

    // === 2. TOROIDAL CASCADE UPDATE + 30 Hz AMORTIZED RELAXATION + AUTO-SLEEP ===
    const focus = this.getFocusPoint(_footFocus);
    const step0 = this.cascade0.cascade.updateFocus(focus.x, focus.z);
    const step1 = this.cascade1.cascade.updateFocus(focus.x, focus.z);

    const injectedEnergy = Math.min(1.0, brushCount * 0.08);
    const si = this.sleepInputScratch;
    si.dt = dt;
    si.activeBrushCount = brushCount;
    si.cascadeMoved = step0.moved;
    si.injectedEnergy = injectedEnergy;
    si.windSpeed = this.config.windSpeed;
    si.autoSleepEnabled = this.config.autoSleepEnabled;
    const sleep0 = this.cascade0.sleep.update(si);
    si.cascadeMoved = step1.moved;
    const sleep1 = this.cascade1.sleep.update(si);

    // 30 Hz fixed-rate relaxation accumulator alternating Cascade 0 and Cascade 1
    this.relaxAccum += dt;
    const relaxPeriod = 1.0 / SAND_DEFAULTS.RELAXATION_HZ;
    let relaxCascade0 = false;
    let relaxCascade1 = false;
    if (this.relaxAccum >= relaxPeriod) {
      this.relaxAccum = Math.min(this.relaxAccum - relaxPeriod, relaxPeriod);
      if (this.relaxAltCascade === 0) {
        relaxCascade0 = true;
        this.relaxAltCascade = 1;
      } else {
        relaxCascade1 = true;
        this.relaxAltCascade = 0;
      }
    }

    const runC0 = !sleep0.sleeping && (brushCount > 0 || step0.moved || relaxCascade0);
    const runC1 = !sleep1.sleeping && (brushCount > 0 || step1.moved || relaxCascade1);

    // Optional hardware GPU timer query wrapping the simulation dispatches (rate-limited to ~4 Hz to avoid IPC stalls)
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    let startedSimQuery = false;
    if (
      this.timerExt &&
      !this.pendingSimQuery &&
      !isWarmup &&
      (runC0 || runC1) &&
      this.simQueryScheduler.shouldStartNewQuery(performance.now())
    ) {
      this.pendingSimQuery = gl.createQuery();
      if (this.pendingSimQuery) {
        gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, this.pendingSimQuery);
        startedSimQuery = true;
      } else {
        this.simQueryScheduler.markCompleted();
      }
    }

    // Always update Cascade 1 BEFORE Cascade 0 so newly exposed strips in Cascade 0
    // promote the freshest tracks (or 500m teleport clears) directly from Cascade 1!
    this.lastSimRenderSubmitMs = 0;
    if (runC1 || runC0) {
      const simSubmitStart = performance.now();
      if (runC1) {
        this.dispatchCascadeSim(this.cascade1, relaxCascade1, relaxPeriod * 2.0, false, null);
      }
      if (runC0) {
        this.dispatchCascadeSim(this.cascade0, relaxCascade0, relaxPeriod * 2.0, false, this.cascade1);
      }
      this.lastSimRenderSubmitMs = performance.now() - simSubmitStart;
    }

    if (startedSimQuery && this.timerExt) {
      gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    } else if (!runC0 && !runC1) {
      // Auto-sleep drops simulation GPU cost to 0.00 ms!
      this.gpuSimSmoothedMs *= 0.85;
      if (this.gpuSimSmoothedMs < 0.005) this.gpuSimSmoothedMs = 0;
    }

    this.roostParticles.flush();
    this.sparkParticles.flush();
    this.smokeSystem.flush();
  }

  private dispatchCascadeSim(
    pair: CascadeGpuPair,
    doRelax: boolean,
    relaxDt: number,
    forceZeroBrush: boolean,
    parentPair: CascadeGpuPair | null,
  ): void {
    const curr = pair.cascade.getCurrentWindow();
    const prev = pair.cascade.getPreviousWindow();
    const u = this.simMaterial.uniforms;

    u.uStateRead.value = this.getReadTarget(pair).texture;
    if (parentPair) {
      const pWin = parentPair.cascade.getCurrentWindow();
      u.uParentCascade.value = this.getReadTarget(parentPair).texture;
      u.uParentOrigin.value.set(pWin.originX, pWin.originZ);
      u.uParentSize.value = parentPair.cascade.size;
      u.uParentGuardWorld.value = parentPair.cascade.guardWorldWidth;
      u.uHasParent.value = 1.0;
    } else {
      // Bind brushTex (never the active writeTarget) to avoid any WebGL2 feedback loop
      u.uParentCascade.value = this.brushTex;
      u.uHasParent.value = 0.0;
    }
    u.uMinCurr.value.set(curr.minX, curr.minZ);
    u.uMaxCurr.value.set(curr.maxX, curr.maxZ);
    u.uMinPrev.value.set(prev.minX, prev.minZ);
    u.uMaxPrev.value.set(prev.maxX, prev.maxZ);
    u.uCascadeSize.value = pair.cascade.size;
    u.uResolution.value = pair.cascade.resolution;
    u.uGuardWorld.value = pair.cascade.guardWorldWidth;
    u.uBrushCount.value = forceZeroBrush ? 0 : this.brushEncoder.getCount();
    u.uDoRelax.value = doRelax ? 1.0 : 0.0;
    u.uRelaxDt.value = relaxDt;
    u.uTickParity.value = pair.tickParity;
    u.uAvalancheRate.value = this.config.avalancheRate;
    u.uWindSpeed.value = this.config.windSpeed;
    u.uWindDir.value.copy(_windDirVec);
    u.uMoisture.value = this.config.moisture;
    u.uBiomeMud.value = this.config.biome === 'mud_grass' ? 1.0 : 0.0;

    if (doRelax) {
      pair.tickParity = 1 - pair.tickParity;
    }

    const writeTarget = this.getWriteTarget(pair);
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(writeTarget);
    this.renderer.render(this.simScene, this.simCamera);
    this.renderer.setRenderTarget(prevTarget);

    this.swapCascade(pair);
  }

  private updateCameraAndUniforms(dt: number): void {
    const focus = this.getFocusPoint(_footFocus);
    this.vehicle.getForwardVector(_vehFwd);

    const mode = this.config.cameraMode;
    const dampK = 1 - Math.exp(-9.5 * dt);

    if (mode === 'orbit' || this.userFreeCameraActive) {
      // Carry the free orbit camera smoothly along with the moving 4x4 while preserving user angle & zoom
      if (this.hasPrevFollowPos) {
        _followDelta.subVectors(this.vehicle.position, this.prevFollowPos);
        if (_followDelta.lengthSq() > 1e-8 && _followDelta.lengthSq() < 400) {
          this.controls.target.add(_followDelta);
          this.camera.position.add(_followDelta);
        }
      }
      this.controls.update();
      // Keep free camera safely above desert dune surface
      const groundAtCam = sampleTerrainHeightForBiome(this.camera.position.x, this.camera.position.z, this.config.biome);
      if (this.camera.position.y < groundAtCam + 0.45) {
        this.camera.position.y = groundAtCam + 0.45;
      }
      _camCurrentTarget.copy(this.controls.target);
    } else {
      if (mode === 'chase') {
        const speedKmh = this.lastVehicleTelemetry.speedKmh;
        const speedT = Math.min(1, speedKmh / 145);
        const boostKick = this.lastVehicleTelemetry.boostActive ? 4.5 : 0;
        const pAdj = computePortraitCameraAdjust(this.camera.aspect);
        // Subtle FOV kick with speed + Turbo Boost + portrait mobile widening
        const targetFov = 54 + pAdj.fovBonusDeg + speedT * 9.5 + boostKick;
        if (Math.abs(this.camera.fov - targetFov) > 0.05) {
          this.camera.fov += (targetFov - this.camera.fov) * dampK;
          this.camera.updateProjectionMatrix();
        }
        const sideOffset =
          (this.config.stressMode === 'manual' ? 1.85 : 2.3) * pAdj.sideOffsetScale;
        const backDist = 7.4 + pAdj.extraBackDist + speedT * 2.1;
        _camDesiredPos.set(
          this.vehicle.position.x - _vehFwd.x * backDist + _vehFwd.z * sideOffset,
          this.vehicle.position.y + 3.05 + pAdj.extraHeight + speedT * 0.5,
          this.vehicle.position.z - _vehFwd.z * backDist - _vehFwd.x * sideOffset,
        );
        _camDesiredTarget.set(
          this.vehicle.position.x + _vehFwd.x * 1.8,
          this.vehicle.position.y + 0.96,
          this.vehicle.position.z + _vehFwd.z * 1.8,
        );
      } else if (mode === 'fender') {
        const targetFov = this.lastVehicleTelemetry.boostActive ? 63 : 58;
        if (Math.abs(this.camera.fov - targetFov) > 0.05) {
          this.camera.fov += (targetFov - this.camera.fov) * dampK;
          this.camera.updateProjectionMatrix();
        }
        this.vehicle.getFenderCamPose(_camDesiredPos, _camDesiredTarget);
      } else if (mode === 'gopro_rear') {
        const targetFov = this.vehicle.getGoProRearCamPose(
          _camDesiredPos,
          _camDesiredTarget,
          this.simTime,
          this.camera.aspect,
          this.lastVehicleTelemetry.boostActive,
        );
        if (Math.abs(this.camera.fov - targetFov) > 0.05) {
          this.camera.fov += (targetFov - this.camera.fov) * dampK;
          this.camera.updateProjectionMatrix();
        }
      } else if (mode === 'wheel_closeup') {
        if (Math.abs(this.camera.fov - 44) > 0.05) {
          this.camera.fov += (44 - this.camera.fov) * dampK;
          this.camera.updateProjectionMatrix();
        }
        this.vehicle.getFrontLeftWheelWorldPos(_wheelFocus);
        _camDesiredPos.set(
          _wheelFocus.x - _vehFwd.x * 2.15 + _vehFwd.z * 1.35,
          _wheelFocus.y + 0.88,
          _wheelFocus.z - _vehFwd.z * 2.15 - _vehFwd.x * 1.35,
        );
        _camDesiredTarget.set(_wheelFocus.x, _wheelFocus.y + 0.16, _wheelFocus.z);
      } else if (mode === 'foot_ik') {
        if (Math.abs(this.camera.fov - 42) > 0.05) {
          this.camera.fov += (42 - this.camera.fov) * dampK;
          this.camera.updateProjectionMatrix();
        }
        const r0 = this.runners[0];
        r0.getFocusFootWorldPos(_wheelFocus);
        const rSin = Math.sin(r0.heading);
        const rCos = Math.cos(r0.heading);
        _camDesiredPos.set(
          _wheelFocus.x + rCos * 1.75 - rSin * 0.95,
          _wheelFocus.y + 0.72,
          _wheelFocus.z - rSin * 1.75 - rCos * 0.95,
        );
        _camDesiredTarget.set(_wheelFocus.x, _wheelFocus.y + 0.25, _wheelFocus.z);
      } else if (mode === 'cockpit') {
        if (Math.abs(this.camera.fov - 70) > 0.05 || this.camera.near !== 0.06) {
          this.camera.fov = 70;
          this.camera.near = 0.06;
          this.camera.updateProjectionMatrix();
        }
        this.controls.enabled = false;
        this.vehicle.getCockpitCamPose(
          _camDesiredPos,
          _camDesiredTarget,
          _camUp,
          this.cockpitState.headPitchRad,
          this.cockpitState.headRollRad,
          this.cockpitState.headHeaveM,
          this.cockpitState.lookYawRad,
          this.cockpitState.lookPitchRad,
        );
        this.camera.up.copy(_camUp);
      }

      if (mode !== 'cockpit') {
        if (this.camera.near !== 0.15) {
          this.camera.near = 0.15;
          this.camera.updateProjectionMatrix();
        }
        this.camera.up.set(0, 1, 0);
        // Prevent external cameras from dipping below terrain
        const baseAtCam = sampleTerrainHeightForBiome(_camDesiredPos.x, _camDesiredPos.z, this.config.biome);
        const surfAtCam =
          mode === 'gopro_rear' && this.config.biome === 'desert'
            ? sampleClimbableRockSurface(_camDesiredPos.x, _camDesiredPos.z, baseAtCam).height
            : baseAtCam;
        const minClearance = mode === 'gopro_rear' ? 0.24 : 0.45;
        if (_camDesiredPos.y < surfAtCam + minClearance) {
          _camDesiredPos.y = surfAtCam + minClearance;
        }
      }

      const camLerp =
        mode === 'cockpit'
          ? 1.0
          : mode === 'gopro_rear'
            ? 1 - Math.exp(-26 * dt)
            : mode === 'fender'
              ? 1 - Math.exp(-20 * dt)
              : dampK;
      this.camera.position.lerp(_camDesiredPos, camLerp);
      _camCurrentTarget.lerp(_camDesiredTarget, camLerp);

      // Subtle crash trauma micro-shake on high-energy impacts & rollovers
      const trauma = this.vehicle.getCrashTrauma();
      if (trauma > 0.01) {
        const shake = trauma * trauma * (mode === 'cockpit' ? 0.08 : 0.16);
        _camCurrentTarget.x += Math.sin(this.simTime * 57.3) * shake;
        _camCurrentTarget.y += Math.cos(this.simTime * 71.9) * shake * 0.8;
      }

      this.camera.lookAt(_camCurrentTarget);
      // Keep OrbitControls target continuously synced so dragging starts smoothly with zero jump
      this.controls.target.copy(_camCurrentTarget);
    }

    this.prevFollowPos.copy(this.vehicle.position);
    this.hasPrevFollowPos = true;

    // Dynamically tighten DirectionalLight shadow frustum from quality budget & camera distance
    const budget = getGraphicsQualityBudget(
      this.config.graphicsQuality,
      this.isMobile,
      this.isSoftwareGl,
    );
    const desiredShadowExtent =
      mode === 'gopro_rear' || mode === 'cockpit' || mode === 'wheel_closeup' || mode === 'fender'
        ? budget.shadowExtentClose
        : budget.shadowExtentChase;
    if (desiredShadowExtent !== this.currentShadowExtent) {
      this.currentShadowExtent = desiredShadowExtent;
      this.lighting.setShadowExtent(desiredShadowExtent);
      this.shadowScheduler.markDirty();
    }

    const showRunnersNow =
      this.config.biome === 'mud_grass' ||
      this.config.stressMode === 'foot_ik_walk' ||
      this.config.cameraMode === 'foot_ik';
    const hasMovingRunners = showRunnersNow && this.config.stressMode !== 'avalanche_park';
    const hasActiveDebris = this.lastVehicleTelemetry.detachedCount > 0;

    // Evaluate lossless directional shadow-map cadence for BOTH Cascade 0 (near) and Cascade 1 (far ±125m)
    // BEFORE updateSun so cached shadow maps stay 100% locked to their exact world-space frustums!
    let updateShadowNow = false;
    let updateFarShadowNow = false;
    if (this.renderer.shadowMap.enabled) {
      const nowShadowMs = performance.now();
      const phi = THREE.MathUtils.degToRad(90 - this.config.sunElevationDeg);
      const theta = THREE.MathUtils.degToRad(this.config.sunAzimuthDeg);
      const sinPhi = Math.sin(phi);
      const sunDirX = sinPhi * Math.sin(theta);
      const sunDirY = Math.cos(phi);
      const sunDirZ = sinPhi * Math.cos(theta);

      const ss = this.shadowScheduleScratch;
      ss.nowMs = nowShadowMs;
      ss.vehicleX = this.vehicle.position.x;
      ss.vehicleY = this.vehicle.position.y;
      ss.vehicleZ = this.vehicle.position.z;
      ss.vehicleFwdX = _vehFwd.x;
      ss.vehicleFwdY = _vehFwd.y;
      ss.vehicleFwdZ = _vehFwd.z;
      ss.vehicleSpeedMs = this.lastVehicleTelemetry.speedKmh / 3.6;
      ss.sunDirX = sunDirX;
      ss.sunDirY = sunDirY;
      ss.sunDirZ = sunDirZ;
      ss.hasMovingRunners = hasMovingRunners;
      ss.hasActiveDebris = hasActiveDebris;
      ss.forceImmediate = this.shadowNeedsRenderThisFrame;
      updateShadowNow = this.shadowScheduler.shouldUpdate(ss);
      if (updateShadowNow) {
        this.shadowNeedsRenderThisFrame = true;
      }

      const fss = this.farShadowScheduleScratch;
      fss.nowMs = nowShadowMs;
      fss.focusX = focus.x;
      fss.focusZ = focus.z;
      fss.sunDirX = sunDirX;
      fss.sunDirY = sunDirY;
      fss.sunDirZ = sunDirZ;
      fss.forceImmediate = this.farShadowNeedsRenderThisFrame;
      updateFarShadowNow = this.farShadowScheduler.shouldUpdate(fss);
      if (updateFarShadowNow) {
        this.farShadowNeedsRenderThisFrame = true;
      }
    }

    // Track whether visible depth-writing scene geometry moved since last frame (for lossless GTAO reuse)
    const vehDepthMoved =
      Math.abs(this.vehicle.position.x - this.lastGtaoVehX) > 1e-4 ||
      Math.abs(this.vehicle.position.y - this.lastGtaoVehY) > 1e-4 ||
      Math.abs(this.vehicle.position.z - this.lastGtaoVehZ) > 1e-4 ||
      Math.abs(this.vehicle.heading - this.lastGtaoHeading) > 1e-4 ||
      this.lastVehicleTelemetry.speedKmh > 0.05;
    this.lastGtaoVehX = this.vehicle.position.x;
    this.lastGtaoVehY = this.vehicle.position.y;
    this.lastGtaoVehZ = this.vehicle.position.z;
    this.lastGtaoHeading = this.vehicle.heading;
    this.sceneGeometryDynamicThisFrame =
      vehDepthMoved || hasMovingRunners || hasActiveDebris || this.lastActiveBrushes > 0;

    // Update golden-hour sun + Shadow Cascade 0 & Cascade 1 frustums (only repositions updating cascades!)
    this.lighting.updateSun(
      this.config.sunElevationDeg,
      this.config.sunAzimuthDeg,
      focus,
      updateShadowNow,
      updateFarShadowNow,
    );

    // Update Clipmap center snapped cleanly to baseCellSize * 2 (zero vertex swim)
    const snapUnit = this.clipmapStats.baseCellSize * 2.0;
    const clipX = Math.round(focus.x / snapUnit) * snapUnit;
    const clipZ = Math.round(focus.z / snapUnit) * snapUnit;

    const w0 = this.cascade0.cascade.getCurrentWindow();
    const w1 = this.cascade1.cascade.getCurrentWindow();

    const tu = this.terrainMaterial.uniforms;
    tu.uCascade0.value = this.getReadTarget(this.cascade0).texture;
    tu.uCascade1.value = this.getReadTarget(this.cascade1).texture;
    tu.uOrigin0.value.set(w0.originX, w0.originZ);
    tu.uOrigin1.value.set(w1.originX, w1.originZ);
    tu.uClipmapCenter.value.set(clipX, clipZ);

    tu.uSunDir.value.copy(this.lighting.sunDirection);
    tu.uSunColor.value.copy(this.lighting.sunColorLinear);
    tu.uSkyColor.value.copy(this.lighting.skyColorLinear);
    tu.uGroundBounceColor.value.copy(this.lighting.groundBounceLinear);
    tu.uFogColor.value.copy(this.lighting.fogColorLinear);
    const isMud = this.config.biome === 'mud_grass';
    const isRainy = this.config.biome === 'rainy_highway';
    tu.uWindDir.value.copy(_windDirVec);
    tu.uMoisture.value = this.config.moisture;
    tu.uTime.value = this.simTime;
    tu.uBiomeMud.value = isMud ? 1.0 : 0.0;
    tu.uBiomeRainy.value = isRainy ? 1.0 : 0.0;
    tu.uRainIntensity.value = isRainy ? this.config.rainIntensity : 0.0;
    tu.uFogDensity.value = this.lighting.fog.density;

    // Update 3D Grass wind sway & dynamic vehicle/track flattening (Cascade 0 + Cascade 1 beyond 16m)
    const gp = this.grassParamsScratch;
    gp.time = this.simTime;
    gp.windDirX = _windDirVec.x;
    gp.windDirZ = _windDirVec.y;
    gp.windSpeed = this.config.windSpeed;
    gp.vehicleX = this.vehicle.position.x;
    gp.vehicleZ = this.vehicle.position.z;
    gp.cascade0Tex = this.getReadTarget(this.cascade0).texture;
    gp.origin0X = w0.originX;
    gp.origin0Z = w0.originZ;
    gp.cascade1Tex = this.getReadTarget(this.cascade1).texture;
    gp.origin1X = w1.originX;
    gp.origin1Z = w1.originZ;
    this.lighting.updateGrass(gp);

    const rc = this.rainyCorridorParamsScratch;
    rc.focusPos = focus;
    rc.cameraPos = this.camera.position;
    rc.time = this.simTime;
    rc.rainIntensity = this.config.rainIntensity;
    rc.sunDir = this.lighting.sunDirection;
    rc.fogColor = this.lighting.fogColorLinear;
    rc.brokenFenceIds = this.vehicle.getBrokenFenceIds();
    this.lighting.updateRainyCorridor(rc);

    const debugIdx =
      this.config.debugView === 'beauty'
        ? 0
        : this.config.debugView === 'toroidal_rgba'
          ? 1
          : this.config.debugView === 'normals_rnm'
            ? 2
            : 3;
    tu.uDebugView.value = debugIdx;
    tu.uGlintQuality.value = this.config.glintQuality === 'quality' ? 0 : 1;

    // Sync hero vehicle 3D pose, interactive lighting, Ray/Path-Traced GI, motorized mirrors & lower-body dust
    this.vehicle.syncCockpitLightingAndMirrors(
      this.cockpitState,
      this.config.weatherPreset,
      this.simTime,
    );
    const lamps = this.vehicle.getActiveLampPowers();
    const terrainPose = this.vehicle.getTerrainPoseData(
      tu.uVehicleFwd3D.value,
      tu.uVehicleRight3D.value,
      tu.uVehicleUp3D.value,
    );
    tu.uVehiclePos.value.copy(this.vehicle.position);
    tu.uVehicleFwd.value.set(_vehFwd.x, _vehFwd.z);
    tu.uVehicleClearanceY.value = terrainPose.clearanceY;
    tu.uVehicleUpright.value = terrainPose.upright01;
    tu.uHeadlightPower.value.set(lamps.headlightLeft, lamps.headlightRight);
    tu.uBrakeLightPower.value.set(lamps.brakeLeft, lamps.brakeRight);
    tu.uReverseLightPower.value = lamps.reverse;

    this.reflections.sharedUniforms.uChassisDust.value = this.vehicle.getChassisDustLevel();
    this.reflections.sharedUniforms.uBiomeMud.value = isMud ? 1.0 : 0.0;

    // Sync Shadow Cascade 0 (near high-res) matrix + hardware depthTexture strictly when updated
    const shadowMap = this.lighting.sunLight.shadow.map;
    if (this.renderer.shadowMap.enabled && shadowMap && shadowMap.depthTexture) {
      if (updateShadowNow || shadowMap.depthTexture !== this.lastBoundShadowTex) {
        this.lighting.sunLight.updateMatrixWorld();
        this.lighting.sunLight.shadow.updateMatrices(this.lighting.sunLight);
        const sc = this.lighting.sunLight.shadow.camera;
        _shadowProjView
          .copy(_shadowBiasMat)
          .multiply(sc.projectionMatrix)
          .multiply(sc.matrixWorldInverse);
        tu.uShadowMatrix.value.copy(_shadowProjView);
        tu.uShadowMap.value = shadowMap.depthTexture;
        tu.uShadowEnabled.value = 1.0;
        const sm = this.lighting.sunLight.shadow.mapSize;
        tu.uShadowMapSize.value.set(sm.width, sm.height);
        this.lastBoundShadowTex = shadowMap.depthTexture;
      }
    } else {
      if (this.lastBoundShadowTex !== null || tu.uShadowEnabled.value !== 0.0) {
        tu.uShadowMap.value = this.shadowFallbackRT.depthTexture;
        tu.uShadowEnabled.value = 0.0;
        this.lastBoundShadowTex = null;
      }
    }

    // Sync Shadow Cascade 1 (far ±125m low-res) matrix + hardware depthTexture strictly when updated
    const farShadowMap = this.lighting.farSunLight.shadow.map;
    if (this.renderer.shadowMap.enabled && farShadowMap && farShadowMap.depthTexture) {
      if (updateFarShadowNow || farShadowMap.depthTexture !== this.lastBoundFarShadowTex) {
        this.lighting.farSunLight.updateMatrixWorld();
        this.lighting.farSunLight.shadow.updateMatrices(this.lighting.farSunLight);
        const fsc = this.lighting.farSunLight.shadow.camera;
        _shadowProjView
          .copy(_shadowBiasMat)
          .multiply(fsc.projectionMatrix)
          .multiply(fsc.matrixWorldInverse);
        tu.uFarShadowMatrix.value.copy(_shadowProjView);
        tu.uFarShadowMap.value = farShadowMap.depthTexture;
        tu.uFarShadowEnabled.value = 1.0;
        this.lastBoundFarShadowTex = farShadowMap.depthTexture;
      }
    } else {
      if (this.lastBoundFarShadowTex !== null || tu.uFarShadowEnabled.value !== 0.0) {
        tu.uFarShadowMap.value = this.shadowFallbackRT.depthTexture;
        tu.uFarShadowEnabled.value = 0.0;
        this.lastBoundFarShadowTex = null;
      }
    }

    // Auto-cull idle GPU particle rings when all emitted grains/sparks have expired (0 draw calls & 0 vertices!)
    this.roostParticles.syncVisibility(this.simTime);
    this.sparkParticles.syncVisibility(this.simTime);

    // Update GPU Particle uniforms only when particles are alive
    const windStrength = 0.8 + this.config.windSpeed * 2.4;
    if (this.roostParticles.points.visible) {
      this.roostParticles.material.uniforms.uTime.value = this.simTime;
      this.roostParticles.material.uniforms.uWindVec.value.set(
        _windDirVec.x * windStrength,
        _windDirVec.y * windStrength,
      );
      this.roostParticles.material.uniforms.uSunColor.value.copy(
        this.lighting.sunColorLinear,
      );
      this.roostParticles.material.uniforms.uSandColor.value.setRGB(
        isMud ? 0.095 : 0.76,
        isMud ? 0.072 : 0.38,
        isMud ? 0.052 : 0.16,
      );
    }
    if (this.sparkParticles.points.visible) {
      this.sparkParticles.material.uniforms.uTime.value = this.simTime;
    }

    this.smokeSystem.material.uniforms.uDustColor.value.setRGB(
      isMud ? 0.38 : 0.80,
      isMud ? 0.36 : 0.44,
      isMud ? 0.33 : 0.21,
    );

    const se = this.smokeEnvScratch;
    se.time = this.simTime;
    se.windVecX = _windDirVec.x * windStrength;
    se.windVecZ = _windDirVec.y * windStrength;
    se.sunDir = this.lighting.sunDirection;
    se.sunColor = this.lighting.sunColorLinear;
    se.skyColor = this.lighting.skyColorLinear;
    se.groundBounce = this.lighting.groundBounceLinear;
    se.fogColor = this.lighting.fogColorLinear;
    se.fogDensity = this.lighting.fog.density;
    se.vehiclePos = this.vehicle.position;
    se.vehicleFwdX = _vehFwd.x;
    se.vehicleFwdZ = _vehFwd.z;
    se.brakeLightPower = Math.max(lamps.brakeLeft, lamps.brakeRight);
    this.smokeSystem.syncEnvironment(se);
  }

  private pollGpuQueries(): void {
    if (!this.timerExt) return;
    const pollSim = Boolean(this.pendingSimQuery) && this.simQueryScheduler.shouldPollNow();
    const pollFrame = Boolean(this.pendingFrameQuery) && this.frameQueryScheduler.shouldPollNow();
    if (!pollSim && !pollFrame) return;

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    // Defer synchronous gl.getParameter(GPU_DISJOINT_EXT) IPC until a matured query is actually ready!
    let disjointChecked = false;
    let disjoint = false;

    if (pollSim && this.pendingSimQuery) {
      const avail = gl.getQueryParameter(
        this.pendingSimQuery,
        gl.QUERY_RESULT_AVAILABLE,
      );
      if (avail) {
        if (!disjointChecked) {
          disjoint = Boolean(gl.getParameter(this.timerExt.GPU_DISJOINT_EXT));
          disjointChecked = true;
        }
        if (!disjoint) {
          const ns = gl.getQueryParameter(this.pendingSimQuery, gl.QUERY_RESULT);
          const ms = ns / 1e6;
          this.gpuSimSmoothedMs =
            this.gpuSimSmoothedMs > 0
              ? this.gpuSimSmoothedMs + (ms - this.gpuSimSmoothedMs) * 0.25
              : ms;
        }
        gl.deleteQuery(this.pendingSimQuery);
        this.pendingSimQuery = null;
        this.simQueryScheduler.markCompleted();
      }
    }

    if (pollFrame && this.pendingFrameQuery) {
      const avail = gl.getQueryParameter(
        this.pendingFrameQuery,
        gl.QUERY_RESULT_AVAILABLE,
      );
      if (avail) {
        if (!disjointChecked) {
          disjoint = Boolean(gl.getParameter(this.timerExt.GPU_DISJOINT_EXT));
          disjointChecked = true;
        }
        if (!disjoint) {
          const ns = gl.getQueryParameter(this.pendingFrameQuery, gl.QUERY_RESULT);
          const ms = ns / 1e6;
          this.gpuTotalSmoothedMs =
            this.gpuTotalSmoothedMs > 0
              ? this.gpuTotalSmoothedMs + (ms - this.gpuTotalSmoothedMs) * 0.25
              : ms;
        }
        gl.deleteQuery(this.pendingFrameQuery);
        this.pendingFrameQuery = null;
        this.frameQueryScheduler.markCompleted();
      }
    }
  }

  private clearUncappedFence(): void {
    if (!this.uncappedFenceSync) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    gl.deleteSync(this.uncappedFenceSync);
    this.uncappedFenceSync = null;
  }

  private emitTelemetryNow(): void {
    const perf = this.perfMonitor.getSnapshot();
    const liveFps = perf.sampleCount > 0 ? perf.fps : Math.round(this.fpsSmoothed);

    // Expose lightweight non-visual renderer stats for automated performance checks
    if (typeof window !== 'undefined') {
      (window as unknown as { __SAND_ENGINE_STATS__?: unknown }).__SAND_ENGINE_STATS__ = {
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        quality: this.config.graphicsQuality,
        pixelRatio: this.renderer.getPixelRatio(),
        mirrorsActive: this.reflections.getMirrorsActiveCount(),
        fps: liveFps,
        fpsUncapped: this.config.fpsUncapped,
        onePercentLowFps: perf.onePercentLowFps,
        cpuUsagePct: perf.cpuUsagePct,
        cpuWorkMs: perf.cpuWorkMs,
        jsCpuMs: perf.jsCpuMs,
        renderSubmitMs: perf.renderSubmitMs,
        gpuStallMs: perf.gpuStallMs,
        gpuUsagePct: perf.gpuUsagePct,
        gpuWorkMs: perf.gpuWorkMs,
        bottleneck: perf.bottleneck,
        backpressureGuarded: perf.backpressureGuarded,
        gtaoCadence: this.currentGtaoCadence,
      };
    }
    if (!this.onTelemetry) return;
    const w0 = this.cascade0.cascade.getCurrentWindow();
    const w1 = this.cascade1.cascade.getCurrentWindow();
    const hasGpuTimer = Boolean(this.timerExt);
    this.onTelemetry({
      fps: liveFps,
      fpsUncapped: this.config.fpsUncapped,
      perf,
      cpuPhysicsMs: this.cpuPhysicsSmoothedMs,
      gpuSimMs: hasGpuTimer ? this.gpuSimSmoothedMs : 0,
      gpuTotalMs: hasGpuTimer ? this.gpuTotalSmoothedMs : 0,
      gpuQuerySupported: hasGpuTimer,
      isSoftwareGl: this.isSoftwareGl,
      graphicsQuality: this.isSoftwareGl ? 'low' : this.config.graphicsQuality,
      mirrorsActive: this.reflections.getMirrorsActiveCount(),
      probeMode: this.reflections.getProbeModeLabel(),
      postProcessingActive: this.postProcessing.isActive(),
      activeBrushes: this.lastActiveBrushes,
      activeTracksInRing: this.terramechanics.getActiveTrackCount(),
      ringBufferCapacity: this.terramechanics.getCapacity(),
      cascadeResolution: this.cascadeResolution,
      cascade0Sleeping: this.cascade0.sleep.isSleeping(),
      cascade1Sleeping: this.cascade1.sleep.isSleeping(),
      cascade0Origin: [w0.originX, w0.originZ],
      cascade1Origin: [w1.originX, w1.originZ],
      vramMB: this.cascadeVramMB,
      clipmapStats: this.clipmapStats,
      vehicle: this.lastVehicleTelemetry,
      avgFootSinkageCm: this.lastAvgFootSinkCm,
      activeInput: Object.assign(this.activeInputTelemetryScratch, this.lastActiveInput),
      vehiclePos: [this.vehicle.position.x, this.vehicle.position.z],
    });
  }

  /**
   * Software-WebGL frame pacing using WebGL2 fenceSync + pause so headless
   * SwiftShader never starves Chromium compositing or UI events.
   */
  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameHandle = window.setTimeout(poll, 16);
      } else {
        if (sync) gl.deleteSync(sync);
        const softwareIdle =
          !this.sceneGeometryDynamicThisFrame &&
          this.keysPressed.size === 0 &&
          this.config.stressMode === 'manual';
        this.frameHandle = window.setTimeout(cb, softwareIdle ? 900 : 220);
      }
    };
    this.frameHandle = window.setTimeout(poll, 16);
  }

  private readonly tick = (): void => {
    if (this.disposed) return;

    const tickStartMs = performance.now();
    const hasPrevWallMs = this.lastTickWallMs > 0;
    const wallDeltaMs = hasPrevWallMs ? tickStartMs - this.lastTickWallMs : 16.667;
    this.lastTickWallMs = tickStartMs;

    this.frameTimer.update();
    const rawDelta = this.frameTimer.getDelta();
    // Clamp simulation dt <= 33ms so tab switches & slow frames never explode physics,
    // while lowering the floor to 0.25ms (4000 FPS) so uncapped rendering keeps exact real-time physics.
    const rawDt = Math.min(0.033, Math.max(0.00025, rawDelta > 0 ? rawDelta : 0.016));

    const instFps = 1 / Math.max(0.00025, rawDelta > 0 ? rawDelta : 0.016);
    this.fpsSmoothed += (instFps - this.fpsSmoothed) * 0.1;

    this.pollGpuQueries();
    const jsStartMs = performance.now();
    this.stepSimulation(rawDt, false);
    this.updateCameraAndUniforms(rawDt);
    const rawJsCpuMs = performance.now() - jsStartMs;
    const jsCpuMs = Math.max(0, rawJsCpuMs - this.lastSimRenderSubmitMs);

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    let startedFrameQuery = false;
    if (
      this.timerExt &&
      !this.pendingFrameQuery &&
      this.frameQueryScheduler.shouldStartNewQuery(tickStartMs)
    ) {
      this.pendingFrameQuery = gl.createQuery();
      if (this.pendingFrameQuery) {
        gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, this.pendingFrameQuery);
        startedFrameQuery = true;
      } else {
        this.frameQueryScheduler.markCompleted();
      }
    }

    const renderStartMs = performance.now();
    this.renderMainScene(false);
    const renderSubmitMs = (performance.now() - renderStartMs) + this.lastSimRenderSubmitMs;

    if (startedFrameQuery && this.timerExt) {
      gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    }

    const baseQualityWeight =
      this.config.graphicsQuality === 'ultra'
        ? 0.86
        : this.config.graphicsQuality === 'hybrid'
          ? 0.56
          : 0.28;
    const mirrorWeight = this.reflections.getMirrorsActiveCount() * 0.06;
    const ppWeight = this.postProcessing.isActive() ? 0.1 : 0.0;
    const prWeight = Math.min(
      0.14,
      Math.max(0, (this.renderer.getPixelRatio() - 1) * 0.12),
    );
    const gpuLoadHint = Math.min(
      1.0,
      baseQualityWeight + mirrorWeight + ppWeight + prWeight,
    );
    const hwGpuMs =
      this.timerExt && this.gpuTotalSmoothedMs > 0
        ? this.gpuTotalSmoothedMs
        : null;
    const uncappedRequested =
      !this.isSoftwareGl &&
      this.config.fpsUncapped &&
      !document.hidden &&
      this.uncapChannel !== null;

    const ps = this.pacingSampleScratch;
    ps.frameDeltaMs = wallDeltaMs;
    ps.jsCpuMs = jsCpuMs;
    ps.renderSubmitMs = renderSubmitMs;
    ps.gpuHardwareMs = hwGpuMs;
    ps.uncappedRequested = uncappedRequested;
    ps.isSoftwareGl = this.isSoftwareGl;
    ps.documentHidden = document.hidden;
    ps.graphicsQuality = this.config.graphicsQuality;
    const decision = this.pacingGovernor.evaluate(ps);
    this.currentGtaoCadence = decision.gtaoCadence;

    const effectiveUncapped = decision.scheduleMode === 'message_channel';

    if (hasPrevWallMs) {
      const pf = this.perfFrameScratch;
      pf.frameDeltaMs = wallDeltaMs;
      pf.cpuWorkMs = decision.trueCpuWorkMs;
      pf.jsCpuMs = jsCpuMs;
      pf.renderSubmitMs = renderSubmitMs;
      pf.gpuStallMs = decision.estimatedGpuStallMs;
      pf.gpuFrameMs = hwGpuMs;
      pf.uncappedMode = effectiveUncapped;
      pf.gpuLoadHint = gpuLoadHint;
      pf.bottleneck = decision.bottleneck;
      pf.backpressureGuarded = decision.backpressureGuarded;
      this.perfMonitor.recordFrame(pf);
    }

    // Throttle React telemetry updates to ~6 Hz (never per-frame setState at 120-400+ FPS!)
    this.telemetryAccum += Math.min(0.1, wallDeltaMs * 0.001);
    if (this.telemetryAccum >= 0.16) {
      this.telemetryAccum = 0;
      this.emitTelemetryNow();
    }

    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else if (effectiveUncapped && this.uncapChannel) {
      // Non-blocking WebGL2 fenceSync check ensures at most 1 GPU frame is queued in MessageChannel mode,
      // preventing Chromium command-buffer flooding & synchronous 40ms stalls!
      let fenceAction: 'proceed_uncapped' | 'yield_to_raf' = 'proceed_uncapped';
      if (this.uncappedFenceSync) {
        const status = gl.getSyncParameter(this.uncappedFenceSync, gl.SYNC_STATUS);
        const signaled = status === gl.SIGNALED;
        if (signaled) {
          gl.deleteSync(this.uncappedFenceSync);
          this.uncappedFenceSync = null;
        }
        fenceAction = this.inFlightFenceLimiter.evaluateFenceStatus(signaled);
      }

      if (fenceAction === 'proceed_uncapped') {
        if (!this.uncappedFenceSync) {
          this.uncappedFenceSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        }
        if (!this.uncapScheduled) {
          this.uncapScheduled = true;
          this.uncapChannel.port2.postMessage(null);
        }
      } else {
        this.frameHandle = requestAnimationFrame(this.tick);
      }
    } else {
      this.clearUncappedFence();
      this.frameHandle = requestAnimationFrame(this.tick);
    }
  };

  private readonly handleResize = (): void => {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const pr = computeEffectivePixelRatio(
      w,
      window.devicePixelRatio || 1,
      this.isSoftwareGl,
      this.config.graphicsQuality,
    );
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.postProcessing.resize(w, h);
    this.roostParticles.material.uniforms.uPixelRatio.value = pr;
    this.sparkParticles.material.uniforms.uPixelRatio.value = pr;
    this.cachedCanvasRect = this.renderer.domElement.getBoundingClientRect();
    this.renderMainScene(false);
  };

  private readonly handleAudioUnlock = (): void => {
    this.audio.unlockFromGesture();
  };

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    this.audio.unlockFromGesture();
    const driveKeys = [
      'KeyW',
      'KeyA',
      'KeyS',
      'KeyD',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Space',
      'ShiftLeft',
      'ShiftRight',
    ];
    if (driveKeys.includes(e.code)) {
      if (
        e.code === 'Space' ||
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight'
      ) {
        e.preventDefault();
      }
      this.keysPressed.add(e.code);
      if (this.config.stressMode !== 'manual') {
        this.config.stressMode = 'manual';
        this.onManualOverride?.();
      }
      return;
    }

    if (e.code === 'KeyF' && !e.repeat) {
      this.rightVehicle();
      return;
    }

    if (e.code === 'KeyR' && !e.repeat) {
      this.resetVehicle();
      return;
    }

    if (e.code === 'KeyC' && !e.repeat) {
      this.cycleCamera();
      return;
    }

    if (e.code === 'KeyV' && !e.repeat) {
      this.cockpitState.wiperMode = cycleWiperMode(this.cockpitState.wiperMode);
      this.config.wiperMode = this.cockpitState.wiperMode;
      this.cockpitState.screenDirty = true;
      this.onConfigSync?.({ wiperMode: this.config.wiperMode });
      return;
    }

    if (e.code === 'KeyK' && !e.repeat) {
      this.cockpitState.headlightMode = cycleHeadlightMode(this.cockpitState.headlightMode);
      this.cockpitState.screenDirty = true;
      this.audio.playUiClick();
    }
  };

  private readonly handleKeyUp = (e: KeyboardEvent): void => {
    this.keysPressed.delete(e.code);
  };

  private readonly handleWindowBlur = (): void => {
    this.keysPressed.clear();
    this.virtualFlags = { ...EMPTY_VIRTUAL_FLAGS };
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) {
      this.keysPressed.clear();
      this.virtualFlags = { ...EMPTY_VIRTUAL_FLAGS };
    } else {
      this.frameTimer.reset();
      this.lastTickWallMs = 0;
    }
  };

  private readonly handleCanvasContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private readonly handleOrbitStart = (): void => {
    this.userFreeCameraActive = true;
    this.prevFollowPos.copy(this.vehicle.position);
    this.hasPrevFollowPos = true;
    this.renderer.domElement.style.cursor = 'grabbing';
  };

  private readonly handleOrbitEnd = (): void => {
    this.renderer.domElement.style.cursor = 'grab';
  };

  private readonly handleCanvasWheel = (): void => {
    this.userFreeCameraActive = true;
    this.prevFollowPos.copy(this.vehicle.position);
    this.hasPrevFollowPos = true;
  };

  private readonly handleCockpitPointerDown = (e: PointerEvent): void => {
    if (this.config.cameraMode !== 'cockpit') return;
    this.cockpitPointerDown = true;
    this.cockpitPointerDragged = false;
    this.cockpitDownX = e.clientX;
    this.cockpitDownY = e.clientY;
  };

  private readonly handleCockpitPointerMove = (e: PointerEvent): void => {
    if (this.config.cameraMode !== 'cockpit') return;

    if (this.cockpitPointerDown) {
      const dx = e.clientX - this.cockpitDownX;
      const dy = e.clientY - this.cockpitDownY;
      if (Math.hypot(dx, dy) > 6) {
        this.cockpitPointerDragged = true;
      }
      if (this.cockpitPointerDragged) {
        this.cockpitState.lookYawRad = Math.max(-0.48, Math.min(0.48, -dx * 0.0028));
        this.cockpitState.lookPitchRad = Math.max(-0.22, Math.min(0.24, -dy * 0.0022));
        this.renderer.domElement.style.cursor = 'grabbing';
        return;
      }
    }

    // Throttle hover raycast to ~30 Hz using cached DOMRect & pre-built target list (zero layout thrash/GC)
    const now = performance.now();
    if (now - this.lastCockpitHoverMs < 33) return;
    this.lastCockpitHoverMs = now;

    const rect = this.cachedCanvasRect ?? (this.cachedCanvasRect = this.renderer.domElement.getBoundingClientRect());
    if (rect.width > 0 && rect.height > 0) {
      this.pointerNdc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      const hits = this.raycaster.intersectObjects(this.cockpitRaycastTargets, false);
      this.renderer.domElement.style.cursor =
        hits.length > 0 ? 'pointer' : this.cockpitPointerDown ? 'grabbing' : 'grab';
    }
  };

  private readonly handleCockpitPointerUp = (e: PointerEvent): void => {
    if (!this.cockpitPointerDown) return;
    const wasDrag = this.cockpitPointerDragged;
    this.cockpitPointerDown = false;
    this.cockpitPointerDragged = false;

    if (this.config.cameraMode !== 'cockpit' || wasDrag) return;
    const rect = this.cachedCanvasRect ?? (this.cachedCanvasRect = this.renderer.domElement.getBoundingClientRect());
    if (rect.width <= 0 || rect.height <= 0) return;

    this.pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const cockpitRig = this.vehicle.getCockpitRig();

    // 1. Check 12" SYNC 4 Touchscreen hit first
    const screenHits = this.raycaster.intersectObject(cockpitRig.syncScreenMesh, false);
    let res =
      screenHits.length > 0 && screenHits[0].uv
        ? handleSyncScreenTouchUV(this.cockpitState, screenHits[0].uv.x, screenHits[0].uv.y)
        : null;

    // 2. Otherwise check physical 3D overhead upfitter switches (Headlights / Lightbar / Hazard / Dome / Ambient)
    if (!res) {
      const swHits = this.raycaster.intersectObjects(this.cockpitSwitchMeshes, false);
      if (swHits.length > 0) {
        const matched = cockpitRig.interactiveSwitches.find((s) => s.mesh === swHits[0].object);
        if (matched) {
          res = handleCabinSwitchAction(this.cockpitState, matched.id);
        }
      }
    }

    if (res && res.hit) {
      this.audio.playUiClick();
      const syncPatch: Partial<SandRuntimeConfig> = {};
      if (res.toggleWipers) {
        this.config.wiperMode = this.cockpitState.wiperMode;
        syncPatch.wiperMode = this.config.wiperMode;
      }
      if (res.toggleDriveMode) {
        this.config.driveMode = this.config.driveMode === '4H' ? '4L' : '4H';
        syncPatch.driveMode = this.config.driveMode;
      }
      if (Object.keys(syncPatch).length > 0) {
        this.onConfigSync?.(syncPatch);
      }
      if (res.triggerRepair) {
        this.resetVehicle();
      }
      this.vehicle.syncCockpitLightingAndMirrors(
        this.cockpitState,
        this.config.weatherPreset,
        this.simTime,
      );
      this.cockpitDisplayTelScratch.speedKmh = this.lastVehicleTelemetry.speedKmh;
      this.cockpitDisplayTelScratch.rpm = this.lastVehicleTelemetry.rpm;
      this.cockpitDisplayTelScratch.gear = this.lastVehicleTelemetry.gear;
      this.cockpitDisplayTelScratch.driveMode = this.config.driveMode;
      this.cockpitDisplayTelScratch.biome = this.config.biome;
      this.cockpitDisplayTelScratch.pitchDeg = this.vehicle.getPitchDeg();
      this.cockpitDisplayTelScratch.rollDeg = this.lastVehicleTelemetry.rollDeg;
      this.cockpitDisplayTelScratch.damage = this.vehicle.getDamageState();
      this.cockpitDisplayTelScratch.timeSec = this.simTime;
      this.cockpitDisplays.update(this.cockpitState, this.cockpitDisplayTelScratch, true);
      if (!this.isSoftwareGl) {
        this.renderMainScene(false);
      }
    }
  };

  private readonly handleContextLost = (e: Event): void => {
    e.preventDefault();
  };

  public dispose(): void {
    this.disposed = true;
    this.unsubscribePreload?.();
    this.unsubscribePreload = null;
    cancelAnimationFrame(this.frameHandle);
    clearTimeout(this.frameHandle);
    if (this.uncapChannel) {
      this.uncapChannel.port1.onmessage = null;
      this.uncapChannel.port1.close();
      this.uncapChannel.port2.close();
      this.uncapChannel = null;
    }

    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleWindowBlur);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('pointerdown', this.handleAudioUnlock);
    this.renderer.domElement.removeEventListener('pointerdown', this.handleCockpitPointerDown);
    window.removeEventListener('pointermove', this.handleCockpitPointerMove);
    window.removeEventListener('pointerup', this.handleCockpitPointerUp);
    this.controls.removeEventListener('start', this.handleOrbitStart);
    this.controls.removeEventListener('end', this.handleOrbitEnd);
    this.renderer.domElement.removeEventListener('wheel', this.handleCanvasWheel);
    this.renderer.domElement.removeEventListener(
      'webglcontextlost',
      this.handleContextLost,
    );
    this.renderer.domElement.removeEventListener(
      'contextmenu',
      this.handleCanvasContextMenu,
    );
    this.cockpitDisplays.dispose();

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.clearUncappedFence();
    if (this.pendingSimQuery) {
      gl.deleteQuery(this.pendingSimQuery);
      this.pendingSimQuery = null;
    }
    if (this.pendingFrameQuery) {
      gl.deleteQuery(this.pendingFrameQuery);
      this.pendingFrameQuery = null;
    }

    this.controls.dispose();
    this.audio.dispose();
    this.cascade0.rtA.dispose();
    this.cascade0.rtB.dispose();
    this.cascade1.rtA.dispose();
    this.cascade1.rtB.dispose();
    this.brushTex.dispose();
    this.simQuadGeo.dispose();
    this.simMaterial.dispose();
    this.clipmapGeo.dispose();
    const activeGrainTex = this.terrainMaterial.uniforms.uSandGrainTex.value as THREE.Texture | null;
    const activeMacroTex = this.terrainMaterial.uniforms.uSandMacroTex.value as THREE.Texture | null;
    activeGrainTex?.dispose();
    activeMacroTex?.dispose();
    if (this.pendingSandGrainTex && this.pendingSandGrainTex !== activeGrainTex) {
      this.pendingSandGrainTex.dispose();
    }
    if (this.pendingSandMacroTex && this.pendingSandMacroTex !== activeMacroTex) {
      this.pendingSandMacroTex.dispose();
    }
    this.pendingSandGrainTex = null;
    this.pendingSandMacroTex = null;
    (this.terrainMaterial.uniforms.uMudDetailTex.value as THREE.Texture | null)?.dispose();
    this.terrainMaterial.dispose();
    this.terrainDepthMaterial.dispose();
    this.shadowFallbackRT.depthTexture?.dispose();
    this.shadowFallbackRT.dispose();
    this.reflections.dispose();
    this.postProcessing.dispose();
    this.vehicle.dispose();
    for (const r of this.runners) r.dispose();
    this.roostParticles.dispose();
    this.sparkParticles.dispose();
    this.smokeSystem.dispose();
    this.lighting.dispose();

    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
