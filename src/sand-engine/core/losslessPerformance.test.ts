import test from 'node:test';
import assert from 'node:assert/strict';
import { ShadowUpdateScheduler, ShadowScheduleInput } from './ShadowUpdateScheduler';
import { getGraphicsQualityBudget } from './GraphicsQualityBudget';
import {
  BiomeReflectionBounds,
  computeBiomeReflectionBounds,
  computeBiomeReflectionBoundsInto,
} from './ReflectionRayMath';

function makeShadowInput(overrides: Partial<ShadowScheduleInput> = {}): ShadowScheduleInput {
  return {
    nowMs: 1000,
    vehicleX: 0,
    vehicleY: 0,
    vehicleZ: 0,
    vehicleFwdX: 0,
    vehicleFwdY: 0,
    vehicleFwdZ: 1,
    vehicleSpeedMs: 0,
    sunDirX: 0.4,
    sunDirY: 0.5,
    sunDirZ: 0.7681,
    hasMovingRunners: false,
    hasActiveDebris: false,
    forceImmediate: false,
    ...overrides,
  };
}

test('ShadowUpdateScheduler renders first frame and skips completely when parked/stationary', () => {
  const sched = new ShadowUpdateScheduler();
  assert.equal(sched.hasRendered(), false);

  // First frame always updates
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1000 })), true);
  assert.equal(sched.hasRendered(), true);

  // Subsequent frames while stationary skip 100% of shadow passes regardless of elapsed time
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1004 })), false);
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1020 })), false);
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 2500 })), false);
});

test('ShadowUpdateScheduler caps moving shadow updates by wall-clock cadence for unlocked FPS', () => {
  const sched = new ShadowUpdateScheduler();
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1000, vehicleZ: 0 })), true);

  // At 250 FPS (4ms frames), normal speed (5 m/s) updates only once every ~16.2ms
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1004, vehicleZ: 0.04, vehicleSpeedMs: 5 })), false);
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1008, vehicleZ: 0.08, vehicleSpeedMs: 5 })), false);
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1012, vehicleZ: 0.12, vehicleSpeedMs: 5 })), false);
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1017, vehicleZ: 0.17, vehicleSpeedMs: 5 })), true);

  // Fast speed (> 8 m/s) raises cadence to ~90 Hz (11ms)
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1024, vehicleZ: 0.4, vehicleSpeedMs: 18 })), false);
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1029, vehicleZ: 0.6, vehicleSpeedMs: 18 })), true);
});

test('ShadowUpdateScheduler immediately updates on sun change, large teleport, or markDirty()', () => {
  const sched = new ShadowUpdateScheduler();
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1000 })), true);

  // Sun angle changed -> immediate update even 2ms later
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1002, sunDirY: 0.52 })), true);

  // Teleport (> 1.5m) -> immediate update even 2ms later
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1004, vehicleZ: 3.0 })), true);

  // Explicit dirty mark (biome/quality/GLB swap) -> immediate update
  sched.markDirty();
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1005, vehicleZ: 3.0 })), true);
});

test('ShadowUpdateScheduler keeps runners and debris shadows updating at cadence even when vehicle parked', () => {
  const sched = new ShadowUpdateScheduler();
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1000, hasMovingRunners: true })), true);
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1008, hasMovingRunners: true })), false);
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1017, hasMovingRunners: true })), true);

  // Active crash debris updates at faster 11ms cadence
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1023, hasActiveDebris: true })), false);
  assert.equal(sched.shouldUpdate(makeShadowInput({ nowMs: 1029, hasActiveDebris: true })), true);
});

test('getGraphicsQualityBudget returns cached frozen references with zero per-call allocation', () => {
  const h1 = getGraphicsQualityBudget('hybrid', false, false);
  const h2 = getGraphicsQualityBudget('hybrid', false, false);
  assert.equal(h1, h2);
  assert.equal(Object.isFrozen(h1), true);

  const u1 = getGraphicsQualityBudget('ultra', false, false);
  const u2 = getGraphicsQualityBudget('ultra', false, false);
  assert.equal(u1, u2);
  assert.notEqual(u1, h1);

  const sw1 = getGraphicsQualityBudget('ultra', false, true);
  const sw2 = getGraphicsQualityBudget('low', true, false);
  assert.equal(sw1, sw2);
});

test('computeBiomeReflectionBoundsInto matches computeBiomeReflectionBounds across all biomes', () => {
  const scratch: BiomeReflectionBounds = {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 0,
    maxY: 0,
    maxZ: 0,
    probeCenterY: 0,
  };
  for (const biome of ['rainy_highway', 'desert', 'mud_grass'] as const) {
    const expected = computeBiomeReflectionBounds(biome, 3.2, 1.4, -12.5);
    const out = computeBiomeReflectionBoundsInto(biome, 3.2, 1.4, -12.5, scratch);
    assert.equal(out, scratch);
    assert.deepEqual(out, expected);
  }
});
