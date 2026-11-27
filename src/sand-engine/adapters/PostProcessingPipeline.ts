/**
 * PostProcessingPipeline.ts
 * Quasi-Ray-Tracing / Quasi-Path-Tracing Linear HDR Post-Processing Stack:
 *  1. Linear HalfFloat HDR Scene RenderTarget with Hardware DepthTexture (zero extra geometry pass!)
 *  2. Ground-Truth Ambient Occlusion (`GTAOPass` reusing scene DepthTexture via `setGBuffer`)
 *  3. Custom Quasi-PT Composite Pass:
 *     - Jimenez 2016 Multi-Bounce Colored AO polynomial (preserves warm desert/paint bounce in crevices)
 *     - Screen-Space Contact Shadows (SSCS): 12-step (Hybrid) / 18-step (Ultra) IGN-dithered
 *       depth raymarching along view-space sun vector for razor-sharp tire/chassis/rock grounding
 *  4. Selective High-Threshold HDR Bloom (`UnrealBloomPass`, threshold 1.22)
 *  5. Unified Filmic Optical Output Pass:
 *     - Switchable Khronos PBR Neutral / AgX (default) vs ACES Filmic tone mapping
 *     - Exposure compensation + sun-aligned optical veiling glare + subtle lens vignette
 *     - Lightweight luma-adaptive FXAA edge smoothing + sRGB encoding
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import {
  computeEffectivePixelRatio,
  GraphicsQuality,
  ToneMappingMode,
} from '../core/SandParams';
import { getGraphicsQualityBudget } from '../core/GraphicsQualityBudget';

const QUASI_PT_COMPOSITE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const QUASI_PT_COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tSceneColor;
uniform sampler2D tSceneDepth;
uniform sampler2D tGtao;

uniform mat4 uProjMatrix;
uniform mat4 uInvProjMatrix;
uniform vec3 uSunDirView;
uniform vec3 uGroundBounce;
uniform vec2 uResolution;
uniform float uAoIntensity;
uniform float uContactShadowStrength;
uniform float uUseGtao;
uniform int uContactSteps;
uniform float uContactMaxDist;
uniform float uCompositeMaxDist;
uniform float uFramePhase;

// Interleaved Gradient Noise (Jimenez 2014) for artifact-free contact shadow jitter
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

vec3 reconstructViewPos(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = uInvProjMatrix * clip;
  return view.xyz / max(view.w, 1e-5);
}

// Jimenez et al. 2016 Multi-Bounce Ambient Occlusion approximation
// Preserves warm indirect bounce chroma in shadowed sand/terracotta instead of flat gray dimming
vec3 multiBounceAO(float ao, vec3 albedo) {
  vec3 a =  2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c =  2.7552 * albedo + 0.6903;
  return max(vec3(ao), ((ao * a + b) * ao + c) * ao);
}

float evalScreenSpaceContactShadow(vec2 uv, vec3 viewPos, float distCam) {
  if (uContactShadowStrength <= 0.005 || distCam > uContactMaxDist || uContactSteps <= 0) return 1.0;

  float distFade = 1.0 - smoothstep(uContactMaxDist * 0.55, uContactMaxDist, distCam);
  vec3 rayDir = uSunDirView;
  float maxRayDist = mix(0.42, 0.62, clamp(distCam / 14.0, 0.0, 1.0));
  float jitter = ign(gl_FragCoord.xy + vec2(uFramePhase * 11.3, uFramePhase * 7.1));

  // Project ray endpoints ONCE in clip space (replaces up to 36 mat4*vec4 per pixel with scalar interpolation!)
  vec3 viewEnd = viewPos + rayDir * maxRayDist;
  vec4 clipStart = uProjMatrix * vec4(viewPos, 1.0);
  vec4 clipEnd = uProjMatrix * vec4(viewEnd, 1.0);
  if (clipStart.w <= 0.001) return 1.0;
  // Clamp ray endpoint slightly in front of near plane if sun points behind camera
  if (clipEnd.w <= 0.05) {
    float denom = max(clipStart.w - clipEnd.w, 1e-4);
    float clampT = clamp((clipStart.w - 0.05) / denom, 0.0, 1.0);
    viewEnd = mix(viewPos, viewEnd, clampT);
    clipEnd = uProjMatrix * vec4(viewEnd, 1.0);
  }

  // Perspective projection scalars for exact viewZ reconstruction without uInvProjMatrix mat4 multiply
  float p22 = uProjMatrix[2][2];
  float p32 = uProjMatrix[3][2];

  // Scale depth thickness tolerance gracefully with camera distance
  float thickness = 0.055 + distCam * 0.0075;
  float selfBias = 0.018 + distCam * 0.0022;
  float invSteps = 1.0 / float(uContactSteps);
  float occlusion = 0.0;

  for (int i = 1; i <= 18; i++) {
    if (i > uContactSteps) break;
    float stepRatio = float(i) * invSteps;
    float edgeFade = 1.0 - smoothstep(0.65, 1.0, stepRatio);
    // Lossless early-out: edgeFade is monotonically non-increasing and thickFade <= 1.0,
    // so once occlusion >= edgeFade no later sample can ever increase occlusion.
    if (occlusion >= edgeFade || occlusion >= 0.985) break;

    float frac = (float(i) - 0.5 + jitter * 0.85) * invSteps;
    // Exact 3D ray interpolation: projection is linear in clip space, so mix(clipStart, clipEnd, frac)
    // matches mix(viewPos, viewEnd, frac) to machine precision with zero mat4 multiplies
    vec4 clipPos = mix(clipStart, clipEnd, frac);
    vec2 sUv = (clipPos.xy / max(clipPos.w, 1e-5)) * 0.5 + 0.5;
    if (sUv.x < 0.005 || sUv.x > 0.995 || sUv.y < 0.005 || sUv.y > 0.995) break;

    float sampleDepth = texture2D(tSceneDepth, sUv).r;
    if (sampleDepth >= 0.9999) continue;

    float sampleViewZ = mix(viewPos.z, viewEnd.z, frac);
    // OpenGL perspective projection: ndcZ = (p22 * vz + p32) / (-vz) => vz = -p32 / (ndcZ + p22)
    float ndcZ = sampleDepth * 2.0 - 1.0;
    float hitViewZ = -p32 / (ndcZ + p22);

    // In view space, -Z is forward: closer surface has larger (less negative) z
    float dz = hitViewZ - sampleViewZ;
    if (dz > selfBias && dz < thickness) {
      float thickFade = 1.0 - smoothstep(thickness * 0.55, thickness, dz);
      occlusion = max(occlusion, edgeFade * thickFade);
    }
  }

  return 1.0 - occlusion * uContactShadowStrength * distFade;
}

void main() {
  vec4 sceneSample = texture2D(tSceneColor, vUv);
  vec3 color = sceneSample.rgb;
  float depth = texture2D(tSceneDepth, vUv).r;

  // Sky / far background pixels: pass straight through untouched
  if (depth >= 0.99985) {
    gl_FragColor = vec4(color, 1.0);
    return;
  }

  vec3 viewPos = reconstructViewPos(vUv, depth);
  float distCam = length(viewPos);

  // Far-horizon early-out: beyond compositeMaxDist both GTAO and SSCS fade to 0, skipping extra texture fetches
  if (distCam > uCompositeMaxDist) {
    gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
    return;
  }

  // 1. Multi-Bounce GTAO (preserves rich indirect warm bounce in tight cavities)
  if (uUseGtao > 0.5 && uAoIntensity > 0.005) {
    float rawAo = texture2D(tGtao, vUv).r;
    // Fade GTAO smoothly in deep fog distance so distant dunes never darken
    float aoRange = 1.0 - smoothstep(uCompositeMaxDist * 0.42, uCompositeMaxDist, distCam);
    float shapedAo = clamp(pow(clamp(rawAo, 0.08, 1.0), 1.0 + uAoIntensity * 0.45), 0.14, 1.0);
    float effAo = mix(1.0, shapedAo, clamp(uAoIntensity * 0.78 * aoRange, 0.0, 1.0));

    // Estimate local diffuse surface chroma (normalized, capped below 1.0) for Jimenez multi-bounce
    float lum = max(dot(color, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
    vec3 estAlbedo = clamp(mix(color / max(lum, 0.45), uGroundBounce * 1.4, 0.35), 0.04, 0.85);
    vec3 mbAo = multiBounceAO(effAo, estAlbedo);

    // Subtle indirect warm ground-bounce fill in occluded zones
    color *= mbAo;
    color += uGroundBounce * ((1.0 - effAo) * 0.022 * aoRange);
  }

  // 2. Screen-Space Contact Shadows (micro grounding for tires, suspension links, rocks)
  float contactVis = evalScreenSpaceContactShadow(vUv, viewPos, distCam);
  // Tint contact shadows slightly cool-warm rather than pitch black
  vec3 contactTint = mix(vec3(0.56, 0.58, 0.64), vec3(1.0), contactVis);
  color *= contactTint;

  gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
}
`;

const OPTICAL_OUTPUT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const OPTICAL_OUTPUT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform vec2 uInvResolution;
uniform float uExposure;
uniform float uToneMapMode; // 0.0 = AgX, 1.0 = ACES Filmic
uniform vec2 uSunScreenPos;
uniform float uSunVisibility;
uniform vec3 uSunGlowColor;
uniform float uEnableFxaa;

// Official Rec.2020 AgX Tone Mapping (linear-sRGB in -> linear-sRGB out; prefixed to avoid Three.js chunk collisions)
vec3 dfAgxContrastApprox(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return + 15.5     * x4 * x2
         - 40.14    * x4 * x
         + 31.96    * x4
         - 6.868    * x2 * x
         + 0.4298   * x2
         + 0.1191   * x
         - 0.00232;
}

vec3 dfToneMapAgX(vec3 color) {
  // Pre-multiplied (agxInset * srgbToRec2020) eliminates one 3x3 matrix multiply per pixel
  const mat3 srgbToAgxInset = mat3(
    vec3(0.54481475, 0.14041695, 0.08881042),
    vec3(0.37378740, 0.75413756, 0.17887176),
    vec3(0.08139785, 0.10544549, 0.73231782)
  );
  const mat3 rec2020ToSrgb = mat3(
    vec3(1.6605, -0.1246, -0.0182),
    vec3(-0.5876, 1.1329, -0.1006),
    vec3(-0.0728, -0.0083, 1.1187)
  );
  const mat3 agxOutset = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
  );
  const float agxMinEv = -12.47393;
  const float agxMaxEv = 4.026069;

  color = max(color, vec3(0.0));
  color = srgbToAgxInset * color;
  color = max(color, vec3(1e-10));
  color = log2(color);
  color = clamp((color - agxMinEv) / (agxMaxEv - agxMinEv), 0.0, 1.0);
  color = dfAgxContrastApprox(color);
  color = agxOutset * color;
  // Convert AgX display-encoded curve back to linear before Rec.2020 -> sRGB
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = rec2020ToSrgb * color;
  // Subtle punchy automotive saturation preservation
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, 1.06);
  return clamp(color, 0.0, 1.0);
}

vec3 dfToneMapACES(vec3 x) {
  x = max(x, vec3(0.0));
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 applyToneAndGamma(vec3 hdr) {
  vec3 exposed = hdr * uExposure;
  vec3 mapped = (uToneMapMode < 0.5) ? dfToneMapAgX(exposed) : dfToneMapACES(exposed);
  return pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2));
}

float reinhardLuma(vec3 c) {
  float l = max(0.0, dot(c, vec3(0.299, 0.587, 0.114)));
  return l / (1.0 + l);
}

void main() {
  vec3 hdrC = texture2D(tDiffuse, vUv).rgb;

  // Lightweight 5-tap FXAA in linear HDR before tone mapping for smooth vehicle chrome/cable silhouettes
  if (uEnableFxaa > 0.5) {
    vec2 dx = vec2(uInvResolution.x, 0.0);
    vec2 dy = vec2(0.0, uInvResolution.y);
    vec3 hdrNW = texture2D(tDiffuse, vUv - dx - dy).rgb;
    vec3 hdrNE = texture2D(tDiffuse, vUv + dx - dy).rgb;
    vec3 hdrSW = texture2D(tDiffuse, vUv - dx + dy).rgb;
    vec3 hdrSE = texture2D(tDiffuse, vUv + dx + dy).rgb;

    float lC  = reinhardLuma(hdrC);
    float lNW = reinhardLuma(hdrNW);
    float lNE = reinhardLuma(hdrNE);
    float lSW = reinhardLuma(hdrSW);
    float lSE = reinhardLuma(hdrSE);

    float lMin = min(lC, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lC, max(max(lNW, lNE), max(lSW, lSE)));
    float contrast = lMax - lMin;

    if (contrast > max(0.045, lMax * 0.12)) {
      vec2 dir;
      dir.x = -((lNW + lNE) - (lSW + lSE));
      dir.y =  ((lNW + lSW) - (lNE + lSE));
      float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
      float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
      dir = clamp(dir * rcpDirMin, vec2(-4.0), vec2(4.0)) * uInvResolution;

      vec3 rgbA = 0.5 * (
        texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
        texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb
      );
      vec3 rgbB = rgbA * 0.5 + 0.25 * (
        texture2D(tDiffuse, vUv + dir * -0.5).rgb +
        texture2D(tDiffuse, vUv + dir *  0.5).rgb
      );
      float lB = reinhardLuma(rgbB);
      hdrC = (lB < lMin || lB > lMax) ? rgbA : rgbB;
    }
  }

  // Subtle physical sun-aligned optical veiling glare when facing near the sun
  if (uSunVisibility > 0.01) {
    vec2 toSun = vUv - uSunScreenPos;
    toSun.x *= uInvResolution.y / max(uInvResolution.x, 1e-5);
    float dSun = length(toSun);
    float veil = exp(-dSun * 3.8) * 0.11 + exp(-dSun * 14.0) * 0.18;
    hdrC += uSunGlowColor * (veil * uSunVisibility);
  }

  vec3 srgb = applyToneAndGamma(hdrC);

  // Very gentle optical lens vignette
  vec2 vigUv = vUv * 2.0 - 1.0;
  float vig = 1.0 - dot(vigUv, vigUv) * 0.085;
  srgb *= clamp(vig, 0.84, 1.0);

  gl_FragColor = vec4(srgb, 1.0);
}
`;

export interface PostProcessRenderParams {
  sunDirWorld: THREE.Vector3;
  sunGlowColor: THREE.Color;
  groundBounce: THREE.Color;
  aoIntensity: number;
  exposure: number;
  toneMappingMode: ToneMappingMode;
  sceneGeometryDynamic?: boolean;
  /** Optional lossless GTAO update cadence (1 = every frame, 2 = every 2nd frame, 3 = every 3rd frame) */
  gtaoCadence?: 1 | 2 | 3;
}

