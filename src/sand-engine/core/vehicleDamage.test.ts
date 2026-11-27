import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyImpactToDamageState,
  applyPotholeSuspensionImpact,
  createInitialDamageState,
  deformSubmeshVertices,
  stepMechanicalDamage,
} from './VehicleCrashPhysics';

test('moderate front hit is absorbed by Rivian EV frunk crumple zone with zero engine breakdown or hood smoke', () => {
  const dmg = createInitialDamageState();
  assert.equal(dmg.engineHealth01, 1);
  assert.equal(dmg.radiatorLeak01, 0);
  assert.equal(dmg.coolantTempC, 38);

  // Moderate single frontal hit into a pole/tree (~32 km/h)
  applyImpactToDamageState(dmg, {
    zone: 'front',
    localPointX: -0.45,
    localPointY: 0.92,
    localPointZ: 2.38,
    localNormalX: 0,
    localNormalY: 0,
    localNormalZ: -1,
    worldPointX: 0,
    worldPointY: 1,
    worldPointZ: 2,
    impulseSpeedMs: 8.8,
    severity: 0.55,
    onRock: true,
    wheelIndex: -1,
  });

  // Frunk absorbed the impact: NO front engine breakdown, NO radiator leak, NO combustion smoke!
  assert.equal(dmg.engineHealth01, 1, 'frunk crumple zone should shield quad-motor drive on moderate front hit');
  assert.equal(dmg.radiatorLeak01, 0, 'low EV chiller should stay intact on moderate front hit');
  assert.equal(dmg.headlightBroken[1], true, 'right front headlight should break on right-front hit');
  assert.equal(dmg.headlightBroken[0], false, 'left front headlight should stay intact on right-front hit');
  assert.ok(dmg.hoodPoppedAngleRad > 0.03 && dmg.hoodPoppedAngleRad < 0.22, 'hood should buckle slightly ajar, not open cleanly wide');
  assert.ok(Math.abs(dmg.hoodTwistRad) > 0.01, 'off-center front hit should twist hood slightly');
  assert.ok(Math.abs(dmg.frontBumperSagRad) > 0.01, 'front bumper should sag visibly before detaching');

  const mech = stepMechanicalDamage(dmg, 0.05, 18, 1.0);
  assert.equal(mech.powerScale, 1, 'truck should drive at 100% power after moderate frunk hit');
  assert.equal(mech.steamIntensity, 0, 'empty frunk must not emit engine smoke or radiator steam');
  assert.equal(mech.misfireActive, false, 'EV drivetrain must never misfire');
  assert.equal(mech.overheated, false);
});

test('catastrophic repeated front crushes detach front parts, breach low EV chiller, yet rear motors preserve >=72% drive power', () => {
  const dmg = createInitialDamageState();
  const detachedAll: string[] = [];
  for (let i = 0; i < 4; i++) {
    const res = applyImpactToDamageState(dmg, {
      zone: 'front',
      localPointX: 0.35,
      localPointY: 1.05,
      localPointZ: 2.35,
      localNormalX: 0,
      localNormalY: 0,
      localNormalZ: -1,
      worldPointX: 0,
      worldPointY: 1,
      worldPointZ: 2,
      impulseSpeedMs: 13.5,
      severity: 0.85,
      onRock: true,
      wheelIndex: -1,
    });
    detachedAll.push(...res.newlyDetached);
  }

  assert.ok(dmg.radiatorLeak01 > 0.3, 'catastrophic front crush should breach low-mounted EV thermal chiller');
  assert.ok(dmg.engineHealth01 >= 0.62 && dmg.engineHealth01 < 1.0, 'front drive unit mildly derates while rear motors stay healthy');
  assert.ok(dmg.steeringPullRad > 0, 'off-center front crash should bend steering alignment');
  assert.ok(dmg.windshieldCrackLevel >= 1, 'catastrophic front crash should crack windshield');
  assert.equal(dmg.detached.frontBumper, true);
  assert.equal(dmg.detached.frontGrille, true);
  assert.equal(dmg.detached.hood, true);
  assert.equal(dmg.wiperDamaged, true);
  assert.ok(detachedAll.includes('frontBumper'));

  let out = stepMechanicalDamage(dmg, 0.05, 22, 1.0);
  for (let i = 0; i < 120; i++) {
    out = stepMechanicalDamage(dmg, 0.05, 24, 1.0);
  }
  assert.ok(dmg.coolantTempC >= 78, `expected EV thermal warning >= 78C, got ${dmg.coolantTempC}`);
  assert.equal(out.overheated, true);
  assert.equal(out.misfireActive, false, 'Quad-Motor EV must never trigger V8 misfire');
  assert.ok(out.steamIntensity > 0.25 && out.steamIntensity <= 0.72, 'breached EV chiller emits modest low mist');
  assert.ok(out.powerScale >= 0.72 && out.powerScale < 0.96, `rear dual motors must preserve >=72% drive power, got ${out.powerScale}`);
});

