/**
 * CockpitStateModel.ts
 * Pure, engine-agnostic state machine for the Ford F-150 Raptor R 1st-person cockpit:
 *  - Articulated dual windshield wiper kinematics (off / intermittent / normal / fast + damage jam)
 *  - 12" SYNC 4 infotainment state (Radio/Spotify, Luzes & RT/PT GI studio, Espelhos motorizados,
 *    4x4 Telemetry & Diagnostics, Vehicle Controls & Climate, deterministic UV hit-testing)
 *  - Interactive exterior & interior lighting state (Headlights Off/Low/High, Roof Lightbar,
 *    Raptor Grille Amber markers, Hazard blinkers, Overhead Dome light, 6-color Ambient LEDs,
 *    Ray-Traced / Path-Traced GI toggle & bounce strength)
 *  - Motorized Wing & Interior Mirror yaw/pitch angles + animated Power-Fold state
 *  - Live odometer (12486 km base), trip meter (5.8 km base), fuel consumption, and G-force head-bob spring
 *
 * Zero Three.js dependencies — fully unit-tested via node:test.
 */

import { WiperMode } from './SandParams';

export type InfotainmentTab = 'home' | 'audio' | 'lights' | 'mirrors' | 'apps' | 'settings';
export type MediaSource = 'spotify' | 'radio';
export type HeadlightMode = 'off' | 'low' | 'high';
export type MirrorTarget = 'left' | 'right' | 'interior';
export type CabinSwitchId = 'headlights' | 'lightbar' | 'hazard' | 'dome' | 'ambient';

export interface AmbientLightPreset {
  id: string;
  label: string;
  hex: string;
  r: number;
  g: number;
  b: number;
}

export const AMBIENT_LIGHT_PRESETS: readonly AmbientLightPreset[] = [
  { id: 'orange', label: 'Code Orange', hex: '#ff5a14', r: 1.0, g: 0.35, b: 0.08 },
  { id: 'cyan', label: 'Ice Cyan', hex: '#14c8ff', r: 0.08, g: 0.78, b: 1.0 },
  { id: 'crimson', label: 'Raptor Red', hex: '#ff1f36', r: 1.0, g: 0.12, b: 0.21 },
  { id: 'emerald', label: 'Emerald', hex: '#18e67a', r: 0.09, g: 0.9, b: 0.48 },
  { id: 'violet', label: 'Cyber Violet', hex: '#a84dff', r: 0.66, g: 0.3, b: 1.0 },
  { id: 'gold', label: 'Warm Gold', hex: '#ffb838', r: 1.0, g: 0.72, b: 0.22 },
];

export interface MirrorAngleState {
  yawRad: number;
  pitchRad: number;
}

export const MIRROR_YAW_LIMIT_RAD = 0.38;
export const MIRROR_PITCH_LIMIT_RAD = 0.26;
export const MIRROR_ADJUST_STEP_RAD = 0.075;

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  bpm: number;
  accentHex: string;
}

export interface RadioStation {
  id: string;
  freq: string;
  name: string;
  genre: string;
  carrierHz: number;
}

export const RAPTOR_PLAYLIST: readonly MusicTrack[] = [
  {
    id: 'earrings',
    title: 'Earrings',
    artist: 'Malcolm Todd',
    album: 'Sweet Boy',
    durationSec: 151, // 2:31 -> at 0:40 remaining is -1:51 (matches reference!)
    bpm: 96,
    accentHex: '#d97b66',
  },
  {
    id: 'rain_highway',
    title: '6:30 Mist',
    artist: 'Coastal Drive',
    album: 'Wet Asphalt Sessions',
    durationSec: 194,
    bpm: 88,
    accentHex: '#4f8ea8',
  },
  {
    id: 'predator_v8',
    title: 'Redline Dawn',
    artist: 'Outback FM',
    album: 'Gravel & Rain',
    durationSec: 178,
    bpm: 110,
    accentHex: '#c84b31',
  },
  {
    id: 'eucalyptus',
    title: 'Eucalyptus Line',
    artist: 'Southbound Tape',
    album: 'Morning Fog',
    durationSec: 205,
    bpm: 82,
    accentHex: '#6b8e64',
  },
];

