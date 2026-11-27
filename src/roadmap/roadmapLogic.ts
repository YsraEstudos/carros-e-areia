import {
  ROADMAP_META,
  ROADMAP_SECTIONS,
  RoadmapChecklistItem,
  RoadmapSection,
  SeverityLevel,
} from './roadmapData';

export type SeverityFilter = 'ALL' | SeverityLevel;

export interface SearchHit {
  sectionId: string;
  sectionIndexLabel: string;
  sectionTitle: string;
  subSectionId: string;
  subSectionCode: string;
  subSectionTitle: string;
  itemId?: string;
  title: string;
  snippet: string;
  severity?: SeverityLevel;
}

export interface ProgressStats {
  completed: number;
  total: number;
  percent: number;
}

export function getSectionIndex(
  sections: RoadmapSection[],
  sectionId: string,
): number {
  const idx = sections.findIndex((s) => s.id === sectionId);
  return idx >= 0 ? idx : 0;
}

export function getSectionById(
  sections: RoadmapSection[],
  sectionId: string,
): RoadmapSection {
  return sections[getSectionIndex(sections, sectionId)];
}

export function getAdjacentSections(
  sections: RoadmapSection[],
  sectionId: string,
): { prev: RoadmapSection | null; next: RoadmapSection | null } {
  const idx = getSectionIndex(sections, sectionId);
  return {
    prev: idx > 0 ? sections[idx - 1] : null,
    next: idx < sections.length - 1 ? sections[idx + 1] : null,
  };
}

const _itemHaystackCache = new WeakMap<RoadmapChecklistItem, string>();
const _subTextCache = new WeakMap<object, string>();
const _rowTextCache = new WeakMap<string[], string>();

function getItemHaystack(item: RoadmapChecklistItem): string {
  let cached = _itemHaystackCache.get(item);
  if (cached === undefined) {
    cached = [
      item.title,
      item.fileRef ?? '',
      item.problem ?? '',
      item.action ?? '',
      item.tag ?? '',
      ...(item.details ?? []),
    ]
      .join(' ')
      .toLowerCase();
    _itemHaystackCache.set(item, cached);
  }
  return cached;
}

function getSubText(sub: RoadmapSection['subSections'][number]): string {
  let cached = _subTextCache.get(sub);
  if (cached === undefined) {
    cached = `${sub.code} ${sub.title} ${sub.summary ?? ''}`.toLowerCase();
    _subTextCache.set(sub, cached);
  }
  return cached;
}

function getRowText(row: string[]): string {
  let cached = _rowTextCache.get(row);
  if (cached === undefined) {
    cached = row.join(' — ').toLowerCase();
    _rowTextCache.set(row, cached);
  }
  return cached;
}

export function filterChecklistItems(
  items: RoadmapChecklistItem[],
  severity: SeverityFilter,
  query = '',
): RoadmapChecklistItem[] {
  const normalized = query.trim().toLowerCase();
  return items.filter((item) => {
    if (severity !== 'ALL' && item.severity !== severity) {
      return false;
    }
    if (!normalized) return true;
    return getItemHaystack(item).includes(normalized);
  });
}

export function countBySeverity(
  sections: RoadmapSection[],
  sectionId: string,
): Record<SeverityFilter, number> {
  const section = getSectionById(sections, sectionId);
  const counts: Record<SeverityFilter, number> = {
    ALL: 0,
    CRÍTICO: 0,
    ALTO: 0,
    MÉDIO: 0,
    BAIXO: 0,
  };
  for (const sub of section.subSections) {
    for (const item of sub.items ?? []) {
      counts.ALL += 1;
      if (item.severity) {
        counts[item.severity] += 1;
      }
    }
  }
  return counts;
}

export function getDefaultCompletedIds(
  sections: RoadmapSection[],
): Set<string> {
  const done = new Set<string>();
  for (const section of sections) {
    for (const sub of section.subSections) {
      for (const item of sub.items ?? []) {
        if (item.completed) {
          done.add(item.id);
        }
      }
    }
  }
  return done;
}

