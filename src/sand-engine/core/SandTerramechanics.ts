/**
 * SandTerramechanics.ts
 * Zero-GPU-readback CPU surrogate terramechanics based on the Soil Contact Model
 * (SCM / Bekker pressure-sinkage law) paired with a lightweight 256-segment
 * spatial ring buffer of recent wheel tracks.
 *
 * Computes:
 *  - Wheel sinkage z (static Bekker + slip sinkage - compacted track relief)
 *  - Compaction rolling resistance proportional to z^(n+1)
 *  - Lateral bulldozing resistance when steering/drifting through loose sand
 *  - Synchronized Foot IK sinkage offset (2-6 cm)
 */

import { EnvironmentBiome, SAND_DEFAULTS } from './SandParams';
import { ScratchIndexList } from './BufferPool';
import { SpatialIndex2D } from './SpatialIndex2D';

export interface TrackSegmentRecord {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  halfWidth: number;
  depth: number;
  compaction: number;
  age: number;
  active: boolean;
}

export interface WheelContactInput {
  worldX: number;
  worldZ: number;
  /** Vertical normal load on the tire (Newtons), e.g., ~3200 N per wheel */
  normalLoadN: number;
  /** Tire width b (meters), e.g., 0.34 m */
  tireWidth: number;
  /** Tire outer radius (meters), e.g., 0.44 m */
  tireRadius: number;
  /** Longitudinal slip ratio in [0, 1+] */
  slipRatio: number;
  /** Lateral slip angle in radians (drift / steering bite) */
  lateralSlipRad: number;
  /** Moisture factor in [0, 1] (slightly increases cohesion and reduces loose sinkage) */
  moisture: number;
  /** Active terrain biome (defaults to 'desert') */
  biome?: EnvironmentBiome;
  /** Tire inflation pressure in PSI (10..36; default 22). Lower PSI widens & lengthens contact patch! */
  tirePressurePsi?: number;
}

export interface WheelContactResult {
  /** Total sinkage z in meters, clamped to MAX_DEPTH_METERS */
  sinkage: number;
  /** Compaction of any pre-existing track beneath this wheel [0, 1] */
  trackCompaction: number;
  /** Compaction rolling resistance force (Newtons, opposes forward motion) */
  rollingResistanceN: number;
  /** Lateral bulldozing resistance force (Newtons, resists lateral slide) */
  bulldozingForceN: number;
  /** Effective traction multiplier (higher in compacted ruts, lower in loose deep sand) */
  tractionFactor: number;
}

export interface FootContactInput {
  worldX: number;
  worldZ: number;
  /** Downward foot impact speed (m/s) */
  impactSpeed: number;
  /** Character body mass (kg) */
  bodyMassKg: number;
  /** Moisture factor in [0, 1] */
  moisture: number;
  /** Active terrain biome (defaults to 'desert') */
  biome?: EnvironmentBiome;
}

export interface FootContactResult {
  /** Exact Foot IK vertical offset (meters, typically 0.02 - 0.06 m) */
  sinkage: number;
  /** Whether stepping into an already compacted track */
  trackCompaction: number;
}

/** Squared distance from point (px, pz) to segment AB in XZ plane */
function pointToSegmentDistSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const abLenSq = abx * abx + abz * abz;
  let t = 0;
  if (abLenSq > 1e-8) {
    t = Math.max(0, Math.min(1, (apx * abx + apz * abz) / abLenSq));
  }
  const cx = ax + abx * t - px;
  const cz = az + abz * t - pz;
  return cx * cx + cz * cz;
}

/**
 * Computes the forward projection distance (in meters ahead of the wheel hub) for the
 * swept capsule brush endpoint so the carved sand rut and front entry slope align
 * precisely with the tire's physical leading contact edge (`sqrt(2*R*z - z^2)`),
 * without protruding as a phantom trench ahead of the tire silhouette.
 */
export function computeTireContactLead(
  tireRadius: number,
  effectiveSinkage: number,
  brushHalfWidth: number,
): number {
  const r = Math.max(0.15, tireRadius);
  const z = Math.max(0, Math.min(r * 0.92, effectiveSinkage));
  const contactHalfLen = Math.sqrt(Math.max(0, 2 * r * z - z * z));
  const capRadius = Math.max(0.04, brushHalfWidth) * 1.22;
  const maxLead = Math.max(0.05, r * 1.10 - capRadius);
  const rawLead = contactHalfLen - capRadius * 0.48;
  return Math.max(0.04, Math.min(maxLead, rawLead));
}

