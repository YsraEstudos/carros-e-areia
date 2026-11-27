/**
 * CockpitDisplayRenderer.ts
 * High-contrast Canvas2D procedural UI renderer for both 12-inch Ford F-150 Raptor R cockpit displays,
 * matching Reference Image 1:
 *  1. 12" Digital Instrument Cluster (1024x384):
 *     - Left: Amber RAPTOR header, ODO (12486 km), TRIP (5.8 km), horizontal FUEL bar
 *     - Center: 6:30 AM clock, circular Raptor tachometer (0..7 x1000 RPM) with live needle & redline,
 *       crisp big digital km/h readout, plus live Check Engine / Overheat / TPMS flat-tire icons
 *     - Right: 11°C ambient temp, P R N D1..D10 gear bar, amber boxed 4H/4L, REAR LOCKED, NORMAL/BAJA mode
 *  2. 12" SYNC 4 Interactive Touchscreen (768x512):
 *     - Top status bar (6:30 AM, signal bars, 11°C)
 *     - Audio tab (default): Radio / Spotify green pill, stylized warm portrait album art,
 *       SPOTIFY / Earrings / Malcolm Todd / Sweet Boy, Prev / Play-Pause / Next,
 *       live vivid green progress scrubber (0:40 .. -1:51) & "Playing on Spotify"
 *     - Home, Climate (interactive temp/fan/AC/defrost), Phone, Apps (4x4 pitch/roll + live damage diagram),
 *       Settings (Wiper speed, 4H/4L, Repair Vehicle)
 *     - Bottom 6-tab bar: Home | Audio | Climate | Phone | Apps | Settings
 */

import * as THREE from 'three';
import {
  AMBIENT_LIGHT_PRESETS,
  CockpitRuntimeState,
  computeHazardFlash01,
  formatTrackTime,
  getActiveAmbientPreset,
  InfotainmentTab,
  RAPTOR_PLAYLIST,
  RAPTOR_RADIO_STATIONS,
} from '../core/CockpitStateModel';
import { DriveMode, EnvironmentBiome } from '../core/SandParams';
import { VehicleDamageState } from '../core/VehicleCrashPhysics';

export interface CockpitDisplayTelemetry {
  speedKmh: number;
  rpm: number;
  gear: string;
  driveMode: DriveMode;
  biome: EnvironmentBiome;
  pitchDeg: number;
  rollDeg: number;
  damage: Readonly<VehicleDamageState>;
  timeSec: number;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class CockpitDisplayRenderer {
  public readonly clusterTexture: THREE.CanvasTexture;
  public readonly syncTexture: THREE.CanvasTexture;

  private readonly clusterCanvas: HTMLCanvasElement;
  private readonly clusterCtx: CanvasRenderingContext2D;
  private readonly clusterStaticCanvas: HTMLCanvasElement;
  private readonly clusterArcGrad: CanvasGradient;
  private readonly syncCanvas: HTMLCanvasElement;
  private readonly syncCtx: CanvasRenderingContext2D;
  private readonly albumArtCanvas: HTMLCanvasElement;

  private lastClusterDrawSec = -10;
  private lastSyncDrawSec = -10;

  constructor() {
    this.clusterCanvas = document.createElement('canvas');
    this.clusterCanvas.width = 1024;
    this.clusterCanvas.height = 384;
    this.clusterCtx = this.clusterCanvas.getContext('2d')!;
    this.clusterStaticCanvas = this.createClusterStaticBackdrop();
    const arcGrad = this.clusterCtx.createLinearGradient(1024 * 0.5 - 132, 228, 1024 * 0.5 + 132, 228);
    arcGrad.addColorStop(0, '#f59e0b');
    arcGrad.addColorStop(0.75, '#f97316');
    arcGrad.addColorStop(1, '#ef4444');
    this.clusterArcGrad = arcGrad;

    this.clusterTexture = new THREE.CanvasTexture(this.clusterCanvas);
    this.clusterTexture.colorSpace = THREE.SRGBColorSpace;
    this.clusterTexture.minFilter = THREE.LinearFilter;
    this.clusterTexture.magFilter = THREE.LinearFilter;
    this.clusterTexture.anisotropy = 4;

    this.syncCanvas = document.createElement('canvas');
    this.syncCanvas.width = 768;
    this.syncCanvas.height = 512;
    this.syncCtx = this.syncCanvas.getContext('2d')!;

    this.syncTexture = new THREE.CanvasTexture(this.syncCanvas);
    this.syncTexture.colorSpace = THREE.SRGBColorSpace;
    this.syncTexture.minFilter = THREE.LinearFilter;
    this.syncTexture.magFilter = THREE.LinearFilter;
    this.syncTexture.anisotropy = 4;

    // Pre-paint procedural stylized warm retro portrait cover matching "Sweet Boy / Earrings" card
    this.albumArtCanvas = this.createAlbumArtCanvas('#e48870', '#c74c3e', '#f2e4d8');
  }

  private createClusterStaticBackdrop(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    const W = 1024;
    const H = 384;
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;

    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, W, H);

    const grad = ctx.createRadialGradient(W * 0.5, H * 0.55, 40, W * 0.5, H * 0.5, 490);
    grad.addColorStop(0, '#0e131b');
    grad.addColorStop(1, '#030508');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Static amber RIVIAN R1T wordmark
    ctx.fillStyle = '#f08218';
    ctx.font = '800 20px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('RIVIAN R1T', 36, 42);

    // Hairline divider below top status row
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(32, 68);
    ctx.lineTo(W - 32, 68);
    ctx.stroke();

    // Static left labels & units
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8b95a3';
    ctx.font = '700 18px "Inter", system-ui, sans-serif';
    ctx.fillText('ODO', 38, 128);
    ctx.fillText('TRIP', 38, 224);
    ctx.fillText('FUEL', 38, 326);

    ctx.fillStyle = '#b4becb';
    ctx.font = '600 22px "Inter", system-ui, sans-serif';
    ctx.fillText('km', 165, 170);
    ctx.fillText('km', 132, 264);

    // Static fuel track background
    ctx.fillStyle = '#202630';
    roundRectPath(ctx, 104, 318, 148, 14, 5);
    ctx.fill();

    // Static tachometer outer track, redline zone, and 0..7 ticks/numbers
    const cx = W * 0.5;
    const cy = 228;
    const r = 132;
    const startAng = Math.PI * 0.78;
    const endAng = Math.PI * 2.22;
    const span = endAng - startAng;

    ctx.strokeStyle = '#1b222c';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAng, endAng);
    ctx.stroke();

    const redStart = startAng + (6 / 7) * span;
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(cx, cy, r, redStart, endAng);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 22px "Inter", system-ui, sans-serif';
    for (let t = 0; t <= 7; t++) {
      const a = startAng + (t / 7) * span;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.strokeStyle = t >= 6 ? '#ef4444' : '#cbd5e1';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx + cos * (r - 12), cy + sin * (r - 12));
      ctx.lineTo(cx + cos * (r + 4), cy + sin * (r + 4));
      ctx.stroke();

