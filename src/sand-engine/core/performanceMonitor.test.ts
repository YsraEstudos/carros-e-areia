import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceMonitor } from './PerformanceMonitor';

test('PerformanceMonitor computes steady high-refresh uncapped FPS accurately (240+ FPS)', () => {
  const mon = new PerformanceMonitor(200);
  // Simulate 250 FPS (4.0ms frame delta), 1.2ms CPU work, 2.8ms hardware GPU work
  for (let i = 0; i < 200; i++) {
    mon.recordFrame({
      frameDeltaMs: 4.0,
      cpuWorkMs: 1.2,
      gpuFrameMs: 2.8,
      uncappedMode: true,
    });
  }

  const snap = mon.getSnapshot();
  assert.equal(snap.fps, 250);
  assert.equal(snap.onePercentLowFps, 250);
  assert.equal(snap.cpuUsagePct, 30);
  assert.equal(snap.gpuUsagePct, 70);
  assert.equal(snap.gpuHardwareMeasured, true);
  assert.equal(snap.sampleCount, 200);
});

test('PerformanceMonitor calculates true 1% Low FPS when frame spikes occur', () => {
  const mon = new PerformanceMonitor(200);
  // 198 smooth frames at 10ms (100 FPS) + 2 hitch frames at 50ms (20 FPS) distributed in window
  // Slowest 1% of 200 frames = 2 frames -> mean 50ms -> 1% Low = 20 FPS!
  for (let i = 0; i < 200; i++) {
    if (i === 50 || i === 120) {
      mon.recordFrame({ frameDeltaMs: 50.0, cpuWorkMs: 12.0, gpuFrameMs: 38.0, uncappedMode: true });
    } else {
      mon.recordFrame({
        frameDeltaMs: 10.0,
        cpuWorkMs: 3.0,
        gpuFrameMs: 6.0,
        uncappedMode: true,
      });
    }
  }

  const snap = mon.getSnapshot();
  assert.ok(snap.fps >= 90 && snap.fps <= 100, `Expected average FPS near 90-100, got ${snap.fps}`);
  assert.equal(snap.onePercentLowFps, 20, `Expected exact 1% Low of 20 FPS, got ${snap.onePercentLowFps}`);
  assert.ok(snap.onePercentLowFps < snap.fps);
});

test('PerformanceMonitor ignores tab-background pauses > 500ms so 1% Low stays truthful', () => {
  const mon = new PerformanceMonitor(100);
  for (let i = 0; i < 100; i++) {
    mon.recordFrame({
      frameDeltaMs: 16.667,
      cpuWorkMs: 4.0,
      gpuFrameMs: 10.0,
      uncappedMode: false,
    });
  }
  // Tab backgrounded for 4 seconds
  mon.recordFrame({
    frameDeltaMs: 4000,
    cpuWorkMs: 5,
    gpuFrameMs: 10,
    uncappedMode: false,
  });

  const snap = mon.getSnapshot();
  assert.equal(snap.fps, 60);
  assert.equal(snap.onePercentLowFps, 60);
});

test('PerformanceMonitor provides calibrated fallback GPU% when hardware timer is absent', () => {
  const monLow = new PerformanceMonitor(60);
  const monUltra = new PerformanceMonitor(60);
  for (let i = 0; i < 60; i++) {
    monLow.recordFrame({
      frameDeltaMs: 16.667,
      cpuWorkMs: 2.0,
      gpuFrameMs: null,
      uncappedMode: false,
      gpuLoadHint: 0.25,
    });
    monUltra.recordFrame({
      frameDeltaMs: 16.667,
      cpuWorkMs: 2.0,
      gpuFrameMs: null,
      uncappedMode: false,
      gpuLoadHint: 0.92,
    });
  }

  const snapLow = monLow.getSnapshot();
  const snapUltra = monUltra.getSnapshot();
  assert.equal(snapLow.gpuHardwareMeasured, false);
  assert.equal(snapUltra.gpuHardwareMeasured, false);
  assert.ok(snapLow.gpuUsagePct > 0 && snapLow.gpuUsagePct < 100);
  assert.ok(snapUltra.gpuUsagePct > snapLow.gpuUsagePct, 'Ultra GPU load hint must report higher GPU% than Low');
});

test('PerformanceMonitor clamps CPU% and GPU% strictly within 0..100% and resets cleanly', () => {
  const mon = new PerformanceMonitor(60);
  mon.recordFrame({
    frameDeltaMs: 8.0,
    cpuWorkMs: 25.0, // exceeds frame delta
    gpuFrameMs: 40.0, // exceeds frame delta
    uncappedMode: true,
  });
  const snap = mon.getSnapshot();
  assert.ok(snap.cpuUsagePct >= 0 && snap.cpuUsagePct <= 100);
  assert.ok(snap.gpuUsagePct >= 0 && snap.gpuUsagePct <= 100);

  mon.reset();
  const afterReset = mon.getSnapshot();
  assert.equal(afterReset.sampleCount, 0);
  assert.equal(afterReset.fps, 0);
});
