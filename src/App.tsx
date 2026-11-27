/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  detectIsMobileDevice,
  SandRuntimeConfig,
} from './sand-engine/core/SandParams';
import {
  BootProgressState,
  buildInitialRuntimeConfig,
  computeUnifiedBootProgress,
  detectStandaloneAppMode,
  getMaxPerformanceConfigPatch,
} from './sand-engine/core/AppRuntimeMode';
import {
  SandEngineTelemetry,
  WebSandAdapter,
} from './sand-engine/adapters/WebSandAdapter';
import { VirtualControlFlags } from './sand-engine/core/VehicleDriveModel';
import { ControlDock } from './components/ControlDock';
import { PerformanceVisor } from './components/PerformanceVisor';
import { RoadmapViewer } from './components/RoadmapViewer';
import { OfflineIndicator } from './components/PWAInstallButton';

type AppViewMode = 'roadmap' | 'sim';

interface VisorPrefs {
  open: boolean;
  showOnePercentLow: boolean;
  showGpu: boolean;
  showCpu: boolean;
}

const VISOR_STORAGE_KEY = 'duneflow.perfVisor.v1';

function loadVisorPrefs(): VisorPrefs {
  const fallback: VisorPrefs = {
    open: false,
    showOnePercentLow: false,
    showGpu: false,
    showCpu: false,
  };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(VISOR_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<VisorPrefs>;
    return {
      open: Boolean(parsed.open),
      showOnePercentLow: Boolean(parsed.showOnePercentLow),
      showGpu: Boolean(parsed.showGpu),
      showCpu: Boolean(parsed.showCpu),
    };
  } catch {
    return fallback;
  }
}

function getInitialViewMode(): AppViewMode {
  if (typeof window === 'undefined') return 'sim';
  const params = new URLSearchParams(window.location.search);
  if (params.get('view') === 'roadmap') {
    return 'roadmap';
  }
  return 'sim';
}

function detectMobileLayout(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.innerWidth < 768) return true;
  // Phones rotated to landscape have width > 768px (e.g. 844-932px) but short height + coarse touch pointer
  const isCoarseTouch =
    window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  return isCoarseTouch && window.innerHeight <= 540;
}

function detectMobileHardware(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const isCoarseTouch = Boolean(window.matchMedia?.('(pointer: coarse)').matches);
  return detectIsMobileDevice(
    navigator.userAgent || '',
    navigator.maxTouchPoints || 0,
    isCoarseTouch,
  );
}

function detectStandaloneEnv(): boolean {
  if (typeof window === 'undefined') return false;
  return detectStandaloneAppMode({
    displayModeStandalone: Boolean(window.matchMedia?.('(display-mode: standalone)').matches),
    navigatorStandalone:
      (window.navigator as unknown as { standalone?: boolean }).standalone === true,
    locationSearch: window.location.search,
  });
}

const INITIAL_BOOT_STATE: BootProgressState = computeUnifiedBootProgress({
  downloadRatio: 0,
  loadedBytes: 0,
  totalBytes: 8_560_000,
  parseCompleted: false,
  sceneReady: false,
  vehicleReady: false,
});

