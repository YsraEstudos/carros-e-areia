/**
 * MeshBvhSetup.ts
 * Configures `three-mesh-bvh` accelerated raycasting (`firstHitOnly`-compatible)
 * on Three.js BufferGeometry & Mesh prototypes, with safe attach/dispose helpers.
 */

import * as THREE from 'three';
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from 'three-mesh-bvh';

let bvhPatched = false;

/**
 * Idempotently patches Three.js `BufferGeometry` and `Mesh.prototype.raycast`
 * with `three-mesh-bvh` BVH acceleration. Safe to call multiple times.
 */
export function ensureMeshBvhPatched(): void {
  if (bvhPatched) return;
  bvhPatched = true;
  (THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree =
    computeBoundsTree;
  (THREE.BufferGeometry.prototype as unknown as { disposeBoundsTree: typeof disposeBoundsTree }).disposeBoundsTree =
    disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

/**
 * Attaches or rebuilds a BVH bounds tree on `geometry` for sub-millisecond raycasting
 * (cockpit touchscreen, switches, and terrain rock surfaces).
 */
export function attachGeometryBvh(
  geometry: THREE.BufferGeometry | null | undefined,
  forceRebuild = false,
): boolean {
  if (!geometry) return false;
  ensureMeshBvhPatched();
  const posAttr = geometry.attributes?.position;
  if (!posAttr || posAttr.count <= 0) return false;

  const geoWithBvh = geometry as THREE.BufferGeometry & {
    boundsTree?: unknown;
    computeBoundsTree?: () => void;
  };
  if (geoWithBvh.boundsTree && !forceRebuild) {
    return true;
  }
  if (typeof geoWithBvh.computeBoundsTree === 'function') {
    geoWithBvh.computeBoundsTree();
    return true;
  }
  return false;
}

/** Disposes any attached BVH tree on `geometry` cleanly. */
export function disposeGeometryBvh(
  geometry: THREE.BufferGeometry | null | undefined,
): void {
  if (!geometry) return;
  const geoWithBvh = geometry as THREE.BufferGeometry & {
    boundsTree?: unknown;
    disposeBoundsTree?: () => void;
  };
  if (geoWithBvh.boundsTree && typeof geoWithBvh.disposeBoundsTree === 'function') {
    geoWithBvh.disposeBoundsTree();
  }
}
