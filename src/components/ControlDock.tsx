/**
 * ControlDock.tsx
 * Minimal unobtrusive HUD + unified collapsible bottom control dock.
 *
 * Design rules observed:
 *  - Central 3D viewport stays 100% unobstructed (zero side panels)
 *  - No CSS `backdrop-filter` / `backdrop-blur` over active WebGL canvas
 *  - No pulsing dots, no fake version badges, no pill badge sandwiches
 *  - Native accessible `<button>`, `<input type="range">`, and `<label>` controls
 *  - Tabular monospace numerals for live physics/GPU metrics
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Navigation,
  Sliders,
  Eye,
  Gauge,
  Compass,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Flame,
  Camera,
  Video,
  Volume2,
  VolumeX,
  Mountain,
  Map,
  X,
  Activity,
} from 'lucide-react';
import {
  CameraMode,
  DebugViewMode,
  DriveMode,
  EnvironmentBiome,
  GlintQualityMode,
  GraphicsQuality,
  SandRuntimeConfig,
  StressTestMode,
  ToneMappingMode,
  WEATHER_PRESET_SPECS,
  WeatherPreset,
} from '../sand-engine/core/SandParams';
import { VirtualControlFlags } from '../sand-engine/core/VehicleDriveModel';
import { SandEngineTelemetry } from '../sand-engine/adapters/WebSandAdapter';
import { MobileDrivePad } from './MobileDrivePad';
import { PWAInstallButton } from './PWAInstallButton';

type DockTab = 'tests' | 'physics' | 'shading' | 'budget';

interface ControlDockProps {
  config: SandRuntimeConfig;
  telemetry: SandEngineTelemetry | null;
  dockOpen: boolean;
  visorOpen: boolean;
  isMobileLayout: boolean;
  onToggleDock: () => void;
  onToggleVisor: () => void;
  onChangeConfig: (patch: Partial<SandRuntimeConfig>) => void;
  onTeleport500m: () => void;
  onClearSand: () => void;
  onRightVehicle: () => void;
  onResetVehicle: () => void;
  onGoToRockTrail: () => void;
  onCycleCamera: () => void;
  onVirtualControl: (patch: Partial<VirtualControlFlags>) => void;
  onOpenRoadmap?: () => void;
  onActivateMaxPerformance?: () => void;
}

const STRESS_PRESETS: Array<{ id: StressTestMode; label: string; hint: string }> = [
  { id: 'manual', label: 'Dirigir', hint: 'Controle total: W/S acelera e ré, A/D esterça, Espaço drift, Shift turbo' },
  { id: 'rollover_crash', label: 'Capotagem', hint: 'Curva brusca em alta velocidade com capotamento, amassados e peças soltas' },
  { id: 'donuts', label: 'Donuts', hint: 'Cruza o próprio rastro continuamente (Marco 2)' },
  { id: 'sprint_150', label: 'Sprint 150', hint: 'Alta velocidade + limpeza toroidal (Marco 1)' },
  { id: 'foot_ik_walk', label: 'Foot IK', hint: 'Sola aterrada na pegada 2–6 cm (Marco 5)' },
  { id: 'avalanche_park', label: 'Avalanche', hint: 'Estacionado: desmoronamento -> 0,0 ms (Marco 3)' },
];

const CAMERA_MODES: Array<{ id: CameraMode; label: string }> = [
  { id: 'chase', label: 'Chase' },
  { id: 'cockpit', label: 'Cockpit 1ª Pessoa' },
  { id: 'fender', label: 'Capô / Roda' },
  { id: 'gopro_rear', label: 'GoPro Roda' },
  { id: 'orbit', label: 'Órbita' },
  { id: 'wheel_closeup', label: 'Close-up Roda' },
  { id: 'foot_ik', label: 'Close-up Foot IK' },
];

const DRIVE_MODES: Array<{ id: DriveMode; label: string; title: string }> = [
  { id: '4H', label: '4H', title: 'Tração 4x4 Alta — velocidade e drift nas dunas (L)' },
  { id: '4L', label: '4L', title: 'Reduzida 4x4 com bloqueio — +48% torque em areia fofa e subidas (L)' },
];

const DEBUG_VIEWS: Array<{ id: DebugViewMode; label: string }> = [
  { id: 'beauty', label: 'Beauty EON' },
  { id: 'toroidal_rgba', label: 'Toroidal RGBA' },
  { id: 'normals_rnm', label: 'Normais RNM' },
  { id: 'wireframe_clipmap', label: 'Clipmap CDLOD' },
];

const BIOMES: Array<{ id: EnvironmentBiome; label: string }> = [
  { id: 'rainy_highway', label: 'Estrada Chuvosa' },
  { id: 'desert', label: 'Deserto' },
  { id: 'mud_grass', label: 'Lama & Grama' },
];

const GRAPHICS_QUALITIES: Array<{ id: GraphicsQuality; label: string; title: string }> = [
  { id: 'low', label: 'Leve', title: 'PMREM atmosférico leve sem pós-processamento HDR' },
  { id: 'hybrid', label: 'Híbrido 60fps', title: 'CubeCamera 128² + Retrovisores reais + GTAO + Sombras de contato' },
  { id: 'ultra', label: 'Ultra', title: 'CubeCamera 256² + Retrovisores duplos HD + GTAO denso + Bloom HDR' },
];

const WEATHER_PRESETS: Array<{ id: WeatherPreset; label: string }> = [
  { id: 'rainy_mist', label: 'Chuva Matinal' },
  { id: 'golden_hour', label: 'Golden Hour' },
  { id: 'desert_noon', label: 'Meio-Dia' },
  { id: 'sunset_blaze', label: 'Crepúsculo' },
  { id: 'humid_overcast', label: 'Nublado' },
];

const TONE_MAPPERS: Array<{ id: ToneMappingMode; label: string }> = [
  { id: 'agx', label: 'AgX' },
  { id: 'aces', label: 'ACES' },
];

export const ControlDock: React.FC<ControlDockProps> = React.memo(({
  config,
  telemetry,
  dockOpen,
  visorOpen,
  isMobileLayout,
  onToggleDock,
  onToggleVisor,
  onChangeConfig,
  onTeleport500m,
  onClearSand,
  onRightVehicle,
  onResetVehicle,
  onGoToRockTrail,
  onCycleCamera,
  onVirtualControl,
  onOpenRoadmap,
  onActivateMaxPerformance,
}) => {
  const [activeTab, setActiveTab] = useState<DockTab>('tests');
  const holdStripRef = useRef<HTMLDivElement | null>(null);

  const handleToggleDriveMode = useCallback(() => {
    onChangeConfig({ driveMode: config.driveMode === '4H' ? '4L' : '4H' });
  }, [config.driveMode, onChangeConfig]);

  const handleToggleTirePsi = useCallback(() => {
    onChangeConfig({ tirePressurePsi: config.tirePressurePsi <= 18 ? 32 : 12 });
  }, [config.tirePressurePsi, onChangeConfig]);

  // Non-passive touchstart/touchmove guard on tablet/desktop hold-to-drive strip (f0-4-2)
  useEffect(() => {
    const strip = holdStripRef.current;
    if (!strip) return;
    const blockBrowserGesture = (e: Event) => {
      e.preventDefault();
    };
    strip.addEventListener('touchstart', blockBrowserGesture, { passive: false });
    strip.addEventListener('touchmove', blockBrowserGesture, { passive: false });
    strip.addEventListener('contextmenu', blockBrowserGesture, { passive: false });
    strip.addEventListener('selectstart', blockBrowserGesture);
    return () => {
      strip.removeEventListener('touchstart', blockBrowserGesture);
      strip.removeEventListener('touchmove', blockBrowserGesture);
      strip.removeEventListener('contextmenu', blockBrowserGesture);
      strip.removeEventListener('selectstart', blockBrowserGesture);
    };
  }, [dockOpen, activeTab, isMobileLayout]);

  const speedKmh = telemetry ? Math.round(telemetry.vehicle.speedKmh) : 0;
  const gear = telemetry ? telemetry.vehicle.gear : 'N';
  const boostActive = Boolean(telemetry?.vehicle.boostActive);
  const sinkCm = telemetry ? telemetry.vehicle.avgSinkageCm.toFixed(1) : '3.0';
  const integrityPct = telemetry ? telemetry.vehicle.integrityPct : 100;
  const isRolledOver = Boolean(telemetry?.vehicle.isRolledOver);
  const integrityColor =
    integrityPct >= 85
      ? 'text-[#f8f3eb]'
      : integrityPct >= 50
        ? 'text-[#e89b3c]'
        : 'text-[#e0523c]';
  const simSleeping = Boolean(
    telemetry && telemetry.cascade0Sleeping && telemetry.cascade1Sleeping,
  );
  const cascadeRes = telemetry?.cascadeResolution ?? (isMobileLayout ? 512 : 1024);
  const ringCapacity = telemetry?.ringBufferCapacity ?? 512;
  const gpuTimerAvailable = Boolean(telemetry?.gpuQuerySupported);
  const activeInput = telemetry?.activeInput;

  const holdFlag = (flag: keyof Omit<VirtualControlFlags, 'analogSteer'>) => ({
    draggable: false,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    },
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Safe fallback on mobile browsers
      }
      onVirtualControl({ [flag]: true });
    },
    onPointerUp: () => onVirtualControl({ [flag]: false }),
    onPointerCancel: () => onVirtualControl({ [flag]: false }),
    onLostPointerCapture: () => onVirtualControl({ [flag]: false }),
  });

  return (
    <>
      {/* Top Bar: Compact Single-Row Mobile HUD (Portrait + Landscape) & Two-Corner Desktop HUD */}
      <header
        className="pointer-events-none fixed inset-x-0 top-0 z-20 flex items-start justify-between gap-2"
        style={{
          paddingTop: 'max(0.65rem, env(safe-area-inset-top))',
          paddingLeft: isMobileLayout
            ? 'max(0.75rem, env(safe-area-inset-left))'
            : '1.25rem',
          paddingRight: isMobileLayout
            ? 'max(0.75rem, env(safe-area-inset-right))'
            : '1.25rem',
        }}
      >
        {/* Mobile Compact Telemetry Strip (portrait & landscape phones) */}
        {isMobileLayout && (
          <div className="touch-tap pointer-events-auto flex w-full items-center justify-between gap-1">
            <div className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[#f5efe6]/14 bg-[#14110e]/94 px-2 py-1 shadow-lg">
              <h1
                className="hidden text-xs font-semibold tracking-tight text-[#f8f3eb] whitespace-nowrap min-[480px]:inline"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                DuneFlow
              </h1>
              <div className="hidden h-3.5 w-px shrink-0 bg-[#f5efe6]/14 min-[480px]:block" aria-hidden="true" />
              <div
                className="flex items-baseline gap-1 font-mono text-[11px] tabular-nums whitespace-nowrap"
                aria-label="Telemetria móvel do veículo"
              >
                <span className={`font-semibold ${boostActive ? 'text-[#ff9436]' : 'text-[#f8f3eb]'}`}>
                  {speedKmh}
                  <span className="ml-0.5 text-[9px] font-normal text-[#c7b9a5]">km/h</span>
                </span>
                <span className="text-[#c7b9a5]">M{gear}</span>
                <span className="text-[#e89b3c] hidden min-[420px]:inline">{sinkCm}cm</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <PWAInstallButton
                compact
                onActivateMaxPerformance={onActivateMaxPerformance}
              />
              <button
                type="button"
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                onClick={onToggleVisor}
                aria-pressed={visorOpen}
                data-testid="mobile-visor-toggle"
                aria-label={visorOpen ? 'Ocultar visor FPS' : 'Ativar visor FPS, 1% Low, GPU e CPU'}
                title="Visor de Performance (FPS / 1% Low / GPU / CPU)"
                className={`touch-tap flex h-8 w-[30px] items-center justify-center rounded-xl border shadow-lg transition-colors active:bg-[#2a221c] min-[400px]:w-8 ${
                  visorOpen
                    ? 'border-[#e89b3c] bg-[#2a2117] text-[#f2b25c]'
                    : 'border-[#f5efe6]/14 bg-[#14110e]/94 text-[#e6dac8]'
                }`}
              >
                <Activity className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                onClick={() => onChangeConfig({ audioEnabled: !config.audioEnabled })}
                aria-pressed={config.audioEnabled}
                aria-label={config.audioEnabled ? 'Silenciar áudio (M)' : 'Ativar áudio (M)'}
                className="touch-tap flex h-8 w-[30px] items-center justify-center rounded-xl border border-[#f5efe6]/14 bg-[#14110e]/94 text-[#e6dac8] shadow-lg active:bg-[#2a221c] min-[400px]:w-8"
              >
                {config.audioEnabled ? (
                  <Volume2 className="h-3.5 w-3.5 text-[#e89b3c]" aria-hidden="true" />
                ) : (
                  <VolumeX className="h-3.5 w-3.5 text-[#9e8e7a]" aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                onClick={onCycleCamera}
                aria-label="Trocar câmera"
                className="touch-tap flex h-8 w-[30px] items-center justify-center rounded-xl border border-[#f5efe6]/14 bg-[#14110e]/94 text-[#e6dac8] shadow-lg active:bg-[#2a221c] min-[400px]:w-8"
              >
                <Camera className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              {onOpenRoadmap && (
                <button
                  type="button"
                  draggable={false}
                  onContextMenu={(e) => e.preventDefault()}
                  onClick={onOpenRoadmap}
                  aria-label="Voltar ao Roadmap"
                  className="touch-tap flex h-8 w-[30px] items-center justify-center rounded-xl border border-[#f5efe6]/14 bg-[#14110e]/94 text-[#e6dac8] shadow-lg active:bg-[#2a221c] min-[400px]:w-8"
                >
                  <Map className="h-3.5 w-3.5 text-[#e89b3c]" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                onClick={onResetVehicle}
                aria-label="Reposicionar veículo"
                className="touch-tap flex h-8 w-[30px] items-center justify-center rounded-xl border border-[#f5efe6]/14 bg-[#14110e]/94 text-[#e6dac8] shadow-lg active:bg-[#2a221c] min-[400px]:w-8"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                onClick={onToggleDock}
                aria-expanded={dockOpen}
                aria-label={dockOpen ? 'Fechar painel de ajustes' : 'Abrir painel de ajustes'}
                className={`touch-tap flex h-8 items-center gap-1 rounded-xl border px-2 text-xs font-medium shadow-lg transition-colors whitespace-nowrap ${
                  dockOpen
                    ? 'border-[#e89b3c] bg-[#e89b3c] text-[#17120d]'
                    : 'border-[#f5efe6]/14 bg-[#14110e]/94 text-[#f8f3eb]'
                }`}
              >
                {dockOpen ? (
                  <>
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Fechar</span>
                  </>
                ) : (
                  <>
                    <Sliders className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Ajustes</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Desktop Top-Left Title & Spec Badge */}
        {!isMobileLayout && (
        <div
          data-testid="desktop-brand-badge"
          className="pointer-events-auto rounded-xl border border-[#f5efe6]/12 bg-[#14110e]/90 px-4 py-2.5 shadow-lg"
        >
          <div className="flex items-baseline gap-3">
            <h1
              className="text-base font-semibold tracking-tight text-[#f8f3eb] whitespace-nowrap"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              DuneFlow
            </h1>
            <span className="text-xs text-[#c7b9a5] whitespace-nowrap">
              {config.biome === 'rainy_highway'
                ? 'Estrada Rural Chuvosa · Rivian R1T'
                : config.biome === 'mud_grass'
                  ? 'Lama Rala & Grama Toroidal · Rivian R1T'
                  : 'Areia Deformável Toroidal · Rivian R1T'}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[#a79782] font-mono tabular-nums">
            <span>2× {cascadeRes}² RGBA16F</span>
            <span aria-hidden="true">·</span>
            <span>1 Draw Call Clipmap</span>
            <span aria-hidden="true">·</span>
            <span>
              {simSleeping
                ? 'Sim Sleep 0.00 ms'
                : gpuTimerAvailable && telemetry
                  ? `Sim ${telemetry.gpuSimMs.toFixed(2)} ms`
                  : 'GPU Timer N/D'}
            </span>
          </div>
        </div>
        )}

        {/* Desktop Compact Top-Right Live Readout */}
        {!isMobileLayout && (
        <div
          className="pointer-events-auto flex items-center gap-4 rounded-xl border border-[#f5efe6]/12 bg-[#14110e]/90 px-4 py-2.5 shadow-lg font-mono tabular-nums"
          aria-label="Telemetria de veículo e terramecânica"
        >
          <div>
            <div className="text-[10px] text-[#a79782]">Velocidade</div>
            <div className={`text-sm font-semibold ${boostActive ? 'text-[#ff9436]' : 'text-[#f8f3eb]'}`}>
              {speedKmh} <span className="text-[11px] font-normal text-[#c7b9a5]">km/h</span>
            </div>
          </div>
          <div className="h-6 w-px bg-[#f5efe6]/12" aria-hidden="true" />
          <div>
            <div className="text-[10px] text-[#a79782]">Marcha</div>
            <div className="text-sm font-semibold text-[#f8f3eb]">{gear}</div>
          </div>
          <div className="h-6 w-px bg-[#f5efe6]/12" aria-hidden="true" />
          <div>
            <div className="text-[10px] text-[#a79782]">Afundamento</div>
            <div className="text-sm font-semibold text-[#e89b3c]">
              {sinkCm} <span className="text-[11px] font-normal text-[#c7b9a5]">cm</span>
            </div>
          </div>
          <div className="h-6 w-px bg-[#f5efe6]/12" aria-hidden="true" />
          <div>
            <div className="text-[10px] text-[#a79782]">Pneus / Tração</div>
            <div className="text-sm font-semibold text-[#f8f3eb]">
              {Math.round(config.tirePressurePsi)}{' '}
              <span className="text-[11px] font-normal text-[#c7b9a5]">PSI</span>{' '}
              <span className={config.driveMode === '4L' ? 'text-[#e89b3c]' : 'text-[#c7b9a5]'}>
                {config.driveMode}
              </span>
            </div>
          </div>
          <div className="h-6 w-px bg-[#f5efe6]/12" aria-hidden="true" />
          <div>
            <div className="text-[10px] text-[#a79782]">Estrutura</div>
            <div className={`text-sm font-semibold ${integrityColor}`}>{integrityPct}%</div>
          </div>
          {isRolledOver && (
            <>
              <div className="h-6 w-px bg-[#f5efe6]/12" aria-hidden="true" />
              <button
                type="button"
                onClick={onRightVehicle}
                className="rounded-lg bg-[#e89b3c] px-2.5 py-1.5 font-sans text-xs font-semibold text-[#17120d] transition-colors hover:bg-[#f2a84a] whitespace-nowrap"
                title="Desvirar veículo capotado mantendo os amassados (F)"
              >
                Desvirar (F)
              </button>
            </>
          )}
          <div className="h-6 w-px bg-[#f5efe6]/12" aria-hidden="true" />
          <button
            type="button"
            onClick={onToggleVisor}
            aria-pressed={visorOpen}
            data-testid="desktop-visor-toggle"
            aria-label={visorOpen ? 'Ocultar visor FPS (P)' : 'Ativar visor FPS, 1% Low, GPU e CPU (P)'}
            title="Visor de Performance — FPS, 1% Low, GPU e CPU (P)"
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 font-sans text-xs font-medium transition-colors whitespace-nowrap ${
              visorOpen
                ? 'border-[#e89b3c]/75 bg-[#e89b3c]/20 text-[#f2b25c]'
                : 'border-[#f5efe6]/12 bg-[#1d1814] text-[#e6dac8] hover:bg-[#2a221c]'
            }`}
          >
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
            <span>FPS</span>
          </button>
          <button
            type="button"
            onClick={() => onChangeConfig({ audioEnabled: !config.audioEnabled })}
            aria-pressed={config.audioEnabled}
            aria-label={config.audioEnabled ? 'Silenciar áudio (M)' : 'Ativar áudio (M)'}
            title={config.audioEnabled ? 'Silenciar motor e areia (M)' : 'Ativar áudio procedural (M)'}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#f5efe6]/12 bg-[#1d1814] text-[#e6dac8] transition-colors hover:bg-[#2a221c]"
          >
            {config.audioEnabled ? (
              <Volume2 className="h-4 w-4 text-[#e89b3c]" aria-hidden="true" />
            ) : (
              <VolumeX className="h-4 w-4 text-[#9e8e7a]" aria-hidden="true" />
            )}
          </button>
          <PWAInstallButton onActivateMaxPerformance={onActivateMaxPerformance} />
          {onOpenRoadmap && (
            <>
              <div className="h-6 w-px bg-[#f5efe6]/12" aria-hidden="true" />
              <button
                type="button"
                onClick={onOpenRoadmap}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#f5efe6]/14 bg-[#1d1814] px-2.5 py-1.5 font-sans text-xs font-medium text-[#f8f3eb] transition-colors hover:bg-[#2a221c] whitespace-nowrap"
              >
                <Map className="h-3.5 w-3.5 text-[#e89b3c]" aria-hidden="true" />
                <span>Roadmap</span>
              </button>
            </>
          )}
        </div>
        )}
      </header>

      {/* Mobile Floating Rollover Recovery Action (when flipped on phones) */}
      {isMobileLayout && isRolledOver && !dockOpen && (
        <div
          className="pointer-events-none fixed inset-x-0 z-20 flex justify-center"
          style={{ top: 'calc(max(0.65rem, env(safe-area-inset-top)) + 3.25rem)' }}
        >
          <button
            type="button"
            draggable={false}
            onContextMenu={(e) => e.preventDefault()}
            onClick={onRightVehicle}
            className="touch-tap pointer-events-auto inline-flex items-center gap-1.5 rounded-xl border border-[#f5efe6]/20 bg-[#e89b3c] px-4 py-2 text-xs font-semibold text-[#17120d] shadow-xl active:scale-95"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Desvirar Veículo</span>
          </button>
        </div>
      )}

      {/* Mobile Dual-Thumb Driving Pad (portrait + landscape phones when settings drawer is closed) */}
      {isMobileLayout && !dockOpen && (
        <MobileDrivePad
          activeInput={activeInput}
          driveMode={config.driveMode}
          tirePressurePsi={config.tirePressurePsi}
          onToggleDriveMode={handleToggleDriveMode}
          onToggleTirePsi={handleToggleTirePsi}
          onVirtualControl={onVirtualControl}
        />
      )}

      {/* Unified Collapsible Bottom Control Dock (Zero Viewport Occlusion) */}
      <aside
        aria-label="Painel de controle da simulação de areia"
        className="fixed bottom-0 left-1/2 z-20 w-[min(1020px,96vw)] -translate-x-1/2 transition-transform duration-200 ease-out"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        {/* Collapse / Expand Handle (desktop only; mobile uses top Ajustes/Fechar button) */}
        {!isMobileLayout && (
          <div className="mb-1.5 flex justify-center">
            <button
              type="button"
              onClick={onToggleDock}
              aria-expanded={dockOpen}
              className="inline-flex items-center gap-1.5 rounded-t-lg rounded-b-md border border-[#f5efe6]/14 bg-[#17130f]/94 px-3.5 py-1.5 text-xs font-medium text-[#e6dac8] shadow-md transition-colors hover:bg-[#241e18] focus-visible:outline-2 focus-visible:outline-[#e89b3c] whitespace-nowrap"
            >
              {dockOpen ? (
                <>
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Ocultar Controles (H)</span>
                </>
              ) : (
                <>
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Mostrar Controles (H)</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Main Dock Body (scrollable sheet on phones, compact horizontal dock on desktop) */}
        {dockOpen && (
          <div
            onContextMenu={(e) => e.preventDefault()}
            className={`touch-scroll-drawer overflow-y-auto rounded-2xl border border-[#f5efe6]/14 bg-[#14110e]/95 px-3.5 py-3 md:px-4 md:py-3.5 shadow-2xl ${
              isMobileLayout ? 'max-h-[64dvh]' : 'max-h-none'
            }`}
          >
            {/* Tab Bar + Quick Actions */}
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between border-b border-[#f5efe6]/10 pb-2">
              <div
                role="tablist"
                aria-label="Seções do painel"
                className="no-scrollbar flex items-center gap-0.5 overflow-x-auto rounded-lg bg-[#0d0b09] p-0.5"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'tests'}
                  onClick={() => setActiveTab('tests')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === 'tests'
                      ? 'bg-[#e89b3c] text-[#17120d]'
                      : 'text-[#cbbca8] hover:text-[#f8f3eb]'
                  }`}
                >
                  <Compass className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Testes & Direção</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'physics'}
                  onClick={() => setActiveTab('physics')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === 'physics'
                      ? 'bg-[#e89b3c] text-[#17120d]'
                      : 'text-[#cbbca8] hover:text-[#f8f3eb]'
                  }`}
                >
                  <Sliders className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Simulação & Física</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'shading'}
                  onClick={() => setActiveTab('shading')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === 'shading'
                      ? 'bg-[#e89b3c] text-[#17120d]'
                      : 'text-[#cbbca8] hover:text-[#f8f3eb]'
                  }`}
                >
                  <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Shading & Câmera</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'budget'}
                  onClick={() => setActiveTab('budget')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                    activeTab === 'budget'
                      ? 'bg-[#e89b3c] text-[#17120d]'
                      : 'text-[#cbbca8] hover:text-[#f8f3eb]'
                  }`}
                >
                  <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Orçamento</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={config.cameraMode === 'cockpit'}
                  onClick={(e) => {
                    e.currentTarget.blur();
                    onChangeConfig({
                      cameraMode: config.cameraMode === 'cockpit' ? 'chase' : 'cockpit',
                    });
                  }}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                    config.cameraMode === 'cockpit'
                      ? 'border-[#e89b3c] bg-[#e89b3c] text-[#17120d]'
                      : 'border-[#e89b3c]/45 bg-[#2a1f14] text-[#f8e7ce] hover:bg-[#3a2a19]'
                  }`}
                  title="Entrar na câmera interna do cockpit em 1ª pessoa (C)"
                >
                  <Camera
                    className={`h-3.5 w-3.5 ${
                      config.cameraMode === 'cockpit' ? 'text-[#17120d]' : 'text-[#e89b3c]'
                    }`}
                    aria-hidden="true"
                  />
                  <span>Cockpit</span>
                </button>
                <button
                  type="button"
                  aria-pressed={config.cameraMode === 'gopro_rear'}
                  onClick={(e) => {
                    e.currentTarget.blur();
                    onChangeConfig({
                      cameraMode: config.cameraMode === 'gopro_rear' ? 'chase' : 'gopro_rear',
                    });
                  }}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                    config.cameraMode === 'gopro_rear'
                      ? 'border-[#e89b3c] bg-[#e89b3c] text-[#17120d]'
                      : 'border-[#f5efe6]/14 bg-[#201b16] text-[#f0e6d8] hover:bg-[#2c251e]'
                  }`}
                  title="Câmera GoPro grande-angular montada próxima à roda traseira (C)"
                >
                  <Video
                    className={`h-3.5 w-3.5 ${
                      config.cameraMode === 'gopro_rear' ? 'text-[#17120d]' : 'text-[#e89b3c]'
                    }`}
                    aria-hidden="true"
                  />
                  <span>GoPro Roda</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    onGoToRockTrail();
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#e89b3c]/50 bg-[#2a1f14] px-2 py-1.5 text-[11px] font-medium text-[#f8e7ce] transition-colors hover:bg-[#3a2a19] whitespace-nowrap shrink-0"
                  title="Ir para a trilha de pedras escaláveis e areia irregular em 4L"
                >
                  <Mountain className="h-3.5 w-3.5 text-[#e89b3c]" aria-hidden="true" />
                  <span>Pedras</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    onTeleport500m();
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#f5efe6]/14 bg-[#201b16] px-2 py-1.5 text-[11px] font-medium text-[#f0e6d8] transition-colors hover:bg-[#2c251e] whitespace-nowrap shrink-0"
                  title="Marco 1: Teletransportar 500m para validar limpeza toroidal zero-copy"
                >
                  <Navigation className="h-3.5 w-3.5 text-[#e89b3c]" aria-hidden="true" />
                  <span>500 m</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    onClearSand();
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#f5efe6]/14 bg-[#201b16] px-2 py-1.5 text-[11px] font-medium text-[#f0e6d8] transition-colors hover:bg-[#2c251e] whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="h-3.5 w-3.5 text-[#c7b9a5]" aria-hidden="true" />
                  <span>Limpar</span>
                </button>
              </div>
            </div>

            {/* Tab Content */}
            <div className="pt-2.5">
              {activeTab === 'tests' && (
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <div
                      role="group"
                      aria-label="Ambiente do terreno"
                      className="flex items-center gap-0.5 rounded-lg border border-[#f5efe6]/12 bg-[#0d0b09] p-0.5"
                    >
                      {BIOMES.map((b) => {
                        const active = config.biome === b.id;
                        return (
                          <button
                            key={b.id}
                            type="button"
                            aria-pressed={active}
                            onClick={(e) => {
                              e.currentTarget.blur();
                              const patch: Partial<SandRuntimeConfig> = { biome: b.id };
                              if (b.id === 'rainy_highway') {
                                patch.moisture = 0.88;
                                patch.sunElevationDeg = WEATHER_PRESET_SPECS.rainy_mist.sunElevationDeg;
                                patch.sunAzimuthDeg = WEATHER_PRESET_SPECS.rainy_mist.sunAzimuthDeg;
                                patch.weatherPreset = 'rainy_mist';
                                patch.exposure = WEATHER_PRESET_SPECS.rainy_mist.exposure;
                              } else if (b.id === 'mud_grass') {
                                patch.moisture = 0.84;
                                patch.sunElevationDeg = WEATHER_PRESET_SPECS.humid_overcast.sunElevationDeg;
                                patch.sunAzimuthDeg = WEATHER_PRESET_SPECS.humid_overcast.sunAzimuthDeg;
                                patch.weatherPreset = 'humid_overcast';
                                patch.exposure = WEATHER_PRESET_SPECS.humid_overcast.exposure;
                              } else {
                                patch.moisture = 0.18;
                                patch.sunElevationDeg = WEATHER_PRESET_SPECS.golden_hour.sunElevationDeg;
                                patch.sunAzimuthDeg = WEATHER_PRESET_SPECS.golden_hour.sunAzimuthDeg;
                                patch.weatherPreset = 'golden_hour';
                                patch.exposure = WEATHER_PRESET_SPECS.golden_hour.exposure;
                              }
                              onChangeConfig(patch);
                            }}
                            className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                              active
                                ? b.id === 'rainy_highway'
                                  ? 'bg-[#6b8fa8] text-[#0c1217]'
                                  : b.id === 'mud_grass'
                                    ? 'bg-[#6b8f3c] text-[#0f140a]'
                                    : 'bg-[#e89b3c] text-[#17120d]'
                                : 'text-[#cbbca8] hover:text-[#f8f3eb]'
                            }`}
                          >
                            {b.label}
                          </button>
                        );
                      })}
                    </div>

                    <div
                      role="group"
                      aria-label="Caixa de transferência 4x4"
                      className="flex items-center gap-0.5 rounded-lg border border-[#f5efe6]/12 bg-[#0d0b09] p-0.5"
                    >
                      {DRIVE_MODES.map((dm) => {
                        const active = config.driveMode === dm.id;
                        return (
                          <button
                            key={dm.id}
                            type="button"
                            aria-pressed={active}
                            title={dm.title}
                            onClick={(e) => {
                              e.currentTarget.blur();
                              onChangeConfig({ driveMode: dm.id });
                            }}
                            className={`rounded-md px-2 py-1 font-mono text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
                              active
                                ? dm.id === '4L'
                                  ? 'bg-[#e89b3c] text-[#17120d]'
                                  : 'bg-[#2e261f] text-[#f8f3eb]'
                                : 'text-[#a79782] hover:text-[#f8f3eb]'
                            }`}
                          >
                            {dm.label}
                          </button>
                        );
                      })}
                    </div>

                    <div
                      role="group"
                      aria-label="Pressão rápida dos pneus"
                      className="flex items-center gap-0.5 rounded-lg border border-[#f5efe6]/12 bg-[#0d0b09] p-0.5"
                    >
                      {[12, 32].map((psi) => {
                        const active = Math.abs(config.tirePressurePsi - psi) <= 3;
                        return (
                          <button
                            key={psi}
                            type="button"
                            aria-pressed={active}
                            title={
                              psi === 12
                                ? '12 PSI — pneu murcho: maior área de contato, mais flexão e tração em pedras/areia'
                                : '32 PSI — pneu cheio: rígido, afunda mais na areia e quica mais nas pedras'
                            }
                            onClick={(e) => {
                              e.currentTarget.blur();
                              onChangeConfig({ tirePressurePsi: psi });
                            }}
                            className={`rounded-md px-2 py-1 font-mono text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
                              active
                                ? psi === 12
                                  ? 'bg-[#e89b3c] text-[#17120d]'
                                  : 'bg-[#2e261f] text-[#f8f3eb]'
                                : 'text-[#a79782] hover:text-[#f8f3eb]'
                            }`}
                          >
                            {psi} PSI
                          </button>
                        );
                      })}
                    </div>

                    <div className="hidden h-4 w-px bg-[#f5efe6]/12 sm:block" aria-hidden="true" />

                    {STRESS_PRESETS.map((preset) => {
                      const active = config.stressMode === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={(e) => {
                            e.currentTarget.blur();
                            const patch: Partial<SandRuntimeConfig> = {
                              stressMode: preset.id,
                            };
                            if (preset.id === 'foot_ik_walk') {
                              patch.cameraMode = 'foot_ik';
                              patch.timeScale = 0.45;
                            } else if (preset.id === 'avalanche_park') {
                              patch.cameraMode = 'wheel_closeup';
                              patch.timeScale = 1.0;
                            } else {
                              patch.timeScale = 1.0;
                              if (config.cameraMode === 'foot_ik') {
                                patch.cameraMode = 'chase';
                              }
                            }
                            onChangeConfig(patch);
                          }}
                          className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                            active
                              ? 'bg-[#e89b3c] text-[#17120d]'
                              : 'border border-[#f5efe6]/12 bg-[#1d1814] text-[#e6dac8] hover:bg-[#28211b]'
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                  {/* Interactive Hold-to-Drive Strip & Keyboard Feedback (Desktop & Tablet) */}
                  {!isMobileLayout && (
                  <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-[#f5efe6]/8 pt-2.5">
                    <div
                      ref={holdStripRef}
                      className="touch-control flex flex-wrap items-center gap-1.5 select-none"
                      aria-label="Controles interativos do veículo"
                    >
                      <button
                        type="button"
                        aria-label="Virar à esquerda (A)"
                        {...holdFlag('left')}
                        className={`touch-control inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                          (activeInput?.steer ?? 0) > 0.1
                            ? 'border-[#e89b3c] bg-[#e89b3c] text-[#17120d]'
                            : 'border-[#f5efe6]/14 bg-[#1d1814] text-[#e6dac8] hover:bg-[#2a221c]'
                        }`}
                      >
                        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="font-mono text-[11px]">A</span>
                      </button>

                      <button
                        type="button"
                        aria-label="Acelerar (W)"
                        {...holdFlag('accelerate')}
                        className={`touch-control inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                          (activeInput?.throttle ?? 0) > 0.1
                            ? 'border-[#e89b3c] bg-[#e89b3c] text-[#17120d]'
                            : 'border-[#f5efe6]/14 bg-[#1d1814] text-[#e6dac8] hover:bg-[#2a221c]'
                        }`}
                      >
                        <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Acelerar</span>
                        <span className="font-mono text-[10px] opacity-75">W</span>
                      </button>

                      <button
                        type="button"
                        aria-label="Freio e Ré (S)"
                        {...holdFlag('brake')}
                        className={`touch-control inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                          (activeInput?.throttle ?? 0) < -0.1
                            ? 'border-[#e0523c] bg-[#e0523c] text-[#fff6f2]'
                            : 'border-[#f5efe6]/14 bg-[#1d1814] text-[#e6dac8] hover:bg-[#2a221c]'
                        }`}
                      >
                        <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Freio / Ré</span>
                        <span className="font-mono text-[10px] opacity-75">S</span>
                      </button>

                      <button
                        type="button"
                        aria-label="Virar à direita (D)"
                        {...holdFlag('right')}
                        className={`touch-control inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                          (activeInput?.steer ?? 0) < -0.1
                            ? 'border-[#e89b3c] bg-[#e89b3c] text-[#17120d]'
                            : 'border-[#f5efe6]/14 bg-[#1d1814] text-[#e6dac8] hover:bg-[#2a221c]'
                        }`}
                      >
                        <span className="font-mono text-[11px]">D</span>
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>

                      <button
                        type="button"
                        aria-label="Freio de mão / Drift (Espaço)"
                        {...holdFlag('handbrake')}
                        className={`touch-control inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                          activeInput?.handbrake
                            ? 'border-[#e0523c] bg-[#e0523c] text-[#fff6f2]'
                            : 'border-[#f5efe6]/14 bg-[#1d1814] text-[#e6dac8] hover:bg-[#2a221c]'
                        }`}
                      >
                        <span>Drift</span>
                        <span className="font-mono text-[10px] opacity-75">Espaço</span>
                      </button>

                      <button
                        type="button"
                        aria-label="Turbo Boost (Shift)"
                        {...holdFlag('boost')}
                        className={`touch-control inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                          activeInput?.boost
                            ? 'border-[#ff8c2e] bg-[#ff8c2e] text-[#17120d]'
                            : 'border-[#f5efe6]/14 bg-[#1d1814] text-[#e6dac8] hover:bg-[#2a221c]'
                        }`}
                      >
                        <Flame className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Turbo</span>
                        <span className="font-mono text-[10px] opacity-75">Shift</span>
                      </button>

                      {isRolledOver && (
                        <button
                          type="button"
                          onClick={onRightVehicle}
                          className="inline-flex items-center gap-1 rounded-md border border-[#e89b3c] bg-[#e89b3c] px-2.5 py-1.5 text-xs font-semibold text-[#17120d] transition-colors hover:bg-[#f2a84a] whitespace-nowrap"
                          title="Desvirar veículo mantendo danos (F)"
                        >
                          <span>Desvirar</span>
                          <span className="font-mono text-[10px] opacity-80">F</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={onResetVehicle}
                        className="inline-flex items-center gap-1 rounded-md border border-[#f5efe6]/14 bg-[#1d1814] px-2.5 py-1.5 text-xs font-medium text-[#d6c9b8] transition-colors hover:bg-[#2a221c] whitespace-nowrap"
                        title="Reparar lataria e reposicionar veículo (R)"
                      >
                        <span>Reparar</span>
                        <span className="font-mono text-[10px] opacity-75">R</span>
                      </button>
                    </div>

                    <span className="font-mono text-[11px] text-[#a79782] whitespace-nowrap">
                      C = Câmera · K = Faróis · V = Limpadores · F = Desvirar · R = Reparar · L = 4H/4L
                    </span>
                  </div>
                  )}

                  {/* Mobile helper hint & quick recovery inside drawer */}
                  {isMobileLayout && (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#f5efe6]/8 pt-2 text-xs text-[#b8a995]">
                      <span>Feche o painel para dirigir com os pedais táteis.</span>
                      <div className="flex items-center gap-1.5">
                        {isRolledOver && (
                          <button
                            type="button"
                            onClick={() => {
                              onRightVehicle();
                              onToggleDock();
                            }}
                            className="touch-tap rounded-lg border border-[#e89b3c] bg-[#2a1f14] px-2.5 py-1.5 text-xs font-semibold text-[#f5b462] whitespace-nowrap shrink-0"
                          >
                            Desvirar
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={onToggleDock}
                          className="touch-tap rounded-lg bg-[#e89b3c] px-3 py-1.5 text-xs font-semibold text-[#17120d] whitespace-nowrap shrink-0"
                        >
                          Voltar a Dirigir
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'physics' && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <label htmlFor="tire-psi-slider" className="text-[#d6c9b8]">
                        Pressão Pneus
                      </label>
                      <span className="font-mono tabular-nums text-[#e89b3c]">
                        {Math.round(config.tirePressurePsi)} PSI
                      </span>
                    </div>
                    <input
                      id="tire-psi-slider"
                      type="range"
                      min={10}
                      max={36}
                      step={1}
                      value={config.tirePressurePsi}
                      onChange={(e) =>
                        onChangeConfig({ tirePressurePsi: parseFloat(e.target.value) })
                      }
                      className="sand-slider w-full"
                    />
                    <div className="flex items-center justify-between text-[11px]">
                      <button
                        type="button"
                        onClick={() => onChangeConfig({ tirePressurePsi: 12 })}
                        className="text-[#e89b3c] underline underline-offset-2 hover:text-[#f5b462]"
                      >
                        12 PSI Areia
                      </button>
                      <button
                        type="button"
                        onClick={() => onChangeConfig({ tirePressurePsi: 32 })}
                        className="text-[#a79782] underline underline-offset-2 hover:text-[#f8f3eb]"
                      >
                        32 PSI Estrada
                      </button>
                    </div>
                  </div>

                  <label className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="text-[#d6c9b8]">Avalanche 33°</span>
                      <span className="font-mono tabular-nums text-[#e89b3c]">
                        {config.avalancheRate.toFixed(2)}×
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={2.4}
                      step={0.05}
                      value={config.avalancheRate}
                      onChange={(e) =>
                        onChangeConfig({ avalancheRate: parseFloat(e.target.value) })
                      }
                      className="sand-slider w-full"
                    />
                  </label>

                  <label className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="text-[#d6c9b8]">Vento & Infill</span>
                      <span className="font-mono tabular-nums text-[#e89b3c]">
                        {config.windSpeed.toFixed(2)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={3.0}
                      step={0.05}
                      value={config.windSpeed}
                      onChange={(e) =>
                        onChangeConfig({ windSpeed: parseFloat(e.target.value) })
                      }
                      className="sand-slider w-full"
                    />
                  </label>

                  <label className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="text-[#d6c9b8]">Umidade Subsuperficial</span>
                      <span className="font-mono tabular-nums text-[#e89b3c]">
                        {Math.round(config.moisture * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={config.moisture}
                      onChange={(e) =>
                        onChangeConfig({ moisture: parseFloat(e.target.value) })
                      }
                      className="sand-slider w-full"
                    />
                  </label>

                  <div className="flex flex-col justify-between gap-1.5">
                    <label className="flex flex-col gap-1.5">
                      <div className="flex justify-between text-xs">
                        <span className="text-[#d6c9b8]">Escala de Tempo</span>
                        <span className="font-mono tabular-nums text-[#e89b3c]">
                          {config.timeScale.toFixed(2)}×
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.2}
                        max={1.0}
                        step={0.05}
                        value={config.timeScale}
                        onChange={(e) =>
                          onChangeConfig({ timeScale: parseFloat(e.target.value) })
                        }
                        className="sand-slider w-full"
                      />
                    </label>
                    <label className="mt-1 inline-flex items-center gap-2 text-xs text-[#d6c9b8] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={config.autoSleepEnabled}
                        onChange={(e) =>
                          onChangeConfig({ autoSleepEnabled: e.target.checked })
                        }
                        className="h-3.5 w-3.5 accent-[#e89b3c]"
                      />
                      <span className="whitespace-nowrap">Auto-Sleep 3 s</span>
                    </label>
                  </div>
                </div>
              )}

              {activeTab === 'shading' && (
                <div className="space-y-3">
                  {/* Row 1: Quasi-RT Quality, Atmosphere/Weather, Tone Mapper */}
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-12 lg:items-center">
                    <div className="lg:col-span-4 space-y-1.5">
                      <div className="text-[11px] text-[#a79782]">Iluminação & Reflexos</div>
                      <div className="flex flex-wrap gap-1.5">
                        {GRAPHICS_QUALITIES.map((q) => (
                          <button
                            key={q.id}
                            type="button"
                            title={q.title}
                            onClick={() => onChangeConfig({ graphicsQuality: q.id })}
                            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                              config.graphicsQuality === q.id
                                ? 'bg-[#e89b3c] text-[#17120d]'
                                : 'border border-[#f5efe6]/12 bg-[#1d1814] text-[#e6dac8] hover:bg-[#28211b]'
                            }`}
                          >
                            {q.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="lg:col-span-5 space-y-1.5">
                      <div className="text-[11px] text-[#a79782]">Clima / Atmosfera</div>
                      <div className="flex flex-wrap gap-1.5">
                        {WEATHER_PRESETS.map((w) => (
                          <button
                            key={w.id}
                            type="button"
                            onClick={() => {
                              const spec = WEATHER_PRESET_SPECS[w.id];
                              onChangeConfig({
                                weatherPreset: w.id,
                                sunElevationDeg: spec.sunElevationDeg,
                                sunAzimuthDeg: spec.sunAzimuthDeg,
                                exposure: spec.exposure,
                              });
                            }}
                            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                              config.weatherPreset === w.id
                                ? 'bg-[#e89b3c] text-[#17120d]'
                                : 'border border-[#f5efe6]/12 bg-[#1d1814] text-[#e6dac8] hover:bg-[#28211b]'
                            }`}
                          >
                            {w.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="lg:col-span-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-[11px] text-[#a79782] whitespace-nowrap shrink-0">Tone Map</span>
                        <div className="flex items-center gap-1 rounded-md bg-[#0d0b09] p-0.5">
                          {TONE_MAPPERS.map((tm) => (
                            <button
                              key={tm.id}
                              type="button"
                              onClick={() => onChangeConfig({ toneMappingMode: tm.id })}
                              className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                                config.toneMappingMode === tm.id
                                  ? 'bg-[#2e261f] text-[#f8f3eb]'
                                  : 'text-[#9e8e7a] hover:text-[#f8f3eb]'
                              }`}
                            >
                              {tm.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-[11px] text-[#a79782] whitespace-nowrap shrink-0">Glints</span>
                        <div className="flex items-center gap-1 rounded-md bg-[#0d0b09] p-0.5">
                          {(['quality', 'performance'] as GlintQualityMode[]).map((g) => (
                            <button
                              key={g}
                              type="button"
                              onClick={() => onChangeConfig({ glintQuality: g })}
                              className={`rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                                config.glintQuality === g
                                  ? 'bg-[#2e261f] text-[#f8f3eb]'
                                  : 'text-[#9e8e7a] hover:text-[#f8f3eb]'
                              }`}
                            >
                              {g === 'quality' ? 'Deliot' : 'Mip'}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Row 2: Fine Optical Sliders (Reflections, AO, Exposure, Sun Elevation) */}
                  <div className="grid grid-cols-2 gap-3 border-t border-[#f5efe6]/8 pt-2.5 lg:grid-cols-4">
                    <label className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-[#d6c9b8]">Reflexos</span>
                        <span className="font-mono tabular-nums text-[#e89b3c]">
                          {Math.round(config.reflectionIntensity * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.2}
                        max={1.8}
                        step={0.05}
                        value={config.reflectionIntensity}
                        onChange={(e) =>
                          onChangeConfig({ reflectionIntensity: parseFloat(e.target.value) })
                        }
                        className="sand-slider w-full"
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-[#d6c9b8]">Oclusão AO</span>
                        <span className="font-mono tabular-nums text-[#e89b3c]">
                          {Math.round(config.aoIntensity * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1.5}
                        step={0.05}
                        value={config.aoIntensity}
                        onChange={(e) =>
                          onChangeConfig({ aoIntensity: parseFloat(e.target.value) })
                        }
                        className="sand-slider w-full"
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-[#d6c9b8]">Exposição</span>
                        <span className="font-mono tabular-nums text-[#e89b3c]">
                          {config.exposure.toFixed(2)}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.75}
                        max={1.35}
                        step={0.02}
                        value={config.exposure}
                        onChange={(e) =>
                          onChangeConfig({ exposure: parseFloat(e.target.value) })
                        }
                        className="sand-slider w-full"
                      />
                    </label>

                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-xs">
                        <label htmlFor="sun-elevation-slider" className="text-[#d6c9b8]">
                          Sol
                        </label>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onChangeConfig({ sunElevationDeg: 10 })}
                            className="text-[11px] text-[#e89b3c] underline underline-offset-2 hover:text-[#f5b462]"
                          >
                            10°
                          </button>
                          <span className="font-mono tabular-nums text-[#f8f3eb]">
                            {Math.round(config.sunElevationDeg)}°
                          </span>
                        </div>
                      </div>
                      <input
                        id="sun-elevation-slider"
                        type="range"
                        min={6}
                        max={68}
                        step={1}
                        value={config.sunElevationDeg}
                        onChange={(e) =>
                          onChangeConfig({
                            sunElevationDeg: parseFloat(e.target.value),
                          })
                        }
                        className="sand-slider w-full"
                      />
                    </div>
                  </div>

                  {/* Row 3: Camera Modes & Debug View Layers */}
                  <div className="grid grid-cols-1 gap-3 border-t border-[#f5efe6]/8 pt-2.5 lg:grid-cols-12 lg:items-center">
                    <div className="lg:col-span-7 space-y-1.5">
                      <div className="text-[11px] text-[#a79782]">Câmera</div>
                      <div className="flex flex-wrap gap-1.5">
                        {CAMERA_MODES.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => onChangeConfig({ cameraMode: m.id })}
                            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                              config.cameraMode === m.id
                                ? 'bg-[#e89b3c] text-[#17120d]'
                                : 'border border-[#f5efe6]/12 bg-[#1d1814] text-[#e6dac8] hover:bg-[#28211b]'
                            }`}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="lg:col-span-5 space-y-1.5">
                      <div className="text-[11px] text-[#a79782]">Camada de Visualização</div>
                      <div className="flex flex-wrap gap-1.5">
                        {DEBUG_VIEWS.map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => onChangeConfig({ debugView: v.id })}
                            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                              config.debugView === v.id
                                ? 'bg-[#e89b3c] text-[#17120d]'
                                : 'border border-[#f5efe6]/12 bg-[#1d1814] text-[#e6dac8] hover:bg-[#28211b]'
                            }`}
                          >
                            {v.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'budget' && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f5efe6]/10 pb-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={onToggleVisor}
                        aria-pressed={visorOpen}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                          visorOpen
                            ? 'border-[#e89b3c] bg-[#e89b3c] text-[#17120d]'
                            : 'border-[#f5efe6]/14 bg-[#1d1814] text-[#f8f3eb] hover:bg-[#2a221c]'
                        }`}
                      >
                        <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{visorOpen ? 'Visor FPS Ativo (P)' : 'Ativar Visor FPS (P)'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => onChangeConfig({ fpsUncapped: !config.fpsUncapped })}
                        aria-pressed={config.fpsUncapped}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                          config.fpsUncapped
                            ? 'border-[#e89b3c]/70 bg-[#e89b3c]/18 text-[#f2b25c]'
                            : 'border-[#f5efe6]/14 bg-[#1d1814] text-[#c7b9a5] hover:bg-[#2a221c]'
                        }`}
                      >
                        <span>{config.fpsUncapped ? 'FPS: Totalmente Livre' : 'FPS: VSync'}</span>
                      </button>
                    </div>
                    <span className="font-mono text-[11px] tabular-nums text-[#a79782]">
                      {telemetry ? `${telemetry.fps} FPS` : '-- FPS'}
                      {telemetry?.perf?.onePercentLowFps ? ` · 1% Low ${telemetry.perf.onePercentLowFps}` : ''}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-5 font-mono tabular-nums">
                    <div>
                      <div className="font-sans text-[11px] text-[#a79782]">Física CPU (SCM/IK)</div>
                      <div className="text-sm font-semibold text-[#f8f3eb]">
                        {telemetry ? telemetry.cpuPhysicsMs.toFixed(2) : '0.09'} ms
                      </div>
                      <div className="font-sans text-[11px] text-[#8f806d]">
                        Alvo ≤ 0,15 ms · 0 readback
                      </div>
                    </div>

                    <div>
                      <div className="font-sans text-[11px] text-[#a79782]">Simulação GPU Toroidal</div>
                      <div className="text-sm font-semibold text-[#e89b3c]">
                        {simSleeping
                          ? '0.00 ms (Sleep)'
                          : gpuTimerAvailable && telemetry
                            ? `${telemetry.gpuSimMs.toFixed(2)} ms`
                            : 'N/D'}
                      </div>
                      <div className="font-sans text-[11px] text-[#8f806d]">
                        {!simSleeping && !gpuTimerAvailable ? 'Sem timer GPU · ' : ''}
                        C0: {telemetry?.cascade0Sleeping ? 'Sleep' : 'Ativa'} · C1:{' '}
                        {telemetry?.cascade1Sleeping ? 'Sleep' : 'Ativa'}
                      </div>
                    </div>

                    <div>
                      <div className="font-sans text-[11px] text-[#a79782]">Reflexos & Probe</div>
                      <div className="text-sm font-semibold text-[#f8f3eb]">
                        {telemetry ? telemetry.probeMode : 'Cube 128² (1 face/f)'}
                      </div>
                      <div className="font-sans text-[11px] text-[#8f806d]">
                        Retrovisores: {telemetry ? telemetry.mirrorsActive : 0}/2 ·{' '}
                        {telemetry?.postProcessingActive ? 'HDR+GTAO' : 'Direto'}
                      </div>
                    </div>

                    <div>
                      <div className="font-sans text-[11px] text-[#a79782]">VRAM & Clipmap</div>
                      <div className="text-sm font-semibold text-[#f8f3eb]">
                        {telemetry ? telemetry.vramMB.toFixed(1) : (cascadeRes === 512 ? '8.0' : '32.0')} MB · 2× {cascadeRes}²
                      </div>
                      <div className="font-sans text-[11px] text-[#8f806d]">
                        {telemetry
                          ? `${Math.round(telemetry.clipmapStats.triangleCount / 1000)}k tris · ${telemetry.clipmapStats.ringCount} anéis · 1 Draw`
                          : '51k tris · 8 anéis · 1 Draw'}
                      </div>
                    </div>

                    <div>
                      <div className="font-sans text-[11px] text-[#a79782]">Terramecânica & Ring</div>
                      <div className="text-sm font-semibold text-[#f8f3eb]">
                        {telemetry ? Math.round(telemetry.vehicle.trackCompactionPct) : 0}% trilho ·{' '}
                        {telemetry ? telemetry.avgFootSinkageCm.toFixed(1) : '3.2'} cm IK
                      </div>
                      <div className="font-sans text-[11px] text-[#8f806d]">
                        {telemetry ? telemetry.activeTracksInRing : 0}/{ringCapacity} seg ·{' '}
                        {telemetry ? Math.round(telemetry.vehicle.rollingDragN) : 0} N drag
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
});
ControlDock.displayName = 'ControlDock';
