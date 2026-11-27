/**
 * BrushEncoder.ts
 * Packs active swept-segment deformation brushes (wheels, feet, chassis skids)
 * into a 16-byte-aligned std140/std430 Float32Array (64 bytes = 4 x vec4 per brush).
 *
 * Exact GPU contract (portable across WebGL2 DataTexture, WebGPU StorageBuffer,
 * UE5 StructuredBuffer, and Unity ComputeBuffer):
 *
 *   struct SandBrush {
 *     vec4 posPrevAndWidth;  // xyz = posPrev, w = halfWidth (meters)
 *     vec4 posCurrAndDepth;  // xyz = posCurr, w = targetSinkage (meters)
 *     vec4 motionParams;     // x = slipRatio, y = treadPhasePrev, z = treadPhaseCurr, w = lateralDrift
 *     vec4 meta;             // x = brushType (0=wheel, 1=foot), y = atlasId, z = compressionWeight, w = massFactor
 *   };
 */

import { SAND_DEFAULTS } from './SandParams';

export enum BrushType {
  Wheel = 0,
  Foot = 1,
}

export interface SandBrushInput {
  posPrevX: number;
  posPrevY: number;
  posPrevZ: number;
  halfWidth: number;

  posCurrX: number;
  posCurrY: number;
  posCurrZ: number;
  targetSinkage: number;

  slipRatio: number;
  treadPhasePrev: number;
  treadPhaseCurr: number;
  lateralDrift: number;

  brushType: BrushType;
  atlasId: number;
  compressionWeight: number;
  massFactor: number;
}

export class BrushEncoder {
  public readonly maxBrushes: number;
  public readonly strideFloats = SAND_DEFAULTS.BRUSH_STRIDE_FLOATS; // 16 floats = 64 bytes
  public readonly buffer: Float32Array;
  private count = 0;

  constructor(maxBrushes: number = SAND_DEFAULTS.MAX_BRUSHES) {
    this.maxBrushes = maxBrushes;
    this.buffer = new Float32Array(maxBrushes * this.strideFloats);
  }

  public clear(): void {
    this.count = 0;
  }

  public getCount(): number {
    return this.count;
  }

  public getByteLength(): number {
    return this.buffer.byteLength;
  }

  /**
   * Appends a swept brush into the 64-byte aligned buffer.
   * Returns false if capacity is full.
   */
  public push(b: SandBrushInput): boolean {
    if (this.count >= this.maxBrushes) return false;
    const o = this.count * this.strideFloats;
    const buf = this.buffer;

    // vec4 0: posPrevAndWidth
    buf[o + 0] = b.posPrevX;
    buf[o + 1] = b.posPrevY;
    buf[o + 2] = b.posPrevZ;
    buf[o + 3] = b.halfWidth;

    // vec4 1: posCurrAndDepth
    buf[o + 4] = b.posCurrX;
    buf[o + 5] = b.posCurrY;
    buf[o + 6] = b.posCurrZ;
    buf[o + 7] = b.targetSinkage;

    // vec4 2: motionParams
    buf[o + 8] = b.slipRatio;
    buf[o + 9] = b.treadPhasePrev;
    buf[o + 10] = b.treadPhaseCurr;
    buf[o + 11] = b.lateralDrift;

    // vec4 3: meta
    buf[o + 12] = b.brushType;
    buf[o + 13] = b.atlasId;
    buf[o + 14] = b.compressionWeight;
    buf[o + 15] = b.massFactor;

    this.count++;
    return true;
  }
}