export const RAPTOR_RADIO_STATIONS: readonly RadioStation[] = [
  { id: 'fm1', freq: '98.5 FM', name: 'Rural Morning', genre: 'Indie & Lo-Fi', carrierHz: 220 },
  { id: 'fm2', freq: '101.9 FM', name: 'Outback Rock', genre: 'Classic Drive', carrierHz: 185 },
  { id: 'fm3', freq: '104.3 FM', name: 'Weather & Road', genre: 'Traffic Live', carrierHz: 262 },
];

export const WIPER_CYCLE_ORDER: readonly WiperMode[] = ['off', 'intermittent', 'normal', 'fast'];
export const HEADLIGHT_CYCLE_ORDER: readonly HeadlightMode[] = ['off', 'low', 'high'];

export interface CockpitRuntimeState {
  // Wipers
  wiperMode: WiperMode;
  wiperPhase: number;
  wiperSweep01: number;
  wiperLeftAngleRad: number;
  wiperRightAngleRad: number;
  wiperWipeFreshness: number;
  wiperDamaged: boolean;

  // Infotainment (12" SYNC 4)
  activeTab: InfotainmentTab;
  mediaSource: MediaSource;
  isPlaying: boolean;
  trackIndex: number;
  trackElapsedSec: number;
  stationIndex: number;
  volume01: number;

  // Interactive Lighting & Ray-Traced / Path-Traced GI System
  headlightMode: HeadlightMode;
  lightbarOn: boolean;
  grilleAmberOn: boolean;
  hazardOn: boolean;
  domeLightOn: boolean;
  ambientLightOn: boolean;
  ambientColorIndex: number;
  ambientIntensity: number; // 0.25 .. 1.0
  rayTracedLighting: boolean;
  rtBounceStrength: number; // 0.65 (Padrão) | 1.15 (RT Alto) | 1.55 (Path GI Ultra)

  // Motorized Mirrors (Left / Interior / Right + Power Fold)
  selectedMirror: MirrorTarget;
  mirrors: Record<MirrorTarget, MirrorAngleState>;
  mirrorsFolded: boolean;
  mirrorFold01: number; // smoothly animated 0 (open) .. 1 (folded)

  // Climate & Settings controls
  cabinTempC: number;
  fanLevel: number;
  acOn: boolean;
  defrostOn: boolean;
  ambientTempC: number;
  clockText: string;

  // Vehicle instrument counters
  odometerKm: number;
  tripKm: number;
  fuelLevel01: number;

  // Cockpit G-force head-bob & look-around offsets
  headPitchRad: number;
  headRollRad: number;
  headHeaveM: number;
  lookYawRad: number;
  lookPitchRad: number;

  // Dirty flag so CanvasTexture redraws only when needed or at throttled cadence
  screenDirty: boolean;
}

export interface CockpitStepInput {
  speedMs: number;
  accelForwardMs2: number;
  lateralG: number;
  rainIntensity: number;
  suspensionBump: number;
  wiperDamaged?: boolean;
  ambientTempC?: number;
}

export interface SyncTouchResult {
  hit: boolean;
  action: string;
  toggleAudio?: boolean;
  changeTrack?: boolean;
  toggleWipers?: boolean;
  toggleHeadlights?: boolean;
  lightingChanged?: boolean;
  mirrorsChanged?: boolean;
  toggleDriveMode?: boolean;
  triggerRepair?: boolean;
}

