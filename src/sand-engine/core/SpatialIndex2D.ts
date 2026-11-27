/**
 * SpatialIndex2D.ts
 * Lightweight 2D Spatial R-Tree index wrapping `flatbush` with zero-allocation
 * box queries (`queryBoxInto`), empty-dataset safety, and WeakMap array caching.
 */

import Flatbush from 'flatbush';
import { ScratchIndexList } from './BufferPool';

const DEFAULT_BOX_SCRATCH = new Float64Array(4);

/**
 * 2D XZ spatial index backed by Flatbush (Hilbert-packed static R-tree).
 * Safely handles 0-item datasets and performs zero heap allocations during `queryBoxInto`.
 */
export class SpatialIndex2D<T = unknown> {
  private tree: Flatbush | null = null;
  private items: readonly T[] = [];
  private itemCount = 0;
  private readonly queryStack = new ScratchIndexList(64);

  public get length(): number {
    return this.itemCount;
  }

  public clear(): void {
    this.tree = null;
    this.items = [];
    this.itemCount = 0;
  }

  /**
   * Builds the spatial index from a readonly array of items.
   * `writeBounds(item, out4)` must write `[minX, minZ, maxX, maxZ]` into `out4`.
   */
  public build<U extends T = T>(
    items: readonly U[],
    writeBounds: (item: U, out4: Float64Array) => void,
    nodeSize = 16,
  ): void {
    this.items = items;
    this.itemCount = items.length;
    if (items.length === 0) {
      this.tree = null;
      return;
    }

    const tree = new Flatbush(items.length, nodeSize);
    for (let i = 0; i < items.length; i++) {
      writeBounds(items[i], DEFAULT_BOX_SCRATCH);
      tree.add(
        DEFAULT_BOX_SCRATCH[0],
        DEFAULT_BOX_SCRATCH[1],
        DEFAULT_BOX_SCRATCH[2],
        DEFAULT_BOX_SCRATCH[3],
      );
    }
    tree.finish();
    this.tree = tree;
  }

  /**
   * Builds a spatial index for `count` externally stored records via a populate callback.
   * Safely skips Flatbush allocation when `count <= 0`.
   */
  public buildIndexed(
    count: number,
    populate: (tree: Flatbush) => void,
    nodeSize = 16,
  ): void {
    this.items = [];
    this.itemCount = Math.max(0, count | 0);
    if (this.itemCount === 0) {
      this.tree = null;
      return;
    }

    const tree = new Flatbush(this.itemCount, nodeSize);
    populate(tree);
    tree.finish();
    this.tree = tree;
  }

  public getItem(index: number): T {
    return this.items[index];
  }

  /**
   * Queries all indexed item indices intersecting `[minX, minZ, maxX, maxZ]`,
   * writing results directly into `out` with zero heap allocations.
   */
  public queryBoxInto(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    out: ScratchIndexList,
  ): void {
    out.clear();
    const tree = this.tree;
    if (!tree || this.itemCount === 0) return;

    // Fast root bounding-box rejection
    if (
      maxX < tree.minX ||
      minX > tree.maxX ||
      maxZ < tree.minY ||
      minZ > tree.maxY
    ) {
      return;
    }

    const boxes = tree._boxes;
    const levelBounds = tree._levelBounds;
    const indices = tree._indices;
    const nodeSize = tree.nodeSize;
    const numItems4 = tree.numItems * 4;
    const stack = this.queryStack;
    stack.clear();

    let nodeIndex: number = boxes.length - 4;
    let level: number = levelBounds.length - 1;
    let contained = false;

    while (true) {
      const end = Math.min(nodeIndex + nodeSize * 4, levelBounds[level]);
      const isNode = nodeIndex >= numItems4;

      if (contained) {
        let pos = nodeIndex;
        for (let l = level; l > 0; l--) {
          pos = indices[pos >> 2];
        }
        const leafEnd = Math.min(
          pos + (end - nodeIndex) * Math.pow(nodeSize, level),
          numItems4,
        );
        for (; pos < leafEnd; pos += 4) {
          out.push(indices[pos >> 2] | 0);
        }
      } else {
        for (let pos = nodeIndex; pos < end; pos += 4) {
          const x0 = boxes[pos];
          if (maxX < x0) continue;
          const y0 = boxes[pos + 1];
          if (maxZ < y0) continue;
          const x1 = boxes[pos + 2];
          if (minX > x1) continue;
          const y1 = boxes[pos + 3];
          if (minZ > y1) continue;

          const idx = indices[pos >> 2] | 0;
          if (isNode) {
            const c = +(minX <= x0 && minZ <= y0 && maxX >= x1 && maxZ >= y1);
            stack.push(idx | c);
            stack.push(level - 1);
          } else {
            out.push(idx);
          }
        }
      }

      if (stack.length < 2) break;
      level = stack.data[--stack.length];
      const packed = stack.data[--stack.length];
      contained = (packed & 1) === 1;
      nodeIndex = packed & ~1;
    }
  }
}

/**
 * Sorts a small ScratchIndexList in-place ascending so spatial query hits match
 * linear iteration order deterministically when resolving simultaneous overlaps.
 */
export function sortScratchIndicesAscending(list: ScratchIndexList): void {
  const n = list.length;
  if (n <= 1) return;
  const d = list.data;
  for (let i = 1; i < n; i++) {
    const key = d[i];
    let j = i - 1;
    while (j >= 0 && d[j] > key) {
      d[j + 1] = d[j];
      j--;
    }
    d[j + 1] = key;
  }
}
