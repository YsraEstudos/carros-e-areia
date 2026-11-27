import test from 'node:test';
import assert from 'node:assert/strict';

import { computeEffectivePixelRatio, SAND_DEFAULTS } from './SandParams';
import {
  classifyRivianNodeRole,
  getGraphicsQualityBudget,
} from './GraphicsQualityBudget';
import {
  ReflectionCubeScheduleDecision,
  ReflectionCubeScheduleInput,
  ReflectionCubeScheduler,
  computeBiomeReflectionBounds,
  computeConeTracedMipLevel,
  computeDielectricFresnel,
  computeLagardeSpecularOcclusion,
  computeSelfBodyOcclusion,
  projectParallaxReflectionRay,
} from './ReflectionRayMath';
import {
  sampleBaseTerrain,
  sampleBaseTerrainHeight,
  sampleMudGrassZoneMask,
  sampleMudHollowFactor,
  sampleUnevenSandOffset,
} from './TerrainHeightfield';
import { ToroidalCascade } from './ToroidalCascade';
import { BrushEncoder, BrushType } from './BrushEncoder';
import {
  computeTireContactLead,
  computeTireFootprintScale,
  SandTerramechanics,
} from './SandTerramechanics';
import {
  CLIMBABLE_ROCK_SLABS,
  evalSingleClimbableRockElevation,
  generateDesertRockObstacles,
  resolveRockCollisions,
  sampleClimbableRockSurface,
} from './DesertObstacles';
import { SleepController } from './SleepController';
import {
  CAMERA_CYCLE_ORDER,
  computeGoProRearCamLocalPose,
  computePortraitCameraAdjust,
  computeSpeedSensitiveMaxSteerRad,
  computeSteeringWheelVisualAngleRad,
  EMPTY_VIRTUAL_FLAGS,
  evaluateVehicleDriveStep,
  getNextCameraMode,
  mergeVehicleInputs,
  resolveVirtualControls,
} from './VehicleDriveModel';
import {
  computeExhaustSmokeEmission,
  computeWheelSmokeEmission,
  generateVolumetricSmokeAtlas,
} from './SmokePhysics';
import { generateMudDetailTexture } from './MudTextureGenerator';
import {
  applyImpactToDamageState,
  classifyImpactZone,
  createInitialDamageState,
  createInitialRolloverState,
  CrashImpactEvent,
  deformSubmeshVertices,
  localVectorXZToWorld,
  stepRolloverDynamics,
} from './VehicleCrashPhysics';
import {
  computeExpSmoothingFactor,
  computeStaticCornerLoadN,
  createInitialSuspensionState,
  evaluateTireCorneringAndYaw,
  rotateBodyVelocityByHeadingDelta,
  snapSuspensionToGround,
  stepSuspensionDynamics,
  SuspensionWheelCorner,
} from './VehicleSuspensionPhysics';
import { RunnerRig } from '../adapters/RunnerRig';

test('ToroidalCascade: integer texel snapping and round-trip UV<->world reconstruction', () => {
  const c0 = new ToroidalCascade(SAND_DEFAULTS.CASCADE0_SIZE, SAND_DEFAULTS.CASCADE_RESOLUTION);
  c0.updateFocus(13.741, -28.319);

  const win = c0.getCurrentWindow();
  // Origin must be snapped to exact integer multiples of texelSize
  const rx = win.originX / c0.texelSize;
  const rz = win.originZ / c0.texelSize;
  assert.ok(Math.abs(rx - Math.round(rx)) < 1e-6, 'originX should be texel-snapped');
  assert.ok(Math.abs(rz - Math.round(rz)) < 1e-6, 'originZ should be texel-snapped');

  // Round-trip world -> UV -> world inside current window (including negative coordinates)
  const testPoints: [number, number][] = [
    [win.originX, win.originZ],
    [win.originX + 3.12, win.originZ - 4.45],
    [win.originX - 5.1, win.originZ + 2.75],
  ];

  for (const [wx, wz] of testPoints) {
    const [u, v] = c0.worldToToroidalUV(wx, wz);
    assert.ok(u >= 0 && u < 1, 'u must stay in [0, 1)');
    assert.ok(v >= 0 && v < 1, 'v must stay in [0, 1)');
    const [recX, recZ] = c0.toroidalUVToWorld(u, v);
    assert.ok(Math.abs(recX - wx) < 1e-5, `recX mismatch: ${recX} vs ${wx}`);
    assert.ok(Math.abs(recZ - wz) < 1e-5, `recZ mismatch: ${recZ} vs ${wz}`);
  }
});

test('ToroidalCascade: zero-copy clear detects newly exposed strip and 500m teleport cleanly', () => {
  const c0 = new ToroidalCascade(12.0, 512);
  c0.updateFocus(0, 0);
  // First step clears everything; second step at same focus should preserve interior
  c0.updateFocus(0, 0);
  const [uCenter, vCenter] = c0.worldToToroidalUV(0, 0);
  assert.equal(c0.shouldClearTexel(uCenter, vCenter), false, 'interior texel must not clear when static');

  // Move forward +2.0m in X: new strip near +7.0m must clear, old overlap at +1.0m must persist
  const step = c0.updateFocus(2.0, 0);
  assert.equal(step.moved, true);
  assert.equal(step.teleported, false);

  const [uOldOverlap, vOldOverlap] = c0.worldToToroidalUV(1.0, 0);
  assert.equal(c0.shouldClearTexel(uOldOverlap, vOldOverlap), false, 'overlapping interior must stay intact');

  const [uExposed, vExposed] = c0.worldToToroidalUV(7.0, 0);
  assert.equal(c0.shouldClearTexel(uExposed, vExposed), true, 'newly exposed leading edge must clear');

  // Stress test Marco 1: teleport 500m away -> entire cascade must flag teleported & clear
  const tp = c0.updateFocus(502.0, 0);
  assert.equal(tp.teleported, true);
  const [uNewCenter, vNewCenter] = c0.worldToToroidalUV(502.0, 0);
  assert.equal(c0.shouldClearTexel(uNewCenter, vNewCenter), true, 'teleported window must clear stale wrapped tracks');
});

test('ToroidalCascade: smooth crossfade weight drops to 0 before outer guard band', () => {
  const c0 = new ToroidalCascade(12.0, 512);
  c0.updateFocus(0, 0);
  assert.equal(c0.computeCascadeWeight(0, 0), 1.0);
  assert.equal(c0.computeCascadeWeight(4.0, 0), 1.0);
  const midFade = c0.computeCascadeWeight(5.55, 0);
  assert.ok(midFade > 0.0 && midFade < 1.0, `expected smooth mid-crossfade, got ${midFade}`);
  assert.equal(c0.computeCascadeWeight(5.98, 0), 0.0);
});

test('BrushEncoder: packs exact 64-byte (4 x vec4) std140 layout and respects capacity', () => {
  const encoder = new BrushEncoder(4);
  assert.equal(encoder.getByteLength(), 4 * 64);

  const ok = encoder.push({
    posPrevX: 1.5,
    posPrevY: 0.2,
    posPrevZ: -3.0,
    halfWidth: 0.22,
    posCurrX: 2.0,
    posCurrY: 0.25,
    posCurrZ: -2.5,
    targetSinkage: 0.14,
    slipRatio: 0.65,
    treadPhasePrev: 1.0,
    treadPhaseCurr: 2.4,
    lateralDrift: -0.4,
    brushType: BrushType.Wheel,
    atlasId: 0,
    compressionWeight: 0.85,
    massFactor: 1.2,
  });

  assert.equal(ok, true);
  assert.equal(encoder.getCount(), 1);

  // Verify exact float offsets matching GLSL SandBrush struct
  assert.ok(Math.abs(encoder.buffer[0] - 1.5) < 1e-6);
  assert.ok(Math.abs(encoder.buffer[3] - 0.22) < 1e-6);
  assert.ok(Math.abs(encoder.buffer[7] - 0.14) < 1e-6);
  assert.ok(Math.abs(encoder.buffer[8] - 0.65) < 1e-6);
  assert.ok(Math.abs(encoder.buffer[12] - BrushType.Wheel) < 1e-6);
  assert.ok(Math.abs(encoder.buffer[15] - 1.2) < 1e-6);

  // Capacity overflow returns false
  encoder.push({
    posPrevX: 0, posPrevY: 0, posPrevZ: 0, halfWidth: 0.1,
    posCurrX: 0, posCurrY: 0, posCurrZ: 0, targetSinkage: 0.04,
    slipRatio: 0, treadPhasePrev: 0, treadPhaseCurr: 0, lateralDrift: 0,
    brushType: BrushType.Foot, atlasId: 1, compressionWeight: 0.7, massFactor: 1.0,
  });
  encoder.push({
    posPrevX: 0, posPrevY: 0, posPrevZ: 0, halfWidth: 0.1,
    posCurrX: 0, posCurrY: 0, posCurrZ: 0, targetSinkage: 0.04,
    slipRatio: 0, treadPhasePrev: 0, treadPhaseCurr: 0, lateralDrift: 0,
    brushType: BrushType.Foot, atlasId: 1, compressionWeight: 0.7, massFactor: 1.0,
  });
  encoder.push({
    posPrevX: 0, posPrevY: 0, posPrevZ: 0, halfWidth: 0.1,
    posCurrX: 0, posCurrY: 0, posCurrZ: 0, targetSinkage: 0.04,
    slipRatio: 0, treadPhasePrev: 0, treadPhaseCurr: 0, lateralDrift: 0,
    brushType: BrushType.Foot, atlasId: 1, compressionWeight: 0.7, massFactor: 1.0,
  });
  const overflow = encoder.push({
    posPrevX: 0, posPrevY: 0, posPrevZ: 0, halfWidth: 0.1,
    posCurrX: 0, posCurrY: 0, posCurrZ: 0, targetSinkage: 0.04,
    slipRatio: 0, treadPhasePrev: 0, treadPhaseCurr: 0, lateralDrift: 0,
    brushType: BrushType.Foot, atlasId: 1, compressionWeight: 0.7, massFactor: 1.0,
  });
  assert.equal(overflow, false);
  assert.equal(encoder.getCount(), 4);
});

test('SandTerramechanics: slip sinkage, compacted track relief, bulldozing, and Foot IK bounds', () => {
  const tm = new SandTerramechanics(64);

  const looseRoll = tm.evaluateWheelContact({
    worldX: 5,
    worldZ: 5,
    normalLoadN: 3400,
    tireWidth: 0.34,
    tireRadius: 0.44,
    slipRatio: 0.05,
    lateralSlipRad: 0.0,
    moisture: 0.1,
  });

  const spinningWheel = tm.evaluateWheelContact({
    worldX: 5,
    worldZ: 5,
    normalLoadN: 3400,
    tireWidth: 0.34,
    tireRadius: 0.44,
    slipRatio: 0.85,
    lateralSlipRad: 0.45,
    moisture: 0.1,
  });

  // Spinning wheel must dig noticeably deeper, suffer higher rolling drag & bulldozing
  assert.ok(spinningWheel.sinkage > looseRoll.sinkage * 1.4, 'slip must increase Bekker sinkage');
  assert.ok(spinningWheel.rollingResistanceN > looseRoll.rollingResistanceN * 1.8, 'deeper sinkage increases z^(n+1) drag');
  assert.ok(spinningWheel.bulldozingForceN > 10, 'lateral slip generates bulldozing force');
  assert.equal(looseRoll.bulldozingForceN, 0, 'zero lateral slip has zero bulldozing');

  // Record a compacted front-wheel track and age it past minAgeSec
  tm.recordTrackSegment(0, 0, 10, 0, 0.22, 0.11, 0.92);
  tm.tickAging(0.25, 0.2);

  const insideTrack = tm.evaluateWheelContact({
    worldX: 5,
    worldZ: 0.02,
    normalLoadN: 3400,
    tireWidth: 0.34,
    tireRadius: 0.44,
    slipRatio: 0.05,
    lateralSlipRad: 0.0,
    moisture: 0.1,
  });

  assert.ok(insideTrack.trackCompaction > 0.7, 'wheel must detect pre-existing compacted rut');
  assert.ok(insideTrack.sinkage < looseRoll.sinkage, 'compacted rut reduces incremental sinkage');
  assert.ok(insideTrack.tractionFactor > looseRoll.tractionFactor, 'compacted rut improves traction');

  // Foot IK stays strictly within 2 cm - 6 cm
  const footSlow = tm.evaluateFootContact({
    worldX: 20, worldZ: 20, impactSpeed: 0.4, bodyMassKg: 75, moisture: 0.1,
  });
  const footSprint = tm.evaluateFootContact({
    worldX: 20, worldZ: 20, impactSpeed: 4.2, bodyMassKg: 82, moisture: 0.1,
  });
  assert.ok(footSlow.sinkage >= 0.02 && footSlow.sinkage <= 0.06);
  assert.ok(footSprint.sinkage > footSlow.sinkage && footSprint.sinkage <= 0.06);
});

