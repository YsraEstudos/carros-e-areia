/**
 * ClipmapGeometry.ts
 * Builds a single static Nested-Ring Geometry Clipmap (`THREE.BufferGeometry`)
 * rendered in 1 draw call with CDLOD morphing metadata in `aRingData`.
 *
 * Layout:
 *  - N = 64 cells per side per ring (inner hole = 32x32 for rings >= 1)
 *  - 8 concentric rings, baseCellSize = 0.08 m (8 cm near player -> 10.24 m at 327 m horizon)
 *  - ~51,200 triangles total, zero dynamic CPU mesh rebuilds, zero seams.
 */

import * as THREE from 'three';

export interface ClipmapStats {
  ringCount: number;
  baseCellSize: number;
  maxRadiusMeters: number;
  vertexCount: number;
  triangleCount: number;
}

export function buildNestedRingClipmap(
  cellsPerSide = 88,
  numRings = 8,
  baseCellSize = 0.044,
): { geometry: THREE.BufferGeometry; stats: ClipmapStats } {
  const halfN = cellsPerSide / 2;
  const quarterN = cellsPerSide / 4;
  const vertsPerRow = cellsPerSide + 1;

  const positions: number[] = [];
  const ringData: number[] = [];
  const indices: number[] = [];

  let vertexOffset = 0;

  for (let ring = 0; ring < numRings; ring++) {
    const cellSize = baseCellSize * Math.pow(2, ring);
    const halfExtent = halfN * cellSize;

    // Compact vertex remap table: emit ONLY vertices referenced by active quads (0 dead inner-hole vertices)
    const remap = new Int32Array(vertsPerRow * vertsPerRow);
    remap.fill(-1);

    const getOrEmitVertex = (ix: number, iz: number): number => {
      const flat = iz * vertsPerRow + ix;
      let idx = remap[flat];
      if (idx === -1) {
        const gx = ix - halfN;
        const gz = iz - halfN;
        idx = vertexOffset++;
        remap[flat] = idx;
        positions.push(gx * cellSize, 0, gz * cellSize);
        ringData.push(gx, gz, cellSize, halfExtent);
      }
      return idx;
    };

    // Emit quad indices (skipping inner hole covered by ring - 1)
    for (let iz = 0; iz < cellsPerSide; iz++) {
      const gz = iz - halfN;
      for (let ix = 0; ix < cellsPerSide; ix++) {
        const gx = ix - halfN;

        if (
          ring > 0 &&
          gx >= -quarterN &&
          gx < quarterN &&
          gz >= -quarterN &&
          gz < quarterN
        ) {
          continue;
        }

        const a = getOrEmitVertex(ix, iz);
        const b = getOrEmitVertex(ix + 1, iz);
        const c = getOrEmitVertex(ix, iz + 1);
        const d = getOrEmitVertex(ix + 1, iz + 1);

        // Alternate quad diagonal split to prevent directional sawtooth facets along curved ruts
        if (((ix + iz) & 1) === 0) {
          indices.push(a, c, b);
          indices.push(b, c, d);
        } else {
          indices.push(a, c, d);
          indices.push(a, d, b);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aRingData', new THREE.Float32BufferAttribute(ringData, 4));
  geometry.setIndex(indices);

  // Huge bounding sphere so Three.js frustum culling never clips the world-snapped clipmap
  const maxRadius = halfN * baseCellSize * Math.pow(2, numRings - 1);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), maxRadius * 4);

  return {
    geometry,
    stats: {
      ringCount: numRings,
      baseCellSize,
      maxRadiusMeters: maxRadius,
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
    },
  };
}
