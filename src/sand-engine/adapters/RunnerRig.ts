/**
 * RunnerRig.ts
 * Articulated multi-part Desert Runner NPC with analytical 2-bone Foot IK
 * driven directly by CPU `SandTerramechanics.evaluateFootContact()` (2-6 cm
 * sinkage offset so the boot sole sits flush at the bottom of every footprint).
 *
 * Emits continuous swept foot brushes (heel-strike -> mid-stance -> toe-off
 * push crest) into the shared 64-byte `BrushEncoder`.
 */

import * as THREE from 'three';
import { sampleTerrainHeightForBiome } from '../core/TerrainHeightfield';
import {
  ClimbableRockSample,
  sampleClimbableRockSurfaceInto,
} from '../core/DesertObstacles';
import {
  FootContactInput,
  FootContactResult,
  SandTerramechanics,
} from '../core/SandTerramechanics';
import { BrushEncoder, BrushType } from '../core/BrushEncoder';
import { EnvironmentBiome } from '../core/SandParams';
import {
  LodCadenceState,
  consumeLodStepDt,
  createLodCadenceState,
  selectSimulationTier,
} from '../core/SimulationLod';

interface FootTracker {
  side: -1 | 1;
  planted: boolean;
  prevWorldX: number;
  prevWorldZ: number;
  sinkage: number;
  hipPivot: THREE.Group;
  kneePivot: THREE.Group;
  bootGroup: THREE.Group;
  worldFootPos: THREE.Vector3;
}

const _hipWorld = new THREE.Vector3();

export class RunnerRig {
  public readonly root = new THREE.Group();
  public readonly position = new THREE.Vector3();
  public heading = 0;

  private readonly orbitCenter = new THREE.Vector3();
  private readonly orbitRadius: number;
  private readonly moveSpeed: number;
  private orbitAngle: number;
  private gaitPhase: number;
  private readonly bodyMassKg: number;
  private lastBiome: EnvironmentBiome = 'desert';

  private readonly torsoGroup = new THREE.Group();
  private readonly leftArmPivot = new THREE.Group();
  private readonly rightArmPivot = new THREE.Group();
  private readonly feet: [FootTracker, FootTracker];

  private readonly thighLen = 0.46;
  private readonly shinLen = 0.46;
  private readonly hipHeight = 0.92;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  private readonly lodState: LodCadenceState = createLodCadenceState();
  private lastAvgFootSinkCm = 3.0;
  private readonly surfaceScratch: ClimbableRockSample = {
    height: 0,
    rockElevation: 0,
    onRock: 0,
  };
  private readonly footContactInputScratch: FootContactInput = {
    worldX: 0,
    worldZ: 0,
    impactSpeed: 0,
    bodyMassKg: 76,
    moisture: 0,
    biome: 'desert',
  };
  private readonly footContactResScratch: FootContactResult = {
    sinkage: 0,
    trackCompaction: 0,
  };
  private readonly brushScratch: Parameters<BrushEncoder['push']>[0] = {
    posPrevX: 0,
    posPrevY: 0,
    posPrevZ: 0,
    halfWidth: 0.095,
    posCurrX: 0,
    posCurrY: 0,
    posCurrZ: 0,
    targetSinkage: 0,
    slipRatio: 0,
    treadPhasePrev: 0,
    treadPhaseCurr: 1,
    lateralDrift: 0,
    brushType: BrushType.Foot,
    atlasId: 0,
    compressionWeight: 0.82,
    massFactor: 1.05,
  };
  private readonly stepResultScratch = { avgFootSinkageCm: 3.0 };

