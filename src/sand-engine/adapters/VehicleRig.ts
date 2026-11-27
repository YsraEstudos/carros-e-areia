/**
 * VehicleRig.ts
 * Interactive 4x4 Desert Expedition Pickup with:
 *  - Bekker/SCM sand terramechanics & 4L/4H powertrain
 *  - Genuine 6-DOF rollover & side/roof tumble physics (sharp high-speed turns tip & flip!)
 *  - BeamNG-style real-time soft-body vertex deformation & paint scrape damage
 *  - Breakaway detachable rigid-body parts (bumpers, hood, mirrors, spare tire, lightbar, boards)
 *  - Metallic impact sparks, cracked glass, bent wheel camber/wobble & crash audio hooks
 */

import * as THREE from 'three';
import {
  sampleBaseTerrain,
  sampleTerrainHeightForBiome,
} from '../core/TerrainHeightfield';
import {
  CockpitRuntimeState,
  computeHazardFlash01,
  getActiveAmbientPreset,
} from '../core/CockpitStateModel';
import {
  computeWetHighwayGripInto,
  getRainyHighwayObstaclesNear,
  HighwayPotholeSample,
  isOnPavedHighway,
  resolveVehicleCapsuleHighwayCollision,
  sampleHighwayPotholeInto,
  WetHighwayGripResult,
} from '../core/RainyHighwayModel';
import {
  computeTireContactLead,
  computeTireFootprintScaleInto,
  SandTerramechanics,
  TireFootprintScale,
  WheelContactInput,
  WheelContactResult,
} from '../core/SandTerramechanics';
import { BrushEncoder, BrushType, SandBrushInput } from '../core/BrushEncoder';
import {
  DriveMode,
  EnvironmentBiome,
  GraphicsQuality,
  StressTestMode,
  WEATHER_PRESET_SPECS,
  WeatherPreset,
} from '../core/SandParams';
import { getGraphicsQualityBudget } from '../core/GraphicsQualityBudget';
import {
  ClimbableRockSample,
  DESERT_ROCK_OBSTACLES,
  resolveRockCollisionsInto,
  RockCollisionOptions,
  RockCollisionResult,
  sampleClimbableRockSurfaceInto,
} from '../core/DesertObstacles';
import {
  computeGoProRearCamLocalPose,
  computeSteeringWheelVisualAngleRad,
  DriveStepInput,
  evaluateVehicleDriveStep,
  VehicleControlInput,
} from '../core/VehicleDriveModel';
import {
  applyImpactToDamageState,
  applyPotholeSuspensionImpact,
  classifyImpactZone,
  CrashImpactEvent,
  createInitialDamageState,
  createInitialRolloverState,
  deformSubmeshVertices,
  DetachablePartId,
  LateralRollInput,
  localVectorXZToWorld,
  MechanicalDamageOutput,
  RolloverPhysicsState,
  stepMechanicalDamage,
  stepRolloverDynamics,
  VehicleDamageState,
} from '../core/VehicleCrashPhysics';
import {
  computeExpSmoothingFactor,
  createInitialSuspensionState,
  evaluateTireCorneringAndYaw,
  rotateBodyVelocityByHeadingDelta,
  snapSuspensionToGround,
  stepSuspensionDynamics,
  SuspensionState,
  SuspensionStepInput,
  SuspensionWheelCorner,
  TireLateralInput,
} from '../core/VehicleSuspensionPhysics';
import {
  TrophyTruckVisuals,
  WheelMountSpec,
} from './VehicleMeshBuilder';
import {
  buildRivianTruckVisuals,
  RIVIAN_TIRE_RADIUS,
  RIVIAN_TIRE_WIDTH,
  RIVIAN_TRACK_HALF,
  RIVIAN_WHEELBASE_HALF,
} from './RivianVehicleBuilder';
import { RaptorCockpitRig } from './RaptorCockpitBuilder';
import {
  MirrorAnchorInfo,
  ReflectionSharedUniforms,
} from './VehicleReflectionSystem';
import {
  computeWheelSmokeEmission,
  SmokeLayerType,
  WheelSmokeSampleInput,
} from '../core/SmokePhysics';
import {
  consumeLodStepDt,
  createLodCadenceState,
  LodCadenceState,
  selectSimulationTier,
} from '../core/SimulationLod';

export type VehicleInput = VehicleControlInput;

export interface VehicleSmokeSignal {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  type: SmokeLayerType;
  baseSize: number;
  lifetime: number;
  opacity: number;
  growthMult: number;
  spinRate: number;
}

export interface VehicleSparkSignal {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  intensity: number;
}

export interface VehicleCrashAudioSignal {
  severity: number;
  onRock: boolean;
  glassCracked: boolean;
}

export interface WheelRuntimeState {
  name: string;
  localOffset: THREE.Vector3;
  isFront: boolean;
  isLeft: boolean;
  worldPos: THREE.Vector3;
  prevWorldPos: THREE.Vector3;
  hasPrevPos: boolean;
  spinAngle: number;
  treadPhase: number;
  prevTreadPhase: number;
  steerAngle: number;
  sinkage: number;
  trackCompaction: number;
  slipRatio: number;
  lateralSlipRad: number;
  contact: WheelContactResult;
  steerPivot: THREE.Group;
  camberGroup: THREE.Group;
  spinMesh: THREE.Group;
  lowerArm: THREE.Mesh;
  upperArm: THREE.Mesh;
  coilGroup: THREE.Group;
}

export interface VehicleTelemetry {
  speedKmh: number;
  avgSinkageCm: number;
  maxSinkageCm: number;
  avgSlipRatio: number;
  trackCompactionPct: number;
  rollingDragN: number;
  bulldozingN: number;
  driftAngleDeg: number;
  gear: string;
  rpm: number;
  boostActive: boolean;
  braking: boolean;
  integrityPct: number;
  rollDeg: number;
  isTipping: boolean;
  isRolledOver: boolean;
  rollCount: number;
  detachedCount: number;
  windshieldCrackLevel: 0 | 1 | 2;
}

interface DetachedDebrisPiece {
  partId: DetachablePartId;
  object: THREE.Object3D;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  age: number;
  settled: boolean;
}

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _quatTerrain = new THREE.Quaternion();
const _quatRollPitch = new THREE.Quaternion();
const _eulerRollPitch = new THREE.Euler(0, 0, 0, 'YXZ');
const _matBasis = new THREE.Matrix4();
const _wheelWorld = new THREE.Vector3();
const _wheelFwd = new THREE.Vector3();
const _debrisQuat = new THREE.Quaternion();
const _debrisEuler = new THREE.Euler();
const _roofSlideWorld = new THREE.Vector3();
const _deformLocalPt = new THREE.Vector3();
const _deformLocalNorm = new THREE.Vector3();
const _deformNormMat = new THREE.Matrix3();
const _debrisSpawnPos = new THREE.Vector3();
const _debrisSpawnQuat = new THREE.Quaternion();

const DETACHABLE_PART_KEYS: readonly DetachablePartId[] = [
  'frontBumper',
  'frontGrille',
  'rearBumper',
  'tailgate',
  'hood',
  'leftMirror',
  'rightMirror',
  'leftStep',
  'rightStep',
  'spareTire',
  'roofBoards',
  'lightBar',
];

export class VehicleRig {
  public readonly root = new THREE.Group();
  public readonly bodyGroup: THREE.Group;
  public readonly debrisContainer = new THREE.Group();
  public readonly wheels: WheelRuntimeState[] = [];

  public readonly position = new THREE.Vector3(0, 0, 0);
  public readonly velocity = new THREE.Vector3(0, 0, 0);
  public heading = 0.35;
  public yawRate = 0;

  private readonly tireRadius = RIVIAN_TIRE_RADIUS;
  private readonly tireWidth = RIVIAN_TIRE_WIDTH;
  private readonly wheelBaseHalf = RIVIAN_WHEELBASE_HALF;
  private readonly trackHalf = RIVIAN_TRACK_HALF;
  private readonly cgHeightM = 0.86;
  private readonly sprungMassKg = 3100;
  private readonly unsprungMassKg = 55;
  private readonly chassisMassKg = 3320;

  private prevVForward = 0;
  private steerSmoothed = 0;
  private whipPitch = 0;
  private whipRoll = 0;
  private autopilotTime = 0;
  private sprintResetDist = 0;
  private readonly wheelDustAccum = [0, 0, 0, 0];
  private readonly wheelDriftAccum = [0, 0, 0, 0];
  private readonly wheelNormalLoads = [0, 0, 0, 0];
  private readonly wheelOmegas = [0, 0, 0, 0];
  private readonly wheelGroundHeights = [0, 0, 0, 0];
  private readonly wheelOnRock = [0, 0, 0, 0];
  private lastBiome: EnvironmentBiome = 'desert';
  private lastTirePressurePsi = 22;
  private lastRearLeftTravelY = 0;
  private roofScrapeDustAccum = 0;
  private roofScrapeSparkAccum = 0;
  private crashTrauma = 0;
  private prevRolloverActive = false;

  private rollover: RolloverPhysicsState = createInitialRolloverState();
  private suspension: SuspensionState = createInitialSuspensionState(0, 0.86, RIVIAN_TIRE_RADIUS, 3100, 55);
  private damage: VehicleDamageState = createInitialDamageState();
  private readonly suspensionCorners: readonly [
    SuspensionWheelCorner,
    SuspensionWheelCorner,
    SuspensionWheelCorner,
    SuspensionWheelCorner,
  ] = [
    { lx: RIVIAN_TRACK_HALF, lz: RIVIAN_WHEELBASE_HALF, isFront: true, isLeft: true },
    { lx: -RIVIAN_TRACK_HALF, lz: RIVIAN_WHEELBASE_HALF, isFront: true, isLeft: false },
    { lx: RIVIAN_TRACK_HALF, lz: -RIVIAN_WHEELBASE_HALF, isFront: false, isLeft: true },
    { lx: -RIVIAN_TRACK_HALF, lz: -RIVIAN_WHEELBASE_HALF, isFront: false, isLeft: false },
  ];
  private readonly wheelSurfHeights: [number, number, number, number] = [0, 0, 0, 0];
  private readonly wheelOnRockArr: [number, number, number, number] = [0, 0, 0, 0];
  private readonly wheelSlipArr: [number, number, number, number] = [0, 0, 0, 0];
  private readonly debrisPieces: DetachedDebrisPiece[] = [];
  private readonly visuals: TrophyTruckVisuals;

  private pendingCrashSparkQueue: VehicleSparkSignal[] = [];
  private pendingCrashAudioQueue: VehicleCrashAudioSignal[] = [];
  private readonly pendingNormalRecomputeQueue: THREE.BufferGeometry[] = [];
  private lastHeadlightPower: [number, number] = [0.22, 0.22];
  private lastBrakeLightPower: [number, number] = [0.22, 0.22];
  private lastReverseLightPower = 0;
  private chassisDustLevel = 0.16;
  private lastWeatherPreset: WeatherPreset = 'golden_hour';
  private lastHeadlightWeatherKey = '';
  private lastCenterGroundY = 0;
  private lastBoundEnvMap: THREE.Texture | null | undefined = undefined;
  private lastBoundMaterialCount = -1;
  private readonly brokenFenceIds = new Set<string>();
  private lastLongAccel = 0;
  private lastLatG = 0;
  private lastSuspBump = 0;
  private hoodSteamAccum = 0;
  private mechClockSec = 0;
  private readonly potholeImpactCooldowns: [number, number, number, number] = [0, 0, 0, 0];
  private lastMechOutput: MechanicalDamageOutput = {
    powerScale: 1,
    steamIntensity: 0,
    overheated: false,
    misfireActive: false,
    flatTireDrag: 0,
    steeringPullRad: 0,
    steeringShakeAmp: 0,
  };

