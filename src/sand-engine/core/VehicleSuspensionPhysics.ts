/**
 * VehicleSuspensionPhysics.ts
 * Pure, engine-agnostic 4-corner independent off-road suspension (unsprung wheel mass,
 * progressive Baja coilovers, asymmetric bypass bump/rebound dampers, sway bars,
 * tire radial sidewall spring) + nonlinear load-weighted brush tire cornering & drift physics.
 * Zero Three.js dependencies — fully deterministic and unit-testable in Node.
 */

export interface SuspensionWheelCorner {
  lx: number; // +left, -right (m)
  lz: number; // +front, -rear (m)
  isFront: boolean;
  isLeft: boolean;
}

export interface SuspensionCornerOut {
  travelM: number;        // -0.34m (full droop) .. +0.26m (full bump compression)
  travelVelMs: number;    // m/s
  hubWorldY: number;      // world Y of wheel spindle
  hubVelY: number;        // world Y velocity of wheel spindle
  normalLoadN: number;    // live downward/upward tire contact force on surface (>= 0)
  suspForceN: number;     // coilover + bypass damper + ARB force pushing chassis up
  tireSquash01: number;   // 0..1 normalized sidewall radial deflection under load
  groundContact01: number;// 0 = airborne, 1 = firmly planted
  dynamicCamberRad: number; // subtle suspension geometry + sidewall roll flex
}

export interface SuspensionState {
  initialized: boolean;
  chassisComWorldY: number;
  chassisComVy: number;
  chassisPitchRad: number; // + = nose down (braking dive), - = nose up (accel squat)
  chassisPitchVel: number;
  chassisRollRad: number;  // + = lean right (left turn), - = lean left (right turn)
  chassisRollVel: number;
  hubWorldY: [number, number, number, number];
  hubVelY: [number, number, number, number];
  travelM: [number, number, number, number];
  travelVelMs: [number, number, number, number];
  normalLoadN: [number, number, number, number];
  groundContact01: [number, number, number, number];
  tireSquash01: [number, number, number, number];
  dynamicCamberRad: [number, number, number, number];
}

export interface SuspensionStepInput {
  dt: number;
  sprungMassKg: number;
  unsprungMassKg: number;
  tireRadiusM: number;
  comHeightRestM: number; // 0.94m
  corners: readonly [
    SuspensionWheelCorner,
    SuspensionWheelCorner,
    SuspensionWheelCorner,
    SuspensionWheelCorner,
  ];
  groundSurfY: readonly [number, number, number, number]; // ground/rock surface Y minus sand sinkage
  onRock: readonly [number, number, number, number];
  tirePressurePsi: number;
  longitudinalAccelMs2: number; // forward acceleration (drives realistic squat/dive weight transfer)
  lateralAccelMs2: number;      // centripetal/lateral acceleration (+ = forces body to +roll right lean)
  /** External override when full 360-deg rollover crash physics takes over (> ~28 deg) */
  rolloverOverrideActive: boolean;
  rolloverRollRad: number;
  rolloverPitchRad: number;
  rolloverAirY: number;
  /** Optional rollover velocities to preserve vertical/angular momentum seamlessly across transitions */
  rolloverVy?: number;
  rolloverRollVel?: number;
  rolloverPitchVel?: number;
  avgGroundY: number;
}

export function computeStaticCornerLoadN(
  sprungMassKg = 3230,
  unsprungMassKg = 55,
  gravity = 9.81,
): number {
  return (sprungMassKg * 0.25 + unsprungMassKg) * gravity;
}

export function createInitialSuspensionState(
  initialGroundY = 0,
  comHeightRestM = 0.94,
  tireRadiusM = 0.48,
  sprungMassKg = 3230,
  unsprungMassKg = 55,
): SuspensionState {
  const hubY = initialGroundY + tireRadiusM;
  const staticLoad = computeStaticCornerLoadN(sprungMassKg, unsprungMassKg);
  return {
    initialized: true,
    chassisComWorldY: initialGroundY + comHeightRestM,
    chassisComVy: 0,
    chassisPitchRad: 0,
    chassisPitchVel: 0,
    chassisRollRad: 0,
    chassisRollVel: 0,
    hubWorldY: [hubY, hubY, hubY, hubY],
    hubVelY: [0, 0, 0, 0],
    travelM: [0, 0, 0, 0],
    travelVelMs: [0, 0, 0, 0],
    normalLoadN: [staticLoad, staticLoad, staticLoad, staticLoad],
    groundContact01: [1, 1, 1, 1],
    tireSquash01: [0.04, 0.04, 0.04, 0.04],
    dynamicCamberRad: [0, 0, 0, 0],
  };
}

