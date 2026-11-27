/**
 * VehicleCrashPhysics.ts
 * Pure, engine-agnostic 6-DOF rollover physics, BeamNG-style soft-body vertex deformation,
 * 3D bounding-probe ground/rock collision solver, breakaway debris kinematics, and structural
 * damage state machine. (Zero Three.js imports — fully testable in Node).
 */

export type DamageZone = 'front' | 'rear' | 'left' | 'right' | 'roof' | 'underbody';

export type DetachablePartId =
  | 'frontBumper'
  | 'frontGrille'
  | 'rearBumper'
  | 'tailgate'
  | 'hood'
  | 'leftMirror'
  | 'rightMirror'
  | 'leftStep'
  | 'rightStep'
  | 'spareTire'
  | 'roofBoards'
  | 'lightBar';

export interface CrashImpactEvent {
  zone: DamageZone;
  localPointX: number;
  localPointY: number;
  localPointZ: number;
  localNormalX: number;
  localNormalY: number;
  localNormalZ: number;
  worldPointX: number;
  worldPointY: number;
  worldPointZ: number;
  impulseSpeedMs: number;
  severity: number; // 0..1 normalized
  onRock: boolean;
  wheelIndex: number; // 0..3 or -1 if chassis/body
}

export interface WheelDamageState {
  camberRad: number;
  toeRad: number;
  wobbleAmp: number;
  punctured: boolean;
  damage01: number;
}

export interface VehicleDamageState {
  overallIntegrityPct: number;
  zoneIntegrity: Record<DamageZone, number>; // 1.0 = pristine -> 0.0 = crushed
  windshieldCrackLevel: 0 | 1 | 2; // 0=intact, 1=spiderweb, 2=shattered
  sideGlassBroken: [boolean, boolean]; // [left, right] door window cracks
  rearGlassBroken: boolean;
  headlightBroken: [boolean, boolean]; // [left, right]
  taillightBroken: [boolean, boolean]; // [left, right]
  hoodPoppedAngleRad: number;
  hoodTwistRad: number;
  frontBumperSagRad: number;
  detached: Record<DetachablePartId, boolean>;
  wheels: [WheelDamageState, WheelDamageState, WheelDamageState, WheelDamageState];
  // Rivian Quad-Motor EV thermal & drivetrain state
  engineHealth01: number; // 1.0 = full quad-motor authority -> 0.62 min (rear dual motors & armored battery intact!)
  radiatorLeak01: number; // 0.0 = intact -> 0.85 = low-mounted EV thermal chiller breached on catastrophic crush
  coolantTempC: number; // 38C normal EV glycol loop -> 78C+ thermal derate & subtle low chiller mist
  steeringPullRad: number; // persistent alignment drift from bent front tie-rod / potholes
  steeringShakeAmp: number; // cockpit steering wheel tremor amplitude
  wiperDamaged: boolean; // jams wipers mid-windshield after severe front/roof impact
  totalImpacts: number;
}

export interface MechanicalDamageOutput {
  powerScale: number; // 0.72..1.0 quad-motor drive torque multiplier (never stalls on front frunk hit!)
  steamIntensity: number; // 0..0.72 subtle low-bumper EV glycol vapor mist (catastrophic front crush only)
  overheated: boolean; // coolantTempC >= 78
  misfireActive: boolean; // always false on Quad-Motor EV (no front combustion engine!)
  flatTireDrag: number; // extra longitudinal rolling resistance (m/s^2)
  steeringPullRad: number;
  steeringShakeAmp: number;
}

export interface RolloverPhysicsState {
  rollRad: number; // continuous [-PI, PI] (0 = upright, +-PI/2 = on side, +-PI = on roof)
  rollVel: number;
  pitchRad: number; // extra dynamic crash/jump pitch relative to terrain
  pitchVel: number;
  airY: number; // vertical COM offset above equilibrium ground plane (>= 0)
  vy: number;
  isAirborne: boolean;
  isTipping: boolean; // inner wheels lifted (> 14 deg roll)
  isRolledOver: boolean; // |roll| > 62 deg (past recovery / sliding on side or roof)
  rollCount: number; // accumulated half-turns / flips
  maxRollReachedDeg: number;
  lateralG: number;
  tippingFactor: number; // ratio of overturning torque / gravity restoring torque (>1 = tipping!)
  scrapeIntensity: number; // 0..1 continuous roof/body sliding friction for sparks & sand carving
  impactCooldownSec: number; // throttles rapid grind crunches while sliding upside-down
}

export function createInitialDamageState(): VehicleDamageState {
  return {
    overallIntegrityPct: 100,
    zoneIntegrity: {
      front: 1,
      rear: 1,
      left: 1,
      right: 1,
      roof: 1,
      underbody: 1,
    },
    windshieldCrackLevel: 0,
    sideGlassBroken: [false, false],
    rearGlassBroken: false,
    headlightBroken: [false, false],
    taillightBroken: [false, false],
    hoodPoppedAngleRad: 0,
    hoodTwistRad: 0,
    frontBumperSagRad: 0,
    detached: {
      frontBumper: false,
      frontGrille: false,
      rearBumper: false,
      tailgate: false,
      hood: false,
      leftMirror: false,
      rightMirror: false,
      leftStep: false,
      rightStep: false,
      spareTire: false,
      roofBoards: false,
      lightBar: false,
    },
    wheels: [
      { camberRad: 0, toeRad: 0, wobbleAmp: 0, punctured: false, damage01: 0 },
      { camberRad: 0, toeRad: 0, wobbleAmp: 0, punctured: false, damage01: 0 },
      { camberRad: 0, toeRad: 0, wobbleAmp: 0, punctured: false, damage01: 0 },
      { camberRad: 0, toeRad: 0, wobbleAmp: 0, punctured: false, damage01: 0 },
    ],
    engineHealth01: 1,
    radiatorLeak01: 0,
    coolantTempC: 38,
    steeringPullRad: 0,
    steeringShakeAmp: 0,
    wiperDamaged: false,
    totalImpacts: 0,
  };
}

export function createInitialRolloverState(): RolloverPhysicsState {
  return {
    rollRad: 0,
    rollVel: 0,
    pitchRad: 0,
    pitchVel: 0,
    airY: 0,
    vy: 0,
    isAirborne: false,
    isTipping: false,
    isRolledOver: false,
    rollCount: 0,
    maxRollReachedDeg: 0,
    lateralG: 0,
    tippingFactor: 0,
    scrapeIntensity: 0,
    impactCooldownSec: 0,
  };
}