  private readonly debrisLodState: LodCadenceState = createLodCadenceState();
  private readonly surfaceScratch: ClimbableRockSample = { height: 0, rockElevation: 0, onRock: 0 };
  private readonly rolloverSurfaceScratch: ClimbableRockSample = { height: 0, rockElevation: 0, onRock: 0 };
  private readonly footprintScratch: TireFootprintScale = { widthScale: 1, lengthScale: 1, tractionBonus: 0 };
  private readonly wheelContactInputScratch: WheelContactInput = {
    worldX: 0,
    worldZ: 0,
    normalLoadN: 0,
    tireWidth: RIVIAN_TIRE_WIDTH,
    tireRadius: RIVIAN_TIRE_RADIUS,
    slipRatio: 0,
    lateralSlipRad: 0,
    moisture: 0.15,
    biome: 'desert',
    tirePressurePsi: 22,
  };
  private readonly wheelContactResScratch: WheelContactResult = {
    sinkage: 0,
    trackCompaction: 0,
    rollingResistanceN: 0,
    bulldozingForceN: 0,
    tractionFactor: 0.85,
  };
  private readonly wetGripScratch: WetHighwayGripResult = {
    lateralGripScale: 0.92,
    rollingDragScale: 0.34,
    inPotholeWater: false,
  };
  private readonly highwayGripScratch: WetHighwayGripResult = {
    lateralGripScale: 0.92,
    rollingDragScale: 0.34,
    inPotholeWater: false,
  };
  private readonly potholeScratch: HighwayPotholeSample = {
    depthM: 0,
    mask01: 0,
    crackRim01: 0,
    waterFill01: 0,
  };
  private readonly rockColOptionsScratch: RockCollisionOptions = {
    dt: 1 / 60,
    vehicleMinY: 0,
    vehicleMaxY: 2.18,
    sampleGroundY: (rx: number, rz: number) => sampleTerrainHeightForBiome(rx, rz, this.lastBiome),
  };
  private readonly rockColOutScratch: RockCollisionResult = {
    collided: false,
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    impactSpeed: 0,
    normalX: 0,
    normalZ: 0,
    hitX: 0,
    hitZ: 0,
  };
  private readonly crashEventScratch: CrashImpactEvent = {
    zone: 'front',
    localPointX: 0,
    localPointY: 0,
    localPointZ: 0,
    localNormalX: 0,
    localNormalY: 0,
    localNormalZ: 0,
    worldPointX: 0,
    worldPointY: 0,
    worldPointZ: 0,
    impulseSpeedMs: 0,
    severity: 0,
    onRock: false,
    wheelIndex: -1,
  };
  private readonly driveInputScratch: DriveStepInput = {
    control: { throttle: 0, steer: 0, handbrake: false, boost: false },
    vForwardMs: 0,
    isSprintPreset: false,
    driveMode: '4H',
  };
  private readonly tireCorneringInputScratch: TireLateralInput = {
    dt: 1 / 60,
    massKg: 3320,
    yawInertiaKgM2: 8800,
    vForwardMs: 0,
    vLateralMs: 0,
    yawRateRadS: 0,
    steerAngleRad: 0,
    corners: this.suspensionCorners,
    normalLoadN: this.suspension.normalLoadN,
    groundContact01: this.suspension.groundContact01,
    wheelSlipRatio: this.wheelSlipArr,
    onRock: this.wheelOnRockArr,
    moisture: 0.15,
    tirePressurePsi: 22,
    isHandbrake: false,
    isLowRange: false,
    isRolledOver: false,
    rolledWheelAuthority: 1,
  };
  private readonly rolloverInputScratch: LateralRollInput = {
    dt: 1 / 60,
    vForwardMs: 0,
    vLateralMs: 0,
    yawRateRadS: 0,
    steerAngleRad: 0,
    terrainRollSlopeRad: 0,
    terrainPitchSlopeRad: 0,
    tirePressurePsi: 22,
    avgOnRock: 0,
    trackHalf: RIVIAN_TRACK_HALF,
    cgHeight: 0.86,
    isHandbrake: false,
  };
  private readonly rolloverCenterScratch = { x: 0, y: 0, z: 0, sinH: 0, cosH: 1 };
  private readonly suspensionInputScratch: SuspensionStepInput = {
    dt: 1 / 60,
    sprungMassKg: 3100,
    unsprungMassKg: 55,
    tireRadiusM: RIVIAN_TIRE_RADIUS,
    comHeightRestM: 0.86,
    corners: this.suspensionCorners,
    groundSurfY: this.wheelSurfHeights,
    onRock: this.wheelOnRockArr,
    tirePressurePsi: 22,
    longitudinalAccelMs2: 0,
    lateralAccelMs2: 0,
    rolloverOverrideActive: false,
    rolloverRollRad: 0,
    rolloverPitchRad: 0,
    rolloverAirY: 0,
    rolloverVy: 0,
    rolloverRollVel: 0,
    rolloverPitchVel: 0,
    avgGroundY: 0,
  };
  private readonly wheelSmokeInputScratch: WheelSmokeSampleInput = {
    speedMs: 0,
    wheelSlip: 0,
    lateralSpeedMs: 0,
    moisture: 0.15,
    boostActive: false,
    handbrake: false,
    isRear: false,
    biome: 'desert',
  };
  private readonly brushScratch: SandBrushInput = {
    posPrevX: 0,
    posPrevY: 0,
    posPrevZ: 0,
    halfWidth: 0.2,
    posCurrX: 0,
    posCurrY: 0,
    posCurrZ: 0,
    targetSinkage: 0,
    slipRatio: 0,
    treadPhasePrev: 0,
    treadPhaseCurr: 0,
    lateralDrift: 0,
    brushType: BrushType.Wheel,
    atlasId: 0,
    compressionWeight: 1,
    massFactor: 1,
  };
  private readonly sparkScratch: VehicleSparkSignal = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    intensity: 0.6,
  };
  private readonly smokeScratch: VehicleSmokeSignal = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    type: SmokeLayerType.DesertDust,
    baseSize: 0.4,
    lifetime: 1,
    opacity: 0.3,
    growthMult: 3,
    spinRate: 0.4,
  };
  private readonly crashAudioScratch: VehicleCrashAudioSignal = {
    severity: 0,
    onRock: false,
    glassCracked: false,
  };
  private readonly telemetryScratch: VehicleTelemetry = {
    speedKmh: 0,
    avgSinkageCm: 0,
    maxSinkageCm: 0,
    avgSlipRatio: 0,
    trackCompactionPct: 0,
    rollingDragN: 0,
    bulldozingN: 0,
    driftAngleDeg: 0,
    gear: 'N',
    rpm: 760,
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
  private readonly terrainPoseScratch = { clearanceY: 0, upright01: 1 };
  private readonly cockpitMotionScratch = {
    speedMs: 0,
    accelForwardMs2: 0,
    lateralG: 0,
    suspensionBump: 0,
  };
  private readonly lampPowersScratch = {
    headlightLeft: 0.22,
    headlightRight: 0.22,
    brakeLeft: 0.22,
    brakeRight: 0.22,
    reverse: 0,
  };
  private readonly sampleRolloverSurfaceBound = (lx: number, lz: number): ClimbableRockSample => {
    const c = this.rolloverCenterScratch;
    const wx = c.x + c.cosH * lx + c.sinH * lz;
    const wz = c.z - c.sinH * lx + c.cosH * lz;
    return this.sampleSurfaceAtInto(wx, wz, this.lastBiome, this.rolloverSurfaceScratch);
  };
  private readonly handleCrashImpactBound = (ev: CrashImpactEvent): void => {
    this.handleCrashImpact(ev);
  };

  constructor(
    reflectionUniforms?: ReflectionSharedUniforms,
    onModelReady?: () => void,
    initialMaxAnisotropy = 4,
    onModelError?: (err: unknown) => void,
  ) {
    const wheelSpecs: Array<WheelMountSpec & { name: string }> = [
      { name: 'FL', x: this.trackHalf, z: this.wheelBaseHalf, isFront: true, isLeft: true },
      { name: 'FR', x: -this.trackHalf, z: this.wheelBaseHalf, isFront: true, isLeft: false },
      { name: 'RL', x: this.trackHalf, z: -this.wheelBaseHalf, isFront: false, isLeft: true },
      { name: 'RR', x: -this.trackHalf, z: -this.wheelBaseHalf, isFront: false, isLeft: false },
    ];

    this.visuals = buildRivianTruckVisuals(
      this.root,
      wheelSpecs,
      this.tireRadius,
      this.tireWidth,
      reflectionUniforms,
      () => {
        this.lastBoundEnvMap = undefined;
        this.lastHeadlightWeatherKey = '';
        this.updateHeadlightsForWeather(this.lastWeatherPreset);
        this.syncVisualTransform(0.016, true, true);
        onModelReady?.();
      },
      initialMaxAnisotropy,
      onModelError,
    );
    this.bodyGroup = this.visuals.bodyGroup;

    for (let i = 0; i < wheelSpecs.length; i++) {
      const spec = wheelSpecs[i];
      const asm = this.visuals.wheelAssemblies[i];
      this.wheels.push({
        name: spec.name,
        localOffset: new THREE.Vector3(spec.x, 0, spec.z),
        isFront: spec.isFront,
        isLeft: spec.isLeft,
        worldPos: new THREE.Vector3(),
        prevWorldPos: new THREE.Vector3(),
        hasPrevPos: false,
        spinAngle: 0,
        treadPhase: 0,
        prevTreadPhase: 0,
        steerAngle: 0,
        sinkage: 0.03,
        trackCompaction: 0,
        slipRatio: 0,
        lateralSlipRad: 0,
        contact: {
          sinkage: 0.03,
          trackCompaction: 0,
          rollingResistanceN: 0,
          bulldozingForceN: 0,
          tractionFactor: 0.85,
        },
        steerPivot: asm.steerPivot,
        camberGroup: asm.camberGroup,
        spinMesh: asm.spinGroup,
        lowerArm: asm.lowerArm,
        upperArm: asm.upperArm,
        coilGroup: asm.coilGroup,
      });
    }

    this.reset(0, 0, 0.35);
  }

  public getBrokenFenceIds(): ReadonlySet<string> {
    return this.brokenFenceIds;
  }

  private sampleSurfaceAtInto(
    x: number,
    z: number,
    biome: EnvironmentBiome,
    out: ClimbableRockSample,
  ): ClimbableRockSample {
    const baseY = sampleTerrainHeightForBiome(x, z, biome);
    if (biome !== 'desert') {
      out.height = baseY;
      out.rockElevation = 0;
      out.onRock = 0;
      return out;
    }
    return sampleClimbableRockSurfaceInto(x, z, baseY, undefined, out);
  }

  private sampleSurfaceAt(
    x: number,
    z: number,
    biome: EnvironmentBiome,
  ): ClimbableRockSample {
    return this.sampleSurfaceAtInto(x, z, biome, this.surfaceScratch);
  }

  private clearDebris(): void {
    for (const p of this.debrisPieces) {
      this.debrisContainer.remove(p.object);
    }
    this.debrisPieces.length = 0;
  }

  public getCrashTrauma(): number {
    return this.crashTrauma;
  }

  public isRolledOver(): boolean {
    return this.rollover.isRolledOver;
  }

  public getIntegrityPct(): number {
    return this.damage.overallIntegrityPct;
  }

  public getDetachedCount(): number {
    let n = 0;
    for (const k in this.damage.detached) {
      if (this.damage.detached[k as DetachablePartId]) n += 1;
    }
    return n;
  }

  /**
   * Flips an overturned truck back onto all 4 wheels in place while preserving battle damage,
   * OR restores a pristine truck on full Reset (`reset(...)`).
   */
  public rightOverturnedVehicle(): void {
    this.rollover.rollRad = 0;
    this.rollover.rollVel = 0;
    this.rollover.pitchRad = 0;
    this.rollover.pitchVel = 0;
    this.rollover.airY = 0.25;
    this.rollover.vy = 0;
    this.rollover.isRolledOver = false;
    this.rollover.isTipping = false;
    this.prevRolloverActive = false;
    this.velocity.multiplyScalar(0.25);
    const surf = this.sampleSurfaceAt(this.position.x, this.position.z, this.lastBiome);
    snapSuspensionToGround(
      this.suspension,
      surf.height,
      this.cgHeightM,
      this.tireRadius,
      this.sprungMassKg,
      this.unsprungMassKg,
    );
    this.suspension.chassisComWorldY += 0.24;
    this.syncVisualTransform(0.016, true);
  }

  public reset(
    x: number,
    z: number,
    headingRad = 0.35,
    biome: EnvironmentBiome = this.lastBiome,
  ): void {
    this.lastBiome = biome;
    const surf = this.sampleSurfaceAt(x, z, biome);
    this.position.set(x, surf.height, z);
    this.velocity.set(0, 0, 0);
    this.heading = headingRad;
    this.yawRate = 0;
    this.prevVForward = 0;
    this.steerSmoothed = 0;
    this.whipPitch = 0;
    this.whipRoll = 0;
    this.autopilotTime = 0;
    this.sprintResetDist = 0;
    this.wheelDustAccum.fill(0);
    this.wheelDriftAccum.fill(0);
    this.wheelOnRock.fill(0);
    this.hoodSteamAccum = 0;
    this.potholeImpactCooldowns.fill(0);
    this.lastMechOutput = {
      powerScale: 1,
      steamIntensity: 0,
      overheated: false,
      misfireActive: false,
      flatTireDrag: 0,
      steeringPullRad: 0,
      steeringShakeAmp: 0,
    };
    this.roofScrapeDustAccum = 0;
    this.roofScrapeSparkAccum = 0;
    this.crashTrauma = 0;
    this.prevRolloverActive = false;
    this.chassisDustLevel = 0.16;
    this.lastBrakeLightPower[0] = 0.22;
    this.lastBrakeLightPower[1] = 0.22;
    this.lastReverseLightPower = 0;
    this.pendingCrashSparkQueue.length = 0;
    this.pendingCrashAudioQueue.length = 0;
    this.pendingNormalRecomputeQueue.length = 0;
    this.lastHeadlightWeatherKey = '';

    this.rollover = createInitialRolloverState();
    snapSuspensionToGround(
      this.suspension,
      surf.height,
      this.cgHeightM,
      this.tireRadius,
      this.sprungMassKg,
      this.unsprungMassKg,
    );
    this.damage = createInitialDamageState();
    this.brokenFenceIds.clear();
    this.clearDebris();
    this.visuals.resetVisualDamage();
    this.updateHeadlightsForWeather(this.lastWeatherPreset);

    for (const w of this.wheels) {
      w.hasPrevPos = false;
      w.sinkage = biome === 'rainy_highway' ? 0.0 : 0.03;
      w.slipRatio = 0;
      w.steerAngle = 0;
    }
    this.syncVisualTransform(0.016, true);
    this.root.updateMatrixWorld(true);
    for (const w of this.wheels) {
      w.steerPivot.getWorldPosition(_wheelWorld);
      const wg = this.sampleSurfaceAt(_wheelWorld.x, _wheelWorld.z, biome);
      w.worldPos.set(_wheelWorld.x, wg.height - w.sinkage * (1 - wg.onRock), _wheelWorld.z);
      w.prevWorldPos.copy(w.worldPos);
    }
  }

  /**
   * Positions the truck on a fast approach vector to demonstrate a dramatic sharp-turn rollover
   * and sandstone rock smash when selecting the 'rollover_crash' mode!
   */
  public setupRolloverCrashShowcase(biome: EnvironmentBiome = 'desert'): void {
    if (biome === 'rainy_highway') {
      // Aim offset front-left corner straight into the nearest solid eucalyptus trunk at ~98 km/h!
      const trees = getRainyHighwayObstaclesNear(12, 24)
        .filter((o) => o.kind === 'eucalyptus' && o.z > 4)
        .sort((a, b) => a.z - b.z);
      const target = trees[0];
      if (target) {
        const spawnX = Math.max(0.6, target.x - 1.9);
        const spawnZ = target.z - 8.2;
        const aimX = target.x - 0.32;
        const aimZ = target.z;
        const heading = Math.atan2(aimX - spawnX, aimZ - spawnZ);
        const launchSpeed = 27.5;
        this.reset(spawnX, spawnZ, heading, biome);
        this.velocity.set(Math.sin(heading) * launchSpeed, 0, Math.cos(heading) * launchSpeed);
        this.prevVForward = launchSpeed;
        this.autopilotTime = 0;
        return;
      }
    }
    // Launch at 88 km/h on undulating dunes angled toward eastern sandstone boulders
    this.reset(1.5, -14.0, 0.34, biome);
    this.velocity.set(Math.sin(0.34) * 24.5, 0, Math.cos(0.34) * 24.5);
    this.prevVForward = 24.5;
    this.autopilotTime = 0;
  }

  public resolveInput(
    stressMode: StressTestMode,
    manual: VehicleInput,
    dt: number,
  ): VehicleInput {
    this.autopilotTime += dt;

    if (stressMode === 'manual') {
      return manual;
    }
    if (stressMode === 'donuts') {
      const phase = this.autopilotTime * 0.24;
      const steerDir = Math.sin(phase) >= 0 ? 1.0 : -1.0;
      return {
        throttle: 1.0,
        steer: steerDir * 0.72,
        handbrake: false,
        boost: false,
      };
    }
    if (stressMode === 'rollover_crash') {
      if (this.lastBiome === 'rainy_highway' && this.autopilotTime < 0.55 && this.damage.totalImpacts === 0) {
        return { throttle: 1.0, steer: 0.0, handbrake: false, boost: true };
      }
      // Immediate Scandinavian flick (0..0.18s brief left weight transfer -> hard full-lock right snap!)
      if (this.autopilotTime < 0.18) {
        return { throttle: 1.0, steer: 0.75, handbrake: false, boost: true };
      }
      if (this.autopilotTime < 2.25 && !this.rollover.isRolledOver) {
        return { throttle: 1.0, steer: -1.0, handbrake: false, boost: true };
      }
      return { throttle: 0.0, steer: 0.0, handbrake: false, boost: false };
    }
    if (stressMode === 'sprint_150') {
      const gentleWeave = Math.sin(this.autopilotTime * 0.45) * 0.07;
      return {
        throttle: 1.0,
        steer: gentleWeave,
        handbrake: false,
        boost: true,
      };
    }
    if (stressMode === 'foot_ik_walk' || stressMode === 'avalanche_park') {
      return {
        throttle: 0,
        steer: 0,
        handbrake: true,
        boost: false,
      };
    }
    return manual;
  }

  private spawnDetachedDebris(partId: DetachablePartId, impact: CrashImpactEvent): void {
    const srcGroup = this.visuals.detachableGroups[partId];
    if (!srcGroup || !srcGroup.visible) return;

    srcGroup.updateWorldMatrix(true, false);
    const clone = srcGroup.clone(true);
    clone.position.set(0, 0, 0);
    clone.rotation.set(0, 0, 0);
    clone.scale.set(1, 1, 1);

    srcGroup.getWorldPosition(_debrisSpawnPos);
    srcGroup.getWorldQuaternion(_debrisSpawnQuat);

    const wrapper = new THREE.Group();
    wrapper.position.copy(_debrisSpawnPos);
    wrapper.quaternion.copy(_debrisSpawnQuat);
    wrapper.add(clone);
    this.debrisContainer.add(wrapper);

    // Hide original attached part on truck
    srcGroup.visible = false;

    const kickSpeed = Math.max(3.0, Math.min(11.0, impact.impulseSpeedMs * 0.65));
    const worldKick = localVectorXZToWorld(impact.localNormalX, impact.localNormalZ, this.heading);
    const isHeavyBumper = partId === 'frontBumper' || partId === 'rearBumper';
    const vx =
      this.velocity.x * (isHeavyBumper ? 0.35 : 0.65) +
      (Math.random() - 0.5) * (isHeavyBumper ? 6.0 : 4.5) +
      worldKick.worldX * kickSpeed * (isHeavyBumper ? 0.55 : 0.45);
    const vy = isHeavyBumper
      ? 1.1 + Math.random() * 1.3 + impact.severity * 0.9
      : 2.6 + Math.random() * 3.4 + impact.severity * 2.5;
    const vz =
      this.velocity.z * (isHeavyBumper ? 0.35 : 0.65) +
      (Math.random() - 0.5) * (isHeavyBumper ? 6.0 : 4.5) +
      worldKick.worldZ * kickSpeed * (isHeavyBumper ? 0.55 : 0.45);

    this.debrisPieces.push({
      partId,
      object: wrapper,
      pos: _debrisSpawnPos.clone(),
      vel: new THREE.Vector3(vx, vy, vz),
      angVel: new THREE.Vector3(
        (Math.random() - 0.5) * 9.5,
        (Math.random() - 0.5) * 9.5,
        (Math.random() - 0.5) * 9.5,
      ),
      age: 0,
      settled: false,
    });
  }

  private handleCrashImpact(ev: CrashImpactEvent): void {
    const { newlyDetached, glassCrackedNow, metalImpactSeverity } =
      applyImpactToDamageState(this.damage, ev);

    if (metalImpactSeverity <= 0.02) return;

    // 1. Add camera trauma pulse & crash audio signal
    this.crashTrauma = Math.min(1.0, this.crashTrauma + metalImpactSeverity * 0.65);
    this.pendingCrashAudioQueue.push({
      severity: metalImpactSeverity,
      onRock: ev.onRock,
      glassCracked: glassCrackedNow,
    });

    // 2. Apply BeamNG-style real-time plastic vertex deformation to nearby subdivided body panels!
    const isFrontal = ev.zone === 'front';
    const crushDepth = Math.min(0.30, 0.055 + ev.severity * 0.23);
    const radius = isFrontal ? 0.64 + ev.severity * 0.56 : 0.72 + ev.severity * 0.65;
    const seed = ev.worldPointX * 3.1 + ev.worldPointZ * 5.7 + this.damage.totalImpacts;

    for (let i = 0; i < this.visuals.deformableMeshes.length; i++) {
      const rec = this.visuals.deformableMeshes[i];
      const distToPanel = Math.hypot(
        rec.center.x - ev.localPointX,
        rec.center.y - ev.localPointY,
        rec.center.z - ev.localPointZ,
      );
      const reachPad = rec.isHood && isFrontal ? Math.max(radius * 1.25, 1.4) : radius;
      if (distToPanel > rec.extentRadius + reachPad) continue;

      let ix = ev.localPointX;
      let iy = ev.localPointY;
      let iz = ev.localPointZ;
      let dirX = ev.localNormalX;
      let dirY = ev.localNormalY;
      let dirZ = ev.localNormalZ;

      if (rec.bodyToLocal) {
        _deformLocalPt.set(ix, iy, iz).applyMatrix4(rec.bodyToLocal);
        ix = _deformLocalPt.x;
        iy = _deformLocalPt.y;
        iz = _deformLocalPt.z;
        _deformNormMat.setFromMatrix4(rec.bodyToLocal);
        _deformLocalNorm.set(dirX, dirY, dirZ).applyMatrix3(_deformNormMat).normalize();
        dirX = _deformLocalNorm.x;
        dirY = _deformLocalNorm.y;
        dirZ = _deformLocalNorm.z;
      } else if (rec.id === 'hoodSkin') {
        iy -= 1.32;
        iz -= 1.24;
      } else if (rec.id === 'frontBullbar') {
        iy -= 0.78;
        iz -= 2.47;
      } else if (rec.id === 'rearBumper') {
        iy -= 0.61;
        iz -= -2.53;
      }

      const geo = rec.mesh.geometry;
      const posArr = geo.attributes.position.array as Float32Array;
      const colArr = geo.attributes.color.array as Float32Array;
      const scrapeAttr = geo.attributes.aScrape;
      const scrapeArr = scrapeAttr ? (scrapeAttr.array as Float32Array) : undefined;

      const { modifiedVertices } = deformSubmeshVertices({
        positions: posArr,
        restPositions: rec.restPositions,
        colors: colArr,
        restColors: rec.restColors,
        scrapes: scrapeArr,
        impactLocalX: ix,
        impactLocalY: iy,
        impactLocalZ: iz,
        crushDirX: dirX,
        crushDirY: dirY,
        crushDirZ: dirZ,
        radius,
        maxCrushDepth: crushDepth,
        creaseSeed: seed,
        innerCoreClamp: rec.innerCoreClamp,
        isHood: rec.isHood,
        isFrontalCrush: isFrontal,
        isPlasticTrim: rec.isPlasticTrim,
      });

      if (modifiedVertices > 0) {
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
        if (scrapeAttr) scrapeAttr.needsUpdate = true;
        // Amortize computeVertexNormals() across frames (up to 4 panels/frame for crisp frontal crumple)
        if (!this.pendingNormalRecomputeQueue.includes(geo)) {
          this.pendingNormalRecomputeQueue.push(geo);
        }
      }
    }

    // 3. Apply visual glass cracks, per-side broken headlamps/DRLs, buckled hood & bent wheel camber
    if (this.damage.windshieldCrackLevel === 1) {
      this.visuals.windshieldMesh.material = this.visuals.crackedGlassMat;
    } else if (this.damage.windshieldCrackLevel >= 2) {
      this.visuals.windshieldMesh.material = this.visuals.shatteredGlassMat;
    }
    if (this.damage.rearGlassBroken) {
      this.visuals.rearGlassMesh.material = this.visuals.crackedRearGlassMat;
    }

    if (this.damage.headlightBroken[0]) {
      this.visuals.headlightLensMatLeft.emissiveIntensity = 0.0;
      this.visuals.headlightLensMatLeft.color.setHex(0x2a2926);
      if (this.visuals.ledDrlMatLeft) this.visuals.ledDrlMatLeft.emissiveIntensity = 0.0;
    }
    if (this.damage.headlightBroken[1]) {
      this.visuals.headlightLensMatRight.emissiveIntensity = 0.0;
      this.visuals.headlightLensMatRight.color.setHex(0x2a2926);
      if (this.visuals.ledDrlMatRight) this.visuals.ledDrlMatRight.emissiveIntensity = 0.0;
    }
    if (
      (this.damage.headlightBroken[0] && this.damage.headlightBroken[1]) ||
      this.damage.zoneIntegrity.front < 0.42
    ) {
      this.visuals.ledDrlMat.emissiveIntensity = 0.0;
    }
    if (this.damage.taillightBroken[0]) {
      this.visuals.brakeLightMatLeft.emissiveIntensity = 0.0;
      this.visuals.brakeLightMatLeft.color.setHex(0x2d1715);
    }
    if (this.damage.taillightBroken[1]) {
      this.visuals.brakeLightMatRight.emissiveIntensity = 0.0;
      this.visuals.brakeLightMatRight.color.setHex(0x2d1715);
    }

    // Buckled & asymmetrically twisted hood latch + drooping front bumper before detachment
    this.visuals.hoodPivot.rotation.x = -this.damage.hoodPoppedAngleRad;
    this.visuals.hoodPivot.rotation.z = this.damage.hoodTwistRad;
    if (!this.damage.detached.frontBumper) {
      const sag = this.damage.frontBumperSagRad;
      this.visuals.detachableGroups.frontBumper.rotation.z = sag;
      this.visuals.detachableGroups.frontBumper.rotation.x = Math.abs(sag) * 0.52;
    }
    const hoodExposed =
      this.damage.hoodPoppedAngleRad > 0.02 ||
      this.damage.zoneIntegrity.front < 0.86 ||
      Boolean(this.damage.detached.hood) ||
      Boolean(this.damage.detached.frontBumper) ||
      newlyDetached.includes('hood') ||
      newlyDetached.includes('frontBumper');
    this.visuals.setUnderHoodVisible?.(hoodExposed);

    // Bend damaged wheel hub camber & toe
    for (let wi = 0; wi < 4; wi++) {
      const wd = this.damage.wheels[wi];
      this.visuals.wheelAssemblies[wi].camberGroup.rotation.z = wd.camberRad;
      this.visuals.wheelAssemblies[wi].camberGroup.rotation.y = wd.toeRad;
    }

    // 4. Spawn newly detached parts into flying rigid-body debris pool
    for (let d = 0; d < newlyDetached.length; d++) {
      this.spawnDetachedDebris(newlyDetached[d], ev);
    }

    // 5. Queue incandescent metallic sparks on rock/heavy metal impacts
    const sparkCount = ev.onRock
      ? Math.round(8 + ev.severity * 18)
      : Math.round(3 + ev.severity * 10);
    for (let s = 0; s < sparkCount; s++) {
      this.pendingCrashSparkQueue.push({
        x: ev.worldPointX + (Math.random() - 0.5) * 0.25,
        y: ev.worldPointY + 0.1 + Math.random() * 0.25,
        z: ev.worldPointZ + (Math.random() - 0.5) * 0.25,
        vx: (Math.random() - 0.5) * 7.5 + this.velocity.x * 0.35,
        vy: 1.8 + Math.random() * 5.2,
        vz: (Math.random() - 0.5) * 7.5 + this.velocity.z * 0.35,
        intensity: ev.onRock ? 1.0 : 0.72,
      });
    }
  }

  private stepDebris(dt: number, biome: EnvironmentBiome): void {
    const pieceCount = this.debrisPieces.length;
    if (pieceCount === 0) return;

    let minDistSq = Infinity;
    let hasUnsettled = false;
    let hasYoung = false;
    for (let i = 0; i < pieceCount; i++) {
      const p = this.debrisPieces[i];
      if (!p.settled) {
        hasUnsettled = true;
        if (p.age < 1.5) hasYoung = true;
        const dx = p.pos.x - this.position.x;
        const dz = p.pos.z - this.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < minDistSq) minDistSq = d2;
      }
    }
    if (!hasUnsettled) return;

    const tier =
      minDistSq <= 40 * 40 || hasYoung
        ? 'full'
        : selectSimulationTier(minDistSq, false, true);
    const stepDt = consumeLodStepDt(this.debrisLodState, dt, tier);
    if (stepDt <= 0) return;
    const safeStepDt = Math.min(0.12, Math.max(0.001, stepDt));

    const g = 9.81;
    const linDamp = Math.exp(-5.5 * safeStepDt);
    const angDamp = Math.exp(-6.0 * safeStepDt);

    for (let i = 0; i < pieceCount; i++) {
      const p = this.debrisPieces[i];
      p.age += safeStepDt;
      if (p.settled) continue;

      p.vel.y -= g * safeStepDt;
      p.pos.addScaledVector(p.vel, safeStepDt);

      _debrisEuler.set(p.angVel.x * safeStepDt, p.angVel.y * safeStepDt, p.angVel.z * safeStepDt);
      _debrisQuat.setFromEuler(_debrisEuler);
      p.object.quaternion.premultiply(_debrisQuat);

      const ground = this.sampleSurfaceAtInto(p.pos.x, p.pos.z, biome, this.surfaceScratch);
      const minY = ground.height + 0.14;
      if (p.pos.y <= minY) {
        p.pos.y = minY;
        if (p.vel.y < -1.0) {
          p.vel.y = -p.vel.y * 0.36;
          p.vel.x *= 0.72;
          p.vel.z *= 0.72;
          p.angVel.multiplyScalar(0.68);
        } else {
          p.vel.y = 0;
          p.vel.x *= linDamp;
          p.vel.z *= linDamp;
          p.angVel.multiplyScalar(angDamp);
          if (Math.hypot(p.vel.x, p.vel.z) < 0.08 && p.age > 0.6) {
            p.settled = true;
          }
        }
      }
      p.object.position.copy(p.pos);
    }
  }

  public step(
    dt: number,
    input: VehicleInput,
    stressMode: StressTestMode,
    moisture: number,
    terramechanics: SandTerramechanics,
    brushEncoder: BrushEncoder,
    onEmitRoost: (
      x: number,
      y: number,
      z: number,
      vx: number,
      vy: number,
      vz: number,
      intensity: number,
    ) => void,
    onEmitSmoke?: (signal: VehicleSmokeSignal) => void,
    biome: EnvironmentBiome = 'desert',
    driveMode: DriveMode = '4H',
    tirePressurePsi = 22,
    onEmitSpark?: (signal: VehicleSparkSignal) => void,
    onCrashAudio?: (signal: VehicleCrashAudioSignal) => void,
  ): VehicleTelemetry {
    const safeDt = Math.min(0.05, Math.max(0.001, dt));
    this.lastBiome = biome;
    this.lastTirePressurePsi = tirePressurePsi;
    this.crashTrauma = Math.max(0, this.crashTrauma - safeDt * 1.45);

    const isLowRange = driveMode === '4L' && stressMode !== 'sprint_150';
    const tireFootprint = computeTireFootprintScaleInto(tirePressurePsi, this.footprintScratch);
    const psiNormLow = Math.max(0, Math.min(1, (32 - tirePressurePsi) / 20));

    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    _fwd.set(sinH, 0, cosH);
    _right.set(cosH, 0, -sinH);

    let vForward = this.velocity.dot(_fwd);
    let vLateral = this.velocity.dot(_right);
    const speed = Math.hypot(vForward, vLateral);

    // If vehicle is upside-down / rolled onto side, engine wheels lose ground authority!
    const rolledWheelAuthority = this.rollover.isRolledOver
      ? 0.05
      : this.rollover.isTipping
        ? 0.62
        : 1.0;

    // Step Phase 5 mechanical degradation (radiator overheating -> hood steam, engine power loss, flat tire drag, alignment pull)
    this.mechClockSec += safeDt;
    for (let k = 0; k < 4; k++) {
      if (this.potholeImpactCooldowns[k] > 0) {
        this.potholeImpactCooldowns[k] = Math.max(0, this.potholeImpactCooldowns[k] - safeDt);
      }
    }
    const mechOut = stepMechanicalDamage(
      this.damage,
      safeDt,
      speed,
      Math.abs(input.throttle),
    );
    this.lastMechOutput = mechOut;

    // Combine wheel damage, engine block health & thermal overheat derate
    const avgWheelDmg =
      0.25 *
      (this.damage.wheels[0].damage01 +
        this.damage.wheels[1].damage01 +
        this.damage.wheels[2].damage01 +
        this.damage.wheels[3].damage01);
    const mechHealthFactor = Math.max(
      0.38,
      (1.0 - avgWheelDmg * 0.28) * mechOut.powerScale,
    );

    const isSprint = stressMode === 'sprint_150' || stressMode === 'rollover_crash';
    const di = this.driveInputScratch;
    di.control = input;
    di.vForwardMs = vForward;
    di.isSprintPreset = isSprint;
    di.driveMode = driveMode;
    const drive = evaluateVehicleDriveStep(di);

    // Asymmetric damaged-suspension + bent tie-rod + flat-tire steering pull
    const pullRad =
      (this.damage.wheels[0].toeRad - this.damage.wheels[1].toeRad) * 0.35 +
      mechOut.steeringPullRad;
    const targetSteer = input.steer * drive.maxSteerAngleRad + pullRad;
    // Speed-progressive steering rate: crisp at crawl, smooth & weighted on highway so brief taps adjust lane cleanly
    const speedCalm = Math.min(1.0, speed / 22.0);
    const steerRate =
      Math.abs(input.steer) > 0.05
        ? 5.0 - speedCalm * 2.4
        : 7.6 + speedCalm * 1.8;
    this.steerSmoothed += (targetSteer - this.steerSmoothed) * (1 - Math.exp(-steerRate * safeDt));

    let totalRollingDrag = 0;
    let totalBulldozing = 0;
    let avgTraction = 0;
    let avgSinkage = 0;
    let maxSinkage = 0;
    let avgSlip = 0;
    let avgTrackComp = 0;
    let avgOnRock = 0;

    const baseLoadPerWheel = this.chassisMassKg * 9.81 * 0.25;
    const lateralSlipAngle = speed > 0.6 ? Math.atan2(vLateral, Math.abs(vForward) + 0.5) : 0;

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.steerAngle = w.isFront ? this.steerSmoothed : 0;

      const wx = this.position.x + _right.x * w.localOffset.x + _fwd.x * w.localOffset.z;
      const wz = this.position.z + _right.z * w.localOffset.x + _fwd.z * w.localOffset.z;

      const grounded = !this.suspension.initialized || this.suspension.groundContact01[i] > 0.01;
      const liveLoad = this.suspension.initialized ? this.suspension.normalLoadN[i] : baseLoadPerWheel;
      const normalLoad = grounded ? Math.max(0, liveLoad) : 0;

      let wheelSlip = 0;
      if (Math.abs(drive.engineForceN) > 500) {
        const launchBoost = Math.max(0, 1.0 - speed / 17.5) * 0.68;
        const driftBoost = Math.min(0.62, Math.abs(lateralSlipAngle) * 0.85);
        const turboBonus = drive.boostActive ? 0.36 : 0.0;
        const driveBias = isLowRange ? (w.isFront ? 0.86 : 0.94) : w.isFront ? 0.52 : 1.12;
        wheelSlip = Math.min(
          1.35,
          Math.abs(input.throttle) * (0.14 + launchBoost + driftBoost + turboBonus) * driveBias,
        );
      }
      if (input.handbrake && !w.isFront && speed > 1.0) {
        wheelSlip = Math.max(wheelSlip, 0.98);
      }

      const rockSurf = this.sampleSurfaceAtInto(wx, wz, biome, this.surfaceScratch);
      const onRock = rockSurf.onRock;
      this.wheelOnRock[i] = onRock;
      this.wheelOnRockArr[i] = onRock;
      avgOnRock += onRock * 0.25;

      const wci = this.wheelContactInputScratch;
      wci.worldX = wx;
      wci.worldZ = wz;
      wci.normalLoadN = normalLoad;
      wci.slipRatio = wheelSlip;
      wci.lateralSlipRad = lateralSlipAngle + (w.isFront ? this.steerSmoothed * 0.35 : 0);
      wci.moisture = moisture;
      wci.biome = biome;
      wci.tirePressurePsi = tirePressurePsi;
      const contact = terramechanics.evaluateWheelContactInto(wci, this.wheelContactResScratch);

      const onAsphalt = biome === 'rainy_highway' && isOnPavedHighway(wx);
      const rockTireFlexSink = 0.002 + psiNormLow * 0.008;
      const effectiveSinkage =
        !grounded || onAsphalt
          ? 0.0
          : contact.sinkage * (1 - onRock) + rockTireFlexSink * onRock;
      const rockGrip = 0.72 + psiNormLow * 0.48;
      const wetGrip = onAsphalt
        ? computeWetHighwayGripInto(wx, wz, speed, 0.78, this.wetGripScratch)
        : null;
      const effectiveTraction = !grounded
        ? 0.0
        : wetGrip
          ? wetGrip.lateralGripScale
          : contact.tractionFactor * (1 - onRock) + rockGrip * onRock;
      const effectiveRollingDrag =
        contact.rollingResistanceN *
        (wetGrip ? wetGrip.rollingDragScale : 1 - onRock * 0.85) *
        this.suspension.groundContact01[i];
      const effectiveBulldoze = onAsphalt
        ? 0
        : contact.bulldozingForceN * (1 - onRock * 0.9) * this.suspension.groundContact01[i];

      w.contact.sinkage = effectiveSinkage;
      w.contact.trackCompaction = contact.trackCompaction;
      w.contact.rollingResistanceN = effectiveRollingDrag;
      w.contact.bulldozingForceN = effectiveBulldoze;
      w.contact.tractionFactor = effectiveTraction;
      w.sinkage =
        !grounded || onAsphalt
          ? 0.0
          : w.sinkage + (effectiveSinkage - w.sinkage) * (1 - Math.exp(-16 * safeDt));
      w.trackCompaction = contact.trackCompaction;
      w.slipRatio = wheelSlip;
      this.wheelSlipArr[i] = wheelSlip;
      w.lateralSlipRad = lateralSlipAngle;

      const sandEmbed = onAsphalt ? 0.0 : 0.025 * (1 - onRock);
      const contactY = rockSurf.height - w.sinkage * (0.94 - 0.22 * onRock) - sandEmbed;
      this.wheelGroundHeights[i] = contactY;
      this.wheelSurfHeights[i] = contactY;

      totalRollingDrag += effectiveRollingDrag;
      totalBulldozing += effectiveBulldoze;
      avgTraction += effectiveTraction * 0.25 * (0.25 + 0.75 * this.suspension.groundContact01[i]);
      avgSinkage += w.sinkage * 0.25;
      maxSinkage = Math.max(maxSinkage, w.sinkage);
      avgSlip += wheelSlip * 0.25;
      avgTrackComp += contact.trackCompaction * 0.25;

      const lockedRear = input.handbrake && !w.isFront && speed > 1.2;
      const effectiveSpeed = lockedRear
        ? vForward * 0.12
        : vForward + Math.sign(drive.engineForceN || vForward || 1) * wheelSlip * 12.5;
      const omega = effectiveSpeed / this.tireRadius;
      w.prevTreadPhase = w.treadPhase;
      w.spinAngle += omega * safeDt;
      w.treadPhase += (effectiveSpeed * safeDt) / (Math.PI * 2 * this.tireRadius);

      this.wheelNormalLoads[i] = normalLoad;
      this.wheelOmegas[i] = omega;
    }

    const aeroDrag = 0.52 * vForward * Math.abs(vForward);
    const motionSign = Math.abs(vForward) > 0.05 ? Math.sign(vForward) : 0;
    const avgContactFactor =
      0.25 *
      (this.suspension.groundContact01[0] +
        this.suspension.groundContact01[1] +
        this.suspension.groundContact01[2] +
        this.suspension.groundContact01[3]);
    const groundedAuthority = rolledWheelAuthority * (0.12 + 0.88 * avgContactFactor);
    const handbrakeForce = input.handbrake ? -motionSign * 19500 * groundedAuthority : 0;
    const serviceBrakeForce = drive.serviceBrakeN > 0 ? -motionSign * drive.serviceBrakeN * groundedAuthority : 0;

    const hFL = this.wheelGroundHeights[0];
    const hFR = this.wheelGroundHeights[1];
    const hRL = this.wheelGroundHeights[2];
    const hRR = this.wheelGroundHeights[3];

    const climbSlopeFwd = Math.max(-0.46, Math.min(0.46, ((hFL + hFR) * 0.5 - (hRL + hRR) * 0.5) / (this.wheelBaseHalf * 2.0)));
    const terrainPitchSlopeRad = Math.atan(climbSlopeFwd);
    const terrainRollSlopeRad = Math.atan(((hFL + hRL) * 0.5 - (hFR + hRR) * 0.5) / (this.trackHalf * 2.0));

    const centerGround = sampleBaseTerrain(this.position.x, this.position.z, 0.25, biome);
    const baseSlopeFwd = -centerGround.normalX * _fwd.x - centerGround.normalZ * _fwd.z;
    const slopeAccelFwd = (0.72 * -climbSlopeFwd + 0.28 * baseSlopeFwd) * 9.81 * (0.35 + 0.65 * avgContactFactor);

    const highwayGrip =
      biome === 'rainy_highway'
        ? computeWetHighwayGripInto(this.position.x, this.position.z, vForward, 0.78, this.highwayGripScratch)
        : null;

    // Genuine 4-wheel slip-angle cornering, weight-transfer drift & full-size Raptor R yaw inertia!
    const tci = this.tireCorneringInputScratch;
    tci.dt = safeDt;
    tci.vForwardMs = vForward;
    tci.vLateralMs = vLateral;
    tci.yawRateRadS = this.yawRate;
    tci.steerAngleRad = this.steerSmoothed;
    tci.moisture = highwayGrip ? 0.55 : moisture;
    tci.tirePressurePsi = tirePressurePsi;
    tci.isHandbrake = input.handbrake;
    tci.isLowRange = isLowRange;
    tci.isRolledOver = this.rollover.isRolledOver;
    tci.rolledWheelAuthority = rolledWheelAuthority;
    const tireHandling = evaluateTireCorneringAndYaw(tci);

    // Roof/side scrape slows down sliding wreck across desert dunes!
    const roofSlideDragN = this.rollover.isRolledOver
      ? -vForward * (1150 + this.rollover.scrapeIntensity * 1450)
      : 0;
    const coastDrag = Math.abs(input.throttle) < 0.05 && !this.rollover.isRolledOver ? -vForward * (highwayGrip ? 680 : 1280) * groundedAuthority : 0;

    const diffLockTraction = isLowRange ? Math.min(1.22, avgTraction + 0.09) : avgTraction;
    const rollingScale = highwayGrip ? highwayGrip.rollingDragScale : 0.52;
    const flatTireDragForce =
      mechOut.flatTireDrag > 0
        ? -motionSign * mechOut.flatTireDrag * this.chassisMassKg * groundedAuthority
        : 0;
    const netFwdForce =
      drive.engineForceN * diffLockTraction * groundedAuthority * mechHealthFactor -
      motionSign * totalRollingDrag * rollingScale * groundedAuthority +
      flatTireDragForce -
      aeroDrag +
      coastDrag +
      roofSlideDragN +
      serviceBrakeForce +
      handbrakeForce +
      tireHandling.steeringDragForceN;

    vForward += (netFwdForce / this.chassisMassKg + slopeAccelFwd) * safeDt;
    vForward = Math.max(-drive.maxReverseSpeedMs, Math.min(drive.maxForwardSpeedMs * mechHealthFactor, vForward));

    if (
      (input.handbrake || drive.serviceBrakeN > 0 || Math.abs(input.throttle) < 0.05 || this.rollover.isRolledOver) &&
      Math.abs(vForward) < 0.45 &&
      Math.abs(drive.engineForceN * groundedAuthority) < 100
    ) {
      vForward *= Math.exp(-8.5 * safeDt);
      vLateral *= Math.exp(-8.5 * safeDt);
    }

    const bulldozeDamp = (totalBulldozing / this.chassisMassKg) * groundedAuthority;
    const latSign = Math.abs(vLateral) > 0.05 ? Math.sign(vLateral) : 0;
    vLateral += tireHandling.vLateralDeltaMs - latSign * bulldozeDamp * 0.42 * safeDt;

    this.yawRate += tireHandling.yawRateDeltaRadS;
    const dHeading = this.yawRate * safeDt;
    this.heading += dHeading;

    // Exact rigid-body rotating-frame velocity transformation (full Coriolis invariance:
    // preserves world linear momentum (vx, vz) when yawing in mid-air or sliding overturned!)
    const rotVel = rotateBodyVelocityByHeadingDelta(vForward, vLateral, dHeading);
    vForward = rotVel.vForward;
    vLateral = rotVel.vLateral;

    const newSin = Math.sin(this.heading);
    const newCos = Math.cos(this.heading);

    this.velocity.set(
      newSin * vForward + newCos * vLateral,
      0,
      newCos * vForward - newSin * vLateral,
    );

    this.position.x += this.velocity.x * safeDt;
    this.position.z += this.velocity.z * safeDt;

    // 1. Boulder / Sandstone Rock Obstacle Impacts (3D vertical clearance + dt-independent scrape damping)
    if (biome === 'desert') {
      const rockOpts = this.rockColOptionsScratch;
      rockOpts.dt = safeDt;
      rockOpts.vehicleMinY = this.position.y;
      rockOpts.vehicleMaxY = this.position.y + 2.18;
      const col = resolveRockCollisionsInto(
        this.position.x,
        this.position.z,
        this.velocity.x,
        this.velocity.z,
        1.52,
        DESERT_ROCK_OBSTACLES,
        rockOpts,
        this.rockColOutScratch,
      );
      if (col.collided) {
        this.position.x = col.x;
        this.position.z = col.z;
        this.velocity.x = col.vx;
        this.velocity.z = col.vz;
        vForward = this.velocity.x * newSin + this.velocity.z * newCos;
        vLateral = this.velocity.x * newCos - this.velocity.z * newSin;

        if (col.impactSpeed > 1.2) {
          // Convert world impact normal & contact point into vehicle-local coordinates
          const lx = (col.hitX - this.position.x) * newCos - (col.hitZ - this.position.z) * newSin;
          const lz = (col.hitX - this.position.x) * newSin + (col.hitZ - this.position.z) * newCos;
          const lnx = col.normalX * newCos - col.normalZ * newSin;
          const lnz = col.normalX * newSin + col.normalZ * newCos;

          // Physical boulder strike angular kick & suspension shock impulse!
          const sideLever = Math.max(-1.0, Math.min(1.0, lx));
          this.rollover.rollVel += -sideLever * col.impactSpeed * 0.28 + lnx * col.impactSpeed * 0.22;
          this.rollover.pitchVel += (lz > 0 ? 1 : -1) * col.impactSpeed * 0.16;
          this.rollover.vy += Math.min(4.2, col.impactSpeed * 0.24);
          this.suspension.chassisComVy += Math.min(3.4, col.impactSpeed * 0.22);
          this.suspension.chassisPitchVel += (lz > 0 ? 1 : -1) * col.impactSpeed * 0.18;
          this.suspension.chassisRollVel += -sideLever * col.impactSpeed * 0.24;

          const cg = sampleTerrainHeightForBiome(this.position.x, this.position.z, biome);
          onEmitRoost(
            col.hitX,
            cg + 0.4,
            col.hitZ,
            col.normalX * col.impactSpeed * 0.45,
            2.4 + col.impactSpeed * 0.4,
            col.normalZ * col.impactSpeed * 0.45,
            Math.min(1.0, col.impactSpeed * 0.24),
          );

          if (col.impactSpeed > 1.8) {
            // Find closest wheel corner if corner hit
            let hitWheel = -1;
            if (Math.abs(lx) > 0.48 && Math.abs(lz) > 0.8) {
              if (lz > 0) hitWheel = lx >= 0 ? 0 : 1;
              else hitWheel = lx >= 0 ? 2 : 3;
            }
            const ce = this.crashEventScratch;
            ce.zone = classifyImpactZone(lx, 1.05, lz);
            ce.localPointX = Math.max(-0.98, Math.min(0.98, lx));
            ce.localPointY = 0.96;
            ce.localPointZ = Math.max(-2.54, Math.min(2.48, lz));
            ce.localNormalX = lnx;
            ce.localNormalY = 0.08;
            ce.localNormalZ = lnz;
            ce.worldPointX = col.hitX;
            ce.worldPointY = cg + 0.85;
            ce.worldPointZ = col.hitZ;
            ce.impulseSpeedMs = col.impactSpeed;
            ce.severity = Math.min(1.0, (col.impactSpeed - 1.5) / 16.0);
            ce.onRock = true;
            ce.wheelIndex = hitWheel;
            this.handleCrashImpact(ce);
          }
        }
      }
    } else if (biome === 'rainy_highway') {
      const hwHit = resolveVehicleCapsuleHighwayCollision(
        this.position.x,
        this.position.z,
        this.heading,
        this.brokenFenceIds,
      );
      if (hwHit.hit && hwHit.obstacle) {
        const obs = hwHit.obstacle;
        this.position.x += hwHit.pushX;
        this.position.z += hwHit.pushZ;

        const vn = this.velocity.x * hwHit.normalX + this.velocity.z * hwHit.normalZ;
        const vtx = this.velocity.x - vn * hwHit.normalX;
        const vtz = this.velocity.z - vn * hwHit.normalZ;
        const tangentSpeed = Math.hypot(vtx, vtz);
        const rawNormalImpact = Math.max(0, -vn);
        // High-speed sideswipes against solid tree trunks/poles still shear panels & mirrors!
        const impactSpeed = obs.breakable
          ? rawNormalImpact
          : Math.max(rawNormalImpact, tangentSpeed * 0.34);
        if (obs.breakable) {
          this.brokenFenceIds.add(obs.id);
          // Slight velocity scrub snapping wooden fence post
          this.velocity.multiplyScalar(0.88);
        } else if (vn < 0 || tangentSpeed > 6.0) {
          const restitution = 0.24;
          if (vn < 0) {
            this.velocity.x -= (1 + restitution) * vn * hwHit.normalX;
            this.velocity.z -= (1 + restitution) * vn * hwHit.normalZ;
          }
          this.velocity.multiplyScalar(0.68);
        }
        vForward = this.velocity.x * newSin + this.velocity.z * newCos;
        vLateral = this.velocity.x * newCos - this.velocity.z * newSin;

        if (impactSpeed > 1.8) {
          const hitX = obs.x + hwHit.normalX * obs.radius;
          const hitZ = obs.z + hwHit.normalZ * obs.radius;
          const lx = (hitX - this.position.x) * newCos - (hitZ - this.position.z) * newSin;
          const lz = (hitX - this.position.x) * newSin + (hitZ - this.position.z) * newCos;
          const lnx = hwHit.normalX * newCos - hwHit.normalZ * newSin;
          const lnz = hwHit.normalX * newSin + hwHit.normalZ * newCos;

          const severityScale = obs.breakable ? 0.35 : 1.0;
          const sideLever = Math.max(-1.0, Math.min(1.0, lx));
          this.rollover.rollVel += (-sideLever * impactSpeed * 0.24 + lnx * impactSpeed * 0.18) * severityScale;
          this.rollover.pitchVel += (lz > 0 ? 1 : -1) * impactSpeed * 0.14 * severityScale;
          this.suspension.chassisPitchVel += (lz > 0 ? 1 : -1) * impactSpeed * 0.16 * severityScale;
          this.suspension.chassisRollVel += -sideLever * impactSpeed * 0.20 * severityScale;

          let hitWheel = -1;
          if (Math.abs(lx) > 0.45 && Math.abs(lz) > 0.75) {
            if (lz > 0) hitWheel = lx >= 0 ? 0 : 1;
            else hitWheel = lx >= 0 ? 2 : 3;
          }
          const cg = sampleTerrainHeightForBiome(this.position.x, this.position.z, biome);
          const ce = this.crashEventScratch;
          ce.zone = classifyImpactZone(lx, 1.05, lz);
          ce.localPointX = Math.max(-0.98, Math.min(0.98, lx));
          ce.localPointY = 0.96;
          ce.localPointZ = Math.max(-2.54, Math.min(2.48, lz));
          ce.localNormalX = lnx;
          ce.localNormalY = 0.08;
          ce.localNormalZ = lnz;
          ce.worldPointX = hitX;
          ce.worldPointY = cg + 0.85;
          ce.worldPointZ = hitZ;
          ce.impulseSpeedMs = impactSpeed * severityScale;
          ce.severity = Math.min(1.0, ((impactSpeed - 1.5) / 15.0) * severityScale);
          ce.onRock = !obs.breakable;
          ce.wheelIndex = obs.breakable ? -1 : hitWheel;
          this.handleCrashImpact(ce);
        }
      }
    }

    // Gentle basin boundary steer-in (infinite Z highway corridor in rainy_highway!)
    const distFromOrigin = Math.hypot(this.position.x, this.position.z);
    const maxRadius = isSprint ? 150 : stressMode === 'manual' ? 135 : 95;
    if (isSprint) {
      this.sprintResetDist += speed * safeDt;
    }
    if (biome === 'rainy_highway') {
      if (Math.abs(this.position.x) > 36 && !this.rollover.isRolledOver) {
        const targetHeading = this.position.x > 0 ? -Math.PI * 0.25 : Math.PI * 0.25;
        const diff = Math.atan2(
          Math.sin(targetHeading - this.heading),
          Math.cos(targetHeading - this.heading),
        );
        this.heading += diff * safeDt * 1.1;
      }
    } else if (distFromOrigin > maxRadius && !this.rollover.isRolledOver) {
      const angleToCenter = Math.atan2(-this.position.x, -this.position.z);
      const diff = Math.atan2(
        Math.sin(angleToCenter - this.heading),
        Math.cos(angleToCenter - this.heading),
      );
      this.heading += diff * safeDt * (stressMode === 'manual' ? 1.15 : 1.55);
    }

    // 2. Authentic 6-DOF Rollover + Real 4-Corner Off-Road Coilover Suspension
    const avgContactY =
      0.25 *
      (this.wheelGroundHeights[0] +
        this.wheelGroundHeights[1] +
        this.wheelGroundHeights[2] +
        this.wheelGroundHeights[3]);

    const prevV = this.prevVForward;
    const longAccel = (vForward - prevV) / safeDt;
    this.prevVForward = vForward;
    this.lastLongAccel = longAccel;
    this.lastLatG = Math.max(-2.5, Math.min(2.5, (this.yawRate * vForward) / 9.81));
    this.lastSuspBump = this.suspension.initialized
      ? (this.suspension.travelM[0] + this.suspension.travelM[1]) * 0.5
      : 0;

    // Keep rollover vertical state synced with live coilover suspension while upright so
    // entering rollover override never teleports COM height or loses vertical momentum
    if (!this.prevRolloverActive && this.suspension.initialized) {
      this.rollover.airY = this.suspension.chassisComWorldY - (avgContactY + this.cgHeightM);
      this.rollover.vy = this.suspension.chassisComVy;
    }

    const rollSubsteps = safeDt > 0.025 ? 2 : 1;
    const rollStepDt = safeDt / rollSubsteps;
    const ri = this.rolloverInputScratch;
    ri.dt = rollStepDt;
    ri.vForwardMs = vForward;
    ri.vLateralMs = vLateral;
    ri.yawRateRadS = this.yawRate;
    ri.steerAngleRad = this.steerSmoothed;
    ri.terrainRollSlopeRad = terrainRollSlopeRad;
    ri.terrainPitchSlopeRad = terrainPitchSlopeRad;
    ri.tirePressurePsi = tirePressurePsi;
    ri.avgOnRock = avgOnRock;
    ri.isHandbrake = input.handbrake;

    const rc = this.rolloverCenterScratch;
    rc.x = this.position.x;
    rc.y = this.position.y;
    rc.z = this.position.z;
    rc.sinH = newSin;
    rc.cosH = newCos;

    for (let rs = 0; rs < rollSubsteps; rs++) {
      stepRolloverDynamics(
        this.rollover,
        ri,
        avgContactY,
        this.sampleRolloverSurfaceBound,
        this.handleCrashImpactBound,
        rc,
      );
    }

    const rolloverActive =
      this.rollover.isRolledOver ||
      Math.abs(this.rollover.rollRad) > 0.44 ||
      Math.abs(this.rollover.pitchRad) > 0.38;
    this.prevRolloverActive = rolloverActive;

    const lateralAccelForSusp = vForward * this.yawRate - vLateral * 1.15;
    const si = this.suspensionInputScratch;
    si.dt = safeDt;
    si.tirePressurePsi = tirePressurePsi;
    si.longitudinalAccelMs2 = Math.max(-14, Math.min(14, longAccel));
    si.lateralAccelMs2 = Math.max(-24, Math.min(24, lateralAccelForSusp));
    si.rolloverOverrideActive = rolloverActive;
    si.rolloverRollRad = this.rollover.rollRad;
    si.rolloverPitchRad = this.rollover.pitchRad;
    si.rolloverAirY = this.rollover.airY;
    si.rolloverVy = this.rollover.vy;
    si.rolloverRollVel = this.rollover.rollVel;
    si.rolloverPitchVel = this.rollover.pitchVel;
    si.avgGroundY = avgContactY;
    stepSuspensionDynamics(this.suspension, si);

    const targetWhipPitch = Math.max(-0.48, Math.min(0.35, -vForward * 0.014 - input.throttle * 0.08));
    const targetWhipRoll = Math.max(-0.34, Math.min(0.34, this.yawRate * 0.2 + this.rollover.rollRad * 0.25));
    this.whipPitch += (targetWhipPitch - this.whipPitch) * (1 - Math.exp(-5.2 * safeDt));
    this.whipRoll += (targetWhipRoll - this.whipRoll) * (1 - Math.exp(-5.2 * safeDt));

    // Update dynamic brake (unless smashed!), reverse & turbo glow materials
    const leftTailIntact = !this.damage.taillightBroken[0];
    const rightTailIntact = !this.damage.taillightBroken[1];
    if (leftTailIntact) {
      this.visuals.brakeLightMatLeft.emissiveIntensity = drive.brakeLightsOn ? 3.8 : 0.85;
    }
    if (rightTailIntact) {
      this.visuals.brakeLightMatRight.emissiveIntensity = drive.brakeLightsOn ? 3.8 : 0.85;
    }
    this.lastBrakeLightPower[0] = leftTailIntact ? (drive.brakeLightsOn ? 1.0 : 0.22) : 0.0;
    this.lastBrakeLightPower[1] = rightTailIntact ? (drive.brakeLightsOn ? 1.0 : 0.22) : 0.0;
    this.lastReverseLightPower = drive.reverseLightsOn ? 1.0 : 0.0;
    this.visuals.reverseLightMat.emissiveIntensity = drive.reverseLightsOn ? 2.8 : 0.0;
    this.visuals.boostGlowMat.emissiveIntensity = drive.boostActive && !this.rollover.isRolledOver ? 3.8 : 0.0;

    // Gradually coat lower rocker panels with Sahara dust or mud splatter as the truck drives
    if (speed > 1.2) {
      const dustRate = (0.008 + avgSlip * 0.025) * (biome === 'mud_grass' ? 1.45 : 1.0);
      this.chassisDustLevel = Math.min(0.68, this.chassisDustLevel + dustRate * safeDt);
    }

    // Amortize deformed crash panel vertex normal recomputations (up to 4 geometries/frame)
    let normalsDone = 0;
    while (normalsDone < 4 && this.pendingNormalRecomputeQueue.length > 0) {
      const dirtyGeo = this.pendingNormalRecomputeQueue.shift()!;
      dirtyGeo.computeVertexNormals();
      normalsDone++;
    }

    // Reuse wheelGroundHeights already sampled in this step() instead of re-sampling terrain 4x
    this.syncVisualTransform(safeDt, false, true);
    this.root.updateMatrixWorld(true);

    // Step detached rigid-body debris pieces
    this.stepDebris(safeDt, biome);

    // Flush queued sparks & crash foley audio
    if (onEmitSpark && this.pendingCrashSparkQueue.length > 0) {
      for (let s = 0; s < this.pendingCrashSparkQueue.length; s++) {
        onEmitSpark(this.pendingCrashSparkQueue[s]);
      }
    }
    this.pendingCrashSparkQueue.length = 0;

    if (onCrashAudio && this.pendingCrashAudioQueue.length > 0) {
      for (let a = 0; a < this.pendingCrashAudioQueue.length; a++) {
        onCrashAudio(this.pendingCrashAudioQueue[a]);
      }
    }
    this.pendingCrashAudioQueue.length = 0;

    // 3. Roof / Body Slide Sand Carving + Spark Spray during Rollovers!
    const postSpeed = Math.hypot(vForward, vLateral);
    if (this.rollover.scrapeIntensity > 0.15 && postSpeed > 1.8) {
      _roofSlideWorld.set(0, 1.85, 0.15);
      this.bodyGroup.localToWorld(_roofSlideWorld);
      const slideGround = this.sampleSurfaceAtInto(
        _roofSlideWorld.x,
        _roofSlideWorld.z,
        biome,
        this.surfaceScratch,
      );

      if (_roofSlideWorld.y < slideGround.height + 0.55) {
        // Stamp wide body-plow trench into toroidal sand!
        if (slideGround.onRock < 0.3) {
          const b = this.brushScratch;
          b.posPrevX = _roofSlideWorld.x - this.velocity.x * safeDt;
          b.posPrevY = slideGround.height - 0.12;
          b.posPrevZ = _roofSlideWorld.z - this.velocity.z * safeDt;
          b.halfWidth = 0.72;
          b.posCurrX = _roofSlideWorld.x;
          b.posCurrY = slideGround.height - 0.12;
          b.posCurrZ = _roofSlideWorld.z;
          b.targetSinkage = 0.18;
          b.slipRatio = 0.9;
          b.treadPhasePrev = 0;
          b.treadPhaseCurr = 0;
          b.lateralDrift = 0.6;
          b.brushType = BrushType.Wheel;
          b.atlasId = 0;
          b.compressionWeight = 0.95;
          b.massFactor = 1.4;
          brushEncoder.push(b);
        }

        // Spray sparks when scraping rocks or roll-bar steel!
        if (onEmitSpark && (slideGround.onRock > 0.25 || this.rollover.scrapeIntensity > 0.45)) {
          this.roofScrapeSparkAccum += 18 * this.rollover.scrapeIntensity * safeDt;
          const sp = this.sparkScratch;
          while (this.roofScrapeSparkAccum >= 1.0) {
            this.roofScrapeSparkAccum -= 1.0;
            sp.x = _roofSlideWorld.x + (Math.random() - 0.5) * 0.5;
            sp.y = slideGround.height + 0.14;
            sp.z = _roofSlideWorld.z + (Math.random() - 0.5) * 0.5;
            sp.vx = -this.velocity.x * 0.25 + (Math.random() - 0.5) * 3.8;
            sp.vy = 1.2 + Math.random() * 2.8;
            sp.vz = -this.velocity.z * 0.25 + (Math.random() - 0.5) * 3.8;
            sp.intensity = slideGround.onRock > 0.25 ? 0.95 : 0.6;
            onEmitSpark(sp);
          }
        }

        // Kick up body-slide sand dust plumes!
        if (onEmitSmoke && biome !== 'mud_grass') {
          this.roofScrapeDustAccum += 14 * this.rollover.scrapeIntensity * safeDt;
          const sm = this.smokeScratch;
          while (this.roofScrapeDustAccum >= 1.0) {
            this.roofScrapeDustAccum -= 1.0;
            sm.x = _roofSlideWorld.x + (Math.random() - 0.5) * 0.8;
            sm.y = slideGround.height + 0.18;
            sm.z = _roofSlideWorld.z + (Math.random() - 0.5) * 0.8;
            sm.vx = -this.velocity.x * 0.2 + (Math.random() - 0.5) * 1.4;
            sm.vy = 0.45 + Math.random() * 0.6;
            sm.vz = -this.velocity.z * 0.2 + (Math.random() - 0.5) * 1.4;
            sm.type = SmokeLayerType.DesertDust;
            sm.baseSize = 0.55 + Math.random() * 0.3;
            sm.lifetime = 1.6 + Math.random() * 0.6;
            sm.opacity = 0.34;
            sm.growthMult = 3.8;
            sm.spinRate = (Math.random() < 0.5 ? -1 : 1) * 0.45;
            onEmitSmoke(sm);
          }
        }
      }
    }

    // 3b. Subtle low-mounted EV thermal glycol vapor mist (ONLY when catastrophic front crush
    // breaches the low chiller behind the front valance — NEVER dark combustion smoke out of the frunk!)
    if (onEmitSmoke && mechOut.steamIntensity > 0.12 && !this.rollover.isRolledOver) {
      this.hoodSteamAccum += (3.2 + mechOut.steamIntensity * 6.5) * safeDt;
      const sm = this.smokeScratch;
      while (this.hoodSteamAccum >= 1.0) {
        this.hoodSteamAccum -= 1.0;
        _roofSlideWorld.set(
          (Math.random() - 0.5) * 0.55,
          0.54,
          2.36 + (Math.random() - 0.5) * 0.18,
        );
        this.bodyGroup.localToWorld(_roofSlideWorld);
        sm.x = _roofSlideWorld.x;
        sm.y = _roofSlideWorld.y;
        sm.z = _roofSlideWorld.z;
        sm.vx = this.velocity.x * 0.42 + (Math.random() - 0.5) * 0.35;
        sm.vy = 0.65 + Math.random() * 0.55 + mechOut.steamIntensity * 0.35;
        sm.vz = this.velocity.z * 0.42 + (Math.random() - 0.5) * 0.35;
        sm.type = SmokeLayerType.DriftSmoke;
        sm.baseSize = 0.18 + Math.random() * 0.14 + mechOut.steamIntensity * 0.08;
        sm.lifetime = 0.95 + Math.random() * 0.45;
        sm.opacity = 0.18 + mechOut.steamIntensity * 0.16;
        sm.growthMult = 2.6;
        sm.spinRate = (Math.random() < 0.5 ? -1 : 1) * 0.42;
        onEmitSmoke(sm);
      }
    }

    // 4. Per-Wheel Swept Sand Deformation & Roost / Smoke (only for wheels actually touching ground!)
    const brushHalfWidth = this.tireWidth * 0.62 * tireFootprint.widthScale;
    const driftNormalized = Math.max(-1, Math.min(1, vLateral / 7.5));
    const fwdSign = vForward >= -0.3 ? 1 : -1;

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.steerPivot.getWorldPosition(_wheelWorld);

      // High-speed pothole suspension & tire puncture slam check on rainy rural highway
      if (
        biome === 'rainy_highway' &&
        postSpeed > 15.5 &&
        this.potholeImpactCooldowns[i] <= 0 &&
        isOnPavedHighway(_wheelWorld.x)
      ) {
        const ph = sampleHighwayPotholeInto(_wheelWorld.x, _wheelWorld.z, this.potholeScratch);
        if (ph.depthM > 0.08 && applyPotholeSuspensionImpact(this.damage, i, postSpeed, ph.depthM)) {
          this.potholeImpactCooldowns[i] = 0.72;
          this.crashTrauma = Math.min(0.65, this.crashTrauma + 0.18);
          if (onCrashAudio) {
            const ca = this.crashAudioScratch;
            ca.severity = Math.min(0.55, (postSpeed - 14) / 28);
            ca.onRock = false;
            ca.glassCracked = false;
            onCrashAudio(ca);
          }
        }
      }

      const me = w.steerPivot.matrixWorld.elements;
      let wfx = me[8];
      let wfz = me[10];
      const wfLen = Math.hypot(wfx, wfz);
      if (wfLen > 1e-4) {
        wfx /= wfLen;
        wfz /= wfLen;
      } else {
        wfx = newSin;
        wfz = newCos;
      }
      _wheelFwd.set(wfx, 0, wfz);

      const ground = this.sampleSurfaceAtInto(
        _wheelWorld.x,
        _wheelWorld.z,
        biome,
        this.surfaceScratch,
      );
      const onPavedAsphalt = biome === 'rainy_highway' && isOnPavedHighway(_wheelWorld.x);
      const onRock = onPavedAsphalt ? 1.0 : ground.onRock;
      if (onPavedAsphalt) {
        w.sinkage = 0.0;
      }
      // Check live suspension contact AND 3D wheel height so airborne/lifted tires don't stamp sand!
      const wheelBottomY = _wheelWorld.y - this.tireRadius;
      const suspGrounded = this.suspension.groundContact01[i] > 0.08;
      const wheelTouchingGround = (suspGrounded || wheelBottomY <= ground.height + 0.12) && !this.rollover.isRolledOver;

      w.worldPos.set(_wheelWorld.x, ground.height - w.sinkage * (1 - onRock), _wheelWorld.z);

      const wheelSlip = w.slipRatio;
      const normalLoad = this.wheelNormalLoads[i];
      const omega = this.wheelOmegas[i];
      const effectiveSink = w.sinkage + 0.03 * (1 - onRock);
      const leadExt = computeTireContactLead(this.tireRadius, effectiveSink, brushHalfWidth);

      const dx = w.hasPrevPos ? w.worldPos.x - w.prevWorldPos.x : 0;
      const dz = w.hasPrevPos ? w.worldPos.z - w.prevWorldPos.z : 0;
      const moveDist = Math.hypot(dx, dz);
      const sandStampMask = wheelTouchingGround && !onPavedAsphalt ? Math.max(0, 1.0 - onRock * 1.85) : 0;

      if (!w.hasPrevPos) {
        if (sandStampMask > 0.15) {
          const b = this.brushScratch;
          b.posPrevX = w.worldPos.x - _wheelFwd.x * leadExt;
          b.posPrevY = w.worldPos.y;
          b.posPrevZ = w.worldPos.z - _wheelFwd.z * leadExt;
          b.halfWidth = brushHalfWidth;
          b.posCurrX = w.worldPos.x + _wheelFwd.x * leadExt;
          b.posCurrY = w.worldPos.y;
          b.posCurrZ = w.worldPos.z + _wheelFwd.z * leadExt;
          b.targetSinkage = w.sinkage * sandStampMask;
          b.slipRatio = wheelSlip;
          b.treadPhasePrev = w.prevTreadPhase;
          b.treadPhaseCurr = w.treadPhase;
          b.lateralDrift = driftNormalized;
          b.brushType = BrushType.Wheel;
          b.atlasId = w.isFront ? 0 : 1;
          b.compressionWeight = Math.min(1.0, 0.55 + (normalLoad / 5000) * 0.4);
          b.massFactor = 1.0;
          brushEncoder.push(b);
        }
      } else if (wheelTouchingGround && (moveDist > 0.002 || wheelSlip > 0.12)) {
        const alongTravel = dx * _wheelFwd.x + dz * _wheelFwd.z;
        const travelSign = moveDist > 0.005 ? (alongTravel >= -0.001 ? 1 : -1) : vForward >= -0.1 ? 1 : -1;

        const px1 = w.worldPos.x + _wheelFwd.x * (travelSign * leadExt);
        const pz1 = w.worldPos.z + _wheelFwd.z * (travelSign * leadExt);
        const trailExt = Math.max(0, leadExt - moveDist);
        const px0 = w.prevWorldPos.x - _wheelFwd.x * (travelSign * trailExt);
        const pz0 = w.prevWorldPos.z - _wheelFwd.z * (travelSign * trailExt);

        if (sandStampMask > 0.12) {
          const b = this.brushScratch;
          b.posPrevX = px0;
          b.posPrevY = w.prevWorldPos.y;
          b.posPrevZ = pz0;
          b.halfWidth = brushHalfWidth;
          b.posCurrX = px1;
          b.posCurrY = w.worldPos.y;
          b.posCurrZ = pz1;
          b.targetSinkage = w.sinkage * sandStampMask;
          b.slipRatio = wheelSlip;
          b.treadPhasePrev = w.prevTreadPhase;
          b.treadPhaseCurr = w.treadPhase;
          b.lateralDrift = driftNormalized;
          b.brushType = BrushType.Wheel;
          b.atlasId = w.isFront ? 0 : 1;
          b.compressionWeight = Math.min(1.0, 0.55 + (normalLoad / 5000) * 0.4);
          b.massFactor = 1.0 + wheelSlip * 0.38;
          brushEncoder.push(b);

          if (moveDist > 0.08) {
            terramechanics.recordTrackSegment(
              w.prevWorldPos.x,
              w.prevWorldPos.z,
              px1,
              pz1,
              this.tireWidth * 0.6,
              w.sinkage * sandStampMask,
              Math.min(1.0, 0.62 + w.sinkage * 2.2),
            );
          }
        }

        const wsi = this.wheelSmokeInputScratch;
        wsi.speedMs = postSpeed;
        wsi.wheelSlip = wheelSlip;
        wsi.lateralSpeedMs = vLateral;
        wsi.moisture = moisture;
        wsi.boostActive = drive.boostActive;
        wsi.handbrake = input.handbrake;
        wsi.isRear = !w.isFront;
        wsi.biome = biome;
        const wheelSmoke = computeWheelSmokeEmission(wsi);

        const roostScale = Math.max(0.08, 1.0 - onRock * 0.88);
        if (wheelSmoke.roostIntensity * roostScale > 0.16) {
          const roostEnergy = wheelSmoke.roostIntensity * roostScale * (1.2 + Math.abs(omega) * 0.06);
          const ejectSpeed = 3.2 + Math.min(11.5, roostEnergy * 2.6);
          const ex = -_fwd.x * ejectSpeed * fwdSign - _right.x * vLateral * 0.36;
          const ez = -_fwd.z * ejectSpeed * fwdSign - _right.z * vLateral * 0.36;
          const ey = 2.0 + Math.min(5.2, roostEnergy * 1.15);
          onEmitRoost(
            w.worldPos.x - _wheelFwd.x * 0.24 * fwdSign,
            ground.height + 0.06,
            w.worldPos.z - _wheelFwd.z * 0.24 * fwdSign,
            ex,
            ey,
            ez,
            Math.min(1.0, wheelSmoke.roostIntensity * roostScale),
          );
        }

        if (onEmitSmoke && biome !== 'mud_grass') {
          const speedScale = Math.min(1.0, Math.max(0.28, postSpeed / 10.5));
          const sm = this.smokeScratch;
          if (wheelSmoke.dustIntensity > 0.14) {
            const dustRateHz = (4.2 + wheelSmoke.dustIntensity * 12.0) * (0.48 + 0.52 * speedScale);
            this.wheelDustAccum[i] = Math.min(2.6, this.wheelDustAccum[i] + dustRateHz * safeDt);
            while (this.wheelDustAccum[i] >= 1.0) {
              this.wheelDustAccum[i] -= 1.0;
              const isFineRoostJet = Math.random() < 0.52;
              const kick = (isFineRoostJet ? 2.6 : 1.7) + wheelSmoke.dustIntensity * (isFineRoostJet ? 4.8 : 3.2);
              const kickScaled = kick * (0.55 + 0.45 * speedScale);
              const sideDir = w.isLeft ? 1 : -1;
              const wakeSideBias = w.isFront
                ? sideDir * (0.42 + Math.random() * 0.52) * speedScale
                : sideDir * (0.14 + Math.random() * 0.38 - 0.34 * speedScale);
              sm.x = w.worldPos.x - _fwd.x * (isFineRoostJet ? 0.52 : 0.72) * fwdSign + _right.x * (sideDir * 0.16) + (Math.random() - 0.5) * 0.2;
              sm.y = ground.height + (isFineRoostJet ? 0.11 : 0.08) + Math.random() * 0.08;
              sm.z = w.worldPos.z - _fwd.z * (isFineRoostJet ? 0.52 : 0.72) * fwdSign + _right.z * (sideDir * 0.16) + (Math.random() - 0.5) * 0.2;
              sm.vx = -_fwd.x * kickScaled * fwdSign + _right.x * (wakeSideBias - vLateral * 0.22) + (Math.random() - 0.5) * 0.48;
              sm.vy = (isFineRoostJet ? 0.44 : 0.24) * speedScale + wheelSmoke.dustIntensity * 0.36 + Math.random() * 0.2;
              sm.vz = -_fwd.z * kickScaled * fwdSign + _right.z * (wakeSideBias - vLateral * 0.22) + (Math.random() - 0.5) * 0.48;
              sm.type = SmokeLayerType.DesertDust;
              sm.baseSize = isFineRoostJet
                ? (0.28 + wheelSmoke.dustIntensity * 0.24 + Math.random() * 0.1) * (0.72 + 0.28 * speedScale)
                : (0.5 + wheelSmoke.dustIntensity * 0.42 + Math.random() * 0.18) * (0.68 + 0.32 * speedScale);
              sm.lifetime = isFineRoostJet ? 0.85 + wheelSmoke.dustIntensity * 0.62 + Math.random() * 0.25 : 1.65 + wheelSmoke.dustIntensity * 1.25 * speedScale + Math.random() * 0.45;
              sm.opacity = isFineRoostJet ? (0.36 + wheelSmoke.dustIntensity * 0.32) * (0.65 + 0.35 * speedScale) : (0.22 + wheelSmoke.dustIntensity * 0.26) * (0.6 + 0.4 * speedScale);
              sm.growthMult = isFineRoostJet ? 2.5 + Math.random() * 0.7 : 4.0 + Math.random() * 1.3;
              sm.spinRate = (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.44);
              onEmitSmoke(sm);
            }
          }

          if (wheelSmoke.driftSmokeIntensity > 0.22) {
            const driftRateHz = 4.0 + wheelSmoke.driftSmokeIntensity * 11.0;
            this.wheelDriftAccum[i] = Math.min(2.2, this.wheelDriftAccum[i] + driftRateHz * safeDt);
            while (this.wheelDriftAccum[i] >= 1.0) {
              this.wheelDriftAccum[i] -= 1.0;
              const sideDir = w.isLeft ? 1 : -1;
              const sideSpray = sideDir * (0.55 + Math.random() * 0.65);
              sm.x = w.worldPos.x - _fwd.x * 0.54 * fwdSign + _right.x * (sideDir * 0.16) + (Math.random() - 0.5) * 0.18;
              sm.y = ground.height + 0.09 + Math.random() * 0.09;
              sm.z = w.worldPos.z - _fwd.z * 0.54 * fwdSign + _right.z * (sideDir * 0.16) + (Math.random() - 0.5) * 0.18;
              sm.vx = -_fwd.x * (1.7 + wheelSmoke.driftSmokeIntensity * 2.4) * fwdSign + _right.x * (sideSpray - vLateral * 0.26);
              sm.vy = 0.34 + wheelSmoke.driftSmokeIntensity * 0.58 + Math.random() * 0.22;
              sm.vz = -_fwd.z * (1.7 + wheelSmoke.driftSmokeIntensity * 2.4) * fwdSign + _right.z * (sideSpray - vLateral * 0.26);
              sm.type = SmokeLayerType.DriftSmoke;
              sm.baseSize = 0.38 + wheelSmoke.driftSmokeIntensity * 0.34 + Math.random() * 0.14;
              sm.lifetime = 1.35 + wheelSmoke.driftSmokeIntensity * 0.95 + Math.random() * 0.38;
              sm.opacity = 0.34 + wheelSmoke.driftSmokeIntensity * 0.34;
              sm.growthMult = 3.6 + Math.random() * 1.1;
              sm.spinRate = (Math.random() < 0.5 ? -1 : 1) * (0.34 + Math.random() * 0.48);
              onEmitSmoke(sm);
            }
          }
        }
      }

      w.prevWorldPos.copy(w.worldPos);
      w.hasPrevPos = true;
    }

    let detachedCount = 0;
    for (let k = 0; k < DETACHABLE_PART_KEYS.length; k++) {
      if (this.damage.detached[DETACHABLE_PART_KEYS[k]]) detachedCount++;
    }

    const t = this.telemetryScratch;
    t.speedKmh = speed * 3.6;
    t.avgSinkageCm = avgSinkage * 100;
    t.maxSinkageCm = maxSinkage * 100;
    t.avgSlipRatio = avgSlip;
    t.trackCompactionPct = avgTrackComp * 100;
    t.rollingDragN = totalRollingDrag;
    t.bulldozingN = totalBulldozing;
    t.driftAngleDeg = Math.abs((lateralSlipAngle * 180) / Math.PI);
    t.gear = drive.gear;
    t.rpm = drive.rpm;
    t.boostActive = drive.boostActive;
    t.braking = drive.brakeLightsOn;
    t.integrityPct = this.damage.overallIntegrityPct;
    t.rollDeg = (this.rollover.rollRad * 180) / Math.PI;
    t.isTipping = this.rollover.isTipping;
    t.isRolledOver = this.rollover.isRolledOver;
    t.rollCount = this.rollover.rollCount;
    t.detachedCount = detachedCount;
    t.windshieldCrackLevel = this.damage.windshieldCrackLevel;
    return t;
  }

  private syncVisualTransform(dt: number, snap = false, reuseCachedWheelHeights = false): void {
    const safeDt = Math.min(0.05, Math.max(0.001, dt));
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const fx = sinH;
    const fz = cosH;
    const rx = cosH;
    const rz = -sinH;

    let avgContactY = 0;
    let avgSink = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      if (!reuseCachedWheelHeights) {
        const wx = this.position.x + rx * w.localOffset.x + fx * w.localOffset.z;
        const wz = this.position.z + rz * w.localOffset.x + fz * w.localOffset.z;
        const surf = this.sampleSurfaceAt(wx, wz, this.lastBiome);
        this.wheelOnRock[i] = surf.onRock;
        const sandEmbed = 0.025 * (1 - surf.onRock);
        const contactY = surf.height - w.sinkage * (0.94 - 0.22 * surf.onRock) - sandEmbed;
        this.wheelGroundHeights[i] = contactY;
      }
      avgContactY += this.wheelGroundHeights[i] * 0.25;
      avgSink += w.sinkage * 0.25;
    }
    this.lastCenterGroundY = avgContactY + avgSink * 0.94;

    const pivotH = this.cgHeightM;
    const roll = this.rollover.rollRad;
    const pitch = this.rollover.pitchRad;
    const rolloverActive =
      this.rollover.isRolledOver ||
      Math.abs(roll) > 0.44 ||
      Math.abs(pitch) > 0.38;

    let totalComY = avgContactY + pivotH + this.rollover.airY;

    if (rolloverActive) {
      // Full 6-DOF barrel-roll / side-slide / roof-slide orientation from CrashPhysics
      const frontY = 0.5 * (this.wheelGroundHeights[0] + this.wheelGroundHeights[1]);
      const rearY = 0.5 * (this.wheelGroundHeights[2] + this.wheelGroundHeights[3]);
      const leftY = 0.5 * (this.wheelGroundHeights[0] + this.wheelGroundHeights[2]);
      const rightY = 0.5 * (this.wheelGroundHeights[1] + this.wheelGroundHeights[3]);

      const pitchSlope = (frontY - rearY) / (this.wheelBaseHalf * 2.0);
      const rollSlope = (leftY - rightY) / (this.trackHalf * 2.0);

      _fwd.set(fx, pitchSlope, fz).normalize();
      _right.set(rx, rollSlope, rz).normalize();
      _up.crossVectors(_fwd, _right).normalize();
      _right.crossVectors(_up, _fwd).normalize();

      _matBasis.makeBasis(_right, _up, _fwd);
      _quatTerrain.setFromRotationMatrix(_matBasis);

      _eulerRollPitch.set(pitch, 0, roll, 'YXZ');
      _quatRollPitch.setFromEuler(_eulerRollPitch);
      const desiredQuat = _quatTerrain.multiply(_quatRollPitch);

      if (snap) {
        this.root.quaternion.copy(desiredQuat);
      } else {
        this.root.quaternion.slerp(desiredQuat, computeExpSmoothingFactor(48.0, safeDt));
      }
      this.position.y = avgContactY + this.rollover.airY;
    } else {
      // Genuine sprung-chassis pose driven directly by 4 independent progressive coilovers!
      const tipBlend = Math.max(0, Math.min(1, (Math.abs(roll) - 0.22) / 0.22));
      const suspRoll = this.suspension.chassisRollRad * (1 - tipBlend) + roll * tipBlend;
      const suspPitch = this.suspension.chassisPitchRad;

      _eulerRollPitch.set(suspPitch, this.heading, suspRoll, 'YXZ');
      _quatRollPitch.setFromEuler(_eulerRollPitch);
      if (snap) {
        this.root.quaternion.copy(_quatRollPitch);
      } else {
        this.root.quaternion.slerp(_quatRollPitch, computeExpSmoothingFactor(76.0, safeDt));
      }
      totalComY = this.suspension.initialized
        ? this.suspension.chassisComWorldY
        : avgContactY + pivotH;
      this.position.y = totalComY - pivotH;
    }

    // Rotate root around COM at y=pivotH
    _up.set(0, pivotH, 0).applyQuaternion(this.root.quaternion);
    this.root.position.set(
      this.position.x - _up.x,
      totalComY - _up.y,
      this.position.z - _up.z,
    );

    this.bodyGroup.position.y = 0;
    this.bodyGroup.rotation.set(0, 0, 0);

    const speedRatio = Math.min(1, this.velocity.length() / 7.5);
    const wheelShake =
      this.lastMechOutput.steeringShakeAmp > 0.005
        ? Math.sin(this.mechClockSec * 29.0) * this.lastMechOutput.steeringShakeAmp * speedRatio
        : 0;
    this.visuals.steeringWheel.rotation.z = computeSteeringWheelVisualAngleRad(
      this.steerSmoothed,
      wheelShake,
    );
    this.visuals.whipAntenna.rotation.set(this.whipPitch, 0, this.whipRoll);

    const psiDeflate = Math.max(0, Math.min(1, (32 - this.lastTirePressurePsi) / 20));

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const onRock = this.wheelOnRock[i];
      const wd = this.damage.wheels[i];
      w.steerPivot.rotation.y = w.steerAngle;

      // Combine permanent crash camber with live dynamic suspension camber + sidewall flex!
      this.visuals.wheelAssemblies[i].camberGroup.rotation.z =
        wd.camberRad + this.suspension.dynamicCamberRad[i];

      // Damaged/bent rim wobble rotates realistically with spin!
      const wobbleTilt = wd.wobbleAmp * Math.sin(w.spinAngle);
      w.spinMesh.rotation.set(w.spinAngle, 0, wobbleTilt);

      // Live elastic tire carcass squash under cornering/landing load & air pressure!
      const squash = this.suspension.tireSquash01[i];
      const punctureSquash = wd.punctured ? 0.88 : 1.0;
      const widthBulge =
        1.0 +
        psiDeflate * (0.06 + onRock * 0.03) +
        squash * (0.085 + psiDeflate * 0.045) +
        (wd.punctured ? 0.14 : 0);
      const radialSquash =
        (1.0 - psiDeflate * 0.022 - squash * (0.052 + psiDeflate * 0.028)) * punctureSquash;
      w.spinMesh.scale.set(widthBulge, radialSquash, radialSquash);

      const localTravel = this.suspension.initialized
        ? this.suspension.travelM[i]
        : 0;
      if (i === 2) {
        this.lastRearLeftTravelY = localTravel;
      }
      w.steerPivot.position.y = this.tireRadius * radialSquash + localTravel;

      const armLen = Math.max(0.32, Math.abs(w.localOffset.x) - 0.44);
      const armAngle = (w.isLeft ? 1 : -1) * Math.atan2(localTravel, armLen);
      w.lowerArm.rotation.z = armAngle;
      w.upperArm.rotation.z = armAngle * 0.88;
      w.coilGroup.scale.y = Math.max(0.62, Math.min(1.38, 1.0 - localTravel * 1.48));
    }

    // Fade contact shadow naturally when airborne or overturned!
    const cosR = Math.cos(rolloverActive ? roll : this.suspension.chassisRollRad);
    const bodyAirGap = Math.max(0, totalComY - (avgContactY + pivotH));
    const uprightFade = Math.max(0, cosR) * Math.max(0, 1 - bodyAirGap * 0.65);
    (this.visuals.contactShadow.material as THREE.MeshBasicMaterial).opacity = 0.52 * uprightFade;
    this.visuals.contactShadow.position.y = 0.04 + avgSink * 0.4;
  }

  public getForwardVector(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /**
   * Extracts the live 3D orthonormal chassis basis (with real pitch, roll & rollover angles)
   * plus ground clearance and uprightness for terrain contact AO, analytical shadows & 3D headlights.
   */
  public getTerrainPoseData(
    fwdOut: THREE.Vector3,
    rightOut: THREE.Vector3,
    upOut: THREE.Vector3,
  ): { clearanceY: number; upright01: number } {
    this.root.updateMatrixWorld(true);
    const me = this.bodyGroup.matrixWorld.elements;
    rightOut.set(me[0], me[1], me[2]).normalize();
    upOut.set(me[4], me[5], me[6]).normalize();
    fwdOut.set(me[8], me[9], me[10]).normalize();

    const tp = this.terrainPoseScratch;
    tp.clearanceY = Math.max(0, this.position.y - this.lastCenterGroundY);
    tp.upright01 = this.rollover.isRolledOver
      ? 0.0
      : Math.max(0, Math.min(1, (upOut.y - 0.35) / 0.55));
    return tp;
  }

  public getFrontLeftWheelWorldPos(out: THREE.Vector3): THREE.Vector3 {
    const w = this.wheels[0];
    return out.copy(w.worldPos);
  }

  public getFenderCamPose(posOut: THREE.Vector3, targetOut: THREE.Vector3): void {
    this.root.updateMatrixWorld(true);
    posOut.set(1.96, 1.38, -0.78);
    this.root.localToWorld(posOut);
    targetOut.set(0.72, 0.24, 2.05);
    this.root.localToWorld(targetOut);
  }

  public getGoProRearCamPose(
    posOut: THREE.Vector3,
    targetOut: THREE.Vector3,
    timeSec: number,
    aspect: number,
    boostActive: boolean,
  ): number {
    this.root.updateMatrixWorld(true);
    const rl = this.wheels[2];
    const pose = computeGoProRearCamLocalPose({
      timeSec,
      speedMs: this.velocity.length(),
      wheelSlip: rl ? rl.slipRatio : 0,
      boostActive,
      wheelTravelY: this.lastRearLeftTravelY,
      aspect,
    });
    posOut.set(pose.posX, pose.posY, pose.posZ);
    this.root.localToWorld(posOut);
    targetOut.set(pose.targetX, pose.targetY, pose.targetZ);
    this.root.localToWorld(targetOut);
    return pose.fovDeg;
  }

  public getCockpitRig(): RaptorCockpitRig {
    return this.visuals.cockpit;
  }

  public setCockpitActive(isCockpit: boolean): void {
    this.visuals.cockpit.setCockpitActive(isCockpit);
  }

  public setGraphicsQuality(
    quality: GraphicsQuality,
    isMobile: boolean,
    isSoftwareGl: boolean,
  ): void {
    const budget = getGraphicsQualityBudget(quality, isMobile, isSoftwareGl);
    this.visuals.setTextureAnisotropy?.(budget.maxTextureAnisotropy);
  }

  public getDamageState(): Readonly<VehicleDamageState> {
    return this.damage;
  }

  public getCockpitMotionSignals(): {
    speedMs: number;
    accelForwardMs2: number;
    lateralG: number;
    suspensionBump: number;
  } {
    const m = this.cockpitMotionScratch;
    m.speedMs = this.velocity.length();
    m.accelForwardMs2 = this.lastLongAccel;
    m.lateralG = this.lastLatG;
    m.suspensionBump = this.lastSuspBump;
    return m;
  }

  public getPitchDeg(): number {
    return (this.suspension.chassisPitchRad * 180) / Math.PI;
  }

  /**
   * Computes exact 1st-person Rivian R1T driver POV rigidly mounted inside bodyGroup,
   * framing the steering wheel, driver digital cluster, 15.6" center touchscreen, A-pillar,
   * left wing mirror, and central rearview mirror cleanly.
   */
  public getCockpitCamPose(
    posOut: THREE.Vector3,
    targetOut: THREE.Vector3,
    upOut: THREE.Vector3,
    headPitchRad: number,
    headRollRad: number,
    headHeaveM: number,
    lookYawRad: number,
    lookPitchRad: number,
  ): void {
    this.root.updateMatrixWorld(true);
    const eyeX = 0.37;
    const eyeY = 1.495 + headHeaveM;
    const eyeZ = 0.08;
    posOut.set(eyeX, eyeY, eyeZ);
    this.bodyGroup.localToWorld(posOut);

    // Slight natural rightward yaw toward road center & touchscreen + slight downward pitch
    const baseYaw = -0.06 + lookYawRad;
    const basePitch = -0.09 + headPitchRad + lookPitchRad;
    const lookDist = 14.0;
    const lx = eyeX + Math.sin(baseYaw) * Math.cos(basePitch) * lookDist;
    const ly = eyeY + Math.sin(basePitch) * lookDist;
    const lz = eyeZ + Math.cos(baseYaw) * Math.cos(basePitch) * lookDist;
    targetOut.set(lx, ly, lz);
    this.bodyGroup.localToWorld(targetOut);

    // Transform cab local up (with subtle lateral G head roll) into world space so camera rolls with cab & rollover!
    upOut.set(Math.sin(headRollRad), Math.cos(headRollRad), 0);
    upOut.transformDirection(this.bodyGroup.matrixWorld).normalize();
  }

  public updateCockpitVisuals(
    timeSec: number,
    rainIntensity: number,
    wiperLeftRad: number,
    wiperRightRad: number,
    wipeFreshness: number,
  ): void {
    const c = this.visuals.cockpit;
    c.updateWipers(wiperLeftRad, wiperRightRad, wipeFreshness);

    const speedMs = this.velocity.length();
    const crack = this.damage.windshieldCrackLevel;

    c.windshieldRainUniforms.uTime.value = timeSec;
    c.windshieldRainUniforms.uRainIntensity.value = rainIntensity;
    c.windshieldRainUniforms.uSpeedMs.value = speedMs;
    c.windshieldRainUniforms.uCrackLevel.value = crack;

    c.sideGlassRainUniforms.uTime.value = timeSec;
    c.sideGlassRainUniforms.uRainIntensity.value = rainIntensity;
    c.sideGlassRainUniforms.uSpeedMs.value = speedMs;
    const sideCrack =
      this.damage.sideGlassBroken[0] || this.damage.sideGlassBroken[1]
        ? Math.max(1.35, crack)
        : Math.max(0, crack - 1);
    c.sideGlassRainUniforms.uCrackLevel.value = sideCrack;
  }

  public attachMirrorMaterials(
    leftMat: THREE.Material,
    rightMat: THREE.Material,
    interiorMat: THREE.Material,
  ): void {
    const helper = (
      this.visuals as TrophyTruckVisuals & {
        __attachMirrors?: (
          l: THREE.Material,
          r: THREE.Material,
          i: THREE.Material,
        ) => void;
      }
    ).__attachMirrors;
    if (helper) {
      helper(leftMat, rightMat, interiorMat);
    } else {
      this.visuals.leftMirrorLensMesh.material = leftMat;
      this.visuals.rightMirrorLensMesh.material = rightMat;
      this.visuals.interiorMirrorLensMesh.material = interiorMat;
    }
  }

  public getGroundHeight(): number {
    return this.lastCenterGroundY;
  }

  private lastBoundGain = -1;

  public setReflectionEnvironment(
    envMap: THREE.Texture | null,
    reflectionIntensity: number,
  ): void {
    const matCount = this.visuals.reflectiveMaterials.length;
    const gain = Math.max(0.15, Math.min(2.0, reflectionIntensity));
    const envChanged =
      envMap !== this.lastBoundEnvMap || matCount !== this.lastBoundMaterialCount;
    const gainChanged = Math.abs(gain - this.lastBoundGain) > 1e-4;
    if (!envChanged && !gainChanged) {
      return;
    }
    // Shader recompilation is only required when transitioning between null <-> non-null envMap
    const nullStateChanged =
      this.lastBoundEnvMap === undefined ||
      matCount !== this.lastBoundMaterialCount ||
      (this.lastBoundEnvMap === null) !== (envMap === null);
    this.lastBoundEnvMap = envMap;
    this.lastBoundMaterialCount = matCount;
    this.lastBoundGain = gain;
    for (let i = 0; i < matCount; i++) {
      const item = this.visuals.reflectiveMaterials[i];
      if (envChanged) {
        item.material.envMap = envMap;
        if (nullStateChanged) {
          item.material.needsUpdate = true;
        }
      }
      item.material.envMapIntensity = item.baseEnvIntensity * gain;
    }
  }

  private lastCockpitMirrorState: {
    leftYaw: number;
    leftPitch: number;
    rightYaw: number;
    rightPitch: number;
    intYaw: number;
    intPitch: number;
    fold01: number;
  } = {
    leftYaw: 0,
    leftPitch: 0,
    rightYaw: 0,
    rightPitch: 0,
    intYaw: 0,
    intPitch: 0,
    fold01: 0,
  };

  /**
   * Applies interactive SYNC 4 & 3D switch lighting state (headlights Off/Low/High,
   * roof LED lightbar, amber grille markers, blinking hazards, dome light, 6-color
   * ambient LEDs, Ray/Path-Tracing GI) AND motorized wing/interior mirror articulation.
   */
  public syncCockpitLightingAndMirrors(
    cockpitState: Readonly<CockpitRuntimeState>,
    weather: WeatherPreset,
    timeSec: number,
  ): void {
    this.lastWeatherPreset = weather;
    const leftIntact = !this.damage.headlightBroken[0];
    const rightIntact = !this.damage.headlightBroken[1];
    const lightbarIntact = !this.damage.detached.lightBar;

    // 1. Headlights: Off / Low / High (controls projector lenses, DRLs, forward SpotLight & terrain beam pools!)
    const hlMode = cockpitState.headlightMode;
    const headEmissive = hlMode === 'high' ? 5.2 : hlMode === 'low' ? 3.2 : 0.14;
    const terrainPower = hlMode === 'high' ? 1.55 : hlMode === 'low' ? 0.92 : 0.0;
    const lightbarActive = cockpitState.lightbarOn && lightbarIntact;

    const totalTerrainPower = terrainPower + (lightbarActive ? 0.72 : 0.0);

    if (leftIntact) {
      this.visuals.headlightLensMatLeft.emissiveIntensity = headEmissive;
      this.lastHeadlightPower[0] = totalTerrainPower;
    } else {
      this.visuals.headlightLensMatLeft.emissiveIntensity = 0.0;
      this.lastHeadlightPower[0] = lightbarActive ? 0.45 : 0.0;
    }

    if (rightIntact) {
      this.visuals.headlightLensMatRight.emissiveIntensity = headEmissive;
      this.lastHeadlightPower[1] = totalTerrainPower;
    } else {
      this.visuals.headlightLensMatRight.emissiveIntensity = 0.0;
      this.lastHeadlightPower[1] = lightbarActive ? 0.45 : 0.0;
    }

    const anyFrontLamp = leftIntact || rightIntact;
    const beamIntensity =
      (anyFrontLamp ? (hlMode === 'high' ? 16.0 : hlMode === 'low' ? 7.5 : 0.0) : 0.0) +
      (lightbarActive ? 14.0 : 0.0);
    this.visuals.forwardBeamSpot.intensity = beamIntensity;
    this.visuals.forwardBeamSpot.distance = hlMode === 'high' || lightbarActive ? 68 : 42;
    this.visuals.forwardBeamSpot.target.position.set(
      0,
      hlMode === 'high' || lightbarActive ? 0.75 : 0.22,
      24.0,
    );

    // Independent Left / Center / Right Rivian LED DRL bars (smashing right corner kills right DRL only!)
    const drlPower = hlMode === 'high' ? 3.8 : hlMode === 'low' ? 2.6 : 0.65;
    const centerBarIntact = anyFrontLamp && this.damage.zoneIntegrity.front >= 0.42;
    this.visuals.ledDrlMat.emissiveIntensity = centerBarIntact ? drlPower : 0.0;
    if (this.visuals.ledDrlMatLeft) {
      this.visuals.ledDrlMatLeft.emissiveIntensity = leftIntact ? drlPower : 0.0;
    }
    if (this.visuals.ledDrlMatRight) {
      this.visuals.ledDrlMatRight.emissiveIntensity = rightIntact ? drlPower : 0.0;
    }

    // 2. Iconic 3 Amber Raptor Grille Markers
    this.visuals.amberMarkerMat.emissiveIntensity = cockpitState.grilleAmberOn ? 2.45 : 0.06;

    // 3. Off-Road Roof LED Lightbar
    this.visuals.lightbarLedMat.emissiveIntensity = lightbarActive ? 6.2 : 0.04;

    // 4. Blinking Hazard / Turn-Signal Amber LEDs
    const hazardFlash01 = computeHazardFlash01(timeSec, cockpitState.hazardOn);
    this.visuals.hazardLampMat.emissiveIntensity = cockpitState.hazardOn
      ? 0.15 + hazardFlash01 * 5.2
      : cockpitState.grilleAmberOn
        ? 0.95
        : 0.08;

    // 5. Motorized Wing-Mirror Power-Fold & Subtle Fine Tilt
    const fold01 = cockpitState.mirrorFold01;
    const smoothFold = fold01 * fold01 * (3 - 2 * fold01);
    const leftM = cockpitState.mirrors.left;
    const rightM = cockpitState.mirrors.right;
    const intM = cockpitState.mirrors.interior;

    this.visuals.leftMirrorPivot.rotation.set(
      leftM.pitchRad * 0.28,
      smoothFold * 1.18 + leftM.yawRad * 0.28,
      0,
    );
    this.visuals.rightMirrorPivot.rotation.set(
      rightM.pitchRad * 0.28,
      -smoothFold * 1.18 + rightM.yawRad * 0.28,
      0,
    );

    this.lastCockpitMirrorState.leftYaw = leftM.yawRad;
    this.lastCockpitMirrorState.leftPitch = leftM.pitchRad;
    this.lastCockpitMirrorState.rightYaw = rightM.yawRad;
    this.lastCockpitMirrorState.rightPitch = rightM.pitchRad;
    this.lastCockpitMirrorState.intYaw = intM.yawRad;
    this.lastCockpitMirrorState.intPitch = intM.pitchRad;
    this.lastCockpitMirrorState.fold01 = smoothFold;

    // 6. Cockpit Ray-Traced / Path-Traced Area-Light GI & Interior Dome/Ambient LEDs
    this.root.updateMatrixWorld(true);
    const ambientPreset = getActiveAmbientPreset(cockpitState);
    const syncScreenHex =
      cockpitState.activeTab === 'lights'
        ? ambientPreset.hex
        : cockpitState.activeTab === 'mirrors'
          ? '#38bdf8'
          : cockpitState.activeTab === 'apps'
            ? '#f59e0b'
            : '#22c55e';

    this.visuals.cockpit.updateLightingAndMirrors({
      bodyWorldMatrix: this.bodyGroup.matrixWorld,
      rayTracedLighting: cockpitState.rayTracedLighting,
      rtBounceStrength: cockpitState.rtBounceStrength,
      ambientLightOn: cockpitState.ambientLightOn,
      ambientColorHex: ambientPreset.hex,
      ambientIntensity: cockpitState.ambientIntensity,
      domeLightOn: cockpitState.domeLightOn,
      headlightPower: Math.max(this.lastHeadlightPower[0], this.lastHeadlightPower[1]),
      lightbarOn: lightbarActive,
      hazardFlash01,
      syncScreenHex,
      interiorMirrorYawRad: intM.yawRad,
      interiorMirrorPitchRad: intM.pitchRad,
      timeSec,
    });
  }

  public updateHeadlightsForWeather(weather: WeatherPreset): void {
    const leftIntact = !this.damage.headlightBroken[0];
    const rightIntact = !this.damage.headlightBroken[1];
    const key = `${weather}|${leftIntact ? 1 : 0}|${rightIntact ? 1 : 0}`;
    if (key === this.lastHeadlightWeatherKey) return;
    this.lastHeadlightWeatherKey = key;
    this.lastWeatherPreset = weather;
    const spec = WEATHER_PRESET_SPECS[weather];

    const headIntensity = spec.headlightsOn ? 3.85 : 0.72;
    const headTerrainPower = spec.headlightsOn ? 1.0 : 0.16;

    if (leftIntact) {
      this.visuals.headlightLensMatLeft.emissiveIntensity = headIntensity;
      this.lastHeadlightPower[0] = headTerrainPower;
    } else {
      this.visuals.headlightLensMatLeft.emissiveIntensity = 0.0;
      this.lastHeadlightPower[0] = 0.0;
    }
    if (rightIntact) {
      this.visuals.headlightLensMatRight.emissiveIntensity = headIntensity;
      this.lastHeadlightPower[1] = headTerrainPower;
    } else {
      this.visuals.headlightLensMatRight.emissiveIntensity = 0.0;
      this.lastHeadlightPower[1] = 0.0;
    }
    const anyFrontLamp = leftIntact || rightIntact;
    const drlIntensity = spec.headlightsOn || spec.lightbarOn ? 3.2 : 1.85;
    const centerBarIntact = anyFrontLamp && this.damage.zoneIntegrity.front >= 0.42;
    this.visuals.ledDrlMat.emissiveIntensity = centerBarIntact ? drlIntensity : 0.0;
    if (this.visuals.ledDrlMatLeft) {
      this.visuals.ledDrlMatLeft.emissiveIntensity = leftIntact ? drlIntensity : 0.0;
    }
    if (this.visuals.ledDrlMatRight) {
      this.visuals.ledDrlMatRight.emissiveIntensity = rightIntact ? drlIntensity : 0.0;
    }
  }

  public getMirrorAnchors(
    leftOut: MirrorAnchorInfo,
    rightOut: MirrorAnchorInfo,
    interiorOut: MirrorAnchorInfo,
  ): void {
    this.root.updateMatrixWorld(true);
    const me = this.bodyGroup.matrixWorld.elements;
    // Vehicle basis: +X = left, +Y = up, +Z = forward
    leftOut.worldRight.set(me[0], me[1], me[2]).normalize();
    leftOut.worldUp.set(me[4], me[5], me[6]).normalize();
    leftOut.worldForward.set(me[8], me[9], me[10]).normalize();

    rightOut.worldRight.copy(leftOut.worldRight);
    rightOut.worldUp.copy(leftOut.worldUp);
    rightOut.worldForward.copy(leftOut.worldForward);

    interiorOut.worldRight.copy(leftOut.worldRight);
    interiorOut.worldUp.copy(leftOut.worldUp);
    interiorOut.worldForward.copy(leftOut.worldForward);

    this.visuals.leftMirrorLensMesh.getWorldPosition(leftOut.worldPos);
    leftOut.detached = Boolean(this.damage.detached.leftMirror);
    leftOut.yawOffsetRad = this.lastCockpitMirrorState.leftYaw;
    leftOut.pitchOffsetRad = this.lastCockpitMirrorState.leftPitch;
    leftOut.fold01 = this.lastCockpitMirrorState.fold01;

    this.visuals.rightMirrorLensMesh.getWorldPosition(rightOut.worldPos);
    rightOut.detached = Boolean(this.damage.detached.rightMirror);
    rightOut.yawOffsetRad = this.lastCockpitMirrorState.rightYaw;
    rightOut.pitchOffsetRad = this.lastCockpitMirrorState.rightPitch;
    rightOut.fold01 = this.lastCockpitMirrorState.fold01;

    this.visuals.interiorMirrorLensMesh.getWorldPosition(interiorOut.worldPos);
    interiorOut.detached = false;
    interiorOut.yawOffsetRad = this.lastCockpitMirrorState.intYaw;
    interiorOut.pitchOffsetRad = this.lastCockpitMirrorState.intPitch;
    interiorOut.fold01 = 0;
  }

  public getActiveLampPowers(): {
    headlightLeft: number;
    headlightRight: number;
    brakeLeft: number;
    brakeRight: number;
    reverse: number;
  } {
    const lp = this.lampPowersScratch;
    lp.headlightLeft = this.lastHeadlightPower[0];
    lp.headlightRight = this.lastHeadlightPower[1];
    lp.brakeLeft = this.lastBrakeLightPower[0];
    lp.brakeRight = this.lastBrakeLightPower[1];
    lp.reverse = this.lastReverseLightPower;
    return lp;
  }

  public getChassisDustLevel(): number {
    return this.chassisDustLevel;
  }

  public dispose(): void {
    this.clearDebris();
    this.visuals.dispose();
  }
}