  constructor(options: {
    centerX: number;
    centerZ: number;
    orbitRadius: number;
    startAngle: number;
    speedMs: number;
    jacketColor: number;
    bodyMassKg?: number;
  }) {
    this.orbitCenter.set(options.centerX, 0, options.centerZ);
    this.orbitRadius = options.orbitRadius;
    this.orbitAngle = options.startAngle;
    this.moveSpeed = options.speedMs;
    this.gaitPhase = options.startAngle * 2.0;
    this.bodyMassKg = options.bodyMassKg ?? 76;

    const jacketMat = new THREE.MeshStandardMaterial({
      color: options.jacketColor,
      roughness: 0.78,
      metalness: 0.05,
    });
    const pantsMat = new THREE.MeshStandardMaterial({
      color: 0x3b352d,
      roughness: 0.85,
      metalness: 0.04,
    });
    const packMat = new THREE.MeshStandardMaterial({
      color: 0x5c4a35,
      roughness: 0.82,
      metalness: 0.1,
    });
    const helmetMat = new THREE.MeshStandardMaterial({
      color: 0xdfd5c5,
      roughness: 0.42,
      metalness: 0.15,
    });
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0x1a2630,
      roughness: 0.12,
      metalness: 0.65,
    });
    const bootMat = new THREE.MeshStandardMaterial({
      color: 0x26211c,
      roughness: 0.88,
      metalness: 0.08,
    });
    this.materials.push(jacketMat, pantsMat, packMat, helmetMat, visorMat, bootMat);

    // Pelvis + Torso + Desert Pack + Head/Helmet/Goggles
    this.torsoGroup.position.set(0, this.hipHeight, 0);
    this.root.add(this.torsoGroup);

    const pelvisGeo = new THREE.BoxGeometry(0.32, 0.16, 0.2);
    const chestGeo = new THREE.BoxGeometry(0.38, 0.48, 0.23);
    const packGeo = new THREE.BoxGeometry(0.28, 0.38, 0.16);
    const headGeo = new THREE.SphereGeometry(0.13, 14, 12);
    const visorGeo = new THREE.BoxGeometry(0.19, 0.075, 0.1);
    const armGeo = new THREE.CylinderGeometry(0.045, 0.04, 0.56, 8);
    const thighGeo = new THREE.CylinderGeometry(0.075, 0.062, this.thighLen, 10);
    const shinGeo = new THREE.CylinderGeometry(0.058, 0.048, this.shinLen, 10);
    const bootUpperGeo = new THREE.BoxGeometry(0.12, 0.1, 0.27);
    const bootSoleGeo = new THREE.BoxGeometry(0.135, 0.036, 0.29);

    this.geometries.push(
      pelvisGeo,
      chestGeo,
      packGeo,
      headGeo,
      visorGeo,
      armGeo,
      thighGeo,
      shinGeo,
      bootUpperGeo,
      bootSoleGeo,
    );

    const pelvis = new THREE.Mesh(pelvisGeo, pantsMat);
    pelvis.castShadow = true;
    this.torsoGroup.add(pelvis);

    const chest = new THREE.Mesh(chestGeo, jacketMat);
    chest.position.set(0, 0.31, 0.02);
    chest.rotation.x = 0.08;
    chest.castShadow = true;
    this.torsoGroup.add(chest);

    const pack = new THREE.Mesh(packGeo, packMat);
    pack.position.set(0, 0.32, -0.17);
    pack.castShadow = true;
    this.torsoGroup.add(pack);

    const head = new THREE.Mesh(headGeo, helmetMat);
    head.position.set(0, 0.67, 0.04);
    head.castShadow = true;
    this.torsoGroup.add(head);

    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 0.68, 0.13);
    this.torsoGroup.add(visor);

    // Arms
    this.leftArmPivot.position.set(0.24, 0.5, 0.02);
    this.rightArmPivot.position.set(-0.24, 0.5, 0.02);
    this.torsoGroup.add(this.leftArmPivot, this.rightArmPivot);

    const leftArm = new THREE.Mesh(armGeo, jacketMat);
    leftArm.position.set(0, -0.26, 0);
    this.leftArmPivot.add(leftArm);

    const rightArm = new THREE.Mesh(armGeo, jacketMat);
    rightArm.position.set(0, -0.26, 0);
    this.rightArmPivot.add(rightArm);

    // Articulated 2-bone legs (Left + Right)
    const buildLeg = (side: -1 | 1): FootTracker => {
      const hipPivot = new THREE.Group();
      hipPivot.position.set(side * 0.11, this.hipHeight, 0);
      this.root.add(hipPivot);

      const thighMesh = new THREE.Mesh(thighGeo, pantsMat);
      thighMesh.position.set(0, -this.thighLen * 0.5, 0);
      thighMesh.castShadow = true;
      hipPivot.add(thighMesh);

      const kneePivot = new THREE.Group();
      kneePivot.position.set(0, -this.thighLen, 0);
      hipPivot.add(kneePivot);

      const shinMesh = new THREE.Mesh(shinGeo, pantsMat);
      shinMesh.position.set(0, -this.shinLen * 0.5, 0);
      shinMesh.castShadow = true;
      kneePivot.add(shinMesh);

      const bootGroup = new THREE.Group();
      bootGroup.position.set(0, -this.shinLen, 0);
      kneePivot.add(bootGroup);

      const upper = new THREE.Mesh(bootUpperGeo, bootMat);
      upper.position.set(0, 0.05, 0.06);
      upper.castShadow = true;
      bootGroup.add(upper);

      const sole = new THREE.Mesh(bootSoleGeo, packMat);
      sole.position.set(0, 0.018, 0.06);
      bootGroup.add(sole);

      return {
        side,
        planted: false,
        prevWorldX: 0,
        prevWorldZ: 0,
        sinkage: 0.03,
        hipPivot,
        kneePivot,
        bootGroup,
        worldFootPos: new THREE.Vector3(),
      };
    };

    this.feet = [buildLeg(1), buildLeg(-1)];
    this.updatePositionFromOrbit();
  }

  public setOrbitCenter(x: number, z: number, biome: EnvironmentBiome = this.lastBiome): void {
    this.lastBiome = biome;
    this.orbitCenter.set(x, 0, z);
    this.updatePositionFromOrbit(biome);
  }

  private sampleSurfaceAtInto(
    x: number,
    z: number,
    biome: EnvironmentBiome,
    out: ClimbableRockSample,
  ): ClimbableRockSample {
    const baseY = sampleTerrainHeightForBiome(x, z, biome);
    if (biome !== 'desert') {
      out.height = baseY;
      out.rockElevation = 0;
      out.onRock = 0;
      return out;
    }
    return sampleClimbableRockSurfaceInto(x, z, baseY, undefined, out);
  }

  private updatePositionFromOrbit(biome: EnvironmentBiome = this.lastBiome): void {
    const x = this.orbitCenter.x + Math.cos(this.orbitAngle) * this.orbitRadius;
    const z = this.orbitCenter.z + Math.sin(this.orbitAngle) * this.orbitRadius;
    const g = this.sampleSurfaceAtInto(x, z, biome, this.surfaceScratch);
    this.position.set(x, g.height, z);
    // Tangent along circular path (+heading faces +Z in local rig)
    this.heading = Math.atan2(-Math.sin(this.orbitAngle), Math.cos(this.orbitAngle));
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
  }

  public step(
    dt: number,
    moisture: number,
    terramechanics: SandTerramechanics,
    brushEncoder: BrushEncoder,
    onFootPuff: (
      x: number,
      y: number,
      z: number,
      vx: number,
      vy: number,
      vz: number,
      intensity: number,
    ) => void,
    biome: EnvironmentBiome = 'desert',
    lodConfig?: {
      focusX: number;
      focusZ: number;
      isFocus?: boolean;
      visible?: boolean;
    },
  ): { avgFootSinkageCm: number } {
    this.lastBiome = biome;
    let safeDt: number;
    if (lodConfig) {
      const dx = this.position.x - lodConfig.focusX;
      const dz = this.position.z - lodConfig.focusZ;
      const tier = selectSimulationTier(
        dx * dx + dz * dz,
        Boolean(lodConfig.isFocus),
        lodConfig.visible ?? true,
      );
      const stepDt = consumeLodStepDt(this.lodState, dt, tier);
      if (stepDt <= 0) {
        this.stepResultScratch.avgFootSinkageCm = this.lastAvgFootSinkCm;
        return this.stepResultScratch;
      }
      safeDt = Math.min(0.12, Math.max(0.001, stepDt));
    } else {
      safeDt = Math.min(0.05, Math.max(0.001, dt));
    }

    const angularVel = this.moveSpeed / Math.max(1.5, this.orbitRadius);
    this.orbitAngle += angularVel * safeDt;
    this.updatePositionFromOrbit(biome);

    // Stride cadence proportional to running speed
    const strideFreq = 1.65 * this.moveSpeed;
    this.gaitPhase += strideFreq * safeDt;

    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const rightX = cosH;
    const rightZ = -sinH;

    // Gentle natural vertical bob during stride
    const bodyBob = Math.abs(Math.sin(this.gaitPhase)) * 0.055;
    this.torsoGroup.position.y = this.hipHeight + bodyBob;
    this.torsoGroup.rotation.y = Math.sin(this.gaitPhase) * 0.08;
    this.leftArmPivot.rotation.x = Math.sin(this.gaitPhase + Math.PI) * 0.58;
    this.rightArmPivot.rotation.x = Math.sin(this.gaitPhase) * 0.58;

    let stanceSinkSum = 0;
    let stanceCount = 0;

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const legPhase = this.gaitPhase + (i === 0 ? 0 : Math.PI);
      const strideSin = Math.sin(legPhase);
      const strideCos = Math.cos(legPhase);

      // Desired foot stride offset in character-local space
      const strideLen = 0.34 + this.moveSpeed * 0.055;
      const localZ = strideSin * strideLen;
      const swingLift = Math.max(0, strideCos) * 0.24;
      const isGroundContact = strideCos <= 0.08;

      const footWorldX =
        this.position.x + rightX * (f.side * 0.12) + sinH * localZ;
      const footWorldZ =
        this.position.z + rightZ * (f.side * 0.12) + cosH * localZ;
      const ground = this.sampleSurfaceAtInto(
        footWorldX,
        footWorldZ,
        biome,
        this.surfaceScratch,
      );

      // Query CPU Foot IK terramechanics ring buffer ONLY during stance phase on deformable soil
      let stanceSinkage = 0;
      if (isGroundContact) {
        if (ground.onRock < 0.95) {
          this.footContactInputScratch.worldX = footWorldX;
          this.footContactInputScratch.worldZ = footWorldZ;
          this.footContactInputScratch.impactSpeed = this.moveSpeed * 0.72;
          this.footContactInputScratch.bodyMassKg = this.bodyMassKg;
          this.footContactInputScratch.moisture = moisture;
          this.footContactInputScratch.biome = biome;
          const contactRes = terramechanics.evaluateFootContactInto(
            this.footContactInputScratch,
            this.footContactResScratch,
          );
          stanceSinkage = contactRes.sinkage * (1 - ground.onRock);
        }
        stanceSinkSum += stanceSinkage;
        stanceCount++;
      }

      const targetSink = isGroundContact ? stanceSinkage : 0;
      f.sinkage += (targetSink - f.sinkage) * (1 - Math.exp(-22 * safeDt));

      const footWorldY = ground.height + swingLift - f.sinkage;
      f.worldFootPos.set(footWorldX, footWorldY, footWorldZ);

      // Analytical 2-bone IK in character sagittal plane (Y-Z)
      const hipWorldY = this.position.y + this.hipHeight + bodyBob;
      const targetRelY = footWorldY - hipWorldY;
      const targetRelZ = localZ;

      const reachRaw = Math.hypot(targetRelZ, targetRelY);
      const maxReach = (this.thighLen + this.shinLen) * 0.985;
      const minReach = 0.22;
      const reach = Math.max(minReach, Math.min(maxReach, reachRaw));

      // Law of cosines for hip & knee flexion (knee bends backward/forward naturally)
      const cosKnee = Math.max(
        -1,
        Math.min(
          1,
          (this.thighLen * this.thighLen +
            this.shinLen * this.shinLen -
            reach * reach) /
            (2 * this.thighLen * this.shinLen),
        ),
      );
      const kneeInterior = Math.acos(cosKnee);
      const kneeBend = Math.PI - kneeInterior; // positive bends shin backward

      const cosHipOffset = Math.max(
        -1,
        Math.min(
          1,
          (this.thighLen * this.thighLen +
            reach * reach -
            this.shinLen * this.shinLen) /
            (2 * this.thighLen * reach),
        ),
      );
      const hipOffset = Math.acos(cosHipOffset);
      const targetAngle = Math.atan2(targetRelZ, -targetRelY);

      f.hipPivot.position.y = this.hipHeight + bodyBob;
      f.hipPivot.rotation.x = -(targetAngle + hipOffset);
      f.kneePivot.rotation.x = kneeBend;
      // Keep boot flat on sand during stance, pitched during heel-strike / toe-off
      const ankleComp = -(f.hipPivot.rotation.x + f.kneePivot.rotation.x);
      f.bootGroup.rotation.x = ankleComp + (isGroundContact ? 0 : -strideSin * 0.25);

      // Emit Foot IK swept brush during stance phase on deformable soil (never stamp solid sandstone slabs)
      if (isGroundContact) {
        if (ground.onRock < 0.35 && stanceSinkage > 0.002) {
          const toeOffPhase = Math.max(0, -strideSin);
          const px0 = f.planted ? f.prevWorldX : footWorldX - sinH * 0.06;
          const pz0 = f.planted ? f.prevWorldZ : footWorldZ - cosH * 0.06;

          this.brushScratch.posPrevX = px0;
          this.brushScratch.posPrevY = footWorldY;
          this.brushScratch.posPrevZ = pz0;
          this.brushScratch.posCurrX = footWorldX;
          this.brushScratch.posCurrY = footWorldY;
          this.brushScratch.posCurrZ = footWorldZ;
          this.brushScratch.targetSinkage = stanceSinkage * 1.45; // Crisp legible boot footprint
          this.brushScratch.slipRatio = toeOffPhase * 0.85;
          this.brushScratch.atlasId = i;
          brushEncoder.push(this.brushScratch);

          // Subtle sand puff on toe-off push
          if (!f.planted || (toeOffPhase > 0.72 && Math.random() < 0.35)) {
            onFootPuff(
              footWorldX - sinH * 0.1,
              ground.height + 0.03,
              footWorldZ - cosH * 0.1,
              -sinH * (1.2 + this.moveSpeed * 0.45),
              1.15,
              -cosH * (1.2 + this.moveSpeed * 0.45),
              0.32,
            );
          }
        }

        f.prevWorldX = footWorldX;
        f.prevWorldZ = footWorldZ;
        f.planted = true;
      } else {
        f.planted = false;
      }
    }

    // Keep helper unused warning clean
    _hipWorld.set(0, 0, 0);

    const avgSinkM =
      stanceCount > 0
        ? stanceSinkSum / stanceCount
        : (this.feet[0].sinkage + this.feet[1].sinkage) * 0.5;
    this.lastAvgFootSinkCm = avgSinkM * 100;
    this.stepResultScratch.avgFootSinkageCm = this.lastAvgFootSinkCm;
    return this.stepResultScratch;
  }

  public getFocusFootWorldPos(out: THREE.Vector3): THREE.Vector3 {
    // Return midpoint between planted feet for close-up Foot IK inspection
    return out
      .copy(this.feet[0].worldFootPos)
      .lerp(this.feet[1].worldFootPos, 0.5);
  }

  public dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
