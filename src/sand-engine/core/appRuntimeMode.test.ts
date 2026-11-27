import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInitialRuntimeConfig,
  computeUnifiedBootProgress,
  detectStandaloneAppMode,
  getMaxPerformanceConfigPatch,
} from './AppRuntimeMode';
import { DEFAULT_RUNTIME_CONFIG } from './SandParams';

test('detectStandaloneAppMode detects standalone display mode, iOS standalone, and launch query', () => {
  assert.equal(
    detectStandaloneAppMode({
      displayModeStandalone: true,
      navigatorStandalone: false,
      locationSearch: '',
    }),
    true,
  );
  assert.equal(
    detectStandaloneAppMode({
      displayModeStandalone: false,
      navigatorStandalone: true,
      locationSearch: '',
    }),
    true,
  );
  assert.equal(
    detectStandaloneAppMode({
      displayModeStandalone: false,
      navigatorStandalone: false,
      locationSearch: '?launch=standalone',
    }),
    true,
  );
  assert.equal(
    detectStandaloneAppMode({
      displayModeStandalone: false,
      navigatorStandalone: false,
      locationSearch: '?view=sim',
    }),
    false,
  );
});

test('buildInitialRuntimeConfig keeps PC ultra and unlocks max performance in standalone app mode', () => {
  const pcBrowser = buildInitialRuntimeConfig({
    isMobileDevice: false,
    isStandaloneApp: false,
  });
  assert.equal(pcBrowser.graphicsQuality, 'ultra');
  assert.equal(pcBrowser.fpsUncapped, false);
  assert.equal(DEFAULT_RUNTIME_CONFIG.fpsUncapped, false);

  const mobileBrowser = buildInitialRuntimeConfig({
    isMobileDevice: true,
    isStandaloneApp: false,
  });
  assert.equal(mobileBrowser.graphicsQuality, 'hybrid');
  assert.equal(mobileBrowser.fpsUncapped, false);

  const pcStandalone = buildInitialRuntimeConfig({
    isMobileDevice: false,
    isStandaloneApp: true,
  });
  assert.equal(pcStandalone.graphicsQuality, 'ultra');
  assert.equal(pcStandalone.fpsUncapped, true);

  const mobileStandalone = buildInitialRuntimeConfig({
    isMobileDevice: true,
    isStandaloneApp: true,
  });
  assert.equal(mobileStandalone.graphicsQuality, 'ultra');
  assert.equal(mobileStandalone.fpsUncapped, true);

  assert.deepEqual(getMaxPerformanceConfigPatch(), {
    graphicsQuality: 'ultra',
    fpsUncapped: true,
  });
});

test('computeUnifiedBootProgress enforces synchronized scene + vehicle reveal gate', () => {
  const downloading = computeUnifiedBootProgress({
    downloadRatio: 0.5,
    loadedBytes: 4_100_000,
    totalBytes: 8_200_000,
    parseCompleted: false,
    sceneReady: false,
    vehicleReady: false,
  });
  assert.equal(downloading.stage, 'downloading');
  assert.equal(downloading.isComplete, false);
  assert.ok(downloading.progressPct >= 25 && downloading.progressPct < 55);

  // Even when the 3D scenery finishes setup, boot gate stays closed until vehicle is also ready!
  const sceneryAlone = computeUnifiedBootProgress({
    downloadRatio: 0.8,
    loadedBytes: 6_500_000,
    totalBytes: 8_200_000,
    parseCompleted: false,
    sceneReady: true,
    vehicleReady: false,
  });
  assert.equal(sceneryAlone.isComplete, false);
  assert.ok(sceneryAlone.progressPct < 99);

  const compiling = computeUnifiedBootProgress({
    downloadRatio: 1,
    loadedBytes: 8_200_000,
    totalBytes: 8_200_000,
    parseCompleted: true,
    sceneReady: true,
    vehicleReady: false,
  });
  assert.equal(compiling.stage, 'compiling');
  assert.equal(compiling.isComplete, false);
  assert.equal(compiling.progressPct, 90);

  const ready = computeUnifiedBootProgress({
    downloadRatio: 1,
    loadedBytes: 8_200_000,
    totalBytes: 8_200_000,
    parseCompleted: true,
    sceneReady: true,
    vehicleReady: true,
  });
  assert.equal(ready.stage, 'ready');
  assert.equal(ready.isComplete, true);
  assert.equal(ready.progressPct, 100);
});
