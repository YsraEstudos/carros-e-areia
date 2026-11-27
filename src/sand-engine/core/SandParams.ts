/**
 * SandParams.ts
 * Engine-agnostic physical constants and configuration for the real-time
 * deformable sand simulation pipeline.
 *
 * Units: SI (meters, seconds, kilograms, Newtons, radians).
 */

export const SAND_DEFAULTS = {
  /** Resolution of each toroidal RGBA16F cascade (512x512 = 4 MB per ping-pong pair, 8 MB total) */
  CASCADE_RESOLUTION: 512,
  /** Cascade 0 (Detail): 32 m x 32 m (~3.1 cm/texel on 1024² GPU, ~6.2 cm/texel on 512² SW-GL) */
  CASCADE0_SIZE: 32.0,
  /** Cascade 1 (Range): 128 m x 128 m (~12.5 cm/texel on 1024² GPU — 64 m persistent track radius in every direction!) */
  CASCADE1_SIZE: 128.0,
  /** Crossfade margin on outer 22% of Cascade 0 into Cascade 1 for an invisible seam */
  CASCADE_CROSSFADE_FRACTION: 0.22,
  /** Guard band in texels cleared along outer toroidal edge to prevent bilinear wrap bleed */
  TOROIDAL_GUARD_TEXELS: 2,

  /** Normalization ceiling for depression/berm height channels (0.25 m max rut depth) */
  MAX_DEPTH_METERS: 0.25,

  /** Dry quartz sand angle of repose: 33 deg -> tan(33 deg) ~= 0.6494 */
  ANGLE_OF_REPOSE_DEG: 33.0,
  TAN_ANGLE_OF_REPOSE: Math.tan((33.0 * Math.PI) / 180.0),

  /** Anisotropic avalanche slump rates */
  BASE_SLUMP_RATE: 0.28,
  /** Loose displaced berms slump ~3x faster than compacted groove floors */
  BERM_ANISOTROPY_FACTOR: 3.0,
  /** Compacted grains resist slumping */
  COMPRESSION_STABILITY_FACTOR: 0.72,

  /** Fixed granular relaxation tick rate (30 Hz amortized across alternating cascades) */
  RELAXATION_HZ: 30.0,
  /** Auto-sleep timeout (seconds) with zero active brushes and negligible residual slope energy */
  SLEEP_TIMEOUT_SECONDS: 3.0,
  /** Residual activity epsilon below which relaxation may sleep */
  SLEEP_ENERGY_EPSILON: 0.0008,

  /** Maximum simultaneous active swept brushes per frame (64 x 64 bytes = 4 KB std140) */
  MAX_BRUSHES: 64,
  /** Floats per brush (4 x vec4 = 16 floats = 64 bytes) */
  BRUSH_STRIDE_FLOATS: 16,

  /** Bekker / SCM surrogate terramechanics parameters (dry loose desert sand) */
  BEKKER_KC: 1200.0,      // Cohesive modulus (N / m^(n+1))
  BEKKER_KPHI: 820000.0,  // Frictional modulus (N / m^(n+2))
  BEKKER_N: 1.1,          // Sinkage exponent (typical dry sand: 1.0 - 1.15)
  SLIP_SINKAGE_GAIN: 1.45, // Additional sinkage multiplier under wheelspin
  TRACK_COMPACTION_RELIEF: 0.58, // Sinkage reduction when following a compacted rut
  BULLDOZING_COEFF: 2400.0, // Lateral bulldozing force coefficient (N/m^2)
  RING_BUFFER_CAPACITY: 512,

  /** Foot IK grounding sinkage bounds (2 cm to 6 cm) */
  FOOT_MIN_SINKAGE: 0.02,
  FOOT_MAX_SINKAGE: 0.06,

  /** Sloppy mud ("lama rala") rheology & terramechanics parameters */
  MUD_ANGLE_OF_REPOSE_DEG: 15.0,
  MUD_TAN_ANGLE_OF_REPOSE: Math.tan((15.0 * Math.PI) / 180.0),
  MUD_STIFFNESS_SCALE: 0.48,
  MUD_SINKAGE_GAIN: 1.42,
  MUD_FOOT_MIN_SINKAGE: 0.032,
  MUD_FOOT_MAX_SINKAGE: 0.088,
} as const;