export function createInitialCockpitState(): CockpitRuntimeState {
  return {
    wiperMode: 'normal',
    wiperPhase: 0.14,
    wiperSweep01: 0.22,
    wiperLeftAngleRad: 0.22 * 0.96,
    wiperRightAngleRad: 0.22 * 0.92,
    wiperWipeFreshness: 0.92,
    wiperDamaged: false,

    activeTab: 'audio',
    mediaSource: 'spotify',
    isPlaying: true,
    trackIndex: 0,
    trackElapsedSec: 40,
    stationIndex: 0,
    volume01: 0.55,

    headlightMode: 'low',
    lightbarOn: false,
    grilleAmberOn: true,
    hazardOn: false,
    domeLightOn: false,
    ambientLightOn: true,
    ambientColorIndex: 0, // Raptor Code Orange
    ambientIntensity: 0.85,
    rayTracedLighting: true,
    rtBounceStrength: 1.2,

    selectedMirror: 'left',
    mirrors: {
      left: { yawRad: 0, pitchRad: 0 },
      right: { yawRad: 0, pitchRad: 0 },
      interior: { yawRad: 0, pitchRad: 0 },
    },
    mirrorsFolded: false,
    mirrorFold01: 0,

    cabinTempC: 21,
    fanLevel: 2,
    acOn: true,
    defrostOn: true,
    ambientTempC: 11,
    clockText: '6:30 AM',

    odometerKm: 12486.0,
    tripKm: 5.8,
    fuelLevel01: 0.78,

    headPitchRad: 0,
    headRollRad: 0,
    headHeaveM: 0,
    lookYawRad: 0,
    lookPitchRad: 0,

    screenDirty: true,
  };
}

export function cycleWiperMode(current: WiperMode): WiperMode {
  const idx = WIPER_CYCLE_ORDER.indexOf(current);
  return WIPER_CYCLE_ORDER[(idx + 1) % WIPER_CYCLE_ORDER.length];
}

export function cycleHeadlightMode(current: HeadlightMode): HeadlightMode {
  const idx = HEADLIGHT_CYCLE_ORDER.indexOf(current);
  return HEADLIGHT_CYCLE_ORDER[(idx + 1) % HEADLIGHT_CYCLE_ORDER.length];
}

export function getActiveAmbientPreset(state: Readonly<CockpitRuntimeState>): AmbientLightPreset {
  const idx =
    ((state.ambientColorIndex % AMBIENT_LIGHT_PRESETS.length) + AMBIENT_LIGHT_PRESETS.length) %
    AMBIENT_LIGHT_PRESETS.length;
  return AMBIENT_LIGHT_PRESETS[idx];
}

/** Deterministic 1.55 Hz hazard flasher pulse (0 or 1 with brief smooth edge). */
export function computeHazardFlash01(timeSec: number, hazardOn: boolean): number {
  if (!hazardOn) return 0;
  const phase = (timeSec * 1.55) % 1.0;
  if (phase < 0.06) return phase / 0.06;
  if (phase < 0.48) return 1.0;
  if (phase < 0.56) return 1.0 - (phase - 0.48) / 0.08;
  return 0.0;
}

export function adjustSelectedMirror(
  state: CockpitRuntimeState,
  deltaYawRad: number,
  deltaPitchRad: number,
): void {
  const target = state.mirrors[state.selectedMirror];
  target.yawRad = Math.max(
    -MIRROR_YAW_LIMIT_RAD,
    Math.min(MIRROR_YAW_LIMIT_RAD, target.yawRad + deltaYawRad),
  );
  target.pitchRad = Math.max(
    -MIRROR_PITCH_LIMIT_RAD,
    Math.min(MIRROR_PITCH_LIMIT_RAD, target.pitchRad + deltaPitchRad),
  );
  // Automatically unfold mirrors if user adjusts a folded wing mirror
  if (state.mirrorsFolded && state.selectedMirror !== 'interior') {
    state.mirrorsFolded = false;
  }
  state.screenDirty = true;
}

export function resetMirrors(state: CockpitRuntimeState): void {
  state.mirrors.left.yawRad = 0;
  state.mirrors.left.pitchRad = 0;
  state.mirrors.right.yawRad = 0;
  state.mirrors.right.pitchRad = 0;
  state.mirrors.interior.yawRad = 0;
  state.mirrors.interior.pitchRad = 0;
  state.mirrorsFolded = false;
  state.screenDirty = true;
}

