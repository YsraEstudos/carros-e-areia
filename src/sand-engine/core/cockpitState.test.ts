import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMBIENT_LIGHT_PRESETS,
  computeHazardFlash01,
  createInitialCockpitState,
  cycleHeadlightMode,
  cycleWiperMode,
  formatTrackTime,
  handleCabinSwitchAction,
  handleSyncScreenTouchUV,
  MIRROR_PITCH_LIMIT_RAD,
  MIRROR_YAW_LIMIT_RAD,
  RAPTOR_PLAYLIST,
  stepCockpitState,
} from './CockpitStateModel';

test('initial cockpit state matches Reference Image 1 defaults', () => {
  const s = createInitialCockpitState();
  assert.equal(s.activeTab, 'audio');
  assert.equal(s.mediaSource, 'spotify');
  assert.equal(RAPTOR_PLAYLIST[s.trackIndex].title, 'Earrings');
  assert.equal(RAPTOR_PLAYLIST[s.trackIndex].artist, 'Malcolm Todd');
  assert.equal(RAPTOR_PLAYLIST[s.trackIndex].album, 'Sweet Boy');
  assert.equal(formatTrackTime(s.trackElapsedSec), '0:40');
  assert.equal(
    formatTrackTime(RAPTOR_PLAYLIST[s.trackIndex].durationSec - s.trackElapsedSec),
    '1:51',
  );
  assert.equal(Math.round(s.odometerKm), 12486);
  assert.equal(Number(s.tripKm.toFixed(1)), 5.8);
  assert.equal(s.rayTracedLighting, true);
  assert.equal(s.ambientLightOn, true);
});

test('wiper cycle transitions through all 4 modes and sweeps smoothly', () => {
  assert.equal(cycleWiperMode('off'), 'intermittent');
  assert.equal(cycleWiperMode('intermittent'), 'normal');
  assert.equal(cycleWiperMode('normal'), 'fast');
  assert.equal(cycleWiperMode('fast'), 'off');

  const s = createInitialCockpitState();
  s.wiperMode = 'normal';
  const startAngle = s.wiperLeftAngleRad;
  for (let i = 0; i < 20; i++) {
    stepCockpitState(s, 0.03, {
      speedMs: 15,
      accelForwardMs2: 0,
      lateralG: 0,
      rainIntensity: 0.8,
      suspensionBump: 0,
    });
  }
  assert.notEqual(s.wiperLeftAngleRad, startAngle, 'normal wiper mode must sweep blades');
  assert.ok(s.wiperWipeFreshness > 0.7, 'active wipers must keep swept arc clean');
});

test('damaged wipers jam mid-windshield and allow rain buildup', () => {
  const s = createInitialCockpitState();
  s.wiperMode = 'fast';
  for (let i = 0; i < 40; i++) {
    stepCockpitState(s, 0.05, {
      speedMs: 10,
      accelForwardMs2: 0,
      lateralG: 0,
      rainIntensity: 0.9,
      suspensionBump: 0,
      wiperDamaged: true,
    });
  }
  assert.equal(s.wiperDamaged, true);
  assert.ok(Math.abs(s.wiperSweep01 - 0.46) < 0.08, 'damaged wipers jam mid-arc');
  assert.ok(s.wiperWipeFreshness < 0.5, 'jammed wipers lose wipe freshness in rain');
});

test('odometer and trip integrate distance accurately while driving', () => {
  const s = createInitialCockpitState();
  const odo0 = s.odometerKm;
  const trip0 = s.tripKm;
  for (let i = 0; i < 1000; i++) {
    stepCockpitState(s, 0.05, {
      speedMs: 20,
      accelForwardMs2: 0,
      lateralG: 0,
      rainIntensity: 0.7,
      suspensionBump: 0,
    });
  }
  assert.ok(Math.abs(s.odometerKm - (odo0 + 1.0)) < 0.01);
  assert.ok(Math.abs(s.tripKm - (trip0 + 1.0)) < 0.01);
});