export type EnvironmentBiome = 'rainy_highway' | 'desert' | 'mud_grass';

export type DriveMode = '4H' | '4L';

export type WiperMode = 'off' | 'intermittent' | 'normal' | 'fast';

export type SandSurfacePreset = 'dry_dune' | 'damp_beach' | 'soft_erg';

export type DebugViewMode =
  | 'beauty'
  | 'toroidal_rgba'
  | 'normals_rnm'
  | 'wireframe_clipmap';

export type CameraMode =
  | 'chase'
  | 'cockpit'
  | 'fender'
  | 'gopro_rear'
  | 'orbit'
  | 'wheel_closeup'
  | 'foot_ik';

export type GlintQualityMode = 'quality' | 'performance';

export type GraphicsQuality = 'low' | 'hybrid' | 'ultra';

export type WeatherPreset =
  | 'rainy_mist'
  | 'golden_hour'
  | 'desert_noon'
  | 'sunset_blaze'
  | 'humid_overcast';

export type ToneMappingMode = 'agx' | 'aces';

export interface WeatherPresetSpec {
  id: WeatherPreset;
  label: string;
  sunElevationDeg: number;
  sunAzimuthDeg: number;
  fogDensityScale: number;
  exposure: number;
  headlightsOn: boolean;
  lightbarOn: boolean;
  isOvercast: boolean;
  /** RGB multipliers / overrides applied on top of biome lighting */
  sunColor: [number, number, number];
  skyColor: [number, number, number];
  groundBounce: [number, number, number];
  fogColor: [number, number, number];
  zenithSky: [number, number, number];
  midSky: [number, number, number];
  sunGlow: [number, number, number];
  sunIntensity: number;
  hemiIntensity: number;
}

export const WEATHER_PRESET_SPECS: Record<WeatherPreset, WeatherPresetSpec> = {
  rainy_mist: {
    id: 'rainy_mist',
    label: 'Chuva Matinal',
    sunElevationDeg: 7.5,
    sunAzimuthDeg: 117,
    fogDensityScale: 1.0,
    exposure: 1.06,
    headlightsOn: true,
    lightbarOn: false,
    isOvercast: true,
    sunColor: [1.18, 1.06, 0.96],
    skyColor: [0.68, 0.71, 0.74],
    groundBounce: [0.22, 0.21, 0.19],
    fogColor: [0.68, 0.70, 0.72],
    zenithSky: [0.56, 0.59, 0.62],
    midSky: [0.68, 0.70, 0.72],
    sunGlow: [0.95, 0.76, 0.62],
    sunIntensity: 1.65,
    hemiIntensity: 1.05,
  },
  golden_hour: {
    id: 'golden_hour',
    label: 'Golden Hour',
    sunElevationDeg: 14.0,
    sunAzimuthDeg: 252,
    fogDensityScale: 1.0,
    exposure: 1.05,
    headlightsOn: false,
    lightbarOn: false,
    isOvercast: false,
    sunColor: [1.92, 1.24, 0.76],
    skyColor: [0.27, 0.45, 0.78],
    groundBounce: [0.58, 0.25, 0.10],
    fogColor: [0.74, 0.48, 0.32],
    zenithSky: [0.09, 0.24, 0.56],
    midSky: [0.30, 0.43, 0.64],
    sunGlow: [1.08, 0.64, 0.26],
    sunIntensity: 3.15,
    hemiIntensity: 0.78,
  },
  desert_noon: {
    id: 'desert_noon',
    label: 'Meio-Dia',
    sunElevationDeg: 52.0,
    sunAzimuthDeg: 218,
    fogDensityScale: 0.76,
    exposure: 0.98,
    headlightsOn: false,
    lightbarOn: false,
    isOvercast: false,
    sunColor: [1.58, 1.46, 1.28],
    skyColor: [0.36, 0.58, 0.92],
    groundBounce: [0.64, 0.36, 0.18],
    fogColor: [0.78, 0.64, 0.49],
    zenithSky: [0.10, 0.32, 0.72],
    midSky: [0.38, 0.58, 0.82],
    sunGlow: [1.0, 0.90, 0.72],
    sunIntensity: 3.55,
    hemiIntensity: 0.88,
  },
  sunset_blaze: {
    id: 'sunset_blaze',
    label: 'Crepúsculo',
    sunElevationDeg: 6.5,
    sunAzimuthDeg: 268,
    fogDensityScale: 1.22,
    exposure: 1.12,
    headlightsOn: true,
    lightbarOn: true,
    isOvercast: false,
    sunColor: [2.15, 0.86, 0.36],
    skyColor: [0.16, 0.24, 0.48],
    groundBounce: [0.42, 0.16, 0.08],
    fogColor: [0.54, 0.28, 0.20],
    zenithSky: [0.04, 0.09, 0.26],
    midSky: [0.24, 0.20, 0.38],
    sunGlow: [1.28, 0.46, 0.14],
    sunIntensity: 2.55,
    hemiIntensity: 0.62,
  },
  humid_overcast: {
    id: 'humid_overcast',
    label: 'Nublado',
    sunElevationDeg: 28.0,
    sunAzimuthDeg: 235,
    fogDensityScale: 1.38,
    exposure: 1.04,
    headlightsOn: true,
    lightbarOn: false,
    isOvercast: true,
    sunColor: [0.98, 0.99, 1.0],
    skyColor: [0.56, 0.62, 0.68],
    groundBounce: [0.20, 0.17, 0.13],
    fogColor: [0.48, 0.52, 0.55],
    zenithSky: [0.34, 0.38, 0.43],
    midSky: [0.50, 0.54, 0.58],
    sunGlow: [0.42, 0.44, 0.46],
    sunIntensity: 1.48,
    hemiIntensity: 0.96,
  },
};

