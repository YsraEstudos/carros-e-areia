/**
 * RainyHighwayEnvironment.ts
 * Complete 3D roadside world for the `'rainy_highway'` biome matching Reference Images 1, 2 & 3:
 *  - Misty 6:30 AM overcast sky dome with warm sunrise horizon hint
 *  - Infinite-corridor recentered Eucalyptus trees on +X left shoulder (mottled pale bark trunks,
 *    angled branches, hanging narrow-leaf foliage canopies overhanging the wet asphalt)
 *  - Utility poles + crossarms + sagging catenary power wires on -X right shoulder
 *  - Wooden paddock fence posts (breakable!) + horizontal wire strands on +-11.4m flanks
 *  - Short white roadside guide posts on +-4.55m gravel shoulders
 *  - Dry pale roadside grass tufts lining both verges
 *  - GPU-animated 3D slanted falling rain streaks around the camera
 */

import * as THREE from 'three';
import { InstancedMesh2 } from '@three.ez/instanced-mesh';
import {
  HIGHWAY_CONSTANTS,
  getRainyHighwayObstaclesNear,
  sampleRainyHighwayHeight,
} from '../core/RainyHighwayModel';
import { SceneObjectLodDistances } from '../core/DistanceLodPolicy';

export interface RainyHighwayUpdateParams {
  focusPos: THREE.Vector3;
  cameraPos: THREE.Vector3;
  time: number;
  rainIntensity: number;
  sunDir: THREE.Vector3;
  fogColor: THREE.Color;
  brokenFenceIds?: ReadonlySet<string>;
}

const FOLIAGE_PALETTE = [0x95a08b, 0x86927d, 0xa2ac97, 0x7b8673];
const BARK_PALETTE = [0xcac3b8, 0xbab1a4, 0xd4cdc2, 0xa89f92];
const GRASS_PALETTE = [0xd8cfb6, 0xcac1a7, 0xbdb59c, 0xe0d8c0];
const CROWN_OFFSETS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-3.4, 8.6, 0.5, 1.24],
  [-0.4, 11.2, -0.4, 1.32],
  [2.2, 9.2, 1.3, 1.12],
  [-1.8, 7.2, -1.6, 1.02],
];
const WIRE_X_OFFSETS = [-0.92, 0.0, 0.92] as const;
const STRAND_HEIGHTS = [0.36, 0.72, 1.06] as const;
const GUIDE_SIDES = [-1, 1] as const;