test('frontal hood deformation creates upward accordion V-buckle while preserving vertex colors and localized scrapes', () => {
  // Build a flat hood grid from z=1.3 to z=2.5, x=-0.7 to 0.7, y=0.90
  const nx = 9;
  const nz = 9;
  const count = nx * nz;
  const restPositions = new Float32Array(count * 3);
  const positions = new Float32Array(count * 3);
  const restColors = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const scrapes = new Float32Array(count);

  let idx = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = -0.7 + (ix / (nx - 1)) * 1.4;
      const z = 1.3 + (iz / (nz - 1)) * 1.2;
      restPositions[idx * 3] = x;
      restPositions[idx * 3 + 1] = 0.9;
      restPositions[idx * 3 + 2] = z;
      restColors[idx * 3] = 0.92;
      restColors[idx * 3 + 1] = 0.72;
      restColors[idx * 3 + 2] = 0.25;
      idx++;
    }
  }
  positions.set(restPositions);
  colors.set(restColors);

  const res = deformSubmeshVertices({
    positions,
    restPositions,
    colors,
    restColors,
    scrapes,
    impactLocalX: 0.0,
    impactLocalY: 0.88,
    impactLocalZ: 2.48,
    crushDirX: 0,
    crushDirY: 0,
    crushDirZ: -1,
    radius: 0.95,
    maxCrushDepth: 0.22,
    creaseSeed: 2.5,
    isHood: true,
    isFrontalCrush: true,
  });

  assert.ok(res.modifiedVertices > 20, 'frontal hit should deform hood vertices');

  // Verify mid-hood (z ~ 1.9, x = 0) buckled UPWARD (+Y) into an accordion V-fold
  const midIdx = 4 * nx + 4; // z = 1.9, x = 0
  const midDy = positions[midIdx * 3 + 1] - restPositions[midIdx * 3 + 1];
  assert.ok(midDy > 0.04, `mid-hood should buckle upward into V-fold (+Y), got dy=${midDy}`);

  // Verify vertex colors stayed 100% pristine (zero color corruption) and scrapes stay localized
  let highScrapeCount = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(colors[i * 3], restColors[i * 3]);
    assert.equal(colors[i * 3 + 1], restColors[i * 3 + 1]);
    assert.equal(colors[i * 3 + 2], restColors[i * 3 + 2]);
    if (scrapes[i] > 0.55) highScrapeCount++;
  }
  assert.ok(highScrapeCount > 0 && highScrapeCount < count * 0.35, `high scrapes must stay localized, got ${highScrapeCount}/${count}`);
});

test('side & rear crashes detach side steps, mirrors, tailgate & crack side door glass', () => {
  const dmg = createInitialDamageState();

  for (let i = 0; i < 2; i++) {
    applyImpactToDamageState(dmg, {
      zone: 'left',
      localPointX: 0.92,
      localPointY: 1.1,
      localPointZ: 0.2,
      localNormalX: -1,
      localNormalY: 0,
      localNormalZ: 0,
      worldPointX: 1,
      worldPointY: 1,
      worldPointZ: 0,
      impulseSpeedMs: 11.0,
      severity: 0.65,
      onRock: false,
      wheelIndex: -1,
    });
  }
  assert.equal(dmg.detached.leftMirror, true);
  assert.equal(dmg.detached.leftStep, true);
  assert.equal(dmg.sideGlassBroken[0], true);

  for (let i = 0; i < 2; i++) {
    applyImpactToDamageState(dmg, {
      zone: 'rear',
      localPointX: 0,
      localPointY: 1.0,
      localPointZ: -2.45,
      localNormalX: 0,
      localNormalY: 0,
      localNormalZ: 1,
      worldPointX: 0,
      worldPointY: 1,
      worldPointZ: -2,
      impulseSpeedMs: 12.0,
      severity: 0.7,
      onRock: false,
      wheelIndex: -1,
    });
  }
  assert.equal(dmg.detached.rearBumper, true);
  assert.equal(dmg.detached.tailgate, true);
});

test('high-speed pothole slams degrade alignment and puncture tire, adding flat-tire drag', () => {
  const dmg = createInitialDamageState();
  // Low-speed pothole should not damage suspension
  assert.equal(applyPotholeSuspensionImpact(dmg, 0, 8.0, 0.12), false);

  // Repeated high-speed deep pothole hits degrade front-left tire into puncture
  for (let i = 0; i < 6; i++) {
    assert.equal(applyPotholeSuspensionImpact(dmg, 0, 28.0, 0.14), true);
  }
  assert.equal(dmg.wheels[0].punctured, true);
  assert.ok(dmg.steeringPullRad > 0);

  const mech = stepMechanicalDamage(dmg, 0.02, 18, 0.5);
  assert.ok(mech.flatTireDrag > 1.0, 'punctured tire should add measurable rolling drag');
  assert.ok(mech.steeringShakeAmp > 0.05, 'punctured tire should vibrate cockpit steering wheel');
});
