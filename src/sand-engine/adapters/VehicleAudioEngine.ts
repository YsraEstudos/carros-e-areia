/**
 * VehicleAudioEngine.ts
 * 100% Procedural Web Audio API 4x4 Turbo-Diesel & Granular Sand/Mud Foley Synthesizer
 * (zero external audio files, zero network fetches, safe autoplay unlock on first user gesture).
 *
 * Layered acoustic channels:
 *  1. Heavy Turbo-Diesel V6/V8 Clatter & Sub-Bass Rumble (RPM + throttle + 4L load)
 *  2. High-Q Turbocharger Spool Whistle & Pneumatic Blow-Off Valve flutter on lift-off
 *  3. Granular Tire-on-Sand Crunch / Wet Sloppy Mud Squelch (driven by live sinkage, slip & biome)
 *  4. Subtle Desert Wind Ambience (scales with windSpeed & vehicle speed)
 */

import { EnvironmentBiome } from '../core/SandParams';

export interface VehicleAudioState {
  rpm: number;
  throttle: number;
  speedMs: number;
  avgSinkageM: number;
  avgSlip: number;
  driftDeg: number;
  boostActive: boolean;
  windSpeed: number;
  biome: EnvironmentBiome;
  isLowRange: boolean;
  /** Optional Phase 4/5 cabin audio & engine damage signals */
  cabinMusicPlaying?: boolean;
  cabinMediaSource?: 'spotify' | 'radio';
  cabinTrackIndex?: number;
  isCockpitView?: boolean;
  engineHealth01?: number;
}

