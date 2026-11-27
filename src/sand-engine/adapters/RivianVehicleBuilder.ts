/**
 * RivianVehicleBuilder.ts
 * Loads and adapts `src/assets/Rivian_R1T_2022_compact.glb` into a 100% functional
 * off-road & highway hero vehicle matching the TrophyTruckVisuals + CockpitRig contract:
 *  - Authentic 2022 Rivian R1T quad-motor pickup geometry, baked PBR textures & Canyon Red microflake paint
 *  - Exact ground-aligned wheel extraction (LF/RF/LR/RR hubs, rims, tires, rotors spin; calipers stay upright)
 *  - Dual interactive cockpit displays split from `gaugeCluster_a_0_[digitalscreen]` (cluster + 15.6" touchscreen)
 *  - Real-time 3-mirror reflections + motorized power-fold (`boneMirrorL_001` / `boneMirrorR_001` / `boneMirrorC_001`)
 *  - Curved windshield & side-door GLSL3 raindrop + dual-wiper clear-arc + crash crack shaders
 *  - Independent per-side headlights, stadium DRLs, front/rear full-width lightbars, brake, reverse & hazard emitters
 *  - BeamNG-style per-vertex soft-body crash deformation (`aScrape` brushed steel) & centered detachable rigid debris
 */

import * as THREE from 'three';
import {
  consumeOrParseRivianGltf,
  preloadRivianGlb,
} from './rivianAssetPreload';
import { attachGeometryBvh, disposeGeometryBvh } from './MeshBvhSetup';

export { preloadRivianGlb };
import {
  DamageZone,
  DetachablePartId,
} from '../core/VehicleCrashPhysics';
import { CabinSwitchId } from '../core/CockpitStateModel';
import {
  CABIN_INTERIOR_LAYER,
  ReflectionSharedUniforms,
} from './VehicleReflectionSystem';
import { classifyRivianNodeRole } from '../core/GraphicsQualityBudget';
import {
  CockpitInteractiveSwitch,
  CockpitLightingSyncParams,
  RaptorCockpitRig,
} from './RaptorCockpitBuilder';
import {
  applyCabinRayTracedLighting,
  CabinRtLightingUniforms,
  createCabinRtLightingUniforms,
} from '../shaders/cabinRayTracedLighting';
import {
  AUTOMOTIVE_RT_UNIFORMS_AND_HELPERS_GLSL,
  applyRivianGlassRtReflections,
  applyRivianMetalRtReflections,
  bindReflectionSharedUniforms,
  buildAsymmetricPccEnvMapChunk,
  createFallbackReflectionUniforms,
} from '../shaders/automotiveRtReflections';
import { createWindshieldRainMaterial } from '../shaders/windshieldRain';
import {
  DeformableMeshRecord,
  TrophyTruckVisuals,
  WheelMountSpec,
  WheelVisualAssembly,
} from './VehicleMeshBuilder';

/**
 * Lens/projector materials whose expensive KHR_materials_transmission extension was stripped
 * during GLB compaction; restored here as crisp low-cost clearcoated alpha glass.
 */
const TRANSMISSIVE_LENS_MAT_NAMES = new Set<string>([
  'SF_Atlas_6',
  'Detail_Clear_Projector_SF_Atlas_6',
  'UNLIT_16_SF_glass.2_All_On_v3',
  'UNLIT_10_SF_Atlas_17_All_On_v3',
  'UNLIT_148_PATCH_148_Detail_Tail_Inner_Lens_SF_Atlas_17_All_On_v3',
]);

const MERGE_TEX_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
] as const;

/**
 * Downgrades a non-paint, non-glass MeshPhysicalMaterial to a leaner MeshStandardMaterial
 * so WebGL2 skips clearcoat/sheen/iridescence/IOR shader branches and reduces program permutations.
 */
function downgradePhysicalMaterial(
  src: THREE.MeshPhysicalMaterial,
): THREE.MeshStandardMaterial {
  const dst = new THREE.MeshStandardMaterial({
    name: src.name,
    color: src.color.clone(),
    map: src.map,
    normalMap: src.normalMap,
    normalMapType: src.normalMapType,
    normalScale: src.normalScale.clone(),
    roughness: src.roughness,
    roughnessMap: src.roughnessMap,
    metalness: src.metalness,
    metalnessMap: src.metalnessMap,
    aoMap: src.aoMap,
    aoMapIntensity: src.aoMapIntensity,
    emissive: src.emissive.clone(),
    emissiveMap: src.emissiveMap,
    emissiveIntensity: src.emissiveIntensity,
    alphaMap: src.alphaMap,
    alphaTest: src.alphaTest,
    vertexColors: src.vertexColors,
    transparent: src.transparent,
    opacity: src.opacity,
    side: src.side,
    depthWrite: src.depthWrite,
    depthTest: src.depthTest,
    envMap: src.envMap,
    envMapIntensity: src.envMapIntensity,
    flatShading: src.flatShading,
    polygonOffset: src.polygonOffset,
    polygonOffsetFactor: src.polygonOffsetFactor,
    polygonOffsetUnits: src.polygonOffsetUnits,
    toneMapped: src.toneMapped,
  });
  return dst;
}

function getRequiredUvNamesForMaterial(mat: THREE.Material): string[] {
  const std = mat as THREE.MeshPhysicalMaterial;
  const channels = new Set<number>();
  for (let i = 0; i < MERGE_TEX_SLOTS.length; i++) {
    const tex = std[MERGE_TEX_SLOTS[i]] as THREE.Texture | null | undefined;
    if (tex) {
      const ch = typeof tex.channel === 'number' ? tex.channel : 0;
      channels.add(ch);
    }
  }
  const names: string[] = [];
  if (channels.has(0)) names.push('uv');
  if (channels.has(1)) names.push('uv1');
  if (channels.has(2)) names.push('uv2');
  if (channels.has(3)) names.push('uv3');
  return names;
}

/**
 * Merges static same-material meshes within a rigid container into batched BufferGeometries,
 * drastically cutting WebGL draw calls while preserving transforms, normals, UVs, vertex colors,
 * mirrored triangle winding, shadow flags, renderOrder, and layer masks.
 */
