import test from 'node:test';
import assert from 'node:assert/strict';
import { ScratchIndexList } from './BufferPool';
import { SpatialIndex2D } from './SpatialIndex2D';
import {
  CLIMBABLE_ROCK_SLABS,
  DESERT_ROCK_OBSTACLES,
  resolveRockCollisions,
  resolveRockCollisionsInto,
  sampleClimbableRockSurface,
  sampleClimbableRockSurfaceInto,
} from './DesertObstacles';
import { SandTerramechanics } from './SandTerramechanics';
import {
  computeWetHighwayGrip,
  computeWetHighwayGripInto,
  sampleHighwayPothole,
  sampleHighwayPotholeInto,
} from './RainyHighwayModel';

test('SpatialIndex2D safely handles 0-item datasets and box queries', () => {
  type BoxItem = { minX: number; minZ: number; maxX: number; maxZ: number };
  const index = new SpatialIndex2D<BoxItem>();
  const out = new ScratchIndexList(8);

  const emptyItems: BoxItem[] = [];
  index.build(emptyItems, (item, box) => {
    box[0] = item.minX;
    box[1] = item.minZ;
    box[2] = item.maxX;
    box[3] = item.maxZ;
  });
  index.queryBoxInto(-10, -10, 10, 10, out);
  assert.equal(out.length, 0);

  const items = [
    { minX: -2, minZ: -2, maxX: 0, maxZ: 0 },
    { minX: 10, minZ: 10, maxX: 14, maxZ: 14 },
    { minX: -1, minZ: 1, maxX: 3, maxZ: 5 },
  ];
  index.build(items, (item, box) => {
    box[0] = item.minX;
    box[1] = item.minZ;
    box[2] = item.maxX;
    box[3] = item.maxZ;
  }, 4);

  index.queryBoxInto(-0.5, -0.5, 1.5, 1.5, out);
  const hits = Array.from(out.data.slice(0, out.length)).sort((a, b) => a - b);
  assert.deepEqual(hits, [0, 2]);
});

test('DesertObstacles Flatbush *Into helpers match standard helpers identically', () => {
  const slab = CLIMBABLE_ROCK_SLABS[0];
  const sampleOut = { height: 0, rockElevation: 0, onRock: 0 };
  const refSample = sampleClimbableRockSurface(slab.x, slab.z, 1.25);
  sampleClimbableRockSurfaceInto(slab.x, slab.z, 1.25, CLIMBABLE_ROCK_SLABS, sampleOut);
  assert.equal(sampleOut.height, refSample.height);
  assert.equal(sampleOut.rockElevation, refSample.rockElevation);
  assert.equal(sampleOut.onRock, refSample.onRock);

  const obs = DESERT_ROCK_OBSTACLES[0];
  const colOut = {
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
  const px = obs.x + obs.radius * 0.4;
  const pz = obs.z;
  const refCol = resolveRockCollisions(px, pz, -8, 1, 1.15, DESERT_ROCK_OBSTACLES);
  resolveRockCollisionsInto(px, pz, -8, 1, 1.15, DESERT_ROCK_OBSTACLES, undefined, colOut);
  assert.equal(colOut.collided, true);
  assert.deepEqual(colOut, refCol);

  // Empty obstacle array edge case
  resolveRockCollisionsInto(0, 0, 1, 2, 1.15, [], undefined, colOut);
  assert.equal(colOut.collided, false);
});

test('SandTerramechanics Flatbush index finds tracks after recording and aging', () => {
  const tm = new SandTerramechanics(64);
  assert.equal(tm.queryTrackCompaction(5, 5), 0);

  for (let i = 0; i < 36; i++) {
    tm.recordTrackSegment(i * 2, 0, i * 2 + 1.5, 0, 0.3, 0.08, 0.85);
  }
  tm.tickAging(0.5, 0);
  const c = tm.queryTrackCompaction(20.5, 0.05);
  assert.ok(c > 0.6, `expected compacted track, got ${c}`);
  assert.equal(tm.queryTrackCompaction(20.5, 8.0), 0);

  const wheelOut = {
    sinkage: 0,
    trackCompaction: 0,
    rollingResistanceN: 0,
    bulldozingForceN: 0,
    tractionFactor: 0,
  };
  const wheelInput = {
    worldX: 20.5,
    worldZ: 0.05,
    normalLoadN: 5000,
    tireWidth: 0.34,
    tireRadius: 0.44,
    slipRatio: 0.1,
    lateralSlipRad: 0.05,
    moisture: 0.2,
  };
  const refWheel = tm.evaluateWheelContact(wheelInput);
  tm.evaluateWheelContactInto(wheelInput, wheelOut);
  assert.deepEqual(wheelOut, refWheel);
});

test('RainyHighwayModel *Into helpers match allocations-returning helpers', () => {
  const potholeOut = { depthM: 0, mask01: 0, crackRim01: 0, waterFill01: 0 };
  for (let z = 5; z < 45; z += 3.5) {
    const refP = sampleHighwayPothole(-1.8, z);
    sampleHighwayPotholeInto(-1.8, z, potholeOut);
    assert.deepEqual(potholeOut, refP);
  }

  const gripOut = { lateralGripScale: 0, rollingDragScale: 0, inPotholeWater: false };
  const refG = computeWetHighwayGrip(-1.5, 18.2, 22, 0.85);
  computeWetHighwayGripInto(-1.5, 18.2, 22, 0.85, gripOut);
  assert.deepEqual(gripOut, refG);
});
