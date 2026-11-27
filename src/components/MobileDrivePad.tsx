/**
 * MobileDrivePad.tsx
 * Ergonomic dual-thumb touch driving controls for phones in BOTH portrait & landscape.
 *
 * Edge/Chrome Android hardening:
 *  - Native non-passive `touchstart`, `touchmove`, `contextmenu`, and `selectstart`
 *    `preventDefault()` directly on the pad root stops Edge Mobile's long-press modal,
 *    Bing/Copilot text-lookup bar, and ghost drags while keeping multi-touch PointerEvents
 *    firing with zero latency.
 *  - Tracks pointer IDs per pedal/steering channel so simultaneous steering + gas + turbo
 *    never conflict, and safely releases all flags on blur/visibilitychange/unmount.
 *  - Honors safe-area insets on bottom, left & right for notched landscape phones.
 */

import React, { useEffect, useRef } from 'react';
import {
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Flame,
} from 'lucide-react';
import { DriveMode } from '../sand-engine/core/SandParams';
import {
  VehicleControlInput,
  VirtualControlFlags,
} from '../sand-engine/core/VehicleDriveModel';

type HoldableFlag = keyof Omit<VirtualControlFlags, 'analogSteer'>;

interface MobileDrivePadProps {
  activeInput: VehicleControlInput | undefined;
  driveMode: DriveMode;
  tirePressurePsi: number;
  onToggleDriveMode: () => void;
  onToggleTirePsi: () => void;
  onVirtualControl: (patch: Partial<VirtualControlFlags>) => void;
}