function mergeStaticContainerByMaterial(
  container: THREE.Object3D,
  excludedMeshes: ReadonlySet<THREE.Object3D>,
  excludedSubtrees: ReadonlySet<THREE.Object3D>,
  trackGeo: <T extends THREE.BufferGeometry>(g: T) => T,
): void {
  container.updateWorldMatrix(true, true);
  const containerInv = new THREE.Matrix4().copy(container.matrixWorld).invert();

  const batches = new Map<
    string,
    {
      material: THREE.Material;
      castShadow: boolean;
      receiveShadow: boolean;
      renderOrder: number;
      layerMask: number;
      meshes: THREE.Mesh[];
    }
  >();

  const walk = (node: THREE.Object3D) => {
    if (node !== container && excludedSubtrees.has(node)) return;
    if (node !== container && !node.visible) return;
    if ((node as THREE.Mesh).isMesh && !excludedMeshes.has(node)) {
      const mesh = node as THREE.Mesh;
      if (!Array.isArray(mesh.material) && mesh.geometry?.attributes?.position) {
        const key = `${mesh.material.uuid}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}|${mesh.renderOrder}|${mesh.layers.mask}`;
        let batch = batches.get(key);
        if (!batch) {
          batch = {
            material: mesh.material,
            castShadow: mesh.castShadow,
            receiveShadow: mesh.receiveShadow,
            renderOrder: mesh.renderOrder,
            layerMask: mesh.layers.mask,
            meshes: [],
          };
          batches.set(key, batch);
        }
        batch.meshes.push(mesh);
      }
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      walk(children[i]);
    }
  };
  walk(container);

  const relMat = new THREE.Matrix4();
  const normalMat = new THREE.Matrix3();
  const tmpV = new THREE.Vector3();
  const tmpN = new THREE.Vector3();

  for (const batch of batches.values()) {
    if (batch.meshes.length < 2) {
      // Freeze static singleton transform matrix inside rigid container
      const single = batch.meshes[0];
      if (single && single.parent === container) {
        single.updateMatrix();
        single.matrixAutoUpdate = false;
      }
      continue;
    }

    const reqUvs = getRequiredUvNamesForMaterial(batch.material);
    const needsColor = Boolean((batch.material as THREE.MeshStandardMaterial).vertexColors);

    // Pre-pass: compute exact total vertex & index counts to allocate ONE final BufferGeometry directly
    // (eliminates hundreds of temporary BufferGeometry allocations & mergeGeometries copies on mount!)
    let totalVerts = 0;
    let totalIndices = 0;
    const validMeshes: THREE.Mesh[] = [];
    for (let mi = 0; mi < batch.meshes.length; mi++) {
      const mesh = batch.meshes[mi];
      const srcGeo = mesh.geometry;
      const srcPos = srcGeo.attributes.position;
      if (!srcPos || srcPos.count === 0) continue;
      validMeshes.push(mesh);
      totalVerts += srcPos.count;
      totalIndices += srcGeo.index ? srcGeo.index.count : srcPos.count;
    }

    if (validMeshes.length < 2) continue;

    const mergedPos = new Float32Array(totalVerts * 3);
    const mergedNorm = new Float32Array(totalVerts * 3);
    const mergedUvs: Float32Array[] = reqUvs.map(() => new Float32Array(totalVerts * 2));
    const mergedCol = needsColor ? new Uint8Array(totalVerts * 3) : null;
    const useUint16 = totalVerts <= 65535;
    const mergedIdx: Uint16Array | Uint32Array = useUint16
      ? new Uint16Array(totalIndices)
      : new Uint32Array(totalIndices);

    let vOffset = 0;
    let iOffset = 0;
    let missingAnyNormal = false;

    for (let mi = 0; mi < validMeshes.length; mi++) {
      const mesh = validMeshes[mi];
      const srcGeo = mesh.geometry;
      const srcPos = srcGeo.attributes.position;
      const vCount = srcPos.count;

      relMat.multiplyMatrices(containerInv, mesh.matrixWorld);
      const isMirrored = relMat.determinant() < 0;
      normalMat.getNormalMatrix(relMat);

      const m = relMat.elements;
      const m0 = m[0], m1 = m[1], m2 = m[2];
      const m4 = m[4], m5 = m[5], m6 = m[6];
      const m8 = m[8], m9 = m[9], m10 = m[10];
      const m12 = m[12], m13 = m[13], m14 = m[14];

      // Fast direct transform of positions into output array
      for (let i = 0; i < vCount; i++) {
        const x = srcPos.getX(i);
        const y = srcPos.getY(i);
        const z = srcPos.getZ(i);
        const o3 = (vOffset + i) * 3;
        mergedPos[o3 + 0] = m0 * x + m4 * y + m8 * z + m12;
        mergedPos[o3 + 1] = m1 * x + m5 * y + m9 * z + m13;
        mergedPos[o3 + 2] = m2 * x + m6 * y + m10 * z + m14;
      }

      // Fast direct transform of unit normals (supports Float32 & quantized INT8 InterleavedBufferAttribute!)
      const srcNorm = srcGeo.attributes.normal;
      if (srcNorm) {
        const nm = normalMat.elements;
        const n0 = nm[0], n1 = nm[1], n2 = nm[2];
        const n3 = nm[3], n4 = nm[4], n5 = nm[5];
        const n6 = nm[6], n7 = nm[7], n8 = nm[8];
        for (let i = 0; i < vCount; i++) {
          const nx = srcNorm.getX(i);
          const ny = srcNorm.getY(i);
          const nz = srcNorm.getZ(i);
          let rx = n0 * nx + n3 * ny + n6 * nz;
          let ry = n1 * nx + n4 * ny + n7 * nz;
          let rz = n2 * nx + n5 * ny + n8 * nz;
          const len = Math.hypot(rx, ry, rz);
          if (len > 1e-6) {
            const inv = 1 / len;
            rx *= inv;
            ry *= inv;
            rz *= inv;
          }
          const o3 = (vOffset + i) * 3;
          mergedNorm[o3 + 0] = rx;
          mergedNorm[o3 + 1] = ry;
          mergedNorm[o3 + 2] = rz;
        }
      } else {
        missingAnyNormal = true;
        // Temporary fallback normal; computeVertexNormals runs below if needed
        for (let i = 0; i < vCount; i++) {
          const o3 = (vOffset + i) * 3;
          mergedNorm[o3 + 1] = 1;
        }
      }

      // Required UV channels only
      for (let ui = 0; ui < reqUvs.length; ui++) {
        const srcUv = srcGeo.attributes[reqUvs[ui]];
        const dstUv = mergedUvs[ui];
        if (srcUv) {
          for (let i = 0; i < vCount; i++) {
            const o2 = (vOffset + i) * 2;
            dstUv[o2 + 0] = srcUv.getX(i);
            dstUv[o2 + 1] = srcUv.getY(i);
          }
        }
      }

      // Normalized uint8 RGB vertex color when material uses vertexColors
      if (mergedCol) {
        const srcCol = srcGeo.attributes.color;
        if (srcCol) {
          for (let i = 0; i < vCount; i++) {
            const o3 = (vOffset + i) * 3;
            mergedCol[o3 + 0] = Math.max(0, Math.min(255, Math.round(srcCol.getX(i) * 255)));
            mergedCol[o3 + 1] = Math.max(0, Math.min(255, Math.round(srcCol.getY(i) * 255)));
            mergedCol[o3 + 2] = Math.max(0, Math.min(255, Math.round(srcCol.getZ(i) * 255)));
          }
        } else {
          mergedCol.fill(255, vOffset * 3, (vOffset + vCount) * 3);
        }
      }

      // Indexed triangles (flip winding if mirrored transform has negative determinant)
      const srcIdx = srcGeo.index;
      const idxCount = srcIdx ? srcIdx.count : vCount;
      if (srcIdx) {
        for (let i = 0; i < idxCount; i++) {
          mergedIdx[iOffset + i] = srcIdx.getX(i) + vOffset;
        }
      } else {
        for (let i = 0; i < idxCount; i++) {
          mergedIdx[iOffset + i] = i + vOffset;
        }
      }
      if (isMirrored) {
        for (let t = 0; t + 2 < idxCount; t += 3) {
          const tmp = mergedIdx[iOffset + t + 1];
          mergedIdx[iOffset + t + 1] = mergedIdx[iOffset + t + 2];
          mergedIdx[iOffset + t + 2] = tmp;
        }
      }

      vOffset += vCount;
      iOffset += idxCount;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
    for (let ui = 0; ui < reqUvs.length; ui++) {
      merged.setAttribute(reqUvs[ui], new THREE.BufferAttribute(mergedUvs[ui], 2));
    }
    if (mergedCol) {
      merged.setAttribute('color', new THREE.BufferAttribute(mergedCol, 3, true));
    }
    merged.setIndex(new THREE.BufferAttribute(mergedIdx, 1));
    if (missingAnyNormal) {
      merged.computeVertexNormals();
    }
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    trackGeo(merged);

    const mergedMesh = new THREE.Mesh(merged, batch.material);
    mergedMesh.name = `rivian_batch_${batch.material.name || 'mat'}`;
    mergedMesh.castShadow = batch.castShadow;
    mergedMesh.receiveShadow = batch.receiveShadow;
    mergedMesh.renderOrder = batch.renderOrder;
    mergedMesh.layers.mask = batch.layerMask;
    mergedMesh.updateMatrix();
    mergedMesh.matrixAutoUpdate = false;
    container.add(mergedMesh);

    for (let mi = 0; mi < validMeshes.length; mi++) {
      const mObj = validMeshes[mi];
      mObj.parent?.remove(mObj);
    }
  }
  void tmpV;
  void tmpN;
}

const _batchIdentityMat = new THREE.Matrix4();

/**
 * Packs remaining singleton meshes inside a rigid container whose untextured opaque
 * `MeshStandardMaterial`s differ only by `color` into `THREE.BatchedMesh` draw calls
 * (respecting negative-determinant mirrored winding and custom shader exclusions).
 */
function batchUntexturedStandardMeshes(
  container: THREE.Object3D,
  excludedMeshes: ReadonlySet<THREE.Object3D>,
  excludedSubtrees: ReadonlySet<THREE.Object3D>,
  trackGeo: <T extends THREE.BufferGeometry>(g: T) => T,
  trackMat: <T extends THREE.Material>(m: T) => T,
  trackBatch: <T extends THREE.BatchedMesh>(b: T) => T,
  reflectiveBaseByMat: ReadonlyMap<THREE.Material, number>,
  reflectiveMaterials: Array<{
    material: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
    baseEnvIntensity: number;
  }>,
  label: string,
): void {
  container.updateWorldMatrix(true, true);
  const containerInv = new THREE.Matrix4().copy(container.matrixWorld).invert();
  const baseOnBeforeCompile = THREE.MeshStandardMaterial.prototype.onBeforeCompile;

  interface BatchBucket {
    template: THREE.MeshStandardMaterial;
    castShadow: boolean;
    receiveShadow: boolean;
    renderOrder: number;
    layerMask: number;
    reflBase: number;
    meshes: THREE.Mesh[];
  }

  const buckets = new Map<string, BatchBucket>();

  const walk = (node: THREE.Object3D) => {
    if (node !== container && excludedSubtrees.has(node)) return;
    if (node !== container && !node.visible) return;
    if ((node as THREE.Mesh).isMesh && !excludedMeshes.has(node)) {
      const mesh = node as THREE.Mesh;
      if (
        !(mesh as THREE.InstancedMesh).isInstancedMesh &&
        !(mesh as THREE.BatchedMesh).isBatchedMesh &&
        !Array.isArray(mesh.material) &&
        mesh.geometry?.attributes?.position &&
        mesh.geometry.attributes.position.count > 0
      ) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const isPhys = (mat as unknown as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial;
        const hasCustomCompile = mat.onBeforeCompile !== baseOnBeforeCompile;
        const hasEmissive = mat.emissiveIntensity > 0 && mat.emissive.getHex() !== 0;
        const hasTextures = getRequiredUvNamesForMaterial(mat).length > 0;
        if (
          mat.isMeshStandardMaterial &&
          !isPhys &&
          !hasCustomCompile &&
          !hasTextures &&
          !hasEmissive &&
          !mat.vertexColors &&
          !mat.transparent &&
          mat.alphaTest === 0 &&
          mat.opacity >= 0.999
        ) {
          const reflBase = reflectiveBaseByMat.get(mat) ?? -1;
          const key = `${mat.roughness.toFixed(4)}|${mat.metalness.toFixed(4)}|${mat.envMapIntensity.toFixed(4)}|${mat.side}|${mat.flatShading ? 1 : 0}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}|${mesh.renderOrder}|${mesh.layers.mask}|${reflBase.toFixed(3)}`;
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = {
              template: mat,
              castShadow: mesh.castShadow,
              receiveShadow: mesh.receiveShadow,
              renderOrder: mesh.renderOrder,
              layerMask: mesh.layers.mask,
              reflBase,
              meshes: [],
            };
            buckets.set(key, bucket);
          }
          bucket.meshes.push(mesh);
        }
      }
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      walk(children[i]);
    }
  };
  walk(container);

  const relMat = new THREE.Matrix4();
  const normalMat = new THREE.Matrix3();

  for (const bucket of buckets.values()) {
    if (bucket.meshes.length < 2) continue;

    interface PreparedEntry {
      mesh: THREE.Mesh;
      geo: THREE.BufferGeometry;
      matrix: THREE.Matrix4;
      color: THREE.Color;
    }

    const rawGeoCache = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
    const uniqueGeos: THREE.BufferGeometry[] = [];
    const entries: PreparedEntry[] = [];
    let totalUniqueVerts = 0;
    let totalUniqueIndices = 0;

    const buildNormalizedGeo = (
      srcGeo: THREE.BufferGeometry,
      bakeMatrix: THREE.Matrix4 | null,
    ): THREE.BufferGeometry => {
      const srcPos = srcGeo.attributes.position;
      const srcNorm = srcGeo.attributes.normal;
      const srcIdx = srcGeo.index;
      const vCount = srcPos.count;
      const idxCount = srcIdx ? srcIdx.count : vCount;

      const posArr = new Float32Array(vCount * 3);
      const normArr = new Float32Array(vCount * 3);
      const idxArr =
        vCount <= 65535 ? new Uint16Array(idxCount) : new Uint32Array(idxCount);

      if (bakeMatrix) {
        normalMat.getNormalMatrix(bakeMatrix);
        const m = bakeMatrix.elements;
        const m0 = m[0], m1 = m[1], m2 = m[2];
        const m4 = m[4], m5 = m[5], m6 = m[6];
        const m8 = m[8], m9 = m[9], m10 = m[10];
        const m12 = m[12], m13 = m[13], m14 = m[14];
        for (let i = 0; i < vCount; i++) {
          const x = srcPos.getX(i);
          const y = srcPos.getY(i);
          const z = srcPos.getZ(i);
          const o3 = i * 3;
          posArr[o3 + 0] = m0 * x + m4 * y + m8 * z + m12;
          posArr[o3 + 1] = m1 * x + m5 * y + m9 * z + m13;
          posArr[o3 + 2] = m2 * x + m6 * y + m10 * z + m14;
        }
        if (srcNorm) {
          const nm = normalMat.elements;
          const n0 = nm[0], n1 = nm[1], n2 = nm[2];
          const n3 = nm[3], n4 = nm[4], n5 = nm[5];
          const n6 = nm[6], n7 = nm[7], n8 = nm[8];
          for (let i = 0; i < vCount; i++) {
            const nx = srcNorm.getX(i);
            const ny = srcNorm.getY(i);
            const nz = srcNorm.getZ(i);
            let rx = n0 * nx + n3 * ny + n6 * nz;
            let ry = n1 * nx + n4 * ny + n7 * nz;
            let rz = n2 * nx + n5 * ny + n8 * nz;
            const len = Math.hypot(rx, ry, rz);
            if (len > 1e-6) {
              const inv = 1 / len;
              rx *= inv;
              ry *= inv;
              rz *= inv;
            }
            const o3 = i * 3;
            normArr[o3 + 0] = rx;
            normArr[o3 + 1] = ry;
            normArr[o3 + 2] = rz;
          }
        }
      } else {
        for (let i = 0; i < vCount; i++) {
          const o3 = i * 3;
          posArr[o3 + 0] = srcPos.getX(i);
          posArr[o3 + 1] = srcPos.getY(i);
          posArr[o3 + 2] = srcPos.getZ(i);
        }
        if (srcNorm) {
          for (let i = 0; i < vCount; i++) {
            const o3 = i * 3;
            normArr[o3 + 0] = srcNorm.getX(i);
            normArr[o3 + 1] = srcNorm.getY(i);
            normArr[o3 + 2] = srcNorm.getZ(i);
          }
        }
      }

      if (srcIdx) {
        for (let i = 0; i < idxCount; i++) {
          idxArr[i] = srcIdx.getX(i);
        }
      } else {
        for (let i = 0; i < idxCount; i++) {
          idxArr[i] = i;
        }
      }

      // Mirrored transform flips triangle winding
      if (bakeMatrix) {
        for (let t = 0; t + 2 < idxCount; t += 3) {
          const tmp = idxArr[t + 1];
          idxArr[t + 1] = idxArr[t + 2];
          idxArr[t + 2] = tmp;
        }
      }

      const outGeo = new THREE.BufferGeometry();
      outGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      outGeo.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
      outGeo.setIndex(new THREE.BufferAttribute(idxArr, 1));
      if (!srcNorm) {
        outGeo.computeVertexNormals();
      }
      trackGeo(outGeo);
      uniqueGeos.push(outGeo);
      totalUniqueVerts += vCount;
      totalUniqueIndices += idxCount;
      return outGeo;
    };

    for (let mi = 0; mi < bucket.meshes.length; mi++) {
      const mesh = bucket.meshes[mi];
      const srcGeo = mesh.geometry;
      relMat.multiplyMatrices(containerInv, mesh.matrixWorld);
      const isMirrored = relMat.determinant() < 0;

      let normGeo: THREE.BufferGeometry;
      let instMatrix: THREE.Matrix4;
      if (isMirrored) {
        normGeo = buildNormalizedGeo(srcGeo, relMat);
        instMatrix = _batchIdentityMat.clone();
      } else {
        const cached = rawGeoCache.get(srcGeo);
        if (cached) {
          normGeo = cached;
        } else {
          normGeo = buildNormalizedGeo(srcGeo, null);
          rawGeoCache.set(srcGeo, normGeo);
        }
        instMatrix = relMat.clone();
      }

      const mat = mesh.material as THREE.MeshStandardMaterial;
      entries.push({
        mesh,
        geo: normGeo,
        matrix: instMatrix,
        color: mat.color.clone(),
      });
    }

    if (entries.length < 2 || totalUniqueVerts <= 0 || totalUniqueIndices <= 0) {
      continue;
    }

    const batchMat = trackMat(
      new THREE.MeshStandardMaterial({
        name: `rivian_batched_std_${label}`,
        color: 0xffffff,
        roughness: bucket.template.roughness,
        metalness: bucket.template.metalness,
        envMap: bucket.template.envMap,
        envMapIntensity: bucket.template.envMapIntensity,
        side: bucket.template.side,
        flatShading: bucket.template.flatShading,
        toneMapped: bucket.template.toneMapped,
      }),
    );
    if (bucket.reflBase >= 0) {
      reflectiveMaterials.push({
        material: batchMat,
        baseEnvIntensity: bucket.reflBase,
      });
    }

    const batched = trackBatch(
      new THREE.BatchedMesh(
        entries.length,
        totalUniqueVerts,
        totalUniqueIndices,
        batchMat,
      ),
    );
    batched.name = `rivian_batched_${label}`;
    batched.castShadow = bucket.castShadow;
    batched.receiveShadow = bucket.receiveShadow;
    batched.renderOrder = bucket.renderOrder;
    batched.layers.mask = bucket.layerMask;
    batched.perObjectFrustumCulled = true;

    const geoIdByGeo = new Map<THREE.BufferGeometry, number>();
    for (let gi = 0; gi < uniqueGeos.length; gi++) {
      const g = uniqueGeos[gi];
      geoIdByGeo.set(g, batched.addGeometry(g));
    }

    for (let ei = 0; ei < entries.length; ei++) {
      const entry = entries[ei];
      const geoId = geoIdByGeo.get(entry.geo)!;
      const instId = batched.addInstance(geoId);
      batched.setMatrixAt(instId, entry.matrix);
      batched.setColorAt(instId, entry.color);
      entry.mesh.parent?.remove(entry.mesh);
    }

    batched.computeBoundingBox();
    batched.computeBoundingSphere();
    batched.updateMatrix();
    batched.matrixAutoUpdate = false;
    container.add(batched);
  }
}