function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash21(px: number, py: number): number {
  const h = Math.sin(px * 127.1 + py * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

/** Procedural pale mottled Australian/rural Eucalyptus bark texture */
function createEucalyptusBarkTexture(anisotropy: number): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const rand = makeRng(3104);

  ctx.fillStyle = '#9c9386';
  ctx.fillRect(0, 0, w, h);

  // Mottled peeling pale cream, warm taupe, and dark damp base bark patches
  for (let i = 0; i < 160; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const rw = 5 + rand() * 18;
    const rh = 18 + rand() * 58;
    const tones = ['#b5aba0', '#8c8376', '#6d6255', '#a79b89', '#776a5c', '#584e43'];
    ctx.fillStyle = tones[Math.floor(rand() * tones.length)];
    ctx.globalAlpha = 0.55 + rand() * 0.35;
    ctx.beginPath();
    ctx.ellipse(x, y, rw * 0.5, rh * 0.5, (rand() - 0.5) * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  // Dark damp vertical fissures & moisture streaks near trunk base
  ctx.globalAlpha = 0.38;
  for (let i = 0; i < 45; i++) {
    ctx.strokeStyle = rand() > 0.4 ? '#3c352d' : '#53493e';
    ctx.lineWidth = 1 + rand() * 2.2;
    const x = rand() * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + (rand() - 0.5) * 10, h * 0.35, x + (rand() - 0.5) * 10, h * 0.7, x, h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1.0;

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Procedural hanging narrow-leaf Eucalyptus canopy silhouette texture (RGBA cutout) */
function createEucalyptusFoliageTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = makeRng(7219);

  ctx.clearRect(0, 0, size, size);

  // Subtle dark slender twigs inside canopy cluster
  ctx.strokeStyle = '#332d26';
  ctx.lineCap = 'round';
  for (let b = 0; b < 14; b++) {
    const startX = size * (0.28 + rand() * 0.44);
    const startY = size * (0.14 + rand() * 0.25);
    const endX = startX + (rand() - 0.5) * size * 0.52;
    const endY = startY + size * (0.22 + rand() * 0.42);
    ctx.lineWidth = 1.4 + rand() * 2.0;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo((startX + endX) * 0.5 + (rand() - 0.5) * 20, (startY + endY) * 0.45, endX, endY);
    ctx.stroke();
  }

  // Drooping narrow lance-shaped Eucalyptus leaf sprays (dark damp olive-sage + misty grey-green)
  const leafColors = ['#2d3527', '#353e2f', '#3d4736', '#46503f', '#242b20', '#4f5947'];
  for (let i = 0; i < 640; i++) {
    const ang = rand() * Math.PI * 2;
    const rad = Math.pow(rand(), 0.55);
    const cx = size * 0.5 + Math.cos(ang) * rad * size * 0.42;
    const cy = size * 0.46 + Math.sin(ang) * rad * size * 0.40;
    // Narrow drooping leaves pointing roughly downward-outward
    const leafLen = 6 + rand() * 11;
    const leafW = 1.8 + rand() * 2.4;
    const droopAng = Math.PI * 0.5 + (rand() - 0.5) * 1.15;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(droopAng);
    ctx.fillStyle = leafColors[Math.floor(rand() * leafColors.length)];
    ctx.beginPath();
    ctx.ellipse(0, 0, leafLen * 0.5, leafW * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Procedural feathery pale dry straw / sage roadside grass tuft texture (arched organic fan, zero boxy edges) */
function createDryRoadsideGrassTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = makeRng(5531);

  ctx.clearRect(0, 0, size, size);
  const tones = ['#cfc4a6', '#bfb494', '#b0a686', '#dad0b4', '#a49b7d', '#c5ba9b'];

  for (let i = 0; i < 240; i++) {
    // Concentrate roots toward center so tuft tapers naturally into an arched meadow clump (zero rectangular edges!)
    const u = 0.16 + rand() * 0.68;
    const centerBias = 1.0 - Math.abs(u - 0.5) * 2.0; // 1 at center, 0 at edges
    const baseX = size * u;
    const maxH = 0.24 + 0.66 * Math.pow(Math.max(0.05, centerBias), 0.55);
    const height = size * (0.20 + rand() * maxH);
    const fanOut = (u - 0.5) * size * 0.42 + (rand() - 0.5) * size * 0.16;
    const ctrlX = baseX + fanOut * 0.48;
    const ctrlY = size - height * 0.62;
    const tipX = baseX + fanOut;
    const tipY = Math.max(8, size - height);

    ctx.strokeStyle = tones[Math.floor(rand() * tones.length)];
    ctx.lineWidth = 1.1 + rand() * 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(baseX, size);
    ctx.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
    ctx.stroke();

    // Delicate pale feathery seedhead plumes on tall central stalks (matches Image 1 & 3 verge grass)
    if (rand() > 0.62 && centerBias > 0.22) {
      ctx.fillStyle = '#ddd4bc';
      ctx.beginPath();
      ctx.ellipse(tipX, tipY, 1.8, 5.2, (fanOut / Math.max(1, height)) * 0.65, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function createCrossedCardsGeometry(
  width: number,
  height: number,
  yOffset = 0,
  cardCount: 2 | 3 = 3,
): THREE.BufferGeometry {
  const hw = width * 0.5;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const angles = cardCount === 2 ? [0, Math.PI * 0.5] : [0, Math.PI / 3, (Math.PI * 2) / 3];
  for (let i = 0; i < angles.length; i++) {
    const c = Math.cos(angles[i]);
    const s = Math.sin(angles[i]);
    const base = i * 4;
    positions.push(
      -hw * c, yOffset, -hw * s,
      hw * c, yOffset, hw * s,
      hw * c, yOffset + height, hw * s,
      -hw * c, yOffset + height, -hw * s,
    );
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

function setInstancedMeshLayer(mesh: InstancedMesh2, layer: number): void {
  mesh.layers.set(layer);
  if (mesh.LODinfo) {
    for (let i = 0; i < mesh.LODinfo.objects.length; i++) {
      mesh.LODinfo.objects[i].layers.set(layer);
    }
  }
}

export class RainyHighwayEnvironment {
  public readonly group = new THREE.Group();
  private readonly disposables: Array<{ dispose(): void }> = [];

  private readonly skyDome: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;

  // Eucalyptus trunks, upper limbs, and hanging foliage canopies
  private readonly maxTrees = 56;
  private readonly trunkMesh: InstancedMesh2;
  private readonly branchMesh: InstancedMesh2;
  private readonly canopyMesh: InstancedMesh2;

  // Utility poles + sagging catenary power wires
  private readonly maxPoles = 14;
  private readonly poleMesh: InstancedMesh2;
  private readonly powerWireGeo: THREE.BufferGeometry;
  private readonly powerWirePosAttr: THREE.BufferAttribute;

  // Wooden fence posts + horizontal wire strands
  private readonly maxFencePosts = 96;
  private readonly fenceWireGeo: THREE.BufferGeometry;
  private readonly fenceWirePosAttr: THREE.BufferAttribute;

  // Short white roadside guide posts
  private readonly maxGuidePosts = 28;

  // BatchedMesh combining utility crossarms, wooden fence posts, and white guide posts into 1 draw call
  private readonly propsBatchedMesh: THREE.BatchedMesh;
  private readonly crossarmInstIds: number[] = [];
  private readonly fencePostInstIds: number[] = [];
  private readonly guidePostInstIds: number[] = [];

  // Dry pale roadside grass tufts
  private readonly grassCount: number;
  private activeGrassCount: number;
  private readonly grassMesh: InstancedMesh2;
  private readonly grassOffsets: Array<{ x: number; zRel: number; scaleW: number; scaleH: number; yaw: number; tintIdx: number }> = [];

  // 3D slanted falling rain streaks
  private readonly rainDropCount: number;
  private readonly rainGeo: THREE.BufferGeometry;
  private readonly rainLines: THREE.LineSegments;
  private readonly rainMat: THREE.ShaderMaterial;

  private lastCorridorStepZ = Number.NaN;
  private lastBrokenCount = -1;
  private readonly dummy = new THREE.Object3D();
  private readonly tmpColor = new THREE.Color();
  private readonly scratchPoles: Array<{ x: number; y: number; z: number }> = [];
  private readonly scratchLeftPosts: Array<{ x: number; y: number; z: number; broken: boolean }> = [];
  private readonly scratchRightPosts: Array<{ x: number; y: number; z: number; broken: boolean }> = [];

  constructor(renderer: THREE.WebGLRenderer, isSoftwareGl: boolean) {
    const maxAniso = renderer.capabilities.getMaxAnisotropy();

    // 1. Misty 6:30 AM Overcast Sky Dome
    const skyGeo = new THREE.SphereGeometry(850, 28, 18);
    this.skyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0.4, 0.13, 0.9) },
        uFogColor: { value: new THREE.Color(0.56, 0.59, 0.61) },
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
        uniform float uLinearHdrOutput;
        out vec4 fragColor;

        void main() {
          vec3 d = normalize(vDir);
          float elev = clamp(d.y, 0.0, 1.0);

          // Cold pale pearl-grey misty morning sky (Images 1, 2, 3)
          vec3 zenithCol = uFogColor * vec3(0.76, 0.80, 0.85);
          vec3 midCol = uFogColor * vec3(1.04, 1.05, 1.06);
          vec3 sky = mix(uFogColor, midCol, smoothstep(0.0, 0.18, elev));
          sky = mix(sky, zenithCol, smoothstep(0.16, 0.72, elev));

          // Subtle low dawn warm peach glow near sun direction behind overcast cloud deck
          float sunAlign = max(0.0, dot(d, normalize(uSunDir)));
          float horizonMask = 1.0 - smoothstep(0.02, 0.28, elev);
          sky += vec3(0.16, 0.095, 0.068) * pow(sunAlign, 4.0) * horizonMask;

          // Seamless lock to exponential mist fog at horizon
          sky = mix(uFogColor, sky, smoothstep(0.0, 0.08, elev));

          if (uLinearHdrOutput < 0.5) {
            sky = (sky * (2.51 * sky + 0.03)) / (sky * (2.43 * sky + 0.59) + 0.14);
            sky = pow(clamp(sky, 0.0, 1.0), vec3(1.0 / 2.2));
          }
          fragColor = vec4(sky, 1.0);
        }
      `,
    });
    this.skyDome = new THREE.Mesh(skyGeo, this.skyMat);
    this.skyDome.renderOrder = -2;
    this.skyDome.frustumCulled = false;
    this.group.add(this.skyDome);
    this.disposables.push(skyGeo, this.skyMat);

    // 2. Eucalyptus Trunks, Upper Limbs & Hanging Foliage Canopies
    const barkTex = createEucalyptusBarkTexture(maxAniso);
    const barkMat = new THREE.MeshStandardMaterial({
      map: barkTex,
      roughness: 0.88,
      metalness: 0.02,
      color: 0xffffff,
    });
    const trunkGeo = new THREE.CylinderGeometry(0.26, 0.48, 12.5, 9, 4);
    trunkGeo.translate(0, 6.0, 0);
    // Slight natural organic trunk bend
    const tp = trunkGeo.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const y = tp.getY(i);
      const t = y / 12.5;
      tp.setX(i, tp.getX(i) + Math.sin(t * Math.PI) * 0.28);
    }
    trunkGeo.computeVertexNormals();

    const barkLodMat = new THREE.MeshLambertMaterial({
      map: barkTex,
      color: 0xffffff,
    });
    const trunkLodGeo = new THREE.CylinderGeometry(0.26, 0.48, 12.5, 5, 1);
    trunkLodGeo.translate(0, 6.0, 0);

    this.trunkMesh = new InstancedMesh2(trunkGeo, barkMat, {
      capacity: this.maxTrees,
      renderer,
    });
    this.trunkMesh.castShadow = !isSoftwareGl;
    this.trunkMesh.receiveShadow = true;
    // Per-instance BVH handles exact frustum culling; disabling whole-mesh sphere culling
    // prevents the entire corridor from vanishing when world origin (0,0,0) leaves view!
    this.trunkMesh.frustumCulled = false;
    this.trunkMesh.perObjectFrustumCulled = true;
    this.trunkMesh.autoUpdateBVH = false;
    this.trunkMesh.addLOD(trunkLodGeo, barkLodMat, 44, 0.08);
    if (!isSoftwareGl) {
      this.trunkMesh.addShadowLOD(trunkLodGeo, 0);
    }

    const branchGeo = new THREE.CylinderGeometry(0.05, 0.16, 4.6, 6, 1);
    branchGeo.translate(0, 2.2, 0);
    this.branchMesh = new InstancedMesh2(branchGeo, barkMat, {
      capacity: this.maxTrees * 3,
      renderer,
    });
    this.branchMesh.castShadow = false;
    this.branchMesh.receiveShadow = true;
    this.branchMesh.frustumCulled = false;
    this.branchMesh.perObjectFrustumCulled = true;
    this.branchMesh.autoUpdateBVH = false;

    const foliageTex = createEucalyptusFoliageTexture(maxAniso);
    const foliageMat = new THREE.MeshLambertMaterial({
      map: foliageTex,
      alphaTest: 0.28,
      side: THREE.DoubleSide,
      color: 0xffffff,
      emissive: new THREE.Color(0x1e241b),
      emissiveIntensity: 0.45,
    });
    const canopyGeo = createCrossedCardsGeometry(8.8, 7.6, -3.2, 3);
    const canopyLodGeo = createCrossedCardsGeometry(8.8, 7.6, -3.2, 2);
    this.canopyMesh = new InstancedMesh2(canopyGeo, foliageMat, {
      capacity: this.maxTrees * 4,
      renderer,
    });
    this.canopyMesh.castShadow = false;
    this.canopyMesh.receiveShadow = false;
    this.canopyMesh.frustumCulled = false;
    this.canopyMesh.perObjectFrustumCulled = true;
    this.canopyMesh.autoUpdateBVH = false;
    this.canopyMesh.addLOD(canopyLodGeo, foliageMat, 50, 0.08);

    this.group.add(this.trunkMesh, this.branchMesh, this.canopyMesh);
    this.disposables.push(
      barkTex,
      barkMat,
      barkLodMat,
      trunkGeo,
      trunkLodGeo,
      branchGeo,
      foliageTex,
      foliageMat,
      canopyGeo,
      canopyLodGeo,
      { dispose: () => { this.trunkMesh.disposeBVH(); this.trunkMesh.dispose(); } },
      { dispose: () => { this.branchMesh.disposeBVH(); this.branchMesh.dispose(); } },
      { dispose: () => { this.canopyMesh.disposeBVH(); this.canopyMesh.dispose(); } },
    );

    // Pre-populate static bark & foliage instance colors ONCE (zero per-rebuild instanceColor uploads)
    this.trunkMesh.addInstances(this.maxTrees);
    this.branchMesh.addInstances(this.maxTrees * 3);
    this.canopyMesh.addInstances(this.maxTrees * 4);
    for (let t = 0; t < this.maxTrees; t++) {
      this.tmpColor.setHex(BARK_PALETTE[t % BARK_PALETTE.length]);
      this.trunkMesh.setColorAt(t, this.tmpColor);
      for (let b = 0; b < 3; b++) {
        this.branchMesh.setColorAt(t * 3 + b, this.tmpColor);
      }
      for (let c = 0; c < 4; c++) {
        this.tmpColor.setHex(FOLIAGE_PALETTE[(t + c) % FOLIAGE_PALETTE.length]);
        this.canopyMesh.setColorAt(t * 4 + c, this.tmpColor);
      }
    }
    this.trunkMesh.clearInstances();
    this.branchMesh.clearInstances();
    this.canopyMesh.clearInstances();

    // 3. Utility Poles + Sagging Power Wires (-X right shoulder)
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x3b322b,
      roughness: 0.85,
      metalness: 0.04,
    });
    const poleLodMat = new THREE.MeshLambertMaterial({ color: 0x3b322b });
    const poleGeo = new THREE.CylinderGeometry(0.14, 0.22, 11.8, 8);
    poleGeo.translate(0, 5.7, 0);
    const poleLodGeo = new THREE.CylinderGeometry(0.14, 0.22, 11.8, 4);
    poleLodGeo.translate(0, 5.7, 0);
    this.poleMesh = new InstancedMesh2(poleGeo, poleMat, {
      capacity: this.maxPoles,
      renderer,
    });
    this.poleMesh.castShadow = !isSoftwareGl;
    this.poleMesh.receiveShadow = true;
    this.poleMesh.frustumCulled = false;
    this.poleMesh.perObjectFrustumCulled = true;
    this.poleMesh.autoUpdateBVH = false;
    this.poleMesh.addLOD(poleLodGeo, poleLodMat, 44, 0.08);
    if (!isSoftwareGl) {
      this.poleMesh.addShadowLOD(poleLodGeo, 0);
    }

    const crossarmGeo = new THREE.BoxGeometry(2.15, 0.16, 0.16);

    // 3 power lines per span * 12 curve segments * (maxPoles - 1) + guy-wires
    const maxWireSegments = (this.maxPoles - 1) * 3 * 12 + this.maxPoles;
    const wirePositions = new Float32Array(maxWireSegments * 2 * 3);
    this.powerWireGeo = new THREE.BufferGeometry();
    this.powerWirePosAttr = new THREE.BufferAttribute(wirePositions, 3);
    this.powerWireGeo.setAttribute('position', this.powerWirePosAttr);
    const wireMat = new THREE.LineBasicMaterial({
      color: 0x222528,
      transparent: true,
      opacity: 0.72,
    });
    const powerWires = new THREE.LineSegments(this.powerWireGeo, wireMat);
    powerWires.frustumCulled = false;

    this.group.add(this.poleMesh, powerWires);
    this.disposables.push(
      poleMat,
      poleLodMat,
      poleGeo,
      poleLodGeo,
      crossarmGeo,
      this.powerWireGeo,
      wireMat,
      { dispose: () => { this.poleMesh.disposeBVH(); this.poleMesh.dispose(); } },
    );

    // 4. Rural Paddock Wooden Fence Posts + Horizontal Wire Strands + White Guide Posts
    const fencePostGeo = new THREE.BoxGeometry(0.14, 1.32, 0.14);
    fencePostGeo.translate(0, 0.58, 0);

    const maxFenceWireSegs = this.maxFencePosts * 3;
    const fenceWirePositions = new Float32Array(maxFenceWireSegs * 2 * 3);
    this.fenceWireGeo = new THREE.BufferGeometry();
    this.fenceWirePosAttr = new THREE.BufferAttribute(fenceWirePositions, 3);
    this.fenceWireGeo.setAttribute('position', this.fenceWirePosAttr);
    const fenceWireMat = new THREE.LineBasicMaterial({
      color: 0x8a8c88,
      transparent: true,
      opacity: 0.55,
    });
    const fenceWires = new THREE.LineSegments(this.fenceWireGeo, fenceWireMat);
    fenceWires.frustumCulled = false;

    const guidePostGeo = new THREE.BoxGeometry(0.11, 0.95, 0.055);
    guidePostGeo.translate(0, 0.44, 0);

    // Consolidate crossarms, fence posts, and guide posts into 1 THREE.BatchedMesh draw call
    const propsBatchedMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.80,
      metalness: 0.03,
    });
    const totalPropInstances = this.maxPoles + this.maxFencePosts + this.maxGuidePosts;
    this.propsBatchedMesh = new THREE.BatchedMesh(totalPropInstances, 256, 256, propsBatchedMat);
    this.propsBatchedMesh.frustumCulled = false;
    this.propsBatchedMesh.perObjectFrustumCulled = true;
    const crossarmGeoId = this.propsBatchedMesh.addGeometry(crossarmGeo);
    const fencePostGeoId = this.propsBatchedMesh.addGeometry(fencePostGeo);
    const guidePostGeoId = this.propsBatchedMesh.addGeometry(guidePostGeo);

    this.tmpColor.setHex(0x3b322b);
    for (let i = 0; i < this.maxPoles; i++) {
      const id = this.propsBatchedMesh.addInstance(crossarmGeoId);
      this.propsBatchedMesh.setColorAt(id, this.tmpColor);
      this.propsBatchedMesh.setVisibleAt(id, false);
      this.crossarmInstIds.push(id);
    }
    this.tmpColor.setHex(0x5c5145);
    for (let i = 0; i < this.maxFencePosts; i++) {
      const id = this.propsBatchedMesh.addInstance(fencePostGeoId);
      this.propsBatchedMesh.setColorAt(id, this.tmpColor);
      this.propsBatchedMesh.setVisibleAt(id, false);
      this.fencePostInstIds.push(id);
    }
    this.tmpColor.setHex(0xdce0e2);
    for (let i = 0; i < this.maxGuidePosts; i++) {
      const id = this.propsBatchedMesh.addInstance(guidePostGeoId);
      this.propsBatchedMesh.setColorAt(id, this.tmpColor);
      this.propsBatchedMesh.setVisibleAt(id, false);
      this.guidePostInstIds.push(id);
    }

    this.group.add(this.propsBatchedMesh, fenceWires);
    this.disposables.push(
      fencePostGeo,
      guidePostGeo,
      propsBatchedMat,
      this.propsBatchedMesh,
      this.fenceWireGeo,
      fenceWireMat,
    );

    // 6. Dry Pale Roadside Grass Tufts bordering both highway shoulders (soft continuous wispy verge)
    const grassTex = createDryRoadsideGrassTexture(maxAniso);
    const grassMat = new THREE.MeshLambertMaterial({
      map: grassTex,
      alphaTest: 0.22,
      side: THREE.DoubleSide,
      color: 0xffffff,
      emissive: new THREE.Color(0x5a5547),
      emissiveIntensity: 0.42,
    });
    const grassGeo = createCrossedCardsGeometry(1.75, 0.78, -0.06, 3);
    const grassLodGeo = createCrossedCardsGeometry(1.75, 0.78, -0.06, 2);
    this.grassCount = isSoftwareGl ? 620 : 960;
    this.activeGrassCount = this.grassCount;
    this.grassMesh = new InstancedMesh2(grassGeo, grassMat, {
      capacity: this.grassCount,
      renderer,
    });
    // Per-instance BVH frustum culling + 2-card distance LOD prevents angle-dependent disappearing grass!
    this.grassMesh.frustumCulled = false;
    this.grassMesh.perObjectFrustumCulled = true;
    this.grassMesh.autoUpdateBVH = false;
    this.grassMesh.addLOD(grassLodGeo, grassMat, 30, 0.08);
    this.grassMesh.addInstances(this.grassCount);

    const gRng = makeRng(8821);
    for (let i = 0; i < this.grassCount; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      // Dense continuous grassy belt right along both gravel shoulders (4.6..11m) + fading into paddock
      const distBias = Math.pow(gRng(), 2.1);
      const x = side * (4.60 + distBias * 20.0);
      const zRel = (gRng() - 0.5) * 140.0;
      const scaleW = 0.85 + gRng() * 1.15;
      const scaleH = 0.52 + gRng() * 0.82;
      const yaw = gRng() * Math.PI * 2;
      const tintIdx = Math.floor(gRng() * 4);
      this.grassOffsets.push({ x, zRel, scaleW, scaleH, yaw, tintIdx });
      this.tmpColor.setHex(GRASS_PALETTE[tintIdx]);
      this.grassMesh.setColorAt(i, this.tmpColor);
    }
    this.group.add(this.grassMesh);
    this.disposables.push(
      grassTex,
      grassMat,
      grassGeo,
      grassLodGeo,
      { dispose: () => { this.grassMesh.disposeBVH(); this.grassMesh.dispose(); } },
    );

    // 7. GPU-Animated 3D Slanted Falling Rain Streaks around camera/vehicle (Image 3!)
    const dropCount = isSoftwareGl ? 750 : 1400;
    this.rainDropCount = dropCount;
    const rainPositions = new Float32Array(dropCount * 2 * 3);
    const rainSeeds = new Float32Array(dropCount * 2 * 3);
    const rainTip = new Float32Array(dropCount * 2);
    const rRng = makeRng(4499);
    for (let i = 0; i < dropCount; i++) {
      const rx = (rRng() - 0.5) * 42.0;
      const ry = rRng() * 22.0;
      const rz = (rRng() - 0.5) * 48.0;
      const speed = 0.85 + rRng() * 0.45;
      const phase = rRng();
      const len = 0.42 + rRng() * 0.36;

      for (let v = 0; v < 2; v++) {
        const idx = (i * 2 + v) * 3;
        rainPositions[idx] = rx;
        rainPositions[idx + 1] = ry;
        rainPositions[idx + 2] = rz;

        rainSeeds[idx] = speed;
        rainSeeds[idx + 1] = phase;
        rainSeeds[idx + 2] = len;

        rainTip[i * 2 + v] = v;
      }
    }
    const rainGeo = new THREE.BufferGeometry();
    this.rainGeo = rainGeo;
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
    rainGeo.setAttribute('aSeed', new THREE.BufferAttribute(rainSeeds, 3));
    rainGeo.setAttribute('aTip', new THREE.BufferAttribute(rainTip, 1));

    this.rainMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uIntensity: { value: 0.78 },
        uRainColor: { value: new THREE.Color(0.84, 0.88, 0.92) },
      },
      vertexShader: /* glsl */ `
        in vec3 aSeed;
        in float aTip;
        uniform float uTime;
        uniform vec3 uCenter;
        out float vAlpha;

        void main() {
          float speed = aSeed.x * 18.5;
          float phase = aSeed.y;
          float streakLen = aSeed.z;

          vec3 rel = position;
          // Wrap rain volume smoothly around camera/vehicle so rain never ends
          rel.x = mod(rel.x - uCenter.x + 21.0, 42.0) - 21.0;
          rel.z = mod(rel.z - uCenter.z + 24.0, 48.0) - 24.0;
          float yFall = mod(rel.y - (uTime * speed + phase * 22.0), 22.0);
          vec3 worldPos = vec3(uCenter.x + rel.x, uCenter.y - 3.0 + yFall, uCenter.z + rel.z);

          // Slight diagonal rain wind slant (matching Image 3 crisp angled streaks)
          vec3 slant = vec3(0.08, -1.0, -0.04) * (aTip * streakLen);
          worldPos += slant;

          float dist = length(worldPos - cameraPosition);
          // Fade out right inside cabin (dist < 1.35m) and beyond 34m mist
          float nearFade = smoothstep(1.35, 2.85, dist);
          float farFade = 1.0 - smoothstep(16.0, 34.0, dist);
          vAlpha = nearFade * farFade * mix(0.28, 0.08, aTip);

          gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uIntensity;
        uniform vec3 uRainColor;
        in float vAlpha;
        out vec4 fragColor;

        void main() {
          float a = vAlpha * uIntensity;
          if (a < 0.008) discard;
          fragColor = vec4(uRainColor, a);
        }
      `,
    });
    this.rainLines = new THREE.LineSegments(rainGeo, this.rainMat);
    this.rainLines.frustumCulled = false;
    this.rainLines.renderOrder = 4;
    this.group.add(this.rainLines);
    this.disposables.push(rainGeo, this.rainMat);

    // Freeze origin-static world-space corridor objects (only skyDome moves with focusPos)
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    const staticCorridorObjects: THREE.Object3D[] = [
      this.trunkMesh,
      this.branchMesh,
      this.canopyMesh,
      this.poleMesh,
      powerWires,
      this.propsBatchedMesh,
      fenceWires,
      this.grassMesh,
      this.rainLines,
    ];
    for (let i = 0; i < staticCorridorObjects.length; i++) {
      staticCorridorObjects[i].matrixAutoUpdate = false;
      staticCorridorObjects[i].updateMatrix();
    }
    this.group.updateMatrixWorld(true);

    // Populate initial corridor at Z = 0
    this.rebuildCorridor(0);
  }

  public setLinearHdrOutput(enabled: boolean): void {
    this.skyMat.uniforms.uLinearHdrOutput.value = enabled ? 1.0 : 0.0;
  }

  public setReflectionExcludedLayer(layer: number): void {
    this.rainLines.layers.set(layer);
    setInstancedMeshLayer(this.grassMesh, layer);
  }

  public setLodDistances(lod: SceneObjectLodDistances): void {
    this.trunkMesh.updateLOD(1, lod.trunkPoleLod1, 0.08);
    this.canopyMesh.updateLOD(1, lod.canopyLod1, 0.08);
    this.poleMesh.updateLOD(1, lod.trunkPoleLod1, 0.08);
    this.grassMesh.updateLOD(1, lod.roadsideGrassLod1, 0.08);
  }

  public setQualityBudgets(grassDensityRatio: number, rainStreakRatio: number): void {
    const gRatio = Math.max(0.3, Math.min(1.0, grassDensityRatio));
    const rRatio = Math.max(0.3, Math.min(1.0, rainStreakRatio));
    this.activeGrassCount = Math.max(1, Math.round(this.grassCount * gRatio));
    for (let i = 0; i < this.grassCount; i++) {
      this.grassMesh.setVisibilityAt(i, i < this.activeGrassCount);
    }
    const activeDrops = Math.max(64, Math.round(this.rainDropCount * rRatio));
    this.rainGeo.setDrawRange(0, activeDrops * 2);
  }

  public update(params: RainyHighwayUpdateParams): void {
    this.skyDome.position.set(params.focusPos.x, 0, params.focusPos.z);
    this.skyMat.uniforms.uSunDir.value.copy(params.sunDir);
    this.skyMat.uniforms.uFogColor.value.copy(params.fogColor);

    this.rainMat.uniforms.uTime.value = params.time;
    this.rainMat.uniforms.uCenter.value.copy(params.cameraPos);
    this.rainMat.uniforms.uIntensity.value = params.rainIntensity;
    this.rainLines.visible = params.rainIntensity > 0.02;

    const stepZ = Math.round(params.focusPos.z / 16.0) * 16.0;
    const brokenCount = params.brokenFenceIds ? params.brokenFenceIds.size : 0;
    if (stepZ !== this.lastCorridorStepZ || brokenCount !== this.lastBrokenCount) {
      this.lastCorridorStepZ = stepZ;
      this.lastBrokenCount = brokenCount;
      this.rebuildCorridor(stepZ, params.brokenFenceIds);
    }
  }

  private rebuildCorridor(centerZ: number, brokenFenceIds?: ReadonlySet<string>): void {
    const obstacles = getRainyHighwayObstaclesNear(centerZ, 128);

    // 1. Place Eucalyptus Trees matching exact CPU obstacle positions (+X left shoulder)
    let eucCount = 0;
    for (let i = 0; i < obstacles.length && eucCount < this.maxTrees; i++) {
      if (obstacles[i].kind === 'eucalyptus') eucCount++;
    }

    if (this.trunkMesh.bvh) this.trunkMesh.disposeBVH();
    if (this.branchMesh.bvh) this.branchMesh.disposeBVH();
    if (this.canopyMesh.bvh) this.canopyMesh.disposeBVH();
    this.trunkMesh.clearInstances();
    this.branchMesh.clearInstances();
    this.canopyMesh.clearInstances();

    if (eucCount > 0) {
      this.trunkMesh.addInstances(eucCount);
      this.branchMesh.addInstances(eucCount * 3);
      this.canopyMesh.addInstances(eucCount * CROWN_OFFSETS.length);
      this.trunkMesh.visible = true;
      this.branchMesh.visible = true;
      this.canopyMesh.visible = true;
    } else {
      this.trunkMesh.visible = false;
      this.branchMesh.visible = false;
      this.canopyMesh.visible = false;
    }

    let tIdx = 0;
    let bIdx = 0;
    let cIdx = 0;

    for (let i = 0; i < obstacles.length; i++) {
      const obs = obstacles[i];
      if (obs.kind !== 'eucalyptus' || tIdx >= eucCount) continue;

      const gy = sampleRainyHighwayHeight(obs.x, obs.z);
      const seed = hash21(obs.z * 0.13, obs.x * 0.37);
      const heightScale = 0.88 + seed * 0.42;
      const radScale = obs.radius / 0.44;
      // Lean gently toward the road (-X) so upper foliage overhangs the left lane like Image 1!
      const leanRoad = -(0.04 + hash21(obs.z, 9.1) * 0.09);

      this.dummy.position.set(obs.x, gy - 0.35, obs.z);
      this.dummy.rotation.set((seed - 0.5) * 0.06, seed * Math.PI * 2, leanRoad);
      this.dummy.scale.set(radScale, heightScale, radScale);
      this.dummy.updateMatrix();
      this.trunkMesh.setMatrixAt(tIdx, this.dummy.matrix);

      // 3 diverging upper branches per eucalyptus tree tucked into canopy
      for (let b = 0; b < 3 && bIdx < eucCount * 3; b++) {
        const bHeight = (6.8 + b * 1.15) * heightScale;
        const az = b === 0 ? Math.PI : b === 1 ? Math.PI * 0.65 : -Math.PI * 0.45;
        const tilt = b === 0 ? 0.46 : 0.38 + hash21(obs.z, b * 11.3) * 0.18;
        this.dummy.position.set(obs.x, gy + bHeight, obs.z);
        this.dummy.rotation.set(Math.sin(az) * tilt, az, Math.cos(az) * tilt);
        const bLen = (0.68 + hash21(obs.z, b * 7.7) * 0.32) * heightScale;
        this.dummy.scale.set(radScale * 0.72, bLen, radScale * 0.72);
        this.dummy.updateMatrix();
        this.branchMesh.setMatrixAt(bIdx, this.dummy.matrix);
        bIdx++;
      }

      // 4 layered hanging eucalyptus foliage canopy clusters per tree (low drooping overhang over left lane!)
      for (let c = 0; c < CROWN_OFFSETS.length && cIdx < eucCount * CROWN_OFFSETS.length; c++) {
        const off = CROWN_OFFSETS[c];
        const jx = (hash21(obs.z + c, 14.1) - 0.5) * 1.2;
        const jz = (hash21(obs.z + c, 28.7) - 0.5) * 1.2;
        this.dummy.position.set(obs.x + off[0] + jx, gy + off[1] * heightScale, obs.z + off[2] + jz);
        this.dummy.rotation.set(0, seed * 6.28 + c * 1.4, 0);
        const s = off[3] * (0.86 + seed * 0.30);
        this.dummy.scale.set(s, s * 0.95, s);
        this.dummy.updateMatrix();
        this.canopyMesh.setMatrixAt(cIdx, this.dummy.matrix);
        cIdx++;
      }
      tIdx++;
    }
    if (eucCount > 0) {
      this.trunkMesh.computeBVH({ margin: 0, getBBoxFromBSphere: false });
      this.trunkMesh.computeBoundingSphere();
      this.branchMesh.computeBVH({ margin: 0, getBBoxFromBSphere: false });
      this.branchMesh.computeBoundingSphere();
      this.canopyMesh.computeBVH({ margin: 0, getBBoxFromBSphere: false });
      this.canopyMesh.computeBoundingSphere();
    }

    // 2. Utility Poles + Crossarms (BatchedMesh) + Sagging Catenary Wires (-X right shoulder)
    const poles = this.scratchPoles;
    poles.length = 0;
    for (let i = 0; i < obstacles.length; i++) {
      const obs = obstacles[i];
      if (obs.kind !== 'utility_pole') continue;
      poles.push({ x: obs.x, y: sampleRainyHighwayHeight(obs.x, obs.z), z: obs.z });
    }
    poles.sort((a, b) => a.z - b.z);
    const poleCount = Math.min(poles.length, this.maxPoles);

    if (this.poleMesh.bvh) this.poleMesh.disposeBVH();
    this.poleMesh.clearInstances();
    if (poleCount > 0) {
      this.poleMesh.addInstances(poleCount);
      this.poleMesh.visible = true;
    } else {
      this.poleMesh.visible = false;
    }

    for (let i = 0; i < poleCount; i++) {
      const p = poles[i];
      this.dummy.position.set(p.x, p.y - 0.25, p.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.poleMesh.setMatrixAt(i, this.dummy.matrix);

      this.dummy.position.set(p.x, p.y + 10.6, p.z);
      this.dummy.updateMatrix();
      const crossId = this.crossarmInstIds[i];
      this.propsBatchedMesh.setMatrixAt(crossId, this.dummy.matrix);
      this.propsBatchedMesh.setVisibleAt(crossId, true);
    }
    for (let i = poleCount; i < this.maxPoles; i++) {
      this.propsBatchedMesh.setVisibleAt(this.crossarmInstIds[i], false);
    }
    if (poleCount > 0) {
      this.poleMesh.computeBVH({ margin: 0, getBBoxFromBSphere: false });
      this.poleMesh.computeBoundingSphere();
    }

    // Build sagging parabolic wires between consecutive poles
    const wireArr = this.powerWirePosAttr.array as Float32Array;
    let wCursor = 0;
    const segsPerSpan = 12;
    for (let i = 0; i < poleCount - 1; i++) {
      const p0 = poles[i];
      const p1 = poles[i + 1];
      for (let w = 0; w < WIRE_X_OFFSETS.length; w++) {
        const ox = WIRE_X_OFFSETS[w];
        const y0 = p0.y + 10.72;
        const y1 = p1.y + 10.72;
        const sag = 1.25;
        for (let s = 0; s < segsPerSpan; s++) {
          const tA = s / segsPerSpan;
          const tB = (s + 1) / segsPerSpan;
          const sagA = 4.0 * tA * (1.0 - tA) * sag;
          const sagB = 4.0 * tB * (1.0 - tB) * sag;

          wireArr[wCursor++] = p0.x + ox;
          wireArr[wCursor++] = THREE.MathUtils.lerp(y0, y1, tA) - sagA;
          wireArr[wCursor++] = THREE.MathUtils.lerp(p0.z, p1.z, tA);

          wireArr[wCursor++] = p1.x + ox;
          wireArr[wCursor++] = THREE.MathUtils.lerp(y0, y1, tB) - sagB;
          wireArr[wCursor++] = THREE.MathUtils.lerp(p0.z, p1.z, tB);
        }
      }
      // Subtle angled stay wire anchored outward into right paddock (-X, away from road!)
      if (i % 2 === 0 && wCursor + 6 <= wireArr.length) {
        wireArr[wCursor++] = p0.x - 0.12;
        wireArr[wCursor++] = p0.y + 9.4;
        wireArr[wCursor++] = p0.z;

        wireArr[wCursor++] = p0.x - 2.4;
        wireArr[wCursor++] = sampleRainyHighwayHeight(p0.x - 2.4, p0.z + 2.2);
        wireArr[wCursor++] = p0.z + 2.2;
      }
    }
    this.powerWireGeo.setDrawRange(0, wCursor / 3);
    this.powerWirePosAttr.needsUpdate = true;

    // 3. Wooden Fence Posts + Horizontal Wire Strands (+-11.4m)
    const leftPosts = this.scratchLeftPosts;
    const rightPosts = this.scratchRightPosts;
    leftPosts.length = 0;
    rightPosts.length = 0;
    let fIdx = 0;

    for (let i = 0; i < obstacles.length; i++) {
      const obs = obstacles[i];
      if (obs.kind !== 'fence_post' || fIdx >= this.maxFencePosts) continue;
      const gy = sampleRainyHighwayHeight(obs.x, obs.z);
      const isBroken = Boolean(brokenFenceIds && brokenFenceIds.has(obs.id));

      this.dummy.position.set(obs.x, gy - 0.08, obs.z);
      if (isBroken) {
        // Knocked flat/snapped wooden post after vehicle impact
        this.dummy.rotation.set(1.38, hash21(obs.z, 3.2) * 0.8, 0.25);
        this.dummy.scale.set(1, 0.72, 1);
      } else {
        this.dummy.rotation.set((hash21(obs.z, 1.3) - 0.5) * 0.08, 0, (hash21(obs.z, 4.9) - 0.5) * 0.08);
        this.dummy.scale.set(1, 0.94 + hash21(obs.z, 8.2) * 0.14, 1);
      }
      this.dummy.updateMatrix();
      const fenceId = this.fencePostInstIds[fIdx++];
      this.propsBatchedMesh.setMatrixAt(fenceId, this.dummy.matrix);
      this.propsBatchedMesh.setVisibleAt(fenceId, true);

      if (obs.x > 0) leftPosts.push({ x: obs.x, y: gy, z: obs.z, broken: isBroken });
      else rightPosts.push({ x: obs.x, y: gy, z: obs.z, broken: isBroken });
    }
    for (let i = fIdx; i < this.maxFencePosts; i++) {
      this.propsBatchedMesh.setVisibleAt(this.fencePostInstIds[i], false);
    }

    leftPosts.sort((a, b) => a.z - b.z);
    rightPosts.sort((a, b) => a.z - b.z);
    const fWireArr = this.fenceWirePosAttr.array as Float32Array;
    let fwCursor = 0;
    for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
      const sidePosts = sideIdx === 0 ? leftPosts : rightPosts;
      for (let i = 0; i < sidePosts.length - 1; i++) {
        const a = sidePosts[i];
        const b = sidePosts[i + 1];
        if (a.broken || b.broken) continue;
        for (let sh = 0; sh < STRAND_HEIGHTS.length; sh++) {
          const h = STRAND_HEIGHTS[sh];
          if (fwCursor + 6 > fWireArr.length) break;
          fWireArr[fwCursor++] = a.x;
          fWireArr[fwCursor++] = a.y + h;
          fWireArr[fwCursor++] = a.z;

          fWireArr[fwCursor++] = b.x;
          fWireArr[fwCursor++] = b.y + h;
          fWireArr[fwCursor++] = b.z;
        }
      }
    }
    this.fenceWireGeo.setDrawRange(0, fwCursor / 3);
    this.fenceWirePosAttr.needsUpdate = true;

    // 4. Short White Roadside Guide Posts (x = +-4.55m every 28m, inside propsBatchedMesh)
    const guideSpacing = 28.0;
    const gStart = Math.floor((centerZ - 120) / guideSpacing);
    const gEnd = Math.ceil((centerZ + 120) / guideSpacing);
    let gIdx = 0;
    for (let gi = gStart; gi <= gEnd && gIdx + 1 < this.maxGuidePosts; gi++) {
      const gz = gi * guideSpacing + 9.0;
      for (let si = 0; si < GUIDE_SIDES.length; si++) {
        const gx = GUIDE_SIDES[si] * 4.55;
        const gy = sampleRainyHighwayHeight(gx, gz);
        this.dummy.position.set(gx, gy - 0.06, gz);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        const guideId = this.guidePostInstIds[gIdx++];
        this.propsBatchedMesh.setMatrixAt(guideId, this.dummy.matrix);
        this.propsBatchedMesh.setVisibleAt(guideId, true);
      }
    }
    for (let i = gIdx; i < this.maxGuidePosts; i++) {
      this.propsBatchedMesh.setVisibleAt(this.guidePostInstIds[i], false);
    }
    this.propsBatchedMesh.computeBoundingBox();
    this.propsBatchedMesh.computeBoundingSphere();

    // 5. Dry Pale Roadside Grass Tufts snapped cleanly onto terrain around centerZ
    if (this.grassMesh.bvh) this.grassMesh.disposeBVH();
    for (let i = 0; i < this.grassCount; i++) {
      const g = this.grassOffsets[i];
      // Tile smoothly along Z in 140m bands so grass never slides relative to the ground
      const worldZ = Math.floor((centerZ - g.zRel + 70.0) / 140.0) * 140.0 + g.zRel;
      const gy = sampleRainyHighwayHeight(g.x, worldZ);
      this.dummy.position.set(g.x, gy - 0.04, worldZ);
      this.dummy.rotation.set(0, g.yaw, 0);
      this.dummy.scale.set(g.scaleW, g.scaleH, g.scaleW);
      this.dummy.updateMatrix();
      this.grassMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.grassMesh.computeBVH({ margin: 0, getBBoxFromBSphere: false });
    this.grassMesh.computeBoundingSphere();
  }

  public dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
