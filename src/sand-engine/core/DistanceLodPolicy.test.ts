import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FarShadowCascadeScheduler,
  ReflectionLodProfile,
  computeReflectionLodProfileInto,
  getSceneObjectLodDistances,
} from './DistanceLodPolicy';

test('getSceneObjectLodDistances returns monotonic frozen presets across desktop, mobile & low tiers', () => {
  const ultra = getSceneObjectLodDistances('ultra', false, false);
  const hybrid = getSceneObjectLodDistances('hybrid', false, false);
  const mobile = getSceneObjectLodDistances('hybrid', true, false);
  const low = getSceneObjectLodDistances('low', false, false);

  // Referential equality (0 per-frame allocation)
  assert.strictEqual(ultra, getSceneObjectLodDistances('ultra', false, false));
  assert.strictEqual(mobile, getSceneObjectLodDistances('ultra', true, false));
  assert.ok(Object.isFrozen(ultra));

  // Strictly increasing rock LOD distances
  for (const tier of [ultra, hybrid, mobile, low]) {
    assert.ok(tier.rockLod1 > 0 && tier.rockLod2 > tier.rockLod1);
    assert.ok(tier.farShadowExtent >= 100);
    assert.ok(tier.farShadowMapSize >= 384 && tier.farShadowMapSize <= 512);
  }

  // Mobile & low transition to lower detail sooner than desktop ultra
  assert.ok(mobile.rockLod1 < hybrid.rockLod1 && hybrid.rockLod1 < ultra.rockLod1);
  assert.ok(low.canopyLod1 < mobile.canopyLod1 && mobile.canopyLod1 < ultra.canopyLod1);
});

test('computeReflectionLodProfileInto scales down mip detail, probe cadence & mirror viewport with distance', () => {
  const out: ReflectionLodProfile = {
    cubeMipBias: 0,
    cubeCooldownMult: 1,
    cubeFar: 300,
    mirrorIntervalMs: 16,
    mirrorViewportScale: 1,
    mirrorFar: 180,
  };

  // Cockpit keeps full 100% mirror viewport & 0 mip bias
  computeReflectionLodProfileInto(
    {
      camToVehicleDist: 1.5,
      isCockpit: true,
      biome: 'rainy_highway',
      quality: 'hybrid',
      isMobile: false,
      vehicleSpeedMs: 18,
    },
    out,
  );
  assert.equal(out.cubeMipBias, 0);
  assert.equal(out.mirrorViewportScale, 1.0);
  assert.ok(out.mirrorIntervalMs <= 17);
  const rainyCubeFar = out.cubeFar;

  // Close exterior view (< 6.8m) keeps crisp reflections
  computeReflectionLodProfileInto(
    {
      camToVehicleDist: 5.5,
      isCockpit: false,
      biome: 'desert',
      quality: 'hybrid',
      isMobile: false,
      vehicleSpeedMs: 12,
    },
    out,
  );
  assert.equal(out.cubeMipBias, 0);
  assert.equal(out.mirrorViewportScale, 1.0);
  assert.equal(out.cubeCooldownMult, 1.0);
  assert.ok(out.cubeFar > rainyCubeFar, 'Open desert reflects farther than misty rainy highway');

  // Far exterior view (35m) drops mirror viewport, increases mip bias, and slows probe cadence
  computeReflectionLodProfileInto(
    {
      camToVehicleDist: 35.0,
      isCockpit: false,
      biome: 'desert',
      quality: 'hybrid',
      isMobile: false,
      vehicleSpeedMs: 12,
    },
    out,
  );
  assert.ok(out.cubeMipBias > 0.8, `Expected elevated mip bias at 35m, got ${out.cubeMipBias}`);
  assert.ok(out.cubeCooldownMult >= 3.0);
  assert.ok(out.mirrorViewportScale <= 0.6);
  assert.ok(out.mirrorIntervalMs >= 40);
});

test('FarShadowCascadeScheduler updates once on init, stays 0 Hz while nearby, and triggers on >=12m travel or sun change', () => {
  const sched = new FarShadowCascadeScheduler(12.0, 120.0);

  // Initial prime updates immediately
  assert.equal(
    sched.shouldUpdate({
      nowMs: 100,
      focusX: 0,
      focusZ: 0,
      sunDirX: 0.4,
      sunDirY: 0.5,
      sunDirZ: 0.768,
    }),
    true,
  );

  // Small 4m movement stays cached (0 Hz)
  assert.equal(
    sched.shouldUpdate({
      nowMs: 400,
      focusX: 3,
      focusZ: 2.5,
      sunDirX: 0.4,
      sunDirY: 0.5,
      sunDirZ: 0.768,
    }),
    false,
  );

  // Traveling 13m after minInterval triggers a low-res recenter
  assert.equal(
    sched.shouldUpdate({
      nowMs: 500,
      focusX: 13,
      focusZ: 0,
      sunDirX: 0.4,
      sunDirY: 0.5,
      sunDirZ: 0.768,
    }),
    true,
  );

  // Sun angle shift forces immediate update
  assert.equal(
    sched.shouldUpdate({
      nowMs: 510,
      focusX: 13,
      focusZ: 0,
      sunDirX: 0.55,
      sunDirY: 0.45,
      sunDirZ: 0.703,
    }),
    true,
  );

  // Explicit markDirty (biome/teleport) forces immediate update
  sched.markDirty();
  assert.equal(
    sched.shouldUpdate({
      nowMs: 520,
      focusX: 13,
      focusZ: 0,
      sunDirX: 0.55,
      sunDirY: 0.45,
      sunDirZ: 0.703,
    }),
    true,
  );
});