test('SYNC 4 UV touch interactions control media, climate in Config, and quick tabs', () => {
  const s = createInitialCockpitState();

  // Click Next track button (x ~ 0.88, y ~ 0.58 => v = 1 - 0.58 = 0.42)
  const nextRes = handleSyncScreenTouchUV(s, 0.88, 0.42);
  assert.equal(nextRes.action, 'media:next');
  assert.equal(s.trackIndex, 1);

  // Click Play/Pause button (x ~ 0.76, y ~ 0.58 => v = 0.42)
  const pauseRes = handleSyncScreenTouchUV(s, 0.76, 0.42);
  assert.equal(pauseRes.action, 'media:pause');
  assert.equal(s.isPlaying, false);

  // Click Radio pill (x ~ 0.10, y ~ 0.16 => v = 0.84)
  const radioRes = handleSyncScreenTouchUV(s, 0.1, 0.84);
  assert.equal(radioRes.action, 'source:radio');
  assert.equal(s.mediaSource, 'radio');

  // Click Config tab at bottom (6th of 6 tabs: x ~ 0.92, y ~ 0.92 => v = 0.08)
  const tabRes = handleSyncScreenTouchUV(s, 0.92, 0.08);
  assert.equal(tabRes.action, 'tab:settings');
  assert.equal(s.activeTab, 'settings');

  // Click Temp Up inside Config tab (x ~ 0.50, y ~ 0.46 => v = 0.54)
  const prevTemp = s.cabinTempC;
  const tempRes = handleSyncScreenTouchUV(s, 0.5, 0.54);
  assert.equal(tempRes.action, 'climate:temp_up');
  assert.equal(s.cabinTempC, prevTemp + 1);
});

test('SYNC 4 Luzes tab toggles headlights, lightbar, dome, ambient colors, and Ray/Path Tracing GI', () => {
  assert.equal(cycleHeadlightMode('off'), 'low');
  assert.equal(cycleHeadlightMode('low'), 'high');
  assert.equal(cycleHeadlightMode('high'), 'off');

  const s = createInitialCockpitState();

  // Open Luzes tab (3rd of 6 bottom tabs: x ~ 0.42, y ~ 0.92 => v = 0.08)
  const lightsTab = handleSyncScreenTouchUV(s, 0.42, 0.08);
  assert.equal(lightsTab.action, 'tab:lights');
  assert.equal(s.activeTab, 'lights');

  // Row 1 Col 1: Faróis (low -> high) at x=0.18, y=0.25 => v=0.75
  const hl1 = handleSyncScreenTouchUV(s, 0.18, 0.75);
  assert.equal(hl1.action, 'lights:headlights_high');
  assert.equal(s.headlightMode, 'high');

  // Row 1 Col 2: Barra LED (off -> on) at x=0.50, y=0.25 => v=0.75
  const lb = handleSyncScreenTouchUV(s, 0.5, 0.75);
  assert.equal(lb.action, 'lights:lightbar_on');
  assert.equal(s.lightbarOn, true);

  // Row 2 Col 1: Pisca-Alerta (off -> on) at x=0.18, y=0.44 => v=0.56
  const haz = handleSyncScreenTouchUV(s, 0.18, 0.56);
  assert.equal(haz.action, 'lights:hazard_on');
  assert.equal(s.hazardOn, true);
  assert.ok(computeHazardFlash01(0.15, true) > 0.8, 'hazard flasher must illuminate during ON phase');
  assert.equal(computeHazardFlash01(0.5, true), 0, 'hazard flasher must darken during OFF phase');

  // Row 2 Col 2: Luz de Teto (off -> on) at x=0.50, y=0.44 => v=0.56
  const dome = handleSyncScreenTouchUV(s, 0.5, 0.56);
  assert.equal(dome.action, 'lights:dome_on');
  assert.equal(s.domeLightOn, true);

  // Row 3: Select Ice Cyan ambient color (index 1 -> x ~ 0.19, y = 0.61 => v = 0.39)
  const swatch = handleSyncScreenTouchUV(s, 0.19, 0.39);
  assert.equal(swatch.action, `lights:color_${AMBIENT_LIGHT_PRESETS[1].id}`);
  assert.equal(s.ambientColorIndex, 1);

  // Row 4 Left: Toggle Ray / Path Tracing GI OFF then ON (x = 0.28, y = 0.76 => v = 0.24)
  const rtOff = handleSyncScreenTouchUV(s, 0.28, 0.24);
  assert.equal(rtOff.action, 'lights:rt_gi_off');
  assert.equal(s.rayTracedLighting, false);

  // Row 4 Right: Cycle RT bounce strength (re-enables RT GI and advances strength)
  const rtBoost = handleSyncScreenTouchUV(s, 0.78, 0.24);
  assert.equal(s.rayTracedLighting, true);
  assert.ok(rtBoost.action.startsWith('lights:rt_strength_'));
});

