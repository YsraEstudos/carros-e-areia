/**
 * DesertEnvironment.ts
 * Multi-biome proving-ground environment manager supporting:
 *  1. `'desert'`: Sahara sandstone mesa spires, gravel pebbles, golden-hour Preetham sky,
 *     and desert rally course pylons.
 *  2. `'mud_grass'`: Overcast humid countryside track matching the mud & grass reference —
 *     single-draw-call 3D wild grass field bordering the muddy trails, cool reflective pond/creek
 *     shore water in low outer basins, mossy dark wet boulders & weathered rally marker posts,
 *     and diffused overcast daylight.
 */

import * as THREE from 'three';
import { InstancedMesh2 } from '@three.ez/instanced-mesh';
import {
  EnvironmentBiome,
  GraphicsQuality,
  WEATHER_PRESET_SPECS,
  WeatherPreset,
} from '../core/SandParams';
import { getGraphicsQualityBudget } from '../core/GraphicsQualityBudget';
import { getSceneObjectLodDistances } from '../core/DistanceLodPolicy';
import {
  CLIMBABLE_ROCK_SLABS,
  DESERT_ROCK_OBSTACLES,
  evalSingleClimbableRockElevation,
} from '../core/DesertObstacles';
import { sampleBaseTerrainHeight } from '../core/TerrainHeightfield';
import { GrassFieldSystem, GrassUpdateParams } from './GrassFieldSystem';
import { AtmosphericIBL } from './AtmosphericIBL';
import {
  RainyHighwayEnvironment,
  RainyHighwayUpdateParams,
} from './RainyHighwayEnvironment';
import { attachGeometryBvh, disposeGeometryBvh } from './MeshBvhSetup';

function setInstancedLayer(mesh: InstancedMesh2, layer: number): void {
  mesh.layers.set(layer);
  if (mesh.LODinfo) {
    for (let i = 0; i < mesh.LODinfo.objects.length; i++) {
      mesh.LODinfo.objects[i].layers.set(layer);
    }
  }
}

export interface DesertLightingRig {
  sunLight: THREE.DirectionalLight;
  farSunLight: THREE.DirectionalLight;
  hemiLight: THREE.HemisphereLight;
  fog: THREE.FogExp2;
  sunDirection: THREE.Vector3;
  sunColorLinear: THREE.Color;
  skyColorLinear: THREE.Color;
  groundBounceLinear: THREE.Color;
  fogColorLinear: THREE.Color;
  sunGlowLinear: THREE.Color;
  setBiome(biome: EnvironmentBiome): void;
  setWeather(weather: WeatherPreset): void;
  setLinearHdrOutput(enabled: boolean): void;
  setShadowQuality(quality: GraphicsQuality): void;
  setShadowExtent(extent: number): void;
  setEnvironmentIntensity(intensity: number): void;
  setReflectionExcludedLayer(layer: number): void;
  getEnvironmentTexture(): THREE.Texture | null;
  updateGrass(params: GrassUpdateParams): void;
  updateRainyCorridor(params: RainyHighwayUpdateParams): void;
  updateSun(
    elevationDeg: number,
    azimuthDeg: number,
    focusTarget: THREE.Vector3,
    updateShadowTarget?: boolean,
    updateFarShadowTarget?: boolean,
  ): void;
  dispose(): void;
}