export function computeSectionProgress(
  section: RoadmapSection,
  completedIds: ReadonlySet<string>,
): ProgressStats {
  let total = 0;
  let completed = 0;
  for (const sub of section.subSections) {
    for (const item of sub.items ?? []) {
      total += 1;
      if (completedIds.has(item.id)) {
        completed += 1;
      }
    }
  }
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { completed, total, percent };
}

export function computeOverallProgress(
  sections: RoadmapSection[],
  completedIds: ReadonlySet<string>,
): ProgressStats {
  let total = 0;
  let completed = 0;
  for (const section of sections) {
    const stats = computeSectionProgress(section, completedIds);
    total += stats.total;
    completed += stats.completed;
  }
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { completed, total, percent };
}

export function searchRoadmap(
  sections: RoadmapSection[],
  rawQuery: string,
  limit = 24,
): SearchHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const hits: SearchHit[] = [];

  for (const section of sections) {
    for (const sub of section.subSections) {
      if (getSubText(sub).includes(query)) {
        hits.push({
          sectionId: section.id,
          sectionIndexLabel: section.indexLabel,
          sectionTitle: section.navTitle,
          subSectionId: sub.id,
          subSectionCode: sub.code,
          subSectionTitle: sub.title,
          title: `${sub.code} · ${sub.title}`,
          snippet: sub.summary ?? section.subtitle,
        });
      }

      for (const item of sub.items ?? []) {
        if (getItemHaystack(item).includes(query)) {
          hits.push({
            sectionId: section.id,
            sectionIndexLabel: section.indexLabel,
            sectionTitle: section.navTitle,
            subSectionId: sub.id,
            subSectionCode: sub.code,
            subSectionTitle: sub.title,
            itemId: item.id,
            title: item.title,
            snippet:
              item.action ??
              item.problem ??
              item.details?.[0] ??
              item.fileRef ??
              sub.title,
            severity: item.severity,
          });
        }
        if (hits.length >= limit) return hits;
      }

      for (const table of sub.tables ?? []) {
        for (const row of table.rows) {
          if (getRowText(row).includes(query)) {
            hits.push({
              sectionId: section.id,
              sectionIndexLabel: section.indexLabel,
              sectionTitle: section.navTitle,
              subSectionId: sub.id,
              subSectionCode: sub.code,
              subSectionTitle: sub.title,
              title: row[0] ?? table.caption ?? sub.title,
              snippet: row.slice(1).join(' · '),
            });
            if (hits.length >= limit) return hits;
          }
        }
      }

      if (sub.callout) {
        for (const line of sub.callout.items) {
          if (line.toLowerCase().includes(query)) {
            hits.push({
              sectionId: section.id,
              sectionIndexLabel: section.indexLabel,
              sectionTitle: section.navTitle,
              subSectionId: sub.id,
              subSectionCode: sub.code,
              subSectionTitle: sub.title,
              title: sub.callout.title,
              snippet: line,
            });
          }
        }
      }
    }
  }

  hits.sort((a, b) => {
    const aTitle = a.title.toLowerCase().includes(query) ? 0 : 1;
    const bTitle = b.title.toLowerCase().includes(query) ? 0 : 1;
    return aTitle - bTitle;
  });

  return hits.slice(0, limit);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generates a 100% self-contained, pure dark-mode HTML file displaying
 * one section at a time with innovative PC + Mobile ergonomics.
 */