export function handleCabinSwitchAction(
  state: CockpitRuntimeState,
  switchId: CabinSwitchId,
): SyncTouchResult {
  if (switchId === 'headlights') {
    state.headlightMode = cycleHeadlightMode(state.headlightMode);
    state.screenDirty = true;
    return {
      hit: true,
      action: `switch:headlights_${state.headlightMode}`,
      toggleHeadlights: true,
      lightingChanged: true,
    };
  }
  if (switchId === 'lightbar') {
    state.lightbarOn = !state.lightbarOn;
    state.screenDirty = true;
    return { hit: true, action: `switch:lightbar_${state.lightbarOn ? 'on' : 'off'}`, lightingChanged: true };
  }
  if (switchId === 'hazard') {
    state.hazardOn = !state.hazardOn;
    state.screenDirty = true;
    return { hit: true, action: `switch:hazard_${state.hazardOn ? 'on' : 'off'}`, lightingChanged: true };
  }
  if (switchId === 'dome') {
    state.domeLightOn = !state.domeLightOn;
    state.screenDirty = true;
    return { hit: true, action: `switch:dome_${state.domeLightOn ? 'on' : 'off'}`, lightingChanged: true };
  }
  state.ambientLightOn = !state.ambientLightOn;
  state.screenDirty = true;
  return { hit: true, action: `switch:ambient_${state.ambientLightOn ? 'on' : 'off'}`, lightingChanged: true };
}