export class VehicleAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  // Engine voices
  private oscMain: OscillatorNode | null = null;
  private oscSub: OscillatorNode | null = null;
  private oscHarm: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;

  // Turbo spool & blow-off
  private turboOsc: OscillatorNode | null = null;
  private turboFilter: BiquadFilterNode | null = null;
  private turboGain: GainNode | null = null;
  private bovFilter: BiquadFilterNode | null = null;
  private bovGain: GainNode | null = null;

  // Granular tire-soil foley & desert wind
  private sandFilter: BiquadFilterNode | null = null;
  private sandGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;

  private enabled = true;
  private initialized = false;
  private disposed = false;
  private boostSmoothed = 0;
  private prevBoostSmoothed = 0;
  private bovCooldown = 0;
  private musicStepAccum = 0;
  private musicChordStep = 0;
  private misfirePhase = 0;
  private audioParamAccum = 0.05;
  private suspendTimerId: ReturnType<typeof setTimeout> | null = null;
  private crashNoiseBuf: AudioBuffer | null = null;

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.suspendTimerId !== null) {
      clearTimeout(this.suspendTimerId);
      this.suspendTimerId = null;
    }
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setTargetAtTime(enabled ? 0.34 : 0.0, now, 0.035);
    if (enabled) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    } else if (this.ctx.state === 'running') {
      // Allow smooth 120ms gain fade-out, then truly suspend the AudioContext to free DSP thread CPU
      this.suspendTimerId = setTimeout(() => {
        this.suspendTimerId = null;
        if (!this.enabled && !this.disposed && this.ctx && this.ctx.state === 'running') {
          this.ctx.suspend().catch(() => {});
        }
      }, 120);
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Unlocks/initializes the Web Audio graph safely on the first user gesture
   * (keyboard press or pointer click), avoiding browser autoplay console warnings.
   */
  public unlockFromGesture(): void {
    if (this.disposed || !this.enabled) return;
    if (!this.initialized) {
      this.initAudioGraph();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  private initAudioGraph(): void {
    if (typeof window === 'undefined') return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx = new AudioCtx();
      this.ctx = ctx;

      const master = ctx.createGain();
      master.gain.value = this.enabled ? 0.34 : 0.0;
      master.connect(ctx.destination);
      this.masterGain = master;

      // Shared looping 2-second granular noise buffer (used for sand/mud foley, BOV, wind)
      const bufLen = ctx.sampleRate * 2;
      const noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < bufLen; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + white * 0.029;
        b1 = 0.985 * b1 + white * 0.032;
        b2 = 0.95 * b2 + white * 0.048;
        // Balanced warm pink-white blend for authentic granular sand hiss & diesel air rush
        data[i] = Math.max(-1, Math.min(1, (b0 + b1 + b2 + white * 0.32) * 0.55));
      }

      // Pre-bake reusable 0.45s decaying crash noise buffer once (zero per-impact AudioBuffer allocation)
      const crashLen = Math.max(1, Math.floor(ctx.sampleRate * 0.45));
      const crashBuf = ctx.createBuffer(1, crashLen, ctx.sampleRate);
      const crashCh = crashBuf.getChannelData(0);
      for (let i = 0; i < crashLen; i++) {
        const env = Math.exp((-i / crashLen) * 4.5);
        crashCh[i] = (Math.random() * 2 - 1) * env;
      }
      this.crashNoiseBuf = crashBuf;

      // 1. Heavy Turbo-Diesel Engine Chain
      const engFilter = ctx.createBiquadFilter();
      engFilter.type = 'lowpass';
      engFilter.frequency.value = 180;
      engFilter.Q.value = 2.4;

      const engGain = ctx.createGain();
      engGain.gain.value = 0.14;
      engFilter.connect(engGain);
      engGain.connect(master);

      const oscMain = ctx.createOscillator();
      oscMain.type = 'sawtooth';
      oscMain.frequency.value = 42;

      const oscSub = ctx.createOscillator();
      oscSub.type = 'triangle';
      oscSub.frequency.value = 21;

      const oscHarm = ctx.createOscillator();
      oscHarm.type = 'sawtooth';
      oscHarm.frequency.value = 63;

      const subGain = ctx.createGain();
      subGain.gain.value = 0.72;
      const harmGain = ctx.createGain();
      harmGain.gain.value = 0.24;

      oscMain.connect(engFilter);
      oscSub.connect(subGain);
      subGain.connect(engFilter);
      oscHarm.connect(harmGain);
      harmGain.connect(engFilter);

      oscMain.start();
      oscSub.start();
      oscHarm.start();

      this.oscMain = oscMain;
      this.oscSub = oscSub;
      this.oscHarm = oscHarm;
      this.engineFilter = engFilter;
      this.engineGain = engGain;

      // 2. Turbocharger Spool Whistle + Blow-Off Valve (BOV)
      const turboOsc = ctx.createOscillator();
      turboOsc.type = 'sine';
      turboOsc.frequency.value = 2400;

      const turboFilter = ctx.createBiquadFilter();
      turboFilter.type = 'bandpass';
      turboFilter.frequency.value = 3200;
      turboFilter.Q.value = 5.5;

      const turboGain = ctx.createGain();
      turboGain.gain.value = 0.0;

      turboOsc.connect(turboFilter);
      turboFilter.connect(turboGain);
      turboGain.connect(master);
      turboOsc.start();

      this.turboOsc = turboOsc;
      this.turboFilter = turboFilter;
      this.turboGain = turboGain;

      const bovSrc = ctx.createBufferSource();
      bovSrc.buffer = noiseBuf;
      bovSrc.loop = true;
      const bovFilter = ctx.createBiquadFilter();
      bovFilter.type = 'bandpass';
      bovFilter.frequency.value = 2800;
      bovFilter.Q.value = 2.8;
      const bovGain = ctx.createGain();
      bovGain.gain.value = 0.0;
      bovSrc.connect(bovFilter);
      bovFilter.connect(bovGain);
      bovGain.connect(master);
      bovSrc.start();

      this.bovFilter = bovFilter;
      this.bovGain = bovGain;

      // 3. Granular Tire-on-Sand / Wet Mud Foley
      const sandSrc = ctx.createBufferSource();
      sandSrc.buffer = noiseBuf;
      sandSrc.loop = true;
      const sandFilter = ctx.createBiquadFilter();
      sandFilter.type = 'bandpass';
      sandFilter.frequency.value = 950;
      sandFilter.Q.value = 0.85;
      const sandGain = ctx.createGain();
      sandGain.gain.value = 0.0;
      sandSrc.connect(sandFilter);
      sandFilter.connect(sandGain);
      sandGain.connect(master);
      sandSrc.start();

      this.sandFilter = sandFilter;
      this.sandGain = sandGain;

      // 4. Desert Wind Ambience
      const windSrc = ctx.createBufferSource();
      windSrc.buffer = noiseBuf;
      windSrc.loop = true;
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.value = 380;
      windFilter.Q.value = 1.6;
      const windGain = ctx.createGain();
      windGain.gain.value = 0.0;
      windSrc.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(master);
      windSrc.start();

      this.windFilter = windFilter;
      this.windGain = windGain;

      this.initialized = true;
    } catch {
      this.ctx = null;
    }
  }

  public update(state: VehicleAudioState, dt: number): void {
    if (!this.initialized || !this.ctx || !this.enabled || this.ctx.state !== 'running') {
      return;
    }

    const now = this.ctx.currentTime;
    const rpmNorm = Math.max(0, Math.min(1, (state.rpm - 720) / 5100));
    const load = Math.abs(state.throttle);
    const speed = Math.max(0, state.speedMs);

    // Step continuous envelopes smoothly every frame
    const targetBoost = state.boostActive
      ? 1.0
      : load > 0.35
        ? Math.min(0.45, rpmNorm * 0.6)
        : 0.0;
    const spoolRate = targetBoost > this.boostSmoothed ? 2.4 : 4.2;
    this.prevBoostSmoothed = this.boostSmoothed;
    this.boostSmoothed += (targetBoost - this.boostSmoothed) * (1 - Math.exp(-spoolRate * Math.min(0.1, dt)));

    this.bovCooldown = Math.max(0, this.bovCooldown - dt);
    if (
      this.prevBoostSmoothed > 0.52 &&
      targetBoost < 0.2 &&
      this.bovCooldown <= 0
    ) {
      // Trigger crisp pneumatic wastegate/blow-off flutter burst immediately
      this.bovCooldown = 0.65;
      this.bovFilter!.frequency.setValueAtTime(3400, now);
      this.bovFilter!.frequency.exponentialRampToValueAtTime(1150, now + 0.28);
      this.bovGain!.gain.cancelScheduledValues(now);
      this.bovGain!.gain.setValueAtTime(0.001, now);
      this.bovGain!.gain.linearRampToValueAtTime(0.24 * this.prevBoostSmoothed, now + 0.025);
      this.bovGain!.gain.exponentialRampToValueAtTime(0.001, now + 0.30);
    }

    // 5. Subtle Procedural Cabin Lo-Fi Music / FM Radio Chords when in Cockpit & Playing
    if (state.cabinMusicPlaying && state.isCockpitView && this.masterGain) {
      this.musicStepAccum += dt;
      const stepPeriod = state.cabinMediaSource === 'radio' ? 0.95 : 0.68;
      if (this.musicStepAccum >= stepPeriod) {
        this.musicStepAccum -= stepPeriod;
        this.triggerCabinLoFiChord(
          state.cabinTrackIndex ?? 0,
          this.musicChordStep++,
          state.cabinMediaSource === 'radio',
        );
      }
    }

    // Throttle continuous setTargetAtTime audio-thread automation writes to ~25 Hz (tau = 0.045..0.12s already smooths!)
    this.audioParamAccum += dt;
    if (this.audioParamAccum < 0.04) {
      return;
    }
    const paramDt = this.audioParamAccum;
    this.audioParamAccum = 0;

    // 1. Quad-Motor EV / Drive fundamental pitch (no front V8 combustion engine misfire stalling!)
    const engHealth = state.engineHealth01 ?? 1.0;
    this.misfirePhase += paramDt * (11 + rpmNorm * 14);
    const misfireCut =
      engHealth < 0.50 && Math.sin(this.misfirePhase * 2.3) > 0.55 ? 0.85 : 1.0;

    const baseFreq = 34 + rpmNorm * 128 + (state.isLowRange ? 6 : 0);
    this.oscMain!.frequency.setTargetAtTime(baseFreq, now, 0.045);
    this.oscSub!.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.045);
    this.oscHarm!.frequency.setTargetAtTime(baseFreq * 1.505, now, 0.045);

    const cutoff = 145 + rpmNorm * 460 + load * 340 + (state.boostActive ? 220 : 0);
    this.engineFilter!.frequency.setTargetAtTime(cutoff, now, 0.05);
    const engVol = (0.11 + load * 0.14 + rpmNorm * 0.09 + (state.boostActive ? 0.05 : 0)) * misfireCut;
    this.engineGain!.gain.setTargetAtTime(engVol, now, 0.06);

    // 2. Turbocharger Spool
    const turboFreq = 1950 + this.boostSmoothed * 3900 + rpmNorm * 650;
    this.turboOsc!.frequency.setTargetAtTime(turboFreq, now, 0.05);
    this.turboFilter!.frequency.setTargetAtTime(turboFreq, now, 0.05);
    this.turboGain!.gain.setTargetAtTime(this.boostSmoothed * 0.065, now, 0.06);

    // 3. Granular Tire-on-Sand Crunch / Wet Mud Squelch / Wet Asphalt Spray Hiss
    const isMud = state.biome === 'mud_grass';
    const isRainy = state.biome === 'rainy_highway';
    const sinkFactor = isRainy ? 0.65 : Math.min(1.4, state.avgSinkageM / 0.16);
    const slipEnergy = Math.min(1.2, state.avgSlip * 0.85 + (state.driftDeg / 38) * 0.65);
    const rollEnergy = Math.min(1.0, speed / 12.0);
    const foleyLevel =
      speed > 0.25 || state.avgSlip > 0.15
        ? Math.min(0.42, (rollEnergy * (isRainy ? 0.26 : 0.20) + slipEnergy * 0.22) * (0.55 + 0.45 * sinkFactor))
        : 0.0;

    const foleyFreq = isRainy
      ? 1450 + rollEnergy * 1650 + slipEnergy * 850
      : isMud
        ? 420 + rollEnergy * 460 + slipEnergy * 520
        : 820 + rollEnergy * 1100 + slipEnergy * 950;
    this.sandFilter!.frequency.setTargetAtTime(foleyFreq, now, 0.06);
    this.sandFilter!.Q.setTargetAtTime(isRainy ? 0.55 : isMud ? 1.55 : 0.72, now, 0.08);
    this.sandGain!.gain.setTargetAtTime(foleyLevel, now, 0.07);

    // 4. Desert Wind / Steady Morning Rain Patter Ambience
    const rainFloor = isRainy ? 0.085 : 0.0;
    const windLevel = Math.min(
      0.18,
      rainFloor + state.windSpeed * 0.045 + Math.min(0.07, (speed / 26) * 0.06),
    );
    const windFreq = isRainy
      ? 1250 + speed * 24
      : 260 + state.windSpeed * 180 + speed * 14;
    this.windFilter!.frequency.setTargetAtTime(windFreq, now, 0.12);
    this.windGain!.gain.setTargetAtTime(windLevel, now, 0.12);
  }

  private triggerCabinLoFiChord(trackIdx: number, step: number, isRadio: boolean): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Warm indie/lo-fi Rhodes-style 4-chord progression (zero external audio files!)
    const progressions = [
      [261.63, 329.63, 392.0, 493.88], // Cmaj7
      [220.0, 261.63, 329.63, 392.0], // Am7
      [174.61, 220.0, 261.63, 329.63], // Fmaj7
      [196.0, 246.94, 293.66, 392.0], // G6
    ];
    const chord = progressions[(step + trackIdx) % progressions.length];
    const filt = ctx.createBiquadFilter();
    filt.type = isRadio ? 'bandpass' : 'lowpass';
    filt.frequency.value = isRadio ? 1150 : 920;
    filt.Q.value = isRadio ? 1.4 : 0.8;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, now);
    env.gain.linearRampToValueAtTime(isRadio ? 0.032 : 0.044, now + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0008, now + 0.62);

    filt.connect(env);
    env.connect(this.masterGain);

    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = chord[i] * (trackIdx % 2 === 1 ? 0.89 : 1.0);
      osc.connect(filt);
      if (i === 2) {
        osc.onended = () => {
          osc.disconnect();
          filt.disconnect();
          env.disconnect();
        };
      } else {
        osc.onended = () => osc.disconnect();
      }
      osc.start(now);
      osc.stop(now + 0.64);
    }
  }

  public playUiClick(): void {
    if (!this.initialized || !this.ctx || !this.masterGain || !this.enabled || this.ctx.state !== 'running') {
      return;
    }
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.045);
    g.gain.setValueAtTime(0.09, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
    osc.start(now);
    osc.stop(now + 0.055);
  }

  private lastCrashAudioMs = 0;

  /**
   * Triggers procedural metallic crash thud, chassis crunch resonance, rock scrape burst,
   * and optional crystalline safety-glass shatter sound (zero external audio files).
   */
  public triggerCrashImpact(
    severity: number,
    onRock: boolean,
    glassCracked: boolean,
  ): void {
    if (!this.initialized || !this.ctx || !this.masterGain || !this.enabled || this.ctx.state !== 'running') {
      return;
    }
    const nowPerf = performance.now();
    if (nowPerf - this.lastCrashAudioMs < 95) return;
    this.lastCrashAudioMs = nowPerf;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const vol = Math.min(0.85, Math.max(0.14, severity * (onRock ? 0.85 : 0.65)));

    // 1. Sub-bass structural chassis slam thud
    const thudOsc = ctx.createOscillator();
    const thudGain = ctx.createGain();
    thudOsc.type = 'triangle';
    thudOsc.frequency.setValueAtTime(115 + severity * 40, now);
    thudOsc.frequency.exponentialRampToValueAtTime(32, now + 0.24);
    thudGain.gain.setValueAtTime(vol * 0.65, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    thudOsc.connect(thudGain);
    thudGain.connect(this.masterGain);
    thudOsc.onended = () => {
      thudOsc.disconnect();
      thudGain.disconnect();
    };
    thudOsc.start(now);
    thudOsc.stop(now + 0.30);

    // 2. Band-passed sheet-metal crunch noise burst (reuses pre-baked crashNoiseBuf)
    const dur = Math.min(0.44, 0.22 + severity * 0.22);
    const buf = this.crashNoiseBuf;
    if (buf) {
      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = buf;

      const crunchFilter = ctx.createBiquadFilter();
      crunchFilter.type = 'bandpass';
      crunchFilter.frequency.setValueAtTime(onRock ? 1450 : 780, now);
      crunchFilter.frequency.exponentialRampToValueAtTime(280, now + dur);
      crunchFilter.Q.value = onRock ? 2.6 : 1.4;

      const crunchGain = ctx.createGain();
      crunchGain.gain.setValueAtTime(vol * 0.72, now);
      crunchGain.gain.exponentialRampToValueAtTime(0.001, now + dur);

      noiseSrc.connect(crunchFilter);
      crunchFilter.connect(crunchGain);
      crunchGain.connect(this.masterGain);
      noiseSrc.onended = () => {
        noiseSrc.disconnect();
        crunchFilter.disconnect();
        crunchGain.disconnect();
      };
      noiseSrc.start(now, 0, dur);

      // 3. Crystalline high-frequency safety-glass shatter burst
      if (glassCracked) {
        const glassFilter = ctx.createBiquadFilter();
        glassFilter.type = 'highpass';
        glassFilter.frequency.value = 3400;
        const glassGain = ctx.createGain();
        glassGain.gain.setValueAtTime(vol * 0.52, now);
        glassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);

        const glassSrc = ctx.createBufferSource();
        glassSrc.buffer = buf;
        glassSrc.connect(glassFilter);
        glassFilter.connect(glassGain);
        glassGain.connect(this.masterGain);
        glassSrc.onended = () => {
          glassSrc.disconnect();
          glassFilter.disconnect();
          glassGain.disconnect();
        };
        glassSrc.start(now, 0, 0.27);
      }
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.suspendTimerId !== null) {
      clearTimeout(this.suspendTimerId);
      this.suspendTimerId = null;
    }
    this.crashNoiseBuf = null;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.initialized = false;
  }
}