export function wrapAngleRad(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Rotates a vehicle-local XZ vector (`+X` left, `+Z` forward) into world XZ space
 * using the vehicle yaw heading (`fwd = (sinH, cosH)`, `left = (cosH, -sinH)`).
 */
export function localVectorXZToWorld(
  localX: number,
  localZ: number,
  headingRad: number,
): { worldX: number; worldZ: number } {
  const cosH = Math.cos(headingRad);
  const sinH = Math.sin(headingRad);
  return {
    worldX: localX * cosH + localZ * sinH,
    worldZ: -localX * sinH + localZ * cosH,
  };
}

export interface LateralRollInput {
  dt: number;
  vForwardMs: number;
  vLateralMs: number;
  yawRateRadS: number;
  steerAngleRad: number;
  terrainRollSlopeRad: number;
  terrainPitchSlopeRad: number;
  tirePressurePsi: number;
  avgOnRock: number;
  trackHalf: number;
  cgHeight: number;
  isHandbrake: boolean;
}

const _rolloverProbes: Array<{ lx: number; ly: number; lz: number; zone: DamageZone; wheelIdx: number }> = [
  // 4 tire bottoms (y=0)
  { lx: 1.02, ly: 0.0, lz: 1.59, zone: 'left', wheelIdx: 0 },
  { lx: -1.02, ly: 0.0, lz: 1.59, zone: 'right', wheelIdx: 1 },
  { lx: 1.02, ly: 0.0, lz: -1.59, zone: 'left', wheelIdx: 2 },
  { lx: -1.02, ly: 0.0, lz: -1.59, zone: 'right', wheelIdx: 3 },
  // 8 upper body corners (hood front L/R, roof L/R, bed rear L/R)
  { lx: 0.88, ly: 1.30, lz: 2.38, zone: 'front', wheelIdx: -1 },
  { lx: -0.88, ly: 1.30, lz: 2.38, zone: 'front', wheelIdx: -1 },
  { lx: 0.78, ly: 2.12, lz: 0.65, zone: 'roof', wheelIdx: -1 },
  { lx: -0.78, ly: 2.12, lz: 0.65, zone: 'roof', wheelIdx: -1 },
  { lx: 0.80, ly: 2.12, lz: -0.35, zone: 'roof', wheelIdx: -1 },
  { lx: -0.80, ly: 2.12, lz: -0.35, zone: 'roof', wheelIdx: -1 },
  { lx: 0.94, ly: 1.32, lz: -2.50, zone: 'rear', wheelIdx: -1 },
  { lx: -0.94, ly: 1.32, lz: -2.50, zone: 'rear', wheelIdx: -1 },
];

/**
 * Evaluates realistic rollover physics based on Static Stability Factor (trackHalf / cgHeight),
 * centrifugal cornering acceleration, sand-rut side-slide tripping torque, and 360-deg rigid-body tumble.
 */
export function stepRolloverDynamics(
  state: RolloverPhysicsState,
  input: LateralRollInput,
  groundYBelowCenter: number,
  sampleCornerSurfaceY: (lx: number, lz: number) => { height: number; onRock: number },
  onImpact: (ev: CrashImpactEvent) => void,
  worldCenter: { x: number; y: number; z: number; sinH: number; cosH: number },
): void {
  const dt = Math.min(0.033, Math.max(0.001, input.dt));
  const g = 9.81;
  const speed = Math.hypot(input.vForwardMs, input.vLateralMs);

  // 1. Centripetal + lateral slide-trip acceleration
  // Positive yawRate turns left -> centrifugal pushes body right (+roll or -roll depending on sign).
  // In VehicleRig: _right = (cosH, 0, -sinH) which points LEFT of +fwd=(sinH, 0, cosH)?
  // Wait: cross(+fwd=(0,0,1), +up=(0,1,0)) = (-1,0,0). Let's match VehicleRig's right vector:
  // In VehicleRig: _right = (cosH, 0, -sinH), so at heading=0, _fwd=(0,0,1), _right=(1,0,0) (left side is +X).
  // Turning LEFT increases heading (yawRate > 0), swinging nose toward +X -> inertia throws body toward -X -> right side drops (+Z rot in Three.js rotates +Y toward -X, i.e., negative or positive?).
  // In Three.js right-handed coords: rotating +Z by +theta moves +X toward +Y and +Y toward -X! So +roll leans RIGHT (-X).
  // Turning LEFT (+yawRate) leans body RIGHT -> +roll!
  const centripetalAcc = input.vForwardMs * input.yawRateRadS;
  const sideSlide = input.vLateralMs;
  const psiStiffness = 0.72 + ((Math.max(10, Math.min(36, input.tirePressurePsi)) - 10) / 26) * 0.58;

  // When drifting fast sideways in sand/berms or snapping steering at speed, tires dig in & trip!
  const lateralTripCoeff =
    (Math.abs(sideSlide) > 3.0 ? 0.44 * psiStiffness : 0.08) +
    (input.isHandbrake ? 0.16 : 0.0) +
    input.avgOnRock * 0.2;
  // True physical centripetal acceleration + sand-rut trip moment on heavy side-slides
  const effectiveLatAcc = centripetalAcc * 1.06 - sideSlide * lateralTripCoeff * Math.min(2.0, speed / 8.5);
  state.lateralG = effectiveLatAcc / g;

  // Static Stability Factor: tan(tipAngle) = trackHalf / cgHeight
  const ssf = input.trackHalf / Math.max(0.45, input.cgHeight);
  const absRoll = Math.abs(state.rollRad);
  state.tippingFactor = Math.abs(effectiveLatAcc) / (g * Math.max(0.22, ssf));

  // 2. Angular roll acceleration
  // Continuous torque curve: anti-roll bar stiffness up to wheel lift-off (~15 deg), then
  // gravity lever arm shrinks cleanly toward balance point (~47 deg) before inverting into full barrel roll!
  const prevRoll = state.rollRad;
  const cosR = Math.cos(state.rollRad);
  const ssfAngle = Math.atan2(input.trackHalf, input.cgHeight); // ~0.82 rad (47 deg)
  const liftAngle = 0.26; // ~15 deg inside-wheel lift threshold
  const peakRestore = (g / input.cgHeight) * 1.18; // ~12.3 rad/s^2 restoring ceiling

  if (absRoll < ssfAngle && !state.isRolledOver) {
    // Wide Trophy Truck stance + loose sand lateral scrub scales lateral force into body roll moment
    const snapBoost = Math.abs(input.steerAngleRad) > 0.36 || input.isHandbrake ? 1.18 : 1.0;
    const turnTorque = (effectiveLatAcc / input.cgHeight) * cosR * 0.54 * snapBoost;
    const targetRest = -input.terrainRollSlopeRad * 0.16;
    const relRoll = state.rollRad - targetRest;
    const absRel = Math.abs(relRoll);
    const dir = Math.sign(relRoll || 1);

    let restoreTorque = 0;
    if (absRel <= liftAngle) {
      restoreTorque = -(relRoll / liftAngle) * peakRestore;
    } else {
      const remain = Math.max(0, Math.sin(ssfAngle - absRel) / Math.max(0.08, Math.sin(ssfAngle - liftAngle)));
      restoreTorque = -dir * peakRestore * remain;
    }

    const damping = absRel < liftAngle ? 4.8 : 1.35;
    const rollAcc = turnTorque + restoreTorque - state.rollVel * damping;
    state.rollVel += rollAcc * dt;
  } else {
    // Past ~47 deg balance point or already rolling: real rigid-body tumble + roof/side equilibrium
    const roofRestore =
      Math.abs(absRoll - Math.PI) < 0.55
        ? Math.sin(Math.PI - absRoll) * (state.rollRad >= 0 ? 1 : -1) * 4.5
        : 0;
    const sideGravity =
      Math.abs(absRoll - Math.PI) >= 0.55
        ? Math.sign(state.rollRad) * Math.sin(Math.max(0.15, absRoll - ssfAngle * 0.85)) * 10.5
        : 0;
    state.rollVel += (sideGravity + roofRestore - state.rollVel * 0.42) * dt;
  }

  state.rollRad = wrapAngleRad(state.rollRad + state.rollVel * dt);

  // Track cumulative half-flips when crossing +-PI/2 or +-PI
  const deltaRoll = wrapAngleRad(state.rollRad - prevRoll);
  if (Math.abs(state.rollRad) > 1.35 && Math.abs(prevRoll) <= 1.35) {
    state.rollCount += 1;
  }
  state.maxRollReachedDeg = Math.max(state.maxRollReachedDeg, Math.abs((state.rollRad * 180) / Math.PI));

  // 3. Vertical heave / bounce & pitch dynamics
  state.vy -= g * dt;
  state.airY += state.vy * dt;

  // Pitch damping & gravity stabilization
  const targetPitch = -input.terrainPitchSlopeRad * 0.12;
  if (!state.isRolledOver && absRoll < 0.65) {
    state.pitchVel += ((targetPitch - state.pitchRad) * 16.0 - state.pitchVel * 4.2) * dt;
  } else {
    state.pitchVel += (-state.pitchRad * 6.0 - state.pitchVel * 1.8) * dt;
  }
  state.pitchRad = Math.max(-1.35, Math.min(1.35, state.pitchRad + state.pitchVel * dt));

  // 4. 3D Structural Bounding Probes (check roof rack, cab pillars, hood, bed rails, wheels against surface!)
  // Local truck dimensions relative to ground-level axle origin (y=0 at bottom of upright tires):
  // Wheel hubs at y=0.48 (bottom at y=0), Hood front at z=2.38, y=1.28, Cab roof at y=2.12, z=0.30, Bed tail at z=-2.54, y=1.32
  const absR = Math.abs(state.rollRad);
  const cosRoll = Math.cos(state.rollRad);
  const sinRoll = Math.sin(state.rollRad);
  const cosPitch = Math.cos(state.pitchRad);
  const sinPitch = Math.sin(state.pitchRad);

  // Approximate rigid body pivot height at COM (0.94m) when rolling so tires lift & roof drops cleanly!
  const pivotH = 0.94;
  // Minimum world-Y offset produced by rotating the truck silhouette around COM(0, pivotH, 0)
  let deepestPenetration = 0;
  let worstProbe: {
    lx: number;
    ly: number;
    lz: number;
    wx: number;
    wy: number;
    wz: number;
    onRock: number;
    surfY: number;
    zone: DamageZone;
    wheelIdx: number;
  } | null = null;

  // Update trackHalf on the 4 pre-allocated tire probe entries (zero per-frame heap allocs)
  _rolloverProbes[0].lx = input.trackHalf;
  _rolloverProbes[1].lx = -input.trackHalf;
  _rolloverProbes[2].lx = input.trackHalf;
  _rolloverProbes[3].lx = -input.trackHalf;

  const { x: cx, z: cz, sinH, cosH } = worldCenter;
  const basePivotWorldY = groundYBelowCenter + pivotH + state.airY;

  for (let i = 0; i < _rolloverProbes.length; i++) {
    const p = _rolloverProbes[i];
    const rx0 = p.lx;
    const ry0 = p.ly - pivotH;
    const rz0 = p.lz;

    // Apply roll around Z then pitch around X
    const rx1 = rx0 * cosRoll - ry0 * sinRoll;
    const ry1 = rx0 * sinRoll + ry0 * cosRoll;
    const ry2 = ry1 * cosPitch - rz0 * sinPitch;
    const rz2 = ry1 * sinPitch + rz0 * cosPitch;

    const wx = cx + cosH * rx1 + sinH * rz2;
    const wz = cz - sinH * rx1 + cosH * rz2;
    const wy = basePivotWorldY + ry2;

    const surf = sampleCornerSurfaceY(rx1, rz2);
    const pen = surf.height - wy;
    if (pen > deepestPenetration) {
      deepestPenetration = pen;
      worstProbe = {
        lx: p.lx,
        ly: p.ly,
        lz: p.lz,
        wx,
        wy,
        wz,
        onRock: surf.onRock,
        surfY: surf.height,
        zone: p.zone,
        wheelIdx: p.wheelIdx,
      };
    }
  }

  state.impactCooldownSec = Math.max(0, state.impactCooldownSec - dt);

  let totalScrape = 0;
  if (deepestPenetration > 0 && worstProbe) {
    state.airY += deepestPenetration;
    const ry0 = worstProbe.ly - pivotH;
    const leverX = worstProbe.lx * cosRoll - ry0 * sinRoll;
    const ry1 = worstProbe.lx * sinRoll + ry0 * cosRoll;
    // Exact derivative of ry2 = ry1 * cosPitch - lz * sinPitch:
    // d(ry2)/dt = (leverX * rollVel) * cosPitch - (lz * cosPitch + ry1 * sinPitch) * pitchVel
    // +pitchVel pitches front (+lz) DOWN (-Y), so its vertical velocity contribution is NEGATIVE.
    const leverZ = worstProbe.lz * cosPitch + ry1 * sinPitch;
    const probeHitVy =
      state.vy +
      state.rollVel * leverX * cosPitch -
      state.pitchVel * leverZ * 0.45;
    const impactDownSpeed = Math.max(0, -probeHitVy);

    // Restitution: bouncy on rocks/sides, softer thud on sand
    const isBodyProbe = worstProbe.wheelIdx === -1;
    const restitution = isBodyProbe ? (worstProbe.onRock > 0.3 ? 0.34 : 0.22) : 0.14;

    if (state.vy < 0) {
      state.vy = impactDownSpeed > 1.25 ? impactDownSpeed * restitution : 0;
    }

    // Angular contact torque when a side/roof corner hits the ground (causes realistic tumble!)
    if (isBodyProbe) {
      const sideSign = worstProbe.lx >= 0 ? 1 : -1;
      const slideContribution = Math.min(1, speed / 9.0);
      totalScrape = Math.max(totalScrape, slideContribution * 0.85 + Math.min(0.4, Math.abs(state.rollVel) * 0.12));

      // Ground reaction torque pushes the penetrating corner UP (+leverX * F_up), rebounding & damping tumble
      const bounceRollImpulse = Math.sign(leverX || sideSign) * Math.min(2.6, impactDownSpeed * 0.28);
      state.rollVel = state.rollVel * 0.78 + bounceRollImpulse;
      if (Math.abs(leverZ) > 0.6) {
        // Upward ground reaction on front (+leverZ) pitches nose UP (-pitchVel)
        state.pitchVel += -Math.sign(leverZ) * Math.min(1.8, impactDownSpeed * 0.22);
      }

      // Emit realistic deformation crash impact when body slams or grinds at speed into sand/rocks
      const tangentialSlam = absR > 0.78 && speed > 4.0 ? speed * 0.36 : 0;
      const effSlamSpeed = Math.max(impactDownSpeed, tangentialSlam);
      const hardHit = impactDownSpeed > 0.92;
      const grindCrunch = deepestPenetration > 0.004 && absR > 0.78 && speed > 4.5 && state.impactCooldownSec <= 0;

      if ((hardHit && state.impactCooldownSec <= 0.06) || grindCrunch) {
        state.impactCooldownSec = 0.16;
        const zone = absR > 2.10 ? 'roof' : worstProbe.zone;
        onImpact({
          zone,
          localPointX: worstProbe.lx,
          localPointY: worstProbe.ly,
          localPointZ: worstProbe.lz,
          localNormalX: -Math.sin(state.rollRad),
          localNormalY: -Math.cos(state.rollRad),
          localNormalZ: worstProbe.lz > 1.5 ? -0.4 : worstProbe.lz < -1.5 ? 0.4 : 0,
          worldPointX: worstProbe.wx,
          worldPointY: worstProbe.surfY,
          worldPointZ: worstProbe.wz,
          impulseSpeedMs: effSlamSpeed,
          severity: Math.min(1.0, Math.max(0.22, (effSlamSpeed - 1.2) / 12.0)),
          onRock: worstProbe.onRock > 0.35,
          wheelIndex: worstProbe.wheelIdx,
        });
      }
    } else if (impactDownSpeed > 3.6) {
      // Heavy wheel landing / slam
      onImpact({
        zone: worstProbe.zone,
        localPointX: worstProbe.lx,
        localPointY: 0.48,
        localPointZ: worstProbe.lz,
        localNormalX: worstProbe.lx > 0 ? -0.5 : 0.5,
        localNormalY: 0.85,
        localNormalZ: 0,
        worldPointX: worstProbe.wx,
        worldPointY: worstProbe.surfY,
        worldPointZ: worstProbe.wz,
        impulseSpeedMs: impactDownSpeed,
        severity: Math.min(1.0, (impactDownSpeed - 3.2) / 12.0),
        onRock: worstProbe.onRock > 0.35,
        wheelIndex: worstProbe.wheelIdx,
      });
    }
  } else if (absR > 1.15 && speed > 6.5 && state.impactCooldownSec <= 0) {
    // High-speed continuous side/roof slide grinding across desert dunes
    state.impactCooldownSec = 0.22;
    const rollSign = state.rollRad >= 0 ? 1 : -1;
    const onRoof = absR > 2.15;
    onImpact({
      zone: onRoof ? 'roof' : rollSign > 0 ? 'right' : 'left',
      localPointX: onRoof ? 0 : -rollSign * 0.92,
      localPointY: onRoof ? 2.10 : 1.35,
      localPointZ: 0.35,
      localNormalX: -Math.sin(state.rollRad),
      localNormalY: -Math.cos(state.rollRad),
      localNormalZ: 0,
      worldPointX: cx,
      worldPointY: groundYBelowCenter + 0.35,
      worldPointZ: cz,
      impulseSpeedMs: Math.min(12, speed * 0.34),
      severity: Math.min(0.85, speed / 22.0),
      onRock: input.avgOnRock > 0.3,
      wheelIndex: -1,
    });
  }

  // Clamp airY never negative
  if (state.airY < 0) state.airY = 0;

  // Settle cleanly if upright & low bounce
  if (absR < 0.28 && state.airY < 0.015 && Math.abs(state.vy) < 0.35) {
    state.airY = 0;
    state.vy = 0;
  }

  state.isAirborne = state.airY > 0.14;
  state.isTipping = absR > 0.24 && absR < 1.08;
  state.isRolledOver = absR >= 1.08; // >= 62 deg: on side or roof!
  state.scrapeIntensity = state.isRolledOver ? Math.max(totalScrape, Math.min(1, speed / 8.0)) : totalScrape;
}

/**
 * Classifies a local-space impact point on the truck into its structural zone.
 */
export function classifyImpactZone(lx: number, ly: number, lz: number): DamageZone {
  if (ly > 1.72) return 'roof';
  if (lz > 1.35) return 'front';
  if (lz < -1.35) return 'rear';
  if (lx >= 0) return 'left';
  return 'right';
}

/**
 * Updates structural health, shattered windows, popped hood, detached flying parts,
 * and bent wheel camber/toe/wobble from a crash impulse event.
 * Returns newly detached part IDs & whether glass cracked on this exact impact.
 */
export function applyImpactToDamageState(
  dmg: VehicleDamageState,
  ev: CrashImpactEvent,
): {
  newlyDetached: DetachablePartId[];
  glassCrackedNow: boolean;
  metalImpactSeverity: number;
} {
  const newlyDetached: DetachablePartId[] = [];
  let glassCrackedNow = false;

  // Ignore micro-taps below ~1.6 m/s (~6 km/h)
  if (ev.impulseSpeedMs < 1.6) {
    return { newlyDetached, glassCrackedNow, metalImpactSeverity: 0 };
  }

  dmg.totalImpacts += 1;
  const rockMult = ev.onRock ? 1.35 : 1.0;
  const rawDmg = Math.min(0.62, ((ev.impulseSpeedMs - 1.5) / 18.0) * rockMult);
  const sev = Math.min(1, Math.max(0.08, rawDmg * 1.65));

  dmg.zoneIntegrity[ev.zone] = Math.max(0, dmg.zoneIntegrity[ev.zone] - rawDmg);

  // Front crashes crush the sacrificial Rivian R1T EV frunk crumple zone, smash impacted lamps/DRLs,
  // buckle & twist the aluminum hood, and sag/detach the front bumper — WITHOUT breaking down a
  // non-existent front combustion engine!
  if (ev.zone === 'front') {
    if (ev.localPointX >= -0.15 && rawDmg > 0.11) dmg.headlightBroken[0] = true;
    if (ev.localPointX <= 0.15 && rawDmg > 0.11) dmg.headlightBroken[1] = true;
    if (Math.abs(ev.localPointX) < 0.42 && rawDmg > 0.24) {
      dmg.headlightBroken[0] = true;
      dmg.headlightBroken[1] = true;
    }

    // Rivian R1T EV architecture: empty front frunk + extruded aluminum crush cans absorb light &
    // moderate frontal impacts completely! Only catastrophic repeated front crushes (integrity < 0.38)
    // breach the low-mounted EV thermal chiller loop & gently derate front-axle drive power while
    // the dual rear motors & armored skateboard battery keep strong >=72% drive authority.
    if (dmg.zoneIntegrity.front < 0.38 && rawDmg > 0.12) {
      const deepPenetration = Math.min(1, (0.38 - dmg.zoneIntegrity.front) / 0.38);
      dmg.radiatorLeak01 = Math.min(0.85, dmg.radiatorLeak01 + rawDmg * (0.45 + deepPenetration * 0.75));
      dmg.engineHealth01 = Math.max(0.62, dmg.engineHealth01 - rawDmg * (0.24 + deepPenetration * 0.26));
      if (dmg.radiatorLeak01 > 0.22) {
        dmg.coolantTempC = Math.min(92, dmg.coolantTempC + rawDmg * 24);
      }
    }

    // Off-center front slam bends tie-rod & induces subtle steering pull + steering wheel shake
    if (rawDmg > 0.18) {
      const pullDir = ev.localPointX >= 0 ? 1 : -1;
      dmg.steeringPullRad = Math.max(
        -0.12,
        Math.min(0.12, dmg.steeringPullRad + pullDir * rawDmg * 0.09),
      );
      dmg.steeringShakeAmp = Math.min(0.14, dmg.steeringShakeAmp + rawDmg * 0.11);
    }

    // Realistic buckled hood latch: slightly ajar & twisted toward impact side (NEVER cleanly popped wide open like a demo!)
    if (dmg.zoneIntegrity.front < 0.88 && !dmg.detached.hood) {
      const frontCrush = 1 - dmg.zoneIntegrity.front;
      // 0.04..0.15 rad on moderate hit -> up to 0.24 rad on heavy smash
      dmg.hoodPoppedAngleRad = Math.min(0.24, 0.03 + frontCrush * 0.27);
      const twistSign = ev.localPointX >= 0 ? -1 : 1;
      const targetTwist = twistSign * Math.min(0.085, frontCrush * 0.105);
      dmg.hoodTwistRad = Math.max(-0.09, Math.min(0.09, dmg.hoodTwistRad * 0.45 + targetTwist * 0.75));
    }

    // Front bumper droops/twists visibly on moderate impact before tearing off on heavy crush
    if (dmg.zoneIntegrity.front < 0.88 && !dmg.detached.frontBumper) {
      const frontCrush = 1 - dmg.zoneIntegrity.front;
      const sagSign = ev.localPointX >= 0 ? 1 : -1;
      dmg.frontBumperSagRad = Math.max(
        -0.09,
        Math.min(0.09, dmg.frontBumperSagRad * 0.5 + sagSign * frontCrush * 0.11),
      );
    }
    if (dmg.zoneIntegrity.front < 0.36 && !dmg.detached.frontBumper) {
      dmg.detached.frontBumper = true;
      newlyDetached.push('frontBumper');
    }
    if (dmg.zoneIntegrity.front < 0.30 && !dmg.detached.frontGrille) {
      dmg.detached.frontGrille = true;
      newlyDetached.push('frontGrille');
    }
    if (dmg.zoneIntegrity.front < 0.24 && !dmg.detached.hood) {
      dmg.detached.hood = true;
      newlyDetached.push('hood');
    }
    if (dmg.zoneIntegrity.front < 0.62 && dmg.windshieldCrackLevel < 1) {
      dmg.windshieldCrackLevel = 1;
      glassCrackedNow = true;
    } else if (dmg.zoneIntegrity.front < 0.34 && dmg.windshieldCrackLevel < 2) {
      dmg.windshieldCrackLevel = 2;
      glassCrackedNow = true;
    }
    if (dmg.zoneIntegrity.front < 0.30) {
      dmg.wiperDamaged = true;
    }
  }

  // Rear crashes damage tail lamps, rear bumper, tailgate & spare tire mount
  if (ev.zone === 'rear') {
    if (ev.localPointX >= -0.2 && rawDmg > 0.15) dmg.taillightBroken[0] = true;
    if (ev.localPointX <= 0.2 && rawDmg > 0.15) dmg.taillightBroken[1] = true;
    if (dmg.zoneIntegrity.rear < 0.65 && !dmg.detached.rearBumper) {
      dmg.detached.rearBumper = true;
      newlyDetached.push('rearBumper');
    }
    if (dmg.zoneIntegrity.rear < 0.48 && !dmg.detached.tailgate) {
      dmg.detached.tailgate = true;
      newlyDetached.push('tailgate');
    }
    if (dmg.zoneIntegrity.rear < 0.44 && !dmg.detached.spareTire) {
      dmg.detached.spareTire = true;
      newlyDetached.push('spareTire');
    }
  }

  // Side crashes rip wing mirrors, running board side steps, crack door windows & bend alignment
  if (ev.zone === 'left') {
    if (dmg.zoneIntegrity.left < 0.80 && !dmg.detached.leftMirror) {
      dmg.detached.leftMirror = true;
      newlyDetached.push('leftMirror');
    }
    if (dmg.zoneIntegrity.left < 0.56 && !dmg.detached.leftStep) {
      dmg.detached.leftStep = true;
      newlyDetached.push('leftStep');
    }
    if (dmg.zoneIntegrity.left < 0.64 && !dmg.sideGlassBroken[0]) {
      dmg.sideGlassBroken[0] = true;
      glassCrackedNow = true;
    }
    if (rawDmg > 0.18) {
      dmg.steeringPullRad = Math.min(0.14, dmg.steeringPullRad + rawDmg * 0.08);
      dmg.steeringShakeAmp = Math.min(0.16, dmg.steeringShakeAmp + rawDmg * 0.10);
    }
  }
  if (ev.zone === 'right') {
    if (dmg.zoneIntegrity.right < 0.80 && !dmg.detached.rightMirror) {
      dmg.detached.rightMirror = true;
      newlyDetached.push('rightMirror');
    }
    if (dmg.zoneIntegrity.right < 0.56 && !dmg.detached.rightStep) {
      dmg.detached.rightStep = true;
      newlyDetached.push('rightStep');
    }
    if (dmg.zoneIntegrity.right < 0.64 && !dmg.sideGlassBroken[1]) {
      dmg.sideGlassBroken[1] = true;
      glassCrackedNow = true;
    }
    if (rawDmg > 0.18) {
      dmg.steeringPullRad = Math.max(-0.14, dmg.steeringPullRad - rawDmg * 0.08);
      dmg.steeringShakeAmp = Math.min(0.16, dmg.steeringShakeAmp + rawDmg * 0.10);
    }
  }

  // Roof / rollover impacts shatter windshield, crack side windows, jam wipers, rip lightbar & roof boards
  if (ev.zone === 'roof') {
    if (dmg.windshieldCrackLevel < 2) {
      dmg.windshieldCrackLevel = rawDmg > 0.22 || dmg.zoneIntegrity.roof < 0.58 ? 2 : 1;
      glassCrackedNow = true;
    }
    if (dmg.zoneIntegrity.roof < 0.78 && !dmg.rearGlassBroken) {
      dmg.rearGlassBroken = true;
      glassCrackedNow = true;
    }
    if (dmg.zoneIntegrity.roof < 0.55) {
      if (!dmg.sideGlassBroken[0] || !dmg.sideGlassBroken[1]) {
        dmg.sideGlassBroken[0] = true;
        dmg.sideGlassBroken[1] = true;
        glassCrackedNow = true;
      }
      dmg.wiperDamaged = true;
    }
    if (dmg.zoneIntegrity.roof < 0.70 && !dmg.detached.lightBar) {
      dmg.detached.lightBar = true;
      newlyDetached.push('lightBar');
    }
    if (dmg.zoneIntegrity.roof < 0.52 && !dmg.detached.roofBoards) {
      dmg.detached.roofBoards = true;
      newlyDetached.push('roofBoards');
    }
  }

  // Wheel / suspension corner bending (camber + toe + rim wobble + flat tire puncture)
  if (ev.wheelIndex >= 0 && ev.wheelIndex < 4 && rawDmg > 0.12) {
    const w = dmg.wheels[ev.wheelIndex];
    const isLeft = ev.wheelIndex === 0 || ev.wheelIndex === 2;
    w.damage01 = Math.min(1, w.damage01 + rawDmg * 1.15);
    const dir = isLeft ? 1 : -1;
    w.camberRad = dir * Math.min(0.24, w.damage01 * 0.22);
    w.toeRad = dir * Math.min(0.16, w.damage01 * 0.14);
    w.wobbleAmp = Math.min(0.12, w.damage01 * 0.10);
    if (ev.wheelIndex < 2) {
      dmg.steeringPullRad = Math.max(
        -0.14,
        Math.min(0.14, dmg.steeringPullRad + dir * rawDmg * 0.09),
      );
      dmg.steeringShakeAmp = Math.min(0.16, dmg.steeringShakeAmp + rawDmg * 0.12);
    }
    if (w.damage01 > 0.75) {
      w.punctured = true;
    }
  }

  // Recompute weighted overall structural integrity percentage
  const z = dmg.zoneIntegrity;
  const weighted =
    z.front * 0.24 + z.roof * 0.22 + z.left * 0.18 + z.right * 0.18 + z.rear * 0.18;
  dmg.overallIntegrityPct = Math.max(0, Math.min(100, Math.round(weighted * 100)));

  return {
    newlyDetached,
    glassCrackedNow,
    metalImpactSeverity: sev,
  };
}

/**
 * Pure per-frame mechanical degradation solver:
 *  - Advances coolant temperature when radiator is leaking and engine is under load
 *  - Computes billowing hood steam intensity, overheat power derate, V8 misfire flag,
 *    flat tire rolling drag, and bent-axle steering pull/shake
 */
export function stepMechanicalDamage(
  dmg: VehicleDamageState,
  dt: number,
  speedMs: number,
  throttleAbs: number,
): MechanicalDamageOutput {
  const safeDt = Math.max(0, Math.min(0.05, dt));
  const absSpeed = Math.abs(speedMs);

  // Rivian EV glycol thermal loop: normal operating equilibrium = 38°C.
  // Only heats up if the low-mounted front chiller was ruptured by a catastrophic front-end crush.
  if (dmg.radiatorLeak01 > 0.08) {
    const heatRate =
      (1.8 + 9.5 * Math.max(0, Math.min(1, throttleAbs)) + absSpeed * 0.12) * dmg.radiatorLeak01;
    const coolRate = (dmg.coolantTempC - 38) * 0.07;
    dmg.coolantTempC = Math.max(38, Math.min(94, dmg.coolantTempC + (heatRate - coolRate) * safeDt));
  } else if (dmg.coolantTempC > 38) {
    dmg.coolantTempC = Math.max(38, dmg.coolantTempC - 5.5 * safeDt);
  }

  const overheated = dmg.coolantTempC >= 78;
  // Quad-Motor EV has no combustion engine — never stalls or misfires!
  const misfireActive = false;

  // Subtle low-bumper EV glycol vapor mist ONLY when low chiller is genuinely breached
  const tempMist = Math.max(0, Math.min(1, (dmg.coolantTempC - 56) / 30));
  const steamIntensity =
    dmg.radiatorLeak01 > 0.12
      ? Math.min(0.72, Math.max(tempMist * 0.65, dmg.radiatorLeak01 * 0.42))
      : 0.0;

  // Dual rear electric motors + armored underfloor battery always preserve >=72% drive authority
  const driveScale = 0.78 + 0.22 * Math.max(0, Math.min(1, dmg.engineHealth01));
  const heatScale = overheated ? Math.max(0.86, 1.0 - ((dmg.coolantTempC - 78) / 16) * 0.14) : 1.0;
  const powerScale = Math.max(0.72, Math.min(1.0, driveScale * heatScale));

  // Count punctured tires -> extra rolling drag + steering pull/tremor
  let puncturedCount = 0;
  let flatPull = 0;
  let maxWobble = 0;
  for (let i = 0; i < 4; i++) {
    const w = dmg.wheels[i];
    maxWobble = Math.max(maxWobble, w.wobbleAmp);
    if (w.punctured) {
      puncturedCount++;
      const isLeft = i === 0 || i === 2;
      flatPull += isLeft ? 0.055 : -0.055;
    }
  }

  const flatTireDrag = puncturedCount * 1.45;
  const steeringPullRad = Math.max(-0.18, Math.min(0.18, dmg.steeringPullRad + flatPull));
  const steeringShakeAmp = Math.min(0.22, dmg.steeringShakeAmp + maxWobble * 0.8 + puncturedCount * 0.035);

  return {
    powerScale,
    steamIntensity,
    overheated,
    misfireActive,
    flatTireDrag,
    steeringPullRad,
    steeringShakeAmp,
  };
}

/**
 * Evaluates high-speed pothole slam suspension & tire wear on the rainy rural highway.
 * Returns true if the impact caused measurable alignment wear or punctured a tire.
 */
export function applyPotholeSuspensionImpact(
  dmg: VehicleDamageState,
  wheelIndex: number,
  speedMs: number,
  potholeDepthM: number,
): boolean {
  if (wheelIndex < 0 || wheelIndex > 3) return false;
  if (speedMs < 15.0 || potholeDepthM < 0.075) return false;

  const intensity = Math.min(1, ((speedMs - 14.0) / 22.0) * (potholeDepthM / 0.14));
  if (intensity < 0.08) return false;

  const w = dmg.wheels[wheelIndex];
  const isLeft = wheelIndex === 0 || wheelIndex === 2;
  const dir = isLeft ? 1 : -1;

  w.damage01 = Math.min(1, w.damage01 + intensity * 0.24);
  w.camberRad = dir * Math.min(0.22, w.damage01 * 0.18);
  w.toeRad = dir * Math.min(0.14, w.damage01 * 0.11);
  w.wobbleAmp = Math.min(0.12, w.damage01 * 0.09);

  if (wheelIndex < 2) {
    dmg.steeringPullRad = Math.max(
      -0.14,
      Math.min(0.14, dmg.steeringPullRad + dir * intensity * 0.03),
    );
    dmg.steeringShakeAmp = Math.min(0.16, dmg.steeringShakeAmp + intensity * 0.045);
  }
  if (w.damage01 > 0.78) {
    w.punctured = true;
  }

  dmg.zoneIntegrity.underbody = Math.max(0.2, dmg.zoneIntegrity.underbody - intensity * 0.06);
  dmg.totalImpacts += 1;
  return true;
}

export interface DeformMeshBounds {
  /** Minimum reinforced inner core radius/box so crumpled sheet metal stops cleanly on roll-cage/chassis */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * BeamNG-inspired real-time plastic vertex deformation on a subdivided BufferGeometry!
 *
 * Applies smooth quartic-falloff directional denting in vehicle-local space PLUS subtle
 * sheet-metal crease buckling wrinkles, clamps against an internal structural core box so
 * triangles never invert inside-out, and writes per-vertex scrape/bare-metal damage into the
 * vertex color buffer.
 */
export function deformSubmeshVertices(params: {
  positions: Float32Array;
  restPositions: Float32Array;
  colors: Float32Array;
  restColors: Float32Array;
  /** Optional per-vertex [0..1] bare-aluminum scrape mask (avoids darkening/color-shifting paint) */
  scrapes?: Float32Array;
  impactLocalX: number;
  impactLocalY: number;
  impactLocalZ: number;
  crushDirX: number;
  crushDirY: number;
  crushDirZ: number;
  radius: number;
  maxCrushDepth: number;
  creaseSeed?: number;
  innerCoreClamp?: DeformMeshBounds;
  /** Enables authentic longitudinal hood accordion V-buckle on frontal impacts */
  isHood?: boolean;
  /** Enables tighter pole/tree wrap-in & longitudinal nose crush behavior */
  isFrontalCrush?: boolean;
  /** Reduces metallic scrape amplitude on matte black plastic bumpers / arch cladding */
  isPlasticTrim?: boolean;
}): { modifiedVertices: number } {
  const {
    positions,
    restPositions,
    colors,
    restColors,
    scrapes,
    impactLocalX,
    impactLocalY,
    impactLocalZ,
    crushDirX,
    crushDirY,
    crushDirZ,
    radius,
    maxCrushDepth,
    creaseSeed = 1.0,
    innerCoreClamp,
    isHood = false,
    isFrontalCrush = false,
    isPlasticTrim = false,
  } = params;

  const effRadius = isHood && isFrontalCrush ? Math.max(radius * 1.18, 1.35) : radius;
  const rSq = effRadius * effRadius;
  if (rSq <= 1e-6 || maxCrushDepth <= 1e-4) {
    return { modifiedVertices: 0 };
  }

  const lenDir = Math.hypot(crushDirX, crushDirY, crushDirZ) || 1;
  const dxN = crushDirX / lenDir;
  const dyN = crushDirY / lenDir;
  const dzN = crushDirZ / lenDir;

  // Frontal longitudinal compression strength (positive when impact pushes nose backward along -Z)
  const frontComp = isFrontalCrush ? Math.max(0.25, Math.min(1.0, -dzN * 1.15)) : 0.0;

  let modifiedVertices = 0;
  const vertCount = Math.floor(positions.length / 3);

  for (let i = 0; i < vertCount; i++) {
    const i3 = i * 3;
    const vx = positions[i3];
    const vy = positions[i3 + 1];
    const vz = positions[i3 + 2];

    const rx = vx - impactLocalX;
    const ry = vy - impactLocalY;
    const rz = vz - impactLocalZ;

    // On frontal pole/tree hits, tighten lateral footprint slightly so the nose wraps sharply around obstacles
    const scaledRx = isFrontalCrush && !isHood ? rx * 1.24 : rx;
    const distSq = scaledRx * scaledRx + ry * ry + rz * rz;
    if (distSq >= rSq) continue;

    // Smooth quartic radial bell (1 at epicenter -> 0 with zero slope at radius edge)
    const u = 1 - distSq / rSq;
    const falloff = u * u;
    const coreFalloff = falloff * falloff; // crisp focused pole/tree indentation core

    // Smooth sculptural stamped sheet-metal crease folds (broad fold + clean ridge kink, zero sawtooth lip spikes)
    const freqScale = isHood ? 0.58 : 0.78;
    const waveA =
      Math.sin((vx * 16.5 + vz * 13.0) * freqScale + creaseSeed) *
      Math.cos((vy * 14.5 - vz * 11.5) * freqScale + creaseSeed * 0.7);
    const ridgeB =
      (1.0 - Math.abs(Math.sin((vx * 20.0 - vz * 16.0) * freqScale + creaseSeed * 1.3))) - 0.5;
    const rimEnvelope = falloff * (1.18 - falloff * 0.55);
    const wrinkleAmpA = isHood ? 0.11 : 0.16;
    const wrinkleAmpB = isHood ? 0.06 : 0.09;
    const wrinkle = (waveA * wrinkleAmpA + ridgeB * wrinkleAmpB) * maxCrushDepth * rimEnvelope;

    // Lock fender rear boundary flush against rigid front door & A-pillar seam (z ≈ 1.10..1.46)
    let seamLock = 1.0;
    if (isFrontalCrush && !isHood) {
      const restZ = restPositions[i3 + 2];
      if (restZ > 0.95 && restZ < 1.50) {
        const s = Math.max(0, Math.min(1, (restZ - 1.12) / 0.36));
        seamLock = s * s * (3 - 2 * s);
      }
    }

    // Combine sharp focused pole pocket with broader outer crush displacement
    const crushProfile = isFrontalCrush
      ? maxCrushDepth * (0.40 * falloff + 0.70 * coreFalloff)
      : maxCrushDepth * falloff;
    const disp = (crushProfile + wrinkle) * seamLock;

    let nx = vx + dxN * disp;
    let ny = vy + dyN * disp;
    let nz = vz + dzN * disp;

    // Authentic Hood Longitudinal Accordion V-Buckle on frontal crashes:
    // Mid-hood kinks smoothly UPWARD into an inverted-V tent fold while the leading nose lip curls downward!
    let buckleY = 0;
    if (isHood && isFrontalCrush && frontComp > 0.1) {
      const behindNose = impactLocalZ - restPositions[i3 + 2]; // 0 at nose -> ~1.3m at windshield cowl
      const lateralProx = Math.exp(-rx * rx * 1.15);
      if (behindNose > 0.14 && behindNose < 1.18) {
        const t = (behindNose - 0.14) / 1.04; // 0..1 from front lip toward cowl
        // Asymmetric tent peak around t = 0.42 (classic aluminum hood V-fold!)
        const tent = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.82)), 1.45);
        const crossCrease = 0.88 + 0.12 * Math.cos(vx * 7.5 + creaseSeed);
        buckleY = maxCrushDepth * 0.68 * frontComp * tent * lateralProx * crossCrease;
        ny += buckleY;
        // Conservation of panel length: upward V-buckle pulls front half slightly rearward
        nz -= buckleY * 0.32 * (1.0 - t * 0.68);
      } else if (behindNose <= 0.14 && behindNose > -0.35) {
        // Leading hood lip folds smoothly downward & inward around the bumper/obstacle
        const lipCurl = Math.max(0, 1 - Math.abs(behindNose) / 0.35) * lateralProx;
        const lipDrop = maxCrushDepth * 0.24 * frontComp * lipCurl;
        ny -= lipDrop;
        buckleY = -lipDrop;
      }
    } else if (isFrontalCrush) {
      // Subtle outward fender/bumper sheet-metal flare right behind the crushed pocket (locked at door seam)
      const rimFlare = falloff * (1.0 - coreFalloff) * maxCrushDepth * 0.13 * seamLock;
      const sideSign = vx >= 0 ? 1 : -1;
      nx += sideSign * rimFlare * (Math.abs(vx) > 0.45 ? 1.0 : 0.25);
    }

    // Clamp maximum total displacement from rest shape so panels stay crisp & recognizable
    const offX = nx - restPositions[i3];
    const offY = ny - restPositions[i3 + 1];
    const offZ = nz - restPositions[i3 + 2];
    const totalDisp = Math.hypot(offX, offY, offZ);
    const maxAllowed = isHood ? 0.32 : 0.36;
    if (totalDisp > maxAllowed) {
      const s = maxAllowed / totalDisp;
      nx = restPositions[i3] + offX * s;
      ny = restPositions[i3 + 1] + offY * s;
      nz = restPositions[i3 + 2] + offZ * s;
    }

    // Optional reinforced chassis/roll-cage clamp (prevents body skin penetrating engine/cage!)
    if (innerCoreClamp) {
      const cx = (innerCoreClamp.minX + innerCoreClamp.maxX) * 0.5;
      const cy = (innerCoreClamp.minY + innerCoreClamp.maxY) * 0.5;
      const cz = (innerCoreClamp.minZ + innerCoreClamp.maxZ) * 0.5;
      if (
        nx > innerCoreClamp.minX &&
        nx < innerCoreClamp.maxX &&
        ny > innerCoreClamp.minY &&
        ny < innerCoreClamp.maxY &&
        nz > innerCoreClamp.minZ &&
        nz < innerCoreClamp.maxZ
      ) {
        const dLeft = Math.abs(nx - innerCoreClamp.maxX);
        const dRight = Math.abs(nx - innerCoreClamp.minX);
        const dTop = Math.abs(ny - innerCoreClamp.maxY);
        const dFront = Math.abs(nz - innerCoreClamp.maxZ);
        const dRear = Math.abs(nz - innerCoreClamp.minZ);
        const m = Math.min(dLeft, dRight, dTop, dFront, dRear);
        if (m === dTop) ny = innerCoreClamp.maxY;
        else if (m === dLeft && nx >= cx) nx = innerCoreClamp.maxX;
        else if (m === dRight && nx < cx) nx = innerCoreClamp.minX;
        else if (m === dFront && nz >= cz) nz = innerCoreClamp.maxZ;
        else if (m === dRear && nz < cz) nz = innerCoreClamp.minZ;
      }
    }

    positions[i3] = nx;
    positions[i3 + 1] = ny;
    positions[i3 + 2] = nz;

    // Strictly localized scrape mask: ONLY where the obstacle physically gouged the contact core
    // (NOT across the broad mid-hood V-buckle, so Rivian paint stays glossy & true-color!)
    const tightCore = coreFalloff * falloff; // ~falloff^3 tightly concentrated at contact point
    const creaseStrain = Math.min(0.45, Math.abs(wrinkle) * 2.2);
    const trimScale = isPlasticTrim ? 0.28 : 1.0;
    const scrapeAmt = Math.min(0.84, (tightCore * 0.78 + creaseStrain * 0.35) * trimScale * seamLock);

    if (scrapes) {
      scrapes[i] = Math.min(0.84, Math.max(scrapes[i], scrapeAmt));
      // Always keep rest vertex color pristine so paint & dark plastic trim NEVER change hue/brightness!
      colors[i3] = restColors[i3];
      colors[i3 + 1] = restColors[i3 + 1];
      colors[i3 + 2] = restColors[i3 + 2];
    } else if (!isPlasticTrim) {
      const bareR = 0.64;
      const bareG = 0.62;
      const bareB = 0.59;
      const nextScrape = Math.min(0.64, scrapeAmt * 0.68);
      colors[i3] = restColors[i3] * (1 - nextScrape) + bareR * nextScrape;
      colors[i3 + 1] = restColors[i3 + 1] * (1 - nextScrape) + bareG * nextScrape;
      colors[i3 + 2] = restColors[i3 + 2] * (1 - nextScrape) + bareB * nextScrape;
    }

    modifiedVertices += 1;
  }

  return { modifiedVertices };
}
