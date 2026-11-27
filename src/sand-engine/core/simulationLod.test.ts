import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectSimulationTier,
  consumeLodStepDt,
  createLodCadenceState,
} from './SimulationLod';

test('selectSimulationTier maps distance, focus, and visibility to correct tiers', () => {
  assert.equal(selectSimulationTier(100 * 100, true, false), 'full');
  assert.equal(selectSimulationTier(10 * 10, false, true), 'full');
  assert.equal(selectSimulationTier(35 * 35, false, true), 'medium');
  assert.equal(selectSimulationTier(75 * 75, false, true), 'low');
  assert.equal(selectSimulationTier(130 * 130, false, true), 'sleep');
  assert.equal(selectSimulationTier(20 * 20, false, false), 'low');
  assert.equal(selectSimulationTier(70 * 70, false, false), 'sleep');
});

test('consumeLodStepDt throttles 400 FPS steps to target Hz while conserving simulation time', () => {
  const medState = createLodCadenceState();
  const lowState = createLodCadenceState();
  const dt400 = 1 / 400; // 2.5 ms per render frame

  let totalMedDt = 0;
  let totalLowDt = 0;
  for (let i = 0; i < 400; i++) {
    const m = consumeLodStepDt(medState, dt400, 'medium');
    if (m > 0) totalMedDt += m;
    const l = consumeLodStepDt(lowState, dt400, 'low');
    if (l > 0) totalLowDt += l;
  }

  // 1 second of 400 FPS frames => ~30 medium steps, ~15 low steps
  assert.ok(medState.steps >= 29 && medState.steps <= 31, `expected ~30 steps, got ${medState.steps}`);
  assert.ok(lowState.steps >= 14 && lowState.steps <= 16, `expected ~15 steps, got ${lowState.steps}`);
  assert.ok(Math.abs(totalMedDt - 1.0) < 0.05, `time conserved med: ${totalMedDt}`);
  assert.ok(Math.abs(totalLowDt - 1.0) < 0.08, `time conserved low: ${totalLowDt}`);
});

test('consumeLodStepDt handles sleep tier without stepping', () => {
  const state = createLodCadenceState();
  assert.equal(consumeLodStepDt(state, 1 / 60, 'sleep'), 0);
  assert.equal(state.steps, 0);
});
