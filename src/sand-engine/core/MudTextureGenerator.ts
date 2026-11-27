/**
 * MudTextureGenerator.ts
 * Pure, deterministic procedural generator for a tileable RGBA8 Wet Mud & Organic Loam
 * detail texture (`256x256`, zero external network fetches):
 *   R: Organic loam & silt albedo modulation (warm/cool umber variation + scattered stones)
 *   G: High-frequency micro-heightfield (for crisp RNM central-difference mud lumps, pores & grit)
 *   B: Moisture / smooth slickness mask (separates glassy wet clay ribs from porous silt)
 *   A: Fine gravel & dark humic fleck mask
 */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hash2Periodic(ix: number, iy: number, period: number, seed: number): number {
  const px = ((ix % period) + period) % period;
  const py = ((iy % period) + period) % period;
  let n = (px * 374761393 + py * 668265263 + seed * 1442695041) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967295;
}

function valueNoisePeriodic(
  u: number,
  v: number,
  freq: number,
  seed: number,
): number {
  const x = u * freq;
  const y = v * freq;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const n00 = hash2Periodic(ix, iy, freq, seed);
  const n10 = hash2Periodic(ix + 1, iy, freq, seed);
  const n01 = hash2Periodic(ix, iy + 1, freq, seed);
  const n11 = hash2Periodic(ix + 1, iy + 1, freq, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

/** Tileable Worley cellular pebbles & mud clod domes */
function worleyClodPeriodic(
  u: number,
  v: number,
  cells: number,
  seed: number,
): { dist: number; cellRnd: number } {
  const x = u * cells;
  const y = v * cells;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  let minD2 = 4.0;
  let bestCell = 0.5;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const rx = hash2Periodic(ix + dx, iy + dy, cells, seed);
      const ry = hash2Periodic(ix + dx, iy + dy, cells, seed + 71);
      const ddx = dx + rx - fx;
      const ddy = dy + ry - fy;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < minD2) {
        minD2 = d2;
        bestCell = hash2Periodic(ix + dx, iy + dy, cells, seed + 193);
      }
    }
  }
  return {
    dist: Math.sqrt(minD2),
    cellRnd: bestCell,
  };
}

export function generateMudDetailTexture(size = 256): Uint8Array {
  const total = size * size;
  const rgba = new Uint8Array(total * 4);

  const heightBuf = new Float32Array(total);
  const loamBuf = new Float32Array(total);
  const slickBuf = new Float32Array(total);
  const gritBuf = new Float32Array(total);

  let minH = 1e9;
  let maxH = -1e9;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;

      // Multi-scale organic mud loam undulation (broad fluid silt flows + subtle pores)
      const n4 = valueNoisePeriodic(u, v, 4, 17);
      const n8 = valueNoisePeriodic(u, v, 8, 53);
      const n16 = valueNoisePeriodic(u, v, 16, 109);
      const n32 = valueNoisePeriodic(u, v, 32, 211);
      const n64 = valueNoisePeriodic(u, v, 64, 409);

      // Soft directional viscous drag streaks (exact integer periods: Δu -> +6, Δv -> +6/+24 mod 6, zero UV seam)
      const streak = valueNoisePeriodic(u + v, v * 4.0, 6, 313);

      // Subtle embedded tiny stones & damp silt pores (avoid bumpy cobblestone domes)
      const clodMed = worleyClodPeriodic(u, v, 8, 503);
      const clodFine = worleyClodPeriodic(u, v, 28, 701);

      const lumpProfile = clamp(1.0 - clodMed.dist * 1.15, 0, 1);
      const pebbleSpot =
        clodFine.cellRnd > 0.80 ? clamp(1.0 - clodFine.dist * 2.35, 0, 1) : 0.0;
      const porePit =
        clodFine.cellRnd < 0.22 ? clamp(1.0 - clodFine.dist * 2.45, 0, 1) : 0.0;

      const h =
        n4 * 0.34 +
        n8 * 0.24 +
        n16 * 0.14 +
        n32 * 0.08 +
        n64 * 0.04 +
        streak * 0.16 +
        lumpProfile * 0.05 +
        pebbleSpot * 0.11 -
        porePit * 0.12;

      heightBuf[idx] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;

      // Rich organic loam albedo modulation (silty clay streaks, warm humps, dark water pores)
      const loam = clamp(
        0.46 +
          (n4 - 0.5) * 0.28 +
          (n8 - 0.5) * 0.26 +
          (n32 - 0.5) * 0.20 +
          (n64 - 0.5) * 0.12 +
          pebbleSpot * 0.16 -
          porePit * 0.24,
        0,
        1,
      );
      loamBuf[idx] = loam;

      // Wetness / glossy clay slick mask (smoothed streaks & low hollows shine; gravel specks stay rougher)
      const slick = clamp(
        n4 * 0.48 + streak * 0.40 + (1.0 - n32) * 0.14 - pebbleSpot * 0.42,
        0,
        1,
      );
      slickBuf[idx] = slick;

      // Fine mineral / organic debris fleck mask
      const grit = clamp(
        n64 * 0.50 + pebbleSpot * 0.44 + (1.0 - porePit) * 0.12,
        0,
        1,
      );
      gritBuf[idx] = grit;
    }
  }

  const invH = 1.0 / Math.max(1e-4, maxH - minH);
  for (let i = 0; i < total; i++) {
    const hNorm = clamp((heightBuf[i] - minH) * invH, 0, 1);
    const o = i * 4;
    rgba[o + 0] = Math.round(loamBuf[i] * 255);
    rgba[o + 1] = Math.round(hNorm * 255);
    rgba[o + 2] = Math.round(slickBuf[i] * 255);
    rgba[o + 3] = Math.round(gritBuf[i] * 255);
  }

  return rgba;
}