export interface TireFootprintScale {
  widthScale: number;
  lengthScale: number;
  tractionBonus: number;
}

const FOOTPRINT_SCRATCH: TireFootprintScale = {
  widthScale: 1,
  lengthScale: 1,
  tractionBonus: 0,
};

export function computeTireFootprintScaleInto(
  tirePressurePsi = 22,
  out: TireFootprintScale,
): TireFootprintScale {
  const psi = Math.max(10, Math.min(36, tirePressurePsi));
  // Normalize around baseline 22 PSI: t < 0 = aired down, t > 0 = high road pressure
  const t = (psi - 22) / 14;
  out.widthScale = t < 0 ? 1.0 + (-t) * 0.24 : 1.0 - t * 0.09;
  out.lengthScale = t < 0 ? 1.0 + (-t) * 0.36 : 1.0 - t * 0.14;
  out.tractionBonus = t < 0 ? (-t) * 0.10 : -t * 0.06;
  return out;
}

/**
 * Models pneumatic off-road tire carcass flattening when airing down for desert sand.
 *  - 10–14 PSI (aired-down dunes): +22% contact width, +34% contact length -> ~40% lower ground pressure
 *  - 22 PSI (balanced trail baseline): 1.00x nominal footprint
 *  - 34–36 PSI (stiff road inflation): narrower, shorter footprint -> deeper ruts & higher drag
 */
export function computeTireFootprintScale(tirePressurePsi = 22): TireFootprintScale {
  return computeTireFootprintScaleInto(tirePressurePsi, {
    widthScale: 1,
    lengthScale: 1,
    tractionBonus: 0,
  });
}

export class SandTerramechanics {
  private readonly capacity: number;
  private readonly segments: TrackSegmentRecord[];
  private readonly spatialIndex = new SpatialIndex2D<TrackSegmentRecord>();
  private readonly indexedSegSlots: Int32Array;
  private readonly queryScratch = new ScratchIndexList(32);
  private spatialDirty = false;
  private writeHead = 0;
  private count = 0;

  constructor(capacity: number = SAND_DEFAULTS.RING_BUFFER_CAPACITY) {
    this.capacity = capacity;
    this.indexedSegSlots = new Int32Array(Math.max(1, capacity));
    this.segments = Array.from({ length: capacity }, () => ({
      ax: 0,
      az: 0,
      bx: 0,
      bz: 0,
      minX: 0,
      maxX: 0,
      minZ: 0,
      maxZ: 0,
      halfWidth: 0.2,
      depth: 0,
      compaction: 0,
      age: 0,
      active: false,
    }));
  }

  public getCapacity(): number {
    return this.capacity;
  }

  public clearTracks(): void {
    this.writeHead = 0;
    this.count = 0;
    for (let i = 0; i < this.capacity; i++) {
      this.segments[i].active = false;
    }
    this.spatialIndex.clear();
    this.spatialDirty = false;
  }

  /** Ages stored segments so wind infill gradually relaxes old CPU track memory only when wind is active. */
  public tickAging(dt: number, windSpeed: number): void {
    const decay = windSpeed > 0.001 ? dt * windSpeed * 0.008 : 0;
    let deactivatedAny = false;
    for (let i = 0; i < this.count; i++) {
      const s = this.segments[i];
      if (!s.active) continue;
      s.age += dt;
      if (decay > 0) {
        s.compaction = Math.max(0, s.compaction - decay);
        if (s.compaction <= 0.02) {
          s.active = false;
          deactivatedAny = true;
        }
      }
    }
    if (deactivatedAny) {
      this.spatialDirty = true;
    }
  }

