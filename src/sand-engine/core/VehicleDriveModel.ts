/**
 * VehicleDriveModel.ts
 * Pure, engine-agnostic vehicle control & powertrain logic for the Desert Trophy Truck.
 *
 * Handles:
 *  - Merging keyboard and on-screen pointer/touch inputs cleanly
 *  - Speed-sensitive steering lock (sharp low-speed dune agility + calm 150+ km/h stability)
 *  - Natural brake-to-reverse state transition with brake/reverse lamp signaling
 *  - Turbo/boost torque & top-speed envelope
 *  - 6-speed rally gearbox & RPM telemetry estimation
 */

import { CameraMode, DriveMode } from './SandParams';

export const CAMERA_CYCLE_ORDER: readonly CameraMode[] = [
  'chase',
  'cockpit',
  'fender',
  'gopro_rear',
  'orbit',
  'wheel_closeup',
  'foot_ik',
];

export function getNextCameraMode(current: CameraMode): CameraMode {
  const idx = CAMERA_CYCLE_ORDER.indexOf(current);
  return CAMERA_CYCLE_ORDER[(idx + 1) % CAMERA_CYCLE_ORDER.length];
}

export interface VehicleControlInput {
  throttle: number; // -1 (brake/reverse) .. +1 (accelerate)
  steer: number;    // -1 (right) .. +1 (left)
  handbrake: boolean;
  boost: boolean;
}

export interface MergedControlInputs {
  keyboard: VehicleControlInput;
  virtual: VehicleControlInput;
}

export interface DriveStepInput {
  control: VehicleControlInput;
  vForwardMs: number;
  isSprintPreset: boolean;
  /** Transfer case range: 4H (default overland) vs 4L (low-range crawler + locked diffs) */
  driveMode?: DriveMode;
}

export interface DriveStepOutput {
  /** Signed longitudinal drive force in Newtons (positive = forward, negative = reverse) */
  engineForceN: number;
  /** Braking resistance force magnitude in Newtons (>= 0, always opposes motion) */
  serviceBrakeN: number;
  /** Maximum steering wheel angle in radians for current speed */
  maxSteerAngleRad: number;
  /** Target top forward speed in m/s */
  maxForwardSpeedMs: number;
  /** Target top reverse speed in m/s */
  maxReverseSpeedMs: number;
  /** True when brake lights should glow brightly */
  brakeLightsOn: boolean;
  /** True when white reverse lamps should illuminate */
  reverseLightsOn: boolean;
  /** True when active boost/overdrive is engaged */
  boostActive: boolean;
  /** Display gear label ('R', 'N', '1'..'6') */
  gear: string;
  /** Estimated engine RPM (900..7500) */
  rpm: number;
}

export interface VirtualControlFlags {
  left: boolean;
  right: boolean;
  accelerate: boolean;
  brake: boolean;
  handbrake: boolean;
  boost: boolean;
  /** Optional continuous analog steer (-1 right .. +1 left) from thumb pad drag */
  analogSteer: number;
}

export const EMPTY_VEHICLE_INPUT: VehicleControlInput = {
  throttle: 0,
  steer: 0,
  handbrake: false,
  boost: false,
};

export const EMPTY_VIRTUAL_FLAGS: VirtualControlFlags = {
  left: false,
  right: false,
  accelerate: false,
  brake: false,
  handbrake: false,
  boost: false,
  analogSteer: 0,
};

/**
 * Resolves independent multi-touch virtual control flags into a normalized VehicleControlInput.
 * Holding Boost alongside Accelerate (or releasing Boost while still holding Accelerate) never
 * clobbers throttle, and simultaneous Left+Right cancels cleanly.
 */
export function resolveVirtualControls(flags: VirtualControlFlags): VehicleControlInput {
  const digitalSteer = (flags.left ? 1 : 0) - (flags.right ? 1 : 0);
  const steer =
    Math.abs(flags.analogSteer) > 0.02
      ? clamp(flags.analogSteer, -1, 1)
      : digitalSteer;
  const accelActive = flags.accelerate || flags.boost;
  const throttle = (accelActive ? 1 : 0) - (flags.brake ? 1 : 0);
  return {
    throttle,
    steer,
    handbrake: flags.handbrake,
    boost: flags.boost,
  };
}

/**
 * Computes portrait-mobile chase camera adjustments so narrow vertical phone screens
 * keep the full Trophy Truck, wheel arches, and carved sand tracks comfortably in view.
 */