export const MobileDrivePad: React.FC<MobileDrivePadProps> = React.memo(({
  activeInput,
  driveMode,
  tirePressurePsi,
  onToggleDriveMode,
  onToggleTirePsi,
  onVirtualControl,
}) => {
  const padRootRef = useRef<HTMLDivElement | null>(null);
  const steerPointerIdRef = useRef<number | null>(null);
  const steerPadRef = useRef<HTMLDivElement | null>(null);
  const activeFlagPointersRef = useRef<Map<number, HoldableFlag>>(new Map());
  const driveToggleHandledPtrRef = useRef(false);
  const psiToggleHandledPtrRef = useRef(false);

  const steerVal = activeInput?.steer ?? 0;
  const throttleVal = activeInput?.throttle ?? 0;
  const handbrakeOn = Boolean(activeInput?.handbrake);
  const boostOn = Boolean(activeInput?.boost);
  const isLowPsi = tirePressurePsi <= 18;

  // Non-passive native touch/context guards: completely stops Edge Android long-press modals
  // while W3C PointerEvents continue firing normally for every control inside the pad.
  useEffect(() => {
    const root = padRootRef.current;
    if (!root) return;

    const blockBrowserGesture = (e: Event) => {
      e.preventDefault();
    };

    root.addEventListener('touchstart', blockBrowserGesture, { passive: false });
    root.addEventListener('touchmove', blockBrowserGesture, { passive: false });
    root.addEventListener('contextmenu', blockBrowserGesture, { passive: false });
    root.addEventListener('selectstart', blockBrowserGesture);

    return () => {
      root.removeEventListener('touchstart', blockBrowserGesture);
      root.removeEventListener('touchmove', blockBrowserGesture);
      root.removeEventListener('contextmenu', blockBrowserGesture);
      root.removeEventListener('selectstart', blockBrowserGesture);
    };
  }, []);

  // Release all held pedals cleanly if the user switches apps, opens notification shade, or unmounts
  useEffect(() => {
    const releaseAll = () => {
      steerPointerIdRef.current = null;
      activeFlagPointersRef.current.clear();
      onVirtualControl({
        accelerate: false,
        brake: false,
        left: false,
        right: false,
        handbrake: false,
        boost: false,
        analogSteer: 0,
      });
    };

    const onVisibility = () => {
      if (document.hidden) releaseAll();
    };

    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
      releaseAll();
    };
  }, [onVirtualControl]);

  const updateAnalogSteerFromClientX = (clientX: number) => {
    const el = steerPadRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const norm = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1; // -1 left .. +1 right
    // VehicleDriveModel steer: +1 = left, -1 = right
    const clamped = Math.max(-1, Math.min(1, -norm * 1.2));
    // Tiny center deadzone so tapping left/right edge responds immediately
    const steer = Math.abs(clamped) < 0.08 ? 0 : clamped;
    onVirtualControl({ analogSteer: steer, left: false, right: false });
  };

  const handleSteerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    steerPointerIdRef.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Safe guard for synthetic/cancelled pointers on Android browsers
    }
    updateAnalogSteerFromClientX(e.clientX);
  };

  const handleSteerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (steerPointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    updateAnalogSteerFromClientX(e.clientX);
  };

  const handleSteerRelease = (e: React.PointerEvent<HTMLDivElement>) => {
    if (steerPointerIdRef.current !== e.pointerId) return;
    e.preventDefault();
    steerPointerIdRef.current = null;
    onVirtualControl({ analogSteer: 0, left: false, right: false });
  };

  const releaseFlagPointer = (pointerId: number, flag: HoldableFlag) => {
    const map = activeFlagPointersRef.current;
    if (map.get(pointerId) === flag) {
      map.delete(pointerId);
    }
    // Only turn off the flag if no other finger is still holding the same pedal
    let stillHeld = false;
    map.forEach((heldFlag) => {
      if (heldFlag === flag) stillHeld = true;
    });
    if (!stillHeld) {
      onVirtualControl({ [flag]: false });
    }
  };

  const holdFlag = (flag: HoldableFlag) => ({
    draggable: false,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    },
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      activeFlagPointersRef.current.set(e.pointerId, flag);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer was already cancelled by OS gesture
      }
      onVirtualControl({ [flag]: true });
    },
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      releaseFlagPointer(e.pointerId, flag);
    },
    onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => {
      releaseFlagPointer(e.pointerId, flag);
    },
    onLostPointerCapture: (e: React.PointerEvent<HTMLButtonElement>) => {
      releaseFlagPointer(e.pointerId, flag);
    },
  });

  // Visual thumb puck offset (-1 left .. +1 right in screen X)
  const puckOffsetPct = 50 - steerVal * 34;

  return (
    <div
      ref={padRootRef}
      onContextMenu={(e) => e.preventDefault()}
      className="touch-control pointer-events-none fixed inset-x-0 bottom-0 z-20 flex items-end justify-between"
      style={{
        paddingLeft: 'max(0.875rem, env(safe-area-inset-left))',
        paddingRight: 'max(0.875rem, env(safe-area-inset-right))',
        paddingBottom: 'max(0.85rem, env(safe-area-inset-bottom))',
      }}
      aria-label="Controles táteis de direção"
    >
      {/* Bottom-Left Thumb Zone: Quick 4H/4L + PSI Switches above Analog Steering Bar */}
      <div className="pointer-events-auto flex flex-col items-start gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            draggable={false}
            aria-pressed={driveMode === '4L'}
            aria-label="Alternar tração 4H e 4L"
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              driveToggleHandledPtrRef.current = true;
              onToggleDriveMode();
            }}
            onClick={(e) => {
              if (driveToggleHandledPtrRef.current) {
                driveToggleHandledPtrRef.current = false;
                return;
              }
              e.stopPropagation();
              onToggleDriveMode();
            }}
            className={`touch-control flex h-9 min-w-[54px] items-center justify-center rounded-xl border px-2.5 font-mono text-xs font-semibold shadow-lg transition-transform active:scale-95 ${
              driveMode === '4L'
                ? 'border-[#e89b3c] bg-[#e89b3c] text-[#17120d]'
                : 'border-[#f5efe6]/18 bg-[#14110e]/88 text-[#e6dac8]'
            }`}
          >
            {driveMode}
          </button>

          <button
            type="button"
            draggable={false}
            aria-pressed={isLowPsi}
            aria-label="Alternar pressão dos pneus entre areia e estrada"
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              psiToggleHandledPtrRef.current = true;
              onToggleTirePsi();
            }}
            onClick={(e) => {
              if (psiToggleHandledPtrRef.current) {
                psiToggleHandledPtrRef.current = false;
                return;
              }
              e.stopPropagation();
              onToggleTirePsi();
            }}
            className={`touch-control flex h-9 items-center justify-center rounded-xl border px-2.5 font-mono text-[11px] font-semibold shadow-lg transition-transform active:scale-95 ${
              isLowPsi
                ? 'border-[#e89b3c]/75 bg-[#2a1f14]/92 text-[#f5b462]'
                : 'border-[#f5efe6]/18 bg-[#14110e]/88 text-[#d6c9b8]'
            }`}
          >
            {Math.round(tirePressurePsi)} PSI
          </button>
        </div>

        <div
          ref={steerPadRef}
          role="slider"
          aria-label="Direção tátil esquerda e direita"
          aria-valuemin={-100}
          aria-valuemax={100}
          aria-valuenow={Math.round(-steerVal * 100)}
          draggable={false}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerDown={handleSteerDown}
          onPointerMove={handleSteerMove}
          onPointerUp={handleSteerRelease}
          onPointerCancel={handleSteerRelease}
          onLostPointerCapture={handleSteerRelease}
          className="touch-control relative flex h-[64px] w-[166px] items-center justify-between rounded-2xl border border-[#f5efe6]/18 bg-[#14110e]/88 px-3 shadow-xl"
        >
          <div
            className={`pointer-events-none flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
              steerVal > 0.12
                ? 'bg-[#e89b3c] text-[#17120d]'
                : 'bg-[#221c17] text-[#e6dac8]'
            }`}
          >
            <ChevronLeft className="h-6 w-6" aria-hidden="true" />
          </div>

          {/* Analog center guide + moving indicator */}
          <div className="pointer-events-none relative mx-1.5 h-1.5 flex-1 rounded-full bg-[#f5efe6]/14">
            <div
              className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#e89b3c] shadow"
              style={{ left: `${puckOffsetPct}%` }}
            />
          </div>

          <div
            className={`pointer-events-none flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
              steerVal < -0.12
                ? 'bg-[#e89b3c] text-[#17120d]'
                : 'bg-[#221c17] text-[#e6dac8]'
            }`}
          >
            <ChevronRight className="h-6 w-6" aria-hidden="true" />
          </div>
        </div>
      </div>

      {/* Bottom-Right Thumb Zone: Drift + Turbo Row above Brake/Rev & Gas Pedals */}
      <div className="pointer-events-auto flex flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Drift (Freio de mão)"
            {...holdFlag('handbrake')}
            className={`touch-control flex h-11 min-w-[68px] items-center justify-center rounded-xl border px-3 text-xs font-semibold shadow-lg transition-transform ${
              handbrakeOn
                ? 'scale-95 border-[#e0523c] bg-[#e0523c] text-[#fff6f2]'
                : 'border-[#f5efe6]/18 bg-[#14110e]/88 text-[#e6dac8]'
            }`}
          >
            Drift
          </button>
          <button
            type="button"
            aria-label="Turbo Boost"
            {...holdFlag('boost')}
            className={`touch-control flex h-11 min-w-[78px] items-center justify-center gap-1 rounded-xl border px-3 text-xs font-semibold shadow-lg transition-transform ${
              boostOn
                ? 'scale-95 border-[#ff8c2e] bg-[#ff8c2e] text-[#17120d]'
                : 'border-[#f5efe6]/18 bg-[#14110e]/88 text-[#f5b462]'
            }`}
          >
            <Flame className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Turbo</span>
          </button>
        </div>

        <div className="flex items-end gap-2">
          <button
            type="button"
            aria-label="Frear ou engatar Ré"
            {...holdFlag('brake')}
            className={`touch-control flex h-[64px] w-[68px] flex-col items-center justify-center gap-0.5 rounded-2xl border shadow-xl transition-transform ${
              throttleVal < -0.1
                ? 'scale-95 border-[#e0523c] bg-[#e0523c] text-[#fff6f2]'
                : 'border-[#f5efe6]/18 bg-[#14110e]/88 text-[#e6dac8]'
            }`}
          >
            <ArrowDown className="h-5 w-5" aria-hidden="true" />
            <span className="text-[10px] font-semibold">Freio/Ré</span>
          </button>

          <button
            type="button"
            aria-label="Acelerar veículo"
            {...holdFlag('accelerate')}
            className={`touch-control flex h-[76px] w-[82px] flex-col items-center justify-center gap-0.5 rounded-2xl border shadow-xl transition-transform ${
              throttleVal > 0.1
                ? 'scale-95 border-[#e89b3c] bg-[#e89b3c] text-[#17120d]'
                : 'border-[#e89b3c]/50 bg-[#1b1510]/92 text-[#f8f3eb]'
            }`}
          >
            <ArrowUp className="h-6 w-6" aria-hidden="true" />
            <span className="text-[11px] font-semibold">Acelerar</span>
          </button>
        </div>
      </div>
    </div>
  );
});
MobileDrivePad.displayName = 'MobileDrivePad';