export function createDesertEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
  isMobile = false,
): DesertLightingRig {
  // 1. Dynamic Procedural Atmospheric HDR IBL (PMREM) + Analytical SH L2 LightProbe
  const atmosphericIbl = new AtmosphericIBL(renderer, scene);
  scene.environmentIntensity = 0.68;

  // 2. Horizon-matched Exponential Fog
  const fogColorLinear = new THREE.Color(0xd9b38c);
  const fog = new THREE.FogExp2(fogColorLinear.getHex(), 0.0046);
  scene.fog = fog;

  // 4. Key Directional Sun Light + Tight Shadow Cascade 0 Frustum (dynamically tightened per camera mode)
  const sunLight = new THREE.DirectionalLight(0xffe1b8, 3.1);
  sunLight.castShadow = !isSoftwareGl;
  sunLight.shadow.autoUpdate = false;
  sunLight.shadow.mapSize.width = 1024;
  sunLight.shadow.mapSize.height = 1024;
  let shadowExtent = 18;
  sunLight.shadow.camera.left = -shadowExtent;
  sunLight.shadow.camera.right = shadowExtent;
  sunLight.shadow.camera.top = shadowExtent;
  sunLight.shadow.camera.bottom = -shadowExtent;
  sunLight.shadow.camera.near = 1.0;
  sunLight.shadow.camera.far = 95.0;
  sunLight.shadow.bias = -0.00045;
  sunLight.shadow.normalBias = 0.022;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // 4b. Dedicated Far Shadow Cascade 1 (zero illumination cost, low-res ±112..128m frustum,
  //     updated only when traveling >=12m or sun/biome changes so distant desert rocks cast real shadows!)
  const initialLod = getSceneObjectLodDistances('hybrid', isMobile, isSoftwareGl);
  let farShadowExtent = initialLod.farShadowExtent;
  const farSunLight = new THREE.DirectionalLight(0x000000, 0);
  farSunLight.castShadow = !isSoftwareGl;
  farSunLight.shadow.autoUpdate = false;
  farSunLight.shadow.mapSize.set(initialLod.farShadowMapSize, initialLod.farShadowMapSize);
  farSunLight.shadow.camera.left = -farShadowExtent;
  farSunLight.shadow.camera.right = farShadowExtent;
  farSunLight.shadow.camera.top = farShadowExtent;
  farSunLight.shadow.camera.bottom = -farShadowExtent;
  farSunLight.shadow.camera.near = 2.0;
  farSunLight.shadow.camera.far = 295.0;
  farSunLight.shadow.bias = -0.0012;
  farSunLight.shadow.normalBias = 0.085;
  scene.add(farSunLight);
  scene.add(farSunLight.target);

  // 5. Sky / Ground Bounce HemisphereLight fill
  const hemiLight = new THREE.HemisphereLight(0x88b4dc, 0xb87a46, 0.85);
  scene.add(hemiLight);

  const disposables: Array<{ dispose(): void }> = [atmosphericIbl];
  const desertGroup = new THREE.Group();
  desertGroup.visible = false;
  const mudGrassGroup = new THREE.Group();
  mudGrassGroup.visible = false;
  scene.add(desertGroup, mudGrassGroup);

  // Lazy-initialized biome resources (avoids constructing unused biomes at boot)
  let desertBuilt = false;
  let desertSkyMat: THREE.ShaderMaterial | null = null;
  let desertSkyDome: THREE.Mesh | null = null;
  let ergDuneMat: THREE.ShaderMaterial | null = null;
  let ergDuneMesh: THREE.Mesh | null = null;
  let desertRocksRef: InstancedMesh2 | null = null;
  let desertScrub: InstancedMesh2 | null = null;
  let mudGrassBuilt = false;
  let grassField: GrassFieldSystem | null = null;
  let mossyRocksRef: InstancedMesh2 | null = null;
  let cloudDomeMat: THREE.ShaderMaterial | null = null;
  let mudCloudDome: THREE.Mesh | null = null;
  let rainyHighwayEnv: RainyHighwayEnvironment | null = null;
  let linearHdrOutputEnabled = false;
  let reflectionExcludedLayer = 0;
  let activeQuality: GraphicsQuality = 'hybrid';

  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // ============================================================================
  // BIOME 1: SAHARA DESERT BACKDROP (Lazy-built on first activation)
  // ============================================================================
  const ensureDesertBuilt = () => {
    if (desertBuilt) return;
    desertBuilt = true;
    const desertSkyGeo = new THREE.SphereGeometry(850, 32, 20);
    desertSkyMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.5, 0.2, 0.8) },
      uFogColor: { value: new THREE.Color(0.74, 0.60, 0.46) },
      uZenithSky: { value: new THREE.Color(0.09, 0.24, 0.56) },
      uMidSky: { value: new THREE.Color(0.30, 0.43, 0.64) },
      uSunGlow: { value: new THREE.Color(1.08, 0.64, 0.26) },
      uIsOvercast: { value: 0.0 },
      uLinearHdrOutput: { value: 0.0 },
    },
    vertexShader: /* glsl */ `
      out vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = normalize(position);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec3 vDir;
      uniform vec3 uSunDir;
      uniform vec3 uFogColor;
      uniform vec3 uZenithSky;
      uniform vec3 uMidSky;
      uniform vec3 uSunGlow;
      uniform float uIsOvercast;
      uniform float uLinearHdrOutput;
      out vec4 fragColor;

      void main() {
        vec3 dir = normalize(vDir);
        vec3 L = normalize(uSunDir);
        float elev = clamp(dir.y, 0.0, 1.0);

        // Weather-driven desert sky: deep zenith -> cerulean/indigo mid -> warm horizon haze
        vec3 horizonHaze = uFogColor * vec3(1.10, 0.96, 0.86);
        vec3 skyCol = mix(horizonHaze, uMidSky, smoothstep(0.0, 0.16, elev));
        skyCol = mix(skyCol, uZenithSky, smoothstep(0.10, 0.52, elev));

        // Concentrated Mie solar aureole + HDR solar disc (drives bloom & clearcoat reflections!)
        float sunCos = max(dot(dir, L), 0.0);
        float overcastDamp = mix(1.0, 0.28, uIsOvercast);
        float mieGlow = (pow(sunCos, 6.0) * 0.44 + pow(sunCos, 44.0) * 0.88 + pow(sunCos, 240.0) * 1.9) * overcastDamp;
        float sunDisc = smoothstep(0.9985, 0.9996, sunCos) * mix(4.2, 0.35, uIsOvercast);
        skyCol += uSunGlow * (mieGlow * (1.0 - smoothstep(0.36, 0.86, elev)) + sunDisc);

        // Seamless horizon lock into terrain aerial perspective
        skyCol = mix(horizonHaze, skyCol, smoothstep(0.0, 0.070, elev));

        if (uLinearHdrOutput < 0.5) {
          skyCol *= 1.02;
          skyCol = (skyCol * (2.51 * skyCol + 0.03)) / (skyCol * (2.43 * skyCol + 0.59) + 0.14);
          skyCol = pow(clamp(skyCol, 0.0, 1.0), vec3(1.0 / 2.2));
        }
        fragColor = vec4(skyCol, 1.0);
      }
    `,
  });
  desertSkyDome = new THREE.Mesh(desertSkyGeo, desertSkyMat);
  desertSkyDome.renderOrder = -2;
  desertSkyDome.frustumCulled = false;
  desertSkyMat.uniforms.uLinearHdrOutput.value = linearHdrOutputEnabled ? 1.0 : 0.0;
  desertGroup.add(desertSkyDome);
  disposables.push(desertSkyGeo, desertSkyMat);

  const ergDuneGeo = createDistantErgDuneRingGeometry();
  ergDuneMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.5, 0.2, 0.8) },
      uSunColor: { value: new THREE.Color(1.65, 1.25, 0.82) },
      uSkyColor: { value: new THREE.Color(0.52, 0.56, 0.68) },
      uGroundBounceColor: { value: new THREE.Color(0.54, 0.41, 0.29) },
      uFogColor: { value: new THREE.Color(0.74, 0.60, 0.46) },
      uFogDensity: { value: 0.0046 },
      uLinearHdrOutput: { value: 0.0 },
    },
    vertexShader: /* glsl */ `
      out vec3 vWorldPos;
      out vec3 vLocalPos;
      out vec3 vNormal;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vLocalPos = position;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec3 vWorldPos;
      in vec3 vLocalPos;
      in vec3 vNormal;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyColor;
      uniform vec3 uGroundBounceColor;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uLinearHdrOutput;
      out vec4 fragColor;

      const float PI = 3.14159265359;

      // Energy-Preserving Oren-Nayar (EON) matched verbatim to foreground terrainSand.ts
      vec3 evalErgEON(vec3 albedo, float roughness, vec3 N, vec3 V, vec3 L) {
        float NdotL = max(dot(N, L), 0.0);
        float NdotV = max(dot(N, V), 1e-4);
        if (NdotL <= 0.0) return vec3(0.0);

        float r = clamp(roughness, 0.0, 1.0);
        float s = dot(L, V) - NdotL * NdotV;
        float t = s > 0.0 ? max(NdotL, NdotV) : 1.0;

        const float C1 = 0.5 - 2.0 / (3.0 * PI);
        float A = 1.0 / (1.0 + C1 * r);
        float B = r * A;
        float fSS = A + B * (s / max(t, 1e-4));

        float E_L = A + B * (0.5 * (1.0 - NdotL) * (1.0 - NdotL));
        float E_V = A + B * (0.5 * (1.0 - NdotV) * (1.0 - NdotV));
        float E_avg = A + (2.0 / 3.0 - 28.0 / (15.0 * PI)) * B;
        vec3 rhoMS = (albedo * albedo) * (E_avg / max(vec3(0.05), vec3(1.0) - albedo * (1.0 - E_avg)));
        vec3 fMS = rhoMS * max(0.0, 1.0 - E_L) * max(0.0, 1.0 - E_V) / max(0.05, PI * (1.0 - E_avg));
        return (albedo * fSS + fMS * 1.05) * NdotL;
      }

      // Smooth analytical sweeping Sahara erg dune height for razor-clean per-pixel lighting (zero polygon facets!)
      float evalErgH(vec2 p) {
        float w1 = sin(p.x * 0.014 + p.y * 0.023 + sin(p.x * 0.0075) * 2.4);
        float c1 = (1.0 - sqrt(w1 * w1 + 0.042)) * 16.5;
        float w2 = cos(p.x * 0.021 - p.y * 0.012 + cos(p.y * 0.0080) * 2.0);
        float c2 = (1.0 - sqrt(w2 * w2 + 0.075)) * 8.8;
        return c1 + c2;
      }

      void main() {
        // Compute silky analytical normal per-pixel so distant barchan shadow bands are razor-smooth
        vec2 p = vLocalPos.xz;
        float eps = 0.85;
        float hL = evalErgH(p - vec2(eps, 0.0));
        float hR = evalErgH(p + vec2(eps, 0.0));
        float hD = evalErgH(p - vec2(0.0, eps));
        float hU = evalErgH(p + vec2(0.0, eps));
        vec3 N_ana = normalize(vec3(-(hR - hL) / (2.0 * eps), 1.0, -(hU - hD) / (2.0 * eps)));
        vec3 N = normalize(mix(normalize(vNormal), N_ana, 0.88));

        vec3 L = normalize(uSunDir);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float distCam = length(cameraPosition - vWorldPos);

        // Matched Sahara quartz-ochre dune strata seamlessly bridging from foreground clipmap
        float hSurf = evalErgH(p);
        float crestT = smoothstep(8.0, 21.0, hSurf);
        vec3 anchorSahara = vec3(0.495, 0.242, 0.098);
        vec3 crestTint = vec3(1.12, 0.96, 0.80);
        vec3 midTint = vec3(0.94, 0.78, 0.62);
        vec3 albedo = anchorSahara * mix(midTint, crestTint, crestT * 0.62);

        // Soft slip-face shadow band + EON diffuse + warm sunlit quartz SSS matching foreground sand
        float NdotL = dot(N, L);
        float shadowBand = smoothstep(-0.08, 0.14, NdotL);
        float directFactor = mix(0.08, 1.0, shadowBand);
        vec3 direct = evalErgEON(albedo, 0.92, N, V, L) * uSunColor * 1.16 * directFactor;

        float slopeWrap = clamp((NdotL + 0.26) / 1.26, 0.0, 1.0);
        vec3 sssBounce = albedo * uSunColor * vec3(1.04, 0.54, 0.24) * (slopeWrap * (0.065 + crestT * 0.055) * mix(0.20, 1.0, shadowBand));

        vec3 warmBounceFloor = max(uGroundBounceColor, vec3(0.54, 0.27, 0.12));
        vec3 skyFill = mix(uSkyColor * 0.58, uFogColor * 0.44, 0.24);
        float hemiT = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
        float shadowCoolBoost = mix(1.28, 0.92, shadowBand);
        vec3 indirect = mix(warmBounceFloor * 0.86, skyFill * shadowCoolBoost, hemiT) * albedo * 0.41;

        // Powdery sunlit dune crest rim glow
        float NdotV = max(dot(N, V), 0.0);
        float rim = pow(1.0 - NdotV, 3.2) * (0.10 + crestT * 0.08) * (0.28 + 0.72 * max(NdotL, 0.0)) * mix(0.20, 1.0, shadowBand);
        vec3 rimColor = uSunColor * vec3(1.02, 0.78, 0.48) * rim;

        vec3 color = direct + sssBounce + indirect + rimColor;

        // Matched sun-aligned golden-apricot Sahara aerial perspective haze
        float fogFactor = 1.0 - exp(-pow(distCam * uFogDensity * 0.64, 1.65));
        float sunAlign = max(dot(-V, L), 0.0);
        vec3 mieHorizon = mix(uFogColor, uFogColor * vec3(1.18, 0.96, 0.78) + vec3(0.11, 0.048, 0.012), pow(sunAlign, 3.0) * 0.78);
        color = mix(color, mieHorizon, clamp(fogFactor, 0.0, 0.84));

        if (uLinearHdrOutput < 0.5) {
          color *= 1.02;
          color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
          color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));
        }
        fragColor = vec4(color, 1.0);
      }
    `,
  });
  ergDuneMesh = new THREE.Mesh(ergDuneGeo, ergDuneMat);
  ergDuneMesh.frustumCulled = false;
  ergDuneMesh.receiveShadow = false;
  ergDuneMesh.castShadow = false;
  ergDuneMat.uniforms.uLinearHdrOutput.value = linearHdrOutputEnabled ? 1.0 : 0.0;
  desertGroup.add(ergDuneMesh);
  disposables.push(ergDuneGeo, ergDuneMat);

  // Weathered Stratified Sahara Sandstone Outcrops with 3-tier Distance LOD + cheap 20-tri Shadow LOD
  const deformSandstoneGeo = (geo: THREE.DodecahedronGeometry): THREE.DodecahedronGeometry => {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);
      // Horizontal sedimentary strata ledges + wind-eroded flat desert mesa tops
      const strata = 0.085 * Math.sin(vy * 9.5 + vx * 1.4) + 0.045 * Math.cos(vy * 18.0 - vz * 2.1);
      const crag = 0.86 + 0.24 * Math.sin(vx * 2.8 + vz * 2.3) * Math.cos(vy * 2.1 - vx * 1.7);
      const flatTop = vy > 0.35 ? 0.35 + (vy - 0.35) * 0.42 : vy;
      pos.setXYZ(i, vx * (crag + strata) * 1.16, flatTop * crag * 0.86, vz * (crag - strata * 0.6) * 1.08);
    }
    geo.computeVertexNormals();
    return geo;
  };
  const sandstoneGeo = deformSandstoneGeo(new THREE.DodecahedronGeometry(1.0, 2));
  const sandstoneGeoLod1 = deformSandstoneGeo(new THREE.DodecahedronGeometry(1.0, 1));
  const sandstoneGeoLod2 = deformSandstoneGeo(new THREE.DodecahedronGeometry(1.0, 0));

  const sandstoneTex = createSandstoneTextures(maxAniso);
  disposables.push(sandstoneTex.albedo, sandstoneTex.bump);

  const sandstoneMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: sandstoneTex.albedo,
    bumpMap: sandstoneTex.bump,
    bumpScale: 0.085,
    roughness: 0.90,
    metalness: 0.03,
    envMapIntensity: 0.28,
  });
  const sandstoneMatLod1 = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    map: sandstoneTex.albedo,
  });
  const sandstoneMatLod2 = new THREE.MeshLambertMaterial({
    color: 0xd8c3ab,
  });
  disposables.push(
    sandstoneGeo,
    sandstoneGeoLod1,
    sandstoneGeoLod2,
    sandstoneMat,
    sandstoneMatLod1,
    sandstoneMatLod2,
  );

  const desertLod = getSceneObjectLodDistances(activeQuality, isMobile, isSoftwareGl);
  const desertRocks = new InstancedMesh2(sandstoneGeo, sandstoneMat, {
    capacity: DESERT_ROCK_OBSTACLES.length,
    renderer,
  });
  desertRocks.castShadow = !isSoftwareGl;
  desertRocks.receiveShadow = true;
  desertRocks.frustumCulled = false;
  desertRocks.perObjectFrustumCulled = true;
  desertRocks.autoUpdateBVH = false;
  desertRocks.addLOD(sandstoneGeoLod1, sandstoneMatLod1, desertLod.rockLod1);
  desertRocks.addLOD(sandstoneGeoLod2, sandstoneMatLod2, desertLod.rockLod2);
  desertRocks.addShadowLOD(sandstoneGeoLod2, 0);
  desertRocks.addInstances(DESERT_ROCK_OBSTACLES.length);
  const sandstonePalette = [0x8f6244, 0x7c5338, 0x9c6e4e, 0x6e4830];
  for (let i = 0; i < DESERT_ROCK_OBSTACLES.length; i++) {
    const obs = DESERT_ROCK_OBSTACLES[i];
    const gy = sampleBaseTerrainHeight(obs.x, obs.z);
    // Embed rock base cleanly into the sand dune so wind-blown drifts hug its skirts
    dummy.position.set(obs.x, gy + obs.scaleY * 0.16, obs.z);
    dummy.rotation.set(((i % 3) - 1) * 0.06, obs.yaw, (((i + 1) % 3) - 1) * 0.05);
    dummy.scale.set(obs.scaleXZ, obs.scaleY, obs.scaleXZ * 0.94);
    dummy.updateMatrix();
    desertRocks.setMatrixAt(i, dummy.matrix);
    tint.setHex(sandstonePalette[obs.colorIndex % sandstonePalette.length]);
    desertRocks.setColorAt(i, tint);
  }
  desertRocks.computeBVH({ margin: 0, getBBoxFromBSphere: false });
  desertRocks.computeBoundingSphere();
  desertRocks.matrixAutoUpdate = false;
  desertRocks.updateMatrix();
  desertRocksRef = desertRocks;
  desertGroup.add(desertRocks);
  disposables.push({ dispose: () => { desertRocks.disposeBVH(); desertRocks.dispose(); } });

  // Climbable Stratified Sahara Sandstone Rock-Crawling Course (1 merged draw call, exact 1:1 CPU elevation match)
  const climbableRockGeo = createClimbableRockCourseGeometry();
  attachGeometryBvh(climbableRockGeo);
  const climbableRockMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: sandstoneTex.albedo,
    bumpMap: sandstoneTex.bump,
    bumpScale: 0.065,
    roughness: 0.88,
    metalness: 0.03,
    envMapIntensity: 0.30,
  });
  const climbableRocksMesh = new THREE.Mesh(climbableRockGeo, climbableRockMat);
  climbableRocksMesh.castShadow = !isSoftwareGl;
  climbableRocksMesh.receiveShadow = true;
  climbableRocksMesh.matrixAutoUpdate = false;
  climbableRocksMesh.updateMatrix();
  desertGroup.add(climbableRocksMesh);
  disposables.push(
    { dispose: () => disposeGeometryBvh(climbableRockGeo) },
    climbableRockGeo,
    climbableRockMat,
  );

  // Sparse Dry Sahara Scrub Grass Tufts nestled near sandstone rock skirts with 1-card Distance LOD
  const scrubBladeGeo = createCrossedBillboardGeometry(0.85, 0.56);
  const scrubBladeLodGeo = new THREE.PlaneGeometry(0.85, 0.56);
  scrubBladeLodGeo.translate(0, 0.56 * 0.45, 0);
  const scrubTex = createDesertScrubTexture(maxAniso);
  const scrubMat = new THREE.MeshLambertMaterial({
    map: scrubTex,
    alphaTest: 0.35,
    side: THREE.DoubleSide,
    color: 0xffffff,
  });
  disposables.push(scrubBladeGeo, scrubBladeLodGeo, scrubTex, scrubMat);

  const scrubCount = DESERT_ROCK_OBSTACLES.length * 4;
  desertScrub = new InstancedMesh2(scrubBladeGeo, scrubMat, {
    capacity: scrubCount,
    renderer,
  });
  desertScrub.castShadow = false;
  desertScrub.receiveShadow = true;
  desertScrub.frustumCulled = false;
  desertScrub.perObjectFrustumCulled = true;
  desertScrub.autoUpdateBVH = false;
  desertScrub.addLOD(scrubBladeLodGeo, scrubMat, desertLod.desertScrubLod1);
  desertScrub.addInstances(scrubCount);
  if (reflectionExcludedLayer > 0) {
    setInstancedLayer(desertScrub, reflectionExcludedLayer);
  }
  const scrubRng = makeRng(90421);
  const scrubPalette = [0xb88644, 0xa17339, 0x8d6332, 0xad7d3f];
  let scrubIdx = 0;
  for (let i = 0; i < DESERT_ROCK_OBSTACLES.length; i++) {
    const obs = DESERT_ROCK_OBSTACLES[i];
    for (let k = 0; k < 4; k++) {
      const a = scrubRng() * Math.PI * 2;
      const dist = obs.radius * (0.95 + scrubRng() * 0.72);
      const sx = obs.x + Math.cos(a) * dist;
      const sz = obs.z + Math.sin(a) * dist;
      const sy = sampleBaseTerrainHeight(sx, sz);
      const sc = 0.65 + scrubRng() * 0.72;
      dummy.position.set(sx, sy - 0.05, sz);
      dummy.rotation.set(0, scrubRng() * Math.PI * 2, 0);
      dummy.scale.set(sc, sc * (0.75 + scrubRng() * 0.45), sc);
      dummy.updateMatrix();
      desertScrub.setMatrixAt(scrubIdx, dummy.matrix);
      tint.setHex(scrubPalette[scrubIdx % scrubPalette.length]);
      desertScrub.setColorAt(scrubIdx, tint);
      scrubIdx++;
    }
  }
  desertScrub.computeBVH({ margin: 0, getBBoxFromBSphere: false });
  desertScrub.computeBoundingSphere();
  desertScrub.matrixAutoUpdate = false;
  desertScrub.updateMatrix();
  desertGroup.add(desertScrub);
  desertGroup.matrixAutoUpdate = false;
  desertGroup.updateMatrix();
  desertGroup.updateMatrixWorld(true);
  const desertScrubRef = desertScrub;
  disposables.push({ dispose: () => { desertScrubRef.disposeBVH(); desertScrubRef.dispose(); } });
  };

  // ============================================================================
  // BIOME 2: SLOPPY MUD & GRASS BACKDROP (Lazy-built on first activation)
  // ============================================================================
  const ensureMudGrassBuilt = () => {
    if (mudGrassBuilt) return;
    mudGrassBuilt = true;

    grassField = new GrassFieldSystem(isSoftwareGl, isMobile, renderer);
    const grassBudget = getGraphicsQualityBudget(activeQuality, isMobile, isSoftwareGl);
    const mudLod = getSceneObjectLodDistances(activeQuality, isMobile, isSoftwareGl);
    grassField.setDensityRatio(grassBudget.grassDensityRatio);
    grassField.setLodDistance(mudLod.mudGrassLod1);
    if (reflectionExcludedLayer > 0) {
      grassField.setLayer(reflectionExcludedLayer);
    }
    mudGrassGroup.add(grassField.mesh);
    disposables.push(grassField);

    // Procedural overcast cloud sky dome (radius 850 stays cleanly inside camera.far = 1200)
    const cloudDomeGeo = new THREE.SphereGeometry(850, 32, 20);
    cloudDomeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0.4, 0.35, 0.85) },
        uFogColor: { value: new THREE.Color(0x889094) },
        uTime: { value: 0 },
        uLinearHdrOutput: { value: linearHdrOutputEnabled ? 1.0 : 0.0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldDir = normalize(position);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vWorldDir;
        uniform vec3 uSunDir;
        uniform vec3 uFogColor;
        uniform float uTime;
        uniform float uLinearHdrOutput;

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

        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          mat2 m = mat2(0.8, -0.6, 0.6, 0.8);
          for (int i = 0; i < 4; i++) {
            v += a * vnoise(p);
            p = m * p * 2.05 + vec2(13.7, 29.1);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 dir = normalize(vWorldDir);
          float elev = max(0.0, dir.y);
          vec2 cloudUV = dir.xz / (elev + 0.18) + vec2(uTime * 0.004, uTime * 0.002);

          float baseLayer = fbm(cloudUV * 0.65);
          float fineLayer = fbm(cloudUV * 1.9 + vec2(4.2, 8.7));
          float cloud = smoothstep(0.28, 0.82, baseLayer * 0.72 + fineLayer * 0.28);

          vec3 overcastBright = vec3(0.66, 0.70, 0.73);
          vec3 overcastMid    = vec3(0.46, 0.50, 0.54);
          vec3 overcastDark   = vec3(0.32, 0.35, 0.38);

          vec3 sky = mix(overcastBright, overcastMid, smoothstep(0.2, 0.7, cloud));
          sky = mix(sky, overcastDark, smoothstep(0.62, 0.95, cloud) * 0.65);

          // Soft diffused overcast solar glow behind cloud deck
          float sunAlign = max(0.0, dot(dir, normalize(uSunDir)));
          sky += vec3(0.22, 0.23, 0.22) * pow(sunAlign, 5.0);

          // Seamless horizon mist transition matching terrain fog
          float horizonBlend = 1.0 - smoothstep(0.0, 0.22, elev);
          sky = mix(sky, uFogColor, horizonBlend);

          if (uLinearHdrOutput < 0.5) {
            sky = (sky * (2.51 * sky + 0.03)) / (sky * (2.43 * sky + 0.59) + 0.14);
            sky = pow(clamp(sky, 0.0, 1.0), vec3(1.0 / 2.2));
          }
          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
    mudCloudDome = new THREE.Mesh(cloudDomeGeo, cloudDomeMat);
    mudCloudDome.renderOrder = -2;
    mudCloudDome.frustumCulled = false;
    mudGrassGroup.add(mudCloudDome);
    disposables.push(cloudDomeGeo, cloudDomeMat);

    // Mossy dark wet boulders bordering the meadow & shoreline with Distance LOD + cheap Shadow LOD
    const deformMossyGeo = (geo: THREE.DodecahedronGeometry): THREE.DodecahedronGeometry => {
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const n = 0.80 + 0.34 * Math.sin(x * 3.1 + y * 4.7 + z * 2.9);
        pos.setXYZ(i, x * n * 1.28, y * n * 0.64, z * n * 1.18);
      }
      geo.computeVertexNormals();
      return geo;
    };
    const mossyRockGeo = deformMossyGeo(new THREE.DodecahedronGeometry(0.85, 1));
    const mossyRockGeoLod1 = deformMossyGeo(new THREE.DodecahedronGeometry(0.85, 0));
    const mossyRockMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.48,
      metalness: 0.04,
      envMapIntensity: 0.42,
    });
    const mossyRockMatLod1 = new THREE.MeshLambertMaterial({
      color: 0xffffff,
    });
    disposables.push(mossyRockGeo, mossyRockGeoLod1, mossyRockMat, mossyRockMatLod1);

    const mossyRockCount = 36;
    const mossyRocks = new InstancedMesh2(mossyRockGeo, mossyRockMat, {
      capacity: mossyRockCount,
      renderer,
    });
    mossyRocks.castShadow = !isSoftwareGl;
    mossyRocks.receiveShadow = true;
    mossyRocks.frustumCulled = false;
    mossyRocks.perObjectFrustumCulled = true;
    mossyRocks.autoUpdateBVH = false;
    mossyRocks.addLOD(mossyRockGeoLod1, mossyRockMatLod1, mudLod.mossyRockLod1);
    mossyRocks.addShadowLOD(mossyRockGeoLod1, 0);
    mossyRocks.addInstances(mossyRockCount);
    const mossyPalette = [0x3c3a33, 0x32352b, 0x454037, 0x3b422f];

    for (let i = 0; i < mossyRockCount; i++) {
      const ang = (i / mossyRockCount) * Math.PI * 2 + 0.18;
      const dist = 20.0 + ((i * 19) % 44);
      const rx = Math.cos(ang) * dist;
      const rz = Math.sin(ang) * dist;
      const ry = sampleBaseTerrainHeight(rx, rz);
      const sc = 0.50 + ((i * 11) % 14) * 0.075;
      dummy.position.set(rx, ry - sc * 0.22, rz);
      dummy.rotation.set((i % 3) * 0.15, ang * 2.1, ((i + 1) % 3) * 0.12);
      dummy.scale.set(sc, sc, sc);
      dummy.updateMatrix();
      mossyRocks.setMatrixAt(i, dummy.matrix);
      tint.setHex(mossyPalette[i % mossyPalette.length]);
      mossyRocks.setColorAt(i, tint);
    }
    mossyRocks.computeBVH({ margin: 0, getBBoxFromBSphere: false });
    mossyRocks.computeBoundingSphere();
    mossyRocks.matrixAutoUpdate = false;
    mossyRocks.updateMatrix();
    mossyRocksRef = mossyRocks;
    mudGrassGroup.add(mossyRocks);
    disposables.push({ dispose: () => { mossyRocks.disposeBVH(); mossyRocks.dispose(); } });

    // Distant countryside natural woodland treeline belt using organic leafy silhouettes (zero low-poly facets)
    const treeTex = createWoodlandTreeTexture(maxAniso);
    const treeGeo = createCrossedFoliageTreeGeometry();
    const bushTex = createWoodlandShrubTexture(maxAniso);
    const bushGeo = createCrossedShrubGeometry();

    const treeMat = new THREE.MeshLambertMaterial({
      map: treeTex,
      alphaTest: 0.38,
      side: THREE.DoubleSide,
      color: 0xffffff,
    });
    const bushMat = new THREE.MeshLambertMaterial({
      map: bushTex,
      alphaTest: 0.38,
      side: THREE.DoubleSide,
      color: 0xffffff,
    });
    disposables.push(treeTex, treeGeo, bushTex, bushGeo, treeMat, bushMat);

    const treeCount = isMobile ? 140 : 210;
    const trees = new InstancedMesh2(treeGeo, treeMat, {
      capacity: treeCount,
      renderer,
    });
    trees.castShadow = false;
    trees.receiveShadow = false;
    trees.frustumCulled = false;
    trees.perObjectFrustumCulled = true;
    trees.autoUpdateBVH = false;
    trees.addInstances(treeCount);
    const foliagePalette = [0x8c987a, 0x7a886b, 0x9aa485, 0x6f7c61, 0x859074];

    for (let i = 0; i < treeCount; i++) {
      // Organic dense woodland ring from 68m..148m (clumped naturally along the perimeter)
      const ang = (i / treeCount) * Math.PI * 2 + Math.sin(i * 2.7) * 0.032;
      const band = i % 3;
      const dist =
        band === 0
          ? 68.0 + ((i * 19) % 24)
          : band === 1
            ? 88.0 + ((i * 29) % 30)
            : 112.0 + ((i * 37) % 38);
      const tx = Math.cos(ang) * dist;
      const tz = Math.sin(ang) * dist;
      const ty = sampleBaseTerrainHeight(tx, tz);
      const hScale = (0.95 + ((i * 13) % 14) * 0.085) * (band === 2 ? 1.22 : 1.0);
      const wScale = hScale * (0.96 + ((i * 7) % 7) * 0.09);
      dummy.position.set(tx, ty - 1.35, tz);
      dummy.rotation.set(0, ang * 2.7 + i * 1.13, 0);
      dummy.scale.set(wScale, hScale, wScale);
      dummy.updateMatrix();
      trees.setMatrixAt(i, dummy.matrix);

      tint.setHex(foliagePalette[i % foliagePalette.length]);
      trees.setColorAt(i, tint);
    }
    trees.computeBVH({ margin: 0, getBBoxFromBSphere: false });
    trees.computeBoundingSphere();

    const bushCount = isMobile ? 140 : 210;
    const bushes = new InstancedMesh2(bushGeo, bushMat, {
      capacity: bushCount,
      renderer,
    });
    bushes.castShadow = false;
    bushes.receiveShadow = false;
    bushes.frustumCulled = false;
    bushes.perObjectFrustumCulled = true;
    bushes.autoUpdateBVH = false;
    bushes.addInstances(bushCount);
    for (let i = 0; i < bushCount; i++) {
      const ang = (i / bushCount) * Math.PI * 2 + Math.cos(i * 3.1) * 0.04;
      const dist = 50.0 + ((i * 23) % 60);
      const bx = Math.cos(ang) * dist;
      const bz = Math.sin(ang) * dist;
      const by = sampleBaseTerrainHeight(bx, bz);
      const sc = 0.85 + ((i * 11) % 12) * 0.085;
      dummy.position.set(bx, by - 0.55, bz);
      dummy.rotation.set(0, ang * 1.9 + i * 0.7, 0);
      dummy.scale.set(sc * 1.35, sc * 1.12, sc * 1.35);
      dummy.updateMatrix();
      bushes.setMatrixAt(i, dummy.matrix);
      tint.setHex(foliagePalette[(i + 2) % foliagePalette.length]);
      bushes.setColorAt(i, tint);
    }
    trees.matrixAutoUpdate = false;
    trees.updateMatrix();
    bushes.computeBVH({ margin: 0, getBBoxFromBSphere: false });
    bushes.computeBoundingSphere();
    bushes.matrixAutoUpdate = false;
    bushes.updateMatrix();
    mudGrassGroup.add(trees, bushes);
    mudGrassGroup.matrixAutoUpdate = false;
    mudGrassGroup.updateMatrix();
    mudGrassGroup.updateMatrixWorld(true);
    disposables.push(
      { dispose: () => { trees.disposeBVH(); trees.dispose(); } },
      { dispose: () => { bushes.disposeBVH(); bushes.dispose(); } },
    );
  };

  const ensureRainyHighwayBuilt = () => {
    if (rainyHighwayEnv) return;
    rainyHighwayEnv = new RainyHighwayEnvironment(renderer, isSoftwareGl);
    const rainyBudget = getGraphicsQualityBudget(activeQuality, isMobile, isSoftwareGl);
    const rainyLod = getSceneObjectLodDistances(activeQuality, isMobile, isSoftwareGl);
    rainyHighwayEnv.setQualityBudgets(rainyBudget.grassDensityRatio, rainyBudget.rainStreakRatio);
    rainyHighwayEnv.setLodDistances(rainyLod);
    rainyHighwayEnv.setLinearHdrOutput(linearHdrOutputEnabled);
    if (reflectionExcludedLayer > 0) {
      rainyHighwayEnv.setReflectionExcludedLayer(reflectionExcludedLayer);
    }
    rainyHighwayEnv.group.visible = activeBiome === 'rainy_highway';
    scene.add(rainyHighwayEnv.group);
    disposables.push(rainyHighwayEnv);
  };

  // ============================================================================
  // SHARED DYNAMIC SUN / SKY / FOG / WEATHER / IBL CONTROLLER
  // ============================================================================
  let activeBiome: EnvironmentBiome = 'desert';
  let activeWeather: WeatherPreset = 'golden_hour';
  let envIntensityScale = 1.0;
  const sunDirection = new THREE.Vector3();
  const sunColorLinear = new THREE.Color();
  const skyColorLinear = new THREE.Color();
  const groundBounceLinear = new THREE.Color();
  const sunGlowLinear = new THREE.Color(1.08, 0.64, 0.26);

  const syncDomeVisibility = () => {
    const isMud = activeBiome === 'mud_grass';
    const isRainy = activeBiome === 'rainy_highway';
    if (isMud) ensureMudGrassBuilt();
    else if (isRainy) ensureRainyHighwayBuilt();
    else ensureDesertBuilt();
    const spec = WEATHER_PRESET_SPECS[activeWeather];
    desertGroup.visible = !isMud && !isRainy;
    mudGrassGroup.visible = isMud;
    if (rainyHighwayEnv) rainyHighwayEnv.group.visible = isRainy;

    const baseFog = isRainy ? 0.0112 : isMud ? 0.0063 : 0.0036;
    fog.density = baseFog * (isRainy ? 1.0 : spec.fogDensityScale);
    scene.background = isMud || isRainy ? fogColorLinear : null;
    const baseEnv = isRainy ? 0.72 : isMud || spec.isOvercast ? 0.58 : 0.72;
    scene.environmentIntensity = baseEnv * envIntensityScale;
  };

  const setBiome = (biome: EnvironmentBiome) => {
    activeBiome = biome;
    syncDomeVisibility();
  };

  const setWeather = (weather: WeatherPreset) => {
    activeWeather = weather;
    syncDomeVisibility();
  };

  const setLinearHdrOutput = (enabled: boolean) => {
    linearHdrOutputEnabled = enabled;
    const val = enabled ? 1.0 : 0.0;
    if (desertSkyMat) desertSkyMat.uniforms.uLinearHdrOutput.value = val;
    if (ergDuneMat) ergDuneMat.uniforms.uLinearHdrOutput.value = val;
    if (cloudDomeMat) cloudDomeMat.uniforms.uLinearHdrOutput.value = val;
    if (rainyHighwayEnv) rainyHighwayEnv.setLinearHdrOutput(enabled);
  };

  const setShadowQuality = (quality: GraphicsQuality) => {
    activeQuality = quality;
    const budget = getGraphicsQualityBudget(quality, isMobile, isSoftwareGl);
    const lod = getSceneObjectLodDistances(quality, isMobile, isSoftwareGl);
    if (grassField) {
      grassField.setDensityRatio(budget.grassDensityRatio);
      grassField.setLodDistance(lod.mudGrassLod1);
    }
    if (rainyHighwayEnv) {
      rainyHighwayEnv.setQualityBudgets(budget.grassDensityRatio, budget.rainStreakRatio);
      rainyHighwayEnv.setLodDistances(lod);
    }
    if (desertRocksRef) {
      desertRocksRef.updateLOD(1, lod.rockLod1);
      desertRocksRef.updateLOD(2, lod.rockLod2);
    }
    if (desertScrub) {
      desertScrub.updateLOD(1, lod.desertScrubLod1);
    }
    if (mossyRocksRef) {
      mossyRocksRef.updateLOD(1, lod.mossyRockLod1);
    }
    if (isSoftwareGl) {
      sunLight.castShadow = false;
      farSunLight.castShadow = false;
      return;
    }
    const desiredSize = budget.shadowMapSize;
    sunLight.castShadow = true;
    farSunLight.castShadow = true;
    if (sunLight.shadow.camera.far !== budget.shadowFar) {
      sunLight.shadow.camera.far = budget.shadowFar;
      sunLight.shadow.camera.updateProjectionMatrix();
    }
    if (sunLight.shadow.mapSize.width !== desiredSize) {
      sunLight.shadow.mapSize.set(desiredSize, desiredSize);
      if (sunLight.shadow.map) {
        sunLight.shadow.map.dispose();
        sunLight.shadow.map = null;
      }
      sunLight.shadow.needsUpdate = true;
    }
    if (Math.abs(farShadowExtent - lod.farShadowExtent) > 0.1) {
      farShadowExtent = lod.farShadowExtent;
      farSunLight.shadow.camera.left = -farShadowExtent;
      farSunLight.shadow.camera.right = farShadowExtent;
      farSunLight.shadow.camera.top = farShadowExtent;
      farSunLight.shadow.camera.bottom = -farShadowExtent;
      farSunLight.shadow.camera.updateProjectionMatrix();
      farSunLight.shadow.needsUpdate = true;
    }
    if (farSunLight.shadow.mapSize.width !== lod.farShadowMapSize) {
      farSunLight.shadow.mapSize.set(lod.farShadowMapSize, lod.farShadowMapSize);
      if (farSunLight.shadow.map) {
        farSunLight.shadow.map.dispose();
        farSunLight.shadow.map = null;
      }
      farSunLight.shadow.needsUpdate = true;
    }
  };

  const setShadowExtent = (extent: number) => {
    const clamped = Math.max(8, Math.min(30, extent));
    if (Math.abs(clamped - shadowExtent) < 0.05) return;
    shadowExtent = clamped;
    sunLight.shadow.camera.left = -shadowExtent;
    sunLight.shadow.camera.right = shadowExtent;
    sunLight.shadow.camera.top = shadowExtent;
    sunLight.shadow.camera.bottom = -shadowExtent;
    sunLight.shadow.camera.updateProjectionMatrix();
  };

  const setEnvironmentIntensity = (intensity: number) => {
    envIntensityScale = intensity;
    syncDomeVisibility();
  };

  const setReflectionExcludedLayer = (layer: number) => {
    reflectionExcludedLayer = layer;
    if (desertScrub) setInstancedLayer(desertScrub, layer);
    if (grassField) grassField.setLayer(layer);
    if (rainyHighwayEnv) rainyHighwayEnv.setReflectionExcludedLayer(layer);
  };

  const _shadowUpHint = new THREE.Vector3();
  const _shadowRight = new THREE.Vector3();
  const _shadowUp = new THREE.Vector3();
  const atmosphericIblParamsScratch: {
    sunDir: THREE.Vector3;
    sunColor: THREE.Color;
    skyColor: THREE.Color;
    groundBounce: THREE.Color;
    fogColor: THREE.Color;
    biome: EnvironmentBiome;
    weather: WeatherPreset;
  } = {
    sunDir: sunDirection,
    sunColor: sunColorLinear,
    skyColor: skyColorLinear,
    groundBounce: groundBounceLinear,
    fogColor: fogColorLinear,
    biome: activeBiome,
    weather: activeWeather,
  };

  const updateSun = (
    elevationDeg: number,
    azimuthDeg: number,
    focusTarget: THREE.Vector3,
    updateShadowTarget = true,
    updateFarShadowTarget = false,
  ) => {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    sunDirection.setFromSphericalCoords(1, phi, theta).normalize();

    if (cloudDomeMat && mudCloudDome) {
      cloudDomeMat.uniforms.uSunDir.value.copy(sunDirection);
      mudCloudDome.position.set(focusTarget.x, 0, focusTarget.z);
    }
    if (desertSkyDome) {
      desertSkyDome.position.set(focusTarget.x, 0, focusTarget.z);
    }
    // Align distant erg horizon ring Y with the heightfield outerRise envelope (r > 52m -> up to +11.5m)
    // so driving beyond 70m never causes the horizon ring to slice through or drop beneath outer clipmap dunes.
    if (ergDuneMesh) {
      const focusDist = Math.hypot(focusTarget.x, focusTarget.z);
      const rimT = Math.max(0, Math.min(1, (focusDist - 52.0) / 140.0));
      const rimBaseY = rimT * rimT * (3.0 - 2.0 * rimT) * 11.5;
      ergDuneMesh.position.set(focusTarget.x, rimBaseY, focusTarget.z);
    }

    const lowSunT = 1.0 - THREE.MathUtils.smoothstep(elevationDeg, 6, 44);
    const spec = WEATHER_PRESET_SPECS[activeWeather];

    if (activeBiome === 'rainy_highway') {
      // Cold misty 6:30 AM morning drizzle with subtle warm sunrise hint (Images 1, 2, 3)
      sunColorLinear.setRGB(1.14, 1.04, 0.96);
      skyColorLinear.setRGB(0.62, 0.66, 0.70);
      groundBounceLinear.setRGB(0.16, 0.15, 0.14);
      fogColorLinear.setRGB(0.57, 0.59, 0.61);
      sunGlowLinear.setRGB(0.76, 0.58, 0.48);

      fog.color.copy(fogColorLinear);
      sunLight.color.setRGB(0.95, 0.91, 0.87);
      sunLight.intensity = 1.45;
      hemiLight.color.copy(skyColorLinear);
      hemiLight.groundColor.copy(groundBounceLinear);
      hemiLight.intensity = 1.05;
    } else if (activeBiome === 'mud_grass') {
      // Humid overcast countryside daylight subtly modulated by weather preset
      const warmShift = activeWeather === 'sunset_blaze' ? 0.38 : activeWeather === 'golden_hour' ? 0.14 : 0.0;
      sunColorLinear.setRGB(
        THREE.MathUtils.lerp(1.02, 1.38, warmShift) * THREE.MathUtils.lerp(1.0, 0.90, lowSunT),
        THREE.MathUtils.lerp(1.02, 0.92, warmShift) * THREE.MathUtils.lerp(1.0, 0.89, lowSunT),
        THREE.MathUtils.lerp(1.01, 0.68, warmShift) * THREE.MathUtils.lerp(1.0, 0.87, lowSunT),
      );
      skyColorLinear.setRGB(0.55, 0.60, 0.65);
      groundBounceLinear.setRGB(0.14, 0.13, 0.10);
      fogColorLinear.setRGB(
        THREE.MathUtils.lerp(0.45, 0.50, warmShift),
        THREE.MathUtils.lerp(0.49, 0.44, warmShift),
        THREE.MathUtils.lerp(0.51, 0.41, warmShift),
      );
      sunGlowLinear.setRGB(0.45, 0.46, 0.44);

      fog.color.copy(fogColorLinear);
      if (cloudDomeMat) cloudDomeMat.uniforms.uFogColor.value.copy(fogColorLinear);

      sunLight.color.setRGB(
        Math.min(1, sunColorLinear.r * 0.9),
        Math.min(1, sunColorLinear.g * 0.9),
        Math.min(1, sunColorLinear.b * 0.9),
      );
      sunLight.intensity = THREE.MathUtils.lerp(1.48, 1.18, lowSunT);
      hemiLight.color.copy(skyColorLinear);
      hemiLight.groundColor.copy(groundBounceLinear);
      hemiLight.intensity = 0.94;
    } else {
      // Weather-driven Sahara lighting palette smoothly responsive to manual sun elevation too
      sunColorLinear.setRGB(spec.sunColor[0], spec.sunColor[1], spec.sunColor[2]);
      skyColorLinear.setRGB(spec.skyColor[0], spec.skyColor[1], spec.skyColor[2]);
      groundBounceLinear.setRGB(spec.groundBounce[0], spec.groundBounce[1], spec.groundBounce[2]);
      fogColorLinear.setRGB(spec.fogColor[0], spec.fogColor[1], spec.fogColor[2]);
      sunGlowLinear.setRGB(spec.sunGlow[0], spec.sunGlow[1], spec.sunGlow[2]);

      // Modulate warmth dynamically if user drags sun elevation slider independently
      if (!spec.isOvercast && activeWeather === 'golden_hour') {
        sunColorLinear.setRGB(
          THREE.MathUtils.lerp(1.52, 1.98, lowSunT),
          THREE.MathUtils.lerp(1.32, 1.20, lowSunT),
          THREE.MathUtils.lerp(1.08, 0.72, lowSunT),
        );
      }

      fog.color.copy(fogColorLinear);
      if (desertSkyMat) {
        desertSkyMat.uniforms.uSunDir.value.copy(sunDirection);
        desertSkyMat.uniforms.uFogColor.value.copy(fogColorLinear);
        desertSkyMat.uniforms.uZenithSky.value.setRGB(spec.zenithSky[0], spec.zenithSky[1], spec.zenithSky[2]);
        desertSkyMat.uniforms.uMidSky.value.setRGB(spec.midSky[0], spec.midSky[1], spec.midSky[2]);
        desertSkyMat.uniforms.uSunGlow.value.copy(sunGlowLinear);
        desertSkyMat.uniforms.uIsOvercast.value = spec.isOvercast ? 1.0 : 0.0;
      }

      if (ergDuneMat) {
        ergDuneMat.uniforms.uSunDir.value.copy(sunDirection);
        ergDuneMat.uniforms.uSunColor.value.copy(sunColorLinear);
        ergDuneMat.uniforms.uSkyColor.value.copy(skyColorLinear);
        ergDuneMat.uniforms.uGroundBounceColor.value.copy(groundBounceLinear);
        ergDuneMat.uniforms.uFogColor.value.copy(fogColorLinear);
        ergDuneMat.uniforms.uFogDensity.value = fog.density;
      }

      sunLight.color.setRGB(
        Math.min(1, sunColorLinear.r * 0.64),
        Math.min(1, sunColorLinear.g * 0.64),
        Math.min(1, sunColorLinear.b * 0.64),
      );
      sunLight.intensity = spec.sunIntensity;
      hemiLight.color.copy(skyColorLinear);
      hemiLight.groundColor.copy(groundBounceLinear);
      hemiLight.intensity = spec.hemiIntensity;
    }

    // Rebuild procedural HDR Atmospheric PMREM & SH L2 LightProbe when sun/weather/biome changes (zero alloc)
    atmosphericIblParamsScratch.biome = activeBiome;
    atmosphericIblParamsScratch.weather = activeWeather;
    atmosphericIbl.update(scene, atmosphericIblParamsScratch);

    // Only reposition DirectionalLight shadow cameras on frames that actually re-render their cascade,
    // so cached shadow maps remain 100% locked to their exact world-space frustum with zero shadow crawl!
    if (updateShadowTarget || updateFarShadowTarget) {
      if (Math.abs(sunDirection.y) > 0.95) {
        _shadowUpHint.set(1, 0, 0);
      } else {
        _shadowUpHint.set(0, 1, 0);
      }
      _shadowRight.crossVectors(_shadowUpHint, sunDirection).normalize();
      _shadowUp.crossVectors(sunDirection, _shadowRight).normalize();

      const focusRight = focusTarget.dot(_shadowRight);
      const focusUp = focusTarget.dot(_shadowUp);
      const focusAlongSun = focusTarget.dot(sunDirection);

      if (updateShadowTarget) {
        const worldUnitsPerTexel = (shadowExtent * 2) / sunLight.shadow.mapSize.width;
        const u = Math.round(focusRight / worldUnitsPerTexel) * worldUnitsPerTexel;
        const v = Math.round(focusUp / worldUnitsPerTexel) * worldUnitsPerTexel;

        sunLight.target.position
          .set(0, 0, 0)
          .addScaledVector(_shadowRight, u)
          .addScaledVector(_shadowUp, v)
          .addScaledVector(sunDirection, focusAlongSun);
        sunLight.position
          .copy(sunLight.target.position)
          .addScaledVector(sunDirection, 42.0);
        sunLight.target.updateMatrixWorld();
      }

      if (updateFarShadowTarget) {
        const farUnitsPerTexel = (farShadowExtent * 2) / farSunLight.shadow.mapSize.width;
        const fu = Math.round(focusRight / farUnitsPerTexel) * farUnitsPerTexel;
        const fv = Math.round(focusUp / farUnitsPerTexel) * farUnitsPerTexel;

        farSunLight.target.position
          .set(0, 0, 0)
          .addScaledVector(_shadowRight, fu)
          .addScaledVector(_shadowUp, fv)
          .addScaledVector(sunDirection, focusAlongSun);
        farSunLight.position
          .copy(farSunLight.target.position)
          .addScaledVector(sunDirection, 145.0);
        farSunLight.target.updateMatrixWorld();
      }
    }
  };

  return {
    sunLight,
    farSunLight,
    hemiLight,
    fog,
    sunDirection,
    sunColorLinear,
    skyColorLinear,
    groundBounceLinear,
    fogColorLinear,
    sunGlowLinear,
    setBiome,
    setWeather,
    setLinearHdrOutput,
    setShadowQuality,
    setShadowExtent,
    setEnvironmentIntensity,
    setReflectionExcludedLayer,
    getEnvironmentTexture() {
      return atmosphericIbl.getEnvironmentTexture();
    },
    updateGrass(params: GrassUpdateParams) {
      if (activeBiome === 'mud_grass' && grassField && cloudDomeMat) {
        grassField.update(params);
        cloudDomeMat.uniforms.uTime.value = params.time;
      }
    },
    updateRainyCorridor(params: RainyHighwayUpdateParams) {
      if (activeBiome === 'rainy_highway' && rainyHighwayEnv) {
        rainyHighwayEnv.update(params);
      }
    },
    updateSun,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** Procedural smooth sweeping Sahara Erg dune horizon ring (positioned outside the 248m clipmap skirt) */
function createDistantErgDuneRingGeometry(): THREE.BufferGeometry {
  // Per-pixel analytical normals keep distant barchan shadow bands razor-smooth with 90% fewer triangles
  const radialSegs = 18;
  const angularSegs = 96;
  // Clipmap outer radius is ~247.8m; start inner skirt at 230m tucked safely below outer rim elevation
  const rInner = 230.0;
  const rOuter = 680.0;

  const positions: number[] = [];
  const indices: number[] = [];

  for (let ir = 0; ir <= radialSegs; ir++) {
    const t = ir / radialSegs;
    const radius = rInner + (rOuter - rInner) * Math.pow(t, 1.32);
    // Tuck cleanly below the clipmap outer boundary (~248m) before rising smoothly into distant erg ranges
    const skirtFade = THREE.MathUtils.smoothstep(t, 0.05, 0.26);
    const outerRise = Math.pow(t, 1.15) * 28.0;

    for (let ia = 0; ia <= angularSegs; ia++) {
      const ang = (ia / angularSegs) * Math.PI * 2;
      const x = Math.cos(ang) * radius;
      const z = Math.sin(ang) * radius;

      // Silky sweeping S-curved barchan dune chains matching fragment shader analytical normal
      const w1 = Math.sin(x * 0.014 + z * 0.023 + Math.sin(x * 0.0075) * 2.4);
      const c1 = (1.0 - Math.sqrt(w1 * w1 + 0.042)) * 16.5;

      const w2 = Math.cos(x * 0.021 - z * 0.012 + Math.cos(z * 0.0080) * 2.0);
      const c2 = (1.0 - Math.sqrt(w2 * w2 + 0.075)) * 8.8;

      const swell = Math.sin(ang * 2.0 + t * 3.8) * 3.4 + Math.cos(ang * 3.0 - t * 2.4) * 2.2;
      const y = -9.5 + (14.5 + outerRise + c1 + c2 + swell) * skirtFade;

      positions.push(x, y, z);
    }
  }

  const rowStride = angularSegs + 1;
  for (let ir = 0; ir < radialSegs; ir++) {
    for (let ia = 0; ia < angularSegs; ia++) {
      const a = ir * rowStride + ia;
      const b = a + 1;
      const c = (ir + 1) * rowStride + ia;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Procedural crisp organic deciduous/woodland tree silhouette texture (RGBA alpha cutout) */
function createWoodlandTreeTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = makeRng(4207);

  ctx.clearRect(0, 0, size, size);

  // Dark gnarled bark trunk + major boughs
  ctx.fillStyle = '#1b1611';
  ctx.beginPath();
  ctx.moveTo(size * 0.46, size * 0.99);
  ctx.lineTo(size * 0.54, size * 0.99);
  ctx.lineTo(size * 0.515, size * 0.44);
  ctx.lineTo(size * 0.485, size * 0.44);
  ctx.closePath();
  ctx.fill();

  const boughs = [
    [0.50, 0.56, 0.32, 0.36, 4.5],
    [0.50, 0.54, 0.67, 0.35, 4.2],
    [0.50, 0.46, 0.40, 0.25, 3.0],
    [0.50, 0.45, 0.61, 0.26, 3.0],
  ];
  ctx.strokeStyle = '#1b1611';
  for (const [x0, y0, x1, y1, lw] of boughs) {
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(size * x0, size * y0);
    ctx.lineTo(size * x1, size * y1);
    ctx.stroke();
  }

  // Layered organic leafy canopy clusters (deep shadow core -> damp olive-pine mid -> overcast lit upper leaves)
  const clusters = [
    { cx: 0.50, cy: 0.36, rx: 0.27, ry: 0.24, count: 165 },
    { cx: 0.31, cy: 0.42, rx: 0.20, ry: 0.17, count: 120 },
    { cx: 0.69, cy: 0.41, rx: 0.20, ry: 0.17, count: 120 },
    { cx: 0.40, cy: 0.23, rx: 0.19, ry: 0.16, count: 110 },
    { cx: 0.60, cy: 0.24, rx: 0.19, ry: 0.16, count: 110 },
    { cx: 0.50, cy: 0.56, rx: 0.32, ry: 0.12, count: 95 },
  ];

  const darkTones = ['#141b10', '#182113', '#1c2616', '#212b19'];
  const midTones = ['#28351d', '#2d3b21', '#344326', '#26321c'];
  const hiTones = ['#3e4e2d', '#465734', '#394829'];

  // Pass 1: dense inner shadow foliage mass
  for (const cl of clusters) {
    for (let i = 0; i < cl.count; i++) {
      const ang = rand() * Math.PI * 2;
      const rad = Math.pow(rand(), 0.58);
      const px = (cl.cx + Math.cos(ang) * rad * cl.rx) * size;
      const py = (cl.cy + Math.sin(ang) * rad * cl.ry) * size;
      const lr = 4.2 + rand() * 8.5;
      ctx.fillStyle = darkTones[Math.floor(rand() * darkTones.length)];
      ctx.beginPath();
      ctx.ellipse(px, py, lr, lr * (0.72 + rand() * 0.45), rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Pass 2: textured outer foliage tufts & subtle overcast crown lighting
  for (const cl of clusters) {
    for (let i = 0; i < Math.floor(cl.count * 0.8); i++) {
      const ang = rand() * Math.PI * 2;
      const rad = Math.pow(rand(), 0.64);
      const px = (cl.cx + Math.cos(ang) * rad * cl.rx) * size;
      const py = (cl.cy + Math.sin(ang) * rad * cl.ry) * size;
      const lr = 2.6 + rand() * 5.8;
      const topBias = 1.0 - py / size;
      const pal = topBias > 0.62 && rand() > 0.45 ? hiTones : midTones;
      ctx.fillStyle = pal[Math.floor(rand() * pal.length)];
      ctx.beginPath();
      ctx.ellipse(px, py, lr, lr * (0.65 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Procedural ragged low woodland hedgerow / bramble shrub texture (RGBA alpha cutout) */
function createWoodlandShrubTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = makeRng(8191);

  ctx.clearRect(0, 0, size, size);
  const darkTones = ['#131a0f', '#192214', '#1e2817'];
  const midTones = ['#28351c', '#314022', '#394827', '#42522d'];

  for (let i = 0; i < 420; i++) {
    const u = 0.08 + rand() * 0.84;
    const bell = Math.sin(u * Math.PI);
    const v = 0.98 - rand() * (0.28 + 0.46 * bell);
    const px = u * size;
    const py = v * size;
    const lr = 4.0 + rand() * 8.0;
    const isTop = v < 0.64 && rand() > 0.42;
    const pal = isTop ? midTones : darkTones;
    ctx.fillStyle = pal[Math.floor(rand() * pal.length)];
    ctx.beginPath();
    ctx.ellipse(px, py, lr, lr * (0.7 + rand() * 0.4), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function createCrossedBillboardGeometry(width: number, height: number): THREE.BufferGeometry {
  const hw = width * 0.5;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const angles = [0, Math.PI / 3, (Math.PI * 2) / 3];
  for (let i = 0; i < angles.length; i++) {
    const c = Math.cos(angles[i]);
    const s = Math.sin(angles[i]);
    const base = i * 4;
    positions.push(
      -hw * c, 0, -hw * s,
      hw * c, 0, hw * s,
      hw * c, height, hw * s,
      -hw * c, height, -hw * s,
    );
    // Upward-softened normal gives smooth overcast foliage shading across crossed planes
    for (let k = 0; k < 4; k++) normals.push(0, 1, 0);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

function createCrossedFoliageTreeGeometry(): THREE.BufferGeometry {
  return createCrossedBillboardGeometry(11.5, 11.0);
}

function createCrossedShrubGeometry(): THREE.BufferGeometry {
  return createCrossedBillboardGeometry(7.2, 3.8);
}

/** Procedural golden-ochre dry Sahara desert tussock grass tuft (RGBA alpha cutout) */
function createDesertScrubTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = makeRng(5531);

  ctx.clearRect(0, 0, size, size);
  const tones = ['#5a492a', '#756038', '#8d7648', '#a38b56'];

  for (let i = 0; i < 42; i++) {
    const baseX = size * (0.34 + rand() * 0.32);
    const spread = (rand() - 0.5) * size * 0.86;
    const tipY = size * (0.14 + rand() * 0.44);
    const ctrlX = baseX + spread * 0.45;
    const ctrlY = size * (0.55 + rand() * 0.22);

    ctx.strokeStyle = tones[Math.floor(rand() * tones.length)];
    ctx.lineWidth = 1.6 + rand() * 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(baseX, size * 0.99);
    ctx.quadraticCurveTo(ctrlX, ctrlY, baseX + spread, tipY);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates procedural stratified Sahara sandstone Albedo + Bump textures
 * with warm sedimentary bands, dark hairline cracks, and wind-trapped golden sand dust.
 */
function createSandstoneTextures(anisotropy: number): {
  albedo: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
} {
  const size = 512;
  const cA = document.createElement('canvas');
  cA.width = size;
  cA.height = size;
  const ctxA = cA.getContext('2d')!;

  const cB = document.createElement('canvas');
  cB.width = size;
  cB.height = size;
  const ctxB = cB.getContext('2d')!;

  const rand = makeRng(7331);

  // Natural sun-baked Sahara burnt-ochre & weathered desert sandstone base
  ctxA.fillStyle = '#997452';
  ctxA.fillRect(0, 0, size, size);
  ctxB.fillStyle = '#808080';
  ctxB.fillRect(0, 0, size, size);

  // Sedimentary horizontal rock strata bands (warm desert ochre, sienna, umber crevices)
  const strataColors = [
    'rgba(126, 86, 56, 0.44)',
    'rgba(174, 128, 86, 0.40)',
    'rgba(96, 66, 44, 0.48)',
    'rgba(188, 142, 96, 0.34)',
    'rgba(138, 96, 64, 0.38)',
  ];
  for (let b = 0; b < 42; b++) {
    const y0 = (b / 42) * size;
    const bandH = 5 + rand() * 16;
    ctxA.fillStyle = strataColors[b % strataColors.length];
    ctxA.beginPath();
    ctxA.moveTo(0, y0);
    for (let x = 0; x <= size; x += 32) {
      const wave = Math.sin(x * 0.018 + b * 1.3) * 5.0 + Math.cos(x * 0.042 - b) * 2.4;
      ctxA.lineTo(x, y0 + wave);
    }
    ctxA.lineTo(size, y0 + bandH);
    ctxA.lineTo(0, y0 + bandH);
    ctxA.closePath();
    ctxA.fill();

    const bumpVal = Math.round(86 + (b % 3) * 38 + (rand() - 0.5) * 30);
    ctxB.fillStyle = `rgb(${bumpVal},${bumpVal},${bumpVal})`;
    ctxB.fillRect(0, y0, size, bandH * 0.72);
  }

  // Coarse weathered sandstone mineral grain & wind-pitted texture
  for (let i = 0; i < 2600; i++) {
    const px = rand() * size;
    const py = rand() * size;
    const rx = 1.5 + rand() * 5.2;
    const ry = 1.0 + rand() * 2.8;
    const bright = rand();
    if (bright > 0.64) {
      ctxA.fillStyle = 'rgba(198, 174, 138, 0.24)';
      ctxB.fillStyle = 'rgba(218, 218, 218, 0.26)';
    } else if (bright < 0.30) {
      ctxA.fillStyle = 'rgba(62, 48, 34, 0.30)';
      ctxB.fillStyle = 'rgba(36, 36, 36, 0.36)';
    } else {
      ctxA.fillStyle = 'rgba(146, 120, 90, 0.22)';
      ctxB.fillStyle = 'rgba(140, 140, 140, 0.22)';
    }
    ctxA.fillRect(px, py, rx, ry);
    ctxB.fillRect(px, py, rx, ry);
  }

  // Crisp fractured sandstone bedding fissures & wind-etched cracks
  ctxA.lineCap = 'round';
  ctxB.lineCap = 'round';
  for (let c = 0; c < 56; c++) {
    let cx = rand() * size;
    let cy = rand() * size;
    const segs = 4 + Math.floor(rand() * 5);
    const horizontal = rand() > 0.32;
    ctxA.strokeStyle = 'rgba(46, 34, 24, 0.54)';
    ctxA.lineWidth = 1.1 + rand() * 2.1;
    ctxB.strokeStyle = 'rgba(16, 16, 16, 0.72)';
    ctxB.lineWidth = 1.5 + rand() * 2.3;

    ctxA.beginPath();
    ctxB.beginPath();
    ctxA.moveTo(cx, cy);
    ctxB.moveTo(cx, cy);
    for (let s = 0; s < segs; s++) {
      cx += horizontal ? (rand() * 26 + 10) : (rand() - 0.5) * 24;
      cy += horizontal ? (rand() - 0.5) * 10 : (rand() * 22 + 8);
      ctxA.lineTo(cx, cy);
      ctxB.lineTo(cx, cy);
    }
    ctxA.stroke();
    ctxB.stroke();
  }

  const albedo = new THREE.CanvasTexture(cA);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = THREE.RepeatWrapping;
  albedo.wrapT = THREE.RepeatWrapping;
  albedo.anisotropy = anisotropy;
  albedo.needsUpdate = true;

  const bump = new THREE.CanvasTexture(cB);
  bump.wrapS = THREE.RepeatWrapping;
  bump.wrapT = THREE.RepeatWrapping;
  bump.anisotropy = Math.min(4, anisotropy);
  bump.needsUpdate = true;

  return { albedo, bump };
}

/**
 * Builds a single merged BufferGeometry for all climbable sandstone rock slabs.
 * Every vertex height evaluates `sampleBaseTerrainHeight(wx, wz) + evalSingleClimbableRockElevation(slab, wx, wz)`
 * — the EXACT same analytical formula used by VehicleRig's 4-wheel suspension grounding!
 */
function createClimbableRockCourseGeometry(): THREE.BufferGeometry {
  const segs = 36;
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Authentic weathered Sahara desert sandstone tones harmonized with orange sand skirts
  const slabTints = [
    new THREE.Color(0x936646),
    new THREE.Color(0x82573b),
    new THREE.Color(0xa17350),
    new THREE.Color(0x744d33),
  ];
  const sandSkirtTint = new THREE.Color(0xd18146);
  const creviceTint = new THREE.Color(0x523624);
  const tmpColor = new THREE.Color();

  let vertexOffset = 0;

  for (let sIdx = 0; sIdx < CLIMBABLE_ROCK_SLABS.length; sIdx++) {
    const slab = CLIMBABLE_ROCK_SLABS[sIdx];
    const cosY = Math.cos(slab.yaw);
    const sinY = Math.sin(slab.yaw);
    const baseTint = slabTints[slab.colorIndex % slabTints.length];

    const spanX = slab.halfX * 1.22;
    const spanZ = slab.halfZ * 1.22;

    for (let iz = 0; iz <= segs; iz++) {
      const tz = (iz / segs) * 2 - 1;
      const lz = tz * spanZ;

      for (let ix = 0; ix <= segs; ix++) {
        const tx = (ix / segs) * 2 - 1;
        const lx = tx * spanX;

        const wx = slab.x + lx * cosY - lz * sinY;
        const wz = slab.z + lx * sinY + lz * cosY;

        const baseY = sampleBaseTerrainHeight(wx, wz);
        const rockElev = evalSingleClimbableRockElevation(slab, wx, wz);

        // Vertices on the rock match CPU wheel height 1:1; outer perimeter tucks cleanly beneath sand
        const wy = rockElev > 0.002 ? baseY + rockElev : baseY - 0.28;
        positions.push(wx, wy, wz);

        // Crisp sedimentary bedding UVs
        uvs.push((lx * 0.40 + lz * 0.26) + sIdx * 0.37, rockElev * 2.4 + lz * 0.16);

        // Blend sand drift at base -> weathered sandstone -> darker strata shadow along terraced ledges
        const rockExpose = Math.min(1, Math.max(0, (rockElev - 0.015) / 0.12));
        tmpColor.copy(sandSkirtTint).lerp(baseTint, rockExpose);
        const strataCrevice = Math.pow(0.5 + 0.5 * Math.sin(rockElev * 22.0 + sIdx), 3.0) * 0.28 * rockExpose;
        tmpColor.lerp(creviceTint, strataCrevice);
        const topDust = 0.90 + 0.14 * Math.min(1, rockElev / Math.max(0.2, slab.height));
        colors.push(
          Math.min(1, tmpColor.r * topDust),
          Math.min(1, tmpColor.g * topDust),
          Math.min(1, tmpColor.b * topDust),
        );
      }
    }

    const rowStride = segs + 1;
    for (let iz = 0; iz < segs; iz++) {
      for (let ix = 0; ix < segs; ix++) {
        const a = vertexOffset + iz * rowStride + ix;
        const b = a + 1;
        const c = a + rowStride;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    vertexOffset += rowStride * rowStride;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