test('SleepController: enters auto-sleep after 3s idle and wakes immediately on brush input', () => {
  const sleep = new SleepController(3.0, 0.0008);
  sleep.wake(0.5);
  assert.equal(sleep.isSleeping(), false);

  // Advance with zero brushes until energy decays + 3s hysteresis expires
  for (let i = 0; i < 120; i++) {
    sleep.update({
      dt: 0.1,
      activeBrushCount: 0,
      cascadeMoved: false,
      injectedEnergy: 0,
      windSpeed: 0.2,
      autoSleepEnabled: true,
    });
  }
  assert.equal(sleep.isSleeping(), true, 'cascade must sleep after idle timeout');

  // Waking with a single brush immediately exits sleep
  const awake = sleep.update({
    dt: 0.016,
    activeBrushCount: 1,
    cascadeMoved: false,
    injectedEnergy: 0.3,
    windSpeed: 0.2,
    autoSleepEnabled: true,
  });
  assert.equal(awake.sleeping, false, 'active brush must wake cascade immediately');
});

test('TerrainHeightfield: smooth finite height and unit normal', () => {
  const h = sampleBaseTerrainHeight(12.5, -8.3);
  assert.ok(Number.isFinite(h));
  const sample = sampleBaseTerrain(12.5, -8.3);
  const nLen = Math.hypot(sample.normalX, sample.normalY, sample.normalZ);
  assert.ok(Math.abs(nLen - 1.0) < 1e-5, 'terrain normal must be unit length');
  assert.ok(sample.normalY > 0.7, 'desert dunes should face predominantly upward');
});

test('VehicleDriveModel: speed-sensitive steering, brake-to-reverse, boost & gearbox', () => {
  const lowSteer = computeSpeedSensitiveMaxSteerRad(3.0);
  const highSteer = computeSpeedSensitiveMaxSteerRad(40.0);
  assert.ok(lowSteer > 0.55 && highSteer < 0.28 && lowSteer > highSteer, 'steering must tighten at high speed');

  // Pressing S while rolling forward engages brakes (not reverse) and lights brake lamps
  const braking = evaluateVehicleDriveStep({
    control: { throttle: -1, steer: 0, handbrake: false, boost: false },
    vForwardMs: 14.0,
    isSprintPreset: false,
  });
  assert.ok(braking.serviceBrakeN > 15000, 'forward motion + S must apply service brakes');
  assert.equal(braking.engineForceN, 0);
  assert.equal(braking.brakeLightsOn, true);
  assert.equal(braking.reverseLightsOn, false);

  // Pressing S when nearly stopped engages reverse gear and white reverse lamps
  const reversing = evaluateVehicleDriveStep({
    control: { throttle: -1, steer: 0, handbrake: false, boost: false },
    vForwardMs: -0.5,
    isSprintPreset: false,
  });
  assert.ok(reversing.engineForceN < -10000, 'stopped + S must apply reverse drive torque');
  assert.equal(reversing.reverseLightsOn, true);
  assert.equal(reversing.gear, 'R');

  // Turbo boost increases forward torque and top speed
  const normalAccel = evaluateVehicleDriveStep({
    control: { throttle: 1, steer: 0, handbrake: false, boost: false },
    vForwardMs: 15.0,
    isSprintPreset: false,
  });
  const boostAccel = evaluateVehicleDriveStep({
    control: { throttle: 1, steer: 0, handbrake: false, boost: true },
    vForwardMs: 15.0,
    isSprintPreset: false,
  });
  assert.ok(boostAccel.engineForceN > normalAccel.engineForceN * 1.25, 'boost must increase torque');
  assert.ok(boostAccel.maxForwardSpeedMs > normalAccel.maxForwardSpeedMs, 'boost must raise top speed');
  assert.equal(boostAccel.boostActive, true);
  assert.ok(Number(boostAccel.gear) >= 2 && boostAccel.rpm >= 2000);

  // Merging keyboard + virtual inputs clamps cleanly
  const merged = mergeVehicleInputs(
    { throttle: 1, steer: 0, handbrake: false, boost: false },
    { throttle: 1, steer: -1, handbrake: true, boost: true },
  );
  assert.equal(merged.throttle, 1);
  assert.equal(merged.steer, -1);
  assert.equal(merged.handbrake, true);
  assert.equal(merged.boost, true);
});

test('VehicleDriveModel: multi-touch virtual flags & portrait mobile camera framing', () => {
  // Multi-touch: holding accelerate + boost + left steer, then releasing boost preserves accelerate & steer
  const full = resolveVirtualControls({
    ...EMPTY_VIRTUAL_FLAGS,
    left: true,
    accelerate: true,
    boost: true,
  });
  assert.equal(full.throttle, 1);
  assert.equal(full.steer, 1);
  assert.equal(full.boost, true);

  const afterBoostRelease = resolveVirtualControls({
    ...EMPTY_VIRTUAL_FLAGS,
    left: true,
    accelerate: true,
    boost: false,
  });
  assert.equal(afterBoostRelease.throttle, 1, 'releasing boost must not kill held gas pedal');
  assert.equal(afterBoostRelease.steer, 1, 'left steering thumb must stay intact');
  assert.equal(afterBoostRelease.boost, false);

  // Analog thumb slide overrides digital buttons cleanly
  const analog = resolveVirtualControls({
    ...EMPTY_VIRTUAL_FLAGS,
    analogSteer: -0.65,
    accelerate: true,
  });
  assert.ok(Math.abs(analog.steer - -0.65) < 1e-6);

  // Portrait phone framing widens FOV and pulls chase camera back vs desktop widescreen
  const desktopAdj = computePortraitCameraAdjust(1440 / 900);
  const phoneAdj = computePortraitCameraAdjust(390 / 844);
  assert.equal(desktopAdj.fovBonusDeg, 0);
  assert.ok(phoneAdj.fovBonusDeg >= 12, 'portrait phone should widen vertical FOV');
  assert.ok(phoneAdj.extraBackDist >= 1.8, 'portrait phone should pull chase camera back');
});

test('SmokePhysics: procedural Perlin-Worley volumetric atlas has full dynamic range & centered gradients', () => {
  const size = 64;
  const rgba = generateVolumetricSmokeAtlas(size);
  assert.equal(rgba.length, size * size * 4);

  let minR = 255;
  let maxR = 0;
  let sumGx = 0;
  let sumGy = 0;
  let sumCurlMag = 0;
  for (let i = 0; i < size * size; i++) {
    const r = rgba[i * 4 + 0];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    const gx = g - 128;
    const gy = b - 128;
    sumGx += gx;
    sumGy += gy;
    sumCurlMag += Math.hypot(gx, gy);
  }
  assert.ok(minR <= 5 && maxR >= 250, `atlas density should span full range, got [${minR}, ${maxR}]`);
  // Periodic curl field must be zero-mean (divergence-free balanced around 128) and carry active swirl energy
  const meanGx = Math.abs(sumGx / (size * size));
  const meanGy = Math.abs(sumGy / (size * size));
  const meanCurlMag = sumCurlMag / (size * size);
  assert.ok(meanGx < 2.0 && meanGy < 2.0, `curl field should be balanced around 128, got ${meanGx}, ${meanGy}`);
  assert.ok(meanCurlMag > 1.0, `curl field must carry swirl energy for advection, got ${meanCurlMag}`);
});

test('SmokePhysics: wheel dust, tire drift smoke & twin-exhaust scale physically with load & moisture', () => {
  const dryDrift = computeWheelSmokeEmission({
    speedMs: 18,
    wheelSlip: 0.85,
    lateralSpeedMs: 6.5,
    moisture: 0.08,
    boostActive: true,
    handbrake: false,
    isRear: true,
  });
  const wetCruise = computeWheelSmokeEmission({
    speedMs: 8,
    wheelSlip: 0.12,
    lateralSpeedMs: 0.2,
    moisture: 0.85,
    boostActive: false,
    handbrake: false,
    isRear: false,
  });

  assert.ok(dryDrift.dustIntensity > 0.75, 'high-speed dry drift must emit dense desert dust');
  assert.ok(dryDrift.driftSmokeIntensity > 0.75, 'high slip + boost must trigger thick drift smoke');
  assert.ok(wetCruise.dustIntensity < dryDrift.dustIntensity * 0.3, 'wet sand must suppress loose desert dust');
  assert.equal(wetCruise.driftSmokeIntensity, 0, 'gentle cruise should not produce burnout smoke');

  const idleEx = computeExhaustSmokeEmission({
    throttle: 0,
    rpm: 920,
    boostActive: false,
    speedMs: 0,
  });
  const boostEx = computeExhaustSmokeEmission({
    throttle: 1,
    rpm: 6100,
    boostActive: true,
    speedMs: 28,
  });
  assert.ok(boostEx.rateHz > idleEx.rateHz * 3.0, 'turbo boost must surge exhaust emission rate');
  assert.ok(boostEx.opacity > idleEx.opacity && boostEx.ejectSpeedMs > idleEx.ejectSpeedMs * 2.0);
});

test('MudGrass biome: deterministic mud clearing vs grass shoulders, deeper mud sinkage, and damp mist emission', () => {
  // Central proving ground clearing (-4, -3) must be open sloppy mud (< 0.25)
  const centerGrass = sampleMudGrassZoneMask(-4.0, -3.0);
  assert.ok(centerGrass < 0.25, `expected open mud clearing at center, got ${centerGrass}`);

  // Flanking meadow bank away from trails should transition into grass (> 0.65)
  const bankGrass = sampleMudGrassZoneMask(14.0, 14.0);
  assert.ok(bankGrass > 0.65, `expected grassy meadow bank off-trail, got ${bankGrass}`);

  const hollow = sampleMudHollowFactor(-4.0, -3.0);
  assert.ok(hollow >= 0 && hollow <= 1);

  // Sloppy mud yields significantly deeper wheel & Foot IK sinkage and higher rolling drag than dry sand
  const tm = new SandTerramechanics(32);
  const sandWheel = tm.evaluateWheelContact({
    worldX: 2,
    worldZ: 2,
    normalLoadN: 3400,
    tireWidth: 0.34,
    tireRadius: 0.44,
    slipRatio: 0.2,
    lateralSlipRad: 0.1,
    moisture: 0.2,
    biome: 'desert',
  });
  const mudWheel = tm.evaluateWheelContact({
    worldX: 2,
    worldZ: 2,
    normalLoadN: 3400,
    tireWidth: 0.34,
    tireRadius: 0.44,
    slipRatio: 0.2,
    lateralSlipRad: 0.1,
    moisture: 0.85,
    biome: 'mud_grass',
  });
  assert.ok(mudWheel.sinkage > sandWheel.sinkage * 1.4, 'sloppy mud must sink deeper than dry sand');

  const sandFoot = tm.evaluateFootContact({
    worldX: 12, worldZ: 12, impactSpeed: 2.4, bodyMassKg: 78, moisture: 0.2, biome: 'desert',
  });
  const mudFoot = tm.evaluateFootContact({
    worldX: 12, worldZ: 12, impactSpeed: 2.4, bodyMassKg: 78, moisture: 0.85, biome: 'mud_grass',
  });
  assert.ok(mudFoot.sinkage > sandFoot.sinkage * 1.25, 'Foot IK must sink deeper in wet sloppy mud');
  assert.ok(mudFoot.sinkage <= SAND_DEFAULTS.MUD_FOOT_MAX_SINKAGE + 1e-6);

  // Wet mud suppresses thick dry dust & burnout tire smoke while keeping heavy mud clod roost
  const mudDrift = computeWheelSmokeEmission({
    speedMs: 18,
    wheelSlip: 0.85,
    lateralSpeedMs: 6.5,
    moisture: 0.88,
    boostActive: false,
    handbrake: true,
    isRear: true,
    biome: 'mud_grass',
  });
  assert.ok(mudDrift.dustIntensity < 0.35, 'wet mud should emit subtle mist instead of thick dry dust');
  assert.ok(mudDrift.roostIntensity > 0.75, 'wet mud should throw heavy mud clods');
});