test('SYNC 4 Espelhos tab selects mirrors, aims with D-pad clamping, and smoothly power-folds', () => {
  const s = createInitialCockpitState();

  // Open Espelhos tab (4th of 6 bottom tabs: x ~ 0.58, y ~ 0.92 => v = 0.08)
  const mirTab = handleSyncScreenTouchUV(s, 0.58, 0.08);
  assert.equal(mirTab.action, 'tab:mirrors');
  assert.equal(s.activeTab, 'mirrors');

  // Select Interior mirror (x = 0.26, y = 0.34 => v = 0.66)
  const selInt = handleSyncScreenTouchUV(s, 0.26, 0.66);
  assert.equal(selInt.action, 'mirrors:select_interior');
  assert.equal(s.selectedMirror, 'interior');

  // Tap Left & Up on D-pad repeatedly to test aim response and clamping
  for (let i = 0; i < 10; i++) {
    handleSyncScreenTouchUV(s, 0.62, 0.52); // Left (x=0.62, y=0.48)
    handleSyncScreenTouchUV(s, 0.74, 0.68); // Up (x=0.74, y=0.32)
  }
  assert.equal(s.mirrors.interior.yawRad, MIRROR_YAW_LIMIT_RAD);
  assert.equal(s.mirrors.interior.pitchRad, MIRROR_PITCH_LIMIT_RAD);

  // Tap D-pad center bullseye (x=0.74, y=0.48 => v=0.52) to reset active mirror
  const centerRes = handleSyncScreenTouchUV(s, 0.74, 0.52);
  assert.equal(centerRes.action, 'mirrors:center_interior');
  assert.equal(s.mirrors.interior.yawRad, 0);
  assert.equal(s.mirrors.interior.pitchRad, 0);

  // Tap Power Fold (x=0.25, y=0.62 => v=0.38) and step cockpit state
  const foldRes = handleSyncScreenTouchUV(s, 0.25, 0.38);
  assert.equal(foldRes.action, 'mirrors:fold_in');
  assert.equal(s.mirrorsFolded, true);

  for (let i = 0; i < 20; i++) {
    stepCockpitState(s, 0.04, {
      speedMs: 0,
      accelForwardMs2: 0,
      lateralG: 0,
      rainIntensity: 0,
      suspensionBump: 0,
    });
  }
  assert.equal(s.mirrorFold01, 1.0, 'power-fold servo must smoothly reach 1.0');
});

test('3D physical overhead upfitter switches toggle lighting state cleanly', () => {
  const s = createInitialCockpitState();
  assert.equal(s.domeLightOn, false);
  const resDome = handleCabinSwitchAction(s, 'dome');
  assert.equal(resDome.action, 'switch:dome_on');
  assert.equal(s.domeLightOn, true);

  const resBar = handleCabinSwitchAction(s, 'lightbar');
  assert.equal(resBar.action, 'switch:lightbar_on');
  assert.equal(s.lightbarOn, true);
});
