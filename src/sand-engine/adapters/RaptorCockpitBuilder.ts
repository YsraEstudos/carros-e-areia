/**
 * RaptorCockpitBuilder.ts
 * High-detail 3D Ford F-150 Raptor R 1st-Person Cockpit Interior matching Reference Image 1:
 *  - Dark charcoal headliner + overhead switch console + frameless central rearview mirror
 *  - Thick sculpted left A-pillar with recessed vertical driver grab handle
 *  - Multi-tier stitched upper dash, instrument binnacle, vertical chrome-rimmed air vents,
 *    diagonal woven carbon-fiber passenger trim, center console & leather door cards
 *  - Detailed Ford Raptor leather steering wheel (red 12-o'clock top stripe, Ford oval + AIRBAG hub,
 *    backlit thumb button clusters, paddle shifters)
 *  - Articulated dual 3D matte-black windshield wiper arms & rubber blades
 *  - Dedicated 3D 12" Digital Instrument Cluster & 12" SYNC 4 Touchscreen meshes
 *  - Custom GLSL3 windshield & side-window raindrop + active wiper clear-arc + interior crack overlays
 */

import * as THREE from 'three';
import { CabinSwitchId } from '../core/CockpitStateModel';
import {
  applyCabinRayTracedLighting,
  CabinRtLightingUniforms,
  createCabinRtLightingUniforms,
} from '../shaders/cabinRayTracedLighting';
import {
  createWindshieldRainMaterial,
  WindshieldRainUniforms,
} from '../shaders/windshieldRain';

export interface CockpitInteractiveSwitch {
  id: CabinSwitchId;
  mesh: THREE.Mesh;
}

export interface CockpitLightingSyncParams {
  bodyWorldMatrix: THREE.Matrix4;
  rayTracedLighting: boolean;
  rtBounceStrength: number;
  ambientLightOn: boolean;
  ambientColorHex: string;
  ambientIntensity: number;
  domeLightOn: boolean;
  headlightPower: number;
  lightbarOn: boolean;
  hazardFlash01: number;
  syncScreenHex: string;
  interiorMirrorYawRad: number;
  interiorMirrorPitchRad: number;
  timeSec: number;
}

export interface RaptorCockpitRig {
  cockpitGroup: THREE.Group;
  steeringWheel: THREE.Group;
  leftWiperPivot: THREE.Group;
  rightWiperPivot: THREE.Group;
  interiorMirrorPivot: THREE.Group;
  clusterScreenMesh: THREE.Mesh;
  syncScreenMesh: THREE.Mesh;
  interiorMirrorLensMesh: THREE.Mesh;
  interactiveSwitches: CockpitInteractiveSwitch[];
  rtUniforms: CabinRtLightingUniforms;
  windshieldRainUniforms: WindshieldRainUniforms;
  sideGlassRainUniforms: WindshieldRainUniforms;
  setClusterTexture: (tex: THREE.Texture) => void;
  setSyncTexture: (tex: THREE.Texture) => void;
  updateWipers: (leftAngleRad: number, rightAngleRad: number, wipeFreshness: number) => void;
  updateLightingAndMirrors: (params: CockpitLightingSyncParams) => void;
  setCockpitActive: (active: boolean) => void;
  dispose: () => void;
}

/**
 * Generates diagonal 2x2 twill carbon-fiber CanvasTexture for the Raptor R passenger dash trim!
 */
function createCarbonFiberTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#141518';
  ctx.fillRect(0, 0, size, size);

  const cell = 8;
  for (let y = 0; y < size; y += cell) {
    for (let x = 0; x < size; x += cell) {
      const diag = ((x / cell + y / cell) % 4 + 4) % 4;
      const bright = diag === 0 || diag === 1;
      const g = ctx.createLinearGradient(x, y, x + cell, y + cell);
      if (bright) {
        g.addColorStop(0, '#2e3136');
        g.addColorStop(0.5, '#464a52');
        g.addColorStop(1, '#23262a');
      } else {
        g.addColorStop(0, '#101214');
        g.addColorStop(0.5, '#1b1d21');
        g.addColorStop(1, '#0c0d0f');
      }
      ctx.fillStyle = g;
      ctx.fillRect(x, y, cell, cell);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(9, 3);
  tex.anisotropy = 8;
  return tex;
}

/**
 * Generates realistic dark pebbled & perforated steering-wheel leather CanvasTexture
 * with subtle red-orange contrast stitching seam.
 */
function createSteeringLeatherTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#15171b';
  ctx.fillRect(0, 0, w, h);

  // Subtle fine leather grain noise
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const frac = n - Math.floor(n);
      const lum = Math.floor(17 + frac * 11);
      ctx.fillStyle = `rgb(${lum},${lum + 1},${lum + 3})`;
      ctx.fillRect(x, y, 3, 3);
    }
  }

  // Perforated leather dimple pattern along the grip belt
  ctx.fillStyle = '#08090b';
  for (let y = 8; y < h; y += 12) {
    const offset = ((y / 12) % 2) * 6;
    for (let x = 6; x < w; x += 12) {
      ctx.beginPath();
      ctx.arc((x + offset) % w, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Subtle Code-Orange contrast stitch track along inner rim seam (v ~ 0.5)
  ctx.strokeStyle = 'rgba(196, 62, 24, 0.55)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(0, h * 0.5);
  ctx.lineTo(w, h * 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 1);
  tex.anisotropy = 8;
  return tex;
}

/**
 * Generates crisp 512x512 Ford Raptor airbag shield texture: fine pebbled leather,
 * subtle perimeter stitch crease, dark satin Ford oval emblem, and embossed AIRBAG text.
 */
function createSteeringHubTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  // Rich soft-touch pebbled charcoal leather gradient
  const bg = ctx.createRadialGradient(w * 0.5, h * 0.36, 24, w * 0.5, h * 0.5, w * 0.65);
  bg.addColorStop(0, '#22252b');
  bg.addColorStop(0.55, '#14161a');
  bg.addColorStop(1, '#090a0d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Subtle pebbled leather texture speckles
  for (let i = 0; i < 2400; i++) {
    const px = ((i * 73.13) % w);
    const py = ((i * 197.41) % h);
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.028)' : 'rgba(0,0,0,0.14)';
    ctx.fillRect(px, py, 2, 2);
  }

  // Subtle molded airbag tear-seam contour around the shield perimeter
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(38, 42, w - 76, h - 84, 58);
  ctx.stroke();

  // Iconic Ford oval emblem (dark brushed navy-black core + gleaming satin silver rim)
  ctx.save();
  ctx.translate(w * 0.5, h * 0.45);
  const rimGrad = ctx.createLinearGradient(0, -56, 0, 56);
  rimGrad.addColorStop(0, '#c2cad6');
  rimGrad.addColorStop(0.5, '#666e7b');
  rimGrad.addColorStop(1, '#9ca5b3');
  ctx.strokeStyle = rimGrad;
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.ellipse(0, 0, 118, 52, 0, 0, Math.PI * 2);
  ctx.stroke();

  const ovalGrad = ctx.createLinearGradient(0, -48, 0, 48);
  ovalGrad.addColorStop(0, '#172336');
  ovalGrad.addColorStop(0.5, '#0d1522');
  ovalGrad.addColorStop(1, '#080c14');
  ctx.fillStyle = ovalGrad;
  ctx.fill();

  ctx.strokeStyle = 'rgba(210, 222, 238, 0.55)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, 104, 41, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#d4dce8';
  ctx.font = 'italic 700 60px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Ford', 0, 2);
  ctx.restore();

  // Subtle debossed "AIRBAG" lettering below oval
  ctx.fillStyle = '#707784';
  ctx.font = '600 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('A I R B A G', w * 0.5, h * 0.77);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Generates high-resolution 256x256 OEM Ford Raptor steering-wheel switch-pod textures
 * with realistic subtle white-ice backlit icons (Cruise/Volume left, 5-way/Raptor Mode right).
 */
function createSpokeButtonsTexture(isLeft: boolean): THREE.CanvasTexture {
  const w = 256;
  const h = 192;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  // Matte satin-black switch housing face
  ctx.fillStyle = '#111317';
  ctx.fillRect(0, 0, w, h);

  // Subtle recessed keycap borders
  const keys = isLeft
    ? [
        { x: 18, y: 16, kw: 68, kh: 46, t: 'RES' },
        { x: 96, y: 16, kw: 64, kh: 46, t: 'VOL+' },
        { x: 170, y: 16, kw: 68, kh: 46, t: 'LANE' },
        { x: 18, y: 72, kw: 68, kh: 46, t: 'SET' },
        { x: 96, y: 72, kw: 64, kh: 46, t: 'MUTE' },
        { x: 170, y: 72, kw: 68, kh: 46, t: 'LIM' },
        { x: 18, y: 128, kw: 68, kh: 46, t: 'CNCL' },
        { x: 96, y: 128, kw: 64, kh: 46, t: 'VOL-' },
        { x: 170, y: 128, kw: 68, kh: 46, t: 'DIST' },
      ]
    : [
        { x: 18, y: 16, kw: 68, kh: 46, t: '▲' },
        { x: 96, y: 16, kw: 64, kh: 46, t: 'R', accent: true },
        { x: 170, y: 16, kw: 68, kh: 46, t: 'EXH' },
        { x: 18, y: 72, kw: 68, kh: 46, t: 'OK' },
        { x: 96, y: 72, kw: 64, kh: 46, t: 'STR' },
        { x: 170, y: 72, kw: 68, kh: 46, t: 'SUSP' },
        { x: 18, y: 128, kw: 68, kh: 46, t: '▼' },
        { x: 96, y: 128, kw: 64, kh: 46, t: 'MIC' },
        { x: 170, y: 128, kw: 68, kh: 46, t: 'TEL' },
      ];

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const k of keys) {
    ctx.fillStyle = '#181b21';
    ctx.beginPath();
    ctx.roundRect(k.x, k.y, k.kw, k.kh, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = k.accent ? 'rgba(232, 92, 42, 0.92)' : 'rgba(208, 224, 240, 0.78)';
    ctx.font = k.accent ? '800 22px sans-serif' : '700 17px monospace';
    ctx.fillText(k.t, k.x + k.kw * 0.5, k.y + k.kh * 0.5 + 1);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Generates brushed metallic "RAPTOR" lower-spoke emblem badge texture.
 */
function createRaptorBadgeTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 64;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#30343c');
  g.addColorStop(0.5, '#1e2127');
  g.addColorStop(1, '#2b2f37');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(180, 190, 205, 0.28)';
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, w - 8, h - 8);

  ctx.fillStyle = '#cfd6e0';
  ctx.font = '800 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('R A P T O R', w * 0.5, h * 0.52);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Builds a realistic contoured Ford Raptor R steering wheel rim with:
 *  - Ovalized ergonomic grip cross-section
 *  - Sculpted 10-and-2 thumb bolsters swelling gently inward
 *  - Subtle sporty D-flat contour at 6 o'clock
 */
function buildContouredRaptorRimGeometry(
  majorRadius = 0.195,
  ringSegs = 72,
  tubeSegs = 18,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= ringSegs; i++) {
    const u = i / ringSegs;
    const theta = u * Math.PI * 2; // 0 = +X (9h), PI/2 = +Y (12h), PI = -X (3h), 3PI/2 = -Y (6h)
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    // Subtle sporty flat-bottom D-cut at 6 o'clock (sinT < -0.78)
    let rMajor = majorRadius;
    if (sinT < -0.78) {
      const f = (-0.78 - sinT) / 0.22;
      rMajor -= f * f * 0.0065;
    }

    // Ergonomic 10-o'clock (theta ~ 128 deg) and 2-o'clock (theta ~ 52 deg) thumb bolsters
    const ang10 = (128 * Math.PI) / 180;
    const ang2 = (52 * Math.PI) / 180;
    const d10 = Math.atan2(Math.sin(theta - ang10), Math.cos(theta - ang10));
    const d2 = Math.atan2(Math.sin(theta - ang2), Math.cos(theta - ang2));
    const bolster =
      Math.exp(-(d10 * d10) / (2 * 0.16 * 0.16)) +
      Math.exp(-(d2 * d2) / (2 * 0.16 * 0.16));

    // Slightly thicker palm grips around 9-and-3
    const grip93 = Math.pow(Math.abs(cosT), 2.5);

    const cx = cosT * rMajor;
    const cy = sinT * rMajor;

    for (let j = 0; j <= tubeSegs; j++) {
      const v = j / tubeSegs;
      const phi = v * Math.PI * 2; // 0 = outer radial, PI = inner radial (toward hub), +-PI/2 = +-Z
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);

      // Ovalized ergonomic cross-section: slightly deeper front-to-back (Z) than radially
      let rRad = 0.0156 + grip93 * 0.0018;
      let rDepth = 0.0184 + grip93 * 0.0022;

      // Sculpted inward thumb bolster swell on inner half (cosP < 0)
      if (cosP < 0 && bolster > 0.02) {
        const innerFactor = Math.pow(-cosP, 1.4);
        rRad += bolster * innerFactor * 0.0072;
        rDepth += bolster * innerFactor * 0.0028;
      }

      const radialOff = cosP * rRad;
      const px = cx + cosT * radialOff;
      const py = cy + sinT * radialOff;
      const pz = sinP * rDepth;

      positions.push(px, py, pz);
      uvs.push(u, v);
    }
  }

  const stride = tubeSegs + 1;
  for (let i = 0; i < ringSegs; i++) {
    for (let j = 0; j < tubeSegs; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = (i + 1) * stride + (j + 1);
      const d = i * stride + (j + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Generates subtle default boot placeholder screen for Phase 3 (replaced live by Phase 4 CockpitDisplayRenderer!).
 */
function createInitialScreenPlaceholder(label: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#07090d';
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = '#e07b18';
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildRaptorCockpitInterior(
  bodyGroup: THREE.Group,
  sharedRtUniforms?: CabinRtLightingUniforms,
): RaptorCockpitRig {
  const disposableGeos: THREE.BufferGeometry[] = [];
  const disposableMats: THREE.Material[] = [];
  const disposableTex: THREE.Texture[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    disposableGeos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    disposableMats.push(m);
    return m;
  };
  const trackTex = <T extends THREE.Texture>(t: T): T => {
    disposableTex.push(t);
    return t;
  };

  const cockpitGroup = new THREE.Group();
  bodyGroup.add(cockpitGroup);

  const add = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ): THREE.Mesh => {
    trackGeo(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = false;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // --- Rich Moody Charcoal/Black Ford Raptor R Interior Materials (matches Image 1 high-contrast cab) ---
  const headlinerMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x060708,
      roughness: 0.95,
      metalness: 0.02,
    }),
  );
  const rtUniforms = sharedRtUniforms ?? createCabinRtLightingUniforms();

  const dashLeatherMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x0e1014,
      roughness: 0.56,
      metalness: 0.10,
    }),
  );
  applyCabinRayTracedLighting(dashLeatherMat, rtUniforms, {
    specStrength: 0.68,
    giStrength: 0.96,
    areaRoughness: 0.38,
    cacheKey: 'std_rt',
  });

  const dashPlasticMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x090b0f,
      roughness: 0.42,
      metalness: 0.18,
    }),
  );
  applyCabinRayTracedLighting(dashPlasticMat, rtUniforms, {
    specStrength: 0.82,
    giStrength: 0.80,
    areaRoughness: 0.30,
    cacheKey: 'std_rt',
  });

  const glossBezelMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x06070a,
      roughness: 0.12,
      metalness: 0.32,
    }),
  );
  applyCabinRayTracedLighting(glossBezelMat, rtUniforms, {
    specStrength: 1.55,
    giStrength: 0.56,
    areaRoughness: 0.09,
    cacheKey: 'std_rt',
  });

  const satinChromeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x767e8b,
      roughness: 0.22,
      metalness: 0.88,
    }),
  );
  applyCabinRayTracedLighting(satinChromeMat, rtUniforms, {
    specStrength: 1.65,
    giStrength: 0.78,
    areaRoughness: 0.13,
    cacheKey: 'std_rt',
  });

  const wiperRubberMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x0a0b0d,
      roughness: 0.58,
      metalness: 0.18,
    }),
  );
  const redAccentMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd93018,
      emissive: 0x8a1808,
      emissiveIntensity: 0.45,
      roughness: 0.38,
      metalness: 0.2,
    }),
  );

  // Dynamic customizable Ambient LED Light Pipe material (synced live from SYNC 4 Luzes tab!)
  const ambientLedMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff7830,
      emissive: 0xff5a14,
      emissiveIntensity: 2.45,
      roughness: 0.16,
      metalness: 0.04,
      toneMapped: false,
    }),
  );
  const doorGlowMat = ambientLedMat;

  // Dynamic Overhead Dome / Map LED frosted lens material
  const domeLensMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd8dce2,
      emissive: 0xfff0d4,
      emissiveIntensity: 0.05,
      roughness: 0.22,
      metalness: 0.04,
    }),
  );

  const carbonTex = trackTex(createCarbonFiberTexture());
  const carbonTrimMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: carbonTex,
      roughness: 0.18,
      metalness: 0.28,
      clearcoat: 0.96,
      clearcoatRoughness: 0.08,
    }),
  );
  applyCabinRayTracedLighting(carbonTrimMat, rtUniforms, {
    specStrength: 1.52,
    giStrength: 0.92,
    areaRoughness: 0.11,
    cacheKey: 'phys_rt',
  });

  const hubTex = trackTex(createSteeringHubTexture());
  const hubEmblemMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: hubTex,
      roughness: 0.48,
      metalness: 0.24,
    }),
  );
  applyCabinRayTracedLighting(hubEmblemMat, rtUniforms, {
    specStrength: 0.96,
    giStrength: 1.02,
    areaRoughness: 0.28,
    cacheKey: 'std_rt',
  });

  const leftBtnTex = trackTex(createSpokeButtonsTexture(true));
  const rightBtnTex = trackTex(createSpokeButtonsTexture(false));
  const leftBtnMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: leftBtnTex,
      emissive: 0x8fb8dc,
      emissiveMap: leftBtnTex,
      emissiveIntensity: 0.56,
      roughness: 0.42,
    }),
  );
  const rightBtnMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: rightBtnTex,
      emissive: 0x8fb8dc,
      emissiveMap: rightBtnTex,
      emissiveIntensity: 0.56,
      roughness: 0.42,
    }),
  );

  // Single unified 3D Interior Bounce PointLight (all 6 area/tube/dome emitters are ray-traced in shader!)
  const cabinBounceLight = new THREE.PointLight(0xff5a14, 0.55, 3.8, 1.5);
  cabinBounceLight.position.set(0.06, 1.66, 0.68);
  cockpitGroup.add(cabinBounceLight);

  // =========================================================================
  // 1. DARK HEADLINER, OVERHEAD CLICKABLE SWITCH CONSOLE, DOME LIGHTS & MIRROR
  // =========================================================================
  applyCabinRayTracedLighting(headlinerMat, rtUniforms, {
    specStrength: 0.24,
    giStrength: 0.86,
    areaRoughness: 0.65,
    cacheKey: 'std_rt',
  });

  // Full dark matte headliner ceiling + front header brow (frames top ~22% of Image 1!)
  add(cockpitGroup, new THREE.BoxGeometry(1.52, 0.055, 1.18), headlinerMat, 0, 1.968, 0.24);
  add(cockpitGroup, new THREE.BoxGeometry(1.52, 0.11, 0.22), headlinerMat, 0, 1.945, 0.74, 0.24, 0, 0);

  // Sculpted Overhead Auxiliary Switch & Dome Console Pod (matches top-right housing in Image 1!)
  add(cockpitGroup, new THREE.BoxGeometry(0.46, 0.095, 0.36), dashPlasticMat, -0.02, 1.91, 0.74, 0.14, 0, 0);
  add(cockpitGroup, new THREE.BoxGeometry(0.34, 0.045, 0.16), headlinerMat, -0.02, 1.88, 0.84, 0.28, 0, 0);

  // Twin Frosted Overhead Dome / Map LED Lenses (light up warmly when Dome Light is ON!)
  add(cockpitGroup, new THREE.BoxGeometry(0.088, 0.012, 0.054), domeLensMat, 0.095, 1.856, 0.66, 0.14, 0, 0);
  add(cockpitGroup, new THREE.BoxGeometry(0.088, 0.012, 0.054), domeLensMat, -0.135, 1.856, 0.66, 0.14, 0, 0);

  // 5 Clickable Backlit Raptor Overhead Upfitter Switches (AUX 1..5 -> Headlights / Lightbar / Hazard / Dome / Ambient)
  const interactiveSwitches: CockpitInteractiveSwitch[] = [];
  const switchPipMats: Record<CabinSwitchId, THREE.MeshStandardMaterial> = {} as Record<
    CabinSwitchId,
    THREE.MeshStandardMaterial
  >;
  const switchDefs: Array<{ id: CabinSwitchId; x: number }> = [
    { id: 'headlights', x: 0.10 },
    { id: 'lightbar', x: 0.04 },
    { id: 'hazard', x: -0.02 },
    { id: 'dome', x: -0.08 },
    { id: 'ambient', x: -0.14 },
  ];
  for (const sw of switchDefs) {
    const pipMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x303846,
        emissive: 0xff7a1a,
        emissiveIntensity: 0.2,
        roughness: 0.25,
        toneMapped: false,
      }),
    );
    switchPipMats[sw.id] = pipMat;
    const swMesh = add(
      cockpitGroup,
      new THREE.BoxGeometry(0.044, 0.022, 0.044),
      dashLeatherMat,
      sw.x,
      1.855,
      0.74,
      0.14,
      0,
      0,
    );
    swMesh.name = `raptor_switch_${sw.id}`;
    interactiveSwitches.push({ id: sw.id, mesh: swMesh });
    // Glowing LED status pip along front edge of each toggle rocker
    add(cockpitGroup, new THREE.BoxGeometry(0.028, 0.008, 0.009), pipMat, sw.x, 1.844, 0.722, 0.14, 0, 0);
  }

  // Driver & Passenger folded dark Sun Visors
  add(cockpitGroup, new THREE.BoxGeometry(0.46, 0.028, 0.18), headlinerMat, 0.46, 1.93, 0.74, 0.18, 0, 0);
  add(cockpitGroup, new THREE.BoxGeometry(0.46, 0.028, 0.18), headlinerMat, -0.48, 1.93, 0.74, 0.18, 0, 0);

  // Articulated Central Interior Frameless Rearview Mirror (physically pivots when adjusted on Espelhos tab!)
  add(cockpitGroup, new THREE.BoxGeometry(0.026, 0.075, 0.03), dashPlasticMat, -0.02, 1.855, 0.80, 0.25, 0, 0);
  const interiorMirrorPivot = new THREE.Group();
  interiorMirrorPivot.position.set(-0.02, 1.80, 0.77);
  interiorMirrorPivot.rotation.set(0.05, 0.12, 0);
  cockpitGroup.add(interiorMirrorPivot);
  add(interiorMirrorPivot, new THREE.BoxGeometry(0.24, 0.070, 0.026), glossBezelMat, 0, 0, 0);
  const interiorMirrorLensMesh = add(
    interiorMirrorPivot,
    new THREE.PlaneGeometry(0.222, 0.056),
    satinChromeMat,
    0,
    0,
    -0.015,
    0,
    Math.PI,
    0,
  );

  // =========================================================================
  // 2. THICK SCULPTED A-PILLARS + ICONIC RECESSED LEFT DRIVER GRAB HANDLE
  // =========================================================================
  for (const side of [-1, 1]) {
    // Inner A-pillar matte-charcoal trim cladding matching windshield rake
    add(
      cockpitGroup,
      new THREE.BoxGeometry(0.088, 0.78, 0.095),
      dashLeatherMat,
      side * 0.79,
      1.68,
      0.99,
      -0.62,
      0,
      side * 0.18,
    );
    // Inner door upper window sill trim + door card + red ambient accent glow
    add(cockpitGroup, new THREE.BoxGeometry(0.075, 0.52, 0.96), dashLeatherMat, side * 0.81, 1.12, 0.72);
    add(cockpitGroup, new THREE.BoxGeometry(0.095, 0.065, 0.92), dashPlasticMat, side * 0.80, 1.35, 0.74);
    add(cockpitGroup, new THREE.BoxGeometry(0.09, 0.06, 0.42), dashLeatherMat, side * 0.77, 1.15, 0.68); // armrest
    // Continuous recessed door-card ambient LED light pipe + illuminated handle pocket
    add(cockpitGroup, new THREE.BoxGeometry(0.012, 0.044, 0.022), doorGlowMat, side * 0.772, 1.31, 0.92);
    add(cockpitGroup, new THREE.BoxGeometry(0.008, 0.007, 0.64), ambientLedMat, side * 0.766, 1.318, 0.64);
  }

  // Signature Left A-Pillar Recessed Vertical Driver Grab Handle (prominent on left in Image 1!)
  const grabGroup = new THREE.Group();
  grabGroup.position.set(0.755, 1.66, 0.99);
  grabGroup.rotation.set(-0.62, 0, 0.18);
  cockpitGroup.add(grabGroup);
  // Sculpted dark outer bezel housing
  add(grabGroup, new THREE.BoxGeometry(0.068, 0.34, 0.052), dashPlasticMat, -0.025, 0, -0.035);
  // Vertical contoured grab bar standing off the pillar with air gap behind it
  add(grabGroup, new THREE.BoxGeometry(0.034, 0.25, 0.028), dashLeatherMat, -0.045, 0, -0.072);
  add(grabGroup, new THREE.BoxGeometry(0.038, 0.038, 0.055), dashPlasticMat, -0.038, 0.125, -0.052);
  add(grabGroup, new THREE.BoxGeometry(0.038, 0.038, 0.055), dashPlasticMat, -0.038, -0.125, -0.052);

  // =========================================================================
  // 3. MULTI-TIER F-150 RAPTOR R DASHBOARD, CHROME VENTS & CARBON FIBER TRIM
  // =========================================================================
  // Forward upper dashboard shelf sits CLEANLY in front of the recessed screens (z = 1.00..1.25) so ZERO occlusion!
  add(cockpitGroup, new THREE.BoxGeometry(1.56, 0.055, 0.28), dashLeatherMat, 0, 1.432, 1.135);
  // Subtle forward defroster grille vents along cowl base
  for (const dx of [-0.42, -0.14, 0.14, 0.42]) {
    add(cockpitGroup, new THREE.BoxGeometry(0.18, 0.012, 0.05), dashPlasticMat, dx, 1.462, 1.16);
  }
  // Solid dark lower dashboard bulkhead & steering-column cowl (sits cleanly BEHIND z=0.972 cluster & z=0.922 SYNC 4!)
  add(cockpitGroup, new THREE.BoxGeometry(1.56, 0.36, 0.16), dashPlasticMat, 0, 1.06, 1.09);
  add(cockpitGroup, new THREE.BoxGeometry(0.62, 0.24, 0.04), dashPlasticMat, 0.40, 1.24, 1.035);

  // Sculpted Driver Instrument Cluster Hood Binnacle (arches cleanly over 12" digital cluster)
  add(cockpitGroup, new THREE.BoxGeometry(0.46, 0.028, 0.22), dashLeatherMat, 0.40, 1.432, 0.99, 0.06, 0, 0);
  add(cockpitGroup, new THREE.BoxGeometry(0.032, 0.19, 0.18), dashLeatherMat, 0.62, 1.335, 1.00);
  add(cockpitGroup, new THREE.BoxGeometry(0.032, 0.19, 0.18), dashLeatherMat, 0.185, 1.335, 1.00);
  // Dark recessed cluster backing cavity behind the screen (z = 1.015)
  add(cockpitGroup, new THREE.BoxGeometry(0.42, 0.19, 0.03), glossBezelMat, 0.40, 1.335, 1.015);

  // 12" Digital Instrument Cluster Display Mesh (100% framed inside steering wheel upper opening!)
  const clusterPlaceholder = trackTex(createInitialScreenPlaceholder('RAPTOR · 12" CLUSTER'));
  const clusterMat = trackMat(
    new THREE.MeshBasicMaterial({
      map: clusterPlaceholder,
      toneMapped: false,
    }),
  );
  const clusterScreenMesh = add(
    cockpitGroup,
    new THREE.PlaneGeometry(0.365, 0.140),
    clusterMat,
    0.40,
    1.325,
    0.972,
    -0.05,
    Math.PI,
    0,
  );
  clusterScreenMesh.name = 'raptor_cluster_screen';

  // Center Stack Upper Brow + Satin Brushed Horizontal Accent Strip above SYNC 4 (matches Image 1!)
  add(cockpitGroup, new THREE.BoxGeometry(0.46, 0.024, 0.14), dashLeatherMat, -0.04, 1.448, 0.985);
  add(cockpitGroup, new THREE.BoxGeometry(0.24, 0.007, 0.012), satinChromeMat, -0.04, 1.444, 0.916);

  // Main SYNC 4 glossy outer frame (behind screen at z = 0.946)
  add(cockpitGroup, new THREE.BoxGeometry(0.39, 0.268, 0.036), glossBezelMat, -0.04, 1.305, 0.946, -0.06, 0.06, 0);

  // 12" SYNC 4 Interactive Touchscreen Mesh (front face at z = 0.922, angled toward driver, ZERO occlusion!)
  const syncPlaceholder = trackTex(createInitialScreenPlaceholder('SYNC 4 · SPOTIFY'));
  const syncMat = trackMat(
    new THREE.MeshBasicMaterial({
      map: syncPlaceholder,
      toneMapped: false,
    }),
  );
  const syncScreenMesh = add(
    cockpitGroup,
    new THREE.PlaneGeometry(0.362, 0.242),
    syncMat,
    -0.04,
    1.305,
    0.922,
    -0.06,
    Math.PI + 0.06,
    0,
  );
  syncScreenMesh.name = 'raptor_sync4_screen';

  // Iconic Vertical Chrome-Accent HVAC Air Vents Flanking Both Sides of SYNC 4 Screen (matches Image 1!)
  for (const vx of [0.185, -0.265]) {
    add(cockpitGroup, new THREE.BoxGeometry(0.058, 0.242, 0.044), dashPlasticMat, vx, 1.305, 0.942, -0.06, 0, 0);
    add(cockpitGroup, new THREE.BoxGeometry(0.007, 0.232, 0.048), satinChromeMat, vx + 0.026, 1.305, 0.938, -0.06, 0, 0);
    add(cockpitGroup, new THREE.BoxGeometry(0.007, 0.232, 0.048), satinChromeMat, vx - 0.026, 1.305, 0.938, -0.06, 0, 0);
    for (let lv = -4; lv <= 4; lv++) {
      add(cockpitGroup, new THREE.BoxGeometry(0.044, 0.006, 0.024), dashLeatherMat, vx, 1.305 + lv * 0.022, 0.922, -0.06, 0, 0);
    }
    add(cockpitGroup, new THREE.BoxGeometry(0.02, 0.011, 0.026), satinChromeMat, vx, 1.305, 0.914, -0.06, 0, 0);
  }

  // Physical HVAC Knobs & Tactile Strip below SYNC 4 screen
  add(cockpitGroup, new THREE.BoxGeometry(0.42, 0.068, 0.042), dashPlasticMat, -0.04, 1.148, 0.935, -0.14, 0, 0);
  for (const kx of [0.1, -0.18]) {
    const knobGeo = new THREE.CylinderGeometry(0.017, 0.019, 0.02, 16);
    knobGeo.rotateX(Math.PI / 2);
    add(cockpitGroup, knobGeo, satinChromeMat, kx, 1.148, 0.908, -0.14, 0, 0);
  }

  // Diagonal Woven CARBON-FIBER Passenger Dash Trim Panel + Glowing Ambient LED Light Pipes!
  add(cockpitGroup, new THREE.BoxGeometry(0.52, 0.168, 0.032), carbonTrimMat, -0.55, 1.315, 0.946, -0.06, 0, 0);
  add(cockpitGroup, new THREE.BoxGeometry(0.53, 0.011, 0.038), satinChromeMat, -0.55, 1.404, 0.940, -0.06, 0, 0);
  add(cockpitGroup, new THREE.BoxGeometry(0.53, 0.011, 0.038), satinChromeMat, -0.55, 1.226, 0.950, -0.06, 0, 0);

  // Recessed Optical LED Ambient Light Pipes (cast real RT/PT specular ribbons onto carbon, chrome & leather!)
  add(cockpitGroup, new THREE.BoxGeometry(0.525, 0.006, 0.009), ambientLedMat, -0.55, 1.396, 0.926, -0.06, 0, 0);
  add(cockpitGroup, new THREE.BoxGeometry(0.525, 0.005, 0.009), ambientLedMat, -0.55, 1.233, 0.936, -0.06, 0, 0);
  // Center SYNC 4 upper & lower recessed LED halo accent strips
  add(cockpitGroup, new THREE.BoxGeometry(0.38, 0.0055, 0.009), ambientLedMat, -0.04, 1.436, 0.922, -0.06, 0.06, 0);
  add(cockpitGroup, new THREE.BoxGeometry(0.38, 0.0055, 0.009), ambientLedMat, -0.04, 1.180, 0.922, -0.10, 0.06, 0);
  // Subtle instrument binnacle brow LED edge light
  add(cockpitGroup, new THREE.BoxGeometry(0.38, 0.005, 0.008), ambientLedMat, 0.40, 1.416, 0.948, 0.04, 0, 0);

  // Center Console Tunnel + Raptor Leather Gear Selector + Illuminated Console Trim
  add(cockpitGroup, new THREE.BoxGeometry(0.36, 0.30, 0.88), dashPlasticMat, 0, 0.98, 0.44);
  add(cockpitGroup, new THREE.BoxGeometry(0.32, 0.055, 0.44), dashLeatherMat, 0, 1.14, 0.24);
  add(cockpitGroup, new THREE.BoxGeometry(0.006, 0.006, 0.46), ambientLedMat, 0.165, 1.132, 0.56);
  add(cockpitGroup, new THREE.BoxGeometry(0.006, 0.006, 0.46), ambientLedMat, -0.165, 1.132, 0.56);
  add(cockpitGroup, new THREE.CylinderGeometry(0.013, 0.015, 0.12, 10), satinChromeMat, 0.08, 1.18, 0.66, 0.14, 0, 0);
  add(cockpitGroup, new THREE.BoxGeometry(0.078, 0.038, 0.044), dashLeatherMat, 0.08, 1.24, 0.675);

  // =========================================================================
  // 4. SCULPTED FORD F-150 RAPTOR R LEATHER STEERING WHEEL (REF IMAGE 1)
  // =========================================================================
  const wheelLeatherTex = trackTex(createSteeringLeatherTexture());
  const wheelLeatherMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: wheelLeatherTex,
      roughness: 0.50,
      metalness: 0.10,
    }),
  );
  applyCabinRayTracedLighting(wheelLeatherMat, rtUniforms, {
    specStrength: 0.92,
    giStrength: 1.02,
    areaRoughness: 0.32,
    cacheKey: 'std_rt',
  });

  const gunmetalTrimMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x4c5360,
      roughness: 0.24,
      metalness: 0.84,
    }),
  );
  applyCabinRayTracedLighting(gunmetalTrimMat, rtUniforms, {
    specStrength: 1.55,
    giStrength: 0.86,
    areaRoughness: 0.14,
    cacheKey: 'std_rt',
  });

  const magnesiumPaddleMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x626a78,
      roughness: 0.20,
      metalness: 0.88,
    }),
  );
  applyCabinRayTracedLighting(magnesiumPaddleMat, rtUniforms, {
    specStrength: 1.58,
    giStrength: 0.82,
    areaRoughness: 0.13,
    cacheKey: 'std_rt',
  });

  const raptorTopMarkerMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xc22e14,
      emissive: 0x3a0a04,
      emissiveIntensity: 0.24,
      roughness: 0.40,
      metalness: 0.12,
    }),
  );
  applyCabinRayTracedLighting(raptorTopMarkerMat, rtUniforms, {
    specStrength: 1.0,
    giStrength: 0.9,
    areaRoughness: 0.25,
    cacheKey: 'std_rt',
  });

  const raptorBadgeTex = trackTex(createRaptorBadgeTexture());
  const raptorBadgeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: raptorBadgeTex,
      roughness: 0.28,
      metalness: 0.74,
    }),
  );
  applyCabinRayTracedLighting(raptorBadgeMat, rtUniforms, {
    specStrength: 1.42,
    giStrength: 0.88,
    areaRoughness: 0.15,
    cacheKey: 'std_rt',
  });

  // Steering column shroud + left turn-signal/wiper multifunction stalk (tucked below cluster opening)
  add(cockpitGroup, new THREE.CylinderGeometry(0.044, 0.056, 0.26, 18), dashPlasticMat, 0.40, 1.225, 0.855, Math.PI / 2 + 0.16, 0, 0);
  // Left indicator/wiper stalk extending cleanly from behind steering column
  add(cockpitGroup, new THREE.CylinderGeometry(0.007, 0.009, 0.125, 10), dashPlasticMat, 0.505, 1.258, 0.795, 0, 0, Math.PI / 2 + 0.16);
  add(cockpitGroup, new THREE.CylinderGeometry(0.0105, 0.009, 0.032, 12), gunmetalTrimMat, 0.568, 1.268, 0.795, 0, 0, Math.PI / 2 + 0.16);

  const steeringWheel = new THREE.Group();
  steeringWheel.position.set(0.40, 1.305, 0.70);
  steeringWheel.rotation.x = 0.22;
  cockpitGroup.add(steeringWheel);

  // 4A. Sculpted Contoured Perforated-Leather Rim (10-and-2 thumb bolsters + subtle D-bottom)
  const rimGeo = buildContouredRaptorRimGeometry(0.195, 72, 18);
  add(steeringWheel, rimGeo, wheelLeatherMat, 0, 0, 0);

  // 4B. Flush Code-Orange / Dark-Crimson 12-o'clock Centering Leather Band + Stitched Seams
  const topBandGeo = new THREE.TorusGeometry(0.195, 0.0176, 14, 16, 0.105);
  add(steeringWheel, topBandGeo, raptorTopMarkerMat, 0, 0, 0, 0, 0, Math.PI / 2 - 0.0525);
  // Twin dark stitch-seam rings flanking the 12-o'clock marker
  for (const seamAng of [Math.PI / 2 - 0.055, Math.PI / 2 + 0.055]) {
    add(
      steeringWheel,
      new THREE.TorusGeometry(0.0179, 0.0016, 8, 16),
      dashPlasticMat,
      Math.cos(seamAng) * 0.195,
      Math.sin(seamAng) * 0.195,
      0,
      Math.PI / 2,
      seamAng,
      0,
    );
  }

  // 4C. Sculpted Beveled Ford F-150 Trapezoidal Airbag Shield Boss (ExtrudeGeometry!)
  const shieldShape = new THREE.Shape();
  shieldShape.moveTo(-0.064, 0.044);
  shieldShape.quadraticCurveTo(0, 0.056, 0.064, 0.044);
  shieldShape.quadraticCurveTo(0.076, 0.040, 0.075, 0.016);
  shieldShape.lineTo(0.058, -0.054);
  shieldShape.quadraticCurveTo(0.052, -0.072, 0.032, -0.075);
  shieldShape.lineTo(-0.032, -0.075);
  shieldShape.quadraticCurveTo(-0.052, -0.072, -0.058, -0.054);
  shieldShape.lineTo(-0.075, 0.016);
  shieldShape.quadraticCurveTo(-0.076, 0.040, -0.064, 0.044);

  const airbagBossGeo = new THREE.ExtrudeGeometry(shieldShape, {
    depth: 0.024,
    bevelEnabled: true,
    bevelThickness: 0.013,
    bevelSize: 0.010,
    bevelSegments: 4,
    curveSegments: 16,
  });
  airbagBossGeo.center();
  add(steeringWheel, airbagBossGeo, dashLeatherMat, 0, -0.046, 0.002);

  // Curved front airbag emblem face (facing driver -Z) + 3D raised chrome Ford oval bezel
  const emblemPlaneGeo = new THREE.PlaneGeometry(0.118, 0.106);
  add(steeringWheel, emblemPlaneGeo, hubEmblemMat, 0, -0.046, -0.024, 0, Math.PI, 0);
  const fordChromeOvalGeo = new THREE.TorusGeometry(0.026, 0.0022, 10, 32);
  fordChromeOvalGeo.scale(1.22, 0.56, 1.0);
  add(steeringWheel, fordChromeOvalGeo, satinChromeMat, 0, -0.040, -0.025);

  // 4D. Sculpted Swept Horizontal Multi-Function Spokes (Left & Right) + 3D Switch Pods
  const buildSideSpoke = (side: 1 | -1) => {
    const spShape = new THREE.Shape();
    spShape.moveTo(0.052 * side, 0.026);
    spShape.lineTo(0.184 * side, 0.020);
    spShape.quadraticCurveTo(0.194 * side, 0.0, 0.184 * side, -0.028);
    spShape.lineTo(0.048 * side, -0.038);
    spShape.closePath();

    const spGeo = new THREE.ExtrudeGeometry(spShape, {
      depth: 0.016,
      bevelEnabled: true,
      bevelThickness: 0.005,
      bevelSize: 0.004,
      bevelSegments: 3,
    });
    add(steeringWheel, spGeo, dashPlasticMat, 0, -0.044, -0.002);

    // Subtle brushed-gunmetal lower accent trim bar framing the switch pod
    add(
      steeringWheel,
      new THREE.BoxGeometry(0.112, 0.0065, 0.014),
      gunmetalTrimMat,
      side * 0.118,
      -0.077,
      -0.006,
      0,
      0,
      side * 0.06,
    );

    // Recessed physical switch-pod housing + crisp 256x192 backlit OEM Ford icons
    const podGeo = new THREE.BoxGeometry(0.076, 0.054, 0.012);
    add(steeringWheel, podGeo, glossBezelMat, side * 0.116, -0.044, -0.009);
    add(
      steeringWheel,
      new THREE.PlaneGeometry(0.072, 0.050),
      side > 0 ? leftBtnMat : rightBtnMat,
      side * 0.116,
      -0.044,
      -0.016,
      0,
      Math.PI,
      0,
    );

    // Sleek 3D molded switch-pod divider ribs framing the backlit key columns without covering icons
    for (const dx of [-0.0115, 0.0115]) {
      add(
        steeringWheel,
        new THREE.BoxGeometry(0.0022, 0.046, 0.0028),
        dashPlasticMat,
        side * 0.116 + dx,
        -0.044,
        -0.0162,
      );
    }
    // Subtle raised satin-metallic outer frame lip around the switch pod
    add(
      steeringWheel,
      new THREE.BoxGeometry(0.078, 0.003, 0.004),
      gunmetalTrimMat,
      side * 0.116,
      -0.016,
      -0.0155,
    );
  };
  buildSideSpoke(1);  // Left spoke (+X)
  buildSideSpoke(-1); // Right spoke (-X)

  // 4E. Sculpted Split-V Open Lower Spoke with Brushed Gunmetal Y-Bezel & RAPTOR Badge
  for (const side of [1, -1] as const) {
    // Twin angled structural spoke legs creating the authentic open center triangle
    add(
      steeringWheel,
      new THREE.BoxGeometry(0.022, 0.098, 0.018),
      dashPlasticMat,
      side * 0.028,
      -0.140,
      0.004,
      0,
      0,
      side * 0.18,
    );
    // Brushed gunmetal outer metallic Y-trim rail
    add(
      steeringWheel,
      new THREE.BoxGeometry(0.010, 0.096, 0.021),
      gunmetalTrimMat,
      side * 0.036,
      -0.140,
      0.002,
      0,
      0,
      side * 0.18,
    );
  }
  // Sculpted bottom gunmetal collar + embossed "RAPTOR" nameplate at 6 o'clock
  add(steeringWheel, new THREE.BoxGeometry(0.068, 0.022, 0.024), gunmetalTrimMat, 0, -0.178, 0.001);
  add(steeringWheel, new THREE.PlaneGeometry(0.056, 0.014), raptorBadgeMat, 0, -0.178, -0.012, 0, Math.PI, 0);

  // 4F. Sculpted Curved Cast-Magnesium Paddle Shifters ("-" Left, "+" Right)
  const buildPaddle = (side: 1 | -1) => {
    const pShape = new THREE.Shape();
    pShape.moveTo(0, -0.026);
    pShape.lineTo(0.026 * side, -0.022);
    pShape.quadraticCurveTo(0.036 * side, 0.010, 0.024 * side, 0.038);
    pShape.lineTo(0.004 * side, 0.034);
    pShape.quadraticCurveTo(-0.004 * side, 0.005, 0, -0.026);
    const pGeo = new THREE.ExtrudeGeometry(pShape, {
      depth: 0.005,
      bevelEnabled: true,
      bevelThickness: 0.0018,
      bevelSize: 0.0015,
      bevelSegments: 2,
    });
    add(steeringWheel, pGeo, magnesiumPaddleMat, side * 0.106, -0.010, 0.024, 0, side * -0.12, side * 0.10);
    // Subtle red "-" / "+" shift indicator accent at top tip of magnesium paddle
    add(
      steeringWheel,
      new THREE.BoxGeometry(0.009, 0.0024, 0.002),
      raptorTopMarkerMat,
      side * 0.120,
      0.016,
      0.022,
    );
    if (side < 0) {
      // Vertical crossbar for "+" on right upshift paddle
      add(
        steeringWheel,
        new THREE.BoxGeometry(0.0024, 0.009, 0.002),
        raptorTopMarkerMat,
        side * 0.120,
        0.016,
        0.022,
      );
    }
  };
  buildPaddle(1);  // Left "-" downshift paddle
  buildPaddle(-1); // Right "+" upshift paddle

  // =========================================================================
  // 5. DUAL ARTICULATED 3D MATTE-BLACK WINDSHIELD WIPER ARMS & RUBBER BLADES
  // =========================================================================
  const wiperPlaneGroup = new THREE.Group();
  wiperPlaneGroup.position.set(0, 1.362, 1.215);
  wiperPlaneGroup.rotation.x = -0.62;
  cockpitGroup.add(wiperPlaneGroup);

  const buildWiperAssembly = (pivotX: number, armLen: number, bladeLen: number): THREE.Group => {
    const pivot = new THREE.Group();
    pivot.position.set(pivotX, 0.010, 0.024);
    wiperPlaneGroup.add(pivot);

    // Pivot nut cap on cowl
    const capGeo = new THREE.CylinderGeometry(0.013, 0.016, 0.018, 10);
    capGeo.rotateX(Math.PI / 2);
    add(pivot, capGeo, wiperRubberMat, 0, 0, 0);

    // Sleek articulated matte-black aero arm extending rightward (-X)
    add(pivot, new THREE.BoxGeometry(armLen, 0.0085, 0.009), wiperRubberMat, -armLen * 0.5, 0.006, 0.006);
    // Sleek low-profile aero-beam rubber wiper blade hugging glass
    add(pivot, new THREE.BoxGeometry(bladeLen, 0.0115, 0.012), wiperRubberMat, -armLen * 0.88, 0.014, -0.002);
    add(pivot, new THREE.BoxGeometry(bladeLen * 0.98, 0.0045, 0.008), glossBezelMat, -armLen * 0.88, 0.007, -0.009);
    return pivot;
  };

  const leftWiperPivot = buildWiperAssembly(0.56, 0.46, 0.54);
  const rightWiperPivot = buildWiperAssembly(-0.02, 0.48, 0.56);

  // =========================================================================
  // 6. CUSTOM GLSL3 WINDSHIELD & SIDE-WINDOW RAINDROP + WIPER CLEAR-ARC SHADERS
  // =========================================================================
  const frontRain = createWindshieldRainMaterial(false);
  const sideRain = createWindshieldRainMaterial(true);
  trackMat(frontRain.material);
  trackMat(sideRain.material);

  const frontRainGeo = trackGeo(new THREE.PlaneGeometry(1.54, 0.76));
  const frontRainMesh = new THREE.Mesh(frontRainGeo, frontRain.material);
  frontRainMesh.position.set(0, 1.68, 0.988);
  frontRainMesh.rotation.set(-0.62, Math.PI, 0);
  frontRainMesh.renderOrder = 3;
  cockpitGroup.add(frontRainMesh);

  const sideRainGeo = trackGeo(new THREE.PlaneGeometry(0.80, 0.57));
  for (const side of [-1, 1]) {
    const sideRainMesh = new THREE.Mesh(sideRainGeo, sideRain.material);
    sideRainMesh.position.set(side * 0.826, 1.66, 0.66);
    sideRainMesh.rotation.set(0, side > 0 ? -Math.PI / 2 : Math.PI / 2, 0);
    sideRainMesh.rotateX(-0.195);
    sideRainMesh.renderOrder = 3;
    cockpitGroup.add(sideRainMesh);
  }

  const updateWipers = (
    leftAngleRad: number,
    rightAngleRad: number,
    wipeFreshness: number,
  ) => {
    leftWiperPivot.rotation.z = -leftAngleRad;
    rightWiperPivot.rotation.z = -rightAngleRad;
    frontRain.uniforms.uWiperLeftAngle.value = leftAngleRad;
    frontRain.uniforms.uWiperRightAngle.value = rightAngleRad;
    frontRain.uniforms.uWipeFreshness.value = wipeFreshness;
  };

  let cockpitViewActive = false;
  cabinBounceLight.visible = false;

  const setCockpitActive = (active: boolean) => {
    cockpitViewActive = active;
    cabinBounceLight.visible = active;
    if (!active) {
      rtUniforms.uRtEnabled.value = 0.0;
    }
  };

  const updateLightingAndMirrors = (p: CockpitLightingSyncParams) => {
    // 1. Sync exact inverse body matrix for vehicle-local Ray-Traced Area-Light reflections!
    const rtActive = cockpitViewActive && p.rayTracedLighting;
    if (cockpitViewActive) {
      rtUniforms.uCabinInvMatrix.value.copy(p.bodyWorldMatrix).invert();
    }
    rtUniforms.uRtEnabled.value = rtActive ? 1.0 : 0.0;
    rtUniforms.uRtBounceGain.value = p.rtBounceStrength;
    rtUniforms.uTime.value = p.timeSec;

    // 2. Ambient LED Light Pipes + Unified Cabin Fill Light
    const ambPower = p.ambientLightOn ? p.ambientIntensity : 0.0;
    rtUniforms.uAmbientColor.value.set(p.ambientColorHex);
    rtUniforms.uAmbientIntensity.value = ambPower;

    ambientLedMat.color.set(p.ambientColorHex);
    ambientLedMat.emissive.set(p.ambientColorHex);
    ambientLedMat.emissiveIntensity = p.ambientLightOn ? 0.65 + ambPower * 1.75 : 0.04;

    // 3. Overhead Dome / Map LED Light + Frosted Lenses
    const domePower = p.domeLightOn ? 1.0 : 0.0;
    rtUniforms.uDomeIntensity.value = domePower;
    domeLensMat.emissiveIntensity = p.domeLightOn ? 3.2 : 0.05;

    cabinBounceLight.visible = cockpitViewActive;
    if (cockpitViewActive) {
      if (p.domeLightOn) {
        cabinBounceLight.color.setHex(0xfff0d4);
        cabinBounceLight.intensity = p.rayTracedLighting ? 1.65 : 1.05;
        cabinBounceLight.position.set(0.06, 1.78, 0.64);
      } else if (p.ambientLightOn) {
        cabinBounceLight.color.set(p.ambientColorHex);
        cabinBounceLight.intensity = (p.rayTracedLighting ? 0.26 : 0.10) * ambPower;
        cabinBounceLight.position.set(0.04, 1.38, 0.80);
      } else {
        cabinBounceLight.color.set(p.syncScreenHex);
        cabinBounceLight.intensity = p.rayTracedLighting ? 0.14 : 0.04;
        cabinBounceLight.position.set(-0.04, 1.32, 0.76);
      }
    }

    // 4. Dynamic 12" SYNC 4 Screen Bounce Light & Cluster Reflection
    rtUniforms.uSyncScreenColor.value.set(p.syncScreenHex);
    rtUniforms.uSyncScreenIntensity.value = 1.0;
    rtUniforms.uClusterIntensity.value = 0.92;

    // 5. Exterior Headlight / Roof Lightbar / Blinking Hazard Cabin Bounce
    rtUniforms.uHeadlightBounce.value = p.headlightPower;
    rtUniforms.uLightbarPower.value = p.lightbarOn ? 1.0 : 0.0;
    rtUniforms.uHazardFlash.value = p.hazardFlash01;

    // 6. Overhead Upfitter Switch LED Status Pips
    switchPipMats.headlights.emissive.setHex(p.headlightPower > 1.1 ? 0x38bdf8 : 0x22c55e);
    switchPipMats.headlights.emissiveIntensity = p.headlightPower > 0.05 ? 2.4 : 0.08;
    switchPipMats.lightbar.emissive.setHex(0xe0f2fe);
    switchPipMats.lightbar.emissiveIntensity = p.lightbarOn ? 2.6 : 0.08;
    switchPipMats.hazard.emissive.setHex(0xff3b14);
    switchPipMats.hazard.emissiveIntensity = p.hazardFlash01 > 0.1 ? 3.2 : 0.12;
    switchPipMats.dome.emissive.setHex(0xffe09a);
    switchPipMats.dome.emissiveIntensity = p.domeLightOn ? 2.5 : 0.08;
    switchPipMats.ambient.emissive.set(p.ambientColorHex);
    switchPipMats.ambient.emissiveIntensity = p.ambientLightOn ? 2.4 : 0.08;

    // 7. Physical Articulation of Central Interior Rearview Mirror Housing
    interiorMirrorPivot.rotation.set(
      0.05 + p.interiorMirrorPitchRad * 0.55,
      0.12 + p.interiorMirrorYawRad * 0.55,
      0,
    );
  };

  // Initial iconic low-angled wiper stance (~15 deg) matching Reference Image 1
  updateWipers(0.24, 0.22, 0.92);

  return {
    cockpitGroup,
    steeringWheel,
    leftWiperPivot,
    rightWiperPivot,
    interiorMirrorPivot,
    clusterScreenMesh,
    syncScreenMesh,
    interiorMirrorLensMesh,
    interactiveSwitches,
    rtUniforms,
    windshieldRainUniforms: frontRain.uniforms,
    sideGlassRainUniforms: sideRain.uniforms,
    setClusterTexture: (tex: THREE.Texture) => {
      clusterMat.map = tex;
      clusterMat.needsUpdate = true;
    },
    setSyncTexture: (tex: THREE.Texture) => {
      syncMat.map = tex;
      syncMat.needsUpdate = true;
    },
    updateWipers,
    updateLightingAndMirrors,
    setCockpitActive,
    dispose: () => {
      for (const g of disposableGeos) g.dispose();
      for (const m of disposableMats) m.dispose();
      for (const t of disposableTex) t.dispose();
    },
  };
}