export function snapSuspensionToGround(
  state: SuspensionState,
  avgGroundY: number,
  comHeightRestM = 0.94,
  tireRadiusM = 0.48,
  sprungMassKg = 3230,
  unsprungMassKg = 55,
): void {
  const hubY = avgGroundY + tireRadiusM;
  const staticLoad = computeStaticCornerLoadN(sprungMassKg, unsprungMassKg);
  state.initialized = true;
  state.chassisComWorldY = avgGroundY + comHeightRestM;
  state.chassisComVy = 0;
  state.chassisPitchRad = 0;
  state.chassisPitchVel = 0;
  state.chassisRollRad = 0;
  state.chassisRollVel = 0;
  for (let i = 0; i < 4; i++) {
    state.hubWorldY[i] = hubY;
    state.hubVelY[i] = 0;
    state.travelM[i] = 0;
    state.travelVelMs[i] = 0;
    state.normalLoadN[i] = staticLoad;
    state.groundContact01[i] = 1;
    state.tireSquash01[i] = 0.04;
    state.dynamicCamberRad[i] = 0;
  }
}

const _suspForceCorner = new Float64Array(4);
const _mountY = new Float64Array(4);
const _mountVy = new Float64Array(4);
const _travels = new Float64Array(4);
const _arbForces = new Float64Array(4);

/**
 * Steps 4-corner unsprung wheel masses, tire radial carcass springs, progressive coilovers,
 * asymmetric off-road bypass dampers, anti-roll bars, and 3-DOF sprung chassis (heave, pitch, roll).
 */