export type StressTestMode =
  | 'manual'
  | 'donuts'
  | 'sprint_150'
  | 'rollover_crash'
  | 'foot_ik_walk'
  | 'avalanche_park';

export interface SandRuntimeConfig {
  /** Active biome environment ('rainy_highway' default | 'desert' | 'mud_grass') */
  biome: EnvironmentBiome;
  /** Transfer case range: 4H (overland + turbo) vs 4L (low-range crawler + locked diffs) */
  driveMode: DriveMode;
  /** Rear differential lock status (displayed on Raptor digital cluster) */
  rearLocked: boolean;
  /** Windshield wiper operating speed */
  wiperMode: WiperMode;
  /** Rainfall density & road wetness intensity (0..1) */
  rainIntensity: number;
  /** Manual headlight toggle (auto-on in rainy mist / dusk) */
  headlightsOn: boolean;
  /** Tire inflation pressure in PSI (10 = aired-down sand flotation, 36 = stiff road tire) */
  tirePressurePsi: number;
  /** Procedural Web Audio turbo-diesel & sand/mud/rain foley toggle */
  audioEnabled: boolean;
  /** Avalanche relaxation rate multiplier (0..2.5) */
  avalancheRate: number;
  /** Wind infill speed multiplier (0..3.0) */
  windSpeed: number;
  /** Global wind azimuth in degrees */
  windAngleDeg: number;
  /** Subsurface moisture level (0 = bone-dry desert, 1 = damp coastal sand / saturated mud) */
  moisture: number;
  /** Sun elevation above horizon in degrees (6..75; 10 deg = grazing self-shadow stress test) */
  sunElevationDeg: number;
  /** Sun azimuth in degrees */
  sunAzimuthDeg: number;
  /** Enable/disable auto-sleep optimization */
  autoSleepEnabled: boolean;
  /** Glints quality: Deliot-Belcour derivative-filtered vs 2-octave mip-blended */
  glintQuality: GlintQualityMode;
  /** Active visualization mode */
  debugView: DebugViewMode;
  /** Active camera rig */
  cameraMode: CameraMode;
  /** Active stress test / autopilot mode */
  stressMode: StressTestMode;
  /** Time dilation for slow-motion Foot IK / roost inspection (0.2..1.0) */
  timeScale: number;
  /** Quasi-ray-tracing lighting & reflection quality tier */
  graphicsQuality: GraphicsQuality;
  /** Atmospheric weather & time-of-day lighting preset */
  weatherPreset: WeatherPreset;
  /** HDR filmic tone mapper ('agx' preserves automotive paint saturation vs 'aces') */
  toneMappingMode: ToneMappingMode;
  /** Dynamic car-body & glass reflection intensity multiplier (0.2..1.8) */
  reflectionIntensity: number;
  /** Ground-truth ambient occlusion & contact shadow intensity multiplier (0..1.5) */
  aoIntensity: number;
  /** Camera exposure compensation (0.7..1.4) */
  exposure: number;
  /** Liberate frame pacing beyond 60Hz VSync on real GPUs (desktop & mobile) */
  fpsUncapped: boolean;
}