test('MudTextureGenerator: produces full dynamic range RGBA loam/height/slick/grit texture', () => {
  const size = 128;
  const rgba = generateMudDetailTexture(size);
  assert.equal(rgba.length, size * size * 4);

  let minG = 255;
  let maxG = 0;
  let minR = 255;
  let maxR = 0;
  for (let i = 0; i < size * size; i++) {
    const r = rgba[i * 4 + 0];
    const g = rgba[i * 4 + 1];
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
  }
  assert.ok(minG <= 4 && maxG >= 251, `mud heightfield should span [0..255], got [${minG}, ${maxG}]`);
  assert.ok(maxR - minR >= 60, `mud loam albedo should have realistic contrast, got [${minR}, ${maxR}]`);
});

test('ToroidalCascade: driving >16m away and returning promotes Cascade 0 from Cascade 1 without erasing tracks', () => {
  const c0 = new ToroidalCascade(SAND_DEFAULTS.CASCADE0_SIZE, 1024);
  const c1 = new ToroidalCascade(SAND_DEFAULTS.CASCADE1_SIZE, 1024);

  c1.updateFocus(0, 0);
  c0.updateFocus(0, 0);
  c1.updateFocus(0, 0);
  c0.updateFocus(0, 0);

  // Drive +24m away (beyond Cascade 0's 16m half-extent so (0, 0) exits Cascade 0)
  for (let x = 2; x <= 24; x += 2) {
    c1.updateFocus(x, 0);
    c0.updateFocus(x, 0);
  }
  const [u1Away, v1Away] = c1.worldToToroidalUV(0, 0);
  assert.equal(c1.shouldClearTexel(u1Away, v1Away), false, 'Cascade 1 must preserve tracks at (0,0) when 24m away');
  assert.equal(c1.computeCascadeWeight(0, 0), 1.0, 'Cascade 1 weight at (0,0) must stay 1.0');

  // Drive back toward (0, 0): as (0, 0) re-enters Cascade 0, Cascade 0 promotes from Cascade 1
  let reentered = false;
  for (let x = 22; x >= 6; x -= 2) {
    c1.updateFocus(x, 0);
    c0.updateFocus(x, 0);
    const w0 = c0.getCurrentWindow();
    if (0 >= w0.minX + c0.guardWorldWidth && 0 < w0.maxX - c0.guardWorldWidth) {
      const [u0, v0] = c0.worldToToroidalUV(0, 0);
      if (c0.shouldClearTexel(u0, v0)) {
        reentered = true;
        assert.equal(c1.computeCascadeWeight(0, 0), 1.0);
        const [u1, v1] = c1.worldToToroidalUV(0, 0);
        assert.equal(c1.shouldClearTexel(u1, v1), false);
      }
    }
  }
  assert.equal(reentered, true, 'origin (0,0) should re-enter Cascade 0 on return drive');

  // On a 500m teleport, Cascade 1 runs FIRST and clears, so Cascade 0 promotes 0.0
  const tp1 = c1.updateFocus(506, 0);
  const tp0 = c0.updateFocus(506, 0);
  assert.equal(tp1.teleported, true);
  assert.equal(tp0.teleported, true);
});

