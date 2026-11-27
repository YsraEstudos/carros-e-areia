/**
 * GraphicsQualityBudget.ts
 * Pure, engine-agnostic quality-tier performance budgets shared across
 * PostProcessingPipeline, VehicleReflectionSystem, DesertEnvironment,
 * GrassFieldSystem, RainyHighwayEnvironment, RivianVehicleBuilder, and terrainSand.
 *
 * Also contains the deterministic Rivian R1T GLB node classifier used for
 * layer assignment, visibility culling, and shadow-caster pruning.
 */

import { GraphicsQuality } from './SandParams';

export interface GraphicsQualityBudget {
  readonly quality: GraphicsQuality;
  /** DPR caps (applied identically to WebGLRenderer, EffectComposer, and particles) */
  readonly dprCapDesktop: number;
  readonly dprCapMobile: number;
  /** GTAO resolution scale & sampling parameters */
  readonly gtaoScale: number;
  readonly gtaoSamples: number;
  readonly gtaoRadius: number;
  readonly gtaoPdSamples: number;
  readonly gtaoPdRings: number;
  readonly gtaoPdRadius: number;
  /** Screen-space contact shadows & composite early-out distances */
  readonly sscsSteps: number;
  readonly sscsMaxDist: number;
  readonly sscsStrength: number;
  readonly compositeMaxDist: number;
  /** Selective HDR Bloom scale (0.25x in Hybrid = 4x fewer blur pixels than 0.5x!) */
  readonly bloomScale: number;
  readonly bloomStrength: number;
  /** Directional shadow map & terrain PCF sampling budget */
  readonly shadowMapSize: number;
  readonly shadowExtentChase: number;
  readonly shadowExtentClose: number;
  readonly shadowFar: number;
  /** 1 = fast 4-tap hardware PCF (16 hw comparisons), 0 = full 9-tap PCF */
  readonly terrainFastShadowPcf: boolean;
  readonly rainRippleMaxDist: number;
  /** Rear-view mirror & dynamic cubemap probe budgets */
  readonly mirrorMaxExteriorDist: number;
  readonly mirrorFar: number;
  readonly mirrorWingWidth: number;
  readonly mirrorWingHeight: number;
  readonly mirrorInteriorWidth: number;
  readonly mirrorInteriorHeight: number;
  readonly interleaveCockpitMirrors: boolean;
  readonly cubeSize: number;
  readonly cubeFacesPerFrame: number;
  readonly cubeMinMovedDistSq: number;
  readonly cubeMinCooldownFrames: number;
  readonly cubeFastMovedDistSq: number;
  readonly cubeFastCooldownFrames: number;
  /** Texture anisotropy cap for vehicle & environment textures */
  readonly maxTextureAnisotropy: number;
  /** Dynamic instance-count ratios (zero geometry rebuild on quality switch) */
  readonly grassDensityRatio: number;
  readonly rainStreakRatio: number;
}

const LOW_BUDGET: GraphicsQualityBudget = Object.freeze({
  quality: 'low',
  dprCapDesktop: 1.25,
  dprCapMobile: 1.0,
  gtaoScale: 0.35,
  gtaoSamples: 4,
  gtaoRadius: 0.6,
  gtaoPdSamples: 4,
  gtaoPdRings: 1,
  gtaoPdRadius: 3,
  sscsSteps: 0,
  sscsMaxDist: 0,
  sscsStrength: 0,
  compositeMaxDist: 45,
  bloomScale: 0.25,
  bloomStrength: 0.16,
  shadowMapSize: 512,
  shadowExtentChase: 14,
  shadowExtentClose: 10,
  shadowFar: 65,
  terrainFastShadowPcf: true,
  rainRippleMaxDist: 14,
  mirrorMaxExteriorDist: 0,
  mirrorFar: 120,
  mirrorWingWidth: 128,
  mirrorWingHeight: 120,
  mirrorInteriorWidth: 160,
  mirrorInteriorHeight: 44,
  interleaveCockpitMirrors: true,
  cubeSize: 64,
  cubeFacesPerFrame: 1,
  cubeMinMovedDistSq: 25,
  cubeMinCooldownFrames: 60,
  cubeFastMovedDistSq: 16,
  cubeFastCooldownFrames: 60,
  maxTextureAnisotropy: 1,
  grassDensityRatio: 0.52,
  rainStreakRatio: 0.45,
});