export function formatTrackTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? '0' : ''}${rem}`;
}

/**
 * Pure simulation step for wiper kinematics, power-fold mirrors, audio progress, odometer/trip, and head spring.
 */
export function stepCockpitState(
  state: CockpitRuntimeState,
  dt: number,
  input: CockpitStepInput,
): void {
  const safeDt = Math.max(0.001, Math.min(0.05, dt));
  if (typeof input.wiperDamaged === 'boolean') {
    state.wiperDamaged = input.wiperDamaged;
  }
  if (typeof input.ambientTempC === 'number') {
    state.ambientTempC = input.ambientTempC;
  }

  // 1. Articulated Dual Windshield Wiper Kinematics
  const rainRate = Math.max(0, Math.min(1, input.rainIntensity));
  if (state.wiperDamaged) {
    state.wiperSweep01 += (0.46 - state.wiperSweep01) * Math.min(1, safeDt * 4.0);
    state.wiperWipeFreshness = Math.max(0, state.wiperWipeFreshness - safeDt * 0.22 * (0.4 + rainRate));
  } else if (state.wiperMode === 'off') {
    state.wiperSweep01 = Math.max(0, state.wiperSweep01 - safeDt * 1.45);
    state.wiperWipeFreshness = Math.max(0, state.wiperWipeFreshness - safeDt * 0.16 * (0.3 + rainRate));
  } else {
    const cycleRate =
      state.wiperMode === 'fast' ? 1.32 : state.wiperMode === 'normal' ? 0.78 : 0.34;
    state.wiperPhase = (state.wiperPhase + safeDt * cycleRate) % 1.0;

    if (state.wiperMode === 'intermittent') {
      if (state.wiperPhase < 0.38) {
        const u = state.wiperPhase / 0.38;
        state.wiperSweep01 = Math.sin(u * Math.PI);
        state.wiperWipeFreshness = Math.min(1.0, state.wiperWipeFreshness + safeDt * 2.4);
      } else {
        state.wiperSweep01 = 0;
        state.wiperWipeFreshness = Math.max(0.28, state.wiperWipeFreshness - safeDt * 0.14 * rainRate);
      }
    } else {
      const s = 0.5 - 0.5 * Math.cos(state.wiperPhase * Math.PI * 2);
      state.wiperSweep01 = Math.pow(s, 0.88);
      state.wiperWipeFreshness = Math.min(1.0, Math.max(0.72, state.wiperWipeFreshness + safeDt * 1.6));
    }
  }

  state.wiperLeftAngleRad = 0.08 + state.wiperSweep01 * 0.88;
  state.wiperRightAngleRad = 0.07 + state.wiperSweep01 * 0.85;

  // 2. Smooth Power-Fold Wing Mirror Servo Animation (0 -> 1 over ~0.55s)
  const foldTarget = state.mirrorsFolded ? 1.0 : 0.0;
  const foldRate = 1.9 * safeDt;
  if (Math.abs(foldTarget - state.mirrorFold01) <= foldRate) {
    state.mirrorFold01 = foldTarget;
  } else {
    state.mirrorFold01 += Math.sign(foldTarget - state.mirrorFold01) * foldRate;
  }

  // 3. Odometer, Trip Meter & Fuel Consumption
  const distKm = (Math.abs(input.speedMs) * safeDt) / 1000;
  if (distKm > 0) {
    state.odometerKm += distKm;
    state.tripKm += distKm;
    state.fuelLevel01 = Math.max(0.04, state.fuelLevel01 - distKm * 0.0024);
  }

  // 4. Infotainment Track Timer
  const activeTrack = RAPTOR_PLAYLIST[state.trackIndex % RAPTOR_PLAYLIST.length];
  if (state.isPlaying && state.mediaSource === 'spotify') {
    const prevSec = Math.floor(state.trackElapsedSec);
    state.trackElapsedSec += safeDt;
    if (state.trackElapsedSec >= activeTrack.durationSec) {
      state.trackElapsedSec = 0;
      state.trackIndex = (state.trackIndex + 1) % RAPTOR_PLAYLIST.length;
      state.screenDirty = true;
    } else if (Math.floor(state.trackElapsedSec) !== prevSec) {
      state.screenDirty = true;
    }
  }

  // 5. Cockpit G-force Head-Bob & Pothole Jolt Spring
  const targetPitch = Math.max(-0.045, Math.min(0.045, -input.accelForwardMs2 * 0.0032));
  const targetRoll = Math.max(-0.05, Math.min(0.05, -input.lateralG * 0.032));
  const targetHeave = Math.max(-0.028, Math.min(0.028, input.suspensionBump * 0.16));
  const lerp = 1 - Math.exp(-9.5 * safeDt);
  state.headPitchRad += (targetPitch - state.headPitchRad) * lerp;
  state.headRollRad += (targetRoll - state.headRollRad) * lerp;
  state.headHeaveM += (targetHeave - state.headHeaveM) * (1 - Math.exp(-14.0 * safeDt));
}

/**
 * Deterministic UV hit-test for 3D raycast clicks on the 12" SYNC 4 Touchscreen.
 * UV convention: u = 0 (left) .. 1 (right), v = 0 (bottom) .. 1 (top) — standard Three.js PlaneGeometry UVs!
 */
export function handleSyncScreenTouchUV(
  state: CockpitRuntimeState,
  u: number,
  v: number,
): SyncTouchResult {
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    return { hit: false, action: 'none' };
  }

  // Convert to top-down normalized coordinates (y = 0 at top, y = 1 at bottom) matching Canvas2D drawing!
  const x = u;
  const y = 1.0 - v;

  // 1. Bottom Navigation Tab Bar (y >= 0.84): 6 evenly spaced tabs
  if (y >= 0.84) {
    const tabs: InfotainmentTab[] = ['home', 'audio', 'lights', 'mirrors', 'apps', 'settings'];
    const idx = Math.min(5, Math.max(0, Math.floor(x * 6)));
    state.activeTab = tabs[idx];
    state.screenDirty = true;
    return { hit: true, action: `tab:${tabs[idx]}` };
  }

  // 2. Quick-Access Top Bar Shortcuts (y < 0.10): right side quick Light / RT status pill
  if (y < 0.10 && x >= 0.56 && x <= 0.78) {
    state.activeTab = 'lights';
    state.screenDirty = true;
    return { hit: true, action: 'tab:lights' };
  }

  // 3. Home / Audio shared media controls (plus quick Lights/Mirrors pills on Home!)
  if (state.activeTab === 'audio' || state.activeTab === 'home') {
    // Source Pills near top-left (y: 0.10..0.23)
    if (y >= 0.1 && y <= 0.23 && x >= 0.03 && x <= 0.42) {
      if (x < 0.18) {
        state.mediaSource = 'radio';
        state.screenDirty = true;
        return { hit: true, action: 'source:radio', changeTrack: true };
      }
      state.mediaSource = 'spotify';
      state.screenDirty = true;
      return { hit: true, action: 'source:spotify', changeTrack: true };
    }

    // Quick-jump chips on top-right of Audio/Home bar (y: 0.10..0.23, x: 0.52..0.96)
    if (y >= 0.1 && y <= 0.23 && x >= 0.52 && x <= 0.96) {
      if (x < 0.74) {
        state.activeTab = 'lights';
        state.screenDirty = true;
        return { hit: true, action: 'tab:lights' };
      }
      state.activeTab = 'mirrors';
      state.screenDirty = true;
      return { hit: true, action: 'tab:mirrors' };
    }

    // Transport buttons (Prev / Play-Pause / Next) around right-middle of media card
    if (y >= 0.46 && y <= 0.7 && x >= 0.54 && x <= 0.96) {
      if (x < 0.69) {
        if (state.mediaSource === 'spotify') {
          state.trackIndex =
            (state.trackIndex - 1 + RAPTOR_PLAYLIST.length) % RAPTOR_PLAYLIST.length;
          state.trackElapsedSec = 0;
        } else {
          state.stationIndex =
            (state.stationIndex - 1 + RAPTOR_RADIO_STATIONS.length) % RAPTOR_RADIO_STATIONS.length;
        }
        state.screenDirty = true;
        return { hit: true, action: 'media:prev', changeTrack: true };
      }
      if (x < 0.83) {
        state.isPlaying = !state.isPlaying;
        state.screenDirty = true;
        return { hit: true, action: state.isPlaying ? 'media:play' : 'media:pause', toggleAudio: true };
      }
      if (state.mediaSource === 'spotify') {
        state.trackIndex = (state.trackIndex + 1) % RAPTOR_PLAYLIST.length;
        state.trackElapsedSec = 0;
      } else {
        state.stationIndex = (state.stationIndex + 1) % RAPTOR_RADIO_STATIONS.length;
      }
      state.screenDirty = true;
      return { hit: true, action: 'media:next', changeTrack: true };
    }

    // Progress scrubber bar (y: 0.70..0.80)
    if (y >= 0.7 && y <= 0.8 && x >= 0.06 && x <= 0.94 && state.mediaSource === 'spotify') {
      const frac = Math.max(0, Math.min(1, (x - 0.06) / 0.88));
      const track = RAPTOR_PLAYLIST[state.trackIndex % RAPTOR_PLAYLIST.length];
      state.trackElapsedSec = frac * track.durationSec;
      state.screenDirty = true;
      return { hit: true, action: 'media:seek' };
    }
  }

  // 4. LUZES & RAY-TRACING / PATH-TRACING GI STUDIO TAB
  if (state.activeTab === 'lights') {
    // Row 1 (y: 0.17..0.34): 3 Exterior Light Cards [Faróis | Barra LED | Grade Âmbar]
    if (y >= 0.17 && y <= 0.34) {
      if (x >= 0.03 && x < 0.35) {
        state.headlightMode = cycleHeadlightMode(state.headlightMode);
        state.screenDirty = true;
        return {
          hit: true,
          action: `lights:headlights_${state.headlightMode}`,
          toggleHeadlights: true,
          lightingChanged: true,
        };
      }
      if (x >= 0.35 && x < 0.66) {
        state.lightbarOn = !state.lightbarOn;
        state.screenDirty = true;
        return { hit: true, action: `lights:lightbar_${state.lightbarOn ? 'on' : 'off'}`, lightingChanged: true };
      }
      if (x >= 0.66 && x <= 0.97) {
        state.grilleAmberOn = !state.grilleAmberOn;
        state.screenDirty = true;
        return { hit: true, action: `lights:grille_${state.grilleAmberOn ? 'on' : 'off'}`, lightingChanged: true };
      }
    }

    // Row 2 (y: 0.36..0.53): 3 Cabin & Signal Cards [Pisca-Alerta | Luz de Teto | LED Ambiente]
    if (y >= 0.36 && y <= 0.53) {
      if (x >= 0.03 && x < 0.35) {
        state.hazardOn = !state.hazardOn;
        state.screenDirty = true;
        return { hit: true, action: `lights:hazard_${state.hazardOn ? 'on' : 'off'}`, lightingChanged: true };
      }
      if (x >= 0.35 && x < 0.66) {
        state.domeLightOn = !state.domeLightOn;
        state.screenDirty = true;
        return { hit: true, action: `lights:dome_${state.domeLightOn ? 'on' : 'off'}`, lightingChanged: true };
      }
      if (x >= 0.66 && x <= 0.97) {
        state.ambientLightOn = !state.ambientLightOn;
        state.screenDirty = true;
        return { hit: true, action: `lights:ambient_${state.ambientLightOn ? 'on' : 'off'}`, lightingChanged: true };
      }
    }

    // Row 3 (y: 0.55..0.68): 6 Ambient Color Swatches (x: 0.04..0.66) + Brightness - / + (x: 0.68..0.96)
    if (y >= 0.55 && y <= 0.68) {
      if (x >= 0.04 && x <= 0.66) {
        const swatchIdx = Math.min(
          AMBIENT_LIGHT_PRESETS.length - 1,
          Math.max(0, Math.floor(((x - 0.04) / 0.62) * AMBIENT_LIGHT_PRESETS.length)),
        );
        state.ambientColorIndex = swatchIdx;
        state.ambientLightOn = true;
        state.screenDirty = true;
        return {
          hit: true,
          action: `lights:color_${AMBIENT_LIGHT_PRESETS[swatchIdx].id}`,
          lightingChanged: true,
        };
      }
      if (x > 0.66 && x <= 0.82) {
        state.ambientIntensity = Math.max(0.25, Math.round((state.ambientIntensity - 0.2) * 100) / 100);
        state.screenDirty = true;
        return { hit: true, action: 'lights:intensity_down', lightingChanged: true };
      }
      if (x > 0.82 && x <= 0.97) {
        state.ambientIntensity = Math.min(1.0, Math.round((state.ambientIntensity + 0.2) * 100) / 100);
        state.ambientLightOn = true;
        state.screenDirty = true;
        return { hit: true, action: 'lights:intensity_up', lightingChanged: true };
      }
    }

    // Row 4 (y: 0.70..0.82): Ray Tracing / Path Tracing GI Engine Bar
    if (y >= 0.70 && y <= 0.82) {
      if (x >= 0.03 && x < 0.58) {
        state.rayTracedLighting = !state.rayTracedLighting;
        state.screenDirty = true;
        return {
          hit: true,
          action: `lights:rt_gi_${state.rayTracedLighting ? 'on' : 'off'}`,
          lightingChanged: true,
        };
      }
      if (x >= 0.58 && x <= 0.97) {
        // Cycle Path-Tracing GI reflection intensity: 0.75 (Padrão) -> 1.20 (Alto) -> 1.65 (Ultra PT)
        state.rayTracedLighting = true;
        state.rtBounceStrength =
          state.rtBounceStrength < 1.0 ? 1.2 : state.rtBounceStrength < 1.45 ? 1.65 : 0.75;
        state.screenDirty = true;
        return { hit: true, action: `lights:rt_strength_${state.rtBounceStrength}`, lightingChanged: true };
      }
    }
  }

  // 5. ESPELHOS (MOTORIZED MIRROR CONTROL) TAB
  if (state.activeTab === 'mirrors') {
    // Left Half (x: 0.03..0.49): Mirror Selector (L / C / R) + Power Fold + Reset
    if (x >= 0.03 && x <= 0.49) {
      // Mirror selector buttons (y: 0.20..0.52)
      if (y >= 0.20 && y <= 0.52) {
        if (x < 0.19) {
          state.selectedMirror = 'left';
          state.screenDirty = true;
          return { hit: true, action: 'mirrors:select_left', mirrorsChanged: true };
        }
        if (x < 0.34) {
          state.selectedMirror = 'interior';
          state.screenDirty = true;
          return { hit: true, action: 'mirrors:select_interior', mirrorsChanged: true };
        }
        state.selectedMirror = 'right';
        state.screenDirty = true;
        return { hit: true, action: 'mirrors:select_right', mirrorsChanged: true };
      }
      // Power Fold button (y: 0.55..0.68)
      if (y >= 0.55 && y <= 0.68) {
        state.mirrorsFolded = !state.mirrorsFolded;
        state.screenDirty = true;
        return {
          hit: true,
          action: `mirrors:fold_${state.mirrorsFolded ? 'in' : 'out'}`,
          mirrorsChanged: true,
        };
      }
      // Reset / Center all mirrors (y: 0.70..0.82)
      if (y >= 0.70 && y <= 0.82) {
        resetMirrors(state);
        return { hit: true, action: 'mirrors:reset', mirrorsChanged: true };
      }
    }

    // Right Half (x: 0.51..0.97): Precision 4-Way Directional D-Pad (y: 0.18..0.82)
    if (x >= 0.51 && x <= 0.97 && y >= 0.18 && y <= 0.82) {
      const cx = 0.74;
      const cy = 0.48;
      const dx = x - cx;
      const dy = y - cy;

      // Center bullseye resets active mirror
      if (Math.hypot(dx, dy) < 0.068) {
        state.mirrors[state.selectedMirror].yawRad = 0;
        state.mirrors[state.selectedMirror].pitchRad = 0;
        state.screenDirty = true;
        return { hit: true, action: `mirrors:center_${state.selectedMirror}`, mirrorsChanged: true };
      }

      if (Math.abs(dx) > Math.abs(dy)) {
        // Horizontal arrow: Left (-X on screen -> look further left/outward +yaw) vs Right (-yaw)
        const dir = dx < 0 ? 1 : -1;
        adjustSelectedMirror(state, dir * MIRROR_ADJUST_STEP_RAD, 0);
        return {
          hit: true,
          action: dx < 0 ? 'mirrors:aim_left' : 'mirrors:aim_right',
          mirrorsChanged: true,
        };
      } else {
        // Vertical arrow: Up (dy < 0 -> +pitch) vs Down (dy > 0 -> -pitch)
        const dir = dy < 0 ? 1 : -1;
        adjustSelectedMirror(state, 0, dir * MIRROR_ADJUST_STEP_RAD);
        return {
          hit: true,
          action: dy < 0 ? 'mirrors:aim_up' : 'mirrors:aim_down',
          mirrorsChanged: true,
        };
      }
    }
  }

  // 6. Settings / Config Tab quick vehicle controls (Wipers, Climate, 4x4, Repair)
  if (state.activeTab === 'settings') {
    if (y >= 0.18 && y <= 0.36) {
      state.wiperMode = cycleWiperMode(state.wiperMode);
      state.screenDirty = true;
      return { hit: true, action: `settings:wiper_${state.wiperMode}`, toggleWipers: true };
    }
    if (y >= 0.38 && y <= 0.56) {
      if (x < 0.33) {
        state.cabinTempC = Math.max(16, state.cabinTempC - 1);
        state.screenDirty = true;
        return { hit: true, action: 'climate:temp_down' };
      }
      if (x < 0.66) {
        state.cabinTempC = Math.min(28, state.cabinTempC + 1);
        state.screenDirty = true;
        return { hit: true, action: 'climate:temp_up' };
      }
      state.acOn = !state.acOn;
      state.screenDirty = true;
      return { hit: true, action: 'climate:ac' };
    }
    if (y >= 0.58 && y <= 0.78) {
      if (x < 0.5) {
        state.screenDirty = true;
        return { hit: true, action: 'settings:drive_mode', toggleDriveMode: true };
      }
      state.screenDirty = true;
      return { hit: true, action: 'settings:repair', triggerRepair: true };
    }
  }

  return { hit: true, action: 'screen:tap' };
}