export function stepSuspensionDynamics(
  state: SuspensionState,
  input: SuspensionStepInput,
): void {
  const dtTotal = Math.min(0.05, Math.max(0.001, input.dt));
  const g = 9.81;

  if (!state.initialized) {
    snapSuspensionToGround(
      state,
      input.avgGroundY,
      input.comHeightRestM,
      input.tireRadiusM,
      input.sprungMassKg,
      input.unsprungMassKg,
    );
  }

  // If full 360-deg crash tumble owns orientation, track rollover pose & velocities cleanly
  // so transitions back to normal suspension or F-key righting have zero vertical/angular discontinuity
  if (input.rolloverOverrideActive) {
    const rolloverVy = input.rolloverVy ?? 0;
    state.chassisComWorldY = input.avgGroundY + input.comHeightRestM + input.rolloverAirY;
    state.chassisComVy = rolloverVy;
    state.chassisPitchRad = input.rolloverPitchRad;
    state.chassisPitchVel = input.rolloverPitchVel ?? 0;
    state.chassisRollRad = input.rolloverRollRad;
    state.chassisRollVel = input.rolloverRollVel ?? 0;
    const droop = -0.31;
    const mountDrop = input.comHeightRestM - input.tireRadiusM;
    const droopAlpha = 1 - Math.exp(-12 * dtTotal);
    for (let i = 0; i < 4; i++) {
      const prevTravel = state.travelM[i];
      state.travelM[i] += (droop - prevTravel) * droopAlpha;
      state.travelVelMs[i] = (state.travelM[i] - prevTravel) / dtTotal;
      state.hubWorldY[i] = state.chassisComWorldY - mountDrop + state.travelM[i];
      state.hubVelY[i] = rolloverVy;
      state.normalLoadN[i] = 0;
      state.groundContact01[i] = 0;
      state.tireSquash01[i] = 0;
      state.dynamicCamberRad[i] = 0;
    }
    return;
  }

  // Vehicle inertia & off-road long-travel coilover tuning (~1.35 Hz plush desert Trophy Truck!)
  const sprungM = input.sprungMassKg;
  const wheelM = input.unsprungMassKg;
  const totalStaticWeightN = (sprungM + wheelM * 4) * g;
  const staticSprungPerCornerN = (sprungM * g) * 0.25;

  // Rotational inertias for a heavy ~5.2m long x 2.1m wide expedition 4x4
  const pitchInertia = sprungM * 2.55; // ~7,600 kg·m^2
  const rollInertia = sprungM * 0.88;  // ~2,650 kg·m^2

  const maxBumpM = 0.26;
  const maxDroopM = -0.34;
  const mountDropFromCom = input.comHeightRestM - input.tireRadiusM; // ~0.46m

  // Tire vertical spring scales realistically with air pressure (10..36 PSI)
  const psiNorm = Math.max(0, Math.min(1, (input.tirePressurePsi - 10) / 26));
  const kTire = 78000 + psiNorm * 58000; // softer 12 PSI pillow vs firmer 32 PSI
  const cTire = 2600;
  const staticTireDeflM = (staticSprungPerCornerN + wheelM * g) / kTire;

  // Plush initial spring rate + progressive hydraulic bump-stop for soft landings
  const kSpringFront = 38500;
  const kSpringRear = 35500;
  const cBump = 3200;     // compliant compression valving (swallows rocks/moguls!)
  const cRebound = 6100;  // controlled rebound valving (creamy float without pogo)
  const kAntiRollFront = 14800;
  const kAntiRollRear = 11600;

  // Use 6 fast substeps for rock-solid unsprung wheel stability at up to dt=50ms
  const substeps = dtTotal > 0.022 ? 6 : 4;
  const subDt = dtTotal / substeps;

  const suspForceCorner = _suspForceCorner;
  const mountY = _mountY;
  const mountVy = _mountVy;
  const travels = _travels;
  const arbForces = _arbForces;

  for (let step = 0; step < substeps; step++) {
    const sinP = Math.sin(state.chassisPitchRad);
    const cosP = Math.cos(state.chassisPitchRad);
    const sinR = Math.sin(state.chassisRollRad);
    const cosR = Math.cos(state.chassisRollRad);

    // Precompute suspension mount Y & velocity for all 4 corners
    for (let i = 0; i < 4; i++) {
      const c = input.corners[i];
      mountY[i] =
        state.chassisComWorldY -
        mountDropFromCom * cosP * cosR -
        c.lz * sinP +
        c.lx * sinR;
      mountVy[i] =
        state.chassisComVy -
        c.lz * state.chassisPitchVel +
        c.lx * state.chassisRollVel;
    }

    // Current suspension travel per corner (positive = bump compression, negative = droop extension)
    const t0 = clamp(state.hubWorldY[0] - mountY[0], maxDroopM, maxBumpM);
    const t1 = clamp(state.hubWorldY[1] - mountY[1], maxDroopM, maxBumpM);
    const t2 = clamp(state.hubWorldY[2] - mountY[2], maxDroopM, maxBumpM);
    const t3 = clamp(state.hubWorldY[3] - mountY[3], maxDroopM, maxBumpM);
    travels[0] = t0;
    travels[1] = t1;
    travels[2] = t2;
    travels[3] = t3;

    // Sway bar (anti-roll bar) transfers difference between left & right corner travel
    const arbFront = (t0 - t1) * kAntiRollFront;
    const arbRear = (t2 - t3) * kAntiRollRear;
    arbForces[0] = -arbFront;
    arbForces[1] = arbFront;
    arbForces[2] = -arbRear;
    arbForces[3] = arbRear;

    let sumSuspY = 0;
    let sumPitchTorque = 0;
    let sumRollTorque = 0;

    for (let i = 0; i < 4; i++) {
      const c = input.corners[i];
      const tr = travels[i];
      const trVel = state.hubVelY[i] - mountVy[i];

      // Progressive coil spring (preloaded to staticSprungPerCornerN at travel=0)
      const kBase = c.isFront ? kSpringFront : kSpringRear;
      // Progressive bump stop ramps stiffness cleanly past 14cm compression
      const bumpExcess = Math.max(0, tr - 0.14);
      const progForce = bumpExcess * bumpExcess * 420000;
      // Limit strap tension gently pulls chassis down only near full droop
      const droopFactor = tr < -0.22 ? (tr + 0.22) * 18000 : 0;

      const springForce = staticSprungPerCornerN + tr * kBase + progForce + droopFactor;

      // Asymmetric bypass shock absorber (soft bump compression, firmer controlled rebound)
      const damperCoeff = trVel >= 0 ? cBump : cRebound;
      const damperForce = trVel * damperCoeff;

      // Coilover cannot pull strongly upward on chassis once wheel is hanging free unless hitting limit strap
      const rawSusp = springForce + damperForce - arbForces[i];
      const fSusp = Math.max(-2400, Math.min(34000, rawSusp));
      suspForceCorner[i] = fSusp;

      // Tire contact against terrain/rock surface (pre-compensated for static carcass deflection)
      const targetTireTopHubY = input.groundSurfY[i] + input.tireRadiusM + staticTireDeflM;
      const pen = targetTireTopHubY - state.hubWorldY[i];
      let fTireGroundUp = 0;
      if (pen > 0) {
        // Hard rock transmits sharper tire spring than plush sand
        const surfaceTireStiff = kTire * (0.86 + 0.24 * input.onRock[i]);
        const clampedPen = Math.min(0.18, pen);
        fTireGroundUp = Math.max(0, clampedPen * surfaceTireStiff - state.hubVelY[i] * cTire);
        // Elastic tire sidewall flex indicator
        state.tireSquash01[i] = clamp(clampedPen / 0.14, 0, 1);
        state.groundContact01[i] = clamp(pen / 0.028, 0, 1);
      } else {
        state.tireSquash01[i] = 0;
        state.groundContact01[i] = 0;
      }
      state.normalLoadN[i] = Math.min(totalStaticWeightN * 0.9, fTireGroundUp);

      // Step unsprung wheel mass vertically: ground pushes up, gravity & coilover push down
      const wheelNetY = fTireGroundUp - fSusp - wheelM * g;
      state.hubVelY[i] += (wheelNetY / wheelM) * subDt;
      state.hubWorldY[i] += state.hubVelY[i] * subDt;

      // Enforce physical suspension travel & rigid rim floor limits cleanly
      const minRimHubY = targetTireTopHubY - 0.16;
      if (state.hubWorldY[i] < minRimHubY) {
        state.hubWorldY[i] = minRimHubY;
        if (state.hubVelY[i] < 0) state.hubVelY[i] *= -0.15;
      }
      if (state.hubWorldY[i] > mountY[i] + maxBumpM) {
        state.hubWorldY[i] = mountY[i] + maxBumpM;
        if (state.hubVelY[i] > mountVy[i]) state.hubVelY[i] = mountVy[i];
      } else if (state.hubWorldY[i] < mountY[i] + maxDroopM) {
        state.hubWorldY[i] = mountY[i] + maxDroopM;
        if (state.hubVelY[i] < mountVy[i]) state.hubVelY[i] = mountVy[i];
      }

      state.travelM[i] = clamp(state.hubWorldY[i] - mountY[i], maxDroopM, maxBumpM);
      state.travelVelMs[i] = trVel;

      // Subtle dynamic camber from suspension arm arc + cornering sidewall flex
      const dir = c.isLeft ? 1 : -1;
      state.dynamicCamberRad[i] = dir * (-state.travelM[i] * 0.18) - sinR * 0.12;

      sumSuspY += fSusp;
      // Pitch torque: +fSusp at +lz (front) pitches nose UP (-pitchRad)
      sumPitchTorque += -fSusp * c.lz;
      // Roll torque: +fSusp at +lx (left) lifts left UP (+rollRad lean right!)
      sumRollTorque += fSusp * c.lx;
    }

    // Weight-transfer inertial moments from longitudinal acceleration & cornering lateral G
    // Accelerating forward (+longAccel) squats rear & lifts nose (-pitch torque)
    // Braking (-longAccel) dives nose (+pitch torque)
    const pitchInertialTorque = -sprungM * input.longitudinalAccelMs2 * input.comHeightRestM * 0.72;
    // Lateral accel (+latAccel in left turn) leans body right (+roll torque)
    const rollInertialTorque = sprungM * input.lateralAccelMs2 * input.comHeightRestM * 0.62;

    const netBodyY = sumSuspY - sprungM * g;
    state.chassisComVy += (netBodyY / sprungM) * subDt;
    state.chassisComWorldY += state.chassisComVy * subDt;

    // Gentle aerodynamic / chassis floor safety guard (never below skidplate)
    const floorComY = input.avgGroundY + 0.34;
    if (state.chassisComWorldY < floorComY) {
      state.chassisComWorldY = floorComY;
      if (state.chassisComVy < 0) state.chassisComVy = 0;
    }

    // Integrate sprung pitch & roll with realistic viscous shock resistance
    const pitchAcc = (sumPitchTorque + pitchInertialTorque - state.chassisPitchVel * 1550) / pitchInertia;
    const rollAcc = (sumRollTorque + rollInertialTorque - state.chassisRollVel * 1750) / rollInertia;

    state.chassisPitchVel += pitchAcc * subDt;
    state.chassisRollVel += rollAcc * subDt;

    state.chassisPitchRad = clamp(state.chassisPitchRad + state.chassisPitchVel * subDt, -0.45, 0.45);
    state.chassisRollRad = clamp(state.chassisRollRad + state.chassisRollVel * subDt, -0.58, 0.58);
  }
}