test('Clipmap vertex displacement fade is watertight across Ring 0/1 and Ring 1/2 seams', () => {
  const smoothstep = (e0: number, e1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const evalVertexDispFade = (dx: number, dz: number) => {
    const chebyshev = Math.max(Math.abs(dx), Math.abs(dz));
    return 1.0 - smoothstep(2.45, 3.80, chebyshev);
  };

  assert.equal(evalVertexDispFade(1.936, 0.5), 1.0, 'Ring 0/1 boundary must be exact 1.0 on both sides');
  assert.equal(evalVertexDispFade(1.936, 1.936), 1.0, 'Ring 0/1 corner must be exact 1.0 on both sides');
  assert.equal(evalVertexDispFade(3.872, 0.0), 0.0, 'Ring 1/2 boundary must be exact 0.0 on both sides');
  assert.equal(evalVertexDispFade(3.872, 3.872), 0.0, 'Ring 1/2 corner must be exact 0.0 on both sides');

  const mid = evalVertexDispFade(3.125, 0.0);
  assert.ok(mid > 0.4 && mid < 0.6, `expected smooth mid-Ring-1 taper, got ${mid}`);
});

test('computeTireContactLead: matches circular tire sand-entry chord without protruding ahead of tire', () => {
  const R = 0.48;
  const brushHalfWidth = 0.35 * 0.62;
  const capRadius = brushHalfWidth * 1.22;

  const leadShallow = computeTireContactLead(R, 0.06, brushHalfWidth);
  const leadSand = computeTireContactLead(R, 0.16, brushHalfWidth);
  const leadDeep = computeTireContactLead(R, 0.24, brushHalfWidth);

  assert.ok(leadShallow < leadSand && leadSand <= leadDeep, 'contact lead must grow monotonically with sinkage');

  // At typical sand sinkage (16 cm), 50%-depth wall (lead + 0.5*capRadius) must align with sqrt(2Rz - z^2)
  const expectedChord = Math.sqrt(2 * R * 0.16 - 0.16 * 0.16);
  const wallPos = leadSand + capRadius * 0.5;
  assert.ok(
    Math.abs(wallPos - expectedChord) < 0.03,
    `expected rut entry wall near ${expectedChord.toFixed(3)}m, got ${wallPos.toFixed(3)}m`,
  );

  // Outer capsule rim (lead + capRadius) must never project far past the front tire silhouette (R * 1.10)
  assert.ok(leadDeep + capRadius <= R * 1.10 + 1e-6, 'outer capsule edge must stay bounded near front tire lugs');
  assert.ok(computeTireContactLead(R, 0, brushHalfWidth) >= 0.04, 'zero sinkage stays safely positive');
});

test('Tire air pressure (PSI): airing down widens contact patch, lowers Bekker sinkage & drag', () => {
  const lowPsi = computeTireFootprintScale(12);
  const highPsi = computeTireFootprintScale(34);

  assert.ok(lowPsi.widthScale > highPsi.widthScale * 1.15, '12 PSI must flatten & widen tire footprint');
  assert.ok(lowPsi.lengthScale > highPsi.lengthScale * 1.25, '12 PSI must lengthen contact patch');
  assert.ok(lowPsi.tractionBonus > highPsi.tractionBonus, 'aired-down tire must increase soft-sand grip');

  const tm = new SandTerramechanics(32);
  const wheel12 = tm.evaluateWheelContact({
    worldX: 8,
    worldZ: 8,
    normalLoadN: 8400,
    tireWidth: 0.35,
    tireRadius: 0.48,
    slipRatio: 0.12,
    lateralSlipRad: 0.05,
    moisture: 0.15,
    tirePressurePsi: 12,
  });
  const wheel34 = tm.evaluateWheelContact({
    worldX: 8,
    worldZ: 8,
    normalLoadN: 8400,
    tireWidth: 0.35,
    tireRadius: 0.48,
    slipRatio: 0.12,
    lateralSlipRad: 0.05,
    moisture: 0.15,
    tirePressurePsi: 34,
  });

  assert.ok(wheel12.sinkage < wheel34.sinkage * 0.86, 'airing down must float higher in loose sand');
  assert.ok(wheel12.rollingResistanceN < wheel34.rollingResistanceN * 0.85, 'airing down must cut rolling drag');
  assert.ok(wheel12.tractionFactor > wheel34.tractionFactor, 'airing down must boost sand traction');
});

test('VehicleDriveModel 4L transfer case: +48% low-range torque, L-gears, crawl cap, and Turbo preserved', () => {
  const high4H = evaluateVehicleDriveStep({
    control: { throttle: 1, steer: 0, handbrake: false, boost: false },
    vForwardMs: 2.0,
    isSprintPreset: false,
    driveMode: '4H',
  });
  const low4L = evaluateVehicleDriveStep({
    control: { throttle: 1, steer: 0, handbrake: false, boost: false },
    vForwardMs: 2.0,
    isSprintPreset: false,
    driveMode: '4L',
  });
  const low4LTurbo = evaluateVehicleDriveStep({
    control: { throttle: 1, steer: 0, handbrake: false, boost: true },
    vForwardMs: 2.0,
    isSprintPreset: false,
    driveMode: '4L',
  });
  const low4LRev = evaluateVehicleDriveStep({
    control: { throttle: -1, steer: 0, handbrake: false, boost: false },
    vForwardMs: -0.4,
    isSprintPreset: false,
    driveMode: '4L',
  });

  assert.ok(low4L.engineForceN > high4H.engineForceN * 1.4, '4L must multiply low-end crawling torque');
  assert.ok(low4L.maxForwardSpeedMs < high4H.maxForwardSpeedMs, '4L must cap top speed for controlled crawling');
  assert.ok(low4L.gear.startsWith('L'), `4L forward gear should start with L, got ${low4L.gear}`);
  assert.equal(low4LRev.gear, 'LR', '4L reverse gear must report LR');
  assert.ok(low4LTurbo.engineForceN > low4L.engineForceN * 1.3, 'Turbo boost must remain active in 4L');
});

test('DesertObstacles: deterministic proving-ground rocks keep spawn/sprint clear & resolve soft bumper collisions', () => {
  const rocks = generateDesertRockObstacles();
  assert.ok(rocks.length >= 20, 'should generate populated proving-ground landmarks');

  for (const rock of rocks) {
    const distFromOrigin = Math.hypot(rock.x, rock.z);
    assert.ok(distFromOrigin >= 17.5, `rock at (${rock.x}, ${rock.z}) must stay clear of central spawn`);
    if (rock.z > -26 && rock.z < 16) {
      assert.ok(
        Math.abs(rock.x - 1.5) >= 5.5,
        `rock at (${rock.x}, ${rock.z}) must keep Sprint launch corridor open`,
      );
    }
  }

  // Test collision resolution against a single rock at (10, 0) radius 2.0m with vehicle radius 1.25m
  const testRock = [
    { x: 10, z: 0, radius: 2.0, scaleXZ: 2.2, scaleY: 1.4, yaw: 0, colorIndex: 0 },
  ];
  // Vehicle penetrates 0.5m into left side while moving diagonally (+4 in X, +3 in Z)
  const hit = resolveRockCollisions(7.25, 0, 4.0, 3.0, 1.25, testRock);
  assert.equal(hit.collided, true);
  assert.ok(hit.x <= 6.75 + 1e-5, `vehicle should be pushed cleanly outside contact radius, got x=${hit.x}`);
  assert.ok(hit.vx <= 0, `inward velocity should bounce/cancel, got vx=${hit.vx}`);
  assert.ok(hit.vz > 1.5, `tangential scraping velocity should be preserved, got vz=${hit.vz}`);
  assert.ok(hit.impactSpeed >= 3.9, 'impactSpeed should record normal impact speed');
});

test('Climbable sandstone rock course & uneven sand moguls: flush height, entry clearance & asymmetric relief', () => {
  assert.ok(CLIMBABLE_ROCK_SLABS.length >= 10, 'should provide climbable rock slabs for articulation course');

  // Trail entrance (14.0, 11.4) and origin spawn (0, 0) must be clear flat sand (onRock === 0)
  const originSample = sampleClimbableRockSurface(0, 0, 0);
  const entrySample = sampleClimbableRockSurface(14.0, 11.4, 0);
  assert.equal(originSample.onRock, 0, 'origin spawn must stay off climbable rocks');
  assert.equal(entrySample.onRock, 0, 'rock trail entrance must start on flat sand');

  // Center of staggered crawl boulder & upper stepped sandstone shelf must elevate cleanly
  const firstSlab = CLIMBABLE_ROCK_SLABS[0];
  const firstCenter = sampleClimbableRockSurface(firstSlab.x, firstSlab.z, 1.0);
  assert.ok(firstCenter.rockElevation >= 0.25, `expected >= 0.25m rock elevation, got ${firstCenter.rockElevation}`);
  assert.equal(firstCenter.onRock, 1, 'slab center must report full onRock=1');
  assert.ok(firstCenter.height > 1.25, 'height must equal baseTerrainY + rockElevation');

  const upperShelf = CLIMBABLE_ROCK_SLABS.find((s) => s.id === 'shelf_upper');
  assert.ok(upperShelf, 'expected stepped upper sandstone shelf');
  const shelfCenter = sampleClimbableRockSurface(upperShelf.x, upperShelf.z, 0);
  assert.ok(shelfCenter.rockElevation >= 0.55, 'upper sandstone shelf should reach >= 0.55m');

  // Perimeter blocker rocks must stay completely clear of the climbable rock trail corridor
  const blockers = generateDesertRockObstacles();
  for (const b of blockers) {
    const insideTrail = b.x > 6.5 && b.x < 22.5 && b.z > 6.0 && b.z < 58.0;
    assert.equal(insideTrail, false, `blocker rock at (${b.x}, ${b.z}) must not block rock-crawling trail`);
  }

  // Uneven sand moguls: smooth near origin, pronounced asymmetric cross-axle undulations at (14, 46.5)
  assert.ok(Math.abs(sampleUnevenSandOffset(0, 0)) < 0.02, 'origin spawn sand must remain smooth');
  let minMogul = Infinity;
  let maxMogul = -Infinity;
  for (let gx = 10; gx <= 18; gx += 0.8) {
    for (let gz = 40; gz <= 53; gz += 0.8) {
      const m = sampleUnevenSandOffset(gx, gz);
      if (m < minMogul) minMogul = m;
      if (m > maxMogul) maxMogul = m;
    }
  }
  const mogulSpan = maxMogul - minMogul;
  assert.ok(mogulSpan >= 0.45, `uneven sand mogul zone should span >= 0.45m peak-to-trough, got ${mogulSpan.toFixed(3)}m`);
});

test('GoPro rear-wheel camera: wide-angle framing outside rear tire, trailing rut target & C-key cycle', () => {
  assert.ok(CAMERA_CYCLE_ORDER.includes('gopro_rear'), 'gopro_rear must be included in camera cycle order');
  assert.equal(getNextCameraMode('fender'), 'gopro_rear', 'C cycle should step from fender into gopro_rear');
  assert.equal(getNextCameraMode('gopro_rear'), 'orbit', 'C cycle should step cleanly out of gopro_rear');

  const cruise = computeGoProRearCamLocalPose({
    timeSec: 1.2,
    speedMs: 6.0,
    wheelSlip: 0.25,
    boostActive: false,
    wheelTravelY: 0,
    aspect: 16 / 9,
  });

  // Camera sits outside rear-left tire outer sidewall (~1.20m) and ahead of rear axle (-1.59m)
  assert.ok(cruise.posX > 1.55 && cruise.posX < 1.90, `expected lateral mount outside tire, got x=${cruise.posX}`);
  assert.ok(cruise.posZ > -0.75 && cruise.posZ < 0.0, `expected forward rocker mount, got z=${cruise.posZ}`);
  assert.ok(cruise.targetZ < -1.8, 'must look across rear tire into freshly deformed sand trench behind axle');
  assert.ok(cruise.targetY < cruise.posY, 'must angle downward toward tire-to-sand contact patch');
  assert.ok(cruise.fovDeg >= 74 && cruise.fovDeg <= 82, `expected wide GoPro FOV, got ${cruise.fovDeg}`);

  const boostPortrait = computeGoProRearCamLocalPose({
    timeSec: 2.5,
    speedMs: 18.0,
    wheelSlip: 0.9,
    boostActive: true,
    wheelTravelY: 0.22,
    aspect: 390 / 844,
  });
  assert.ok(boostPortrait.fovDeg > cruise.fovDeg + 8, 'portrait + boost must widen GoPro FOV');
  assert.ok(boostPortrait.targetY > cruise.targetY + 0.05, 'target should subtly track rear-wheel upward travel');
});

test('VehicleCrashPhysics: gentle donuts stay upright while sharp high-speed corner triggers full 6-DOF rollover & roof impacts', () => {
  // 1. Moderate donuts drift (~10.5 m/s, steer ~0.35 rad) must lean naturally without flipping upside-down
  const gentleState = createInitialRolloverState();
  const gentleImpacts: CrashImpactEvent[] = [];
  for (let i = 0; i < 120; i++) {
    stepRolloverDynamics(
      gentleState,
      {
        dt: 1 / 60,
        vForwardMs: 10.5,
        vLateralMs: 1.8,
        yawRateRadS: 1.25,
        steerAngleRad: 0.35,
        terrainRollSlopeRad: 0,
        terrainPitchSlopeRad: 0,
        tirePressurePsi: 22,
        avgOnRock: 0,
        trackHalf: 1.02,
        cgHeight: 0.94,
        isHandbrake: false,
      },
      0,
      () => ({ height: 0, onRock: 0 }),
      (ev) => gentleImpacts.push(ev),
      { x: 0, y: 0, z: 0, sinH: 0, cosH: 1 },
    );
  }
  assert.equal(gentleState.isRolledOver, false, 'moderate drift should stay upright');
  assert.ok(Math.abs(gentleState.rollRad) > 0.06 && Math.abs(gentleState.rollRad) < 0.35, 'should exhibit visible suspension body roll');

  // 2. Violent high-speed sharp snap-turn (~21 m/s, full steer) must lift wheels & tumble into barrel roll
  const crashState = createInitialRolloverState();
  const crashImpacts: CrashImpactEvent[] = [];
  let sawTipping = false;
  for (let i = 0; i < 180; i++) {
    stepRolloverDynamics(
      crashState,
      {
        dt: 1 / 60,
        vForwardMs: crashState.isRolledOver ? 9.0 : 21.0,
        vLateralMs: 4.5,
        yawRateRadS: crashState.isRolledOver ? 0.1 : -2.15,
        steerAngleRad: -0.44,
        terrainRollSlopeRad: 0,
        terrainPitchSlopeRad: 0,
        tirePressurePsi: 26,
        avgOnRock: 0,
        trackHalf: 1.02,
        cgHeight: 0.94,
        isHandbrake: true,
      },
      0,
      () => ({ height: 0, onRock: 0 }),
      (ev) => crashImpacts.push(ev),
      { x: 0, y: 0, z: 0, sinH: 0, cosH: 1 },
    );
    if (crashState.isTipping) sawTipping = true;
  }

  assert.equal(sawTipping, true, 'sharp turn must pass through 2-wheel tipping phase');
  assert.equal(crashState.isRolledOver, true, 'violent high-speed turn must roll past 62 deg');
  assert.ok(crashState.rollCount >= 1, 'should increment rollover flip counter');
  assert.ok(crashImpacts.length >= 1, 'rollover ground strike must emit body CrashImpactEvent');
});

test('VehicleCrashPhysics: heavy impacts crack glass, smash lights, pop hood, bend wheel camber & detach parts', () => {
  const dmg = createInitialDamageState();
  assert.equal(classifyImpactZone(0.6, 0.9, 2.3), 'front');
  assert.equal(classifyImpactZone(0.0, 2.05, 0.1), 'roof');
  assert.equal(classifyImpactZone(0.95, 0.9, 0.0), 'left');

  // Repeated high-speed front boulder strikes
  for (let hit = 0; hit < 2; hit++) {
    applyImpactToDamageState(dmg, {
      zone: 'front',
      localPointX: 0.55,
      localPointY: 0.96,
      localPointZ: 2.42,
      localNormalX: 0,
      localNormalY: 0,
      localNormalZ: -1,
      worldPointX: 0,
      worldPointY: 1,
      worldPointZ: 2,
      impulseSpeedMs: 14.5,
      severity: 0.85,
      onRock: true,
      wheelIndex: 0,
    });
  }

  assert.equal(dmg.headlightBroken[0], true, 'front-left impact should shatter left headlamp');
  assert.ok(dmg.hoodPoppedAngleRad > 0.1, 'front crash should pop hood latch open');
  assert.equal(dmg.detached.frontBumper, true, 'heavy front impact should rip off ARB front bumper');
  assert.ok(dmg.wheels[0].damage01 > 0.5 && Math.abs(dmg.wheels[0].camberRad) > 0.1, 'corner impact bends wheel camber');
  assert.ok(dmg.overallIntegrityPct < 90, 'overall integrity must reflect heavy damage');

  // Roof slam shatters windshield completely & rips lightbar
  for (let hit = 0; hit < 2; hit++) {
    applyImpactToDamageState(dmg, {
      zone: 'roof',
      localPointX: -0.2,
      localPointY: 2.12,
      localPointZ: 0.25,
      localNormalX: 0,
      localNormalY: -1,
      localNormalZ: 0,
      worldPointX: 0,
      worldPointY: 0.5,
      worldPointZ: 0,
      impulseSpeedMs: 11.5,
      severity: 0.72,
      onRock: false,
      wheelIndex: -1,
    });
  }
  assert.equal(dmg.windshieldCrackLevel, 2, 'roof rollover must shatter front windshield');
  assert.equal(dmg.rearGlassBroken, true, 'roof damage must crack rear cab glass');
  assert.equal(dmg.detached.lightBar, true, 'roof rollover must detach LED roof lightbar');
});

test('VehicleCrashPhysics: deformSubmeshVertices crushes vertices inward cleanly, scrapes paint & respects roll-cage clamp', () => {
  // 2-vertex fixture: one center vertex inside dent radius on front hood, one far vertex untouched
  const restPos = new Float32Array([
    0.0, 1.30, 2.10, // v0 right at impact
    0.0, 1.30, -1.50, // v1 far away
  ]);
  const pos = new Float32Array(restPos);
  const restCols = new Float32Array([1, 1, 1, 1, 1, 1]);
  const cols = new Float32Array(restCols);

  const res = deformSubmeshVertices({
    positions: pos,
    restPositions: restPos,
    colors: cols,
    restColors: restCols,
    impactLocalX: 0.0,
    impactLocalY: 1.30,
    impactLocalZ: 2.10,
    crushDirX: 0,
    crushDirY: -0.5,
    crushDirZ: -0.86,
    radius: 0.85,
    maxCrushDepth: 0.35,
    innerCoreClamp: { minX: -0.65, maxX: 0.65, minY: 0.65, maxY: 1.24, minZ: 1.05, maxZ: 2.02 },
  });

  assert.equal(res.modifiedVertices, 1, 'only vertices inside dent radius should deform');
  assert.ok(pos[2] < 2.05, 'hood vertex must crumple rearward');
  assert.ok(pos[1] >= 1.24 || pos[2] >= 2.02, 'deformed skin must respect inner engine/cage core bounds');
  assert.ok(cols[0] < 0.95 && cols[1] < 0.95, 'deformed zone must blend bare-metal scrape color');
  assert.equal(pos[5], -1.50, 'distant vertex must stay completely untouched');
  assert.equal(cols[3], 1, 'distant vertex color must stay pristine');
});

test('DesertObstacles: resolveRockCollisions emits unit outward impact normal & 3D hit point', () => {
  const testRock = [
    { x: 10, z: 0, radius: 2.0, scaleXZ: 2.2, scaleY: 1.4, yaw: 0, colorIndex: 0 },
  ];
  const hit = resolveRockCollisions(7.25, 0, 8.0, 0.0, 1.25, testRock);
  assert.equal(hit.collided, true);
  assert.ok(Math.abs(Math.hypot(hit.normalX, hit.normalZ) - 1.0) < 1e-5, 'collision normal must be unit length');
  assert.ok(hit.normalX < -0.95, 'hitting left side of rock should push outward toward -X');
  assert.ok(hit.hitX > 7.0 && hit.hitX < 9.0, 'hitX should lie along rock perimeter');
});

const TEST_CORNERS: readonly [
  SuspensionWheelCorner,
  SuspensionWheelCorner,
  SuspensionWheelCorner,
  SuspensionWheelCorner,
] = [
  { lx: 1.02, lz: 1.59, isFront: true, isLeft: true },
  { lx: -1.02, lz: 1.59, isFront: true, isLeft: false },
  { lx: 1.02, lz: -1.59, isFront: false, isLeft: true },
  { lx: -1.02, lz: -1.59, isFront: false, isLeft: false },
];

test('VehicleSuspensionPhysics: absorbs single-wheel rock bump independently and squats/dives under accel/braking', () => {
  const susp = createInitialSuspensionState(0, 0.94, 0.48);

  // 1. Hit front-left wheel onto a +0.20m sandstone step while other 3 tires stay on sand (0.0m)
  let peakFLTravel = -1;
  let peakFLDeltaVsFR = -1;
  for (let i = 0; i < 30; i++) {
    stepSuspensionDynamics(susp, {
      dt: 1 / 60,
      sprungMassKg: 3230,
      unsprungMassKg: 55,
      tireRadiusM: 0.48,
      comHeightRestM: 0.94,
      corners: TEST_CORNERS,
      groundSurfY: [0.20, 0, 0, 0],
      onRock: [1, 0, 0, 0],
      tirePressurePsi: 20,
      longitudinalAccelMs2: 0,
      lateralAccelMs2: 0,
      rolloverOverrideActive: false,
      rolloverRollRad: 0,
      rolloverPitchRad: 0,
      rolloverAirY: 0,
      avgGroundY: 0.05,
    });
    peakFLTravel = Math.max(peakFLTravel, susp.travelM[0]);
    peakFLDeltaVsFR = Math.max(peakFLDeltaVsFR, susp.travelM[0] - susp.travelM[1]);
  }
  assert.ok(peakFLTravel > 0.10, `FL wheel must compress up into arch on rock impact (got ${peakFLTravel.toFixed(3)})`);
  assert.ok(peakFLDeltaVsFR > 0.09, 'FL must articulate independently higher than FR on flat sand');
  assert.ok(susp.tireSquash01[0] > 0.25, 'loaded rock tire must exhibit sidewall squash');

  // 2. Hard braking on flat ground -> nose dives (+chassisPitchRad > 0) and transfers weight onto front tires!
  const diveSusp = createInitialSuspensionState(0, 0.94, 0.48);
  for (let i = 0; i < 40; i++) {
    stepSuspensionDynamics(diveSusp, {
      dt: 1 / 60,
      sprungMassKg: 3230,
      unsprungMassKg: 55,
      tireRadiusM: 0.48,
      comHeightRestM: 0.94,
      corners: TEST_CORNERS,
      groundSurfY: [0, 0, 0, 0],
      onRock: [0, 0, 0, 0],
      tirePressurePsi: 22,
      longitudinalAccelMs2: -9.5,
      lateralAccelMs2: 0,
      rolloverOverrideActive: false,
      rolloverRollRad: 0,
      rolloverPitchRad: 0,
      rolloverAirY: 0,
      avgGroundY: 0,
    });
  }
  assert.ok(diveSusp.chassisPitchRad > 0.03, `hard braking must dive nose down (got ${diveSusp.chassisPitchRad.toFixed(4)})`);
  assert.ok(diveSusp.normalLoadN[0] > diveSusp.normalLoadN[2] + 1500, 'braking must shift normal load to front tires');
});

test('VehicleSuspensionPhysics: extends wheels to full droop in mid-air and absorbs hard landing cleanly', () => {
  const susp = createInitialSuspensionState(0, 0.94, 0.48);
  // Launch chassis 1.2m into the air!
  susp.chassisComWorldY = 2.15;
  susp.chassisComVy = 1.5;
  for (let i = 0; i < 4; i++) {
    susp.hubWorldY[i] = 1.69;
    susp.hubVelY[i] = 1.5;
  }

  // Step 0.45s airborne
  for (let i = 0; i < 27; i++) {
    stepSuspensionDynamics(susp, {
      dt: 1 / 60,
      sprungMassKg: 3230,
      unsprungMassKg: 55,
      tireRadiusM: 0.48,
      comHeightRestM: 0.94,
      corners: TEST_CORNERS,
      groundSurfY: [0, 0, 0, 0],
      onRock: [0, 0, 0, 0],
      tirePressurePsi: 22,
      longitudinalAccelMs2: 0,
      lateralAccelMs2: 0,
      rolloverOverrideActive: false,
      rolloverRollRad: 0,
      rolloverPitchRad: 0,
      rolloverAirY: 0,
      avgGroundY: 0,
    });
  }
  assert.ok(susp.travelM[0] < -0.18, `wheels must droop downward off jump (got ${susp.travelM[0].toFixed(3)})`);
  assert.equal(susp.groundContact01[0], 0, 'airborne wheel must have zero ground contact');

  // Step 1.5s more through impact landing & soft rebound settling
  let maxLandTravel = -1;
  for (let i = 0; i < 90; i++) {
    stepSuspensionDynamics(susp, {
      dt: 1 / 60,
      sprungMassKg: 3230,
      unsprungMassKg: 55,
      tireRadiusM: 0.48,
      comHeightRestM: 0.94,
      corners: TEST_CORNERS,
      groundSurfY: [0, 0, 0, 0],
      onRock: [0, 0, 0, 0],
      tirePressurePsi: 22,
      longitudinalAccelMs2: 0,
      lateralAccelMs2: 0,
      rolloverOverrideActive: false,
      rolloverRollRad: 0,
      rolloverPitchRad: 0,
      rolloverAirY: 0,
      avgGroundY: 0,
    });
    maxLandTravel = Math.max(maxLandTravel, susp.travelM[0]);
  }
  assert.ok(maxLandTravel > 0.12, `landing must compress coilovers deeply (got ${maxLandTravel.toFixed(3)})`);
  assert.ok(Number.isFinite(susp.chassisComWorldY) && susp.chassisComWorldY > 0.6, 'landing must settle cleanly above ground');
});

test('VehicleSuspensionPhysics: load-weighted brush tire cornering produces yaw & zero grip mid-air', () => {
  const groundedTurn = evaluateTireCorneringAndYaw({
    dt: 1 / 60,
    massKg: 3450,
    yawInertiaKgM2: 5200,
    vForwardMs: 14.0,
    vLateralMs: 0,
    yawRateRadS: 0,
    steerAngleRad: 0.32,
    corners: TEST_CORNERS,
    normalLoadN: [8500, 8500, 8500, 8500],
    groundContact01: [1, 1, 1, 1],
    wheelSlipRatio: [0.1, 0.1, 0.1, 0.1],
    onRock: [0, 0, 0, 0],
    moisture: 0.1,
    tirePressurePsi: 22,
    isHandbrake: false,
    isLowRange: false,
    isRolledOver: false,
    rolledWheelAuthority: 1,
  });
  assert.ok(groundedTurn.yawRateDeltaRadS > 0.02, 'left steer at speed must generate positive left yaw acceleration');
  assert.ok(groundedTurn.steeringDragForceN < 0, 'steered tires must create realistic induced turning drag');

  const airborneTurn = evaluateTireCorneringAndYaw({
    dt: 1 / 60,
    massKg: 3450,
    yawInertiaKgM2: 5200,
    vForwardMs: 14.0,
    vLateralMs: 0,
    yawRateRadS: 0,
    steerAngleRad: 0.32,
    corners: TEST_CORNERS,
    normalLoadN: [0, 0, 0, 0],
    groundContact01: [0, 0, 0, 0],
    wheelSlipRatio: [0, 0, 0, 0],
    onRock: [0, 0, 0, 0],
    moisture: 0.1,
    tirePressurePsi: 22,
    isHandbrake: false,
    isLowRange: false,
    isRolledOver: false,
    rolledWheelAuthority: 1,
  });
  assert.equal(airborneTurn.steeringDragForceN, 0, 'airborne wheels must create zero steering ground force');
  assert.ok(Math.abs(airborneTurn.yawRateDeltaRadS) < 1e-4, 'airborne wheels must not turn car mid-air');
});

test('Phase 0.1 — MudTextureGenerator: periodic wrap across U=0/1 and V=0/1 edges has zero visible seam', () => {
  const size = 128;
  const rgba = generateMudDetailTexture(size);

  let maxRowWrapDiff = 0;
  let maxColWrapDiff = 0;
  let maxInteriorDiff = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const gCur = rgba[idx + 1]; // micro-height channel (where tire-rut periodic noise lives)
      const gRight = rgba[(y * size + ((x + 1) % size)) * 4 + 1];
      const gDown = rgba[(((y + 1) % size) * size + x) * 4 + 1];
      const dx = Math.abs(gCur - gRight);
      const dy = Math.abs(gCur - gDown);
      if (x === size - 1) {
        if (dx > maxColWrapDiff) maxColWrapDiff = dx;
      } else if (dx > maxInteriorDiff) {
        maxInteriorDiff = dx;
      }
      if (y === size - 1) {
        if (dy > maxRowWrapDiff) maxRowWrapDiff = dy;
      } else if (dy > maxInteriorDiff) {
        maxInteriorDiff = dy;
      }
    }
  }

  assert.ok(
    maxColWrapDiff <= maxInteriorDiff * 1.35 + 4,
    `U-wrap seam detected: edge diff ${maxColWrapDiff} vs interior ${maxInteriorDiff}`,
  );
  assert.ok(
    maxRowWrapDiff <= maxInteriorDiff * 1.35 + 4,
    `V-wrap seam detected: edge diff ${maxRowWrapDiff} vs interior ${maxInteriorDiff}`,
  );
});

