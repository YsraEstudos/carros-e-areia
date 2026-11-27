/**
 * PerformanceVisor.tsx
 * Toggleable real-time hardware performance overlay (FPS, 1% Low, GPU%, CPU%)
 * with unlocked FPS / VSync mode switch for both Desktop and Mobile viewports.
 *
 * Design rules observed:
 *  - Zero CSS backdrop-filter / backdrop-blur over active WebGL canvas
 *  - Zero pulsing dots or noisy status pills
 *  - Crisp tabular monospace numerals, motorsport instrument aesthetic
 *  - Guaranteed zero overlap with top-left DuneFlow badge at ANY viewport width
 *    via ResizeObserver anchoring on Desktop & safe-area offsets on Mobile
 */

import React, { useEffect, useState } from 'react';
import { X, Zap, Lock } from 'lucide-react';
import { SandEngineTelemetry } from '../sand-engine/adapters/WebSandAdapter';

export interface PerformanceVisorProps {
  visible: boolean;
  telemetry: SandEngineTelemetry | null;
  fpsUncapped: boolean;
  isMobileLayout: boolean;
  showOnePercentLow: boolean;
  showGpu: boolean;
  showCpu: boolean;
  onClose: () => void;
  onToggleOnePercentLow: () => void;
  onToggleGpu: () => void;
  onToggleCpu: () => void;
  onToggleFpsUncapped: () => void;
}

function getFpsColor(fps: number): string {
  if (fps >= 58) return 'text-[#8fd694]';
  if (fps >= 35) return 'text-[#e89b3c]';
  return 'text-[#e0523c]';
}

function getUsageBarColor(pct: number): string {
  if (pct >= 90) return 'bg-[#e0523c]';
  if (pct >= 70) return 'bg-[#e89b3c]';
  return 'bg-[#8fd694]';
}