export const RIVIAN_TIRE_RADIUS = 0.4315;
export const RIVIAN_TIRE_WIDTH = 0.326;
export const RIVIAN_WHEELBASE_HALF = 1.7245;
export const RIVIAN_TRACK_HALF = 0.84;
export const RIVIAN_Y_LIFT = 0.3385;

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function createShadowBlobTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(
    size * 0.5,
    size * 0.5,
    size * 0.14,
    size * 0.5,
    size * 0.5,
    size * 0.5,
  );
  grad.addColorStop(0, 'rgba(18, 12, 8, 0.72)');
  grad.addColorStop(0.55, 'rgba(20, 14, 10, 0.44)');
  grad.addColorStop(1, 'rgba(20, 14, 10, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createCrackedGlassTexture(heavyShatter: boolean): THREE.CanvasTexture {
  const w = 256;
  const h = 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#141e26');
  grad.addColorStop(0.5, '#0c1218');
  grad.addColorStop(1, '#090e13');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const centers = heavyShatter
    ? [
        { x: w * 0.34, y: h * 0.42, r: 88 },
        { x: w * 0.68, y: h * 0.34, r: 78 },
        { x: w * 0.52, y: h * 0.64, r: 65 },
      ]
    : [{ x: w * 0.38, y: h * 0.46, r: 68 }];

  for (let ci = 0; ci < centers.length; ci++) {
    const center = centers[ci];
    const rays = heavyShatter ? 24 : 15;
    for (let r = 0; r < rays; r++) {
      const ang = (r / rays) * Math.PI * 2 + (hash2(r, ci + 1) - 0.5) * 0.24;
      ctx.strokeStyle =
        r % 2 === 0 ? 'rgba(235, 244, 255, 0.85)' : 'rgba(180, 206, 232, 0.62)';
      ctx.lineWidth = r % 3 === 0 ? 2.1 : 1.25;
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      const steps = 6;
      for (let s = 1; s <= steps; s++) {
        const rad = (s / steps) * center.r * (0.65 + hash2(r + s, ci) * 0.5);
        const jitter = (hash2(s * 7, r * 3 + ci) - 0.5) * 0.14;
        ctx.lineTo(
          center.x + Math.cos(ang + jitter) * rad,
          center.y + Math.sin(ang + jitter) * rad,
        );
      }
      ctx.stroke();
    }

    const rings = heavyShatter ? 6 : 4;
    for (let k = 1; k <= rings; k++) {
      const ringR = (k / rings) * center.r * 0.72;
      ctx.strokeStyle =
        k <= 2 ? 'rgba(240, 248, 255, 0.88)' : 'rgba(205, 222, 238, 0.55)';
      ctx.lineWidth = k === 1 ? 1.8 : 1.1;
      ctx.beginPath();
      const segs = 18;
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const rr = ringR * (0.85 + hash2(s, k + ci * 5) * 0.28);
        const x = center.x + Math.cos(a) * rr;
        const y = center.y + Math.sin(a) * rr;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    const crush = ctx.createRadialGradient(center.x, center.y, 1, center.x, center.y, 26);
    crush.addColorStop(0, 'rgba(235, 242, 248, 0.85)');
    crush.addColorStop(0.5, 'rgba(180, 198, 214, 0.38)');
    crush.addColorStop(1, 'rgba(180, 198, 214, 0.0)');
    ctx.fillStyle = crush;
    ctx.fillRect(center.x - 28, center.y - 28, 56, 56);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Enhances the Rivian's baked PBR carpaint material with lightweight pseudo-ray-traced reflections:
 *  - Asymmetric ground-anchored & biome-corridor Parallax-Corrected Cubemap (PCC)
 *  - Dual-lobe clearcoat: sharp cone-traced hardware cubemap (`uEnvCubeRaw`) for dielectric lacquer
 *    paired with Three.js GGX PMREM for metallic microflake basecoat
 *  - Analytical vehicle-body self-occlusion + Sébastien Lagarde specular occlusion
 *  - Progressive desert dust / mud rocker patina & brushed-steel crash scrapes (`aScrape`)
 */
function enhanceRivianPaintMaterial(
  mat: THREE.MeshPhysicalMaterial,
  sharedUniforms: ReflectionSharedUniforms | undefined,
  cacheSuffix: string,
  rtUniforms: CabinRtLightingUniforms,
): void {
  const uniforms = sharedUniforms ?? createFallbackReflectionUniforms();

  // Keep painted panel clearcoat sharp & coherent across both primary & secondary carpaint slots
  mat.ior = 1.56;
  if (mat.name === 'SF_carpaint.4') {
    mat.clearcoat = 1.0;
    mat.clearcoatRoughness = Math.min(mat.clearcoatRoughness, 0.045);
  } else {
    mat.clearcoat = 1.0;
    mat.clearcoatRoughness = Math.min(mat.clearcoatRoughness || 0.02, 0.024);
  }

  mat.customProgramCacheKey = () => `duneflow_rivian_rt_paint_v4_${cacheSuffix}`;
  mat.onBeforeCompile = (shader) => {
    bindReflectionSharedUniforms(shader.uniforms, uniforms);
    shader.uniforms.uRtEnabled = rtUniforms.uRtEnabled;
    shader.uniforms.uRtBounceGain = rtUniforms.uRtBounceGain;
    shader.uniforms.uAmbientColor = rtUniforms.uAmbientColor;
    shader.uniforms.uAmbientIntensity = rtUniforms.uAmbientIntensity;
    shader.uniforms.uHeadlightBounce = rtUniforms.uHeadlightBounce;
    shader.uniforms.uHazardFlash = rtUniforms.uHazardFlash;
    shader.uniforms.uLightbarPower = rtUniforms.uLightbarPower;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aScrape;
varying vec3 vRivWorldPos;
varying vec3 vRivLocalPos;
varying vec3 vRivWorldNormal;
varying float vRivScrape;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vec4 rivWp = modelMatrix * vec4( transformed, 1.0 );
vRivWorldPos = rivWp.xyz;
vRivLocalPos = position;
vRivWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
vRivScrape = clamp( aScrape, 0.0, 1.0 );`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vRivWorldPos;
varying vec3 vRivLocalPos;
varying vec3 vRivWorldNormal;
varying float vRivScrape;
uniform float uRtEnabled;
uniform float uRtBounceGain;
uniform vec3 uAmbientColor;
uniform float uAmbientIntensity;
uniform float uHeadlightBounce;
uniform float uHazardFlash;
uniform float uLightbarPower;
${AUTOMOTIVE_RT_UNIFORMS_AND_HELPERS_GLSL}

float rivHash31( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}`,
      )
      .replace(
        '#include <envmap_physical_pars_fragment>',
        buildAsymmetricPccEnvMapChunk('vRivWorldPos'),
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec3 rivViewW = normalize( cameraPosition - vRivWorldPos );
vec3 rivNormW = normalize( vRivWorldNormal );
float rivNdotV = clamp( dot( rivNormW, rivViewW ), 0.0, 1.0 );

// Subtle lower-body desert dust / mud patina
float dustHeight = 1.0 - smoothstep( 0.25, 0.85, vRivLocalPos.y );
float dustNoise = rivHash31( floor( vRivLocalPos * 14.0 ) ) * 0.45 + rivHash31( floor( vRivLocalPos * 4.5 ) ) * 0.55;
float rivDustMask = clamp( dustHeight * max( 0.0, uChassisDust - 0.12 ) * ( 0.55 + 0.75 * dustNoise ), 0.0, 0.52 );
vec3 biomePatina = mix( vec3( 0.52, 0.34, 0.18 ), vec3( 0.12, 0.09, 0.06 ), uBiomeMud );
diffuseColor.rgb = mix( diffuseColor.rgb, biomePatina, rivDustMask * 0.52 );

// Localized directional automotive crash scratches + chipped paint micro-edges + satin raw aluminum.
// Strictly preserves Rivian body paint across surrounding dented/buckled sheet metal (ZERO wide black/white chrome blotches!)
float streakFine = rivHash31( floor( vRivLocalPos * vec3( 110.0, 210.0, 18.0 ) ) );
float streakMed  = rivHash31( floor( vRivLocalPos * vec3( 42.0, 88.0, 9.0 ) ) );
float chipNoise  = rivHash31( floor( vRivLocalPos * vec3( 64.0, 64.0, 64.0 ) ) );
float scratchLines = smoothstep( 0.56, 0.92, streakFine * 0.62 + streakMed * 0.38 );
float edgeChips    = smoothstep( 0.50, 0.86, chipNoise );
// Only sharp scratch lines & high-strain contact core peaks break through paint to satin aluminum
float rivScrapeMask = clamp(
  smoothstep( 0.46, 0.90, vRivScrape ) * ( 0.22 + 0.78 * scratchLines ) +
  smoothstep( 0.26, 0.72, vRivScrape ) * scratchLines * 0.30,
  0.0,
  0.68
);
float primerRim = clamp(
  smoothstep( 0.22, 0.56, vRivScrape ) * ( 0.30 + 0.70 * edgeChips ) * ( 1.0 - rivScrapeMask ) * 0.24,
  0.0,
  0.24
);
float contactScuff = smoothstep( 0.34, 0.80, vRivScrape ) * smoothstep( 0.68, 0.96, streakMed ) * 0.18;
vec3 primerCol   = vec3( 0.42, 0.40, 0.37 );
vec3 bareAlumCol = vec3( 0.68, 0.67, 0.64 );
vec3 scuffCol    = vec3( 0.22, 0.21, 0.20 );
diffuseColor.rgb = mix( diffuseColor.rgb, primerCol, primerRim );
diffuseColor.rgb = mix( diffuseColor.rgb, bareAlumCol, rivScrapeMask );
diffuseColor.rgb = mix( diffuseColor.rgb, scuffCol, contactScuff );`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix( roughnessFactor, 0.86, rivDustMask * 0.72 );
roughnessFactor = mix( roughnessFactor, 0.56, rivScrapeMask );
roughnessFactor = mix( roughnessFactor, 0.72, primerRim + contactScuff );`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
// Satin scuffed aluminum keeps strong diffuse lighting on BOTH vertical fenders and horizontal hoods (never 0.92 black/white mirror!)
metalnessFactor = mix( metalnessFactor, 0.40, rivScrapeMask );
metalnessFactor = mix( metalnessFactor, 0.08, primerRim + contactScuff );`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
{
  vec3 paintShadingN = normalize( transformDirectionByInverseViewMatrix( geometryNormal, viewMatrix ) );
  float paintSelfOcc = 1.0;
  float cleanClearcoat = ( 1.0 - rivDustMask * 0.76 ) * ( 1.0 - clamp( rivScrapeMask + primerRim * 0.8 + contactScuff, 0.0, 0.92 ) );

  if ( uHasRawCube > 0.5 ) {
    // Dual-lobe metallic basecoat: blend cone-traced live cubemap (sharp horizon & canopy contrast on side doors!)
    // with GGX PMREM while applying analytical self-body & Lagarde specular occlusion.
    float baseSelf = 1.0;
    float baseConeRough = clamp( roughnessFactor * 0.72 + 0.04, 0.06, 0.65 );
    vec3 sharpBaseEnv = rivSampleRayTracedMirror(
      vRivWorldPos,
      paintShadingN,
      rivViewW,
      baseConeRough,
      0.93,
      baseSelf
    );
    float baseOcc = rivLagardeSpecOcc( clamp( dot( paintShadingN, rivViewW ), 0.0, 1.0 ), 0.92 * baseSelf, roughnessFactor );
    vec3 baseBounce = uGroundColor * ( 0.24 + 0.16 * clamp( paintShadingN.y * 0.5 + 0.5, 0.0, 1.0 ) );
    vec3 pmremGrounded = mix( baseBounce, radiance, baseOcc );
    float sharpBaseBlend = mix( 0.64, 0.18, smoothstep( 0.12, 0.55, roughnessFactor ) ) * cleanClearcoat;
    radiance = mix( pmremGrounded, sharpBaseEnv * uReflectGain * 1.08, sharpBaseBlend );

    // Crisp scraped bare-steel streaks pick up sharper metallic environment reflections
    if ( rivScrapeMask > 0.05 ) {
      float scrapeOcc = 1.0;
      vec3 steelEnv = rivSampleRayTracedMirror( vRivWorldPos, paintShadingN, rivViewW, 0.20, 0.90, scrapeOcc );
      radiance = mix( radiance, steelEnv * uReflectGain, rivScrapeMask * 0.72 );
    }

    #ifdef USE_CLEARCOAT
      vec3 ccWorldN = normalize( transformDirectionByInverseViewMatrix( geometryClearcoatNormal, viewMatrix ) );
      float ccRough = clamp( material.clearcoatRoughness + rivDustMask * 0.22, 0.014, 0.42 );
      vec3 sharpClearcoatEnv = rivSampleRayTracedMirror(
        vRivWorldPos,
        ccWorldN,
        rivViewW,
        ccRough,
        0.96,
        paintSelfOcc
      );
      // Feed razor-sharp cone-traced cubemap radiance directly into Three.js energy-conserving Clearcoat BRDF!
      clearcoatRadiance = sharpClearcoatEnv * uReflectGain * mix( 0.24, 1.38, cleanClearcoat );
    #endif
  } else {
    float fallbackOcc = rivLagardeSpecOcc( rivNdotV, 0.88, roughnessFactor );
    radiance *= fallbackOcc;
    #ifdef USE_CLEARCOAT
      clearcoatRadiance *= fallbackOcc * cleanClearcoat;
    #endif
  }
}`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
if ( uRtEnabled > 0.01 ) {
  float cleanRtCoat = ( 1.0 - rivDustMask * 0.72 ) * ( 1.0 - rivScrapeMask * 0.90 );
  float fresnelExt = 0.12 + 0.88 * pow( 1.0 - rivNdotV, 3.6 );
  float rtGainExt = uRtEnabled * uRtBounceGain * cleanRtCoat;
  vec3 extBounce = vec3( 0.0 );
  float frontZone = smoothstep( 0.85, 2.35, vRivLocalPos.z );
  extBounce += vec3( 0.78, 0.88, 1.0 ) * ( uHeadlightBounce * 0.14 + uLightbarPower * 0.24 ) * frontZone * fresnelExt;
  extBounce += vec3( 1.0, 0.48, 0.05 ) * ( uHazardFlash * 0.28 * frontZone * fresnelExt );
  reflectedLight.directSpecular += extBounce * rtGainExt;
}`,
      );
  };
}

/**
 * Normalizes a geometry's `color` attribute to a writable RGB Float32Array (itemSize=3)
 * and initializes `aScrape` float attribute so `deformSubmeshVertices` works cleanly on GLB panels.
 */
function prepareDeformableGeometry(geo: THREE.BufferGeometry): {
  restPositions: Float32Array;
  restNormals: Float32Array;
  restColors: Float32Array;
} {
  const posAttr = geo.attributes.position;
  const count = posAttr.count;
  let writablePos: Float32Array;
  if (
    posAttr instanceof THREE.BufferAttribute &&
    posAttr.array instanceof Float32Array &&
    !posAttr.normalized
  ) {
    writablePos = posAttr.array;
  } else {
    writablePos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      writablePos[i * 3 + 0] = posAttr.getX(i);
      writablePos[i * 3 + 1] = posAttr.getY(i);
      writablePos[i * 3 + 2] = posAttr.getZ(i);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(writablePos, 3));
  }
  const restPositions = new Float32Array(writablePos);

  if (!geo.attributes.normal) {
    geo.computeVertexNormals();
  }
  const normAttr = geo.attributes.normal;
  let writableNorm: Float32Array;
  if (
    normAttr instanceof THREE.BufferAttribute &&
    normAttr.array instanceof Float32Array &&
    !normAttr.normalized
  ) {
    writableNorm = normAttr.array;
  } else {
    // Unpack quantized INT8 / InterleavedBufferAttribute normals cleanly to writable Float32Array
    writableNorm = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      writableNorm[i * 3 + 0] = normAttr.getX(i);
      writableNorm[i * 3 + 1] = normAttr.getY(i);
      writableNorm[i * 3 + 2] = normAttr.getZ(i);
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(writableNorm, 3));
  }
  const restNormals = new Float32Array(writableNorm);

  const srcColor = geo.attributes.color;
  const colors = new Float32Array(count * 3);
  if (srcColor) {
    for (let i = 0; i < count; i++) {
      colors[i * 3 + 0] = srcColor.getX(i);
      colors[i * 3 + 1] = srcColor.getY(i);
      colors[i * 3 + 2] = srcColor.getZ(i);
    }
  } else {
    colors.fill(1.0);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const restColors = new Float32Array(colors);

  const scrapes = new Float32Array(count);
  geo.setAttribute('aScrape', new THREE.BufferAttribute(scrapes, 1));

  return { restPositions, restNormals, restColors };
}

/**
 * Splits a multi-triangle BufferGeometry by triangle predicate into new standalone BufferGeometries,
 * transforming vertex positions & normals into `modelRoot` space (`meshToModel`).
 */
function extractFilteredGeometry(
  srcGeo: THREE.BufferGeometry,
  meshToModel: THREE.Matrix4,
  predicate: (
    cx: number,
    cy: number,
    cz: number,
    minU: number,
    maxU: number,
    minV: number,
    maxV: number,
  ) => boolean,
  planarUvBounds?: { minX: number; maxX: number; minY: number; maxY: number },
): THREE.BufferGeometry | null {
  const posAttr = srcGeo.attributes.position;
  const normAttr = srcGeo.attributes.normal;
  const uvAttr = srcGeo.attributes.uv;
  const indexAttr = srcGeo.index;

  const normalMat = new THREE.Matrix3().getNormalMatrix(meshToModel);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();

  const outPos: number[] = [];
  const outNorm: number[] = [];
  const outUv: number[] = [];
  const outIdx: number[] = [];
  const remap = new Map<number, number>();

  const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;

  const emitVertex = (srcIdx: number): number => {
    const existing = remap.get(srcIdx);
    if (existing !== undefined) return existing;

    v.fromBufferAttribute(posAttr, srcIdx).applyMatrix4(meshToModel);
    outPos.push(v.x, v.y, v.z);

    if (normAttr) {
      n.fromBufferAttribute(normAttr, srcIdx).applyMatrix3(normalMat).normalize();
      outNorm.push(n.x, n.y, n.z);
    } else {
      outNorm.push(0, 1, 0);
    }

    if (planarUvBounds) {
      const spanX = Math.max(1e-4, planarUvBounds.maxX - planarUvBounds.minX);
      const spanY = Math.max(1e-4, planarUvBounds.maxY - planarUvBounds.minY);
      const pu = (planarUvBounds.maxX - v.x) / spanX;
      const pv = (v.y - planarUvBounds.minY) / spanY;
      outUv.push(Math.max(0, Math.min(1, pu)), Math.max(0, Math.min(1, pv)));
    } else if (uvAttr) {
      outUv.push(uvAttr.getX(srcIdx), uvAttr.getY(srcIdx));
    } else {
      outUv.push(0, 0);
    }

    const newIdx = outPos.length / 3 - 1;
    remap.set(srcIdx, newIdx);
    return newIdx;
  };

  for (let t = 0; t < triCount; t++) {
    const i0 = indexAttr ? indexAttr.getX(t * 3 + 0) : t * 3 + 0;
    const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

    const cx = (posAttr.getX(i0) + posAttr.getX(i1) + posAttr.getX(i2)) / 3;
    const cy = (posAttr.getY(i0) + posAttr.getY(i1) + posAttr.getY(i2)) / 3;
    const cz = (posAttr.getZ(i0) + posAttr.getZ(i1) + posAttr.getZ(i2)) / 3;

    const u0 = uvAttr ? uvAttr.getX(i0) : 0;
    const u1 = uvAttr ? uvAttr.getX(i1) : 0;
    const u2 = uvAttr ? uvAttr.getX(i2) : 0;
    const v0 = uvAttr ? uvAttr.getY(i0) : 0;
    const v1 = uvAttr ? uvAttr.getY(i1) : 0;
    const v2 = uvAttr ? uvAttr.getY(i2) : 0;

    if (
      predicate(
        cx,
        cy,
        cz,
        Math.min(u0, u1, u2),
        Math.max(u0, u1, u2),
        Math.min(v0, v1, v2),
        Math.max(v0, v1, v2),
      )
    ) {
      outIdx.push(emitVertex(i0), emitVertex(i1), emitVertex(i2));
    }
  }

  if (outIdx.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(outNorm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
  geo.setIndex(outIdx);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Remaps planar UVs on an existing mesh in `modelRoot` coordinates (`+X` left, `+Y` up, `+Z` forward).
 */
function remapMeshPlanarUVs(
  mesh: THREE.Mesh,
  meshToModel: THREE.Matrix4,
  axis: 'xy' | 'zy',
): { min: THREE.Vector3; max: THREE.Vector3 } {
  const geo = mesh.geometry.clone();
  mesh.geometry = geo;
  const pos = geo.attributes.position;
  const p = new THREE.Vector3();

  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(meshToModel);
    min.min(p);
    max.max(p);
  }

  const uvs = new Float32Array(pos.count * 2);
  const spanX = Math.max(1e-4, max.x - min.x);
  const spanY = Math.max(1e-4, max.y - min.y);
  const spanZ = Math.max(1e-4, max.z - min.z);

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(meshToModel);
    const u = axis === 'xy' ? (max.x - p.x) / spanX : (max.z - p.z) / spanZ;
    const v = (p.y - min.y) / spanY;
    uvs[i * 2 + 0] = Math.max(0, Math.min(1, u));
    uvs[i * 2 + 1] = Math.max(0, Math.min(1, v));
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.attributes.uv.needsUpdate = true;
  return { min, max };
}

/**
 * Creates a proxy Material property binding so setting `proxyMat.emissiveIntensity` or `.color`
 * propagates automatically to one or more distinct cloned GLB lamp materials (preserving each mesh's UV maps!).
 */
function linkMaterialGroup(
  proxyMat: THREE.MeshStandardMaterial,
  targets: Array<{ mat: THREE.MeshStandardMaterial; scale: number; tintHex?: number }>,
): void {
  let intensity = proxyMat.emissiveIntensity;
  const origColors = targets.map((t) => t.mat.color.clone());
  const apply = () => {
    const isBrokenDark = intensity <= 0.001;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      t.mat.emissiveIntensity = intensity * t.scale;
      if (isBrokenDark) {
        t.mat.color.setHex(0x161a20);
      } else {
        t.mat.color.copy(origColors[i]);
      }
      if (t.tintHex !== undefined) {
        t.mat.emissive.setHex(t.tintHex);
      }
    }
  };
  apply();
  Object.defineProperty(proxyMat, 'emissiveIntensity', {
    configurable: true,
    enumerable: true,
    get() {
      return intensity;
    },
    set(val: number) {
      intensity = val;
      apply();
    },
  });
}

export function buildRivianTruckVisuals(
  root: THREE.Group,
  wheelSpecs: Array<WheelMountSpec & { name: string }>,
  tireRadius: number,
  _tireWidth: number,
  reflectionUniforms?: ReflectionSharedUniforms,
  onModelLoaded?: () => void,
  initialMaxAnisotropy = 4,
  onModelError?: (err: unknown) => void,
): TrophyTruckVisuals {
  let disposed = false;

  const disposableGeos: THREE.BufferGeometry[] = [];
  const disposableMats: THREE.Material[] = [];
  const disposableTex: THREE.Texture[] = [];
  const disposableBatches: THREE.BatchedMesh[] = [];

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
  const trackBatch = <T extends THREE.BatchedMesh>(b: T): T => {
    disposableBatches.push(b);
    return b;
  };

  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const rtUniforms = createCabinRtLightingUniforms();
  const frontRain = createWindshieldRainMaterial(false);
  const sideRain = createWindshieldRainMaterial(true);
  trackMat(frontRain.material);
  trackMat(sideRain.material);

  // Proxy / shared emissive control materials synced directly by VehicleRig
  const headlightLensMatLeft = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xf4f8ff,
      emissive: 0xe6f2ff,
      emissiveIntensity: 2.2,
      roughness: 0.1,
    }),
  );
  const headlightLensMatRight = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xf4f8ff,
      emissive: 0xe6f2ff,
      emissiveIntensity: 2.2,
      roughness: 0.1,
    }),
  );
  const brakeLightMatLeft = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xb91c1c,
      emissive: 0xff1a12,
      emissiveIntensity: 1.2,
      roughness: 0.2,
      toneMapped: false,
    }),
  );
  const brakeLightMatRight = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xb91c1c,
      emissive: 0xff1a12,
      emissiveIntensity: 1.2,
      roughness: 0.2,
      toneMapped: false,
    }),
  );
  const reverseLightMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xf8fbff,
      emissiveIntensity: 0.0,
      roughness: 0.15,
      toneMapped: false,
    }),
  );
  const ledDrlMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xeef7ff,
      emissiveIntensity: 2.2,
      roughness: 0.12,
      toneMapped: false,
    }),
  );
  const ledDrlMatLeft = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xeef7ff,
      emissiveIntensity: 2.2,
      roughness: 0.12,
      toneMapped: false,
    }),
  );
  const ledDrlMatRight = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xeef7ff,
      emissiveIntensity: 2.2,
      roughness: 0.12,
      toneMapped: false,
    }),
  );
  const amberMarkerMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff8a18,
      emissive: 0xff6a00,
      emissiveIntensity: 1.4,
      roughness: 0.22,
      toneMapped: false,
    }),
  );
  const hazardLampMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff8800,
      emissive: 0xff7700,
      emissiveIntensity: 0.08,
      roughness: 0.22,
      toneMapped: false,
    }),
  );
  const lightbarLedMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xf0f8ff,
      emissive: 0xdff2ff,
      emissiveIntensity: 0.04,
      roughness: 0.15,
      toneMapped: false,
    }),
  );
  const boostGlowMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.0,
    }),
  );

  // Forward SpotLight mounted to bodyGroup at Rivian lightbar/headlamp height
  const forwardBeamSpot = new THREE.SpotLight(0xfff4e2, 0, 56, Math.PI * 0.24, 0.55, 1.4);
  forwardBeamSpot.position.set(0, 1.06, 2.52);
  forwardBeamSpot.target.position.set(0, 0.22, 24.0);
  bodyGroup.add(forwardBeamSpot);
  bodyGroup.add(forwardBeamSpot.target);

  // Exterior crash-damage windshield & rear-glass material variants
  const crackedTex = trackTex(createCrackedGlassTexture(false));
  const shatteredTex = trackTex(createCrackedGlassTexture(true));

  const intactGlassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x101c20,
      roughness: 0.03,
      metalness: 0.0,
      ior: 1.52,
      clearcoat: 1.0,
      clearcoatRoughness: 0.025,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  applyRivianGlassRtReflections(intactGlassMat, reflectionUniforms, 'windshield', {
    baseOpacity: 0.20,
    grazingOpacity: 0.78,
    reflectionBoost: 1.24,
  });
  const crackedGlassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: crackedTex,
      roughness: 0.24,
      metalness: 0.04,
      clearcoat: 0.72,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const shatteredGlassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: shatteredTex,
      roughness: 0.42,
      metalness: 0.04,
      clearcoat: 0.45,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const intactRearGlassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x0b1115,
      roughness: 0.03,
      metalness: 0.0,
      ior: 1.52,
      clearcoat: 1.0,
      clearcoatRoughness: 0.025,
      transparent: true,
      opacity: 0.50,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  applyRivianGlassRtReflections(intactRearGlassMat, reflectionUniforms, 'rearglass', {
    baseOpacity: 0.46,
    grazingOpacity: 0.88,
    reflectionBoost: 1.24,
  });
  const crackedRearGlassMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: shatteredTex,
      roughness: 0.36,
      metalness: 0.08,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );

  // Screen materials swapped onto split Rivian dual displays
  const placeholderCanvas = document.createElement('canvas');
  placeholderCanvas.width = 64;
  placeholderCanvas.height = 64;
  const pCtx = placeholderCanvas.getContext('2d')!;
  pCtx.fillStyle = '#07090d';
  pCtx.fillRect(0, 0, 64, 64);
  const placeholderTex = trackTex(new THREE.CanvasTexture(placeholderCanvas));
  placeholderTex.colorSpace = THREE.SRGBColorSpace;

  let activeClusterTex: THREE.Texture = placeholderTex;
  let activeSyncTex: THREE.Texture = placeholderTex;

  const clusterScreenMat = trackMat(
    new THREE.MeshBasicMaterial({
      map: placeholderTex,
      toneMapped: false,
    }),
  );
  const syncScreenMat = trackMat(
    new THREE.MeshBasicMaterial({
      map: placeholderTex,
      toneMapped: false,
    }),
  );

  // Dynamic visual references updated once GLB finishes loading
  let steeringWheelRef: THREE.Object3D = new THREE.Group();
  const whipAntenna = new THREE.Group(); // Rivian R1T uses sleek roof sharkfin (no whip)
  let hoodPivotRef: THREE.Group = new THREE.Group();
  bodyGroup.add(hoodPivotRef);

  let leftMirrorPivotRef: THREE.Object3D = new THREE.Group();
  let rightMirrorPivotRef: THREE.Object3D = new THREE.Group();
  let interiorMirrorPivotRef: THREE.Object3D = new THREE.Group();

  let leftWiperBone: THREE.Object3D | null = null;
  let rightWiperBone: THREE.Object3D | null = null;
  const leftWiperBaseQuat = new THREE.Quaternion();
  const rightWiperBaseQuat = new THREE.Quaternion();
  const _yAxis = new THREE.Vector3(0, 1, 0);
  const _wiperDeltaQuat = new THREE.Quaternion();

  const stubGeo = trackGeo(new THREE.BufferGeometry());
  const stubMat = trackMat(new THREE.MeshBasicMaterial({ visible: false }));
  const windshieldMeshRef: { current: THREE.Mesh } = {
    current: new THREE.Mesh(stubGeo, intactGlassMat),
  };
  const rearGlassMeshRef: { current: THREE.Mesh } = {
    current: new THREE.Mesh(stubGeo, intactRearGlassMat),
  };

  let leftMirrorLensMesh: THREE.Mesh = new THREE.Mesh(stubGeo, stubMat);
  let rightMirrorLensMesh: THREE.Mesh = new THREE.Mesh(stubGeo, stubMat);
  let interiorMirrorLensMesh: THREE.Mesh = new THREE.Mesh(stubGeo, stubMat);
  const leftMirrorPosAnchor = new THREE.Object3D();
  const rightMirrorPosAnchor = new THREE.Object3D();
  const interiorMirrorPosAnchor = new THREE.Object3D();
  leftMirrorPosAnchor.position.set(1.0, 1.39, 0.76);
  rightMirrorPosAnchor.position.set(-1.0, 1.39, 0.76);
  interiorMirrorPosAnchor.position.set(0.06, 1.66, 0.61);
  bodyGroup.add(leftMirrorPosAnchor, rightMirrorPosAnchor, interiorMirrorPosAnchor);

  let boundLeftMirrorMat: THREE.Material | null = null;
  let boundRightMirrorMat: THREE.Material | null = null;
  let boundInteriorMirrorMat: THREE.Material | null = null;

  const overrideMeshWorldPos = (mesh: THREE.Mesh, anchor: THREE.Object3D) => {
    mesh.getWorldPosition = (target: THREE.Vector3) => anchor.getWorldPosition(target);
  };

  // Contact shadow disc
  const shadowTex = trackTex(createShadowBlobTexture());
  const contactShadowGeo = trackGeo(new THREE.PlaneGeometry(2.38, 5.55));
  contactShadowGeo.rotateX(-Math.PI / 2);
  const contactShadowMat = trackMat(
    new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: 0.54,
      depthWrite: false,
    }),
  );
  const contactShadow = new THREE.Mesh(contactShadowGeo, contactShadowMat);
  contactShadow.position.y = 0.03;
  // Hidden until GLB finishes mounting so there is never an empty road with a lonely floating black oval
  contactShadow.visible = false;
  root.add(contactShadow);

  // Wheel suspension assemblies (`FL=0, FR=1, RL=2, RR=3`)
  const wheelAssemblies: WheelVisualAssembly[] = [];
  const dummyArmGeo = trackGeo(new THREE.BufferGeometry());
  for (const spec of wheelSpecs) {
    const steerPivot = new THREE.Group();
    steerPivot.position.set(spec.x, tireRadius, spec.z);
    root.add(steerPivot);

    const camberGroup = new THREE.Group();
    steerPivot.add(camberGroup);

    const spinGroup = new THREE.Group();
    camberGroup.add(spinGroup);

    const lowerArm = new THREE.Mesh(dummyArmGeo, stubMat);
    lowerArm.visible = false;
    const upperArm = new THREE.Mesh(dummyArmGeo, stubMat);
    upperArm.visible = false;
    const coilGroup = new THREE.Group();
    coilGroup.visible = false;

    wheelAssemblies.push({
      steerPivot,
      camberGroup,
      spinGroup,
      lowerArm,
      upperArm,
      coilGroup,
    });
  }

  // Empty detachable Groups populated cleanly upon GLB load
  const detachableGroups: Record<DetachablePartId, THREE.Group> = {
    frontBumper: new THREE.Group(),
    frontGrille: new THREE.Group(),
    rearBumper: new THREE.Group(),
    tailgate: new THREE.Group(),
    hood: new THREE.Group(),
    leftMirror: new THREE.Group(),
    rightMirror: new THREE.Group(),
    leftStep: new THREE.Group(),
    rightStep: new THREE.Group(),
    spareTire: new THREE.Group(),
    roofBoards: new THREE.Group(),
    lightBar: new THREE.Group(),
  };

  const deformableMeshes: DeformableMeshRecord[] = [];
  const reflectiveMaterials: Array<{
    material: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
    baseEnvIntensity: number;
  }> = [
    { material: intactGlassMat, baseEnvIntensity: 1.45 },
    { material: crackedGlassMat, baseEnvIntensity: 1.0 },
    { material: shatteredGlassMat, baseEnvIntensity: 0.75 },
    { material: intactRearGlassMat, baseEnvIntensity: 1.35 },
    { material: crackedRearGlassMat, baseEnvIntensity: 0.9 },
  ];

  // Subtle OEM overhead console switches nestled in Rivian headliner (cockpit-only & interior layer)
  const cockpitGroup = new THREE.Group();
  cockpitGroup.visible = false;
  bodyGroup.add(cockpitGroup);
  const cabinBounceLight = new THREE.PointLight(0xff5a14, 0.45, 3.6, 1.5);
  cabinBounceLight.position.set(0.06, 1.62, 0.56);
  cabinBounceLight.visible = false;
  cockpitGroup.add(cabinBounceLight);

  const interactiveSwitches: CockpitInteractiveSwitch[] = [];
  const switchPipMats: Record<CabinSwitchId, THREE.MeshStandardMaterial> = {} as Record<
    CabinSwitchId,
    THREE.MeshStandardMaterial
  >;
  const switchDefs: Array<{ id: CabinSwitchId; x: number }> = [
    { id: 'headlights', x: 0.08 },
    { id: 'lightbar', x: 0.04 },
    { id: 'hazard', x: 0.0 },
    { id: 'dome', x: -0.04 },
    { id: 'ambient', x: -0.08 },
  ];
  const switchHousingMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x101318,
      roughness: 0.48,
      metalness: 0.25,
    }),
  );
  const domeSpotLight = new THREE.PointLight(0xfff0d4, 0.0, 3.2, 1.6);
  domeSpotLight.position.set(0.04, 1.72, 0.46);
  domeSpotLight.visible = false;
  cockpitGroup.add(domeSpotLight);

  for (const sw of switchDefs) {
    const pipMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x262c36,
        emissive: 0xff7a1a,
        emissiveIntensity: 0.2,
        roughness: 0.25,
        toneMapped: false,
      }),
    );
    switchPipMats[sw.id] = pipMat;
    const swGeo = trackGeo(new THREE.BoxGeometry(0.032, 0.012, 0.028));
    attachGeometryBvh(swGeo);
    const swMesh = new THREE.Mesh(swGeo, switchHousingMat);
    swMesh.position.set(sw.x, 1.728, 0.52);
    swMesh.rotation.x = 0.24;
    swMesh.name = `rivian_switch_${sw.id}`;
    swMesh.layers.set(CABIN_INTERIOR_LAYER);
    swMesh.castShadow = false;
    swMesh.updateMatrix();
    swMesh.matrixAutoUpdate = false;
    cockpitGroup.add(swMesh);
    interactiveSwitches.push({ id: sw.id, mesh: swMesh });

    const pipGeo = trackGeo(new THREE.BoxGeometry(0.022, 0.005, 0.006));
    const pipMesh = new THREE.Mesh(pipGeo, pipMat);
    pipMesh.position.set(sw.x, 1.721, 0.508);
    pipMesh.rotation.x = 0.24;
    pipMesh.layers.set(CABIN_INTERIOR_LAYER);
    pipMesh.castShadow = false;
    pipMesh.updateMatrix();
    pipMesh.matrixAutoUpdate = false;
    cockpitGroup.add(pipMesh);
  }

  let cockpitViewActive = false;
  let underHoodVisible = false;
  let targetMaxAnisotropy = Math.max(1, Math.round(initialMaxAnisotropy));
  let cockpitOnlyGroupRef: THREE.Group | null = null;
  let underHoodBayGroupRef: THREE.Group | null = null;
  let underHoodLinerGroupRef: THREE.Group | null = null;
  let cockpitMerged = false;
  let underHoodMerged = false;
  let deferredSpecialProtected: Set<THREE.Object3D> | null = null;
  const deferredReflectiveBaseByMat = new Map<THREE.Material, number>();
  let frontBumperRestPos: THREE.Vector3 | null = null;
  const loadedGlbTextures: THREE.Texture[] = [];

  const clusterScreenMesh = new THREE.Mesh(stubGeo, clusterScreenMat);
  const syncScreenMesh = new THREE.Mesh(stubGeo, syncScreenMat);

  const cockpit: RaptorCockpitRig = {
    cockpitGroup,
    steeringWheel: new THREE.Group(),
    leftWiperPivot: new THREE.Group(),
    rightWiperPivot: new THREE.Group(),
    interiorMirrorPivot: new THREE.Group(),
    clusterScreenMesh,
    syncScreenMesh,
    interiorMirrorLensMesh,
    interactiveSwitches,
    rtUniforms,
    windshieldRainUniforms: frontRain.uniforms,
    sideGlassRainUniforms: sideRain.uniforms,
    setClusterTexture: (tex: THREE.Texture) => {
      activeClusterTex = tex;
      clusterScreenMat.map = tex;
      clusterScreenMat.needsUpdate = true;
    },
    setSyncTexture: (tex: THREE.Texture) => {
      activeSyncTex = tex;
      syncScreenMat.map = tex;
      syncScreenMat.needsUpdate = true;
    },
    updateWipers: (leftAngleRad: number, rightAngleRad: number, wipeFreshness: number) => {
      if (leftWiperBone) {
        _wiperDeltaQuat.setFromAxisAngle(_yAxis, -Math.max(0, leftAngleRad - 0.14));
        leftWiperBone.quaternion.copy(leftWiperBaseQuat).multiply(_wiperDeltaQuat);
      }
      if (rightWiperBone) {
        _wiperDeltaQuat.setFromAxisAngle(_yAxis, -Math.max(0, rightAngleRad - 0.14));
        rightWiperBone.quaternion.copy(rightWiperBaseQuat).multiply(_wiperDeltaQuat);
      }
      frontRain.uniforms.uWiperLeftAngle.value = leftAngleRad;
      frontRain.uniforms.uWiperRightAngle.value = rightAngleRad;
      frontRain.uniforms.uWipeFreshness.value = wipeFreshness;
    },
    updateLightingAndMirrors: (p: CockpitLightingSyncParams) => {
      const rtActive = cockpitViewActive && p.rayTracedLighting;
      if (cockpitViewActive) {
        rtUniforms.uCabinInvMatrix.value.copy(p.bodyWorldMatrix).invert();
      }
      rtUniforms.uRtEnabled.value = rtActive ? 1.0 : 0.0;
      rtUniforms.uRtBounceGain.value = p.rtBounceStrength;
      rtUniforms.uTime.value = p.timeSec;

      const ambPower = p.ambientLightOn ? p.ambientIntensity : 0.0;
      rtUniforms.uAmbientColor.value.set(p.ambientColorHex);
      rtUniforms.uAmbientIntensity.value = ambPower;

      const domePower = p.domeLightOn ? 1.0 : 0.0;
      rtUniforms.uDomeIntensity.value = domePower;
      domeSpotLight.visible = cockpitViewActive && p.domeLightOn;
      domeSpotLight.intensity = p.domeLightOn ? 1.4 : 0.0;

      cabinBounceLight.visible = cockpitViewActive;
      if (cockpitViewActive) {
        if (p.domeLightOn) {
          cabinBounceLight.color.setHex(0xfff0d4);
          cabinBounceLight.intensity = p.rayTracedLighting ? 1.35 : 0.9;
        } else if (p.ambientLightOn) {
          cabinBounceLight.color.set(p.ambientColorHex);
          cabinBounceLight.intensity = (p.rayTracedLighting ? 0.34 : 0.14) * ambPower;
        } else {
          cabinBounceLight.color.set(p.syncScreenHex);
          cabinBounceLight.intensity = p.rayTracedLighting ? 0.18 : 0.06;
        }
      }

      rtUniforms.uSyncScreenColor.value.set(p.syncScreenHex);
      rtUniforms.uSyncScreenIntensity.value = 1.0;
      rtUniforms.uClusterIntensity.value = 0.92;
      rtUniforms.uHeadlightBounce.value = p.headlightPower;
      rtUniforms.uLightbarPower.value = p.lightbarOn ? 1.0 : 0.0;
      rtUniforms.uHazardFlash.value = p.hazardFlash01;

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

      interiorMirrorPivotRef.rotation.set(
        p.interiorMirrorPitchRad * 0.45,
        p.interiorMirrorYawRad * 0.45,
        0,
      );
    },
    setCockpitActive: (active: boolean) => {
      cockpitViewActive = active;
      cockpitGroup.visible = active;
      if (cockpitOnlyGroupRef) {
        if (active && !cockpitMerged && deferredSpecialProtected) {
          cockpitMerged = true;
          const empty = new Set<THREE.Object3D>();
          mergeStaticContainerByMaterial(
            cockpitOnlyGroupRef,
            deferredSpecialProtected,
            empty,
            trackGeo,
          );
          batchUntexturedStandardMeshes(
            cockpitOnlyGroupRef,
            deferredSpecialProtected,
            empty,
            trackGeo,
            trackMat,
            trackBatch,
            deferredReflectiveBaseByMat,
            reflectiveMaterials,
            'cockpit',
          );
        }
        cockpitOnlyGroupRef.visible = active;
      }
      cabinBounceLight.visible = active;
      domeSpotLight.visible = active;
      if (!active) {
        rtUniforms.uRtEnabled.value = 0.0;
      }
    },
    dispose: () => {
      for (const b of disposableBatches) b.dispose();
      for (const g of disposableGeos) {
        disposeGeometryBvh(g);
        g.dispose();
      }
      for (const m of disposableMats) m.dispose();
      for (const t of disposableTex) t.dispose();
    },
  };

  // Visual steering wheel & mirror proxies updated automatically once GLB loads
  const visuals: TrophyTruckVisuals = {
    bodyGroup,
    get hoodPivot() {
      return hoodPivotRef;
    },
    get steeringWheel() {
      return steeringWheelRef as THREE.Group;
    },
    whipAntenna,
    brakeLightMatLeft,
    brakeLightMatRight,
    reverseLightMat,
    headlightLensMatLeft,
    headlightLensMatRight,
    ledDrlMat,
    ledDrlMatLeft,
    ledDrlMatRight,
    amberMarkerMat,
    hazardLampMat,
    lightbarLedMat,
    boostGlowMat,
    forwardBeamSpot,
    get windshieldMesh() {
      return windshieldMeshRef.current;
    },
    get rearGlassMesh() {
      return rearGlassMeshRef.current;
    },
    get leftMirrorPivot() {
      return leftMirrorPivotRef as THREE.Group;
    },
    get rightMirrorPivot() {
      return rightMirrorPivotRef as THREE.Group;
    },
    get leftMirrorLensMesh() {
      return leftMirrorLensMesh;
    },
    get rightMirrorLensMesh() {
      return rightMirrorLensMesh;
    },
    get interiorMirrorLensMesh() {
      return interiorMirrorLensMesh;
    },
    intactGlassMat,
    crackedGlassMat,
    shatteredGlassMat,
    intactRearGlassMat,
    crackedRearGlassMat,
    reflectiveMaterials,
    contactShadow,
    wheelAssemblies,
    deformableMeshes,
    detachableGroups,
    cockpit,
    setTextureAnisotropy: (maxAnisotropy: number) => {
      const clamped = Math.max(1, Math.round(maxAnisotropy));
      targetMaxAnisotropy = clamped;
      for (let i = 0; i < loadedGlbTextures.length; i++) {
        const tex = loadedGlbTextures[i];
        if (tex.anisotropy !== clamped) {
          tex.anisotropy = clamped;
          tex.needsUpdate = true;
        }
      }
    },
    setUnderHoodVisible: (visible: boolean) => {
      if (underHoodVisible === visible) return;
      underHoodVisible = visible;
      if (visible && !underHoodMerged && deferredSpecialProtected) {
        underHoodMerged = true;
        root.updateMatrixWorld(true);
        const empty = new Set<THREE.Object3D>();
        if (underHoodBayGroupRef) {
          mergeStaticContainerByMaterial(underHoodBayGroupRef, deferredSpecialProtected, empty, trackGeo);
          batchUntexturedStandardMeshes(
            underHoodBayGroupRef,
            deferredSpecialProtected,
            empty,
            trackGeo,
            trackMat,
            trackBatch,
            deferredReflectiveBaseByMat,
            reflectiveMaterials,
            'underhood_bay',
          );
        }
        if (underHoodLinerGroupRef) {
          mergeStaticContainerByMaterial(underHoodLinerGroupRef, deferredSpecialProtected, empty, trackGeo);
          batchUntexturedStandardMeshes(
            underHoodLinerGroupRef,
            deferredSpecialProtected,
            empty,
            trackGeo,
            trackMat,
            trackBatch,
            deferredReflectiveBaseByMat,
            reflectiveMaterials,
            'underhood_liner',
          );
        }
      }
      if (underHoodBayGroupRef) underHoodBayGroupRef.visible = visible;
      if (underHoodLinerGroupRef) underHoodLinerGroupRef.visible = visible;
    },
    resetVisualDamage: () => {
      for (let i = 0; i < deformableMeshes.length; i++) {
        const rec = deformableMeshes[i];
        const geo = rec.mesh.geometry;
        (geo.attributes.position.array as Float32Array).set(rec.restPositions);
        (geo.attributes.normal.array as Float32Array).set(rec.restNormals);
        (geo.attributes.color.array as Float32Array).set(rec.restColors);
        if (geo.attributes.aScrape) {
          (geo.attributes.aScrape.array as Float32Array).fill(0);
          geo.attributes.aScrape.needsUpdate = true;
        }
        geo.attributes.position.needsUpdate = true;
        geo.attributes.normal.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
      }

      hoodPivotRef.rotation.set(0, 0, 0);
      if (frontBumperRestPos) {
        detachableGroups.frontBumper.position.copy(frontBumperRestPos);
      }
      detachableGroups.frontBumper.rotation.set(0, 0, 0);
      underHoodVisible = false;
      if (underHoodBayGroupRef) underHoodBayGroupRef.visible = false;
      if (underHoodLinerGroupRef) underHoodLinerGroupRef.visible = false;
      windshieldMeshRef.current.material = intactGlassMat;
      rearGlassMeshRef.current.material = intactRearGlassMat;
      headlightLensMatLeft.color.setHex(0xf4f8ff);
      headlightLensMatRight.color.setHex(0xf4f8ff);
      headlightLensMatLeft.emissiveIntensity = 2.2;
      headlightLensMatRight.emissiveIntensity = 2.2;
      ledDrlMat.emissiveIntensity = 2.2;
      ledDrlMatLeft.emissiveIntensity = 2.2;
      ledDrlMatRight.emissiveIntensity = 2.2;
      brakeLightMatLeft.color.setHex(0xb91c1c);
      brakeLightMatRight.color.setHex(0xb91c1c);
      brakeLightMatLeft.emissiveIntensity = 1.2;
      brakeLightMatRight.emissiveIntensity = 1.2;

      const keys = Object.keys(detachableGroups) as DetachablePartId[];
      for (const k of keys) {
        detachableGroups[k].visible = true;
      }
      for (const asm of wheelAssemblies) {
        asm.camberGroup.rotation.set(0, 0, 0);
      }
    },
    dispose: () => {
      disposed = true;
      cockpit.dispose();
    },
  };

  // Consume t=0ms pre-parsed GLTF (zero duplicate download or late main-thread parse stall!)
  const onGltfParsed = (gltf: { scene: THREE.Group }) => {
    const modelRoot = gltf.scene;
    if (disposed) {
        modelRoot.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) {
            const m = obj as THREE.Mesh;
            m.geometry.dispose();
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            for (const mat of mats) {
              mat.dispose();
            }
          }
        });
        return;
      }

      modelRoot.updateMatrixWorld(true);

      // 1. Track geometries, textures, restore stripped lens materials & downgrade non-paint/glass physical materials
      const matRemap = new Map<THREE.Material, THREE.Material>();
      const seenTex = new Set<THREE.Texture>();
      const seenGeos = new Set<THREE.BufferGeometry>();

      const processAndOptimizeMaterial = (origMat: THREE.Material): THREE.Material => {
        const existing = matRemap.get(origMat);
        if (existing) return existing;

        const phys = origMat as THREE.MeshPhysicalMaterial;
        const isPaint =
          origMat.name === 'Detail_Microflake_carpaint' || origMat.name === 'SF_carpaint.4';
        const hadTransmission =
          ('transmission' in phys && typeof phys.transmission === 'number' && phys.transmission > 0.1) ||
          TRANSMISSIVE_LENS_MAT_NAMES.has(origMat.name);
        const isWindowGlass =
          origMat.name.startsWith('window glass') ||
          origMat.name.includes('SF_glass');

        if ('transmission' in phys && typeof phys.transmission === 'number') {
          phys.transmission = 0;
        }

        // Keep MeshPhysicalMaterial ONLY for clearcoated paint & glass/lenses; downgrade all trim/rubber/interior/metal to MeshStandardMaterial
        let finalMat: THREE.Material = origMat;
        if (phys.isMeshPhysicalMaterial && !isPaint && !hadTransmission && !isWindowGlass) {
          finalMat = downgradePhysicalMaterial(phys);
          origMat.dispose();
        }
        matRemap.set(origMat, finalMat);
        trackMat(finalMat);

        const std = finalMat as THREE.MeshPhysicalMaterial;
        const isInteriorGhostGlass = finalMat.name === 'PATCH_151_SF_glass.3';
        const isTrimGlass = finalMat.name === 'SF_glass.3';
        const isExteriorWindowGlass = finalMat.name.startsWith('window glass');
        const isWheelPaint = finalMat.name === 'SF_wheelpaint.3';

        if (isInteriorGhostGlass) {
          // Strip bogus alpha=0 metallic=1 interior glass layer that caused ghost chrome reflections behind windows
          std.transparent = true;
          std.depthWrite = false;
          std.opacity = 0.0;
          std.metalness = 0.0;
          std.roughness = 0.5;
          std.visible = false;
        } else if (hadTransmission) {
          std.transparent = true;
          std.depthWrite = false;
          std.roughness = 0.04;
          std.metalness = 0.0;
          if (std.isMeshPhysicalMaterial) {
            std.clearcoat = 1.0;
            std.clearcoatRoughness = 0.03;
            std.ior = 1.5;
          }
          if (finalMat.name.includes('Detail_Tail_Inner_Lens')) {
            std.color.setHex(0x8a0d0a);
            std.opacity = 0.44;
          } else {
            std.color.setHex(0xdce8f4);
            std.opacity = 0.14;
          }
        }
        if (isTrimGlass) {
          // Fix GLB's metallicFactor=1.0 chrome bug on trim glass -> dark dielectric glass with live PCC reflection
          std.color.setHex(0x0c1216);
          std.transparent = true;
          std.depthWrite = false;
          std.roughness = 0.035;
          std.metalness = 0.0;
          std.opacity = 0.34;
          if (std.isMeshPhysicalMaterial) {
            std.clearcoat = 1.0;
            std.clearcoatRoughness = 0.03;
            std.ior = 1.52;
            applyRivianGlassRtReflections(std, reflectionUniforms, 'trim_glass', {
              baseOpacity: 0.30,
              grazingOpacity: 0.84,
              reflectionBoost: 1.15,
            });
          }
        }
        if (isExteriorWindowGlass) {
          const isTinted = finalMat.name.includes('46%');
          std.color.setHex(isTinted ? 0x0b1216 : 0x101c20);
          std.transparent = true;
          std.depthWrite = false;
          std.roughness = 0.03;
          std.metalness = 0.0;
          std.opacity = isTinted ? 0.48 : 0.22;
          if (std.isMeshPhysicalMaterial) {
            std.clearcoat = 1.0;
            std.clearcoatRoughness = 0.025;
            std.ior = 1.52;
            applyRivianGlassRtReflections(
              std,
              reflectionUniforms,
              isTinted ? 'side_tint46' : 'side_tint77',
              {
                baseOpacity: isTinted ? 0.46 : 0.20,
                grazingOpacity: isTinted ? 0.88 : 0.78,
                reflectionBoost: 1.24,
              },
            );
          }
        }

        if (std.isMeshStandardMaterial || std.isMeshPhysicalMaterial) {
          for (let ti = 0; ti < MERGE_TEX_SLOTS.length; ti++) {
            const tex = std[MERGE_TEX_SLOTS[ti]] as THREE.Texture | null | undefined;
            if (tex && !seenTex.has(tex)) {
              seenTex.add(tex);
              tex.anisotropy = targetMaxAnisotropy;
              loadedGlbTextures.push(tex);
              trackTex(tex);
            }
          }

          if (isPaint) {
            enhanceRivianPaintMaterial(std, reflectionUniforms, finalMat.name, rtUniforms);
            reflectiveMaterials.push({ material: std, baseEnvIntensity: 1.18 });
          } else if (isExteriorWindowGlass || isTrimGlass) {
            reflectiveMaterials.push({ material: std, baseEnvIntensity: 1.32 });
          } else if (isWheelPaint) {
            applyRivianMetalRtReflections(std, reflectionUniforms, 'wheel_rim', 0.62);
            reflectiveMaterials.push({ material: std, baseEnvIntensity: 1.12 });
          } else if (
            finalMat.name === 'Smart_Native_gunmetal.2' ||
            finalMat.name === 'NativeSmallAtlas_06'
          ) {
            applyRivianMetalRtReflections(std, reflectionUniforms, finalMat.name, 0.45);
            reflectiveMaterials.push({ material: std, baseEnvIntensity: 0.92 });
          } else if (finalMat.name.includes('titanium')) {
            reflectiveMaterials.push({ material: std, baseEnvIntensity: 0.92 });
          } else if (!isInteriorGhostGlass) {
            reflectiveMaterials.push({ material: std, baseEnvIntensity: 0.62 });
          }

          // Cabin RT GI lighting on interior trim materials
          if (
            finalMat.name.includes('cloth') ||
            finalMat.name.includes('Leather') ||
            finalMat.name.includes('wood') ||
            finalMat.name.includes('titanium')
          ) {
            applyCabinRayTracedLighting(std, rtUniforms, {
              specStrength: finalMat.name.includes('titanium') ? 1.45 : 0.72,
              giStrength: 0.92,
              areaRoughness: finalMat.name.includes('titanium') ? 0.16 : 0.44,
              cacheKey: finalMat.name.includes('titanium') ? 'riv_tit' : 'riv_int',
            });
          }

          // Normalize excessive GLB HDR emissive strengths down to balanced scene scale
          if (std.emissiveIntensity && std.emissiveIntensity > 3.0) {
            std.emissiveIntensity = 1.8;
          }
        }
        return finalMat;
      };

      modelRoot.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          if (!seenGeos.has(mesh.geometry)) {
            seenGeos.add(mesh.geometry);
            trackGeo(mesh.geometry);
          }
          if (Array.isArray(mesh.material)) {
            mesh.material = mesh.material.map((m) => processAndOptimizeMaterial(m));
          } else if (mesh.material) {
            mesh.material = processAndOptimizeMaterial(mesh.material);
          }
          mesh.castShadow = false;
          mesh.receiveShadow = true;
        }
      });

      // 2. Locate key named objects & bones in GLB hierarchy
      // Three.js GLTFLoader sanitizes `[:]` out of node names (`PropertyBinding.sanitizeNodeName`)
      const normName = (s: string): string => s.replace(/[:\[\]]/g, '');
      const nodeEntries: Array<{ norm: string; obj: THREE.Object3D }> = [];
      const nodeByNorm = new Map<string, THREE.Object3D>();
      modelRoot.traverse((obj) => {
        if (obj.name) {
          const norm = normName(obj.name);
          nodeEntries.push({ norm, obj });
          if (!nodeByNorm.has(norm)) nodeByNorm.set(norm, obj);
        }
      });
      const getNode = (key: string): THREE.Object3D | undefined =>
        nodeByNorm.get(normName(key));

      const modelRootInv = new THREE.Matrix4().copy(modelRoot.matrixWorld).invert();
      const getModelMatrix = (obj: THREE.Object3D): THREE.Matrix4 =>
        new THREE.Matrix4().multiplyMatrices(modelRootInv, obj.matrixWorld);

      // 3. Extract 4 Wheel + Caliper Assemblies (`LF`, `RF`, `LR`, `RR`)
      const cornerConfigs: Array<{
        code: 'LF' | 'RF' | 'LR' | 'RR';
        cx: number;
        cy: number;
        cz: number;
      }> = [
        { code: 'LF', cx: 0.8401, cy: 0.0928, cz: 1.7245 },
        { code: 'RF', cx: -0.8401, cy: 0.0928, cz: 1.7245 },
        { code: 'LR', cx: 0.8401, cy: 0.0928, cz: -1.7245 },
        { code: 'RR', cx: -0.8401, cy: 0.0928, cz: -1.7245 },
      ];

      const wheelSpinOffsets: THREE.Group[] = [];
      const wheelCaliperOffsets: THREE.Group[] = [];
      for (let i = 0; i < cornerConfigs.length; i++) {
        const cfg = cornerConfigs[i];
        const asm = wheelAssemblies[i];
        const spinOffset = new THREE.Group();
        spinOffset.position.set(-cfg.cx, -cfg.cy, -cfg.cz);
        asm.spinGroup.add(spinOffset);
        wheelSpinOffsets.push(spinOffset);

        const caliperOffset = new THREE.Group();
        caliperOffset.position.set(-cfg.cx, -cfg.cy, -cfg.cz);
        asm.camberGroup.add(caliperOffset);
        wheelCaliperOffsets.push(caliperOffset);

        const spinRe = new RegExp(`^(rim_?|tyre_?|RIV_rotor)${cfg.code}`);
        const calRe = new RegExp(`^RIV_caliper${cfg.code}`);
        for (const { norm, obj } of nodeEntries) {
          if (spinRe.test(norm)) {
            spinOffset.add(obj);
          } else if (calRe.test(norm)) {
            caliperOffset.add(obj);
          }
        }
      }

      // 4. Add lifted chassis to bodyGroup (y + 0.3385 puts GLB ground plane flush at y = 0)
      const chassisLiftGroup = new THREE.Group();
      chassisLiftGroup.position.y = RIVIAN_Y_LIFT;
      chassisLiftGroup.add(modelRoot);
      bodyGroup.add(chassisLiftGroup);

      // Dedicated layer/culling containers inside chassisLiftGroup
      const interiorSilhouetteGroup = new THREE.Group();
      interiorSilhouetteGroup.name = 'rivian_interior_silhouette';
      chassisLiftGroup.add(interiorSilhouetteGroup);

      const cockpitOnlyGroup = new THREE.Group();
      cockpitOnlyGroup.name = 'rivian_cockpit_only';
      cockpitOnlyGroup.visible = cockpitViewActive;
      chassisLiftGroup.add(cockpitOnlyGroup);
      cockpitOnlyGroupRef = cockpitOnlyGroup;

      const underHoodBayGroup = new THREE.Group();
      underHoodBayGroup.name = 'rivian_under_hood_bay';
      underHoodBayGroup.visible = underHoodVisible;
      chassisLiftGroup.add(underHoodBayGroup);
      underHoodBayGroupRef = underHoodBayGroup;

      // 5. Split dual digital displays from `gaugeCluster_a_0_[digitalscreen]`
      let createdClusterMesh: THREE.Mesh | null = null;
      let createdSyncMesh: THREE.Mesh | null = null;
      const screenObj = getNode('gaugeCluster_a_0_[digitalscreen]') as
        | THREE.Mesh
        | undefined;
      if (screenObj && screenObj.isMesh) {
        const meshToModel = getModelMatrix(screenObj);
        const clusterGeo = extractFilteredGeometry(
          screenObj.geometry,
          meshToModel,
          (cx, _cy, _cz, _minU, _maxU, _minV, maxV) => cx > 0.22 && maxV > 0.08,
          { minX: 0.2654, maxX: 0.5047, minY: 0.9246, maxY: 1.0147 },
        );
        const syncGeo = extractFilteredGeometry(
          screenObj.geometry,
          meshToModel,
          (cx, _cy, _cz, _minU, _maxU, minV) => cx <= 0.22 && minV > 0.4,
          { minX: -0.1664, maxX: 0.174, minY: 0.8121, maxY: 0.9992 },
        );
        const bezelGeo = extractFilteredGeometry(
          screenObj.geometry,
          meshToModel,
          (cx, _cy, _cz, _minU, _maxU, minV, maxV) =>
            !(cx > 0.22 && maxV > 0.08) && !(cx <= 0.22 && minV > 0.4),
        );

        screenObj.visible = false;

        if (clusterGeo) {
          trackGeo(clusterGeo);
          const clusterMesh = new THREE.Mesh(clusterGeo, clusterScreenMat);
          clusterMesh.name = 'rivian_cluster_screen';
          clusterMesh.castShadow = false;
          clusterMesh.layers.set(CABIN_INTERIOR_LAYER);
          clusterMesh.updateMatrix();
          clusterMesh.matrixAutoUpdate = false;
          clusterScreenMat.map = activeClusterTex;
          clusterScreenMat.needsUpdate = true;
          cockpitOnlyGroup.add(clusterMesh);
          cockpit.clusterScreenMesh = clusterMesh;
          createdClusterMesh = clusterMesh;
        }
        if (syncGeo) {
          trackGeo(syncGeo);
          attachGeometryBvh(syncGeo);
          const syncMesh = new THREE.Mesh(syncGeo, syncScreenMat);
          syncMesh.name = 'rivian_center_screen';
          syncMesh.castShadow = false;
          syncMesh.layers.set(CABIN_INTERIOR_LAYER);
          syncMesh.updateMatrix();
          syncMesh.matrixAutoUpdate = false;
          syncScreenMat.map = activeSyncTex;
          syncScreenMat.needsUpdate = true;
          cockpitOnlyGroup.add(syncMesh);
          cockpit.syncScreenMesh = syncMesh;
          createdSyncMesh = syncMesh;
        }
        if (bezelGeo) {
          trackGeo(bezelGeo);
          const bezelMat = trackMat(
            new THREE.MeshStandardMaterial({
              color: 0x07090d,
              roughness: 0.16,
              metalness: 0.28,
            }),
          );
          const bezelMesh = new THREE.Mesh(bezelGeo, bezelMat);
          bezelMesh.castShadow = false;
          bezelMesh.layers.set(CABIN_INTERIOR_LAYER);
          bezelMesh.updateMatrix();
          bezelMesh.matrixAutoUpdate = false;
          cockpitOnlyGroup.add(bezelMesh);
        }
      }

      // 6. Wire Rivian steering wheel, wipers, and 3 rearview mirror pivots & lens UVs
      const steerBone = getNode('R1T_NATIVE::boneSteeringWheelSpindle');
      if (steerBone) {
        steeringWheelRef = steerBone;
        cockpit.steeringWheel = steerBone as THREE.Group;
      }

      const wL = getNode('R1T_NATIVE::boneWiperL');
      if (wL) {
        leftWiperBone = wL;
        leftWiperBaseQuat.copy(wL.quaternion);
      }
      const wR = getNode('R1T_NATIVE::boneWiperR');
      if (wR) {
        rightWiperBone = wR;
        rightWiperBaseQuat.copy(wR.quaternion);
      }

      const mirLBone = getNode('R1T_NATIVE::boneMirrorL_001');
      if (mirLBone) leftMirrorPivotRef = mirLBone;
      const mirRBone = getNode('R1T_NATIVE::boneMirrorR_001');
      if (mirRBone) rightMirrorPivotRef = mirRBone;
      const mirCBone = getNode('R1T_NATIVE::boneMirrorC_001');
      if (mirCBone) interiorMirrorPivotRef = mirCBone;

      const mirLM = getNode('wingMirrorL_a_2_[mirror_left]') as THREE.Mesh | undefined;
      if (mirLM?.isMesh) {
        const { min, max } = remapMeshPlanarUVs(mirLM, getModelMatrix(mirLM), 'xy');
        trackGeo(mirLM.geometry);
        leftMirrorPosAnchor.position.set(
          (min.x + max.x) * 0.5,
          (min.y + max.y) * 0.5 + RIVIAN_Y_LIFT,
          (min.z + max.z) * 0.5,
        );
        overrideMeshWorldPos(mirLM, leftMirrorPosAnchor);
        leftMirrorLensMesh = mirLM;
        if (boundLeftMirrorMat) mirLM.material = boundLeftMirrorMat;
      }

      const mirRM = getNode('wingMirrorR_a_2_[mirror_left]') as THREE.Mesh | undefined;
      if (mirRM?.isMesh) {
        const { min, max } = remapMeshPlanarUVs(mirRM, getModelMatrix(mirRM), 'xy');
        trackGeo(mirRM.geometry);
        rightMirrorPosAnchor.position.set(
          (min.x + max.x) * 0.5,
          (min.y + max.y) * 0.5 + RIVIAN_Y_LIFT,
          (min.z + max.z) * 0.5,
        );
        overrideMeshWorldPos(mirRM, rightMirrorPosAnchor);
        rightMirrorLensMesh = mirRM;
        if (boundRightMirrorMat) mirRM.material = boundRightMirrorMat;
      }

      const mirCM = getNode('overheadConsole_a_2_[mirror_center]') as THREE.Mesh | undefined;
      if (mirCM?.isMesh) {
        const { min, max } = remapMeshPlanarUVs(mirCM, getModelMatrix(mirCM), 'xy');
        trackGeo(mirCM.geometry);
        interiorMirrorPosAnchor.position.set(
          (min.x + max.x) * 0.5,
          (min.y + max.y) * 0.5 + RIVIAN_Y_LIFT,
          (min.z + max.z) * 0.5,
        );
        overrideMeshWorldPos(mirCM, interiorMirrorPosAnchor);
        interiorMirrorLensMesh = mirCM;
        cockpit.interiorMirrorLensMesh = mirCM;
        if (boundInteriorMirrorMat) mirCM.material = boundInteriorMirrorMat;
      }

      // 7. Curved Windshield & Side-Door Rain + Wiper Sweep + Crack Overlays
      const glassFInt = getNode('glassFInt_a_1_[glass_windshield]') as
        | THREE.Mesh
        | undefined;
      if (glassFInt?.isMesh) {
        remapMeshPlanarUVs(glassFInt, getModelMatrix(glassFInt), 'xy');
        trackGeo(glassFInt.geometry);
        glassFInt.material = frontRain.material;
        glassFInt.renderOrder = 3;
        glassFInt.castShadow = false;
      }

      const glassLFInt = getNode('glassLFInt_a_0_[glass_window_side]') as
        | THREE.Mesh
        | undefined;
      if (glassLFInt?.isMesh) {
        remapMeshPlanarUVs(glassLFInt, getModelMatrix(glassLFInt), 'zy');
        trackGeo(glassLFInt.geometry);
        glassLFInt.material = sideRain.material;
        glassLFInt.renderOrder = 3;
        glassLFInt.castShadow = false;
      }

      const glassRFInt = getNode('glassRFInt_a_0_[glass_window_side]') as
        | THREE.Mesh
        | undefined;
      if (glassRFInt?.isMesh) {
        remapMeshPlanarUVs(glassRFInt, getModelMatrix(glassRFInt), 'zy');
        trackGeo(glassRFInt.geometry);
        glassRFInt.material = sideRain.material;
        glassRFInt.renderOrder = 3;
        glassRFInt.castShadow = false;
      }

      const extWindshield = getNode('glassF_a_0_[glass_windshield]') as
        | THREE.Mesh
        | undefined;
      if (extWindshield?.isMesh) {
        remapMeshPlanarUVs(extWindshield, getModelMatrix(extWindshield), 'xy');
        trackGeo(extWindshield.geometry);
        extWindshield.material = intactGlassMat;
        extWindshield.castShadow = false;
        windshieldMeshRef.current = extWindshield;
      }

      const extRearGlass = getNode('glassR_a_0_[glass_window_side]') as
        | THREE.Mesh
        | undefined;
      if (extRearGlass?.isMesh) {
        remapMeshPlanarUVs(extRearGlass, getModelMatrix(extRearGlass), 'xy');
        trackGeo(extRearGlass.geometry);
        extRearGlass.material = intactRearGlassMat;
        extRearGlass.castShadow = false;
        rearGlassMeshRef.current = extRearGlass;
      }

      // 8. Clone & bind independent Left/Right Headlight, DRL, Taillight, Reverse & Hazard Emitters
      // Deduplicate cloned materials per (logicalGroup, origMat.uuid) so same-atlas emitters merge cleanly!
      const lampCloneCache = new Map<string, THREE.MeshStandardMaterial>();
      const cloneLampMeshMat = (
        groupKey: string,
        nodeName: string,
        baseColorHex?: number,
      ): { mat: THREE.MeshStandardMaterial; isNew: boolean } | null => {
        const m = getNode(nodeName) as THREE.Mesh | undefined;
        if (!m?.isMesh) return null;
        const orig = Array.isArray(m.material) ? m.material[0] : m.material;
        const cacheKey = `${groupKey}|${orig.uuid}|${baseColorHex ?? -1}`;
        let cloned = lampCloneCache.get(cacheKey);
        let isNew = false;
        if (!cloned) {
          cloned = orig.clone() as THREE.MeshStandardMaterial;
          cloned.toneMapped = false;
          if (baseColorHex !== undefined) {
            cloned.color.setHex(baseColorHex);
          }
          trackMat(cloned);
          lampCloneCache.set(cacheKey, cloned);
          isNew = true;
        }
        m.material = cloned;
        return { mat: cloned, isNew };
      };

      const hlLeftTargets: Array<{ mat: THREE.MeshStandardMaterial; scale: number; tintHex?: number }> = [];
      for (const n of ['headlightl_a_11_[emitter_ch1]', 'headlightl_a_12_[emitter_ch1]']) {
        const res = cloneLampMeshMat('hl_left', n, 0xb8d4f0);
        if (res?.isNew) hlLeftTargets.push({ mat: res.mat, scale: 1.0, tintHex: 0xeaf4ff });
      }
      if (hlLeftTargets.length > 0) linkMaterialGroup(headlightLensMatLeft, hlLeftTargets);

      const hlRightTargets: Array<{ mat: THREE.MeshStandardMaterial; scale: number; tintHex?: number }> = [];
      for (const n of ['headlightr_a_11_[emitter_ch1]', 'headlightr_a_12_[emitter_ch1]']) {
        const res = cloneLampMeshMat('hl_right', n, 0xb8d4f0);
        if (res?.isNew) hlRightTargets.push({ mat: res.mat, scale: 1.0, tintHex: 0xeaf4ff });
      }
      if (hlRightTargets.length > 0) linkMaterialGroup(headlightLensMatRight, hlRightTargets);

      const drlCenterTargets: Array<{ mat: THREE.MeshStandardMaterial; scale: number; tintHex?: number }> = [];
      for (const n of [
        'headlightc_a_0_[glass_detailed]',
        'headlightc_a_1_[glass_detailed_ch1]',
        'headlightc_a_3_[emitter_ch1]',
      ]) {
        const isGlassDrl = n.includes('glass');
        const res = cloneLampMeshMat(isGlassDrl ? 'drl_c_glass' : 'drl_c_emit', n, 0xc8ddf2);
        if (res?.isNew) drlCenterTargets.push({ mat: res.mat, scale: isGlassDrl ? 0.42 : 0.78, tintHex: 0xecf6ff });
      }
      if (drlCenterTargets.length > 0) linkMaterialGroup(ledDrlMat, drlCenterTargets);

      const drlLeftTargets: Array<{ mat: THREE.MeshStandardMaterial; scale: number; tintHex?: number }> = [];
      for (const n of [
        'headlightl_a_0_[glass_detailed]',
        'headlightl_a_1_[glass_detailed_ch1]',
        'headlightl_a_5_[glass_detailed_ch1]',
        'headlightl_a_10_[emitter_ch1]',
        'headlightl_a_13_[emitter_ch1]',
      ]) {
        const isGlassDrl = n.includes('glass');
        const res = cloneLampMeshMat(isGlassDrl ? 'drl_l_glass' : 'drl_l_emit', n, 0xc8ddf2);
        if (res?.isNew) drlLeftTargets.push({ mat: res.mat, scale: isGlassDrl ? 0.42 : 0.78, tintHex: 0xecf6ff });
      }
      if (drlLeftTargets.length > 0) linkMaterialGroup(ledDrlMatLeft, drlLeftTargets);

      const drlRightTargets: Array<{ mat: THREE.MeshStandardMaterial; scale: number; tintHex?: number }> = [];
      for (const n of [
        'headlightr_a_0_[glass_detailed]',
        'headlightr_a_1_[glass_detailed_ch1]',
        'headlightr_a_5_[glass_detailed_ch1]',
        'headlightr_a_10_[emitter_ch1]',
        'headlightr_a_13_[emitter_ch1]',
      ]) {
        const isGlassDrl = n.includes('glass');
        const res = cloneLampMeshMat(isGlassDrl ? 'drl_r_glass' : 'drl_r_emit', n, 0xc8ddf2);
        if (res?.isNew) drlRightTargets.push({ mat: res.mat, scale: isGlassDrl ? 0.42 : 0.78, tintHex: 0xecf6ff });
      }
      if (drlRightTargets.length > 0) linkMaterialGroup(ledDrlMatRight, drlRightTargets);

      const tailLeftTargets: Array<{ mat: THREE.MeshStandardMaterial; scale: number; tintHex?: number }> = [];
      for (const n of [
        'taillightL_a_1_[glass_detailed_ch1]',
        'taillightL_a_2_[glass_detailed_ch1]',
        'taillightL_a_3_[glass_detailed_ch1]',
      ]) {
        const res = cloneLampMeshMat('tail_left', n, 0x5c0705);
        if (res?.isNew) tailLeftTargets.push({ mat: res.mat, scale: 0.78, tintHex: 0xff140c });
      }
      const tailCenterRes = cloneLampMeshMat('tail_center', 'taillightC_a_2_[glass_detailed_ch1]', 0x580604);
      if (tailCenterRes?.isNew) {
        tailLeftTargets.push({ mat: tailCenterRes.mat, scale: 0.58, tintHex: 0xff120a });
      }
      const chmslRes = cloneLampMeshMat('tail_chmsl', 'taillightCHMSL_a_0_[emitter_ch1]', 0x580604);
      if (chmslRes?.isNew) {
        tailLeftTargets.push({ mat: chmslRes.mat, scale: 0.72, tintHex: 0xff1810 });
      }
      if (tailLeftTargets.length > 0) linkMaterialGroup(brakeLightMatLeft, tailLeftTargets);

      const tailRightTargets: Array<{ mat: THREE.MeshStandardMaterial; scale: number; tintHex?: number }> = [];
      for (const n of [
        'taillightR_a_1_[glass_detailed_ch1]',
        'taillightR_a_2_[glass_detailed_ch1]',
        'taillightR_a_3_[glass_detailed_ch1]',
      ]) {
        const res = cloneLampMeshMat('tail_right', n, 0x5c0705);
        if (res?.isNew) tailRightTargets.push({ mat: res.mat, scale: 0.78, tintHex: 0xff140c });
      }
      if (tailRightTargets.length > 0) linkMaterialGroup(brakeLightMatRight, tailRightTargets);

      const revTargets: Array<{ mat: THREE.MeshStandardMaterial; scale: number; tintHex?: number }> = [];
      for (const n of [
        'taillightL_a_7_[emitter_ch1]',
        'taillightL_a_8_[emitter_ch1]',
        'taillightR_a_7_[emitter_ch1]',
        'taillightR_a_8_[emitter_ch1]',
      ]) {
        const res = cloneLampMeshMat('reverse', n, 0xdbe6f0);
        if (res?.isNew) revTargets.push({ mat: res.mat, scale: 1.0, tintHex: 0xffffff });
      }
      if (revTargets.length > 0) linkMaterialGroup(reverseLightMat, revTargets);

      const auxLightbarTargets: Array<{ mat: THREE.MeshStandardMaterial; scale: number; tintHex?: number }> = [];
      for (const n of [
        'foglightl_a_1_[emitter_ch1]',
        'foglightl_a_2_[emitter_ch1]',
        'foglightl_a_3_[emitter_ch1]',
        'foglightr_a_1_[emitter_ch1]',
        'foglightr_a_2_[emitter_ch1]',
        'foglightr_a_3_[emitter_ch1]',
      ]) {
        const res = cloneLampMeshMat('aux_fog', n, 0x262c36);
        if (res?.isNew) auxLightbarTargets.push({ mat: res.mat, scale: 0.9, tintHex: 0xffeacc });
      }
      if (auxLightbarTargets.length > 0) linkMaterialGroup(lightbarLedMat, auxLightbarTargets);

      const hazardTargets: Array<{ mat: THREE.MeshStandardMaterial; scale: number; tintHex?: number }> = [];
      for (const n of [
        'bumperRsidemarkers_a_1_[emitter_ch1]',
        'bumperRsidemarkers_a_2_[emitter_ch1]',
      ]) {
        const res = cloneLampMeshMat('hazard', n, 0x803808);
        if (res?.isNew) hazardTargets.push({ mat: res.mat, scale: 1.0, tintHex: 0xff7700 });
      }
      if (hazardTargets.length > 0) linkMaterialGroup(hazardLampMat, hazardTargets);

      // 9. Mount centered Detachable Crash Subassemblies
      const detachableInnerOffsets = new Map<DetachablePartId, THREE.Group>();
      const mountDetachable = (
        partId: DetachablePartId,
        nodes: THREE.Object3D[],
        fallbackParent: THREE.Object3D = chassisLiftGroup,
      ): THREE.Group | null => {
        if (nodes.length === 0) return null;
        const box = new THREE.Box3();
        for (const n of nodes) {
          n.updateWorldMatrix(true, true);
          box.expandByObject(n);
        }
        const centerWorld = box.getCenter(new THREE.Vector3());
        fallbackParent.updateWorldMatrix(true, false);
        const parentInv = new THREE.Matrix4().copy(fallbackParent.matrixWorld).invert();
        const centerLocal = centerWorld.clone().applyMatrix4(parentInv);

        const group = detachableGroups[partId];
        group.position.copy(centerLocal);
        fallbackParent.add(group);

        const innerOffset = new THREE.Group();
        innerOffset.position.copy(centerLocal).negate();
        group.add(innerOffset);
        detachableInnerOffsets.set(partId, innerOffset);

        for (const n of nodes) {
          n.updateWorldMatrix(true, false);
          const relMat = new THREE.Matrix4().multiplyMatrices(parentInv, n.matrixWorld);
          innerOffset.add(n);
          n.matrixAutoUpdate = true;
          n.matrix.copy(relMat);
          n.matrix.decompose(n.position, n.quaternion, n.scale);
        }
        return innerOffset;
      };

      const collectByPrefixes = (prefixes: string[]): THREE.Object3D[] => {
        const out: THREE.Object3D[] = [];
        for (const { norm, obj } of nodeEntries) {
          if (prefixes.some((p) => norm.startsWith(p))) {
            out.push(obj);
          }
        }
        return out;
      };

      // Hood pivots cleanly on impact via hoodPivotRef positioned at boneHood!
      let hoodInnerOffset: THREE.Group | null = null;
      const hoodBone = getNode('R1T_NATIVE::boneHood');
      if (hoodBone) {
        hoodBone.updateWorldMatrix(true, false);
        const hoodPivotPos = new THREE.Vector3().setFromMatrixPosition(hoodBone.matrixWorld);
        modelRoot.updateWorldMatrix(true, false);
        const hoodLocal = hoodPivotPos
          .clone()
          .applyMatrix4(new THREE.Matrix4().copy(modelRoot.matrixWorld).invert());
        hoodPivotRef.position.set(hoodLocal.x, hoodLocal.y + RIVIAN_Y_LIFT, hoodLocal.z);

        const hoodMeshNodes = collectByPrefixes(['hood_a_']);
        hoodInnerOffset = mountDetachable('hood', hoodMeshNodes, hoodPivotRef);
      }

      const underHoodLinerGroup = new THREE.Group();
      underHoodLinerGroup.name = 'rivian_under_hood_liner';
      underHoodLinerGroup.visible = underHoodVisible;
      (hoodInnerOffset ?? chassisLiftGroup).add(underHoodLinerGroup);
      underHoodLinerGroupRef = underHoodLinerGroup;

      mountDetachable(
        'frontBumper',
        collectByPrefixes(['bumperF_a_', 'bumperFCustom_a_', 'foglightl_a_', 'foglightr_a_']),
      );
      frontBumperRestPos = detachableGroups.frontBumper.position.clone();
      mountDetachable(
        'rearBumper',
        collectByPrefixes(['bumperR_a_', 'bumperRsidemarkers_a_', 'glassbumperRsidemarkers_a_']),
      );
      mountDetachable(
        'tailgate',
        collectByPrefixes(['trunk_a_', 'trunkLiner_a_', 'taillightC_a_']),
      );
      mountDetachable(
        'lightBar',
        collectByPrefixes(['wing_a_', 'taillightCHMSL_a_']),
      );
      if (mirLBone) {
        mountDetachable('leftMirror', collectByPrefixes(['wingMirrorL_a_']), mirLBone);
      }
      if (mirRBone) {
        mountDetachable('rightMirror', collectByPrefixes(['wingMirrorR_a_']), mirRBone);
      }

      // Split side skirts into independent Left (+X) & Right (-X) step rails
      const skirtNodes = collectByPrefixes(['skirtL_a_']) as THREE.Mesh[];
      const _skirtTriCenter = new THREE.Vector3();
      const buildSplitSkirtSide = (partId: DetachablePartId, isLeft: boolean) => {
        const builtMeshes: THREE.Mesh[] = [];
        for (const sk of skirtNodes) {
          if (!sk.isMesh) continue;
          const mToModel = getModelMatrix(sk);
          const geo = extractFilteredGeometry(
            sk.geometry,
            mToModel,
            (cx) => {
              _skirtTriCenter.set(cx, 0, 0).applyMatrix4(mToModel);
              return isLeft ? _skirtTriCenter.x >= 0 : _skirtTriCenter.x < 0;
            },
          );
          if (geo) {
            trackGeo(geo);
            const m = new THREE.Mesh(geo, sk.material);
            m.castShadow = true;
            m.receiveShadow = true;
            builtMeshes.push(m);
          }
        }
        if (builtMeshes.length > 0) {
          for (const sk of skirtNodes) sk.visible = false;
          for (const bm of builtMeshes) chassisLiftGroup.add(bm);
          mountDetachable(partId, builtMeshes, chassisLiftGroup);
        }
      };
      buildSplitSkirtSide('leftStep', true);
      buildSplitSkirtSide('rightStep', false);

      // 9b. Authentic Rivian R1T EV Front Crash Structure & Frunk Details inside `underHoodBayGroup`
      // (No combustion engine — extruded aluminum crash beam, dual crush cans, low-mounted EV thermal
      // chiller, strut-tower braces, orange HV cables, washer fluid cap & ribbed frunk cargo floor!)
      {
        const alumBeamMat = trackMat(
          new THREE.MeshStandardMaterial({
            color: 0xaab2bc,
            roughness: 0.36,
            metalness: 0.78,
          }),
        );
        const darkChassisMat = trackMat(
          new THREE.MeshStandardMaterial({
            color: 0x1a1e24,
            roughness: 0.62,
            metalness: 0.35,
          }),
        );
        const chillerCoreMat = trackMat(
          new THREE.MeshStandardMaterial({
            color: 0x262b33,
            roughness: 0.48,
            metalness: 0.62,
          }),
        );
        const hvOrangeMat = trackMat(
          new THREE.MeshStandardMaterial({
            color: 0xf97316,
            roughness: 0.44,
            metalness: 0.12,
          }),
        );
        const washerCapMat = trackMat(
          new THREE.MeshStandardMaterial({
            color: 0x2563eb,
            roughness: 0.35,
            metalness: 0.08,
          }),
        );
        const frunkLedMat = trackMat(
          new THREE.MeshStandardMaterial({
            color: 0xf0f6ff,
            emissive: 0xdbeafe,
            emissiveIntensity: 1.35,
            roughness: 0.2,
          }),
        );

        const addEvPart = (
          geo: THREE.BufferGeometry,
          mat: THREE.Material,
          x: number,
          y: number,
          z: number,
          rx = 0,
          ry = 0,
          rz = 0,
        ) => {
          trackGeo(geo);
          const m = new THREE.Mesh(geo, mat);
          m.position.set(x, y, z);
          m.rotation.set(rx, ry, rz);
          m.castShadow = false;
          m.receiveShadow = true;
          underHoodBayGroup.add(m);
        };

        // Extruded brushed-aluminum front crash bar (revealed behind bumper/valance on heavy front hits)
        addEvPart(new THREE.BoxGeometry(1.36, 0.13, 0.08), alumBeamMat, 0, 0.44, 2.38);
        // Dual octagonal extruded aluminum crush cans anchoring crash bar to front rails
        addEvPart(new THREE.CylinderGeometry(0.068, 0.078, 0.30, 8), alumBeamMat, 0.48, 0.44, 2.20, Math.PI * 0.5);
        addEvPart(new THREE.CylinderGeometry(0.068, 0.078, 0.30, 8), alumBeamMat, -0.48, 0.44, 2.20, Math.PI * 0.5);
        // Low-mounted EV thermal glycol heat exchanger / chiller tucked low behind lower grille
        addEvPart(new THREE.BoxGeometry(0.92, 0.24, 0.05), chillerCoreMat, 0, 0.25, 2.28, -0.18);
        // Front dual strut-tower machined aluminum hats & cowl brace
        addEvPart(new THREE.CylinderGeometry(0.11, 0.13, 0.06, 12), alumBeamMat, 0.68, 0.80, 1.66);
        addEvPart(new THREE.CylinderGeometry(0.11, 0.13, 0.06, 12), alumBeamMat, -0.68, 0.80, 1.66);
        addEvPart(new THREE.BoxGeometry(1.34, 0.032, 0.045), darkChassisMat, 0, 0.82, 1.46);
        // Safety-orange High-Voltage (HV) EV cable conduits running cleanly along subframe firewall
        addEvPart(new THREE.CylinderGeometry(0.016, 0.016, 0.54, 8), hvOrangeMat, 0.60, 0.68, 1.64, Math.PI * 0.5);
        addEvPart(new THREE.CylinderGeometry(0.016, 0.016, 0.54, 8), hvOrangeMat, -0.60, 0.68, 1.64, Math.PI * 0.5);
        addEvPart(new THREE.CylinderGeometry(0.015, 0.015, 1.18, 8), hvOrangeMat, 0, 0.72, 1.42, 0, 0, Math.PI * 0.5);
        // Blue windshield washer reservoir cap + frunk cargo floor liner ribs + courtesy LED strip
        addEvPart(new THREE.CylinderGeometry(0.032, 0.034, 0.025, 10), washerCapMat, 0.66, 0.84, 1.48);
        for (let r = -2; r <= 2; r++) {
          addEvPart(new THREE.BoxGeometry(0.028, 0.014, 0.44), darkChassisMat, r * 0.18, 0.565, 2.04);
        }
        addEvPart(new THREE.BoxGeometry(0.46, 0.012, 0.016), frunkLedMat, 0, 0.76, 2.28);
      }

      // 10. Role-based Shadow Pruning, Layer Isolation & Visibility Partitioning
      // (Done BEFORE deformTargets registration so hoodLiner_a_* bodyToLocal matches its final parent!)
      root.updateMatrixWorld(true);
      const isDescendantOf = (obj: THREE.Object3D, ancestor: THREE.Object3D | undefined): boolean => {
        if (!ancestor) return false;
        let cur: THREE.Object3D | null = obj;
        while (cur) {
          if (cur === ancestor) return true;
          cur = cur.parent;
        }
        return false;
      };

      const deformTargets: Array<{
        prefix: string;
        zone: DamageZone;
        isHood?: boolean;
        isPlasticTrim?: boolean;
      }> = [
        { prefix: 'body_a_0', zone: 'roof' },
        { prefix: 'body_a_1', zone: 'left' },
        { prefix: 'body_a_2', zone: 'right' },
        // Full cohesive front-end assembly: fenders, arch cladding, hood + inner liner,
        // painted bumper + black plastic bumper + valance + skid plate + grille + lightbar/headlight housings
        { prefix: 'fenders_a_0', zone: 'front' },
        { prefix: 'fenders_a_2', zone: 'front', isPlasticTrim: true },
        { prefix: 'fenders_a_4', zone: 'front', isPlasticTrim: true },
        { prefix: 'hood_a_0', zone: 'front', isHood: true },
        { prefix: 'hoodLiner_a__SLOD_0', zone: 'front', isHood: true },
        { prefix: 'hoodLiner_a__SLOD_6', zone: 'front', isHood: true, isPlasticTrim: true },
        { prefix: 'bumperF_a_0', zone: 'front' },
        { prefix: 'bumperF_a_1', zone: 'front' },
        { prefix: 'bumperF_a_2', zone: 'front', isPlasticTrim: true },
        { prefix: 'bumperF_a_3', zone: 'front', isPlasticTrim: true },
        { prefix: 'bumperF_a_4', zone: 'front' },
        { prefix: 'bumperFCustom_a_0', zone: 'front' },
        { prefix: 'grille_a__SLOD_1', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightc_a_0', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightc_a_1', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightc_a_2', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightc_a_3', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightl_a_0', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightl_a_1', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightl_a_5', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightl_a_7', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightl_a_8', zone: 'front' },
        { prefix: 'headlightl_a_10', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightl_a_13', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightr_a_0', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightr_a_1', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightr_a_5', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightr_a_7', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightr_a_8', zone: 'front' },
        { prefix: 'headlightr_a_10', zone: 'front', isPlasticTrim: true },
        { prefix: 'headlightr_a_13', zone: 'front', isPlasticTrim: true },
        { prefix: 'trunk_a_0', zone: 'rear' },
        { prefix: 'doorHandleLF_a_0', zone: 'left' },
        { prefix: 'doorHandleLF_a_2', zone: 'left' },
        { prefix: 'doorHandleLR_a_0', zone: 'left' },
        { prefix: 'doorHandleLR_a_2', zone: 'left' },
        { prefix: 'doorHandleLF_a_1', zone: 'right' },
        { prefix: 'doorHandleLF_a_3', zone: 'right' },
        { prefix: 'doorHandleLR_a_1', zone: 'right' },
        { prefix: 'doorHandleLR_a_3', zone: 'right' },
      ];

      for (const { norm, obj } of nodeEntries) {
        if (!(obj as THREE.Mesh).isMesh) continue;
        const mesh = obj as THREE.Mesh;
        if (!mesh.visible) continue;

        // Interior rain/wiper glass & rearview mirror stay on CABIN_INTERIOR_LAYER (excluded from mirrors & CubeCamera)
        if (mesh === glassFInt || mesh === glassLFInt || mesh === glassRFInt || mesh === mirCM) {
          mesh.layers.set(CABIN_INTERIOR_LAYER);
          mesh.castShadow = false;
          continue;
        }
        if (mesh === extWindshield || mesh === extRearGlass || mesh === mirLM || mesh === mirRM) {
          mesh.castShadow = false;
          continue;
        }

        const primaryMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        const matName = primaryMat?.name ?? '';
        const role = classifyRivianNodeRole(norm, matName);

        if (role === 'sealed_cavity') {
          mesh.visible = false;
          mesh.castShadow = false;
          continue;
        }
        if (role === 'under_hood_bay') {
          mesh.castShadow = false;
          underHoodBayGroup.attach(mesh);
          continue;
        }
        if (role === 'under_hood_liner') {
          mesh.castShadow = false;
          underHoodLinerGroup.attach(mesh);
          continue;
        }

        // Steering wheel subtree stays parented to steerBone; isolate to interior layer with no shadows
        if (isDescendantOf(mesh, steerBone)) {
          mesh.layers.set(CABIN_INTERIOR_LAYER);
          mesh.castShadow = false;
          continue;
        }

        if (role === 'interior_micro') {
          mesh.layers.set(CABIN_INTERIOR_LAYER);
          mesh.castShadow = false;
          cockpitOnlyGroup.attach(mesh);
          continue;
        }
        if (role === 'interior_silhouette') {
          mesh.layers.set(CABIN_INTERIOR_LAYER);
          mesh.castShadow = false;
          interiorSilhouetteGroup.attach(mesh);
          continue;
        }

        mesh.castShadow = role === 'exterior_shadow';
        mesh.receiveShadow = true;
      }

      // 11. Register Deformable Sheetmetal, Bumper, Trim & Lightbar Panels with exact bodyGroup-to-vertex transforms
      bodyGroup.updateMatrixWorld(true);
      const bodyInv = new THREE.Matrix4().copy(bodyGroup.matrixWorld).invert();

      // Count geometry references so unique deformable meshes prepare in-place without redundant cloning
      const geoRefCount = new Map<THREE.BufferGeometry, number>();
      for (const { obj } of nodeEntries) {
        if ((obj as THREE.Mesh).isMesh) {
          const g = (obj as THREE.Mesh).geometry;
          geoRefCount.set(g, (geoRefCount.get(g) ?? 0) + 1);
        }
      }

      const deformableMeshSet = new Set<THREE.Object3D>();
      for (const { norm, obj } of nodeEntries) {
        if (!(obj as THREE.Mesh).isMesh) continue;
        const mesh = obj as THREE.Mesh;
        const match = deformTargets.find((t) => norm.startsWith(t.prefix));
        if (!match) continue;

        if ((geoRefCount.get(mesh.geometry) ?? 0) > 1) {
          mesh.geometry = mesh.geometry.clone();
          trackGeo(mesh.geometry);
        }
        const { restPositions, restNormals, restColors } = prepareDeformableGeometry(mesh.geometry);

        mesh.updateWorldMatrix(true, false);
        const localToBody = new THREE.Matrix4().multiplyMatrices(bodyInv, mesh.matrixWorld);
        const bodyToLocal = new THREE.Matrix4().copy(localToBody).invert();

        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
        const centerLocal = new THREE.Vector3();
        mesh.geometry.boundingBox?.getCenter(centerLocal);
        const centerInBody = centerLocal.clone().applyMatrix4(localToBody);
        const radius = mesh.geometry.boundingSphere
          ? mesh.geometry.boundingSphere.radius + 0.15
          : 1.5;

        deformableMeshSet.add(mesh);
        deformableMeshes.push({
          id: norm,
          mesh,
          center: centerInBody,
          extentRadius: radius,
          zoneHint: match.zone,
          restPositions,
          restNormals,
          restColors,
          bodyToLocal,
          isHood: match.isHood,
          isPlasticTrim: match.isPlasticTrim,
        });
      }

      const specialProtectedMeshes = new Set<THREE.Object3D>(deformableMeshSet);
      if (mirLM) specialProtectedMeshes.add(mirLM);
      if (mirRM) specialProtectedMeshes.add(mirRM);
      if (mirCM) specialProtectedMeshes.add(mirCM);
      if (glassFInt) specialProtectedMeshes.add(glassFInt);
      if (glassLFInt) specialProtectedMeshes.add(glassLFInt);
      if (glassRFInt) specialProtectedMeshes.add(glassRFInt);
      if (extWindshield) specialProtectedMeshes.add(extWindshield);
      if (extRearGlass) specialProtectedMeshes.add(extRearGlass);
      if (createdClusterMesh) specialProtectedMeshes.add(createdClusterMesh);
      if (createdSyncMesh) specialProtectedMeshes.add(createdSyncMesh);
      deferredSpecialProtected = specialProtectedMeshes;
      for (let ri = 0; ri < reflectiveMaterials.length; ri++) {
        const entry = reflectiveMaterials[ri];
        deferredReflectiveBaseByMat.set(entry.material, entry.baseEnvIntensity);
      }

      // 12. Batch-merge visible static same-material meshes immediately, then pack remaining
      // compatible untextured opaque MeshStandardMaterial singletons into THREE.BatchedMesh draw calls.
      const chassisExcludedSubtrees = new Set<THREE.Object3D>([
        interiorSilhouetteGroup,
        cockpitOnlyGroup,
        underHoodBayGroup,
        underHoodLinerGroup,
        hoodPivotRef,
        ...Object.values(detachableGroups),
      ]);
      if (steerBone) chassisExcludedSubtrees.add(steerBone);
      if (leftWiperBone) chassisExcludedSubtrees.add(leftWiperBone);
      if (rightWiperBone) chassisExcludedSubtrees.add(rightWiperBone);
      if (mirLBone) chassisExcludedSubtrees.add(mirLBone);
      if (mirRBone) chassisExcludedSubtrees.add(mirRBone);
      if (mirCBone) chassisExcludedSubtrees.add(mirCBone);

      const emptySubtrees = new Set<THREE.Object3D>();
      const runBatchingPass = (
        container: THREE.Object3D,
        excludedSubtrees: ReadonlySet<THREE.Object3D>,
        label: string,
      ) => {
        mergeStaticContainerByMaterial(container, specialProtectedMeshes, excludedSubtrees, trackGeo);
        batchUntexturedStandardMeshes(
          container,
          specialProtectedMeshes,
          excludedSubtrees,
          trackGeo,
          trackMat,
          trackBatch,
          deferredReflectiveBaseByMat,
          reflectiveMaterials,
          label,
        );
      };

      runBatchingPass(chassisLiftGroup, chassisExcludedSubtrees, 'chassis');
      runBatchingPass(interiorSilhouetteGroup, emptySubtrees, 'interior_sil');
      if (cockpitViewActive) {
        cockpitMerged = true;
        runBatchingPass(cockpitOnlyGroup, emptySubtrees, 'cockpit');
      }
      if (underHoodVisible) {
        underHoodMerged = true;
        runBatchingPass(underHoodBayGroup, emptySubtrees, 'underhood_bay');
        runBatchingPass(underHoodLinerGroup, emptySubtrees, 'underhood_liner');
      }

      for (let i = 0; i < wheelSpinOffsets.length; i++) {
        runBatchingPass(wheelSpinOffsets[i], emptySubtrees, `wheel_spin_${i}`);
        runBatchingPass(wheelCaliperOffsets[i], emptySubtrees, `wheel_cal_${i}`);
      }
      if (steerBone) {
        runBatchingPass(steerBone, emptySubtrees, 'steer');
      }
      if (leftWiperBone) {
        runBatchingPass(leftWiperBone, emptySubtrees, 'wiper_l');
      }
      if (rightWiperBone) {
        runBatchingPass(rightWiperBone, emptySubtrees, 'wiper_r');
      }
      const detachExcludedSubtrees = new Set<THREE.Object3D>([underHoodLinerGroup]);
      for (const [partId, innerOffset] of detachableInnerOffsets.entries()) {
        runBatchingPass(innerOffset, detachExcludedSubtrees, `detach_${partId}`);
      }

      // Reveal contact shadow the exact instant the truck geometry is mounted
      contactShadow.visible = true;

      // Immediately release source GLB geometries no longer referenced by any live scene mesh
      const liveGeos = new Set<THREE.BufferGeometry>();
      root.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          liveGeos.add((obj as THREE.Mesh).geometry);
        }
      });
      for (const origGeo of seenGeos) {
        if (!liveGeos.has(origGeo)) {
          origGeo.dispose();
        }
      }

      // Sync loaded lamp intensities and notify VehicleRig/WebSandAdapter immediately
      onModelLoaded?.();
  };

  consumeOrParseRivianGltf()
    .then((gltf) => {
      onGltfParsed(gltf);
    })
    .catch((err) => {
      console.error('Failed to load Rivian_R1T_2022_compact.glb:', err);
      onModelError?.(err);
    });

  // Also store helper to attach mirror shader materials dynamically (before OR after GLB load!)
  const origAttach = (leftMat: THREE.Material, rightMat: THREE.Material, interiorMat: THREE.Material) => {
    boundLeftMirrorMat = leftMat;
    boundRightMirrorMat = rightMat;
    boundInteriorMirrorMat = interiorMat;
    leftMirrorLensMesh.material = leftMat;
    rightMirrorLensMesh.material = rightMat;
    interiorMirrorLensMesh.material = interiorMat;
  };
  (visuals as TrophyTruckVisuals & { __attachMirrors?: typeof origAttach }).__attachMirrors =
    origAttach;

  return visuals;
}