const _sunDirView = new THREE.Vector3();
const _sunProjPos = new THREE.Vector3();
const _normalMat = new THREE.Matrix3();

export class PostProcessingPipeline {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly isSoftwareGl: boolean;
  private readonly isMobile: boolean;

  private quality: GraphicsQuality;
  private width: number;
  private height: number;
  private frameCounter = 0;
  private gtaoCacheValid = false;
  private readonly lastGtaoCamMatrix = new Float32Array(16);
  private readonly lastGtaoProjMatrix = new Float32Array(16);

  private sceneTarget: THREE.WebGLRenderTarget;
  private sceneDepthTexture: THREE.DepthTexture;
  private composer: EffectComposer;
  private gtaoPass: GTAOPass;
  private compositePass: ShaderPass;
  private bloomPass: UnrealBloomPass;
  private outputPass: ShaderPass;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    isSoftwareGl: boolean,
    initialQuality: GraphicsQuality,
    isMobile = false,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.isSoftwareGl = isSoftwareGl;
    this.isMobile = isMobile;
    this.quality = isSoftwareGl ? 'low' : initialQuality;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);

    const pr = this.getEffectivePixelRatio();
    const rw = Math.max(1, Math.floor(this.width * pr));
    const rh = Math.max(1, Math.floor(this.height * pr));

    // 1. Primary Linear HDR RenderTarget with hardware DepthTexture
    this.sceneDepthTexture = new THREE.DepthTexture(rw, rh);
    this.sceneDepthTexture.format = THREE.DepthStencilFormat;
    this.sceneDepthTexture.type = THREE.UnsignedInt248Type;

    this.sceneTarget = new THREE.WebGLRenderTarget(rw, rh, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: this.sceneDepthTexture,
    });

    const budget = getGraphicsQualityBudget(this.quality, this.isMobile, this.isSoftwareGl);

    // 2. GTAO Pass reusing sceneDepthTexture (zero second geometry pass!)
    this.gtaoPass = new GTAOPass(
      scene,
      camera,
      Math.max(1, Math.floor(rw * budget.gtaoScale)),
      Math.max(1, Math.floor(rh * budget.gtaoScale)),
      { depthTexture: this.sceneDepthTexture },
    );
    this.gtaoPass.updateGtaoMaterial({
      radius: budget.gtaoRadius,
      distanceExponent: 1.85,
      thickness: 1.6,
      distanceFallOff: 0.9,
      scale: 1.05,
      samples: budget.gtaoSamples,
    });
    this.gtaoPass.updatePdMaterial({
      lumaPhi: 10,
      depthPhi: 2.2,
      normalPhi: 3.0,
      radius: budget.gtaoPdRadius,
      rings: budget.gtaoPdRings,
      samples: budget.gtaoPdSamples,
    });
    this.gtaoPass.output = GTAOPass.OUTPUT.Off;
    this.gtaoPass.needsSwap = false;

    // 3. EffectComposer (HalfFloat HDR ping-pong)
    const composerRT = new THREE.WebGLRenderTarget(rw, rh, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.composer = new EffectComposer(renderer, composerRT);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this.width, this.height);

    // 4. Custom Quasi-PT Composite Pass (Jimenez Multi-Bounce AO + SS Contact Shadows)
    // Pass null for RenderTarget textures in ShaderPass descriptor to avoid Three.js UniformsUtils.clone warnings,
    // then bind the live texture references right after ShaderPass instantiation!
    this.compositePass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        tSceneColor: { value: null },
        tSceneDepth: { value: null },
        tGtao: { value: null },
        uProjMatrix: { value: new THREE.Matrix4() },
        uInvProjMatrix: { value: new THREE.Matrix4() },
        uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
        uGroundBounce: { value: new THREE.Color(0.55, 0.28, 0.12) },
        uResolution: { value: new THREE.Vector2(rw, rh) },
        uAoIntensity: { value: 1.0 },
        uContactShadowStrength: { value: budget.sscsStrength },
        uUseGtao: { value: 1.0 },
        uContactSteps: { value: budget.sscsSteps },
        uContactMaxDist: { value: budget.sscsMaxDist },
        uCompositeMaxDist: { value: budget.compositeMaxDist },
        uFramePhase: { value: 0.0 },
      },
      vertexShader: QUASI_PT_COMPOSITE_VERT,
      fragmentShader: QUASI_PT_COMPOSITE_FRAG,
    });
    this.compositePass.uniforms.tSceneColor.value = this.sceneTarget.texture;
    this.compositePass.uniforms.tSceneDepth.value = this.sceneDepthTexture;
    this.compositePass.uniforms.tGtao.value = this.gtaoPass.gtaoMap;
    this.compositePass.material.toneMapped = false;
    this.composer.addPass(this.compositePass);

    // 5. Selective High-Threshold HDR Bloom (quarter-res in Hybrid = 4x fewer blur pixels, half-res in Ultra)
    const bloomW = Math.max(1, Math.floor(rw * budget.bloomScale));
    const bloomH = Math.max(1, Math.floor(rh * budget.bloomScale));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(bloomW, bloomH),
      budget.bloomStrength,
      0.42,
      1.24,
    );
    this.composer.addPass(this.bloomPass);
    this.bloomPass.setSize(bloomW, bloomH);

    // 6. Optical Output Pass (AgX/ACES + Sun Veiling Glare + FXAA + Vignette + sRGB)
    this.outputPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uInvResolution: { value: new THREE.Vector2(1 / rw, 1 / rh) },
        uExposure: { value: 1.05 },
        uToneMapMode: { value: 0.0 },
        uSunScreenPos: { value: new THREE.Vector2(0.5, 0.5) },
        uSunVisibility: { value: 0.0 },
        uSunGlowColor: { value: new THREE.Color(1.0, 0.65, 0.3) },
        uEnableFxaa: { value: 1.0 },
      },
      vertexShader: OPTICAL_OUTPUT_VERT,
      fragmentShader: OPTICAL_OUTPUT_FRAG,
    });
    this.outputPass.material.toneMapped = false;
    this.composer.addPass(this.outputPass);

    this.applyQualitySettings();
  }

  private getEffectivePixelRatio(): number {
    return computeEffectivePixelRatio(
      this.width,
      window.devicePixelRatio || 1,
      this.isSoftwareGl,
      this.quality,
    );
  }

  public isActive(): boolean {
    return !this.isSoftwareGl && this.quality !== 'low';
  }

  public setQuality(next: GraphicsQuality): void {
    const effective: GraphicsQuality = this.isSoftwareGl ? 'low' : next;
    if (effective === this.quality) return;
    this.quality = effective;
    this.applyQualitySettings();
    this.resize(this.width, this.height);
  }

  private applyQualitySettings(): void {
    const budget = getGraphicsQualityBudget(this.quality, this.isMobile, this.isSoftwareGl);
    this.gtaoPass.updateGtaoMaterial({
      samples: budget.gtaoSamples,
      radius: budget.gtaoRadius,
    });
    this.gtaoPass.updatePdMaterial({
      samples: budget.gtaoPdSamples,
      rings: budget.gtaoPdRings,
      radius: budget.gtaoPdRadius,
    });
    this.compositePass.uniforms.uContactSteps.value = budget.sscsSteps;
    this.compositePass.uniforms.uContactMaxDist.value = budget.sscsMaxDist;
    this.compositePass.uniforms.uContactShadowStrength.value = budget.sscsStrength;
    this.compositePass.uniforms.uCompositeMaxDist.value = budget.compositeMaxDist;
    this.bloomPass.strength = budget.bloomStrength;
    this.bloomPass.threshold = 1.24;
  }

  public resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const budget = getGraphicsQualityBudget(this.quality, this.isMobile, this.isSoftwareGl);
    const pr = this.getEffectivePixelRatio();
    const rw = Math.max(1, Math.floor(this.width * pr));
    const rh = Math.max(1, Math.floor(this.height * pr));

    this.sceneTarget.setSize(rw, rh);
    this.gtaoPass.setSize(
      Math.max(1, Math.floor(rw * budget.gtaoScale)),
      Math.max(1, Math.floor(rh * budget.gtaoScale)),
    );
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this.width, this.height);
    // EffectComposer.setSize propagates full resolution to all passes — restore budget-scaled Bloom!
    this.bloomPass.setSize(
      Math.max(1, Math.floor(rw * budget.bloomScale)),
      Math.max(1, Math.floor(rh * budget.bloomScale)),
    );

    this.compositePass.uniforms.uResolution.value.set(rw, rh);
    this.outputPass.uniforms.uInvResolution.value.set(1 / rw, 1 / rh);
    this.gtaoCacheValid = false;
  }

  public invalidateGtaoCache(): void {
    this.gtaoCacheValid = false;
  }

  private checkCameraChangedForGtao(): boolean {
    const cw = this.camera.matrixWorld.elements;
    const cp = this.camera.projectionMatrix.elements;
    let changed = !this.gtaoCacheValid;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(cw[i] - this.lastGtaoCamMatrix[i]) > 1e-5 || Math.abs(cp[i] - this.lastGtaoProjMatrix[i]) > 1e-5) {
        changed = true;
      }
      this.lastGtaoCamMatrix[i] = cw[i];
      this.lastGtaoProjMatrix[i] = cp[i];
    }
    return changed;
  }

  public render(params: PostProcessRenderParams): void {
    if (!this.isActive()) {
      this.renderer.toneMapping =
        params.toneMappingMode === 'agx'
          ? THREE.AgXToneMapping
          : THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = params.exposure;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.frameCounter = (this.frameCounter + 1) % 64;

    // 1. Render main scene in linear HDR into sceneTarget + DepthTexture
    //    (renderer.autoClear is true by default — skip redundant explicit renderer.clear())
    this.renderer.setRenderTarget(this.sceneTarget);
    if (!this.renderer.autoClear) {
      this.renderer.clear();
    }
    this.renderer.render(this.scene, this.camera);

    // 2. Run GTAO reusing sceneDepthTexture (zero extra scene draw calls, skip when depth
    //    is bit-for-bit static, and optionally amortize cadence under sustained GPU load)
    const useGtao = params.aoIntensity > 0.01;
    if (useGtao) {
      const cadence = params.gtaoCadence ?? 1;
      const cacheWasValid = this.gtaoCacheValid;
      const camChanged = this.checkCameraChangedForGtao();
      const needsUpdate = !cacheWasValid || camChanged || params.sceneGeometryDynamic !== false;
      const cadenceAllows = !cacheWasValid || cadence <= 1 || this.frameCounter % cadence === 0;
      if (needsUpdate && cadenceAllows) {
        this.gtaoPass.render(this.renderer, this.sceneTarget, this.sceneTarget, 0, false);
        this.gtaoCacheValid = true;
      }
    }

    // 3. Sync camera & sun uniforms into Quasi-PT Composite Pass
    const cu = this.compositePass.uniforms;
    cu.tSceneColor.value = this.sceneTarget.texture;
    cu.tSceneDepth.value = this.sceneDepthTexture;
    cu.tGtao.value = this.gtaoPass.gtaoMap;
    cu.uProjMatrix.value.copy(this.camera.projectionMatrix);
    cu.uInvProjMatrix.value.copy(this.camera.projectionMatrixInverse);

    _normalMat.setFromMatrix4(this.camera.matrixWorldInverse);
    _sunDirView.copy(params.sunDirWorld).applyMatrix3(_normalMat).normalize();
    cu.uSunDirView.value.copy(_sunDirView);
    cu.uGroundBounce.value.copy(params.groundBounce);
    cu.uAoIntensity.value = params.aoIntensity;
    cu.uUseGtao.value = useGtao ? 1.0 : 0.0;
    cu.uFramePhase.value = this.frameCounter;

    // 4. Sync sun screen-space coordinates for subtle optical veiling glare
    _sunProjPos.copy(this.camera.position).addScaledVector(params.sunDirWorld, 400);
    _sunProjPos.project(this.camera);
    const sunInFront = _sunDirView.z < -0.15;
    const sunVis = sunInFront
      ? THREE.MathUtils.clamp((-_sunDirView.z - 0.15) * 1.4, 0, 1) *
        THREE.MathUtils.clamp(1.0 - Math.hypot(_sunProjPos.x, _sunProjPos.y) * 0.45, 0, 1)
      : 0;

    const ou = this.outputPass.uniforms;
    ou.uExposure.value = params.exposure;
    ou.uToneMapMode.value = params.toneMappingMode === 'agx' ? 0.0 : 1.0;
    ou.uSunScreenPos.value.set(_sunProjPos.x * 0.5 + 0.5, _sunProjPos.y * 0.5 + 0.5);
    ou.uSunVisibility.value = sunVis;
    ou.uSunGlowColor.value.copy(params.sunGlowColor);

    // 5. Execute Composite -> Bloom -> Optical Output to screen
    this.composer.render();
  }

  public dispose(): void {
    this.gtaoPass.dispose();
    this.bloomPass.dispose();
    this.compositePass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
    this.sceneTarget.dispose();
    this.sceneDepthTexture.dispose();
  }
}