export function computePortraitCameraAdjust(aspect: number): {
  fovBonusDeg: number;
  extraBackDist: number;
  extraHeight: number;
  sideOffsetScale: number;
} {
  if (aspect >= 0.95) {
    return { fovBonusDeg: 0, extraBackDist: 0, extraHeight: 0, sideOffsetScale: 1.0 };
  }
  const t = clamp((0.95 - aspect) / 0.5, 0, 1);
  return {
    fovBonusDeg: t * 15.0,
    extraBackDist: t * 2.4,
    extraHeight: t * 0.75,
    sideOffsetScale: 1.0 - t * 0.55,
  };
}

export interface GoProRearCamPose {
  posX: number;
  posY: number;
  posZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  fovDeg: number;
}

/**
 * Computes the local chassis-mounted GoPro action-cam pose suction-mounted low on the
 * left cab/bed rocker looking rearward across the 35" rear-left tire, rubber-to-sand
 * contact patch, and freshly sculpted sand trench/berm.
 */
export function computeGoProRearCamLocalPose(params: {
  timeSec: number;
  speedMs: number;
  wheelSlip: number;
  boostActive: boolean;
  wheelTravelY: number;
  aspect: number;
}): GoProRearCamPose {
  const speedNorm = clamp(Math.abs(params.speedMs) / 14.0, 0, 1);
  const slipNorm = clamp(params.wheelSlip, 0, 1.2);
  const shakeAmp = (0.002 + speedNorm * 0.0065 + slipNorm * 0.0045) * (params.boostActive ? 1.2 : 1.0);
  const shakeX = Math.sin(params.timeSec * 31.7) * shakeAmp * 0.55;
  const shakeY = Math.cos(params.timeSec * 43.3 + 0.9) * shakeAmp;

  // Wide-angle GoPro SuperView lens (76 deg desktop, widened gently on portrait phones & under boost)
  const portraitBoost = params.aspect < 0.95 ? clamp((0.95 - params.aspect) / 0.5, 0, 1) * 9.0 : 0;
  const fovDeg = 76 + portraitBoost + (params.boostActive ? 4.0 : 0) + speedNorm * 2.5;

  const clampedTravel = clamp(params.wheelTravelY, -0.28, 0.28);

  return {
    // Low external suction mount outside left rear rocker/bed side, framing full tire sidewall, contact patch & trailing sand groove
    posX: 1.74 + shakeX,
    posY: 0.52 + shakeY,
    posZ: -0.52,
    // Aim cleanly across lower tire sidewall, contact patch & freshly carved sand trench behind tire
    targetX: 0.98,
    targetY: 0.22 + clampedTravel * 0.35 + shakeY * 0.4,
    targetZ: -2.35,
    fovDeg,
  };
}

/**
 * Merges keyboard and virtual (touch/mouse) inputs without losing either source.
 */
export function mergeVehicleInputs(
  keyboard: VehicleControlInput,
  virtual: VehicleControlInput,
): VehicleControlInput {
  const throttle = clamp(keyboard.throttle + virtual.throttle, -1, 1);
  const steer = clamp(keyboard.steer + virtual.steer, -1, 1);
  return {
    throttle,
    steer,
    handbrake: keyboard.handbrake || virtual.handbrake,
    boost: keyboard.boost || virtual.boost,
  };
}

/**
 * Computes speed-sensitive steering lock for a heavy long-wheelbase Raptor R 4x4:
 *  - Low speed (0..3.5 m/s): ~33.2 deg (0.58 rad) for tight parking & rock crawling
 *  - Cruising (13.5 m/s / ~49 km/h): ~13 deg (0.23 rad)
 *  - Highway (26 m/s / ~95 km/h): ~7 deg (0.12 rad)
 *  - High speed (40 m/s / ~144 km/h): ~5 deg (0.087 rad) for planted straight-line stability
 */
export function computeSpeedSensitiveMaxSteerRad(speedMs: number): number {
  const absSpeed = Math.abs(speedMs);
  if (absSpeed <= 3.5) return 0.58;
  const excess = absSpeed - 3.5;
  return 0.045 + (0.58 - 0.045) / (1.0 + Math.pow(excess / 6.2, 1.38));
}

/**
 * Converts front-wheel steering angle (+ = turning LEFT, - = turning RIGHT) into
 * the 3D cockpit steering wheel's local Z rotation (in Three.js right-handed space
 * with the driver facing +Z, +X = LEFT, +Y = UP: negative Z rotation swings the
 * 12-o'clock top marker toward +X = LEFT / counter-clockwise from driver's POV).
 */
export function computeSteeringWheelVisualAngleRad(
  frontWheelSteerRad: number,
  shakeRad = 0,
): number {
  return -frontWheelSteerRad * 2.85 + shakeRad;
}

/**
 * Evaluates longitudinal drive force, heavy service braking, lighting signals,
 * and automatic 6-speed gearbox telemetry for a slow, heavy (~3,450 kg) turbo 4x4 expedition truck.
 * Normal drive is deliberate and heavy (~48 km/h crawl across deep sand);
 * Turbo Boost delivers a dramatic +87% torque surge up to ~95 km/h.
 */
