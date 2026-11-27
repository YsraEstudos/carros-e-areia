/**
 * AppRuntimeMode.ts
 * Pure, engine-agnostic helpers for:
 *  - Standalone / installed PWA detection & maximum-performance runtime configuration
 *  - Synchronized fast-boot progress tracking across asset download, GLTF decode, and GPU scene readiness
 */

import {
  DEFAULT_RUNTIME_CONFIG,
  getInitialGraphicsQuality,
  SandRuntimeConfig,
} from './SandParams';

export interface StandaloneEnvSnapshot {
  displayModeStandalone: boolean;
  navigatorStandalone: boolean;
  locationSearch: string;
}

export function detectStandaloneAppMode(env: StandaloneEnvSnapshot): boolean {
  if (env.displayModeStandalone || env.navigatorStandalone) {
    return true;
  }
  const search = env.locationSearch || '';
  if (!search) return false;
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
    const launch = params.get('launch');
    const standalone = params.get('standalone');
    return launch === 'standalone' || launch === 'app' || standalone === '1' || standalone === 'true';
  } catch {
    return false;
  }
}

export interface MaxPerfConfigInput {
  isMobileDevice: boolean;
  isStandaloneApp: boolean;
}

/**
 * Resolves startup configuration:
 *  - Desktop PCs always start on 'ultra'
 *  - Installed/standalone launches unlock maximum GPU throughput (`graphicsQuality: 'ultra'`
 *    and `fpsUncapped: true`, guarded by WebGL2 fenceSync + FramePacingGovernor)
 */
export function buildInitialRuntimeConfig(input: MaxPerfConfigInput): SandRuntimeConfig {
  if (input.isStandaloneApp) {
    return {
      ...DEFAULT_RUNTIME_CONFIG,
      graphicsQuality: 'ultra',
      fpsUncapped: true,
    };
  }
  return {
    ...DEFAULT_RUNTIME_CONFIG,
    graphicsQuality: getInitialGraphicsQuality(input.isMobileDevice),
    fpsUncapped: false,
  };
}

/**
 * Returns a maximum-performance patch for user-triggered "Máx. Performance" boosts.
 */
export function getMaxPerformanceConfigPatch(): Partial<SandRuntimeConfig> {
  return {
    graphicsQuality: 'ultra',
    fpsUncapped: true,
  };
}

export type BootStageId = 'downloading' | 'parsing' | 'compiling' | 'ready' | 'error';

export interface BootProgressState {
  stage: BootStageId;
  progressPct: number;
  label: string;
  loadedBytes: number;
  totalBytes: number;
  sceneReady: boolean;
  vehicleReady: boolean;
  isComplete: boolean;
  errorMessage: string | null;
}

const STAGE_LABELS: Record<BootStageId, string> = {
  downloading: 'Baixando modelo 3D e texturas...',
  parsing: 'Montando chassi Rivian R1T e suspensão...',
  compiling: 'Sincronizando cenário, sombras e reflexos...',
  ready: 'Simulador pronto',
  error: 'Falha ao carregar veículo',
};

export interface BootProgressSnapshotInput {
  downloadRatio: number;
  loadedBytes: number;
  totalBytes: number;
  parseCompleted: boolean;
  sceneReady: boolean;
  vehicleReady: boolean;
  errorMessage?: string | null;
}

/**
 * Computes deterministic 0..100 synchronized boot progress.
 * Guarantees `isComplete === true` ONLY when both the 3D scene AND the Rivian R1T
 * vehicle are 100% mounted and compiled together.
 */
export function computeUnifiedBootProgress(
  input: BootProgressSnapshotInput,
): BootProgressState {
  if (input.errorMessage) {
    return {
      stage: 'error',
      progressPct: 100,
      label: STAGE_LABELS.error,
      loadedBytes: Math.max(0, input.loadedBytes),
      totalBytes: Math.max(0, input.totalBytes),
      sceneReady: input.sceneReady,
      vehicleReady: input.vehicleReady,
      isComplete: false,
      errorMessage: input.errorMessage,
    };
  }

  const clampedDownload = Math.max(0, Math.min(1, Number.isFinite(input.downloadRatio) ? input.downloadRatio : 0));
  const isComplete = Boolean(input.sceneReady && input.vehicleReady);

  let stage: BootStageId;
  if (isComplete) {
    stage = 'ready';
  } else if (input.parseCompleted) {
    stage = 'compiling';
  } else if (clampedDownload >= 0.999) {
    stage = 'parsing';
  } else {
    stage = 'downloading';
  }

  // Weighted synchronized pipeline:
  // 55% network stream + 25% GLTF/Meshopt decode + 20% scene/shader sync
  const rawPct =
    clampedDownload * 55 +
    (input.parseCompleted ? 25 : clampedDownload >= 0.999 ? 8 : 0) +
    (input.sceneReady ? 10 : 0) +
    (input.vehicleReady ? 10 : 0);

  const progressPct = isComplete
    ? 100
    : Math.max(4, Math.min(99, Math.round(rawPct)));

  return {
    stage,
    progressPct,
    label: STAGE_LABELS[stage],
    loadedBytes: Math.max(0, Math.round(input.loadedBytes)),
    totalBytes: Math.max(0, Math.round(input.totalBytes)),
    sceneReady: input.sceneReady,
    vehicleReady: input.vehicleReady,
    isComplete,
    errorMessage: null,
  };
}
