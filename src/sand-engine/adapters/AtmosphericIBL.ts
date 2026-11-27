/**
 * AtmosphericIBL.ts
 * Real-time procedural Atmospheric HDR Image-Based Lighting (PMREM) +
 * Analytical L2 Spherical Harmonics LightProbe.
 *
 * Replaces static indoor RoomEnvironment with a physically matched sky +
 * HDR solar disc + warm/cool terrain ground bounce dome so car paint, chrome,
 * and automotive glass reflect the actual desert sky, sun, and sand horizon.
 */

import * as THREE from 'three';
import { EnvironmentBiome, WeatherPreset, WEATHER_PRESET_SPECS } from '../core/SandParams';

export interface AtmosphericIBLUpdateParams {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  skyColor: THREE.Color;
  groundBounce: THREE.Color;
  fogColor: THREE.Color;
  biome: EnvironmentBiome;
  weather: WeatherPreset;
  force?: boolean;
}

export class AtmosphericIBL {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly pmremGenerator: THREE.PMREMGenerator;
  private readonly iblScene: THREE.Scene;
  private readonly domeGeo: THREE.SphereGeometry;
  private readonly domeMat: THREE.ShaderMaterial;
  private readonly domeMesh: THREE.Mesh;

  public readonly lightProbe: THREE.LightProbe;
  private currentEnvRT: THREE.WebGLRenderTarget | null = null;

  private readonly lastSunDir = new THREE.Vector3(0, 1, 0);
  private lastBiome: EnvironmentBiome | null = null;
  private lastWeather: WeatherPreset | null = null;
  private initialized = false;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.renderer = renderer;
    this.pmremGenerator = new THREE.PMREMGenerator(renderer);
    this.pmremGenerator.compileEquirectangularShader();