test('Phase 0.1 — DesertObstacles: smooth facetNoise envelope before r2=1.24 and rotated elongated slab AABB bound', () => {
  const slab = {
    id: 'test_elongated',
    x: 0,
    z: 0,
    halfX: 3.6,
    halfZ: 1.1,
    height: 0.72,
    yaw: Math.PI / 4,
    seed: 1.7,
    colorIndex: 0,
  };

  let maxNearBoundaryElev = 0;
  for (let a = 0; a < 64; a++) {
    const theta = (a / 64) * Math.PI * 2;
    const r = Math.sqrt(1.19);
    const lx = r * Math.cos(theta) * slab.halfX;
    const lz = r * Math.sin(theta) * slab.halfZ;
    const c = Math.cos(slab.yaw);
    const s = Math.sin(slab.yaw);
    const wx = lx * c - lz * s;
    const wz = lx * s + lz * c;
    const elev = evalSingleClimbableRockElevation(slab, wx, wz);
    if (elev > maxNearBoundaryElev) maxNearBoundaryElev = elev;
  }
  assert.ok(
    maxNearBoundaryElev < 0.005,
    `slab elevation near r2=1.19 must vanish smoothly, got ${maxNearBoundaryElev.toFixed(4)}m`,
  );

  const tipLx = 0.72 * slab.halfX;
  const tipLz = 0.42 * slab.halfZ;
  const c = Math.cos(slab.yaw);
  const s = Math.sin(slab.yaw);
  const tipX = tipLx * c - tipLz * s;
  const tipZ = tipLx * s + tipLz * c;
  const direct = evalSingleClimbableRockElevation(slab, tipX, tipZ);
  const sampled = sampleClimbableRockSurface(tipX, tipZ, 0, [slab]);
  assert.ok(direct > 0.05, `expected positive tip elevation, got ${direct}`);
  assert.ok(
    Math.abs(sampled.rockElevation - direct) < 1e-6,
    'sampleClimbableRockSurface AABB bound must not prematurely reject rotated slab corners',
  );
});