export function buildStandaloneRoadmapHtml(
  sections: RoadmapSection[] = ROADMAP_SECTIONS,
): string {
  const serializedSections = JSON.stringify(sections).replace(/</g, '\\u003c');
  const serializedMeta = JSON.stringify(ROADMAP_META).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#050507" />
  <title>${escapeHtml(ROADMAP_META.documentTitle)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Outfit:wght@500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #050507;
      --surface: #0b0b0f;
      --surface-elevated: #121218;
      --border: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.16);
      --text: #f3efe7;
      --text-muted: #9e9a92;
      --text-dim: #6e6b64;
      --amber: #e89b3c;
      --amber-soft: rgba(232, 155, 60, 0.12);
      --crit: #f87171;
      --high: #fb923c;
      --med: #fbbf24;
      --low: #94a3b8;
      --ok: #34d399;
      --font-display: "Outfit", system-ui, -apple-system, sans-serif;
      --font-sans: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }
    button {
      font: inherit;
      color: inherit;
      background: none;
      border: none;
      cursor: pointer;
    }
    button:focus-visible, input:focus-visible {
      outline: 2px solid var(--amber);
      outline-offset: 2px;
    }
    .app-shell {
      min-height: 100dvh;
      display: grid;
      grid-template-rows: 56px 1fr;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 30;
      height: 56px;
      background: rgba(5, 5, 7, 0.92);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      gap: 16px;
    }
    .brand {
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 16px;
      letter-spacing: -0.01em;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .topbar-center {
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
      min-width: 0;
    }
    .topbar-progress-track {
      width: 120px;
      height: 3px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      overflow: hidden;
    }
    .topbar-progress-fill {
      height: 100%;
      background: var(--amber);
      transition: width 180ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 40px;
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface);
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      transition: border-color 160ms ease, background 160ms ease, color 160ms ease;
    }
    .btn:hover {
      border-color: var(--border-strong);
      background: var(--surface-elevated);
    }
    .btn-primary {
      background: var(--amber);
      color: #090704;
      border-color: var(--amber);
      font-weight: 600;
    }
    .btn-primary:hover {
      background: #f2a94c;
      border-color: #f2a94c;
    }
    .workspace {
      display: grid;
      grid-template-columns: 280px 1fr;
      min-height: calc(100dvh - 56px);
    }
    .sidebar {
      position: sticky;
      top: 56px;
      height: calc(100dvh - 56px);
      overflow-y: auto;
      border-right: 1px solid var(--border);
      padding: 20px 14px;
      background: var(--bg);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .sidebar-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-dim);
      padding: 0 12px 10px;
      letter-spacing: 0.04em;
    }
    .nav-item {
      width: 100%;
      text-align: left;
      padding: 11px 12px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 13px;
      color: var(--text-muted);
      border: 1px solid transparent;
      transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
    }
    .nav-item:hover {
      background: var(--surface);
      color: var(--text);
    }
    .nav-item.active {
      background: var(--surface-elevated);
      color: var(--text);
      border-color: rgba(232, 155, 60, 0.35);
    }
    .nav-item-left {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
    }
    .nav-num {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .nav-item.active .nav-num { color: var(--amber); }
    .nav-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .nav-count {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .stage {
      min-width: 0;
      padding: 36px 40px 96px;
    }
    .stage-inner {
      max-width: 880px;
      margin: 0 auto;
    }
    .chapter-kicker {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--amber);
      margin-bottom: 10px;
      font-variant-numeric: tabular-nums;
    }
    .kicker-sep { color: var(--text-dim); }
    .kicker-muted { color: var(--text-muted); font-family: var(--font-sans); }
    h1 {
      font-family: var(--font-display);
      font-size: clamp(1.75rem, 3vw, 2.5rem);
      line-height: 1.14;
      letter-spacing: -0.02em;
      margin: 0 0 12px;
      text-wrap: balance;
    }
    .subtitle {
      font-size: 16px;
      color: var(--text-muted);
      margin: 0 0 18px;
      max-width: 68ch;
    }
    .rationale {
      font-size: 14px;
      color: #a7a299;
      margin: 0 0 22px;
      max-width: 68ch;
    }
    .subtabs-bar {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .subtabs {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      max-width: 100%;
    }
    .subtab {
      min-height: 40px;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      background: var(--surface);
      border: 1px solid var(--border);
      white-space: nowrap;
      flex-shrink: 0;
      transition: all 140ms ease;
    }
    .subtab:hover { color: var(--text); border-color: var(--border-strong); }
    .subtab.active {
      background: var(--amber-soft);
      color: var(--amber);
      border-color: rgba(232, 155, 60, 0.45);
    }
    .filter-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    .filter-btn {
      min-height: 36px;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      border: 1px solid var(--border);
      background: var(--surface);
      white-space: nowrap;
    }
    .filter-btn.active {
      color: var(--text);
      border-color: var(--amber);
      background: var(--amber-soft);
    }
    .sub-header {
      margin-bottom: 18px;
    }
    .sub-header h2 {
      font-family: var(--font-display);
      font-size: 20px;
      margin: 0 0 6px;
      font-weight: 600;
    }
    .sub-summary {
      font-size: 14px;
      color: var(--text-muted);
      margin: 0;
    }
    .item-list {
      display: flex;
      flex-direction: column;
      border-top: 1px solid var(--border);
    }
    .item-row {
      border-bottom: 1px solid var(--border);
      padding: 16px 4px;
      transition: background 140ms ease;
    }
    .item-row-head {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .check-btn {
      width: 24px;
      height: 24px;
      min-width: 24px;
      margin-top: 2px;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: var(--surface);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      color: transparent;
    }
    .check-btn.done {
      background: var(--ok);
      border-color: var(--ok);
      color: #04130c;
      font-weight: 700;
    }
    .item-main {
      flex: 1;
      min-width: 0;
    }
    .item-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    .sev-label {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
    }
    .sev-CRÍTICO { color: var(--crit); }
    .sev-ALTO { color: var(--high); }
    .sev-MÉDIO { color: var(--med); }
    .sev-BAIXO { color: var(--low); }
    .item-title-btn {
      width: 100%;
      text-align: left;
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
      line-height: 1.4;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .item-title-btn.done {
      color: var(--text-muted);
      text-decoration: line-through;
    }
    .item-body {
      margin-top: 10px;
      padding-left: 36px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 14px;
      color: #cfcbc2;
    }
    .item-field strong {
      color: var(--text);
      font-weight: 600;
    }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface);
      margin: 20px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th {
      color: var(--text-muted);
      font-weight: 600;
      font-size: 12px;
      background: rgba(255, 255, 255, 0.02);
    }
    tr:last-child td { border-bottom: none; }
    .callout {
      margin: 20px 0;
      padding: 18px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--surface);
    }
    .callout h3 {
      margin: 0 0 10px;
      font-family: var(--font-display);
      font-size: 15px;
      color: var(--amber);
    }
    .callout ul {
      margin: 0;
      padding-left: 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 14px;
      color: #d6d2c9;
    }
    .chapter-footer {
      margin-top: 36px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .mobile-bar {
      display: none;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 60;
      background: rgba(0, 0, 0, 0.78);
      display: none;
      align-items: flex-start;
      justify-content: center;
      padding: 64px 16px 24px;
    }
    .modal-backdrop.open { display: flex; }
    .modal-panel {
      width: 100%;
      max-width: 620px;
      max-height: 75dvh;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .modal-search-input {
      width: 100%;
      padding: 14px 16px;
      background: transparent;
      border: none;
      border-bottom: 1px solid var(--border);
      color: var(--text);
      font-size: 15px;
    }
    .modal-results {
      overflow-y: auto;
      padding: 8px;
    }
    .search-hit {
      width: 100%;
      text-align: left;
      padding: 10px 12px;
      border-radius: 8px;
      display: block;
    }
    .search-hit:hover { background: var(--surface-elevated); }
    .mobile-sheet-backdrop {
      position: fixed;
      inset: 0;
      z-index: 55;
      background: rgba(0, 0, 0, 0.72);
      display: none;
      align-items: flex-end;
    }
    .mobile-sheet-backdrop.open { display: flex; }
    .mobile-sheet {
      width: 100%;
      max-height: 75dvh;
      background: var(--surface);
      border-top: 1px solid var(--border-strong);
      border-radius: 18px 18px 0 0;
      padding: 14px 16px 28px;
      overflow-y: auto;
    }
    @media (max-width: 1023px) {
      .app-shell { grid-template-rows: 52px 1fr; }
      .topbar { height: 52px; padding: 0 14px; }
      .topbar-progress-track { display: none; }
      .workspace { grid-template-columns: 1fr; }
      .sidebar { display: none; }
      .stage { padding: 20px 16px 88px; }
      .chapter-footer { display: none; }
      .mobile-bar {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        height: 58px;
        z-index: 40;
        background: rgba(9, 9, 12, 0.96);
        backdrop-filter: blur(10px);
        border-top: 1px solid var(--border);
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        padding: 0 10px;
        gap: 8px;
      }
      .mobile-bar button {
        min-height: 44px;
        padding: 0 12px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">DuneFlow Roadmap</div>
      <div class="topbar-center">
        <span id="top-step-label">Seção 1 / 9</span>
        <div class="topbar-progress-track" aria-hidden="true">
          <div id="top-progress-fill" class="topbar-progress-fill" style="width: 11%"></div>
        </div>
        <span id="top-done-label">0 concluídos</span>
      </div>
      <div class="topbar-actions">
        <button type="button" id="open-search-btn" class="btn" aria-label="Buscar no roadmap">Buscar</button>
      </div>
    </header>

    <div class="workspace">
      <nav class="sidebar" aria-label="Capítulos do Roadmap">
        <div class="sidebar-label">Seções (1 por vez)</div>
        <div id="sidebar-list"></div>
      </nav>

      <main class="stage">
        <div id="stage-inner" class="stage-inner"></div>
      </main>
    </div>
  </div>

  <nav class="mobile-bar" aria-label="Navegação entre seções">
    <button type="button" id="mob-prev-btn">← Anterior</button>
    <button type="button" id="mob-index-btn" class="btn">Índice</button>
    <button type="button" id="mob-next-btn" style="color: var(--amber); justify-self: end;">Próxima →</button>
  </nav>

  <div id="search-modal" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Busca global no roadmap">
    <div class="modal-panel">
      <div style="display:flex;align-items:center;border-bottom:1px solid var(--border);">
        <input id="search-input" class="modal-search-input" type="search" placeholder="Buscar fase, arquivo, física, shader ou paper..." style="border-bottom:none;" />
        <button type="button" id="close-search-btn" class="btn" style="margin-right:8px;min-height:36px;">Fechar</button>
      </div>
      <div id="search-results" class="modal-results"></div>
    </div>
  </div>

  <div id="mobile-sheet" class="mobile-sheet-backdrop" role="dialog" aria-modal="true" aria-label="Índice de seções">
    <div class="mobile-sheet">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <strong style="font-family:var(--font-display);font-size:16px;">Escolher Seção</strong>
        <button type="button" id="close-sheet-btn" class="btn" style="min-height:36px;">Fechar</button>
      </div>
      <div id="mobile-sheet-list" style="display:flex;flex-direction:column;gap:4px;"></div>
    </div>
  </div>

  <script>
    const ROADMAP_META = ${serializedMeta};
    const SECTIONS = ${serializedSections};
    const STORAGE_KEY = 'duneflow_roadmap_done_v1';

    let activeSectionId = SECTIONS[0].id;
    let activeSubId = SECTIONS[0].subSections[0].id;
    let showAllSubs = false;
    let severityFilter = 'ALL';
    let expandedItems = new Set();
    const defaultDoneIds = [];
    SECTIONS.forEach(sec => sec.subSections.forEach(sub => (sub.items || []).forEach(it => {
      if (it.completed) defaultDoneIds.push(it.id);
    })));
    let storedDoneIds = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(parsed)) storedDoneIds = parsed;
    } catch {}
    let doneIds = new Set(defaultDoneIds.concat(storedDoneIds));

    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function saveDone() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(doneIds)));
    }

    function getTotalDone() {
      let total = 0, done = 0;
      SECTIONS.forEach(sec => sec.subSections.forEach(sub => (sub.items || []).forEach(it => {
        total++;
        if (doneIds.has(it.id)) done++;
      })));
      return { done, total };
    }

    function selectSection(id, subId) {
      const sec = SECTIONS.find(s => s.id === id) || SECTIONS[0];
      activeSectionId = sec.id;
      activeSubId = subId || sec.subSections[0].id;
      severityFilter = 'ALL';
      showAllSubs = false;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function renderSidebar() {
      const list = document.getElementById('sidebar-list');
      const mobList = document.getElementById('mobile-sheet-list');
      const html = SECTIONS.map(sec => {
        const isActive = sec.id === activeSectionId;
        let secTotal = 0, secDone = 0;
        sec.subSections.forEach(sub => (sub.items || []).forEach(it => {
          secTotal++;
          if (doneIds.has(it.id)) secDone++;
        }));
        return '<button type="button" class="nav-item ' + (isActive ? 'active' : '') + '" data-sec="' + esc(sec.id) + '">' +
          '<span class="nav-item-left"><span class="nav-num">' + esc(sec.indexLabel) + '</span><span class="nav-title">' + esc(sec.navTitle) + '</span></span>' +
          (secTotal > 0 ? '<span class="nav-count">' + secDone + '/' + secTotal + '</span>' : '') +
        '</button>';
      }).join('');
      list.innerHTML = html;
      mobList.innerHTML = html;

      document.querySelectorAll('[data-sec]').forEach(btn => {
        btn.addEventListener('click', () => {
          selectSection(btn.getAttribute('data-sec'));
          document.getElementById('mobile-sheet').classList.remove('open');
        });
      });
    }

    function renderItems(items) {
      const filtered = (items || []).filter(it => severityFilter === 'ALL' || it.severity === severityFilter);
      if (!filtered.length) {
        return '<p style="color:var(--text-muted);font-size:14px;padding:16px 0;">Nenhum item neste filtro.</p>';
      }
      return '<div class="item-list">' + filtered.map(it => {
        const isDone = doneIds.has(it.id);
        const hasBody = Boolean(it.problem || it.action || (it.details && it.details.length));
        const isOpen = expandedItems.has(it.id);
        const sevHtml = it.severity ? '<span class="sev-label sev-' + esc(it.severity) + '">● ' + esc(it.severity) + '</span>' : '';
        const metaParts = [sevHtml, it.tag ? '<span>' + esc(it.tag) + '</span>' : '', it.fileRef ? '<span style="font-family:var(--font-mono)">' + esc(it.fileRef) + '</span>' : ''].filter(Boolean);
        return '<div class="item-row">' +
          '<div class="item-row-head">' +
            '<button type="button" class="check-btn ' + (isDone ? 'done' : '') + '" data-check="' + esc(it.id) + '" aria-label="Marcar item como concluído">✓</button>' +
            '<div class="item-main">' +
              (metaParts.length ? '<div class="item-meta">' + metaParts.join('<span aria-hidden="true">·</span>') + '</div>' : '') +
              '<button type="button" class="item-title-btn ' + (isDone ? 'done' : '') + '" data-expand="' + esc(it.id) + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '">' +
                '<span>' + esc(it.title) + '</span>' +
                (hasBody ? '<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-dim);flex-shrink:0;">' + (isOpen ? '−' : '+') + '</span>' : '') +
              '</button>' +
            '</div>' +
          '</div>' +
          (hasBody && isOpen ? (
            '<div class="item-body">' +
              (it.problem ? '<div class="item-field"><strong>Problema:</strong> ' + esc(it.problem) + '</div>' : '') +
              (it.action ? '<div class="item-field"><strong>Ação:</strong> ' + esc(it.action) + '</div>' : '') +
              ((it.details || []).map(d => '<div class="item-field">' + esc(d) + '</div>').join('')) +
            '</div>'
          ) : '') +
        '</div>';
      }).join('') + '</div>';
    }

    function renderSubSection(sub) {
      const hasSeverities = (sub.items || []).some(it => Boolean(it.severity));
      let sevBar = '';
      if (hasSeverities) {
        const levels = ['ALL', 'CRÍTICO', 'ALTO', 'MÉDIO', 'BAIXO'];
        sevBar = '<div class="filter-row">' + levels.map(lv => {
          const label = lv === 'ALL' ? 'Todos' : lv;
          return '<button type="button" class="filter-btn ' + (severityFilter === lv ? 'active' : '') + '" data-sev="' + lv + '">' + label + '</button>';
        }).join('') + '</div>';
      }

      const tablesHtml = (sub.tables || []).map(tbl => {
        return '<div class="table-wrap"><table><thead><tr>' +
          tbl.headers.map(h => '<th>' + esc(h) + '</th>').join('') +
          '</tr></thead><tbody>' +
          tbl.rows.map(r => '<tr>' + r.map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table></div>';
      }).join('');

      const calloutHtml = sub.callout ? (
        '<div class="callout"><h3>' + esc(sub.callout.title) + '</h3><ul>' +
        sub.callout.items.map(line => '<li>' + esc(line) + '</li>').join('') +
        '</ul></div>'
      ) : '';

      return '<section aria-label="' + esc(sub.title) + '">' +
        '<div class="sub-header"><h2>' + esc(sub.code) + ' · ' + esc(sub.title) + '</h2>' +
        (sub.summary ? '<p class="sub-summary">' + esc(sub.summary) + '</p>' : '') +
        '</div>' +
        sevBar +
        (sub.items ? renderItems(sub.items) : '') +
        tablesHtml +
        calloutHtml +
      '</section>';
    }

    function render() {
      const idx = SECTIONS.findIndex(s => s.id === activeSectionId);
      const sec = SECTIONS[idx] || SECTIONS[0];
      const prev = idx > 0 ? SECTIONS[idx - 1] : null;
      const next = idx < SECTIONS.length - 1 ? SECTIONS[idx + 1] : null;

      const stats = getTotalDone();
      document.getElementById('top-step-label').textContent = 'Seção ' + (idx + 1) + ' / ' + SECTIONS.length;
      document.getElementById('top-progress-fill').style.width = Math.round(((idx + 1) / SECTIONS.length) * 100) + '%';
      document.getElementById('top-done-label').textContent = stats.done + '/' + stats.total + ' concluídos';

      const mobPrev = document.getElementById('mob-prev-btn');
      const mobNext = document.getElementById('mob-next-btn');
      const mobIdx = document.getElementById('mob-index-btn');
      mobPrev.disabled = !prev;
      mobPrev.style.opacity = prev ? '1' : '0.35';
      mobNext.disabled = !next;
      mobNext.style.opacity = next ? '1' : '0.35';
      mobIdx.textContent = 'Seções (' + (idx + 1) + '/' + SECTIONS.length + ')';

      const activeSubs = showAllSubs ? sec.subSections : [sec.subSections.find(s => s.id === activeSubId) || sec.subSections[0]];

      const stage = document.getElementById('stage-inner');
      stage.innerHTML =
        '<div class="chapter-kicker"><span>Seção ' + esc(sec.indexLabel) + ' de 0' + (SECTIONS.length - 1) + '</span>' +
        (sec.phaseBadge ? '<span class="kicker-sep">·</span><span class="kicker-muted">' + esc(sec.phaseBadge) + '</span>' : '') +
        '</div>' +
        '<h1>' + esc(sec.title) + '</h1>' +
        '<p class="subtitle">' + esc(sec.subtitle) + '</p>' +
        '<div class="rationale">' + esc(sec.rationale) + '</div>' +
        '<div class="subtabs-bar">' +
          '<div class="subtabs">' +
            sec.subSections.map(s => '<button type="button" class="subtab ' + (!showAllSubs && s.id === activeSubId ? 'active' : '') + '" data-sub="' + esc(s.id) + '">' + esc(s.code) + ' · ' + esc(s.title) + '</button>').join('') +
          '</div>' +
          '<button type="button" class="btn" id="toggle-all-subs" style="min-height:36px;font-size:12px;">' + (showAllSubs ? 'Ver 1 subseção' : 'Ver tudo na seção') + '</button>' +
        '</div>' +
        activeSubs.map(renderSubSection).join('<hr style="border:none;border-top:1px solid var(--border);margin:28px 0;" />') +
        '<div class="chapter-footer">' +
          (prev ? '<button type="button" class="btn" id="desk-prev-btn">← ' + esc(prev.navTitle) + '</button>' : '<span></span>') +
          (next ? '<button type="button" class="btn btn-primary" id="desk-next-btn">' + esc(next.navTitle) + ' →</button>' : '<span></span>') +
        '</div>';

      renderSidebar();

      document.querySelectorAll('[data-sub]').forEach(btn => {
        btn.addEventListener('click', () => {
          showAllSubs = false;
          activeSubId = btn.getAttribute('data-sub');
          severityFilter = 'ALL';
          render();
        });
      });

      document.getElementById('toggle-all-subs').addEventListener('click', () => {
        showAllSubs = !showAllSubs;
        render();
      });

      document.querySelectorAll('[data-sev]').forEach(btn => {
        btn.addEventListener('click', () => {
          severityFilter = btn.getAttribute('data-sev');
          render();
        });
      });

      document.querySelectorAll('[data-check]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-check');
          if (doneIds.has(id)) doneIds.delete(id); else doneIds.add(id);
          saveDone();
          render();
        });
      });

      document.querySelectorAll('[data-expand]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-expand');
          if (expandedItems.has(id)) expandedItems.delete(id); else expandedItems.add(id);
          render();
        });
      });

      const deskPrev = document.getElementById('desk-prev-btn');
      const deskNext = document.getElementById('desk-next-btn');
      if (deskPrev && prev) deskPrev.addEventListener('click', () => selectSection(prev.id));
      if (deskNext && next) deskNext.addEventListener('click', () => selectSection(next.id));
    }

    document.getElementById('mob-prev-btn').addEventListener('click', () => {
      const idx = SECTIONS.findIndex(s => s.id === activeSectionId);
      if (idx > 0) selectSection(SECTIONS[idx - 1].id);
    });
    document.getElementById('mob-next-btn').addEventListener('click', () => {
      const idx = SECTIONS.findIndex(s => s.id === activeSectionId);
      if (idx < SECTIONS.length - 1) selectSection(SECTIONS[idx + 1].id);
    });
    document.getElementById('mob-index-btn').addEventListener('click', () => {
      document.getElementById('mobile-sheet').classList.add('open');
    });
    document.getElementById('close-sheet-btn').addEventListener('click', () => {
      document.getElementById('mobile-sheet').classList.remove('open');
    });

    const searchModal = document.getElementById('search-modal');
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');

    function openSearch() {
      searchModal.classList.add('open');
      searchInput.value = '';
      searchResults.innerHTML = '<p style="padding:14px;color:var(--text-muted);font-size:13px;">Digite um termo (ex.: Jolt, MLS-MPM, toroidal, 4L, Waveguide)...</p>';
      setTimeout(() => searchInput.focus(), 20);
    }

    document.getElementById('open-search-btn').addEventListener('click', openSearch);
    document.getElementById('close-search-btn').addEventListener('click', () => searchModal.classList.remove('open'));
    searchModal.addEventListener('click', (e) => { if (e.target === searchModal) searchModal.classList.remove('open'); });

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) {
        searchResults.innerHTML = '<p style="padding:14px;color:var(--text-muted);font-size:13px;">Digite para buscar em todas as 9 seções.</p>';
        return;
      }
      const hits = [];
      SECTIONS.forEach(sec => sec.subSections.forEach(sub => {
        (sub.items || []).forEach(it => {
          const hay = (it.title + ' ' + (it.fileRef || '') + ' ' + (it.problem || '') + ' ' + (it.action || '') + ' ' + (it.details || []).join(' ')).toLowerCase();
          if (hay.includes(q)) hits.push({ sec, sub, title: it.title, id: it.id });
        });
      }));
      if (!hits.length) {
        searchResults.innerHTML = '<p style="padding:14px;color:var(--text-muted);font-size:13px;">Nenhum resultado encontrado.</p>';
        return;
      }
      searchResults.innerHTML = hits.slice(0, 20).map(h =>
        '<button type="button" class="search-hit" data-jump-sec="' + esc(h.sec.id) + '" data-jump-sub="' + esc(h.sub.id) + '" data-jump-item="' + esc(h.id) + '">' +
          '<div style="font-size:11px;font-family:var(--font-mono);color:var(--amber);">' + esc(h.sec.indexLabel) + ' · ' + esc(h.sub.code) + ' ' + esc(h.sub.title) + '</div>' +
          '<div style="font-size:14px;font-weight:500;">' + esc(h.title) + '</div>' +
        '</button>'
      ).join('');
      searchResults.querySelectorAll('[data-jump-sec]').forEach(btn => {
        btn.addEventListener('click', () => {
          expandedItems.add(btn.getAttribute('data-jump-item'));
          selectSection(btn.getAttribute('data-jump-sec'), btn.getAttribute('data-jump-sub'));
          searchModal.classList.remove('open');
        });
      });
    });

    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openSearch();
      } else if (e.key === 'Escape') {
        searchModal.classList.remove('open');
        document.getElementById('mobile-sheet').classList.remove('open');
      } else if (!searchModal.classList.contains('open')) {
        const idx = SECTIONS.findIndex(s => s.id === activeSectionId);
        if (e.key === 'ArrowRight' && idx < SECTIONS.length - 1) selectSection(SECTIONS[idx + 1].id);
        if (e.key === 'ArrowLeft' && idx > 0) selectSection(SECTIONS[idx - 1].id);
      }
    });

    render();
  </script>
</body>
</html>`;
}