export function evaluateVehicleDriveStep(params: DriveStepInput): DriveStepOutput {
  const { control, vForwardMs, isSprintPreset, driveMode = '4H' } = params;
  const throttle = clamp(control.throttle, -1, 1);
  const absFwd = Math.abs(vForwardMs);
  const isLowRange = driveMode === '4L' && !isSprintPreset;

  const boostActive = control.boost && throttle > 0.1 && !control.handbrake;
  const maxForwardSpeedMs = isSprintPreset
    ? 44.5 // ~160 km/h dedicated sprint stress-test preset
    : isLowRange
      ? boostActive
        ? 11.8 // ~42 km/h 4L low-range turbo pull
        : 6.8  // ~24.5 km/h authoritative heavy 4L dune/mud crawl
      : boostActive
        ? 26.5 // ~95 km/h heavy turbo boost surge
        : 13.5; // ~48.5 km/h slow, weighty heavy 4x4 overland crawl
  const maxReverseSpeedMs = isLowRange ? 4.4 : 6.5;

  let engineForceN = 0;
  let serviceBrakeN = 0;
  let brakeLightsOn = control.handbrake;
  let reverseLightsOn = false;

  // Scaled for 3,450 kg loaded expedition 4x4: 4L multiplies low-end crawl torque by +48%
  const baseFwdTorque = isSprintPreset
    ? 38500
    : isLowRange
      ? boostActive
        ? 36500
        : 22600
      : boostActive
        ? 28500
        : 15200;
  const reverseTorque = isLowRange ? 18200 : 12800;

  if (throttle > 0.05) {
    if (vForwardMs < -1.1) {
      // Driver pressed forward while reversing -> apply heavy hydraulic service brakes first
      serviceBrakeN = 26500 * throttle;
      brakeLightsOn = true;
    } else {
      engineForceN = throttle * baseFwdTorque;
    }
  } else if (throttle < -0.05) {
    if (vForwardMs > 1.2) {
      // Driver pressed S/Down while moving forward -> progressive heavy-truck braking
      serviceBrakeN = 29500 * Math.abs(throttle);
      brakeLightsOn = true;
    } else {
      // Engaged reverse gear cleanly with slow heavy crawler torque
      engineForceN = throttle * reverseTorque;
      reverseLightsOn = true;
    }
  }

  // Automatic 6-speed heavy off-road transmission (with low-range L1..L4 ratios in 4L)
  const speedKmh = absFwd * 3.6;
  let gear = 'N';
  let rpm = 760;

  if (reverseLightsOn || vForwardMs < -0.6) {
    gear = isLowRange ? 'LR' : 'R';
    rpm = clamp(950 + (speedKmh / (isLowRange ? 16 : 26)) * 3800, 900, 5200);
  } else if (speedKmh < 1.0 && Math.abs(throttle) < 0.05) {
    gear = 'N';
    rpm = 760;
  } else if (isLowRange) {
    const lowThresholds = [7, 14, 24, 44];
    let gIdx = 0;
    while (gIdx < lowThresholds.length - 1 && speedKmh > lowThresholds[gIdx]) {
      gIdx++;
    }
    gear = `L${gIdx + 1}`;
    const low = gIdx === 0 ? 0 : lowThresholds[gIdx - 1] * 0.7;
    const high = lowThresholds[gIdx];
    const ratio = clamp((speedKmh - low) / Math.max(1, high - low), 0, 1);
    const throttleRevLift = Math.max(0, throttle) * (boostActive ? 1350 : 620);
    rpm = clamp(1500 + ratio * 3300 + throttleRevLift, 950, 5950);
  } else {
    const gearThresholds = [12, 24, 38, 54, 74, 110];
    let gIdx = 0;
    while (gIdx < gearThresholds.length - 1 && speedKmh > gearThresholds[gIdx]) {
      gIdx++;
    }
    gear = String(gIdx + 1);
    const low = gIdx === 0 ? 0 : gearThresholds[gIdx - 1] * 0.72;
    const high = gearThresholds[gIdx];
    const ratio = clamp((speedKmh - low) / Math.max(1, high - low), 0, 1);
    const throttleRevLift = Math.max(0, throttle) * (boostActive ? 1200 : 480);
    rpm = clamp(1400 + ratio * 3400 + throttleRevLift, 880, 5900);
  }

  return {
    engineForceN,
    serviceBrakeN,
    maxSteerAngleRad: computeSpeedSensitiveMaxSteerRad(vForwardMs),
    maxForwardSpeedMs,
    maxReverseSpeedMs,
    brakeLightsOn,
    reverseLightsOn,
    boostActive,
    gear,
    rpm: Math.round(rpm),
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
