import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TypedArrayPool,
  ScratchIndexList,
  SharedBufferPools,
} from './BufferPool';

test('TypedArrayPool reuses power-of-two buffers across acquire/release cycles', () => {
  const pool = new TypedArrayPool(Float32Array, 4);

  const a = pool.acquire(10);
  assert.equal(a.length, 16);
  a[0] = 42;
  pool.release(a);

  const b = pool.acquire(12);
  assert.strictEqual(b, a, 'same buffer instance should be recycled');
  assert.equal(pool.getStats().hits, 1);
  assert.equal(pool.getStats().misses, 1);

  const c = pool.acquire(33);
  assert.equal(c.length, 64);
  pool.release(c);
  const d = pool.acquire(64);
  assert.strictEqual(d, c);
});

test('TypedArrayPool respects maxPerBucket cap and clear()', () => {
  const pool = new TypedArrayPool(Uint16Array, 2);
  const x = pool.acquire(16);
  const y = pool.acquire(16);
  const z = pool.acquire(16);

  pool.release(x);
  pool.release(y);
  pool.release(z);
  assert.equal(pool.getStats().pooledCount, 2);

  pool.clear();
  assert.equal(pool.getStats().pooledCount, 0);
});

test('ScratchIndexList pushes, grows without losing data, and clears with zero reallocation', () => {
  const list = new ScratchIndexList(8);
  const initialBuf = list.data;
  for (let i = 0; i < 6; i++) {
    list.push(i * 3);
  }
  assert.equal(list.length, 6);
  assert.strictEqual(list.data, initialBuf);

  list.clear();
  assert.equal(list.length, 0);
  assert.strictEqual(list.data, initialBuf);

  for (let i = 0; i < 20; i++) {
    list.push(i);
  }
  assert.equal(list.length, 20);
  assert.equal(list.data[19], 19);
  assert.ok(list.data.length >= 20);
});

test('SharedBufferPools provides typed pools ready for batching and physics', () => {
  const f = SharedBufferPools.float32.acquire(100);
  assert.ok(f instanceof Float32Array && f.length >= 100);
  SharedBufferPools.float32.release(f);

  const u = SharedBufferPools.uint32.acquire(20);
  assert.ok(u instanceof Uint32Array && u.length >= 20);
  SharedBufferPools.uint32.release(u);
});
