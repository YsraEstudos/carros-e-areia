/**
 * VolumetricSmokeSystem.ts
 * Single-draw-call GPU Instanced Volumetric Smoke & Desert Dust Engine:
 *  - Pre-bakes one 256x256 tileable Perlin-Worley density+gradient RGBA DataTexture on startup (~2 ms)
 *  - Renders up to 480 billowing camera-facing quads (desert sand dust, thick tire drift smoke,
 *    and twin-exhaust plumes) in 1 draw call via InstancedBufferGeometry circular ring buffers
 *  - Zero per-frame heap allocations, dead-puff vertex collapse (0 overdraw when idle),
 *    analytical soft ground fade, and full 3D sun/sky/Henyey-Greenstein scattering
 */

import * as THREE from 'three';
import {
  generateVolumetricSmokeAtlas,
  SmokeLayerType,
} from '../core/SmokePhysics';
import {
  VOLUMETRIC_SMOKE_FRAG,
  VOLUMETRIC_SMOKE_VERT,
} from '../shaders/particlesRoost';

export interface VolumetricPuffParams {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spawnTime: number;
  lifetime: number;
  baseSize: number;
  type: SmokeLayerType;
  opacity: number;
  growthMult: number;
  spinRate: number;
}

export interface SmokeEnvironmentState {
  time: number;
  windVecX: number;
  windVecZ: number;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  skyColor: THREE.Color;
  groundBounce: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
  vehiclePos: THREE.Vector3;
  vehicleFwdX: number;
  vehicleFwdZ: number;
  brakeLightPower?: number;
}

export class VolumetricSmokeSystem {
  public readonly mesh: THREE.Mesh;
  public readonly material: THREE.ShaderMaterial;

  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly atlasTexture: THREE.DataTexture;
  private readonly capacity: number;

  private readonly origins: Float32Array;
  private readonly velocities: Float32Array;
  private readonly params: Float32Array;
  private readonly styles: Float32Array;

  private readonly originAttr: THREE.InstancedBufferAttribute;
  private readonly velocityAttr: THREE.InstancedBufferAttribute;
  private readonly paramsAttr: THREE.InstancedBufferAttribute;
  private readonly stylesAttr: THREE.InstancedBufferAttribute;

  private head = 0;
  private dirtyStart = -1;
  private dirtyCount = 0;

  constructor(capacity = 600) {
    this.capacity = capacity;

    // 1. Pre-bake 256x256 tileable Perlin-Worley volumetric cloud atlas (sharp crisp wisps, mipmapped)
    const atlasSize = 256;
    const atlasBytes = generateVolumetricSmokeAtlas(atlasSize);
    this.atlasTexture = new THREE.DataTexture(
      atlasBytes,
      atlasSize,
      atlasSize,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.atlasTexture.wrapS = THREE.RepeatWrapping;
    this.atlasTexture.wrapT = THREE.RepeatWrapping;
    this.atlasTexture.generateMipmaps = true;
    this.atlasTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.atlasTexture.magFilter = THREE.LinearFilter;
    this.atlasTexture.needsUpdate = true;

    // 2. Unit quad InstancedBufferGeometry + zero-GC pre-allocated circular ring buffers
    const baseQuad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = baseQuad.index;
    this.geometry.attributes.position = baseQuad.attributes.position;
    this.geometry.attributes.uv = baseQuad.attributes.uv;
    this.geometry.instanceCount = capacity;
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000);
    baseQuad.dispose();

    this.origins = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);
    this.styles = new Float32Array(capacity * 4);

    // Initialize all slots as expired so they collapse cleanly in the vertex shader
    for (let i = 0; i < capacity; i++) {
      this.params[i * 4 + 0] = -1000;
      this.params[i * 4 + 1] = 0.1;
      this.params[i * 4 + 2] = 0.1;
      this.styles[i * 4 + 1] = 0;
    }

    this.originAttr = new THREE.InstancedBufferAttribute(this.origins, 3);
    this.velocityAttr = new THREE.InstancedBufferAttribute(this.velocities, 3);
    this.paramsAttr = new THREE.InstancedBufferAttribute(this.params, 4);
    this.stylesAttr = new THREE.InstancedBufferAttribute(this.styles, 4);

    this.originAttr.setUsage(THREE.DynamicDrawUsage);
    this.velocityAttr.setUsage(THREE.DynamicDrawUsage);
    this.paramsAttr.setUsage(THREE.DynamicDrawUsage);
    this.stylesAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry.setAttribute('aOrigin', this.originAttr);
    this.geometry.setAttribute('aVelocity', this.velocityAttr);
    this.geometry.setAttribute('aParams', this.paramsAttr);
    this.geometry.setAttribute('aStyle', this.stylesAttr);

