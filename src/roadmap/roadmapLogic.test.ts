import test from 'node:test';
import assert from 'node:assert/strict';
import { ROADMAP_SECTIONS } from './roadmapData';
import {
  buildStandaloneRoadmapHtml,
  computeOverallProgress,
  computeSectionProgress,
  countBySeverity,
  filterChecklistItems,
  getAdjacentSections,
  getDefaultCompletedIds,
  getSectionById,
  searchRoadmap,
} from './roadmapLogic';

test('roadmap covers all 9 chapters from Fundamentos through Ecossistema & Sprints', () => {
  assert.equal(ROADMAP_SECTIONS.length, 9);
  assert.deepEqual(
    ROADMAP_SECTIONS.map((s) => s.id),
    [
      'fundamentos',
      'fase-0',
      'fase-1',
      'fase-2',
      'fase-3',
      'fase-4',
      'fase-5',
      'fase-6',
      'ecossistema-sprints',
    ],
  );
});

test('Fase 0 contains all 36 audit bullets across 0.1–0.4 with severities', () => {
  const counts = countBySeverity(ROADMAP_SECTIONS, 'fase-0');
  assert.equal(counts.ALL, 36);
  assert.equal(counts.CRÍTICO, 5);
  assert.equal(counts.ALTO, 14);
  assert.equal(counts.MÉDIO, 13);
  assert.equal(counts.BAIXO, 4);
});

test('filterChecklistItems filters accurately by severity and search query', () => {
  const fase0 = getSectionById(ROADMAP_SECTIONS, 'fase-0');
  const sub01 = fase0.subSections[0];
  const criticalOnly = filterChecklistItems(sub01.items ?? [], 'CRÍTICO');
  assert.equal(criticalOnly.length, 1);
  assert.match(criticalOnly[0].title, /Texturas fotográficas/);

  const guardSearch = filterChecklistItems(sub01.items ?? [], 'ALTO', 'guard band');
  assert.equal(guardSearch.length, 1);
  assert.equal(guardSearch[0].id, 'f0-1-2');
});

test('getAdjacentSections handles boundary chapters and transitions', () => {
  const first = getAdjacentSections(ROADMAP_SECTIONS, 'fundamentos');
  assert.equal(first.prev, null);
  assert.equal(first.next?.id, 'fase-0');

  const last = getAdjacentSections(ROADMAP_SECTIONS, 'ecossistema-sprints');
  assert.equal(last.prev?.id, 'fase-6');
  assert.equal(last.next, null);
});

test('searchRoadmap finds technical terms across phases with accurate target IDs', () => {
  const joltHits = searchRoadmap(ROADMAP_SECTIONS, 'MixedContactResolver');
  assert.ok(joltHits.length >= 1);
  assert.equal(joltHits[0].sectionId, 'fase-2');
  assert.equal(joltHits[0].subSectionId, 'f2-1');

  const mpmHits = searchRoadmap(ROADMAP_SECTIONS, 'MLS-MPM');
  assert.ok(mpmHits.some((h) => h.sectionId === 'fase-6'));

  const waveguideHits = searchRoadmap(ROADMAP_SECTIONS, 'Waveguide');
  assert.ok(waveguideHits.some((h) => h.sectionId === 'fase-5'));
});

test('progress calculations compute section and overall completion accurately', () => {
  const fase1 = getSectionById(ROADMAP_SECTIONS, 'fase-1');
  const done = new Set(['f1-1-1', 'f1-2-1']);
  const secProgress = computeSectionProgress(fase1, done);
  assert.equal(secProgress.completed, 2);
  assert.equal(secProgress.total, 13);
  assert.equal(secProgress.percent, 15);

  const overall = computeOverallProgress(ROADMAP_SECTIONS, done);
  assert.equal(overall.completed, 2);
  assert.ok(overall.total > 80);
});

test('buildStandaloneRoadmapHtml outputs valid dark-mode HTML without raw LaTeX delimiters', () => {
  const html = buildStandaloneRoadmapHtml(ROADMAP_SECTIONS);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('#050507'));
  assert.ok(html.includes('DuneFlow Roadmap'));
  assert.ok(html.includes('Fase 0 — Hardening'));
  assert.ok(html.includes('JoltPhysics.js'));
  assert.equal(/\$(?:F_z|\\tau|k_\\phi|C\^1)\$/.test(html), false);
});

test('All Phase 0 items (0.1–0.4: 36/36) are marked completed by default across data and standalone HTML', () => {
  const defaults = getDefaultCompletedIds(ROADMAP_SECTIONS);
  for (let i = 1; i <= 12; i++) {
    assert.equal(defaults.has(`f0-1-${i}`), true, `expected f0-1-${i} in default completed set`);
  }
  for (let i = 1; i <= 10; i++) {
    assert.equal(defaults.has(`f0-2-${i}`), true, `expected f0-2-${i} in default completed set`);
  }
  for (let i = 1; i <= 11; i++) {
    assert.equal(defaults.has(`f0-3-${i}`), true, `expected f0-3-${i} in default completed set`);
  }
  for (let i = 1; i <= 3; i++) {
    assert.equal(defaults.has(`f0-4-${i}`), true, `expected f0-4-${i} in default completed set`);
  }
  const fase0 = getSectionById(ROADMAP_SECTIONS, 'fase-0');
  const p0 = computeSectionProgress(fase0, defaults);
  assert.equal(p0.completed, 36);
  assert.equal(p0.total, 36);
  assert.equal(p0.percent, 100);

  const html = buildStandaloneRoadmapHtml(ROADMAP_SECTIONS);
  assert.ok(html.includes('"id":"f0-1-1"'));
  assert.ok(html.includes('"id":"f0-2-1"'));
  assert.ok(html.includes('"id":"f0-3-1"'));
  assert.ok(html.includes('"id":"f0-4-3"'));
  assert.ok(html.includes('"completed":true'));
});

test('public/roadmap.html matches buildStandaloneRoadmapHtml(ROADMAP_SECTIONS)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const expected = buildStandaloneRoadmapHtml(ROADMAP_SECTIONS);
  const actual = fs.readFileSync(path.resolve(process.cwd(), 'public/roadmap.html'), 'utf8');
  assert.equal(actual, expected);
});