export const DEFAULT_RUNTIME_CONFIG: SandRuntimeConfig = {
  biome: 'rainy_highway',
  driveMode: '4H',
  rearLocked: true,
  wiperMode: 'normal',
  rainIntensity: 0.78,
  headlightsOn: true,
  tirePressurePsi: 30,
  audioEnabled: true,
  avalancheRate: 0.75,
  windSpeed: 0.2,
  windAngleDeg: 32,
  moisture: 0.72,
  sunElevationDeg: 7.5,
  sunAzimuthDeg: 117,
  autoSleepEnabled: true,
  glintQuality: 'quality',
  debugView: 'beauty',
  cameraMode: 'chase',
  stressMode: 'manual',
  timeScale: 1.0,
  graphicsQuality: 'ultra',
  weatherPreset: 'rainy_mist',
  toneMappingMode: 'agx',
  reflectionIntensity: 1.12,
  aoIntensity: 1.0,
  exposure: 1.06,
  fpsUncapped: false,
};

/**
 * Pure detector distinguishing real mobile/tablet hardware from a desktop PC
 * running inside a narrow split-screen browser window or preview iframe.
 */
export function detectIsMobileDevice(
  userAgent: string,
  maxTouchPoints: number,
  hasCoarsePointer: boolean,
): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) {
    return true;
  }
  const isDesktopOs = /Windows|Macintosh|Win64|WOW64|X11|Linux x86_64/i.test(userAgent);
  if (isDesktopOs) {
    return false;
  }
  return hasCoarsePointer && maxTouchPoints > 0;
}

/**
 * Always initializes Desktop PCs in 'ultra' mode while keeping real mobile phones on 'hybrid'.
 */
export function getInitialGraphicsQuality(isMobileDevice: boolean): GraphicsQuality {
  return isMobileDevice ? 'hybrid' : 'ultra';
}

/**
 * Centralized DPR cap shared across WebGLRenderer, PostProcessingPipeline (GTAO/HDR),
 * and point-sprite particle uniforms so mobile orientation/resize stays 100% consistent.
 *
 * Quality-aware caps:
 *  - 'ultra' (default for backward compatibility): 1.5 mobile / 2.0 desktop
 *  - 'hybrid': 1.25 mobile / 1.5 desktop (44% lower HiDPI fill-rate with FXAA keeping edges crisp)
 *  - 'low': 1.0 mobile / 1.25 desktop
 */
export function computeEffectivePixelRatio(
  viewportWidth: number,
  devicePixelRatio: number,
  isSoftwareGl: boolean,
  quality: GraphicsQuality = 'ultra',
): number {
  if (isSoftwareGl) return 1;
  const safeDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const isNarrow = viewportWidth < 768;
  let cap: number;
  if (quality === 'low') {
    cap = isNarrow ? 1.0 : 1.25;
  } else if (quality === 'hybrid') {
    cap = isNarrow ? 1.25 : 1.5;
  } else {
    cap = isNarrow ? 1.5 : 2.0;
  }
  return Math.min(safeDpr, cap);
}