export const PerformanceVisor: React.FC<PerformanceVisorProps> = React.memo(({
  visible,
  telemetry,
  fpsUncapped,
  isMobileLayout,
  showOnePercentLow,
  showGpu,
  showCpu,
  onClose,
  onToggleOnePercentLow,
  onToggleGpu,
  onToggleCpu,
  onToggleFpsUncapped,
}) => {
  // Dynamically anchor below the top-left DuneFlow badge so wrapping on narrow desktop / iframe panes NEVER overlaps
  const [desktopTopPx, setDesktopTopPx] = useState<number>(106);

  useEffect(() => {
    if (!visible || isMobileLayout || typeof window === 'undefined') return;
    const measure = () => {
      const badge = document.querySelector<HTMLElement>('[data-testid="desktop-brand-badge"]');
      if (!badge) return;
      const rect = badge.getBoundingClientRect();
      if (rect.height > 0) {
        setDesktopTopPx(Math.ceil(rect.bottom) + 10);
      }
    };
    measure();
    const badge = document.querySelector<HTMLElement>('[data-testid="desktop-brand-badge"]');
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (badge && ro) ro.observe(badge);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [visible, isMobileLayout, telemetry?.cascadeResolution]);

  if (!visible) return null;

  const perf = telemetry?.perf;
  const fps = perf && perf.sampleCount > 0 ? perf.fps : (telemetry?.fps ?? 0);
  const frameTimeMs = perf && perf.sampleCount > 0 ? perf.frameTimeMs : 0;
  const onePercentLow = perf && perf.sampleCount > 0 ? perf.onePercentLowFps : 0;
  const gpuPct = perf && perf.sampleCount > 0 ? perf.gpuUsagePct : 0;
  const gpuMs = perf && perf.sampleCount > 0 ? perf.gpuWorkMs : 0;
  const gpuHw = Boolean(perf?.gpuHardwareMeasured);
  const cpuPct = perf && perf.sampleCount > 0 ? perf.cpuUsagePct : 0;
  const cpuMs = perf && perf.sampleCount > 0 ? perf.cpuWorkMs : 0;
  const jsCpuMs = perf && perf.sampleCount > 0 ? perf.jsCpuMs : 0;
  const gpuStallMs = perf && perf.sampleCount > 0 ? perf.gpuStallMs : 0;
  const bottleneck = perf?.bottleneck ?? 'balanced';
  const backpressureGuarded = Boolean(perf?.backpressureGuarded);

  const pacingLabel = fpsUncapped
    ? backpressureGuarded
      ? 'Auto'
      : 'Livre'
    : 'VSync';

  const pacingTitle = fpsUncapped
    ? backpressureGuarded
      ? 'Modo Livre com proteção anti-engasgo ativa (GPU/iframe em fila cheia — sincronizado via rAF)'
      : 'FPS liberado com guarda de fila WebGL2 (clique para travar no VSync)'
    : 'Sincronizado ao VSync nativo do monitor 60/120/240Hz (clique para tentar modo Livre)';

  return (
    <section
      aria-label="Visor de performance em tempo real"
      data-testid="performance-visor"
      data-bottleneck={bottleneck}
      className={`pointer-events-auto fixed z-20 rounded-xl border border-[#f5efe6]/14 bg-[#120f0c]/94 shadow-xl font-mono tabular-nums ${
        isMobileLayout
          ? 'w-[228px] px-2.5 py-2'
          : 'w-[264px] px-3 py-2.5'
      }`}
      style={
        isMobileLayout
          ? {
              top: 'calc(max(0.65rem, env(safe-area-inset-top)) + 3.1rem)',
              left: 'max(0.75rem, env(safe-area-inset-left))',
            }
          : {
              top: `${desktopTopPx}px`,
              left: '1.25rem',
            }
      }
    >
      {/* Primary FPS Row + FPS Mode Switch + Close */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span
            data-testid="visor-fps-value"
            className={`text-xl font-bold leading-none ${getFpsColor(fps)}`}
          >
            {fps > 0 ? fps : '--'}
          </span>
          <span className="text-[10px] font-semibold tracking-wider text-[#a79782]">
            FPS
          </span>
          <span className="text-[10px] text-[#8f806d]">
            {frameTimeMs > 0 ? `${frameTimeMs.toFixed(1)}ms` : '--'}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            draggable={false}
            onContextMenu={(e) => e.preventDefault()}
            onClick={onToggleFpsUncapped}
            aria-pressed={fpsUncapped}
            data-testid="visor-fps-mode-btn"
            title={pacingTitle}
            className={`touch-tap inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-sans text-[10px] font-semibold transition-colors whitespace-nowrap ${
              fpsUncapped
                ? 'border-[#e89b3c]/70 bg-[#e89b3c]/18 text-[#f2b25c]'
                : 'border-[#f5efe6]/14 bg-[#1c1713] text-[#c7b9a5] hover:bg-[#27201a]'
            }`}
          >
            {fpsUncapped ? (
              <Zap className="h-2.5 w-2.5" aria-hidden="true" />
            ) : (
              <Lock className="h-2.5 w-2.5" aria-hidden="true" />
            )}
            <span>{pacingLabel}</span>
          </button>

          <button
            type="button"
            draggable={false}
            onContextMenu={(e) => e.preventDefault()}
            onClick={onClose}
            aria-label="Ocultar visor de performance (P)"
            title="Ocultar visor (P)"
            className="touch-tap flex h-5 w-5 items-center justify-center rounded-md border border-[#f5efe6]/12 bg-[#1c1713] text-[#a79782] transition-colors hover:bg-[#2a221c] hover:text-[#f8f3eb]"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Individual Metric Toggles (1% Low / GPU / CPU) */}
      <div
        className="mt-2 grid grid-cols-3 gap-1"
        role="group"
        aria-label="Métricas opcionais do visor"
      >
        <button
          type="button"
          draggable={false}
          onContextMenu={(e) => e.preventDefault()}
          onClick={onToggleOnePercentLow}
          aria-pressed={showOnePercentLow}
          data-testid="visor-toggle-1pct"
          className={`touch-tap rounded-md border px-1.5 py-1 font-sans text-[10px] font-medium transition-colors whitespace-nowrap ${
            showOnePercentLow
              ? 'border-[#e89b3c]/60 bg-[#2a2117] text-[#f8f3eb]'
              : 'border-[#f5efe6]/10 bg-[#191410] text-[#8f806d] hover:text-[#c7b9a5]'
          }`}
        >
          1% Low
        </button>
        <button
          type="button"
          draggable={false}
          onContextMenu={(e) => e.preventDefault()}
          onClick={onToggleGpu}
          aria-pressed={showGpu}
          data-testid="visor-toggle-gpu"
          className={`touch-tap rounded-md border px-1.5 py-1 font-sans text-[10px] font-medium transition-colors whitespace-nowrap ${
            showGpu
              ? 'border-[#e89b3c]/60 bg-[#2a2117] text-[#f8f3eb]'
              : 'border-[#f5efe6]/10 bg-[#191410] text-[#8f806d] hover:text-[#c7b9a5]'
          }`}
        >
          GPU
        </button>
        <button
          type="button"
          draggable={false}
          onContextMenu={(e) => e.preventDefault()}
          onClick={onToggleCpu}
          aria-pressed={showCpu}
          data-testid="visor-toggle-cpu"
          className={`touch-tap rounded-md border px-1.5 py-1 font-sans text-[10px] font-medium transition-colors whitespace-nowrap ${
            showCpu
              ? 'border-[#e89b3c]/60 bg-[#2a2117] text-[#f8f3eb]'
              : 'border-[#f5efe6]/10 bg-[#191410] text-[#8f806d] hover:text-[#c7b9a5]'
          }`}
        >
          CPU
        </button>
      </div>

      {/* Active Optional Metric Rows */}
      {(showOnePercentLow || showGpu || showCpu) && (
        <div className="mt-2 space-y-1.5 border-t border-[#f5efe6]/10 pt-2">
          {showOnePercentLow && (
            <div
              data-testid="visor-row-1pct"
              className="flex items-center justify-between text-[11px]"
            >
              <span className="font-sans text-[#a79782]">1% Low</span>
              <span className={`font-semibold ${getFpsColor(onePercentLow)}`}>
                {onePercentLow > 0 ? `${onePercentLow} fps` : '--'}
              </span>
            </div>
          )}

          {showGpu && (
            <div
              data-testid="visor-row-gpu"
              className="space-y-0.5"
              title={
                gpuStallMs >= 2
                  ? `GPU ${gpuMs.toFixed(1)}ms · Espera fila WebGL ${gpuStallMs.toFixed(1)}ms`
                  : `Tempo de execução GPU: ${gpuMs.toFixed(1)}ms`
              }
            >
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-sans text-[#a79782]">
                  Uso GPU
                </span>
                <span className="font-semibold text-[#f8f3eb]">
                  {!gpuHw && gpuPct > 0 ? '~' : ''}
                  {gpuPct}%
                  <span className="ml-1.5 text-[10px] font-normal text-[#8f806d]">
                    {gpuMs > 0 ? `${gpuMs.toFixed(1)}ms` : '--'}
                  </span>
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-[#241e18]">
                <div
                  className={`h-full transition-[width] duration-150 ${getUsageBarColor(gpuPct)}`}
                  style={{ width: `${Math.min(100, Math.max(0, gpuPct))}%` }}
                />
              </div>
            </div>
          )}

          {showCpu && (
            <div
              data-testid="visor-row-cpu"
              className="space-y-0.5"
              title={`JS Simulação: ${jsCpuMs.toFixed(1)}ms · Total CPU (JS + WebGL encode): ${cpuMs.toFixed(1)}ms`}
            >
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-sans text-[#a79782]">Uso CPU</span>
                <span className="font-semibold text-[#f8f3eb]">
                  {cpuPct}%
                  <span className="ml-1.5 text-[10px] font-normal text-[#8f806d]">
                    {cpuMs > 0 ? `${cpuMs.toFixed(1)}ms` : '--'}
                  </span>
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-[#241e18]">
                <div
                  className={`h-full transition-[width] duration-150 ${getUsageBarColor(cpuPct)}`}
                  style={{ width: `${Math.min(100, Math.max(0, cpuPct))}%` }}
                />
              </div>
            </div>
          )}

          {bottleneck === 'browser_throttle' && (
            <div
              data-testid="visor-throttle-hint"
              className="flex items-center justify-between pt-0.5 font-sans text-[10px] text-[#e89b3c]"
            >
              <span>Limite do navegador / Eco</span>
              <span className="font-mono text-[#a79782]">CPU/GPU livres</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
});
PerformanceVisor.displayName = 'PerformanceVisor';