test('Phase 0.1 — VehicleCrashPhysics: dedicated scrapes mask preserves pristine paint vertex colors', () => {
  const restPos = new Float32Array([
    0.0, 1.30, 2.10,
    0.0, 1.30, -1.50,
  ]);
  const pos = new Float32Array(restPos);
  const restCols = new Float32Array([1, 1, 1, 1, 1, 1]);
  const cols = new Float32Array(restCols);
  const scrapes = new Float32Array([0, 0]);

  const res = deformSubmeshVertices({
    positions: pos,
    restPositions: restPos,
    colors: cols,
    restColors: restCols,
    scrapes,
    impactLocalX: 0.0,
    impactLocalY: 1.30,
    impactLocalZ: 2.10,
    crushDirX: 0,
    crushDirY: -0.5,
    crushDirZ: -0.86,
    radius: 0.85,
    maxCrushDepth: 0.35,
  });

  assert.equal(res.modifiedVertices, 1);
  assert.ok(scrapes[0] > 0.5, `impacted vertex must write metallic scrape mask, got ${scrapes[0]}`);
  assert.equal(scrapes[1], 0, 'distant vertex must keep scrape mask 0');
  assert.equal(cols[0], 1);
  assert.equal(cols[1], 1);
  assert.equal(cols[2], 1);
});

test('Phase 0.1 — SandParams: computeEffectivePixelRatio aligns mobile/desktop caps and software GL', () => {
  assert.equal(computeEffectivePixelRatio(1440, 2, true), 1);
  assert.equal(computeEffectivePixelRatio(390, 3, true), 1);
  assert.equal(computeEffectivePixelRatio(390, 3, false), 1.5);
  assert.equal(computeEffectivePixelRatio(767, 2.5, false), 1.5);
  assert.equal(computeEffectivePixelRatio(768, 2.5, false), 2.0);
  assert.equal(computeEffectivePixelRatio(1440, 1.25, false), 1.25);
});

test('Highway stability: brief steering tap at 65 km/h turns smoothly without flying sideways or tipping', () => {
  let vF = 18.0; // ~65 km/h
  let vL = 0;
  let yawRate = 0;
  let heading = 0;
  let steerSmoothed = 0;
  const rollover = createInitialRolloverState();
  const dt = 1 / 60;

  let maxAbsVLat = 0;
  let maxAbsRollDeg = 0;

  for (let frame = 0; frame < 90; frame++) {
    const steerInput = frame < 15 ? 1.0 : 0.0; // 0.25s brief tap of A then release
    const maxSteer = computeSpeedSensitiveMaxSteerRad(vF);
    const speedCalm = Math.min(1, vF / 22.0);
    const steerRate = Math.abs(steerInput) > 0.05 ? 5.0 - speedCalm * 2.4 : 7.6 + speedCalm * 1.8;
    steerSmoothed += (steerInput * maxSteer - steerSmoothed) * (1 - Math.exp(-steerRate * dt));

    const handling = evaluateTireCorneringAndYaw({
      dt,
      massKg: 3450,
      yawInertiaKgM2: 8800,
      vForwardMs: vF,
      vLateralMs: vL,
      yawRateRadS: yawRate,
      steerAngleRad: steerSmoothed,
      corners: TEST_CORNERS,
      normalLoadN: [8500, 8500, 8500, 8500],
      groundContact01: [1, 1, 1, 1],
      wheelSlipRatio: [0.08, 0.08, 0.08, 0.08],
      onRock: [0, 0, 0, 0],
      moisture: 0.55,
      tirePressurePsi: 30,
      isHandbrake: false,
      isLowRange: false,
      isRolledOver: false,
      rolledWheelAuthority: 1,
    });

    vL += handling.vLateralDeltaMs;
    yawRate += handling.yawRateDeltaRadS;
    const dH = yawRate * dt;
    heading += dH;
    const cosD = Math.cos(dH);
    const sinD = Math.sin(dH);
    const rotF = vF * cosD + vL * sinD;
    const rotL = vL * cosD - vF * sinD;
    vF = rotF;
    vL = rotL;

    stepRolloverDynamics(
      rollover,
      {
        dt,
        vForwardMs: vF,
        vLateralMs: vL,
        yawRateRadS: yawRate,
        steerAngleRad: steerSmoothed,
        terrainRollSlopeRad: 0,
        terrainPitchSlopeRad: 0,
        tirePressurePsi: 30,
        avgOnRock: 0,
        trackHalf: 1.02,
        cgHeight: 0.94,
        isHandbrake: false,
      },
      0,
      () => ({ height: 0, onRock: 0 }),
      () => {},
      { x: 0, y: 0, z: 0, sinH: Math.sin(heading), cosH: Math.cos(heading) },
    );

    maxAbsVLat = Math.max(maxAbsVLat, Math.abs(vL));
    maxAbsRollDeg = Math.max(maxAbsRollDeg, (Math.abs(rollover.rollRad) * 180) / Math.PI);
  }

  const headingDeg = (heading * 180) / Math.PI;
  assert.equal(rollover.isRolledOver, false, 'brief highway steering tap must never roll over');
  assert.equal(rollover.isTipping, false, 'brief highway steering tap must never lift inner wheels');
  assert.ok(maxAbsVLat < 2.2, `lateral slip must stay planted (<2.2 m/s), got ${maxAbsVLat.toFixed(2)} m/s`);
  assert.ok(maxAbsRollDeg < 11.0, `body roll must stay composed (<11 deg), got ${maxAbsRollDeg.toFixed(1)} deg`);
  assert.ok(headingDeg > 3.0 && headingDeg < 26.0, `heading change must be smooth (3..26 deg), got ${headingDeg.toFixed(1)} deg`);
  assert.ok(Math.abs(yawRate) < 0.08, `yaw rate must settle cleanly after releasing steer, got ${yawRate.toFixed(3)}`);
});

test('Cockpit steering wheel visual rotation matches actual vehicle turn direction', () => {
  // In right-handed Three.js looking +Z forward (+X = LEFT, +Y = UP),
  // rotating top marker (0, +R) by rz gives x' = -R * sin(rz).
  // Turning LEFT (frontWheelSteerRad > 0) MUST move top marker to +X (left)!
  const leftRz = computeSteeringWheelVisualAngleRad(0.25);
  const leftTopX = -0.195 * Math.sin(leftRz);
  assert.ok(leftTopX > 0.05, `Turning left must move 12-o'clock marker to +X (left), got x=${leftTopX.toFixed(3)}`);

  // Turning RIGHT (frontWheelSteerRad < 0) MUST move top marker to -X (right)!
  const rightRz = computeSteeringWheelVisualAngleRad(-0.25);
  const rightTopX = -0.195 * Math.sin(rightRz);
  assert.ok(rightTopX < -0.05, `Turning right must move 12-o'clock marker to -X (right), got x=${rightTopX.toFixed(3)}`);
});

test('Phase 0.2 (f0-2-1) — Reverse steering induced drag opposes reverse motion instead of accelerating backward', () => {
  const baseInput = {
    dt: 1 / 60,
    massKg: 3450,
    yawInertiaKgM2: 8800,
    vLateralMs: 0,
    yawRateRadS: 0,
    steerAngleRad: 0.34,
    corners: TEST_CORNERS,
    normalLoadN: [8500, 8500, 8500, 8500] as [number, number, number, number],
    groundContact01: [1, 1, 1, 1] as [number, number, number, number],
    wheelSlipRatio: [0.05, 0.05, 0.05, 0.05] as [number, number, number, number],
    onRock: [0, 0, 0, 0] as [number, number, number, number],
    moisture: 0.1,
    tirePressurePsi: 22,
    isHandbrake: false,
    isLowRange: false,
    isRolledOver: false,
    rolledWheelAuthority: 1,
  };

  const fwd = evaluateTireCorneringAndYaw({ ...baseInput, vForwardMs: 10.0 });
  const rev = evaluateTireCorneringAndYaw({ ...baseInput, vForwardMs: -10.0 });

  assert.ok(fwd.steeringDragForceN < -500, `forward steering must oppose +vForward (<0), got ${fwd.steeringDragForceN}`);
  assert.ok(rev.steeringDragForceN > 500, `reverse steering must oppose -vForward (>0), got ${rev.steeringDragForceN}`);
});

test('Phase 0.2 (f0-2-2) — Rollover front nose-down pitchVel amplifies front impact down-speed cleanly', () => {
  const runProbeImpact = (pitchVel: number) => {
    const st = createInitialRolloverState();
    st.isRolledOver = true;
    st.rollRad = 0.0;
    st.pitchRad = 1.25; // Steep nose-dive tumble so front hood corner strikes ground first
    st.pitchVel = pitchVel;
    st.airY = 0.95; // basePivotY=1.89, front hood ry2=-2.146 -> penetrates ground by ~0.25m
    st.vy = -1.2;
    const impacts: CrashImpactEvent[] = [];
    stepRolloverDynamics(
      st,
      {
        dt: 1 / 60,
        vForwardMs: 4.0,
        vLateralMs: 0,
        yawRateRadS: 0,
        steerAngleRad: 0,
        terrainRollSlopeRad: 0,
        terrainPitchSlopeRad: 0,
        tirePressurePsi: 22,
        avgOnRock: 0,
        trackHalf: 1.02,
        cgHeight: 0.94,
        isHandbrake: false,
      },
      0,
      () => ({ height: 0, onRock: 0 }),
      (ev) => impacts.push(ev),
      { x: 0, y: 0, z: 0, sinH: 0, cosH: 1 },
    );
    return { impacts, pitchVelAfter: st.pitchVel };
  };

  const noseDown = runProbeImpact(+5.0); // +pitchVel drives front (+lz) DOWN into ground
  const noseUp = runProbeImpact(-5.0);   // -pitchVel pulls front (+lz) UP away from ground
  assert.ok(noseDown.impacts.length >= 1, 'nose-down pitch slam must emit front impact');
  assert.equal(noseDown.impacts[0].zone, 'front', 'front hood probe must be deepest contact zone');
  const downImpulse = noseDown.impacts[0].impulseSpeedMs;
  const upImpulse = noseUp.impacts.length > 0 ? noseUp.impacts[0].impulseSpeedMs : 0;
  assert.ok(
    downImpulse > upImpulse + 2.0,
    `nose-down front impact (${downImpulse.toFixed(2)}) must exceed nose-up (${upImpulse.toFixed(2)})`,
  );
  assert.ok(
    noseDown.pitchVelAfter < 4.5,
    `front ground reaction must rebound nose upward (reduce +pitchVel), got ${noseDown.pitchVelAfter.toFixed(2)}`,
  );
});

test('Phase 0.2 (f0-2-3) — Exact Coriolis rotation preserves world linear momentum when yawing mid-air', () => {
  let heading = 0.72;
  let vF = 18.4;
  let vL = -3.6;

  const worldVx0 = Math.sin(heading) * vF + Math.cos(heading) * vL;
  const worldVz0 = Math.cos(heading) * vF - Math.sin(heading) * vL;

  // Spin heading by 1.35 rad across 30 mid-air frames with zero external horizontal forces
  for (let i = 0; i < 30; i++) {
    const dH = 0.045;
    heading += dH;
    const rot = rotateBodyVelocityByHeadingDelta(vF, vL, dH);
    vF = rot.vForward;
    vL = rot.vLateral;
  }

  const worldVx1 = Math.sin(heading) * vF + Math.cos(heading) * vL;
  const worldVz1 = Math.cos(heading) * vF - Math.sin(heading) * vL;
  assert.ok(Math.abs(worldVx1 - worldVx0) < 1e-11, `world Vx drifted: ${worldVx0} -> ${worldVx1}`);
  assert.ok(Math.abs(worldVz1 - worldVz0) < 1e-11, `world Vz drifted: ${worldVz0} -> ${worldVz1}`);
});