const ULTRA_DESKTOP_BUDGET: GraphicsQualityBudget = Object.freeze({
  quality: 'ultra',
  dprCapDesktop: 2.0,
  dprCapMobile: 1.5,
  gtaoScale: 0.8,
  gtaoSamples: 14,
  gtaoRadius: 0.8,
  gtaoPdSamples: 12,
  gtaoPdRings: 2,
  gtaoPdRadius: 6,
  sscsSteps: 16,
  sscsMaxDist: 34,
  sscsStrength: 0.58,
  compositeMaxDist: 76,
  bloomScale: 0.5,
  bloomStrength: 0.28,
  shadowMapSize: 2048,
  shadowExtentChase: 18,
  shadowExtentClose: 11,
  shadowFar: 95,
  terrainFastShadowPcf: false,
  rainRippleMaxDist: 38,
  mirrorMaxExteriorDist: 16.0,
  mirrorFar: 260,
  mirrorWingWidth: 240,
  mirrorWingHeight: 224,
  mirrorInteriorWidth: 256,
  mirrorInteriorHeight: 72,
  interleaveCockpitMirrors: false,
  cubeSize: 256,
  cubeFacesPerFrame: 3,
  cubeMinMovedDistSq: 0.25,
  cubeMinCooldownFrames: 1,
  cubeFastMovedDistSq: 0.16,
  cubeFastCooldownFrames: 1,
  maxTextureAnisotropy: 8,
  grassDensityRatio: 1.0,
  rainStreakRatio: 1.0,
});

function createHybridBudget(quality: GraphicsQuality, isMobile: boolean): GraphicsQualityBudget {
  return Object.freeze({
    quality,
    dprCapDesktop: 1.5,
    dprCapMobile: 1.25,
    gtaoScale: isMobile ? 0.4 : 0.45,
    gtaoSamples: isMobile ? 5 : 6,
    gtaoRadius: 0.68,
    gtaoPdSamples: isMobile ? 5 : 6,
    gtaoPdRings: 1,
    gtaoPdRadius: 4,
    sscsSteps: isMobile ? 5 : 7,
    sscsMaxDist: isMobile ? 16 : 22,
    sscsStrength: 0.48,
    compositeMaxDist: isMobile ? 52 : 66,
    bloomScale: 0.25,
    bloomStrength: 0.21,
    shadowMapSize: 1024,
    shadowExtentChase: 15,
    shadowExtentClose: 10.5,
    shadowFar: 72,
    terrainFastShadowPcf: true,
    rainRippleMaxDist: isMobile ? 16 : 22,
    mirrorMaxExteriorDist: 6.2,
    mirrorFar: 160,
    mirrorWingWidth: isMobile ? 128 : 144,
    mirrorWingHeight: isMobile ? 120 : 136,
    mirrorInteriorWidth: isMobile ? 168 : 192,
    mirrorInteriorHeight: isMobile ? 48 : 54,
    interleaveCockpitMirrors: true,
    cubeSize: 128,
    cubeFacesPerFrame: 2,
    cubeMinMovedDistSq: 0.64,
    cubeMinCooldownFrames: 2,
    cubeFastMovedDistSq: 0.36,
    cubeFastCooldownFrames: 2,
    maxTextureAnisotropy: isMobile ? 2 : 4,
    grassDensityRatio: isMobile ? 0.62 : 0.75,
    rainStreakRatio: isMobile ? 0.55 : 0.72,
  });
}

const HYBRID_DESKTOP_BUDGET: GraphicsQualityBudget = createHybridBudget('hybrid', false);
const HYBRID_MOBILE_BUDGET: GraphicsQualityBudget = createHybridBudget('hybrid', true);
const ULTRA_MOBILE_BUDGET: GraphicsQualityBudget = createHybridBudget('ultra', true);

export function getGraphicsQualityBudget(
  quality: GraphicsQuality,
  isMobile: boolean,
  isSoftwareGl: boolean,
): GraphicsQualityBudget {
  const effective: GraphicsQuality = isSoftwareGl ? 'low' : quality;

  if (effective === 'low') {
    return LOW_BUDGET;
  }

  if (effective === 'ultra') {
    return isMobile ? ULTRA_MOBILE_BUDGET : ULTRA_DESKTOP_BUDGET;
  }

  return isMobile ? HYBRID_MOBILE_BUDGET : HYBRID_DESKTOP_BUDGET;
}

export type RivianNodeRole =
  | 'sealed_cavity'
  | 'under_hood_bay'
  | 'under_hood_liner'
  | 'interior_micro'
  | 'interior_silhouette'
  | 'exterior_shadow'
  | 'exterior_noshadow';

const SEALED_CAVITY_PREFIXES = [
  'doorSill_a_',
  'doorJambLF_a_',
  'bodyCustomLLiner_a_',
  'storage_a_',
];

const INTERIOR_MICRO_PREFIXES = [
  'pedals_a_',
  'floor_a_',
  'centerConsoleStructure_a_',
  'dashStructure_a_',
  'seatBeltL_a_',
  'overheadConsole_a_',
];

