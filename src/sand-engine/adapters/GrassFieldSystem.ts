/**
 * GrassFieldSystem.ts
 * Single-draw-call InstancedMesh wild meadow grass border for the 'mud_grass' biome.
 *
 * Features:
 *  - Multi-blade curved & tapered grass clump geometry (5 blades/tuft) with
 *    deep mossy-root to rich meadow-green tip vertex AO gradient (never washed-out white)
 *  - GPU wind wave animation + vehicle proximity & toroidal track flattening via
 *    MeshStandardMaterial.onBeforeCompile (zero per-frame CPU matrix updates)
 *  - Deterministic dense shoulder placement along mud trails via `sampleMudGrassZoneMask`
 */

import * as THREE from 'three';
import { InstancedMesh2 } from '@three.ez/instanced-mesh';
import {
  sampleBaseTerrainHeight,
  sampleMudGrassZoneMask,
} from '../core/TerrainHeightfield';

export interface GrassUpdateParams {
  time: number;
  windDirX: number;
  windDirZ: number;
  windSpeed: number;
  vehicleX: number;
  vehicleZ: number;
  cascade0Tex: THREE.Texture;
  origin0X: number;
  origin0Z: number;
  size0: number;
  guardWorld0: number;
  cascade1Tex: THREE.Texture;
  origin1X: number;
  origin1Z: number;
  size1: number;
  guardWorld1: number;
}

/**
 * Builds a lush 8-blade 360-degree arching wild meadow grass tuft BufferGeometry with
 * deep mossy root AO -> rich olive chlorophyll blade coloration so tufts blend into dark soil.
 */
function createGrassTuftGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const bladeCount = 6;
  const segs = 2;
  const bladeAngles = [0.0, 1.05, 2.09, 3.14, 4.19, 5.24];
  const bladeHeights = [0.38, 0.25, 0.45, 0.30, 0.40, 0.27];
  const bladeWidths = [0.072, 0.060, 0.074, 0.062, 0.068, 0.058];
  const bladeLeans = [0.19, 0.25, 0.15, 0.22, 0.17, 0.23];
  const bladeRadii = [0.048, 0.092, 0.036, 0.088, 0.060, 0.098];

  let vertOffset = 0;

  for (let b = 0; b < bladeCount; b++) {
    const ang = bladeAngles[b] + (b % 2 === 0 ? 0.18 : -0.20);
    const hMax = bladeHeights[b];
    const wBase = bladeWidths[b];
    const leanMax = bladeLeans[b];
    const rad = bladeRadii[b];

    const dirX = Math.cos(ang);
    const dirZ = Math.sin(ang);
    const sideX = -dirZ;
    const sideZ = dirX;
    const offX = dirX * rad;
    const offZ = dirZ * rad;

    for (let s = 0; s <= segs; s++) {
      const t = s / segs; // 0 = root, 1 = tip
      const y = hMax * (t - 0.12 * t * t);
      const arch = leanMax * Math.pow(t, 1.85);
      const halfW = wBase * (1.0 - Math.pow(t, 1.25)) * 0.5;

      const cx = offX + dirX * arch;
      const cz = offZ + dirZ * arch;

      // Deep dark earthy root AO -> natural damp meadow olive mid -> softly lighter tip
      const ao = THREE.MathUtils.smoothstep(t, 0.0, 0.62);
      const cr = THREE.MathUtils.lerp(0.14, 0.68, Math.pow(t, 0.85)) * (0.28 + 0.72 * ao);
      const cg = THREE.MathUtils.lerp(0.20, 0.84, Math.pow(t, 0.82)) * (0.28 + 0.72 * ao);
      const cb = THREE.MathUtils.lerp(0.08, 0.36, t) * (0.28 + 0.72 * ao);

      // Upward-biased soft foliage normal so overcast sky lights tufts softly without harsh backfaces
      const ny = 0.92 - t * 0.14;
      const nx = dirX * (0.18 + t * 0.16);
      const nz = dirZ * (0.18 + t * 0.16);
      const nLen = Math.hypot(nx, ny, nz);

      if (s === segs) {
        positions.push(cx, y, cz);
        normals.push(nx / nLen, ny / nLen, nz / nLen);
        colors.push(cr, cg, cb);
        uvs.push(0.5, t);
      } else {
        positions.push(cx - sideX * halfW, y, cz - sideZ * halfW);
        normals.push(nx / nLen, ny / nLen, nz / nLen);
        colors.push(cr, cg, cb);
        uvs.push(0.0, t);

        positions.push(cx + sideX * halfW, y, cz + sideZ * halfW);
        normals.push(nx / nLen, ny / nLen, nz / nLen);
        colors.push(cr, cg, cb);
        uvs.push(1.0, t);
      }
    }

    for (let s = 0; s < segs - 1; s++) {
      const i0 = vertOffset + s * 2;
      const i1 = i0 + 1;
      const i2 = i0 + 2;
      const i3 = i0 + 3;
      indices.push(i0, i1, i2, i1, i3, i2);
    }
    const baseTipRow = vertOffset + (segs - 1) * 2;
    const tipIdx = baseTipRow + 2;
    indices.push(baseTipRow, baseTipRow + 1, tipIdx);

    vertOffset += segs * 2 + 1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/** Lightweight 3-blade single-segment grass tuft LOD (3 tris vs 30 tris) for mid/far meadow tufts. */
function createGrassTuftLodGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const bladeAngles = [0.2, 2.3, 4.4];
  const bladeHeights = [0.42, 0.34, 0.39];
  const bladeWidths = [0.11, 0.10, 0.11];
  const bladeLeans = [0.18, 0.22, 0.17];

  for (let b = 0; b < 3; b++) {
    const ang = bladeAngles[b];
    const hMax = bladeHeights[b];
    const halfW = bladeWidths[b] * 0.5;
    const dirX = Math.cos(ang);
    const dirZ = Math.sin(ang);
    const sideX = -dirZ;
    const sideZ = dirX;
    const base = b * 3;

    // Root left, root right, arched tip
    positions.push(
      -sideX * halfW, 0, -sideZ * halfW,
      sideX * halfW, 0, sideZ * halfW,
      dirX * bladeLeans[b], hMax, dirZ * bladeLeans[b],
    );
    normals.push(0, 1, 0, 0, 1, 0, dirX * 0.25, 0.94, dirZ * 0.25);
    // Root dark AO -> tip olive green matching LOD 0
    colors.push(
      0.04, 0.06, 0.02,
      0.04, 0.06, 0.02,
      0.66, 0.82, 0.35,
    );
    uvs.push(0, 0, 1, 0, 0.5, 1);
    indices.push(base, base + 1, base + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

function hash2(ix: number, iz: number): number {
  const n = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function valueNoise2D(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

export class GrassFieldSystem {
  public readonly mesh: InstancedMesh2;
  private readonly maxCount: number;
  private readonly placedCount: number;
  private readonly geometry: THREE.BufferGeometry;
  private readonly lodGeometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshLambertMaterial;
  private readonly dummyCascadeTex: THREE.DataTexture;

  private readonly shaderUniforms: {
    uGrassTime: { value: number };
    uGrassWindDir: { value: THREE.Vector2 };
    uGrassWindSpeed: { value: number };
    uGrassVehiclePos: { value: THREE.Vector2 };
    uGrassCascade0: { value: THREE.Texture };
    uGrassOrigin0: { value: THREE.Vector2 };
    uGrassSize0: { value: number };
    uGrassGuard0: { value: number };
    uGrassCascade1: { value: THREE.Texture };
    uGrassOrigin1: { value: THREE.Vector2 };
    uGrassSize1: { value: number };
    uGrassGuard1: { value: number };
  };

  constructor(isSoftwareGl: boolean, isMobile = false, renderer?: THREE.WebGLRenderer) {
    this.geometry = createGrassTuftGeometry();
    this.lodGeometry = createGrassTuftLodGeometry();

    // Valid 1x1 zero RGBA texture so uGrassCascade0/uGrassCascade1 are never null on initial compile
    this.dummyCascadeTex = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 0]),
      1,
      1,
      THREE.RGBAFormat,
    );
    this.dummyCascadeTex.needsUpdate = true;

    this.shaderUniforms = {
      uGrassTime: { value: 0 },
      uGrassWindDir: { value: new THREE.Vector2(0.84, 0.53) },
      uGrassWindSpeed: { value: 0.45 },
      uGrassVehiclePos: { value: new THREE.Vector2(-4.5, -3.5) },
      uGrassCascade0: { value: this.dummyCascadeTex },
      uGrassOrigin0: { value: new THREE.Vector2(0, 0) },
      uGrassSize0: { value: 32.0 },
      uGrassGuard0: { value: 0.125 },
      uGrassCascade1: { value: this.dummyCascadeTex },
      uGrassOrigin1: { value: new THREE.Vector2(0, 0) },
      uGrassSize1: { value: 128.0 },
      uGrassGuard1: { value: 0.5 },
    };

    // Matte Lambert grass completely eliminates metallic silver/white grazing Fresnel glare
    this.material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.shaderUniforms);

      shader.vertexShader =
        /* glsl */ `
        uniform float uGrassTime;
        uniform vec2 uGrassWindDir;
        uniform float uGrassWindSpeed;
        uniform vec2 uGrassVehiclePos;
        uniform sampler2D uGrassCascade0;
        uniform vec2 uGrassOrigin0;
        uniform float uGrassSize0;
        uniform float uGrassGuard0;
        uniform sampler2D uGrassCascade1;
        uniform vec2 uGrassOrigin1;
        uniform float uGrassSize1;
        uniform float uGrassGuard1;
        varying float vBladeT;
        varying float vBladeCrush;
        ` + shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        float bladeH = clamp(position.y / 0.46, 0.0, 1.0);
        float bendFactor = bladeH * bladeH;

        vec4 instWorldPos = vec4(0.0, 0.0, 0.0, 1.0);
        #if defined(USE_INSTANCING) || defined(USE_INSTANCING_INDIRECT)
          instWorldPos = instanceMatrix * instWorldPos;
        #endif

        // 1. Check toroidal track depression/compression beneath grass tuft (skip distant sub-pixel reads > 46m)
        float distCamGrass = length(instWorldPos.xz - cameraPosition.xz);
        float crushedTrack = 0.0;
        if (distCamGrass < 46.0) {
          vec2 relC0 = abs(instWorldPos.xz - uGrassOrigin0) / max(0.001, uGrassSize0 * 0.5);
          float c0Edge = 1.0 - (uGrassGuard0 / max(0.001, uGrassSize0 * 0.5)) * 1.5;
          float c0Weight = 1.0 - smoothstep(0.80, max(0.82, c0Edge), max(relC0.x, relC0.y));
          float crush0 = 0.0;
          if (c0Weight > 0.01) {
            vec4 st0 = texture2D(uGrassCascade0, fract(instWorldPos.xz / uGrassSize0));
            crush0 = smoothstep(0.025, 0.14, st0.r + st0.g * 0.75 + st0.b * 0.45);
          }

          float crush1 = 0.0;
          if (c0Weight < 0.99) {
            vec2 relC1 = abs(instWorldPos.xz - uGrassOrigin1) / max(0.001, uGrassSize1 * 0.5);
            float c1Edge = 1.0 - (uGrassGuard1 / max(0.001, uGrassSize1 * 0.5)) * 1.5;
            float c1Weight = 1.0 - smoothstep(0.86, max(0.88, c1Edge), max(relC1.x, relC1.y));
            if (c1Weight > 0.01) {
              vec4 st1 = texture2D(uGrassCascade1, fract(instWorldPos.xz / uGrassSize1));
              crush1 = smoothstep(0.02, 0.13, st1.r + st1.g * 0.75 + st1.b * 0.45) * c1Weight;
            }
          }
          crushedTrack = mix(crush1, crush0, c0Weight);
        }

        // 2. Real-time vehicle proximity crush & radial push
        vec2 fromVeh = instWorldPos.xz - uGrassVehiclePos;
        float distVeh = length(fromVeh);
        float crushVeh = 1.0 - smoothstep(1.15, 2.35, distVeh);
        float totalCrush = max(crushedTrack, crushVeh);

        vBladeT = bladeH;
        vBladeCrush = totalCrush;

        // Flatten height & splay blades radially when driven over into mud
        transformed.y *= mix(1.0, 0.12, totalCrush);
        vec2 pushDir = distVeh > 0.01 ? (fromVeh / distVeh) : vec2(1.0, 0.0);
        transformed.xz += pushDir * (crushVeh * 0.24 * bladeH);

        // 3. Natural organic wind wave gust across the meadow
        float wavePhase = dot(instWorldPos.xz, uGrassWindDir) * 0.45 - uGrassTime * (1.7 + uGrassWindSpeed * 1.4);
        float gust = sin(wavePhase) * 0.52 + sin(wavePhase * 2.2 + instWorldPos.x * 0.65) * 0.28 + 0.20;
        float swayAmp = (0.042 + uGrassWindSpeed * 0.068) * (1.0 - totalCrush * 0.85);
        transformed.xz += uGrassWindDir * (gust * swayAmp * bendFactor);
        `,
      );

      shader.fragmentShader =
        /* glsl */ `
        varying float vBladeT;
        varying float vBladeCrush;
        ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        // Deep soil-edge root darkening + muddy splash coat when driven over
        float rootAO = mix(0.28, 1.0, smoothstep(0.0, 0.76, vBladeT));
        diffuseColor.rgb *= rootAO;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.028, 0.020, 0.013), vBladeCrush * 0.72);
        `,
      );
    };
    this.material.customProgramCacheKey = () => 'mud-grass-lambert-v5';

    // Scatter tufts using concentric inner-first ordering so the hero
    // 0..28m mud-grass border around the vehicle is ALWAYS lush in all 360 degrees
    const tier1Cap = isSoftwareGl ? 2400 : isMobile ? 2200 : 4500;
    const tier2Cap = isSoftwareGl ? 3800 : isMobile ? 3600 : 7400;
    const placements: Array<{
      x: number;
      y: number;
      z: number;
      scale: number;
      rot: number;
      tint: number;
      dryStraw: boolean;
    }> = [];

    const addGrassRing = (
      step: number,
      gridLim: number,
      minR: number,
      maxR: number,
      densityMult: number,
      budgetCap: number,
    ) => {
      for (let gx = -gridLim; gx <= gridLim; gx++) {
        for (let gz = -gridLim; gz <= gridLim; gz++) {
          if (placements.length >= budgetCap) return;

          const jx = (hash2(gx, gz) - 0.5) * step * 1.14;
          const jz = (hash2(gx + 41, gz - 19) - 0.5) * step * 1.14;
          const wx = gx * step + jx;
          const wz = gz * step + jz;

          const dist = Math.hypot(wx, wz);
          if (dist < minR || dist > maxR) continue;

          const grassZone = sampleMudGrassZoneMask(wx, wz);
          if (grassZone < 0.06) continue;

          const tussock = valueNoise2D(wx * 0.62 + 3.1, wz * 0.62 - 7.4);
          const edgeCluster = grassZone < 0.72 ? (0.76 + 0.88 * tussock) : 1.12;
          const radialSpan = Math.max(0.01, maxR - minR);
          const radialT = Math.max(0, Math.min(1, (dist - minR) / radialSpan));
          const outerFade = minR > 1.0 ? 1.0 - radialT * 0.62 : 1.0 - Math.max(0, (dist - 16.0) / 10.0) * 0.25;
          const densityKeep = hash2(gx - 73, gz + 29);
          if (densityKeep > grassZone * 1.65 * edgeCluster * densityMult * outerFade) continue;

          const wy = sampleBaseTerrainHeight(wx, wz);
          const distScaleBoost = 1.0 + Math.min(0.45, Math.max(0, (dist - 18.0) * 0.014));
          const hScale =
            (0.46 + hash2(gx + 11, gz + 53) * 1.04) *
            (0.38 + grassZone * 0.70) *
            (0.80 + tussock * 0.40) *
            distScaleBoost;

          placements.push({
            x: wx,
            y: wy - 0.04,
            z: wz,
            scale: hScale,
            rot: hash2(gx * 3, gz * 5) * Math.PI * 2,
            tint: hash2(gx + 97, gz - 31),
            dryStraw: hash2(gx * 7 - 13, gz * 11 + 5) > 0.80,
          });
        }
      }
    };

    // Tier 1: dense foreground & mud-shoulder tussocks within 24m
    addGrassRing(isMobile ? 0.68 : 0.56, isMobile ? 36 : 44, 0.0, 24.0, 1.0, tier1Cap);
    // Tier 2: softly feathered meadow tufts out to 58m
    addGrassRing(isMobile ? 1.02 : 0.84, isMobile ? 58 : 70, 22.0, 58.0, 0.88, tier2Cap);

    this.placedCount = placements.length;
    this.maxCount = Math.max(1, this.placedCount);
    this.mesh = new InstancedMesh2(this.geometry, this.material, {
      capacity: this.maxCount,
      renderer,
    });
    // Root AO grounds blades into the soil without projecting unbent static depth-pass shadows
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Per-instance BVH frustum culling + 3-blade distance LOD (10x fewer vertices past 18m!)
    this.mesh.frustumCulled = false;
    this.mesh.perObjectFrustumCulled = true;
    this.mesh.autoUpdateBVH = false;
    this.mesh.addLOD(this.lodGeometry, this.material, isMobile ? 14 : 18, 0.1);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    if (this.placedCount > 0) {
      this.mesh.addInstances(this.placedCount);
    } else {
      this.mesh.visible = false;
    }

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    // Authentic humid countryside olive pasture greens + weathered dark sedge clumps (reference matched)
    const greenPalette = [0x3d511c, 0x314315, 0x4b5f22, 0x2b3b12, 0x566828];
    const strawPalette = [0x5d572c, 0x4d4924];

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(
        (p.tint - 0.5) * 0.22,
        p.rot,
        ((p.tint * 3.7) % 1 - 0.5) * 0.22,
      );
      dummy.scale.set(
        1.18 + p.tint * 0.76,
        p.scale,
        1.18 + ((p.tint * 2.1) % 1) * 0.76,
      );
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);

      const pal = p.dryStraw ? strawPalette : greenPalette;
      const palHex = pal[Math.floor(p.tint * pal.length) % pal.length];
      color.setHex(palHex);
      this.mesh.setColorAt(i, color);
    }

    if (this.placedCount > 0) {
      this.mesh.computeBVH({ margin: 0, getBBoxFromBSphere: false });
    }
    this.mesh.computeBoundingSphere();
    if (!this.mesh.boundingSphere) {
      this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 64);
    } else {
      this.mesh.boundingSphere.radius = Math.max(this.mesh.boundingSphere.radius, 64);
    }
  }

  public update(params: GrassUpdateParams): void {
    const u = this.shaderUniforms;
    u.uGrassTime.value = params.time;
    u.uGrassWindDir.value.set(params.windDirX, params.windDirZ);
    u.uGrassWindSpeed.value = params.windSpeed;
    u.uGrassVehiclePos.value.set(params.vehicleX, params.vehicleZ);
    u.uGrassCascade0.value = params.cascade0Tex;
    u.uGrassOrigin0.value.set(params.origin0X, params.origin0Z);
    u.uGrassSize0.value = params.size0;
    u.uGrassGuard0.value = params.guardWorld0;
    u.uGrassCascade1.value = params.cascade1Tex;
    u.uGrassOrigin1.value.set(params.origin1X, params.origin1Z);
    u.uGrassSize1.value = params.size1;
    u.uGrassGuard1.value = params.guardWorld1;
  }

  /** Scales active instanced tuft count via InstancedMesh2 per-instance visibility (inner-first). */
  public setDensityRatio(ratio: number): void {
    const clamped = Math.max(0.25, Math.min(1.0, ratio));
    const targetCount = Math.max(1, Math.round(this.placedCount * clamped));
    for (let i = 0; i < this.placedCount; i++) {
      this.mesh.setVisibilityAt(i, i < targetCount);
    }
  }

  public setLodDistance(lod1Distance: number): void {
    this.mesh.updateLOD(1, lod1Distance, 0.1);
  }

  public setLayer(layer: number): void {
    this.mesh.layers.set(layer);
    if (this.mesh.LODinfo) {
      for (let i = 0; i < this.mesh.LODinfo.objects.length; i++) {
        this.mesh.LODinfo.objects[i].layers.set(layer);
      }
    }
  }

  public dispose(): void {
    this.mesh.disposeBVH();
    this.mesh.dispose();
    this.geometry.dispose();
    this.lodGeometry.dispose();
    this.material.dispose();
    this.dummyCascadeTex.dispose();
  }
}