    this.iblScene = new THREE.Scene();
    this.domeGeo = new THREE.SphereGeometry(50, 32, 20);
    this.domeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0.5, 0.25, 0.8) },
        uSunColor: { value: new THREE.Color(1.9, 1.25, 0.76) },
        uZenithSky: { value: new THREE.Color(0.09, 0.24, 0.56) },
        uMidSky: { value: new THREE.Color(0.30, 0.43, 0.64) },
        uFogColor: { value: new THREE.Color(0.74, 0.48, 0.32) },
        uGroundBounce: { value: new THREE.Color(0.58, 0.25, 0.10) },
        uSunGlow: { value: new THREE.Color(1.08, 0.64, 0.26) },
        uIsOvercast: { value: 0.0 },
      },
      vertexShader: /* glsl */ `
        out vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec3 vDir;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uZenithSky;
        uniform vec3 uMidSky;
        uniform vec3 uFogColor;
        uniform vec3 uGroundBounce;
        uniform vec3 uSunGlow;
        uniform float uIsOvercast;
        out vec4 fragColor;

        float hash21(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
            mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }

        void main() {
          vec3 dir = normalize(vDir);
          vec3 L = normalize(uSunDir);
          float y = dir.y;

          // Upper hemisphere: Rayleigh sky gradient + Mie aureole + HDR solar disc
          float elev = max(y, 0.0);
          vec3 horizonCol = uFogColor * vec3(1.12, 0.98, 0.88);
          vec3 skyCol = mix(horizonCol, uMidSky, smoothstep(0.0, 0.18, elev));
          skyCol = mix(skyCol, uZenithSky, smoothstep(0.12, 0.62, elev));

          // Overcast soft cloud deck modulation
          if (uIsOvercast > 0.5) {
            vec2 cuv = dir.xz / (elev + 0.22);
            float cl = vnoise(cuv * 0.9) * 0.65 + vnoise(cuv * 2.4 + vec2(3.1, 7.4)) * 0.35;
            vec3 brightCloud = uMidSky * 1.48;
            vec3 darkCloud = uZenithSky * 0.72;
            skyCol = mix(darkCloud, brightCloud, smoothstep(0.25, 0.78, cl));
            skyCol = mix(uFogColor, skyCol, smoothstep(0.0, 0.20, elev));
          }

          // Solar aureole & crisp HDR sun disc (> 9.0 linear) for realistic paint clearcoat highlights
          float sunCos = max(dot(dir, L), 0.0);
          float aureole = pow(sunCos, 6.0) * 0.42 + pow(sunCos, 38.0) * 1.15;
          float sunDisc = smoothstep(0.9965, 0.9994, sunCos);
          float overcastDamp = mix(1.0, 0.22, uIsOvercast);
          skyCol += uSunGlow * aureole * overcastDamp;
          skyCol += uSunColor * sunDisc * mix(11.5, 1.8, uIsOvercast);

          // Lower hemisphere: distant dune/treeline horizon band + warm sunlit ground bounce
          float downT = clamp(-y, 0.0, 1.0);
          float duneRipple = 0.88 + 0.12 * sin(atan(dir.z, dir.x) * 6.0 + dir.x * 3.0);
          vec3 groundNear = uGroundBounce * mix(1.35, 0.85, uIsOvercast) * duneRipple;
          vec3 groundNadir = uGroundBounce * 0.52;
          vec3 groundCol = mix(groundNear, groundNadir, smoothstep(0.05, 0.65, downT));

          // Subtle dark horizon silhouette band (dunes or distant trees) for crisp automotive reflection contrast
          float horizonBand = exp(-pow((y + 0.015) * 26.0, 2.0));
          vec3 silhouetteCol = mix(uGroundBounce * 0.48, vec3(0.05, 0.07, 0.04), uIsOvercast);
          vec3 combined = mix(groundCol, skyCol, smoothstep(-0.025, 0.035, y));
          combined = mix(combined, silhouetteCol, horizonBand * 0.28);

          // Linear HDR radiance directly into PMREM
          fragColor = vec4(max(combined, vec3(0.0)), 1.0);
        }
      `,
    });

    this.domeMesh = new THREE.Mesh(this.domeGeo, this.domeMat);
    this.iblScene.add(this.domeMesh);

    this.lightProbe = new THREE.LightProbe();
    this.lightProbe.intensity = 0.55;
    scene.add(this.lightProbe);
  }

  public getEnvironmentTexture(): THREE.Texture | null {
    return this.currentEnvRT ? this.currentEnvRT.texture : null;
  }

  public update(scene: THREE.Scene, params: AtmosphericIBLUpdateParams): boolean {
    const sunDot = this.lastSunDir.dot(params.sunDir);
    const biomeChanged = this.lastBiome !== params.biome;
    const weatherChanged = this.lastWeather !== params.weather;

    if (!params.force && this.initialized && !biomeChanged && !weatherChanged && sunDot > 0.9985) {
      return false;
    }

    this.initialized = true;
    this.lastSunDir.copy(params.sunDir);
    this.lastBiome = params.biome;
    this.lastWeather = params.weather;

    const spec = WEATHER_PRESET_SPECS[params.weather];
    const isOvercast =
      params.biome === 'mud_grass' ||
      params.biome === 'rainy_highway' ||
      spec.isOvercast;

    const u = this.domeMat.uniforms;
    u.uSunDir.value.copy(params.sunDir);
    u.uSunColor.value.copy(params.sunColor);
    u.uFogColor.value.copy(params.fogColor);
    u.uGroundBounce.value.copy(params.groundBounce);
    u.uIsOvercast.value = isOvercast ? 1.0 : 0.0;

    if (params.biome === 'rainy_highway') {
      u.uZenithSky.value.setRGB(0.44, 0.48, 0.53);
      u.uMidSky.value.setRGB(0.62, 0.65, 0.68);
      u.uSunGlow.value.setRGB(0.74, 0.56, 0.46);
    } else if (params.biome === 'mud_grass') {
      u.uZenithSky.value.setRGB(0.32, 0.36, 0.40);
      u.uMidSky.value.setRGB(0.48, 0.52, 0.56);
      u.uSunGlow.value.setRGB(0.34, 0.36, 0.38);
    } else {
      u.uZenithSky.value.setRGB(spec.zenithSky[0], spec.zenithSky[1], spec.zenithSky[2]);
      u.uMidSky.value.setRGB(spec.midSky[0], spec.midSky[1], spec.midSky[2]);
      u.uSunGlow.value.setRGB(spec.sunGlow[0], spec.sunGlow[1], spec.sunGlow[2]);
    }

    const prevToneMapping = this.renderer.toneMapping;
    const prevRT = this.renderer.getRenderTarget();
    this.renderer.toneMapping = THREE.NoToneMapping;

    const nextRT = this.pmremGenerator.fromScene(this.iblScene, 0.024);

    this.renderer.toneMapping = prevToneMapping;
    this.renderer.setRenderTarget(prevRT);

    if (this.currentEnvRT) {
      this.currentEnvRT.dispose();
    }
    this.currentEnvRT = nextRT;
    scene.environment = nextRT.texture;

    // Update analytical L2 Spherical Harmonics LightProbe (zero GPU readback)
    this.updateAnalyticalLightProbe(
      params.sunDir,
      params.sunColor,
      params.skyColor,
      params.groundBounce,
      isOvercast,
    );

    return true;
  }

  private updateAnalyticalLightProbe(
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    skyColor: THREE.Color,
    groundBounce: THREE.Color,
    isOvercast: boolean,
  ): void {
    const coeffs = this.lightProbe.sh.coefficients;
    // Band 0 (ambient average of sky + warm ground bounce + directional sun bounce)
    const sunBounceScale = isOvercast ? 0.06 : 0.14;
    coeffs[0].set(
      (skyColor.r * 0.46 + groundBounce.r * 0.54 + sunColor.r * sunBounceScale) * 0.85,
      (skyColor.g * 0.46 + groundBounce.g * 0.54 + sunColor.g * sunBounceScale) * 0.85,
      (skyColor.b * 0.46 + groundBounce.b * 0.54 + sunColor.b * sunBounceScale) * 0.85,
    );

    // Band 1: Y dipole (sky zenith minus ground bounce) + sun directional bounce
    const dyR = (skyColor.r - groundBounce.r) * 0.55;
    const dyG = (skyColor.g - groundBounce.g) * 0.55;
    const dyB = (skyColor.b - groundBounce.b) * 0.55;

    const sunDirBoost = isOvercast ? 0.08 : 0.22;
    coeffs[1].set(
      dyR + sunDir.y * sunColor.r * sunDirBoost,
      dyG + sunDir.y * sunColor.g * sunDirBoost,
      dyB + sunDir.y * sunColor.b * sunDirBoost,
    );
    coeffs[2].set(
      sunDir.z * sunColor.r * sunDirBoost,
      sunDir.z * sunColor.g * sunDirBoost,
      sunDir.z * sunColor.b * sunDirBoost,
    );
    coeffs[3].set(
      sunDir.x * sunColor.r * sunDirBoost,
      sunDir.x * sunColor.g * sunDirBoost,
      sunDir.x * sunColor.b * sunDirBoost,
    );

    // Band 2: subtle quadratic sky/ground contrast for metallic & curved surfaces
    for (let i = 4; i < 9; i++) {
      coeffs[i].set(0, 0, 0);
    }
    coeffs[6].set(
      (skyColor.r + groundBounce.r) * 0.08,
      (skyColor.g + groundBounce.g) * 0.08,
      (skyColor.b + groundBounce.b) * 0.08,
    );

    this.lightProbe.intensity = isOvercast ? 0.42 : 0.54;
  }

  public dispose(): void {
    if (this.currentEnvRT) {
      this.currentEnvRT.dispose();
      this.currentEnvRT = null;
    }
    this.domeGeo.dispose();
    this.domeMat.dispose();
    this.pmremGenerator.dispose();
  }
}