  /** Records a swept wheel segment into the O(1) spatial ring buffer. */
  public recordTrackSegment(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    halfWidth: number,
    depth: number,
    compaction: number,
  ): void {
    const seg = this.segments[this.writeHead];
    const r = halfWidth * 1.15;
    seg.ax = ax;
    seg.az = az;
    seg.bx = bx;
    seg.bz = bz;
    seg.minX = (ax < bx ? ax : bx) - r;
    seg.maxX = (ax > bx ? ax : bx) + r;
    seg.minZ = (az < bz ? az : bz) - r;
    seg.maxZ = (az > bz ? az : bz) + r;
    seg.halfWidth = halfWidth;
    seg.depth = depth;
    seg.compaction = Math.max(0, Math.min(1, compaction));
    seg.age = 0;
    seg.active = true;

    this.writeHead = (this.writeHead + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
    this.spatialDirty = true;
  }

  private ensureSpatialIndex(): number {
    if (!this.spatialDirty) {
      return this.spatialIndex.length;
    }
    this.spatialDirty = false;
    let activeCount = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.segments[i].active) activeCount++;
    }
    this.spatialIndex.buildIndexed(
      activeCount,
      (tree) => {
        let slot = 0;
        for (let i = 0; i < this.count; i++) {
          const seg = this.segments[i];
          if (!seg.active) continue;
          this.indexedSegSlots[slot++] = i;
          tree.add(seg.minX, seg.minZ, seg.maxX, seg.maxZ);
        }
      },
      12,
    );
    return activeCount;
  }

  /**
   * Queries maximum pre-existing track compaction beneath worldXZ using the Flatbush 2D index.
   * Excludes segments younger than `minAgeSec` so a wheel does not read the
   * segment it literally just stamped on the previous micro-step.
   */
  public queryTrackCompaction(
    worldX: number,
    worldZ: number,
    minAgeSec = 0.12,
  ): number {
    if (this.count === 0) return 0;
    const activeCount = this.ensureSpatialIndex();
    if (activeCount === 0) return 0;

    this.spatialIndex.queryBoxInto(
      worldX,
      worldZ,
      worldX,
      worldZ,
      this.queryScratch,
    );

    let maxCompaction = 0;
    const hits = this.queryScratch.data;
    const hitCount = this.queryScratch.length;
    for (let h = 0; h < hitCount; h++) {
      const seg = this.segments[this.indexedSegSlots[hits[h]]];
      if (!seg.active || seg.age < minAgeSec) continue;

      const r = seg.halfWidth * 1.15;
      const distSq = pointToSegmentDistSq(
        worldX,
        worldZ,
        seg.ax,
        seg.az,
        seg.bx,
        seg.bz,
      );
      if (distSq < r * r) {
        const falloff = 1.0 - Math.sqrt(distSq) / r;
        const c = seg.compaction * (0.45 + 0.55 * falloff);
        if (c > maxCompaction) {
          maxCompaction = c;
        }
      }
    }
    return maxCompaction;
  }

  public getActiveTrackCount(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.segments[i].active) n++;
    }
    return n;
  }

  /**
   * Zero-allocation Bekker / SCM surrogate wheel-soil solver (`*Into` variant).
   */
  public evaluateWheelContactInto(
    input: WheelContactInput,
    out: WheelContactResult,
  ): WheelContactResult {
    const b = Math.max(0.1, input.tireWidth);
    const radius = Math.max(0.15, input.tireRadius);
    const fz = Math.max(0, input.normalLoadN);
    if (fz <= 1e-3) {
      out.sinkage = 0;
      out.trackCompaction = 0;
      out.rollingResistanceN = 0;
      out.bulldozingForceN = 0;
      out.tractionFactor = 0;
      return out;
    }
    const moisture = Math.max(0, Math.min(1, input.moisture));
    const slip = Math.max(0, Math.min(1.5, input.slipRatio));

    const isMud = input.biome === 'mud_grass';

    const stiffnessBoost = isMud
      ? SAND_DEFAULTS.MUD_STIFFNESS_SCALE * (1.0 - moisture * 0.18)
      : 1.0 + moisture * 0.42;
    const kc = isMud
      ? SAND_DEFAULTS.BEKKER_KC * 0.65
      : SAND_DEFAULTS.BEKKER_KC * (1.0 + moisture * 1.2);
    const kphi = SAND_DEFAULTS.BEKKER_KPHI * stiffnessBoost;
    const n = isMud ? 0.96 : SAND_DEFAULTS.BEKKER_N;

    const fp = computeTireFootprintScaleInto(
      input.tirePressurePsi ?? 22,
      FOOTPRINT_SCRATCH,
    );
    const effB = b * fp.widthScale;

    const contactLength = (0.28 + radius * 0.35) * fp.lengthScale;
    const contactArea = effB * contactLength;
    const pressure = fz / contactArea;

    const soilModulus = kc / effB + kphi;
    const zStatic = Math.pow(Math.max(0, pressure / soilModulus), 1.0 / n);

    const slipFactor = 1.0 + SAND_DEFAULTS.SLIP_SINKAGE_GAIN * slip * (isMud ? 1.15 : 1.0);

    const trackCompaction = this.queryTrackCompaction(input.worldX, input.worldZ);
    const trackRelief = 1.0 - trackCompaction * SAND_DEFAULTS.TRACK_COMPACTION_RELIEF;

    const biomeSinkScale = isMud ? SAND_DEFAULTS.MUD_SINKAGE_GAIN : 1.0;
    const rawSinkage = zStatic * 2.15 * biomeSinkScale * slipFactor * trackRelief;
    const sinkage = Math.max(0.008, Math.min(SAND_DEFAULTS.MAX_DEPTH_METERS, rawSinkage));

    const rollingResistanceN =
      (isMud ? 0.23 : 0.16) * effB * soilModulus * Math.pow(sinkage, n + 1.0) / (n + 1.0);

    const latSin = Math.sin(Math.min(Math.PI * 0.5, Math.abs(input.lateralSlipRad)));
    const lateralProjectedArea = sinkage * (radius * 1.6);
    const bulldozingForceN =
      SAND_DEFAULTS.BULLDOZING_COEFF *
      (isMud ? 0.88 : 1.0 + moisture * 0.25) *
      lateralProjectedArea *
      latSin *
      (1.0 - trackCompaction * 0.35);

    const tractionFactor =
      (isMud
        ? 0.72 + trackCompaction * 0.20 - Math.min(0.24, sinkage * 0.75)
        : 0.78 + trackCompaction * 0.22 + moisture * 0.12 - Math.min(0.25, sinkage * 0.85)) +
      fp.tractionBonus;

    out.sinkage = sinkage;
    out.trackCompaction = trackCompaction;
    out.rollingResistanceN = rollingResistanceN;
    out.bulldozingForceN = bulldozingForceN;
    out.tractionFactor = Math.max(0.42, Math.min(1.18, tractionFactor));
    return out;
  }

  public evaluateWheelContact(input: WheelContactInput): WheelContactResult {
    return this.evaluateWheelContactInto(input, {
      sinkage: 0,
      trackCompaction: 0,
      rollingResistanceN: 0,
      bulldozingForceN: 0,
      tractionFactor: 0,
    });
  }

  /**
   * Zero-allocation synchronized Foot IK sinkage (`*Into` variant).
   */
  public evaluateFootContactInto(
    input: FootContactInput,
    out: FootContactResult,
  ): FootContactResult {
    const isMud = input.biome === 'mud_grass';
    const trackCompaction = this.queryTrackCompaction(
      input.worldX,
      input.worldZ,
      0.25,
    );
    const massFactor = Math.max(0.5, Math.min(1.6, input.bodyMassKg / 75.0));
    const impactBoost = Math.min(1.0, Math.max(0, input.impactSpeed) / 4.5);
    const moistureRelief = isMud
      ? 1.0 + Math.max(0, Math.min(1, input.moisture)) * 0.12
      : 1.0 - Math.max(0, Math.min(1, input.moisture)) * 0.28;
    const trackRelief = 1.0 - trackCompaction * 0.4;

    const minSink = isMud
      ? SAND_DEFAULTS.MUD_FOOT_MIN_SINKAGE
      : SAND_DEFAULTS.FOOT_MIN_SINKAGE;
    const maxSink = isMud
      ? SAND_DEFAULTS.MUD_FOOT_MAX_SINKAGE
      : SAND_DEFAULTS.FOOT_MAX_SINKAGE;
    const span = maxSink - minSink;
    const raw =
      (minSink + span * (0.25 + 0.75 * impactBoost) * massFactor) *
      moistureRelief *
      trackRelief;

    out.sinkage = Math.max(minSink, Math.min(maxSink, raw));
    out.trackCompaction = trackCompaction;
    return out;
  }

  public evaluateFootContact(input: FootContactInput): FootContactResult {
    return this.evaluateFootContactInto(input, {
      sinkage: 0,
      trackCompaction: 0,
    });
  }
}