const INTERIOR_SILHOUETTE_PREFIXES = [
  'seatL_a_',
  'rearSeats_a_',
  'dashPad_a_',
  'doorCardLF_a_',
  'doorCardLR_a_',
  'pillarTrim_a_',
  'steeringWheel_a_',
  'gaugeCluster_a_',
];

const SHADOW_CASTER_PREFIXES = [
  'body_a_',
  'fenders_a_',
  'hood_a_',
  'trunk_a_',
  'trunkBay_a_',
  'bumperF_a_',
  'bumperFCustom_a_',
  'bumperR_a_',
  'skirtL_a_',
  'wing_a_',
  'wingMirrorL_a_',
  'wingMirrorR_a_',
  'doorHandleLF_a_',
  'doorHandleLR_a_',
  'tyre_',
  'rim_',
];

/**
 * Classifies a Rivian R1T GLB mesh (by sanitized node name & material name) into its
 * rendering, culling, and shadow-casting role.
 *
 * Guarantees:
 *  - Pickup bed (`trunkBay_a_`, `trunkLiner_a_`) and front `grille_a_` remain exterior visible.
 *  - Interior rearview mirror (`overheadConsole_a_2_mirror_center`) is handled separately by caller.
 *  - Decals, labels, badges, glass, emitters, rotors, and calipers never waste shadow-map draw calls.
 */
export function classifyRivianNodeRole(
  normNodeName: string,
  materialName: string,
): RivianNodeRole {
  if (SEALED_CAVITY_PREFIXES.some((p) => normNodeName.startsWith(p))) {
    return 'sealed_cavity';
  }
  if (normNodeName.startsWith('engineBay_a_')) {
    return 'under_hood_bay';
  }
  if (normNodeName.startsWith('hoodLiner_a_')) {
    return 'under_hood_liner';
  }

  // Interior micro-details: invisible from outside the truck, only needed when inside Cockpit view
  if (
    INTERIOR_MICRO_PREFIXES.some((p) => normNodeName.startsWith(p)) ||
    materialName.includes('interior cutout') ||
    materialName.includes('carpet')
  ) {
    return 'interior_micro';
  }

  // Interior silhouette: visible through windows from outside + in cockpit, excluded from mirror/cube passes
  if (INTERIOR_SILHOUETTE_PREFIXES.some((p) => normNodeName.startsWith(p))) {
    return 'interior_silhouette';
  }

  // Exterior non-shadow-casters: glass, decals, labels, badges, emitters, small trim, rotors, calipers, wipers
  const isNoShadowMat =
    materialName.includes('window glass') ||
    materialName.includes('SF_glass') ||
    materialName.includes('Detail_Tail_Inner_Lens') ||
    materialName.includes('Detail_Clear_Projector') ||
    materialName.includes('Smart_Small_Decals') ||
    materialName.includes('mfr_badge') ||
    materialName.includes('emitter') ||
    materialName.includes('Cutout') ||
    materialName.includes('defrostlines') ||
    materialName.includes('LIT_DRL') ||
    materialName.includes('UNLIT_');

  const isNoShadowNode =
    normNodeName.includes('glass') ||
    normNodeName.includes('label_ch1') ||
    normNodeName.includes('MFR_Badge') ||
    normNodeName.includes('emitter') ||
    normNodeName.startsWith('RIV_rotor') ||
    normNodeName.startsWith('RIV_caliper') ||
    normNodeName.startsWith('wipers_a_') ||
    normNodeName.startsWith('headlight') ||
    normNodeName.startsWith('taillight') ||
    normNodeName.startsWith('foglight') ||
    normNodeName.startsWith('Platelight') ||
    normNodeName.startsWith('fenderssidemarkers') ||
    normNodeName.startsWith('bumperRsidemarkers') ||
    normNodeName.startsWith('grille_a_');

  if (isNoShadowMat || isNoShadowNode) {
    return 'exterior_noshadow';
  }

  // Primary structural silhouette & wheels cast crisp directional sun shadows
  if (SHADOW_CASTER_PREFIXES.some((p) => normNodeName.startsWith(p))) {
    // Only outer tire treads/sidewalls and primary rim faces cast shadows; skip tiny rim lug/label/chrome sub-meshes
    if (normNodeName.startsWith('rim_')) {
      const isMajorRim =
        normNodeName.includes('_0_') ||
        normNodeName.includes('_2_') ||
        normNodeName.includes('_9_');
      return isMajorRim ? 'exterior_shadow' : 'exterior_noshadow';
    }
    return 'exterior_shadow';
  }

  return 'exterior_noshadow';
}
