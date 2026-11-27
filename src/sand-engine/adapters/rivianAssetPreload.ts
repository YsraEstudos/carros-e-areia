/**
 * rivianAssetPreload.ts
 * High-priority asset preloader imported as LINE 1 of `src/main.tsx`.
 *  - Fetches `Rivian_R1T_2022_compact.glb` at high priority while streaming exact byte progress
 *  - Warms WASM `MeshoptDecoder` AND runs early `GLTFLoader.parse()` at t = 0ms in parallel
 *    with React + WebGL2 + Terrain/Atmosphere setup so the car and scenery appear together!
 */

import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import rivianGlbUrl from '../../assets/Rivian_R1T_2022_compact.glb?url';

export interface RivianPreloadProgress {
  loadedBytes: number;
  totalBytes: number;
  downloadRatio: number;
  parseCompleted: boolean;
  errorMessage: string | null;
}

const DEFAULT_ESTIMATED_GLB_BYTES = 8_560_000;

let prefetchedRivianBufferPromise: Promise<ArrayBuffer> | null = null;
let meshoptReadyPromise: Promise<void> | null = null;
let earlyParsedGltfPromise: Promise<GLTF> | null = null;
let earlyGltfConsumed = false;

const snapshot: RivianPreloadProgress = {
  loadedBytes: 0,
  totalBytes: DEFAULT_ESTIMATED_GLB_BYTES,
  downloadRatio: 0,
  parseCompleted: false,
  errorMessage: null,
};

const listeners = new Set<(progress: RivianPreloadProgress) => void>();

function notifyListeners(): void {
  const copy: RivianPreloadProgress = { ...snapshot };
  for (const cb of listeners) {
    cb(copy);
  }
}

export function getRivianLoadSnapshot(): RivianPreloadProgress {
  return { ...snapshot };
}

export function subscribeRivianLoadProgress(
  listener: (progress: RivianPreloadProgress) => void,
): () => void {
  listeners.add(listener);
  listener({ ...snapshot });
  return () => {
    listeners.delete(listener);
  };
}

export function getMeshoptReadyPromise(): Promise<void> {
  if (!meshoptReadyPromise) {
    meshoptReadyPromise = Promise.resolve(MeshoptDecoder.ready).then(() => undefined);
  }
  return meshoptReadyPromise;
}

function parseBufferWithMeshopt(buffer: ArrayBuffer): Promise<GLTF> {
  return getMeshoptReadyPromise().then(
    () =>
      new Promise<GLTF>((resolve, reject) => {
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        loader.parse(
          buffer,
          '',
          (gltf) => resolve(gltf),
          (err) => reject(err instanceof Error ? err : new Error(String(err))),
        );
      }),
  );
}

export function preloadRivianGlb(): Promise<ArrayBuffer> {
  void getMeshoptReadyPromise();
  if (!prefetchedRivianBufferPromise) {
    snapshot.errorMessage = null;
    prefetchedRivianBufferPromise = fetch(rivianGlbUrl, {
      priority: 'high',
    } as RequestInit)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Falha ao baixar modelo 3D (HTTP ${res.status})`);
        }
        const contentLenHeader = res.headers.get('content-length');
        const parsedLen = contentLenHeader ? Number.parseInt(contentLenHeader, 10) : 0;
        const totalBytes =
          Number.isFinite(parsedLen) && parsedLen > 0 ? parsedLen : DEFAULT_ESTIMATED_GLB_BYTES;
        snapshot.totalBytes = totalBytes;

        if (!res.body) {
          const buf = await res.arrayBuffer();
          snapshot.loadedBytes = buf.byteLength;
          snapshot.totalBytes = buf.byteLength;
          snapshot.downloadRatio = 1;
          notifyListeners();
          return buf;
        }

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.byteLength;
            snapshot.loadedBytes = received;
            snapshot.downloadRatio = Math.min(0.99, received / Math.max(received, totalBytes));
            notifyListeners();
          }
        }

        const merged = new Uint8Array(received);
        let offset = 0;
        for (let i = 0; i < chunks.length; i++) {
          merged.set(chunks[i], offset);
          offset += chunks[i].byteLength;
        }

        snapshot.loadedBytes = received;
        snapshot.totalBytes = received;
        snapshot.downloadRatio = 1;
        notifyListeners();
        return merged.buffer;
      })
      .catch((err) => {
        prefetchedRivianBufferPromise = null;
        snapshot.errorMessage =
          err instanceof Error ? err.message : 'Erro ao carregar veículo 3D.';
        notifyListeners();
        throw err;
      });
  }
  return prefetchedRivianBufferPromise;
}

export function preloadRivianGltf(): Promise<GLTF> {
  if (!earlyParsedGltfPromise) {
    earlyParsedGltfPromise = Promise.all([preloadRivianGlb(), getMeshoptReadyPromise()])
      .then(([buffer]) => parseBufferWithMeshopt(buffer))
      .then((gltf) => {
        snapshot.parseCompleted = true;
        notifyListeners();
        return gltf;
      })
      .catch((err) => {
        earlyParsedGltfPromise = null;
        snapshot.errorMessage =
          err instanceof Error ? err.message : 'Erro ao decodificar veículo 3D.';
        notifyListeners();
        throw err;
      });
  }
  return earlyParsedGltfPromise;
}

/**
 * Returns the already-started early GLTF parse on initial mount (zero duplicate work!),
 * or cleanly re-parses the cached ArrayBuffer on subsequent remounts (e.g. StrictMode / Roadmap switch).
 */
export function consumeOrParseRivianGltf(): Promise<GLTF> {
  if (!earlyGltfConsumed) {
    earlyGltfConsumed = true;
    return preloadRivianGltf();
  }
  return preloadRivianGlb().then((buffer) => parseBufferWithMeshopt(buffer));
}

// Kick off network fetch, WASM init, AND early GLTF decode immediately at t = 0ms
if (typeof window !== 'undefined' && typeof fetch === 'function') {
  void preloadRivianGltf();
}