test('Phase 0.2 (f0-2-4 & f0-2-8) — Rollover/suspension velocity sync, dt-independent smoothing, and dynamic staticLoad', () => {
  // f0-2-8: dynamic static corner load scales with sprung + unsprung mass
  const lightSusp = createInitialSuspensionState(0, 0.94, 0.48, 1600, 40);
  const expectedLight = computeStaticCornerLoadN(1600, 40);
  assert.ok(Math.abs(lightSusp.normalLoadN[0] - expectedLight) < 1e-6);
  assert.ok(Math.abs(expectedLight - (1600 / 4 + 40) * 9.81) < 1e-6);

  snapSuspensionToGround(lightSusp, 2.5, 0.94, 0.48, 2000, 50);
  assert.ok(Math.abs(lightSusp.normalLoadN[2] - (2000 / 4 + 50) * 9.81) < 1e-6);

  // f0-2-4: rollover override preserves vertical/angular velocities instead of zeroing them
  stepSuspensionDynamics(lightSusp, {
    dt: 1 / 60,
    sprungMassKg: 2000,
    unsprungMassKg: 50,
    tireRadiusM: 0.48,
    comHeightRestM: 0.94,
    corners: TEST_CORNERS,
    groundSurfY: [2.5, 2.5, 2.5, 2.5],
    onRock: [0, 0, 0, 0],
    tirePressurePsi: 22,
    longitudinalAccelMs2: 0,
    lateralAccelMs2: 0,
    rolloverOverrideActive: true,
    rolloverRollRad: 0.85,
    rolloverPitchRad: 0.12,
    rolloverAirY: 0.4,
    rolloverVy: 2.75,
    rolloverRollVel: 1.9,
    rolloverPitchVel: -0.6,
    avgGroundY: 2.5,
  });
  assert.equal(lightSusp.chassisComVy, 2.75, 'rollover override must preserve vertical COM velocity');
  assert.equal(lightSusp.chassisRollVel, 1.9, 'rollover override must preserve roll velocity');
  assert.equal(lightSusp.chassisPitchVel, -0.6, 'rollover override must preserve pitch velocity');

  // f0-2-4: exponential smoothing factor converges identically at 60 Hz vs 120 Hz
  const a60 = computeExpSmoothingFactor(48.0, 1 / 60);
  const a120 = computeExpSmoothingFactor(48.0, 1 / 120);
  const rem60 = 1 - a60;
  const rem120TwoSteps = (1 - a120) * (1 - a120);
  assert.ok(Math.abs(rem60 - rem120TwoSteps) < 1e-12, '60 Hz and 2x 120 Hz exponential smoothing must match exactly');
});

test('Phase 0.2 (f0-2-5) — localVectorXZToWorld rotates detached debris impact normal by vehicle heading', () => {
  // Heading = +PI/2 faces +X; local forward (0, 1) must map to world (+1, 0), local left (1, 0) to (0, -1)
  const fwdWorld = localVectorXZToWorld(0, 1, Math.PI / 2);
  assert.ok(Math.abs(fwdWorld.worldX - 1) < 1e-12 && Math.abs(fwdWorld.worldZ) < 1e-12);

  const leftWorld = localVectorXZToWorld(1, 0, Math.PI / 2);
  assert.ok(Math.abs(leftWorld.worldX) < 1e-12 && Math.abs(leftWorld.worldZ - -1) < 1e-12);
});

test('Phase 0.2 (f0-2-6) — Airborne wheel with zero normal load reports zero sinkage and zero soil drag', () => {
  const tm = new SandTerramechanics(32);
  const air = tm.evaluateWheelContact({
    worldX: 4,
    worldZ: 4,
    normalLoadN: 0,
    tireWidth: 0.35,
    tireRadius: 0.48,
    slipRatio: 0.8,
    lateralSlipRad: 0.4,
    moisture: 0.2,
    biome: 'desert',
  });
  assert.equal(air.sinkage, 0);
  assert.equal(air.rollingResistanceN, 0);
  assert.equal(air.bulldozingForceN, 0);
  assert.equal(air.tractionFactor, 0);
});

test('Phase 0.2 (f0-2-7) — 3D rock collision respects vertical Y clearance and dt-independent scrape damping', () => {
  const rock = [{ x: 10, z: 0, radius: 2.0, scaleXZ: 2.0, scaleY: 1.0, yaw: 0, colorIndex: 0, yMin: -0.9, yMax: 0.85 }];

  // Airborne jump cleanly above rock top (vehicleMinY = 1.6 > rock.yMax = 0.85) must NOT collide
  const jumpOver = resolveRockCollisions(8.0, 0, 12.0, 0, 1.5, rock, {
    dt: 1 / 60,
    vehicleMinY: 1.6,
    vehicleMaxY: 3.7,
  });
  assert.equal(jumpOver.collided, false, 'jumping higher than rockYMax must clear obstacle cleanly');

  // Ground-level hit MUST collide and damp tangentially in a dt-independent way
  const hit60 = resolveRockCollisions(7.0, 0, 10.0, 10.0, 1.5, rock, {
    dt: 1 / 60,
    vehicleMinY: 0.0,
    vehicleMaxY: 2.1,
  });
  const hit120 = resolveRockCollisions(7.0, 0, 10.0, 10.0, 1.5, rock, {
    dt: 1 / 120,
    vehicleMinY: 0.0,
    vehicleMaxY: 2.1,
  });
  assert.equal(hit60.collided, true);
  assert.equal(hit120.collided, true);
  // Tangential speed vz retains Math.pow(0.88, dt * 60): 120 Hz single hit damps less than 60 Hz, and (vz120/10)^2 == vz60/10
  const r60 = hit60.vz / 10.0;
  const r120 = hit120.vz / 10.0;
  assert.ok(Math.abs(r120 * r120 - r60) < 1e-12, `expected dt-independent scrape damping: ${r120 * r120} vs ${r60}`);
});

test('Phase 0.2 (f0-2-9 & f0-2-10) — RunnerRig walks atop climbable rock slabs and skips ring-buffer query for swing foot', () => {
  const slab = CLIMBABLE_ROCK_SLABS[0];
  const baseSandY = sampleBaseTerrainHeight(slab.x, slab.z);
  const rockSurf = sampleClimbableRockSurface(slab.x, slab.z, baseSandY);
  assert.ok(rockSurf.rockElevation > 0.25, 'test slab must elevate noticeably above sand');

  // Place runner directly atop climbable sandstone slab (orbitRadius = 0)
  const runnerOnRock = new RunnerRig({
    centerX: slab.x,
    centerZ: slab.z,
    orbitRadius: 0,
    startAngle: 0,
    speedMs: 2.2,
    jacketColor: 0xcc5522,
  });
  assert.ok(
    Math.abs(runnerOnRock.position.y - rockSurf.height) < 1e-5,
    `runner on rock must stand at ${rockSurf.height.toFixed(3)}m, got ${runnerOnRock.position.y.toFixed(3)}m`,
  );

  // Place runner on flat desert sand and verify evaluateFootContact is ONLY called for stance feet (never airborne swing foot)
  const runnerOnSand = new RunnerRig({
    centerX: 0,
    centerZ: 0,
    orbitRadius: 6,
    startAngle: 0.3,
    speedMs: 2.5,
    jacketColor: 0x3377aa,
  });
  const tm = new SandTerramechanics(32);
  let footQueryCalls = 0;
  const origEvalInto = tm.evaluateFootContactInto.bind(tm);
  tm.evaluateFootContactInto = (inp, out) => {
    footQueryCalls++;
    return origEvalInto(inp, out);
  };
  const encoder = new BrushEncoder(16);

  const steps = 40;
  for (let i = 0; i < steps; i++) {
    encoder.clear();
    runnerOnSand.step(1 / 60, 0.15, tm, encoder, () => {}, 'desert');
  }
  // Previously 2 calls/step (= 80); with stance-only guard, ~1 call/step (strictly < 2 * steps and > 0)
  assert.ok(
    footQueryCalls > 0 && footQueryCalls < steps * 1.5,
    `expected stance-only foot queries (< ${steps * 1.5}), got ${footQueryCalls} over ${steps} steps`,
  );
});

test('GraphicsQualityBudget & DPR: Hybrid mode applies aggressive lossless budgets vs Ultra and falls back cleanly on SoftwareGL', () => {
  const hybridDesktop = getGraphicsQualityBudget('hybrid', false, false);
  const hybridMobile = getGraphicsQualityBudget('hybrid', true, false);
  const ultraDesktop = getGraphicsQualityBudget('ultra', false, false);
  const swFallback = getGraphicsQualityBudget('ultra', false, true);

  // Hybrid desktop must slash post-processing, bloom, shadow PCF, and exterior mirror overhead vs Ultra
  assert.equal(hybridDesktop.bloomScale, 0.25);
  assert.equal(ultraDesktop.bloomScale, 0.5);
  assert.ok(hybridDesktop.gtaoScale < ultraDesktop.gtaoScale);
  assert.ok(hybridDesktop.gtaoSamples <= 6);
  assert.ok(hybridDesktop.sscsSteps < ultraDesktop.sscsSteps);
  assert.equal(hybridDesktop.terrainFastShadowPcf, true);
  assert.equal(ultraDesktop.terrainFastShadowPcf, false);
  assert.ok(hybridDesktop.mirrorMaxExteriorDist > 5.0 && hybridDesktop.mirrorMaxExteriorDist < 7.0);
  assert.equal(hybridDesktop.interleaveCockpitMirrors, true);
  assert.equal(ultraDesktop.interleaveCockpitMirrors, false);
  assert.ok(ultraDesktop.cubeFacesPerFrame >= 3 && hybridDesktop.cubeFacesPerFrame >= 2);
  assert.ok(ultraDesktop.cubeMinMovedDistSq < hybridDesktop.cubeMinMovedDistSq);
  assert.ok(hybridDesktop.cubeMinCooldownFrames <= 4);
  assert.ok(hybridDesktop.grassDensityRatio < 1.0 && hybridDesktop.rainStreakRatio < 1.0);

  // Hybrid mobile trims further
  assert.ok(hybridMobile.gtaoScale <= hybridDesktop.gtaoScale);
  assert.ok(hybridMobile.maxTextureAnisotropy <= hybridDesktop.maxTextureAnisotropy);

  // SoftwareGL always enforces low tier
  assert.equal(swFallback.quality, 'low');
  assert.equal(swFallback.sscsSteps, 0);

  // Quality-aware pixelRatio caps (with backward-compatible default = 'ultra')
  assert.equal(computeEffectivePixelRatio(1440, 2.0, false), 2.0);
  assert.equal(computeEffectivePixelRatio(1440, 2.0, false, 'ultra'), 2.0);
  assert.equal(computeEffectivePixelRatio(1440, 2.0, false, 'hybrid'), 1.5);
  assert.equal(computeEffectivePixelRatio(390, 3.0, false, 'hybrid'), 1.25);
  assert.equal(computeEffectivePixelRatio(1440, 2.0, false, 'low'), 1.25);
  assert.equal(computeEffectivePixelRatio(1440, 2.0, true, 'ultra'), 1.0);
});

