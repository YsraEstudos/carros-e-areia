import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWetHighwayGrip,
  getRainyHighwayObstaclesNear,
  HIGHWAY_CONSTANTS,
  isOnPavedHighway,
  resolveHighwayObstacleCollisions,
  resolveVehicleCapsuleHighwayCollision,
  sampleHighwayPothole,
  sampleRainyHighwayHeight,
} from './RainyHighwayModel';

test('rainy highway center is paved and crowned smoothly above road edges', () => {
  assert.equal(isOnPavedHighway(0), true);
  assert.equal(isOnPavedHighway(3.2), true);
  assert.equal(isOnPavedHighway(5.5), false);

  // At z = 0 (clean spawn zone without potholes), road center is slightly higher than shoulder edge
  const hCenter = sampleRainyHighwayHeight(0, 0);
  const hEdge = sampleRainyHighwayHeight(HIGHWAY_CONSTANTS.ROAD_HALF_WIDTH, 0);
  assert.ok(hCenter > hEdge + 0.03, `Expected crowned road (${hCenter} > ${hEdge})`);

  // Drainage swale at |x| = 6.8 sits below road edge
  const hSwale = sampleRainyHighwayHeight(6.8, 0);
  assert.ok(hSwale < hEdge - 0.10, `Expected drainage swale (${hSwale} < ${hEdge})`);
});

test('deterministic potholes exist ahead of spawn and depress road surface with water', () => {
  let foundPothole = false;
  let maxDepth = 0;
  for (let z = 6; z <= 60; z += 0.5) {
    for (let x = -3.1; x <= 3.1; x += 0.35) {
      const p = sampleHighwayPothole(x, z);
      if (p.mask01 > 0.65 && p.depthM > 0.04) {
        foundPothole = true;
        maxDepth = Math.max(maxDepth, p.depthM);
        assert.ok(p.waterFill01 > 0.5, 'Deep pothole should hold standing rainwater');
      }
    }
  }
  assert.equal(foundPothole, true, 'Expected deterministic potholes along rural highway ahead of spawn');
  assert.ok(maxDepth >= 0.045 && maxDepth <= 0.14, `Pothole depth ${maxDepth}m out of realistic range`);

  // Immediate spawn wheels at z=0 stay clean
  assert.equal(sampleHighwayPothole(0, 0).depthM, 0);
});

test('roadside obstacles place eucalyptus trees on left (+X), poles on right (-X), and resolve solid hits', () => {
  const obstacles = getRainyHighwayObstaclesNear(20, 45);
  const trees = obstacles.filter((o) => o.kind === 'eucalyptus');
  const poles = obstacles.filter((o) => o.kind === 'utility_pole');
  const fences = obstacles.filter((o) => o.kind === 'fence_post');

  assert.ok(trees.length >= 4, 'Expected overhanging eucalyptus trees along left flank');
  assert.ok(poles.length >= 2, 'Expected utility poles along right flank');
  assert.ok(fences.length >= 10, 'Expected wooden fence posts on both sides');

  for (const t of trees) {
    assert.ok(t.x > HIGHWAY_CONSTANTS.SHOULDER_OUTER_X, 'Trees must sit safely off the paved road on +X left side');
  }
  for (const p of poles) {
    assert.ok(p.x < -HIGHWAY_CONSTANTS.SHOULDER_OUTER_X, 'Utility poles must sit off the paved road on -X right side');
  }

  // Colliding directly with a eucalyptus trunk produces push-out vector
  const targetTree = trees[0];
  const hit = resolveHighwayObstacleCollisions(targetTree.x - 0.5, targetTree.z, 1.05);
  assert.equal(hit.hit, true);
  assert.equal(hit.obstacle?.kind, 'eucalyptus');
  assert.ok(hit.pushX < 0, 'Collision should push truck back toward highway (-X)');

  // Driving down center of highway has zero obstacle hits
  const clean = resolveHighwayObstacleCollisions(0, 20, 1.05);
  assert.equal(clean.hit, false);
});

test('wet highway grip drops on puddles at high speed and off-road shoulder increases drag', () => {
  const dryAsphalt = computeWetHighwayGrip(0, 0, 5, 0.2);
  const fastWet = computeWetHighwayGrip(0, 0, 32, 1.0);
  const shoulder = computeWetHighwayGrip(4.4, 0, 10, 0.8);

  assert.ok(fastWet.lateralGripScale < dryAsphalt.lateralGripScale, 'High-speed rain should reduce lateral grip');
  assert.ok(shoulder.rollingDragScale > dryAsphalt.rollingDragScale, 'Gravel shoulder should have higher rolling drag than asphalt');
});

test('3-sphere vehicle capsule detects front-bumper tree impact before hood clips trunk', () => {
  const trees = getRainyHighwayObstaclesNear(20, 40).filter((o) => o.kind === 'eucalyptus');
  const tree = trees[0];
  // Truck facing +Z (heading=0), center 2.5m behind trunk -> front bumper touches trunk!
  const hit = resolveVehicleCapsuleHighwayCollision(tree.x, tree.z - 2.5, 0);
  assert.equal(hit.hit, true);
  assert.equal(hit.obstacle?.id, tree.id);
  assert.ok(hit.pushZ < 0, 'Front bumper hit should push vehicle backward (-Z)');
});