export interface TireLateralInput {
  dt: number;
  massKg: number;
  yawInertiaKgM2: number;
  vForwardMs: number;
  vLateralMs: number;
  yawRateRadS: number;
  steerAngleRad: number;
  corners: readonly [
    SuspensionWheelCorner,
    SuspensionWheelCorner,
    SuspensionWheelCorner,
    SuspensionWheelCorner,
  ];
  normalLoadN: readonly [number, number, number, number];
  groundContact01: readonly [number, number, number, number];
  wheelSlipRatio: readonly [number, number, number, number];
  onRock: readonly [number, number, number, number];
  moisture: number;
  tirePressurePsi: number;
  isHandbrake: boolean;
  isLowRange: boolean;
  isRolledOver: boolean;
  rolledWheelAuthority: number;
}

export interface TireLateralOutput {
  vLateralDeltaMs: number;
  yawRateDeltaRadS: number;
  steeringDragForceN: number;
  effectiveLateralGrip: number;
}

/**
 * Evaluates true 4-wheel nonlinear slip-angle tire cornering forces weighted by live
 * dynamic suspension loads (`normalLoadN`), surface friction (sand vs sandstone rock),
 * longitudinal-vs-lateral friction circle saturation, and airborne wheel unloading!
 */
export function evaluateTireCorneringAndYaw(input: TireLateralInput): TireLateralOutput {
  const dt = Math.min(0.05, Math.max(0.001, input.dt));

  if (input.isRolledOver) {
    // Roof/side digging into dunes stalls yaw & scrubs sideways velocity strongly
    return {
      vLateralDeltaMs: -input.vLateralMs * Math.min(1, 4.4 * dt),
      yawRateDeltaRadS: -input.yawRateRadS * Math.min(1, 3.8 * dt),
      steeringDragForceN: 0,
      effectiveLateralGrip: 4.4,
    };
  }

  const absFwd = Math.abs(input.vForwardMs);
  const speed = Math.hypot(input.vForwardMs, input.vLateralMs);
  const psiNormLow = clamp((32 - input.tirePressurePsi) / 20, 0, 1);
  const moisturePenalty = 1.0 - clamp(input.moisture, 0, 1) * 0.22;

  let totalLatForceN = 0;
  let totalYawTorqueNm = 0;
  let totalInducedDragN = 0;

  // Regularized reference longitudinal velocity prevents slip-angle singularity near 0 km/h
  const vxReg = Math.max(2.6, absFwd);

  for (let i = 0; i < 4; i++) {
    const c = input.corners[i];
    const contact = input.groundContact01[i];
    const loadN = input.normalLoadN[i];
    if (contact <= 0.02 || loadN <= 80) continue;

    const steer = c.isFront ? input.steerAngleRad : 0;
    const cosS = Math.cos(steer);
    const sinS = Math.sin(steer);

    // Wheel center velocity in vehicle frame (note: _right points +X left, so turning +yaw moves front toward +X)
    const vwFwd = input.vForwardMs - input.yawRateRadS * c.lx;
    const vwLat = input.vLateralMs + input.yawRateRadS * c.lz;

    // Velocity perpendicular to steered tire heading
    const vTireLat = vwLat * cosS - vwFwd * sinS;
    const slipAngleRad = Math.atan2(vTireLat, vxReg);

    // Off-road friction coefficient + friction circle degradation under wheelspin or locked handbrake
    const rockMu = 1.02 + psiNormLow * 0.18;
    const sandMu = (0.74 + psiNormLow * 0.16) * moisturePenalty * (input.isLowRange ? 1.08 : 1.0);
    let mu = sandMu * (1 - input.onRock[i]) + rockMu * input.onRock[i];

    // Longitudinal spin/handbrake uses up friction circle capacity -> rear steps out naturally!
    const spinUse = clamp(input.wheelSlipRatio[i] * 0.52, 0, 0.72);
    mu *= Math.sqrt(Math.max(0.18, 1.0 - spinUse * spinUse));
    if (input.isHandbrake && !c.isFront) {
      mu *= 0.34;
    }

    // Progressive brush tire cornering curve: slightly firmer rear than front gives realistic,
    // stable pickup-truck handling (mild understeer at limit instead of twitchy snap-oversteer!)
    const corneringStiffness = c.isFront ? 4.4 : 5.8;
    const fTireLat = -mu * loadN * Math.tanh(slipAngleRad * corneringStiffness) * contact;

    const fLatChassis = fTireLat * cosS;
    // Tire lateral normal is (cosS, -sinS) in chassis (X=left, Z=fwd) space:
    // projecting fTireLat onto +Z gives -fTireLat * sinS in BOTH forward and reverse!
    const fFwdChassis = -fTireLat * sinS;

    totalLatForceN += fLatChassis;
    totalInducedDragN += fFwdChassis;
    totalYawTorqueNm += fLatChassis * c.lz;
  }

  // Natural lateral scrub & rotational yaw damping for composed highway & off-road tracking
  const sandSideDragN = -input.vLateralMs * (1850 + absFwd * 75);
  const sandYawDampNm = -input.yawRateRadS * (3600 + speed * 210);

  // Subtle low-speed crawler turn-in assist below ~3.5 m/s so tight rock crawling feels responsive
  let lowSpeedAssistYaw = 0;
  if (absFwd > 0.18 && absFwd < 4.5 && Math.abs(input.steerAngleRad) > 0.02) {
    const blend = 1.0 - clamp((absFwd - 1.5) / 3.0, 0, 1);
    const kinYaw = (input.vForwardMs / 3.45) * Math.tan(input.steerAngleRad);
    lowSpeedAssistYaw = (kinYaw - input.yawRateRadS) * blend * 4.5 * input.rolledWheelAuthority;
  }

  const dvLat = ((totalLatForceN + sandSideDragN) / input.massKg) * dt;
  const dYaw = ((totalYawTorqueNm + sandYawDampNm) / input.yawInertiaKgM2) * dt + lowSpeedAssistYaw * dt;

  // Compute equivalent damping diagnostic
  const equivGrip = Math.abs(input.vLateralMs) > 0.2 ? Math.abs(totalLatForceN / (input.massKg * input.vLateralMs)) : 2.2;

  return {
    vLateralDeltaMs: clamp(dvLat, -14, 14) * input.rolledWheelAuthority,
    yawRateDeltaRadS: clamp(dYaw, -6, 6) * input.rolledWheelAuthority,
    steeringDragForceN: totalInducedDragN,
    effectiveLateralGrip: clamp(equivGrip, 0.5, 6.0),
  };
}

/**
 * Exact 2D rigid-body rotating-frame velocity transformation (full Coriolis invariance):
 * when heading rotates by `dHeading` with zero external horizontal forces, body-frame
 * `(vForward, vLateral)` rotates by `-dHeading` so world linear momentum `(vx, vz)` stays invariant.
 */
export function rotateBodyVelocityByHeadingDelta(
  vForward: number,
  vLateral: number,
  dHeading: number,
): { vForward: number; vLateral: number } {
  const cosD = Math.cos(dHeading);
  const sinD = Math.sin(dHeading);
  return {
    vForward: vForward * cosD + vLateral * sinD,
    vLateral: vLateral * cosD - vForward * sinD,
  };
}

/** Frame-rate independent exponential slerp/lerp factor: `1 - exp(-rate * dt)`. */
export function computeExpSmoothingFactor(ratePerSec: number, dt: number): number {
  return 1 - Math.exp(-Math.max(0, ratePerSec) * Math.max(0, dt));
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