      ctx.fillStyle = t >= 6 ? '#f87171' : '#dbe3ee';
      ctx.fillText(`${t}`, cx + cos * (r - 30), cy + sin * (r - 30));
    }

    ctx.fillStyle = '#9aa6b5';
    ctx.font = '600 24px "Inter", system-ui, sans-serif';
    ctx.fillText('km/h', cx, cy + 56);

    return c;
  }

  private createAlbumArtCanvas(c1: string, c2: string, wall: string): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 180;
    c.height = 180;
    const ctx = c.getContext('2d')!;

    // Warm sunlit bedroom/studio backdrop with subtle red/pink tint (matches Image 1 album square!)
    const bg = ctx.createLinearGradient(0, 0, 180, 180);
    bg.addColorStop(0, wall);
    bg.addColorStop(0.55, '#ead4c6');
    bg.addColorStop(1, '#c99382');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 180, 180);

    // Subtle bookshelf / dark studio window frame on right half
    ctx.fillStyle = '#332022';
    ctx.fillRect(108, 12, 62, 112);
    ctx.fillStyle = '#d45a46';
    ctx.fillRect(114, 24, 50, 26);
    ctx.fillStyle = '#f3d4b8';
    ctx.fillRect(116, 62, 46, 52);

    // Stylized silhouette figure seated on left in warm light
    ctx.fillStyle = c2;
    ctx.beginPath();
    ctx.ellipse(66, 134, 44, 52, -0.1, 0, Math.PI * 2);
    ctx.fill();

    // Warm skin tone torso/arms + head
    ctx.fillStyle = '#efc0a6';
    ctx.beginPath();
    ctx.arc(64, 62, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2d1c19';
    ctx.beginPath();
    ctx.arc(63, 54, 23, Math.PI * 0.95, Math.PI * 2.1);
    ctx.fill();

    // White vintage tee / collar accent
    ctx.fillStyle = '#f7f2ed';
    ctx.beginPath();
    ctx.moveTo(40, 88);
    ctx.lineTo(94, 86);
    ctx.lineTo(104, 165);
    ctx.lineTo(28, 165);
    ctx.closePath();
    ctx.fill();

    // Warm film tint vignette
    const vig = ctx.createRadialGradient(90, 90, 35, 90, 90, 128);
    vig.addColorStop(0, 'rgba(255, 190, 160, 0.04)');
    vig.addColorStop(1, c1 + '44');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, 180, 180);

    return c;
  }

  public update(
    cockpit: CockpitRuntimeState,
    tel: CockpitDisplayTelemetry,
    force = false,
  ): void {
    // Throttle cluster redraws to ~14 Hz (smooth needles, zero frame hitch)
    if (force || tel.timeSec - this.lastClusterDrawSec >= 0.07) {
      this.drawInstrumentCluster(cockpit, tel);
      this.clusterTexture.needsUpdate = true;
      this.lastClusterDrawSec = tel.timeSec;
    }

    // Redraw SYNC 4 immediately on touch/dirty flag or once per second for progress bar
    if (force || cockpit.screenDirty || tel.timeSec - this.lastSyncDrawSec >= 0.45) {
      this.drawSync4Screen(cockpit, tel);
      this.syncTexture.needsUpdate = true;
      this.lastSyncDrawSec = tel.timeSec;
      cockpit.screenDirty = false;
    }
  }

  // =========================================================================
  // 1. 12" DIGITAL INSTRUMENT CLUSTER (Exact layout matching Reference Image 1)
  // =========================================================================
  private drawInstrumentCluster(
    cockpit: CockpitRuntimeState,
    tel: CockpitDisplayTelemetry,
  ): void {
    const ctx = this.clusterCtx;
    const W = 1024;
    const H = 384;

    // Blit pre-rendered static OLED backdrop, divider, labels, tachometer ring & 0..7 ticks
    ctx.drawImage(this.clusterStaticCanvas, 0, 0);

    // Center clock ("6:30 AM") + Live Automotive Lighting Telltales (Headlights / High Beam / Lightbar / Hazard!)
    ctx.fillStyle = '#e5ebf2';
    ctx.font = '600 20px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cockpit.clockText, W * 0.5, 42);

    const hazardLit = computeHazardFlash01(tel.timeSec, cockpit.hazardOn) > 0.2;
    if (hazardLit) {
      // Blinking green/amber turn-signal arrows flanking clock
      ctx.fillStyle = '#22c55e';
      ctx.font = '900 26px "Inter", system-ui, sans-serif';
      ctx.fillText('◀', W * 0.5 - 110, 43);
      ctx.fillText('▶', W * 0.5 + 110, 43);
    }

    // Headlight telltale (green low-beam / vivid blue high-beam)
    if (cockpit.headlightMode !== 'off') {
      const isHigh = cockpit.headlightMode === 'high';
      const hx = 225;
      const hy = 42;
      ctx.fillStyle = isHigh ? '#38bdf8' : '#22c55e';
      ctx.beginPath();
      ctx.arc(hx, hy, 10, -Math.PI * 0.5, Math.PI * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = isHigh ? '#38bdf8' : '#22c55e';
      ctx.lineWidth = 2.5;
      for (let r = -1; r <= 1; r++) {
        ctx.beginPath();
        ctx.moveTo(hx - 4, hy + r * 6);
        ctx.lineTo(hx - 16, hy + r * 6 + (isHigh ? 0 : 4));
        ctx.stroke();
      }
    }

    // Roof Lightbar active badge
    if (cockpit.lightbarOn) {
      ctx.fillStyle = '#e0f2fe';
      ctx.font = '800 15px "Inter", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('AUX LED', 260, 43);
    }

    // Subtle RT/PT GI badge on upper right beside temp
    if (cockpit.rayTracedLighting) {
      const amb = getActiveAmbientPreset(cockpit);
      ctx.fillStyle = amb.hex;
      ctx.font = '800 14px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText('RT·GI', W - 120, 43);
    }

    // Right outside temp ("11°C")
    ctx.fillStyle = '#e5ebf2';
    ctx.font = '600 20px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(cockpit.ambientTempC)}°C`, W - 36, 42);

    // --- LEFT TELEMETRY COLUMN (dynamic numeric values + fuel fill only) ---
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f2f6fb';
    ctx.font = '700 38px "JetBrains Mono", monospace';
    ctx.fillText(`${Math.floor(cockpit.odometerKm)}`, 38, 166);

    ctx.font = '700 34px "JetBrains Mono", monospace';
    ctx.fillText(`${cockpit.tripKm.toFixed(1)}`, 38, 260);

    const barX = 104;
    const barY = 318;
    const barW = 148;
    const barH = 14;
    const fuelW = Math.max(8, barW * cockpit.fuelLevel01);
    ctx.fillStyle = cockpit.fuelLevel01 < 0.16 ? '#ef4444' : '#e6edf6';
    roundRectPath(ctx, barX, barY, fuelW, barH, 5);
    ctx.fill();

    // --- CENTER CIRCULAR TACHOMETER (dynamic RPM arc + indicator tip + digital km/h) ---
    const cx = W * 0.5;
    const cy = 228;
    const r = 132;
    const startAng = Math.PI * 0.78;
    const endAng = Math.PI * 2.22;
    const span = endAng - startAng;

    const rpmClamped = Math.max(0, Math.min(7000, tel.rpm));
    const rpmFrac = rpmClamped / 7000;
    const curAng = startAng + rpmFrac * span;
    ctx.strokeStyle = this.clusterArcGrad;
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAng, Math.max(startAng + 0.04, curAng));
    ctx.stroke();

    // Crisp illuminated amber RPM indicator tip
    const tipX = cx + Math.cos(curAng) * (r - 4);
    const tipY = cy + Math.sin(curAng) * (r - 4);
    ctx.fillStyle = '#fb923c';
    ctx.beginPath();
    ctx.arc(tipX, tipY, 7, 0, Math.PI * 2);
    ctx.fill();

    // Large crisp digital speed readout inside dial center ("0" / "84")
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 92px "JetBrains Mono", "Inter", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(tel.speedKmh)}`, cx, cy - 2);

    // --- LIVE MECHANICAL & DAMAGE WARNING TELLTALES (bottom center under dial) ---
    const dmg = tel.damage;
    const anyFlat = dmg.wheels.some((w) => w.punctured);
    const overheated = dmg.coolantTempC >= 78;
    const driveLimit = dmg.engineHealth01 < 0.85;
    const alignFault = Math.abs(dmg.steeringPullRad) > 0.04;
    const warnY = 348;

    if (overheated) {
      ctx.fillStyle = '#ef4444';
      ctx.font = '800 18px "Inter", system-ui, sans-serif';
      ctx.fillText(`THERM ${Math.round(dmg.coolantTempC)}°C`, cx - 122, warnY);
    } else if (driveLimit) {
      ctx.fillStyle = '#f59e0b';
      ctx.font = '800 18px "Inter", system-ui, sans-serif';
      ctx.fillText('DRIVE LIM', cx - 116, warnY);
    }
    if (dmg.overallIntegrityPct < 96 || dmg.windshieldCrackLevel > 0) {
      ctx.fillStyle = dmg.overallIntegrityPct < 55 ? '#ef4444' : '#f59e0b';
      ctx.font = '800 18px "Inter", system-ui, sans-serif';
      ctx.fillText(`BODY ${Math.round(dmg.overallIntegrityPct)}%`, cx + 6, warnY);
    }
    if (anyFlat) {
      ctx.fillStyle = '#facc15';
      ctx.font = '800 18px "Inter", system-ui, sans-serif';
      ctx.fillText('(!) FLAT', cx + 124, warnY);
    } else if (alignFault) {
      ctx.fillStyle = '#fb923c';
      ctx.font = '800 17px "Inter", system-ui, sans-serif';
      ctx.fillText('ALIGN', cx + 120, warnY);
    }

    // --- RIGHT GEAR & 4x4 DRIVE MODE COLUMN (P R N D1, [4H], REAR LOCKED, NORMAL) ---
    const rx = W - 150;
    const gearLabels = ['P', 'R', 'N', 'D'];
    const activeGearChar = tel.gear === 'R' ? 'R' : tel.gear === 'N' ? 'D' : 'D';
    const gearNumber = tel.gear === 'N' || tel.gear === 'R' ? '1' : tel.gear;

    ctx.textAlign = 'center';
    for (let i = 0; i < gearLabels.length; i++) {
      const gx = rx - 82 + i * 48;
      const isAct = gearLabels[i] === activeGearChar;
      ctx.fillStyle = isAct ? '#ffffff' : '#5e6875';
      ctx.font = isAct ? '800 36px "Inter", system-ui, sans-serif' : '600 24px "Inter", system-ui, sans-serif';
      const txt = isAct && activeGearChar === 'D' ? `D${gearNumber}` : gearLabels[i];
      ctx.fillText(txt, gx + (isAct && activeGearChar === 'D' ? 14 : 0), 132);
    }

    // Boxed Amber 4H / 4L Transfer Case Indicator (exact match to Image 1!)
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 3.5;
    roundRectPath(ctx, rx - 58, 178, 116, 56, 10);
    ctx.stroke();
    ctx.fillStyle = 'rgba(245, 158, 11, 0.14)';
    ctx.fill();

    ctx.fillStyle = '#fb923c';
    ctx.font = '800 34px "Inter", system-ui, sans-serif';
    ctx.fillText(tel.driveMode, rx, 208);

    // REAR LOCKED & Drive Terrain Mode
    ctx.fillStyle = '#f59e0b';
    ctx.font = '800 21px "Inter", system-ui, sans-serif';
    ctx.fillText('REAR LOCKED', rx, 272);

    ctx.fillStyle = '#f1f5f9';
    ctx.font = '700 26px "Inter", system-ui, sans-serif';
    const modeLabel =
      tel.driveMode === '4L'
        ? 'ROCK CRAWL'
        : tel.biome === 'rainy_highway'
          ? 'NORMAL'
          : tel.biome === 'mud_grass'
            ? 'MUD / RUTS'
            : 'BAJA';
    ctx.fillText(modeLabel, rx, 316);
  }

  // =========================================================================
  // 2. 12" SYNC 4 INTERACTIVE TOUCHSCREEN (Exact match to Reference Image 1)
  // =========================================================================
  private drawSync4Screen(
    cockpit: CockpitRuntimeState,
    tel: CockpitDisplayTelemetry,
  ): void {
    const ctx = this.syncCtx;
    const W = 768;
    const H = 512;

    const activeAmb = getActiveAmbientPreset(cockpit);

    // Deep glossy dark SYNC 4 background with subtle ambient top sheen
    ctx.fillStyle = '#090b0f';
    ctx.fillRect(0, 0, W, H);
    if (cockpit.ambientLightOn) {
      const topGlow = ctx.createLinearGradient(0, 0, W, 120);
      topGlow.addColorStop(0, activeAmb.hex + '1e');
      topGlow.addColorStop(0.5, activeAmb.hex + '08');
      topGlow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = topGlow;
      ctx.fillRect(0, 0, W, 110);
    }

    // --- TOP STATUS BAR (y: 0..48) ---
    ctx.fillStyle = '#e8edf4';
    ctx.font = '700 22px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(cockpit.clockText, 28, 28);

    // Quick-status RT GI pill in top status bar (clickable -> jumps to Luzes!)
    ctx.fillStyle = cockpit.rayTracedLighting ? '#141e2a' : '#15171d';
    roundRectPath(ctx, 418, 10, 174, 36, 18);
    ctx.fill();
    ctx.strokeStyle = cockpit.rayTracedLighting ? activeAmb.hex + 'cc' : 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = cockpit.rayTracedLighting ? activeAmb.hex : '#64748b';
    ctx.beginPath();
    ctx.arc(438, 28, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = cockpit.rayTracedLighting ? '#f8fafc' : '#64748b';
    ctx.font = '800 16px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(cockpit.rayTracedLighting ? 'RT PATH GI' : 'RT OFF', 452, 29);

    // Cellular signal bars + temp on top right
    for (let b = 0; b < 4; b++) {
      ctx.fillStyle = b < 3 ? '#dce4ee' : '#4a5462';
      const bh = 6 + b * 4;
      ctx.fillRect(W - 148 + b * 8, 34 - bh, 5, bh);
    }
    ctx.fillStyle = '#e8edf4';
    ctx.font = '700 22px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(cockpit.ambientTempC)}°C`, W - 26, 28);

    // --- TAB CONTENT AREA (y: 52..424) ---
    if (cockpit.activeTab === 'audio' || cockpit.activeTab === 'home') {
      this.drawAudioTab(ctx, W, cockpit);
    } else if (cockpit.activeTab === 'lights') {
      this.drawLightsTab(ctx, W, cockpit, tel);
    } else if (cockpit.activeTab === 'mirrors') {
      this.drawMirrorsTab(ctx, W, cockpit);
    } else if (cockpit.activeTab === 'apps') {
      this.drawAppsTab(ctx, W, tel);
    } else {
      this.drawSettingsTab(ctx, W, cockpit, tel);
    }

    // --- BOTTOM 6-TAB NAVIGATION BAR (y: 430..512) ---
    ctx.fillStyle = '#0d1016';
    ctx.fillRect(0, 430, W, 82);
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 430);
    ctx.lineTo(W, 430);
    ctx.stroke();

    const tabs: Array<{ id: InfotainmentTab; label: string; accent: string }> = [
      { id: 'home', label: 'Home', accent: '#22c55e' },
      { id: 'audio', label: 'Audio', accent: '#22c55e' },
      { id: 'lights', label: 'Luzes', accent: activeAmb.hex },
      { id: 'mirrors', label: 'Espelhos', accent: '#38bdf8' },
      { id: 'apps', label: '4×4', accent: '#f59e0b' },
      { id: 'settings', label: 'Config', accent: '#94a3b8' },
    ];
    const tabW = W / tabs.length;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      const active = cockpit.activeTab === t.id;
      const tx = tabW * (i + 0.5);
      ctx.fillStyle = active ? '#ffffff' : '#8e98a6';
      ctx.font = active ? '800 20px "Inter", system-ui, sans-serif' : '600 19px "Inter", system-ui, sans-serif';
      ctx.fillText(t.label, tx, 469);

      if (active) {
        ctx.fillStyle = t.accent;
        roundRectPath(ctx, tx - 34, 492, 68, 5, 3);
        ctx.fill();
      }
    }
  }

  private drawAudioTab(
    ctx: CanvasRenderingContext2D,
    W: number,
    cockpit: CockpitRuntimeState,
  ): void {
    // Source Pills: "Radio" & "Spotify" (vivid green when active, exact match to Image 1!)
    const isSpotify = cockpit.mediaSource === 'spotify';
    const activeAmb = getActiveAmbientPreset(cockpit);

    // Radio pill
    ctx.fillStyle = !isSpotify ? '#22c55e' : '#1b2028';
    roundRectPath(ctx, 28, 58, 102, 42, 21);
    ctx.fill();
    ctx.fillStyle = !isSpotify ? '#051a0c' : '#d5dde7';
    ctx.font = '700 20px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Radio', 79, 79);

    // Spotify pill
    ctx.fillStyle = isSpotify ? '#22c55e' : '#1b2028';
    roundRectPath(ctx, 144, 58, 122, 42, 21);
    ctx.fill();
    ctx.fillStyle = isSpotify ? '#051a0c' : '#d5dde7';
    ctx.fillText('Spotify', 205, 79);

    // Quick-Access Vehicle Studio Chips on right (Luzes & Espelhos -> 1-tap from main screen!)
    ctx.fillStyle = '#161c26';
    roundRectPath(ctx, 412, 58, 152, 42, 21);
    ctx.fill();
    ctx.strokeStyle = activeAmb.hex + '99';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = activeAmb.hex;
    ctx.font = '800 18px "Inter", system-ui, sans-serif';
    ctx.fillText('☀ LUZES RT', 488, 79);

    ctx.fillStyle = '#161c26';
    roundRectPath(ctx, 578, 58, 162, 42, 21);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = '#7dd3fc';
    ctx.fillText('◈ ESPELHOS', 659, 79);

    // Main dark rounded media player card
    ctx.fillStyle = '#141820';
    roundRectPath(ctx, 28, 118, W - 56, 232, 22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (isSpotify) {
      const track = RAPTOR_PLAYLIST[cockpit.trackIndex % RAPTOR_PLAYLIST.length];

      // Album cover art square with rounded corners
      ctx.save();
      roundRectPath(ctx, 50, 140, 186, 186, 16);
      ctx.clip();
      ctx.drawImage(this.albumArtCanvas, 50, 140, 186, 186);
      // Subtle tint variation for tracks 2-4
      if (cockpit.trackIndex > 0) {
        ctx.fillStyle = track.accentHex + '40';
        ctx.fillRect(50, 140, 186, 186);
      }
      ctx.restore();

      // Track metadata right of cover
      ctx.textAlign = 'left';
      ctx.fillStyle = '#22c55e';
      ctx.font = '800 18px "Inter", system-ui, sans-serif';
      ctx.fillText('SPOTIFY', 258, 166);

      ctx.fillStyle = '#ffffff';
      ctx.font = '800 42px "Inter", system-ui, sans-serif';
      ctx.fillText(track.title, 258, 212);

      ctx.fillStyle = '#c5ceda';
      ctx.font = '600 24px "Inter", system-ui, sans-serif';
      ctx.fillText(track.artist, 258, 254);

      ctx.fillStyle = '#7e8896';
      ctx.font = '500 20px "Inter", system-ui, sans-serif';
      ctx.fillText(track.album, 258, 288);

      // Transport Controls (Prev / White Circular Play-Pause / Next) on right side of card
      const btnY = 290;
      this.drawTransportControls(ctx, 480, 588, 682, btnY, cockpit.isPlaying);

      // Vivid green progress bar below card (matches Image 1!)
      const pX = 32;
      const pY = 374;
      const pW = W - 64;
      const frac = Math.max(0, Math.min(1, cockpit.trackElapsedSec / Math.max(1, track.durationSec)));

      ctx.fillStyle = '#272e3a';
      roundRectPath(ctx, pX, pY, pW, 8, 4);
      ctx.fill();

      ctx.fillStyle = '#22c55e';
      roundRectPath(ctx, pX, pY, Math.max(12, pW * frac), 8, 4);
      ctx.fill();

      // Glowing green scrubber thumb
      ctx.beginPath();
      ctx.arc(pX + pW * frac, pY + 4, 8, 0, Math.PI * 2);
      ctx.fill();

      // Elapsed ("0:40"), caption ("Playing on Spotify"), Remaining ("-1:51")
      ctx.fillStyle = '#cbd4e0';
      ctx.font = '600 18px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(formatTrackTime(cockpit.trackElapsedSec), pX, 404);

      ctx.fillStyle = '#8b95a3';
      ctx.font = '600 18px "Inter", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(cockpit.isPlaying ? 'Playing on Spotify' : 'Paused on Spotify', W * 0.5, 404);

      const remSec = Math.max(0, track.durationSec - cockpit.trackElapsedSec);
      ctx.fillStyle = '#cbd4e0';
      ctx.font = '600 18px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`-${formatTrackTime(remSec)}`, W - 32, 404);
    } else {
      const station = RAPTOR_RADIO_STATIONS[cockpit.stationIndex % RAPTOR_RADIO_STATIONS.length];
      ctx.textAlign = 'left';
      ctx.fillStyle = '#22c55e';
      ctx.font = '800 20px "Inter", system-ui, sans-serif';
      ctx.fillText('FM STEREO · HD RADIO', 56, 162);

      ctx.fillStyle = '#ffffff';
      ctx.font = '800 62px "JetBrains Mono", monospace';
      ctx.fillText(station.freq, 56, 224);

      ctx.fillStyle = '#d1dae5';
      ctx.font = '700 28px "Inter", system-ui, sans-serif';
      ctx.fillText(station.name, 56, 278);

      ctx.fillStyle = '#828d9c';
      ctx.font = '500 21px "Inter", system-ui, sans-serif';
      ctx.fillText(station.genre, 56, 314);

      this.drawTransportControls(ctx, 480, 588, 682, 290, cockpit.isPlaying);

      // FM Tuner Scale bar below card
      ctx.fillStyle = '#202732';
      roundRectPath(ctx, 32, 372, W - 64, 14, 7);
      ctx.fill();
      const markerX = 140 + cockpit.stationIndex * 220;
      ctx.fillStyle = '#22c55e';
      roundRectPath(ctx, markerX, 366, 12, 26, 4);
      ctx.fill();
      ctx.fillStyle = '#9aa6b5';
      ctx.font = '600 18px "Inter", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Tuned to ${station.freq} · ${station.name}`, W * 0.5, 408);
    }
  }

  private drawTransportControls(
    ctx: CanvasRenderingContext2D,
    prevX: number,
    playX: number,
    nextX: number,
    cy: number,
    isPlaying: boolean,
  ): void {
    // Prev button (|<)
    ctx.fillStyle = '#d8e0ea';
    ctx.fillRect(prevX - 14, cy - 11, 4, 22);
    ctx.beginPath();
    ctx.moveTo(prevX + 12, cy - 11);
    ctx.lineTo(prevX - 8, cy);
    ctx.lineTo(prevX + 12, cy + 11);
    ctx.closePath();
    ctx.fill();

    // Circular white Play/Pause primary button
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(playX, cy, 31, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#0c0f14';
    if (isPlaying) {
      ctx.fillRect(playX - 9, cy - 12, 6, 24);
      ctx.fillRect(playX + 3, cy - 12, 6, 24);
    } else {
      ctx.beginPath();
      ctx.moveTo(playX - 7, cy - 13);
      ctx.lineTo(playX + 14, cy);
      ctx.lineTo(playX - 7, cy + 13);
      ctx.closePath();
      ctx.fill();
    }

    // Next button (>|)
    ctx.fillStyle = '#d8e0ea';
    ctx.fillRect(nextX + 10, cy - 11, 4, 22);
    ctx.beginPath();
    ctx.moveTo(nextX - 12, cy - 11);
    ctx.lineTo(nextX + 8, cy);
    ctx.lineTo(nextX - 12, cy + 11);
    ctx.closePath();
    ctx.fill();
  }

  // =========================================================================
  // LUZES & RAY TRACING / PATH TRACING GI STUDIO TAB
  // =========================================================================
  private drawLightsTab(
    ctx: CanvasRenderingContext2D,
    W: number,
    cockpit: CockpitRuntimeState,
    tel: CockpitDisplayTelemetry,
  ): void {
    const activeAmb = getActiveAmbientPreset(cockpit);
    const hazardPulse = computeHazardFlash01(tel.timeSec, cockpit.hazardOn);

    // Section title
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '800 22px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('ILUMINAÇÃO & RAY TRACING STUDIO', 28, 68);

    const drawToggleCard = (
      x: number,
      y: number,
      w: number,
      h: number,
      title: string,
      statusText: string,
      active: boolean,
      accent: string,
      iconDraw: (cx: number, cy: number, col: string) => void,
    ) => {
      // Card fill with subtle glowing tint when active
      const grad = ctx.createLinearGradient(x, y, x, y + h);
      if (active) {
        grad.addColorStop(0, accent + '36');
        grad.addColorStop(1, '#121721');
      } else {
        grad.addColorStop(0, '#141923');
        grad.addColorStop(1, '#0f131b');
      }
      ctx.fillStyle = grad;
      roundRectPath(ctx, x, y, w, h, 16);
      ctx.fill();

      ctx.strokeStyle = active ? accent + 'cc' : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = active ? 2.2 : 1.3;
      ctx.stroke();

      // Status indicator dot
      ctx.fillStyle = active ? accent : '#3a4250';
      ctx.beginPath();
      ctx.arc(x + w - 18, y + 18, 5, 0, Math.PI * 2);
      ctx.fill();

      // Custom crisp vector icon on left
      iconDraw(x + 36, y + h * 0.5, active ? accent : '#64748b');

      // Label & status on right
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '800 18px "Inter", system-ui, sans-serif';
      ctx.fillText(title, x + 68, y + 31);

      ctx.fillStyle = active ? accent : '#64748b';
      ctx.font = '700 16px "JetBrains Mono", monospace';
      ctx.fillText(statusText, x + 68, y + 57);
    };

    // --- ROW 1 (y: 88..172 -> norm 0.17..0.34): Exterior Lamps ---
    const hlActive = cockpit.headlightMode !== 'off';
    const hlAccent = cockpit.headlightMode === 'high' ? '#38bdf8' : '#22c55e';
    const hlLabel =
      cockpit.headlightMode === 'high'
        ? 'ALTO · 100%'
        : cockpit.headlightMode === 'low'
          ? 'BAIXO · ON'
          : 'DESLIGADO';

    drawToggleCard(26, 88, 232, 82, 'FARÓIS', hlLabel, hlActive, hlAccent, (cx, cy, col) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(cx + 4, cy, 12, -Math.PI * 0.5, Math.PI * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.6;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(cx - 2, cy + i * 7);
        ctx.lineTo(cx - 16, cy + i * 7 + (cockpit.headlightMode === 'high' ? 0 : 4));
        ctx.stroke();
      }
    });

    drawToggleCard(
      268,
      88,
      232,
      82,
      'BARRA LED',
      cockpit.lightbarOn ? 'TETO · ON' : 'OFF',
      cockpit.lightbarOn,
      '#e0f2fe',
      (cx, cy, col) => {
        ctx.fillStyle = col;
        roundRectPath(ctx, cx - 18, cy - 5, 36, 10, 4);
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.moveTo(cx + i * 10, cy - 9);
          ctx.lineTo(cx + i * 13, cy - 17);
          ctx.stroke();
        }
      },
    );

    drawToggleCard(
      510,
      88,
      232,
      82,
      'GRADE ÂMBAR',
      cockpit.grilleAmberOn ? 'R1T · ON' : 'OFF',
      cockpit.grilleAmberOn,
      '#f59e0b',
      (cx, cy, col) => {
        ctx.fillStyle = col;
        for (let i = -1; i <= 1; i++) {
          roundRectPath(ctx, cx + i * 13 - 4, cy - 4, 9, 8, 2);
          ctx.fill();
        }
      },
    );

    // --- ROW 2 (y: 182..266 -> norm 0.36..0.53): Signals & Cabin Lights ---
    const hazAccent = hazardPulse > 0.3 ? '#ff5514' : '#ef4444';
    drawToggleCard(
      26,
      182,
      232,
      82,
      'PISCA-ALERTA',
      cockpit.hazardOn ? 'PISCANDO' : 'OFF',
      cockpit.hazardOn,
      hazAccent,
      (cx, cy, col) => {
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(cx, cy - 14);
        ctx.lineTo(cx + 15, cy + 12);
        ctx.lineTo(cx - 15, cy + 12);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy - 6);
        ctx.lineTo(cx + 7, cy + 7);
        ctx.lineTo(cx - 7, cy + 7);
        ctx.closePath();
        ctx.stroke();
      },
    );

    drawToggleCard(
      268,
      182,
      232,
      82,
      'LUZ DE TETO',
      cockpit.domeLightOn ? 'CABINE · ON' : 'OFF',
      cockpit.domeLightOn,
      '#fde68a',
      (cx, cy, col) => {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(cx, cy - 6, 10, 0, Math.PI);
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.2;
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.moveTo(cx + i * 7, cy + 6);
          ctx.lineTo(cx + i * 11, cy + 15);
          ctx.stroke();
        }
      },
    );

    drawToggleCard(
      510,
      182,
      232,
      82,
      'LED AMBIENTE',
      cockpit.ambientLightOn ? activeAmb.label.toUpperCase() : 'OFF',
      cockpit.ambientLightOn,
      activeAmb.hex,
      (cx, cy, col) => {
        ctx.strokeStyle = col;
        ctx.lineWidth = 4.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - 16, cy + 4);
        ctx.quadraticCurveTo(cx, cy - 12, cx + 16, cy + 4);
        ctx.stroke();
      },
    );

    // --- ROW 3 (y: 280..344 -> norm 0.55..0.68): 6 Ambient LED Swatches + Intensity Stepper ---
    ctx.fillStyle = '#121722';
    roundRectPath(ctx, 26, 280, 484, 64, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    const swatchCount = AMBIENT_LIGHT_PRESETS.length;
    const swatchAreaW = 468;
    const swatchStep = swatchAreaW / swatchCount;
    for (let i = 0; i < swatchCount; i++) {
      const preset = AMBIENT_LIGHT_PRESETS[i];
      const sx = 34 + swatchStep * (i + 0.5);
      const sy = 312;
      const selected = i === cockpit.ambientColorIndex && cockpit.ambientLightOn;

      if (selected) {
        ctx.fillStyle = preset.hex + '44';
        ctx.beginPath();
        ctx.arc(sx, sy, 24, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.arc(sx, sy, 19, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = preset.hex;
      ctx.beginPath();
      ctx.arc(sx, sy, 15, 0, Math.PI * 2);
      ctx.fill();
    }

    // Intensity - / % / + box (x: 522..742)
    ctx.fillStyle = '#121722';
    roundRectPath(ctx, 522, 280, 220, 64, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.stroke();

    ctx.fillStyle = '#1f2837';
    roundRectPath(ctx, 532, 290, 52, 44, 10);
    ctx.fill();
    roundRectPath(ctx, 680, 290, 52, 44, 10);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '800 30px sans-serif';
    ctx.fillText('−', 558, 312);
    ctx.fillText('+', 706, 312);

    ctx.fillStyle = activeAmb.hex;
    ctx.font = '800 22px "JetBrains Mono", monospace';
    ctx.fillText(`${Math.round(cockpit.ambientIntensity * 100)}%`, 632, 313);

    // --- ROW 4 (y: 356..418 -> norm 0.70..0.82): RAY TRACING / PATH TRACING GI ENGINE BAR ---
    const rtOn = cockpit.rayTracedLighting;
    const rtGrad = ctx.createLinearGradient(26, 356, 444, 418);
    if (rtOn) {
      rtGrad.addColorStop(0, activeAmb.hex + '44');
      rtGrad.addColorStop(0.6, '#152236');
      rtGrad.addColorStop(1, '#101827');
    } else {
      rtGrad.addColorStop(0, '#141923');
      rtGrad.addColorStop(1, '#10141c');
    }
    ctx.fillStyle = rtGrad;
    roundRectPath(ctx, 26, 356, 418, 62, 14);
    ctx.fill();
    ctx.strokeStyle = rtOn ? activeAmb.hex : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = rtOn ? 2.2 : 1.2;
    ctx.stroke();

    // Prism / light-bounce ray icon
    ctx.strokeStyle = rtOn ? activeAmb.hex : '#64748b';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(48, 398);
    ctx.lineTo(62, 372);
    ctx.lineTo(76, 398);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(38, 386);
    ctx.lineTo(54, 386);
    ctx.moveTo(70, 383);
    ctx.lineTo(86, 375);
    ctx.moveTo(72, 390);
    ctx.lineTo(88, 396);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 19px "Inter", system-ui, sans-serif';
    ctx.fillText('RAY / PATH TRACING GI', 98, 379);
    ctx.fillStyle = rtOn ? activeAmb.hex : '#64748b';
    ctx.font = '700 15px "JetBrains Mono", monospace';
    ctx.fillText(rtOn ? 'REFLEXOS DE ÁREA + MULTI-BOUNCE ON' : 'SOMENTE LUZ PADRÃO (DESLIGADO)', 98, 402);

    // Bounce Intensity / Mode Selector (x: 454..742)
    const modeLabel =
      cockpit.rtBounceStrength >= 1.45
        ? 'PATH GI · ULTRA'
        : cockpit.rtBounceStrength >= 1.0
          ? 'RT GI · ALTO'
          : 'RT GI · PADRÃO';
    ctx.fillStyle = rtOn ? '#192638' : '#12161f';
    roundRectPath(ctx, 454, 356, 288, 62, 14);
    ctx.fill();
    ctx.strokeStyle = rtOn ? '#38bdf8' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = rtOn ? '#e0f2fe' : '#64748b';
    ctx.font = '800 18px "JetBrains Mono", monospace';
    ctx.fillText(modeLabel, 598, 380);
    ctx.fillStyle = rtOn ? '#38bdf8' : '#475569';
    ctx.font = '700 13px "Inter", system-ui, sans-serif';
    ctx.fillText('TOCAR P/ INTENSIDADE DE REFLEXO', 598, 402);
  }

  // =========================================================================
  // ESPELHOS (MOTORIZED WING & INTERIOR MIRROR CONTROL) TAB
  // =========================================================================
  private drawMirrorsTab(
    ctx: CanvasRenderingContext2D,
    W: number,
    cockpit: CockpitRuntimeState,
  ): void {
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '800 22px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('CONTROLE DE RETROVISORES ELÉTRICOS', 28, 68);

    // --- LEFT PANEL: Top-Down Raptor Schematic + L / C / R Selector + Fold + Reset ---
    ctx.fillStyle = '#121722';
    roundRectPath(ctx, 26, 94, 352, 174, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Stylized top-down cab silhouette in center of left card
    const carCx = 202;
    const carCy = 186;
    ctx.fillStyle = '#202938';
    roundRectPath(ctx, carCx - 48, carCy - 58, 96, 122, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.stroke();
    // Windshield band
    ctx.fillStyle = '#0f172a';
    roundRectPath(ctx, carCx - 38, carCy - 36, 76, 26, 6);
    ctx.fill();

    // 3 Interactive Mirror Selection Pods (ESQ / INT / DIR)
    const mirrorPods: Array<{
      id: 'left' | 'interior' | 'right';
      label: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }> = [
      { id: 'left', label: 'ESQ (L)', x: 40, y: 122, w: 102, h: 118 },
      { id: 'interior', label: 'INT (C)', x: 152, y: 110, w: 100, h: 92 },
      { id: 'right', label: 'DIR (R)', x: 262, y: 122, w: 102, h: 118 },
    ];

    for (const pod of mirrorPods) {
      const sel = cockpit.selectedMirror === pod.id;
      ctx.fillStyle = sel ? 'rgba(56, 189, 248, 0.24)' : '#18202e';
      roundRectPath(ctx, pod.x, pod.y, pod.w, pod.h, 14);
      ctx.fill();
      ctx.strokeStyle = sel ? '#38bdf8' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = sel ? 2.6 : 1.2;
      ctx.stroke();

      const mState = cockpit.mirrors[pod.id];
      const yawDeg = Math.round((mState.yawRad * 180) / Math.PI);
      const pitchDeg = Math.round((mState.pitchRad * 180) / Math.PI);

      // Live gaze cone arrow showing current mirror orientation
      const gx = pod.x + pod.w * 0.5;
      const gy = pod.y + pod.h * 0.44;
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(-mState.yawRad * 1.4);
      ctx.fillStyle = sel ? 'rgba(56, 189, 248, 0.35)' : 'rgba(148, 163, 184, 0.16)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-14, 24);
      ctx.lineTo(14, 24);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = sel ? '#38bdf8' : '#94a3b8';
      roundRectPath(ctx, -15, -6, 30, 9, 4);
      ctx.fill();
      ctx.restore();

      ctx.textAlign = 'center';
      ctx.fillStyle = sel ? '#ffffff' : '#cbd5e1';
      ctx.font = '800 16px "Inter", system-ui, sans-serif';
      ctx.fillText(pod.label, gx, pod.y + 22);

      ctx.fillStyle = sel ? '#7dd3fc' : '#64748b';
      ctx.font = '700 13px "JetBrains Mono", monospace';
      ctx.fillText(`${yawDeg >= 0 ? '+' : ''}${yawDeg}° / ${pitchDeg >= 0 ? '+' : ''}${pitchDeg}°`, gx, pod.y + pod.h - 15);
    }

    // Power Fold Button (y: 280..346 -> norm 0.55..0.68)
    const folded = cockpit.mirrorsFolded;
    ctx.fillStyle = folded ? '#0ea5e9' : '#182130';
    roundRectPath(ctx, 26, 280, 352, 66, 14);
    ctx.fill();
    ctx.strokeStyle = folded ? '#7dd3fc' : 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = folded ? '#041724' : '#e0f2fe';
    ctx.font = '800 20px "Inter", system-ui, sans-serif';
    ctx.fillText(folded ? '⇄ ABRIR RETROVISORES' : '⇄ DOBRAR RETROVISORES', 202, 314);

    // Reset All Button (y: 356..418 -> norm 0.70..0.82)
    ctx.fillStyle = '#151b26';
    roundRectPath(ctx, 26, 356, 352, 62, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '700 18px "Inter", system-ui, sans-serif';
    ctx.fillText('⟲ CENTRALIZAR POSIÇÃO PADRÃO', 202, 388);

    // --- RIGHT PANEL: Precision 4-Way Motorized Adjustment D-Pad ---
    ctx.fillStyle = '#121722';
    roundRectPath(ctx, 394, 94, W - 420, 324, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    const cx = 568; // norm 0.74
    const cy = 244; // norm 0.48
    const outerR = 114;

    // Outer metallic ring
    ctx.fillStyle = '#182232';
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.4;
    ctx.stroke();

    // Diagonal quadrant separators
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1.6;
    for (const a of [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * 38, cy + Math.sin(a) * 38);
      ctx.lineTo(cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR);
      ctx.stroke();
    }

    // Crisp directional arrows
    ctx.fillStyle = '#e0f2fe';
    ctx.font = '900 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▲', cx, cy - 74);
    ctx.fillText('▼', cx, cy + 76);
    ctx.fillText('◀', cx - 76, cy + 1);
    ctx.fillText('▶', cx + 76, cy + 1);

    // Center bullseye reset button
    ctx.fillStyle = '#0ea5e9';
    ctx.beginPath();
    ctx.arc(cx, cy, 36, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#041724';
    ctx.font = '900 18px "JetBrains Mono", monospace';
    ctx.fillText('0°', cx, cy + 1);

    // Active Mirror Telemetry Readout at bottom of D-Pad card
    const activeMir = cockpit.mirrors[cockpit.selectedMirror];
    const yawD = Math.round((activeMir.yawRad * 180) / Math.PI);
    const pitchD = Math.round((activeMir.pitchRad * 180) / Math.PI);
    const selName =
      cockpit.selectedMirror === 'left'
        ? 'ESQUERDO'
        : cockpit.selectedMirror === 'right'
          ? 'DIREITO'
          : 'INTERNO';

    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 15px "Inter", system-ui, sans-serif';
    ctx.fillText(`AJUSTANDO: ${selName}`, cx, 114);

    ctx.fillStyle = '#38bdf8';
    ctx.font = '800 18px "JetBrains Mono", monospace';
    ctx.fillText(
      `YAW ${yawD >= 0 ? '+' : ''}${yawD}°   ·   PITCH ${pitchD >= 0 ? '+' : ''}${pitchD}°`,
      cx,
      392,
    );
  }

  private drawAppsTab(
    ctx: CanvasRenderingContext2D,
    W: number,
    tel: CockpitDisplayTelemetry,
  ): void {
    ctx.fillStyle = '#f59e0b';
    ctx.font = '800 24px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('RIVIAN 4×4 TELEMETRY & DIAGNOSTICS', 34, 84);

    // Left card: Pitch & Roll Inclinometer
    ctx.fillStyle = '#141922';
    roundRectPath(ctx, 34, 118, 332, 282, 18);
    ctx.fill();

    ctx.fillStyle = '#9aa6b5';
    ctx.font = '700 18px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PITCH / ROLL', 200, 148);

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 42px "JetBrains Mono", monospace';
    ctx.fillText(`${Math.round(tel.pitchDeg)}°  /  ${Math.round(tel.rollDeg)}°`, 200, 214);

    ctx.fillStyle = '#f59e0b';
    ctx.font = '700 22px "Inter", system-ui, sans-serif';
    ctx.fillText(`TRANSFER: ${tel.driveMode}`, 200, 290);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '600 20px "Inter", system-ui, sans-serif';
    ctx.fillText(`REAR DIFF: LOCKED`, 200, 336);

    // Right card: Live Top-Down Raptor R Structural & Mechanical Health Diagram!
    ctx.fillStyle = '#141922';
    roundRectPath(ctx, 386, 118, W - 420, 282, 18);
    ctx.fill();

    const dmg = tel.damage;
    const zi = dmg.zoneIntegrity;
    const zoneCol = (integrity01: number) =>
      integrity01 < 0.45 ? '#ef4444' : integrity01 < 0.8 ? '#f59e0b' : '#22c55e';

    const tx = 500;
    const ty = 248;
    // Top-down truck silhouette zones
    ctx.fillStyle = zoneCol(zi.front);
    roundRectPath(ctx, tx - 44, ty - 90, 88, 44, 10);
    ctx.fill();
    ctx.fillStyle = zoneCol(zi.roof);
    roundRectPath(ctx, tx - 42, ty - 42, 84, 62, 8);
    ctx.fill();
    ctx.fillStyle = zoneCol(zi.rear);
    roundRectPath(ctx, tx - 44, ty + 24, 88, 52, 10);
    ctx.fill();
    ctx.fillStyle = zoneCol(zi.left);
    ctx.fillRect(tx - 56, ty - 44, 10, 114);
    ctx.fillStyle = zoneCol(zi.right);
    ctx.fillRect(tx + 46, ty - 44, 10, 114);

    // 4 wheels status
    const wCoords = [
      [tx - 62, ty - 68],
      [tx + 48, ty - 68],
      [tx - 62, ty + 38],
      [tx + 48, ty + 38],
    ];
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = dmg.wheels[i].punctured ? '#ef4444' : dmg.wheels[i].damage01 > 0.3 ? '#f59e0b' : '#22c55e';
      ctx.fillRect(wCoords[i][0], wCoords[i][1], 14, 28);
    }

    // Mechanical telemetry readout column beside truck diagram
    const mx = 594;
    ctx.textAlign = 'left';
    ctx.font = '700 17px "JetBrains Mono", monospace';
    ctx.fillStyle = dmg.engineHealth01 < 0.82 ? '#f59e0b' : '#4ade80';
    ctx.fillText(`DRV ${Math.round(dmg.engineHealth01 * 100)}%`, mx, 168);

    ctx.fillStyle = dmg.coolantTempC >= 78 ? '#ef4444' : '#cbd5e1';
    ctx.fillText(`THERM ${Math.round(dmg.coolantTempC)}°C`, mx, 206);

    ctx.fillStyle = dmg.radiatorLeak01 > 0.12 ? '#f59e0b' : '#4ade80';
    ctx.fillText(dmg.radiatorLeak01 > 0.12 ? 'CHILLER' : 'THERM OK', mx, 244);

    ctx.fillStyle = dmg.wiperDamaged ? '#f59e0b' : '#94a3b8';
    ctx.fillText(dmg.wiperDamaged ? 'WIPER JAM' : 'WIPER OK', mx, 282);

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 22px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`INTEGRITY ${Math.round(dmg.overallIntegrityPct)}%`, 560, 372);
  }

  private drawSettingsTab(
    ctx: CanvasRenderingContext2D,
    W: number,
    cockpit: CockpitRuntimeState,
    tel: CockpitDisplayTelemetry,
  ): void {
    ctx.fillStyle = '#e8edf4';
    ctx.font = '800 24px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('CONTROLES DO VEÍCULO & CLIMA', 30, 72);

    // Row 1 (y: 94..184 -> norm 0.18..0.36): Wiper Speed
    ctx.fillStyle = '#17202d';
    roundRectPath(ctx, 30, 94, W - 60, 86, 16);
    ctx.fill();
    ctx.fillStyle = '#22c55e';
    ctx.font = '800 24px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`LIMPADORES: ${cockpit.wiperMode.toUpperCase()}  (TOCAR)`, W * 0.5, 138);

    // Row 2 (y: 196..284 -> norm 0.38..0.56): Climate - / Temp + / A/C
    ctx.fillStyle = '#151c27';
    roundRectPath(ctx, 30, 196, 224, 86, 16);
    ctx.fill();
    ctx.fillStyle = '#60a5fa';
    ctx.font = '800 28px "Inter", system-ui, sans-serif';
    ctx.fillText(`−  ${cockpit.cabinTempC}°C`, 142, 240);

    ctx.fillStyle = '#151c27';
    roundRectPath(ctx, 272, 196, 224, 86, 16);
    ctx.fill();
    ctx.fillStyle = '#f87171';
    ctx.fillText(`+  TEMP`, 384, 240);

    ctx.fillStyle = cockpit.acOn ? '#1d4ed8' : '#1b2230';
    roundRectPath(ctx, 514, 196, 224, 86, 16);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 24px "Inter", system-ui, sans-serif';
    ctx.fillText(cockpit.acOn ? 'A/C · ON' : 'A/C · OFF', 626, 240);

    // Row 3 (y: 298..396 -> norm 0.58..0.78): 4H/4L & Repair
    ctx.fillStyle = '#222a36';
    roundRectPath(ctx, 30, 298, 344, 96, 16);
    ctx.fill();
    ctx.fillStyle = '#fb923c';
    ctx.font = '800 25px "Inter", system-ui, sans-serif';
    ctx.fillText(`TRAÇÃO: ${tel.driveMode}`, 202, 347);

    ctx.fillStyle = '#1e3a2f';
    roundRectPath(ctx, 394, 298, 344, 96, 16);
    ctx.fill();
    ctx.fillStyle = '#4ade80';
    ctx.fillText('REPARAR RIVIAN R1T', 566, 347);
  }

  public dispose(): void {
    this.clusterTexture.dispose();
    this.syncTexture.dispose();
  }
}