test('Rivian 3D model classifier: prunes shadows surgically, isolates interior layers & preserves pickup bed/grille', () => {
  // Primary exterior silhouette & tires/major rims cast shadows
  assert.equal(classifyRivianNodeRole('body_a_0_carpaint', 'Detail_Microflake_carpaint'), 'exterior_shadow');
  assert.equal(classifyRivianNodeRole('tyre_LF_0_rubber', 'rubber'), 'exterior_shadow');
  assert.equal(classifyRivianNodeRole('rim_LF_0_alloy', 'alloy'), 'exterior_shadow');
  assert.equal(classifyRivianNodeRole('trunkBay_a__SLOD_3', 'plastic'), 'exterior_shadow');

  // Small decals, labels, badges, glass, emitters, rotors, calipers, wipers & grille skip shadow pass
  assert.equal(classifyRivianNodeRole('rim_LF_8_label_ch1', 'Smart_Small_Decals'), 'exterior_noshadow');
  assert.equal(classifyRivianNodeRole('grille_a__SLOD_1', 'plastic_black'), 'exterior_noshadow');
  assert.equal(classifyRivianNodeRole('RIV_caliperLF_002_3', 'caliper_yellow'), 'exterior_noshadow');
  assert.equal(classifyRivianNodeRole('RIV_rotorLF_001_0', 'rotor_metal'), 'exterior_noshadow');
  assert.equal(classifyRivianNodeRole('glassF_a_0_glass_windshield', 'window glass 70%'), 'exterior_noshadow');

  // Interior partitioning: micro hidden outside cockpit; silhouette on CABIN_INTERIOR_LAYER
  assert.equal(classifyRivianNodeRole('pedals_a_0', 'metal'), 'interior_micro');
  assert.equal(classifyRivianNodeRole('floor_a_0', 'carpet_dark'), 'interior_micro');
  assert.equal(classifyRivianNodeRole('seatL_a_0', 'Leather_Black'), 'interior_silhouette');
  assert.equal(classifyRivianNodeRole('dashPad_a_0', 'wood_ash'), 'interior_silhouette');

  // Under-hood bay & liner stay hidden until hood opens/detaches; sealed cavities stay hidden
  assert.equal(classifyRivianNodeRole('engineBay_a__SLOD_5', 'plastic'), 'under_hood_bay');
  assert.equal(classifyRivianNodeRole('hoodLiner_a__SLOD_6', 'cloth'), 'under_hood_liner');
  assert.equal(classifyRivianNodeRole('doorSill_a__SLOD_0', 'plastic'), 'sealed_cavity');
});

test('ReflectionRayMath: asymmetric biome bounds anchor minY flush to groundPlaneY and fit highway corridor', () => {
  const highway = computeBiomeReflectionBounds('rainy_highway', -1.55, 0.0, 20.0);
  const desert = computeBiomeReflectionBounds('desert', 14.0, 2.35, -8.0);
  const mud = computeBiomeReflectionBounds('mud_grass', 3.0, -0.45, 5.0);

  // Every biome anchors virtual floor flush to exact groundPlaneY (never 13m underground!)
  assert.equal(highway.minY, 0.0);
  assert.equal(desert.minY, 2.35);
  assert.equal(mud.minY, -0.45);
  assert.ok(highway.probeCenterY > highway.minY + 1.0 && highway.probeCenterY < highway.maxY);

  // Highway bounds tightly track eucalyptus (+X) and pole (-X) roadside corridor and canopy height
  assert.ok(highway.maxX >= 9.0 && highway.maxX <= 12.0);
  assert.ok(highway.minX <= -11.0 && highway.minX >= -14.0);
  assert.ok(highway.maxY < desert.maxY, 'highway eucalyptus canopy ceiling must be tighter than open desert sky');
});

test('ReflectionRayMath: analytical ray-AABB PCC accurately detects ground-plane hits and clamps out-of-box origins', () => {
  const bounds = computeBiomeReflectionBounds('rainy_highway', -1.55, 0.0, 0.0);
  const boxMin = { x: bounds.minX, y: bounds.minY, z: bounds.minZ };
  const boxMax = { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ };
  const probeCenter = { x: -1.55, y: bounds.probeCenterY, z: 0.0 };

  // Downward door reflection ray at y=0.90m must hit groundPlaneY=0 at ~1.8m distance (not 25m!)
  const doorHit = projectParallaxReflectionRay(
    { x: -0.6, y: 0.9, z: 0.2 },
    { x: 0.866, y: -0.5, z: 0.0 },
    boxMin,
    boxMax,
    probeCenter,
  );
  assert.equal(doorHit.isGroundHit, true);
  assert.ok(doorHit.hitDist > 1.5 && doorHit.hitDist < 2.2, `expected ~1.8m ground hit, got ${doorHit.hitDist.toFixed(3)}`);
  assert.ok(doorHit.dirY < 0, 'ground hit direction from probe center must point downward');

  // Upward roof reflection ray must hit sky canopy, not ground
  const roofHit = projectParallaxReflectionRay(
    { x: -1.55, y: 1.85, z: 0.0 },
    { x: 0.1, y: 0.99, z: 0.1 },
    boxMin,
    boxMax,
    probeCenter,
  );
  assert.equal(roofHit.isGroundHit, false);
  assert.ok(roofHit.dirY > 0.9, 'upward roof reflection must sample upper sky/canopy');

  // Even if suspension dips vertex slightly below boxMin.y, origin clamping keeps result finite & valid
  const dipped = projectParallaxReflectionRay(
    { x: -1.55, y: -0.25, z: 0.0 },
    { x: 0.0, y: -1.0, z: 0.0 },
    boxMin,
    boxMax,
    probeCenter,
  );
  assert.ok(Number.isFinite(dipped.dirX) && Number.isFinite(dipped.dirY) && Number.isFinite(dipped.hitDist));
});

test('ReflectionRayMath: contact-hardening cone mip, Lagarde specular occlusion, self-body occlusion, and Fresnel', () => {
  // Nearby ground contact hit stays significantly sharper than distant sky hit for identical roughness
  const nearMip = computeConeTracedMipLevel(0.18, 1.4, 7.0, true);
  const farMip = computeConeTracedMipLevel(0.18, 22.0, 7.0, false);
  assert.ok(nearMip < farMip * 0.65, `nearby ground hit (${nearMip.toFixed(2)}) must be sharper than distant hit (${farMip.toFixed(2)})`);
  assert.equal(computeConeTracedMipLevel(0.0, 10.0, 7.0, false), 0);

  // Lagarde specular occlusion darkens cavities and remains bounded [0, 1]
  const openOcc = computeLagardeSpecularOcclusion(0.7, 1.0, 0.05);
  const cavityOcc = computeLagardeSpecularOcclusion(0.7, 0.25, 0.05);
  assert.ok(openOcc > 0.95 && cavityOcc < 0.45 && cavityOcc >= 0);

  // Self-body occlusion keeps exposed hood/roof high while heavily attenuating underbody & inward-pointing rays
  const hoodVis = computeSelfBodyOcclusion({ x: 0.0, y: 1.25, z: 1.6 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0.8, z: 0.6 });
  const underVis = computeSelfBodyOcclusion({ x: 0.0, y: 0.22, z: 0.2 }, { x: 0, y: -0.9, z: 0 }, { x: 0, y: -0.8, z: 0.2 });
  const inwardVis = computeSelfBodyOcclusion({ x: 0.92, y: 0.95, z: 0.1 }, { x: 0.9, y: 0.1, z: 0 }, { x: -0.9, y: 0.1, z: 0 });
  assert.ok(hoodVis > 0.95, `exposed hood must be unoccluded (got ${hoodVis.toFixed(3)})`);
  assert.ok(underVis < 0.35, `underbody must be strongly occluded (got ${underVis.toFixed(3)})`);
  assert.ok(inwardVis < 0.45, `inward ray toward chassis core must be attenuated (got ${inwardVis.toFixed(3)})`);

  // Dielectric Schlick Fresnel for clearcoat (IOR 1.5 -> F0 = 0.04 at normal, 1.0 at grazing)
  assert.ok(Math.abs(computeDielectricFresnel(1.0, 1.5) - 0.04) < 1e-4);
  assert.ok(Math.abs(computeDielectricFresnel(0.0, 1.5) - 1.0) < 1e-4);
  assert.ok(computeDielectricFresnel(0.15, 1.52) > 0.45);
});

test('ReflectionCubeScheduler: double-buffered cycle locks capture origin & keeps published bounds coherent until face 5 swap', () => {
  const sched = new ReflectionCubeScheduler();
  const decision: ReflectionCubeScheduleDecision = {
    action: 'idle',
    faceStart: 0,
    faceCount: 0,
    captureX: 0,
    captureY: 0,
    captureZ: 0,
    completesCycle: false,
    shouldBakePmrem: false,
  };
  const input: ReflectionCubeScheduleInput = {
    nowMs: 100,
    probeX: 0,
    probeY: 1.18,
    probeZ: 0,
    groundPlaneY: 0,
    biome: 'rainy_highway',
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

  // Frame 0: initial prime renders all 6 faces and immediately publishes origin + PMREM
  sched.evaluateInto(input, decision);
  assert.equal(decision.action, 'prime');
  assert.equal(decision.faceCount, 6);
  assert.equal(decision.shouldBakePmrem, true);
  assert.equal(sched.commit(input, decision), true);
  assert.equal(sched.publishedZ, 0);

  // Move car 2m forward after cooldown -> starts slice 0..1 latched at z=2.0
  input.hasPmrem = true;
  input.nowMs = 160;
  input.probeZ = 2.0;
  input.vehicleSpeedMs = 12;
  // Advance 2 frames for minCooldownFrames=2
  sched.evaluateInto({ ...input, probeZ: 0.2, nowMs: 120 }, decision);
  sched.evaluateInto(input, decision);
  assert.equal(decision.action, 'slice');
  assert.equal(decision.faceStart, 0);
  assert.equal(decision.faceCount, 2);
  assert.equal(decision.captureZ, 2.0);
  assert.equal(decision.completesCycle, false);
  assert.equal(sched.commit(input, decision), false);
  // Published origin MUST remain at z=0 while write buffer is still mid-cycle!
  assert.equal(sched.publishedZ, 0);

  // Car keeps moving to z=3.2 and z=4.5 during faces 2..5: capture MUST stay locked at latched z=2.0!
  input.nowMs = 176;
  input.probeZ = 3.2;
  sched.evaluateInto(input, decision);
  assert.equal(decision.action, 'slice');
  assert.equal(decision.faceStart, 2);
  assert.equal(decision.captureZ, 2.0);
  assert.equal(decision.completesCycle, false);
  assert.equal(sched.commit(input, decision), false);
  assert.equal(sched.publishedZ, 0);

  // Final faces 4..5 complete cycle -> atomic buffer swap publishes z=2.0!
  input.nowMs = 192;
  input.probeZ = 4.5;
  sched.evaluateInto(input, decision);
  assert.equal(decision.action, 'slice');
  assert.equal(decision.faceStart, 4);
  assert.equal(decision.captureZ, 2.0);
  assert.equal(decision.completesCycle, true);
  assert.equal(sched.commit(input, decision), true);
  assert.equal(sched.publishedZ, 2.0);

  // Soon after (elapsed < pmremMinIntervalMs), raw cube updates smoothly WITHOUT re-running heavy PMREM
  input.nowMs = 245;
  input.probeZ = 6.0;
  sched.evaluateInto({ ...input, nowMs: 210, probeZ: 5.0 }, decision);
  sched.evaluateInto(input, decision);
  assert.equal(decision.action, 'slice');
  assert.equal(decision.faceStart, 0);
  assert.equal(sched.commit(input, decision), false);

  // Once pmremMinIntervalMs (180ms from 100 -> 280+) elapses after a cycle completes, deferred PMREM fires
  sched.evaluateInto({ ...input, nowMs: 262, probeZ: 6.4 }, decision);
  sched.commit(input, decision);
  sched.evaluateInto({ ...input, nowMs: 278, probeZ: 6.8 }, decision);
  sched.commit(input, decision);
  assert.equal(sched.publishedZ, 6.0);

  sched.evaluateInto({ ...input, nowMs: 295, probeZ: 7.4 }, decision);
  assert.equal(decision.action, 'pmrem');
  assert.equal(decision.shouldBakePmrem, true);
  assert.equal(decision.faceCount, 0);
});