    // 3. Physically lit volumetric cloud ShaderMaterial (1 draw call for all smoke types)
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VOLUMETRIC_SMOKE_VERT,
      fragmentShader: VOLUMETRIC_SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      uniforms: {
        uSmokeAtlas: { value: this.atlasTexture },
        uTime: { value: 0 },
        uWindVec: { value: new THREE.Vector2(1.0, 0.5) },
        uSunDir: { value: new THREE.Vector3(0.5, 0.3, 0.8) },
        uSunColor: { value: new THREE.Color(1.5, 1.25, 0.85) },
        uSkyColor: { value: new THREE.Color(0.48, 0.66, 0.90) },
        uGroundBounceColor: { value: new THREE.Color(0.58, 0.40, 0.24) },
        uFogColor: { value: new THREE.Color(0xd9b38c) },
        uFogDensity: { value: 0.0036 },
        uDustColor: { value: new THREE.Color(0.80, 0.44, 0.21) },
        uVehiclePos: { value: new THREE.Vector3() },
        uVehicleFwd: { value: new THREE.Vector2(0, 1) },
        uBrakeLightPower: { value: 0.0 },
        uLinearHdrOutput: { value: 0.0 },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.visible = false;
    this.mesh.renderOrder = 3;
  }

  private maxExpireTime = -1;

  public emitPuff(p: VolumetricPuffParams): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;

    const i3 = i * 3;
    const i4 = i * 4;

    this.origins[i3 + 0] = p.x;
    this.origins[i3 + 1] = p.y;
    this.origins[i3 + 2] = p.z;

    this.velocities[i3 + 0] = p.vx;
    this.velocities[i3 + 1] = p.vy;
    this.velocities[i3 + 2] = p.vz;

    this.params[i4 + 0] = p.spawnTime;
    this.params[i4 + 1] = p.lifetime;
    this.params[i4 + 2] = p.baseSize;
    this.params[i4 + 3] = Math.random();

    this.styles[i4 + 0] = p.type;
    this.styles[i4 + 1] = p.opacity;
    this.styles[i4 + 2] = p.growthMult;
    this.styles[i4 + 3] = p.spinRate;

    if (this.dirtyCount === 0) {
      this.dirtyStart = i;
      this.dirtyCount = 1;
    } else {
      this.dirtyCount = Math.min(this.capacity, this.dirtyCount + 1);
    }
    const expire = p.spawnTime + p.lifetime;
    if (expire > this.maxExpireTime) {
      this.maxExpireTime = expire;
    }
    this.mesh.visible = true;
  }

  public flush(): void {
    if (this.dirtyCount === 0) return;

    this.originAttr.clearUpdateRanges();
    this.velocityAttr.clearUpdateRanges();
    this.paramsAttr.clearUpdateRanges();
    this.stylesAttr.clearUpdateRanges();

    if (this.dirtyCount >= this.capacity) {
      this.originAttr.addUpdateRange(0, this.capacity * 3);
      this.velocityAttr.addUpdateRange(0, this.capacity * 3);
      this.paramsAttr.addUpdateRange(0, this.capacity * 4);
      this.stylesAttr.addUpdateRange(0, this.capacity * 4);
    } else {
      const start = this.dirtyStart;
      const firstCount = Math.min(this.dirtyCount, this.capacity - start);
      const secondCount = this.dirtyCount - firstCount;

      this.originAttr.addUpdateRange(start * 3, firstCount * 3);
      this.velocityAttr.addUpdateRange(start * 3, firstCount * 3);
      this.paramsAttr.addUpdateRange(start * 4, firstCount * 4);
      this.stylesAttr.addUpdateRange(start * 4, firstCount * 4);

      if (secondCount > 0) {
        this.originAttr.addUpdateRange(0, secondCount * 3);
        this.velocityAttr.addUpdateRange(0, secondCount * 3);
        this.paramsAttr.addUpdateRange(0, secondCount * 4);
        this.stylesAttr.addUpdateRange(0, secondCount * 4);
      }
    }

    this.originAttr.needsUpdate = true;
    this.velocityAttr.needsUpdate = true;
    this.paramsAttr.needsUpdate = true;
    this.stylesAttr.needsUpdate = true;
    this.dirtyStart = -1;
    this.dirtyCount = 0;
  }

  public clear(): void {
    for (let i = 0; i < this.capacity; i++) {
      this.params[i * 4 + 0] = -1000;
      this.styles[i * 4 + 1] = 0;
    }
    this.dirtyStart = 0;
    this.dirtyCount = this.capacity;
    this.maxExpireTime = -1;
    this.mesh.visible = false;
    this.flush();
  }

  public syncEnvironment(env: SmokeEnvironmentState): void {
    const alive = env.time <= this.maxExpireTime;
    this.mesh.visible = alive;
    if (!alive) return;
    const u = this.material.uniforms;
    u.uTime.value = env.time;
    u.uWindVec.value.set(env.windVecX, env.windVecZ);
    u.uSunDir.value.copy(env.sunDir);
    u.uSunColor.value.copy(env.sunColor);
    u.uSkyColor.value.copy(env.skyColor);
    u.uGroundBounceColor.value.copy(env.groundBounce);
    u.uFogColor.value.copy(env.fogColor);
    u.uFogDensity.value = env.fogDensity;
    u.uVehiclePos.value.copy(env.vehiclePos);
    u.uVehicleFwd.value.set(env.vehicleFwdX, env.vehicleFwdZ);
    if (env.brakeLightPower !== undefined) {
      u.uBrakeLightPower.value = env.brakeLightPower;
    }
  }

  public setLinearHdrOutput(enabled: boolean): void {
    this.material.uniforms.uLinearHdrOutput.value = enabled ? 1.0 : 0.0;
  }

  public dispose(): void {
    this.atlasTexture.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