export default function App() {
  const [appView, setAppView] = useState<AppViewMode>(() => getInitialViewMode());
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<WebSandAdapter | null>(null);

  const [isStandaloneApp] = useState<boolean>(() => detectStandaloneEnv());
  const initialConfigRef = useRef<SandRuntimeConfig>(
    buildInitialRuntimeConfig({
      isMobileDevice: detectMobileHardware(),
      isStandaloneApp: detectStandaloneEnv(),
    }),
  );

  const [config, setConfig] = useState<SandRuntimeConfig>(() => initialConfigRef.current);
  const [telemetry, setTelemetry] = useState<SandEngineTelemetry | null>(null);
  const [bootProgress, setBootProgress] = useState<BootProgressState>(INITIAL_BOOT_STATE);
  const [isMobileLayout, setIsMobileLayout] = useState<boolean>(() => detectMobileLayout());
  const [dockOpen, setDockOpen] = useState<boolean>(() => !detectMobileLayout());
  const [visorPrefs, setVisorPrefs] = useState<VisorPrefs>(() => loadVisorPrefs());
  const [webglError, setWebglError] = useState<string | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(VISOR_STORAGE_KEY, JSON.stringify(visorPrefs));
    } catch {
      // Ignore storage quota / private mode failures
    }
  }, [visorPrefs]);

  // Track portrait <-> landscape orientation & resize cleanly on phones/tablets
  useEffect(() => {
    const updateLayout = () => {
      const mobile = detectMobileLayout();
      setIsMobileLayout((prev) => {
        if (prev !== mobile && mobile) {
          setDockOpen(false);
        }
        return mobile;
      });
    };
    window.addEventListener('resize', updateLayout);
    window.addEventListener('orientationchange', updateLayout);
    return () => {
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('orientationchange', updateLayout);
    };
  }, []);

  // Suppress Edge/Chrome Android long-press modals only while 3D simulator is active
  useEffect(() => {
    if (appView !== 'sim') return;

    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);

    const preventContextMenu = (e: MouseEvent) => {
      if (!isEditable(e.target)) {
        e.preventDefault();
      }
    };
    const preventSelectStart = (e: Event) => {
      if (!isEditable(e.target)) {
        e.preventDefault();
      }
    };
    const preventDragStart = (e: DragEvent) => {
      if (!isEditable(e.target)) {
        e.preventDefault();
      }
    };
    const preventGesture = (e: Event) => {
      e.preventDefault();
    };

    window.addEventListener('contextmenu', preventContextMenu, { capture: true });
    document.addEventListener('selectstart', preventSelectStart, { capture: true });
    window.addEventListener('dragstart', preventDragStart, { capture: true });
    window.addEventListener('gesturestart', preventGesture, { passive: false } as AddEventListenerOptions);
    return () => {
      window.removeEventListener('contextmenu', preventContextMenu, { capture: true });
      document.removeEventListener('selectstart', preventSelectStart, { capture: true });
      window.removeEventListener('dragstart', preventDragStart, { capture: true });
      window.removeEventListener('gesturestart', preventGesture);
    };
  }, [appView]);

  // Mount WebGL2 WebSandAdapter only when Simulator view is active
  useEffect(() => {
    if (appView !== 'sim') return;
    const el = canvasMountRef.current;
    if (!el) return;

    setBootProgress(INITIAL_BOOT_STATE);
    let adapter: WebSandAdapter | null = null;
    try {
      adapter = new WebSandAdapter(el, initialConfigRef.current, {
        onTelemetry: (snap) => {
          setTelemetry(snap);
        },
        onBootProgress: (progress) => {
          setBootProgress(progress);
        },
        onManualOverride: () => {
          setConfig((prev) =>
            prev.stressMode === 'manual' ? prev : { ...prev, stressMode: 'manual' },
          );
        },
        onCameraCycle: (nextCam) => {
          setConfig((prev) =>
            prev.cameraMode === nextCam ? prev : { ...prev, cameraMode: nextCam },
          );
        },
        onConfigSync: (patch) => {
          setConfig((prev) => {
            let changed = false;
            for (const key of Object.keys(patch) as Array<keyof SandRuntimeConfig>) {
              if (prev[key] !== patch[key]) {
                changed = true;
                break;
              }
            }
            return changed ? { ...prev, ...patch } : prev;
          });
        },
      });
      adapterRef.current = adapter;
    } catch (err) {
      setWebglError(
        err instanceof Error
          ? err.message
          : 'WebGL2 não pôde ser inicializado neste navegador.',
      );
    }

    return () => {
      adapter?.dispose();
      adapterRef.current = null;
    };
  }, [appView]);

  // Keyboard shortcuts for simulator mode
  useEffect(() => {
    if (appView !== 'sim') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.code === 'KeyH' && !e.repeat) {
        setDockOpen((open) => !open);
      } else if (e.code === 'KeyP' && !e.repeat) {
        setVisorPrefs((prev) => ({ ...prev, open: !prev.open }));
      } else if (e.code === 'KeyL' && !e.repeat) {
        setConfig((prev) => {
          const nextMode = prev.driveMode === '4H' ? '4L' : '4H';
          adapterRef.current?.setConfig({ driveMode: nextMode });
          return { ...prev, driveMode: nextMode };
        });
      } else if (e.code === 'KeyM' && !e.repeat) {
        setConfig((prev) => {
          const nextAudio = !prev.audioEnabled;
          adapterRef.current?.setConfig({ audioEnabled: nextAudio });
          return { ...prev, audioEnabled: nextAudio };
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appView]);

  const handleChangeConfig = useCallback((patch: Partial<SandRuntimeConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      initialConfigRef.current = next;
      adapterRef.current?.setConfig(patch);
      return next;
    });
  }, []);

  const handleActivateMaxPerformance = useCallback(() => {
    const patch = getMaxPerformanceConfigPatch();
    handleChangeConfig(patch);
  }, [handleChangeConfig]);

  const handleTeleport500m = useCallback(() => {
    adapterRef.current?.teleport500m();
  }, []);

  const handleClearSand = useCallback(() => {
    adapterRef.current?.clearSand();
  }, []);

  const handleRightVehicle = useCallback(() => {
    adapterRef.current?.rightVehicle();
  }, []);

  const handleResetVehicle = useCallback(() => {
    adapterRef.current?.resetVehicle();
  }, []);

  const handleGoToRockTrail = useCallback(() => {
    setConfig((prev) => ({
      ...prev,
      biome: 'desert',
      stressMode: 'manual',
      driveMode: '4L',
    }));
    adapterRef.current?.goToRockTrail();
  }, []);

  const handleCycleCamera = useCallback(() => {
    adapterRef.current?.cycleCamera();
  }, []);

  const handleVirtualControl = useCallback((patch: Partial<VirtualControlFlags>) => {
    adapterRef.current?.setVirtualControl(patch);
  }, []);

  const handleToggleDock = useCallback(() => {
    setDockOpen((o) => !o);
  }, []);

  const handleToggleVisor = useCallback(() => {
    setVisorPrefs((prev) => ({ ...prev, open: !prev.open }));
  }, []);

  const handleCloseVisor = useCallback(() => {
    setVisorPrefs((prev) => ({ ...prev, open: false }));
  }, []);

  const handleToggleOnePercentLow = useCallback(() => {
    setVisorPrefs((prev) => ({ ...prev, showOnePercentLow: !prev.showOnePercentLow }));
  }, []);

  const handleToggleGpu = useCallback(() => {
    setVisorPrefs((prev) => ({ ...prev, showGpu: !prev.showGpu }));
  }, []);

  const handleToggleCpu = useCallback(() => {
    setVisorPrefs((prev) => ({ ...prev, showCpu: !prev.showCpu }));
  }, []);

  const handleToggleFpsUncapped = useCallback(() => {
    setConfig((prev) => {
      const nextUncapped = !prev.fpsUncapped;
      initialConfigRef.current = { ...prev, fpsUncapped: nextUncapped };
      adapterRef.current?.setConfig({ fpsUncapped: nextUncapped });
      return { ...prev, fpsUncapped: nextUncapped };
    });
  }, []);

  const handleOpenRoadmap = useCallback(() => {
    setAppView('roadmap');
  }, []);

  const handleOpenSimulator = useCallback(() => {
    setAppView('sim');
  }, []);

  if (appView === 'roadmap') {
    return <RoadmapViewer onOpenSimulator={handleOpenSimulator} />;
  }

  const loadedMb = (bootProgress.loadedBytes / (1024 * 1024)).toFixed(1);
  const totalMb = (Math.max(bootProgress.totalBytes, bootProgress.loadedBytes) / (1024 * 1024)).toFixed(1);

  return (
    <main
      data-testid="sand-engine-root"
      className="sim-viewport-lock relative h-[100dvh] w-screen overflow-hidden bg-[#12100e] select-none"
      onContextMenu={(e) => e.preventDefault()}
      data-biome={config.biome}
      data-graphics-quality={config.graphicsQuality}
      data-weather-preset={config.weatherPreset}
      data-tone-map={config.toneMappingMode}
      data-stress-mode={config.stressMode}
      data-debug-view={config.debugView}
      data-camera-mode={config.cameraMode}
      data-drive-mode={config.driveMode}
      data-tire-psi={config.tirePressurePsi}
      data-audio-enabled={config.audioEnabled ? 'on' : 'off'}
      data-gear={telemetry?.vehicle.gear ?? 'N'}
      data-speed-kmh={telemetry ? Math.round(telemetry.vehicle.speedKmh) : 0}
      data-integrity-pct={telemetry?.vehicle.integrityPct ?? 100}
      data-rolled-over={telemetry?.vehicle.isRolledOver ? 'true' : 'false'}
      data-roll-deg={telemetry ? Math.round(telemetry.vehicle.rollDeg) : 0}
      data-detached-count={telemetry?.vehicle.detachedCount ?? 0}
      data-fps-uncapped={config.fpsUncapped ? 'true' : 'false'}
      data-visor-open={visorPrefs.open ? 'true' : 'false'}
      data-vehicle-ready={bootProgress.isComplete ? 'true' : 'false'}
      data-standalone-mode={isStandaloneApp ? 'true' : 'false'}
    >
      {/* Dedicated isolated WebGL canvas container */}
      <div
        ref={canvasMountRef}
        data-testid="sand-webgl-viewport"
        className="touch-control h-full w-full"
      />

      {/* Synchronized Fast-Boot Loading Gate: keeps world & Rivian R1T synced until frame 1 is compiled */}
      {!bootProgress.isComplete && !webglError && (
        <div
          data-testid="fast-boot-overlay"
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-30 flex items-center justify-center bg-[#0c0a08] p-6"
        >
          <div className="w-full max-w-sm rounded-2xl border border-[#f5efe6]/14 bg-[#14110e] p-6 shadow-2xl">
            <div className="flex items-baseline justify-between gap-2">
              <h2
                className="text-lg font-semibold tracking-tight text-[#f8f3eb]"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                DuneFlow
              </h2>
              <span className="font-mono text-xs font-semibold tabular-nums text-[#e89b3c]">
                {bootProgress.progressPct}%
              </span>
            </div>

            <p className="mt-2 text-xs text-[#cbbca8]">{bootProgress.label}</p>

            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[#241e18]">
              <div
                className="h-full rounded-full bg-[#e89b3c] transition-[width] duration-150 ease-out"
                style={{ width: `${bootProgress.progressPct}%` }}
              />
            </div>

            <div className="mt-2.5 flex items-center justify-between font-mono text-[11px] tabular-nums text-[#9e8e7a]">
              <span>Rivian R1T + Cenário</span>
              <span>
                {loadedMb} / {totalMb} MB
              </span>
            </div>

            {bootProgress.errorMessage && (
              <div className="mt-3 rounded-lg border border-[#e0523c]/50 bg-[#2a1512] p-2.5 text-xs text-[#ffd7cf]">
                {bootProgress.errorMessage}
              </div>
            )}
          </div>
        </div>
      )}

      {webglError && (
        <div
          role="alert"
          className="fixed inset-0 z-30 flex items-center justify-center bg-[#14110e] p-6 text-center"
        >
          <div className="max-w-md rounded-xl border border-[#f5efe6]/14 bg-[#1c1713] p-6">
            <h2 className="text-base font-semibold text-[#f8f3eb]">
              Contexto WebGL2 indisponível
            </h2>
            <p className="mt-2 text-sm text-[#c7b9a5]">{webglError}</p>
          </div>
        </div>
      )}

      <PerformanceVisor
        visible={visorPrefs.open}
        telemetry={telemetry}
        fpsUncapped={config.fpsUncapped}
        isMobileLayout={isMobileLayout}
        showOnePercentLow={visorPrefs.showOnePercentLow}
        showGpu={visorPrefs.showGpu}
        showCpu={visorPrefs.showCpu}
        onClose={handleCloseVisor}
        onToggleOnePercentLow={handleToggleOnePercentLow}
        onToggleGpu={handleToggleGpu}
        onToggleCpu={handleToggleCpu}
        onToggleFpsUncapped={handleToggleFpsUncapped}
      />

      <ControlDock
        config={config}
        telemetry={telemetry}
        dockOpen={dockOpen}
        visorOpen={visorPrefs.open}
        isMobileLayout={isMobileLayout}
        onToggleDock={handleToggleDock}
        onToggleVisor={handleToggleVisor}
        onChangeConfig={handleChangeConfig}
        onTeleport500m={handleTeleport500m}
        onClearSand={handleClearSand}
        onRightVehicle={handleRightVehicle}
        onResetVehicle={handleResetVehicle}
        onGoToRockTrail={handleGoToRockTrail}
        onCycleCamera={handleCycleCamera}
        onVirtualControl={handleVirtualControl}
        onOpenRoadmap={handleOpenRoadmap}
        onActivateMaxPerformance={handleActivateMaxPerformance}
      />

      <OfflineIndicator />
    </main>
  );
}
