import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Layers,
  List,
  Search,
  X,
} from 'lucide-react';
import {
  ROADMAP_META,
  ROADMAP_SECTIONS,
  RoadmapChecklistItem,
  RoadmapSubSection,
} from '../roadmap/roadmapData';
import {
  SeverityFilter,
  buildStandaloneRoadmapHtml,
  computeOverallProgress,
  computeSectionProgress,
  countBySeverity,
  filterChecklistItems,
  getAdjacentSections,
  getDefaultCompletedIds,
  getSectionById,
  getSectionIndex,
  searchRoadmap,
} from '../roadmap/roadmapLogic';

const STORAGE_KEY = 'duneflow_roadmap_done_v1';

const SEVERITY_OPTIONS: Array<{ id: SeverityFilter; label: string }> = [
  { id: 'ALL', label: 'Todos' },
  { id: 'CRÍTICO', label: 'Crítico' },
  { id: 'ALTO', label: 'Alto' },
  { id: 'MÉDIO', label: 'Médio' },
  { id: 'BAIXO', label: 'Baixo' },
];

function getSeverityTextClass(sev?: RoadmapChecklistItem['severity']): string {
  switch (sev) {
    case 'CRÍTICO':
      return 'text-red-400';
    case 'ALTO':
      return 'text-orange-400';
    case 'MÉDIO':
      return 'text-amber-300';
    case 'BAIXO':
      return 'text-slate-400';
    default:
      return 'text-zinc-400';
  }
}

interface RoadmapViewerProps {
  onOpenSimulator: () => void;
}

export const RoadmapViewer: React.FC<RoadmapViewerProps> = ({ onOpenSimulator }) => {
  const [activeSectionId, setActiveSectionId] = useState<string>(ROADMAP_SECTIONS[0].id);
  const [activeSubId, setActiveSubId] = useState<string>(
    ROADMAP_SECTIONS[0].subSections[0].id,
  );
  const [showAllSubSections, setShowAllSubSections] = useState<boolean>(false);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('ALL');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set());
  const [completedIds, setCompletedIds] = useState<Set<string>>(() => {
    const defaults = getDefaultCompletedIds(ROADMAP_SECTIONS);
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return defaults;
      for (const id of parsed) {
        if (typeof id === 'string') defaults.add(id);
      }
      return defaults;
    } catch {
      return defaults;
    }
  });

  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [mobileSheetOpen, setMobileSheetOpen] = useState<boolean>(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const stageTopRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(completedIds)));
    } catch {
      // Ignore storage quota errors
    }
  }, [completedIds]);

  const activeSection = useMemo(
    () => getSectionById(ROADMAP_SECTIONS, activeSectionId),
    [activeSectionId],
  );

  const activeSectionIdx = useMemo(
    () => getSectionIndex(ROADMAP_SECTIONS, activeSectionId),
    [activeSectionId],
  );

  const { prev: prevSection, next: nextSection } = useMemo(
    () => getAdjacentSections(ROADMAP_SECTIONS, activeSectionId),
    [activeSectionId],
  );

  const overallProgress = useMemo(
    () => computeOverallProgress(ROADMAP_SECTIONS, completedIds),
    [completedIds],
  );

  const severityCounts = useMemo(
    () => countBySeverity(ROADMAP_SECTIONS, activeSectionId),
    [activeSectionId],
  );

  const searchResults = useMemo(
    () => searchRoadmap(ROADMAP_SECTIONS, searchQuery, 24),
    [searchQuery],
  );

  const selectSection = useCallback((sectionId: string, subId?: string) => {
    const target = getSectionById(ROADMAP_SECTIONS, sectionId);
    setActiveSectionId(target.id);
    setActiveSubId(subId ?? target.subSections[0].id);
    setShowAllSubSections(false);
    setSeverityFilter('ALL');
    setMobileSheetOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const toggleCompleted = useCallback((itemId: string) => {
    setCompletedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const toggleExpanded = useCallback((itemId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const expandAllInSub = useCallback((sub: RoadmapSubSection, expand: boolean) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      for (const item of sub.items ?? []) {
        if (expand) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  }, []);

  const handleDownloadStandaloneHtml = useCallback(() => {
    const html = buildStandaloneRoadmapHtml(ROADMAP_SECTIONS);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'duneflow-roadmap.html';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, []);

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 20);
    }
  }, [searchOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((open) => !open);
        return;
      }
      if (e.key === 'Escape') {
        setSearchOpen(false);
        setMobileSheetOpen(false);
        return;
      }
      if (
        searchOpen ||
        mobileSheetOpen ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === 'ArrowRight' && nextSection) {
        selectSection(nextSection.id);
      } else if (e.key === 'ArrowLeft' && prevSection) {
        selectSection(prevSection.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileSheetOpen, nextSection, prevSection, searchOpen, selectSection]);

  const visibleSubSections = useMemo(() => {
    if (showAllSubSections) return activeSection.subSections;
    const match =
      activeSection.subSections.find((s) => s.id === activeSubId) ??
      activeSection.subSections[0];
    return [match];
  }, [activeSection, activeSubId, showAllSubSections]);

  const stageProgressPct = Math.round(
    ((activeSectionIdx + 1) / ROADMAP_SECTIONS.length) * 100,
  );

  return (
    <div
      className="min-h-[100dvh] bg-[#050507] text-[#f3efe7] flex flex-col"
      data-testid="roadmap-root"
      data-active-section={activeSection.id}
    >
      {/* Top Bar — 52px mobile / 56px desktop, strict 3-zone contract */}
      <header className="sticky top-0 z-30 h-[52px] lg:h-[56px] border-b border-white/[0.08] bg-[#050507]/95 backdrop-blur-md px-4 lg:px-6 flex items-center justify-between gap-3 lg:gap-8">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-display text-[15px] sm:text-base lg:text-lg font-semibold tracking-tight text-[#f3efe7] whitespace-nowrap shrink-0">
            {ROADMAP_META.brand} Roadmap
          </span>
        </div>

        <div className="hidden md:flex items-center gap-3 text-xs font-mono text-[#9e9a92] tabular-nums">
          <span className="whitespace-nowrap">
            Seção {activeSectionIdx + 1} / {ROADMAP_SECTIONS.length}
          </span>
          <div
            className="w-24 h-1 rounded-full bg-white/[0.08] overflow-hidden"
            aria-hidden="true"
          >
            <div
              className="h-full bg-[#e89b3c] transition-all duration-200"
              style={{ width: `${stageProgressPct}%` }}
            />
          </div>
          <span className="whitespace-nowrap">
            {overallProgress.completed}/{overallProgress.total} concluídos
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Buscar no roadmap"
            className="min-h-[40px] min-w-[40px] px-2.5 sm:px-3 rounded-lg border border-white/[0.1] bg-[#0b0b0f] hover:bg-[#13131a] text-xs font-medium text-[#e5e0d5] inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-[#e89b3c]"
          >
            <Search className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[#9e9a92]" />
            <span className="hidden sm:inline">Buscar</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadStandaloneHtml}
            aria-label="Baixar HTML standalone"
            className="hidden sm:inline-flex min-h-[40px] px-3 rounded-lg border border-white/[0.1] bg-[#0b0b0f] hover:bg-[#13131a] text-xs font-medium text-[#e5e0d5] items-center gap-2 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-[#e89b3c]"
          >
            <Download className="w-3.5 h-3.5 text-[#9e9a92]" />
            <span>HTML</span>
          </button>

          <button
            type="button"
            onClick={onOpenSimulator}
            aria-label="Abrir Simulador 3D"
            className="min-h-[40px] px-3 sm:px-3.5 rounded-lg bg-[#e89b3c] hover:bg-[#f0a74b] text-[#090704] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-white"
          >
            <Box className="w-3.5 h-3.5" />
            <span className="sm:hidden">3D</span>
            <span className="hidden sm:inline">Simulador 3D</span>
          </button>
        </div>
      </header>

      {/* Main Desktop + Mobile Workspace */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[276px_1fr]">
        {/* Desktop Left Chapter Rail */}
        <aside
          aria-label="Índice de seções do roadmap"
          className="hidden lg:flex flex-col sticky top-[56px] h-[calc(100dvh-56px)] border-r border-white/[0.08] bg-[#050507] px-3.5 py-5 overflow-y-auto"
        >
          <div className="px-2.5 pb-3 flex items-center justify-between text-[11px] font-medium text-[#7c7870]">
            <span>Seções (1 por vez)</span>
            <span className="font-mono tabular-nums">{overallProgress.percent}%</span>
          </div>

          <nav className="flex flex-col gap-1" aria-label="Navegação por capítulos">
            {ROADMAP_SECTIONS.map((sec) => {
              const isActive = sec.id === activeSection.id;
              const stats = computeSectionProgress(sec, completedIds);
              return (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() => selectSection(sec.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors flex items-center justify-between gap-2.5 min-h-[42px] focus-visible:outline-2 focus-visible:outline-[#e89b3c] ${
                    isActive
                      ? 'bg-[#121218] border-[#e89b3c]/40 text-[#f3efe7]'
                      : 'border-transparent text-[#9e9a92] hover:bg-[#0b0b0f] hover:text-[#f3efe7]'
                  }`}
                >
                  <span className="flex items-baseline gap-2.5 min-w-0">
                    <span
                      className={`font-mono text-[11px] tabular-nums shrink-0 ${
                        isActive ? 'text-[#e89b3c]' : 'text-[#6c6860]'
                      }`}
                    >
                      {sec.indexLabel}
                    </span>
                    <span className="text-[13px] font-medium truncate">
                      {sec.navTitle}
                    </span>
                  </span>
                  {stats.total > 0 && (
                    <span className="font-mono text-[11px] text-[#7c7870] tabular-nums shrink-0">
                      {stats.completed}/{stats.total}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="mt-auto pt-5 border-t border-white/[0.07] px-2 flex flex-col gap-2">
            <a
              href="/roadmap.html"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-[#9e9a92] hover:text-[#f3efe7] inline-flex items-center gap-2 py-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Abrir arquivo /roadmap.html</span>
            </a>
            <p className="text-[11px] text-[#6c6860] leading-relaxed">
              Use as setas ← e → no teclado para alternar entre as seções.
            </p>
          </div>
        </aside>

        {/* Focused Single-Section Stage */}
        <main
          ref={stageTopRef}
          className="min-w-0 px-4 sm:px-8 lg:px-12 pt-6 pb-24 lg:py-10"
        >
          <div className="max-w-4xl mx-auto">
            {/* Section Kicker */}
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-[#e89b3c] mb-2.5 tabular-nums">
              <span>
                Seção {activeSection.indexLabel} de 0{ROADMAP_SECTIONS.length - 1}
              </span>
              {activeSection.phaseBadge && (
                <>
                  <span aria-hidden="true" className="text-[#6c6860]">
                    ·
                  </span>
                  <span className="font-sans text-[#9e9a92]">
                    {activeSection.phaseBadge}
                  </span>
                </>
              )}
            </div>

            <h1 className="font-display text-[clamp(1.55rem,3vw,2.35rem)] font-semibold tracking-tight leading-[1.14] text-[#f6f2ea] text-balance mb-2.5">
              {activeSection.title}
            </h1>

            <p className="text-[15px] sm:text-base text-[#b8b3aa] leading-relaxed max-w-3xl mb-2">
              {activeSection.subtitle}
            </p>

            <p className="text-[13px] sm:text-sm text-[#8a857d] leading-relaxed max-w-3xl mb-5">
              {activeSection.rationale}
            </p>

            {activeSection.id === 'fundamentos' && (
              <details className="mb-5 rounded-xl border border-white/[0.08] bg-[#0b0b0f] px-4 py-3 text-xs sm:text-sm text-[#a7a299]">
                <summary className="cursor-pointer font-medium text-[#e5e0d5] select-none list-none flex items-center justify-between gap-2">
                  <span>Base atual já operacional na engine</span>
                  <ChevronDown className="w-4 h-4 text-[#9e9a92]" />
                </summary>
                <p className="mt-2.5 leading-relaxed text-[#9e9a92]">
                  {ROADMAP_META.operationalBase.replace(
                    'Base atual já operacional na engine: ',
                    '',
                  )}
                </p>
              </details>
            )}

            {/* Sub-section Tabs + View-All Toggle */}
            <div className="flex flex-col gap-3 pb-4 border-b border-white/[0.08] mb-6">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-mono text-[#7c7870] uppercase tracking-wider">
                  Subseções ({activeSection.subSections.length})
                </span>
                {activeSection.subSections.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setShowAllSubSections((prev) => !prev)}
                    className="min-h-[36px] px-3 rounded-lg border border-white/[0.08] bg-[#0b0b0f] hover:bg-[#121218] text-xs font-medium text-[#b8b3aa] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <Layers className="w-3.5 h-3.5 text-[#9e9a92]" />
                    <span>
                      {showAllSubSections ? 'Focar 1 subseção' : 'Ver toda a seção'}
                    </span>
                  </button>
                )}
              </div>

              <div
                className="flex items-center gap-1.5 overflow-x-auto sm:flex-wrap sm:overflow-visible no-scrollbar pb-1 sm:pb-0"
                role="tablist"
                aria-label="Subseções da seção atual"
              >
                {activeSection.subSections.map((sub) => {
                  const isSubActive = !showAllSubSections && sub.id === activeSubId;
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      role="tab"
                      aria-selected={isSubActive}
                      onClick={() => {
                        setShowAllSubSections(false);
                        setActiveSubId(sub.id);
                        setSeverityFilter('ALL');
                      }}
                      className={`min-h-[40px] px-3 py-2 rounded-lg border text-xs sm:text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-[#e89b3c] ${
                        isSubActive
                          ? 'bg-[#e89b3c]/12 border-[#e89b3c]/50 text-[#e89b3c]'
                          : 'bg-[#0b0b0f] border-white/[0.08] text-[#9e9a92] hover:text-[#f3efe7] hover:border-white/[0.16]'
                      }`}
                    >
                      <span className="font-mono mr-1.5">{sub.code}</span>
                      <span>{sub.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Active Sub-section Content */}
            <div className="flex flex-col gap-10">
              {visibleSubSections.map((sub) => {
                const hasSeverities = (sub.items ?? []).some((i) =>
                  Boolean(i.severity),
                );
                const filteredItems = filterChecklistItems(
                  sub.items ?? [],
                  severityFilter,
                );
                const hasExpandableItems = filteredItems.some(
                  (i) =>
                    Boolean(i.problem) ||
                    Boolean(i.action) ||
                    Boolean(i.details?.length),
                );
                const allExpanded =
                  hasExpandableItems &&
                  filteredItems.every((i) => expandedItems.has(i.id));

                return (
                  <section key={sub.id} aria-label={sub.title}>
                    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-4">
                      <div>
                        <h2 className="font-display text-lg sm:text-xl font-semibold text-[#f3efe7]">
                          <span className="font-mono text-[#e89b3c] mr-2">
                            {sub.code}
                          </span>
                          {sub.title}
                        </h2>
                        {sub.summary && (
                          <p className="mt-1.5 text-sm text-[#9e9a92] leading-relaxed max-w-3xl">
                            {sub.summary}
                          </p>
                        )}
                      </div>

                      {hasExpandableItems && (
                        <button
                          type="button"
                          onClick={() => expandAllInSub(sub, !allExpanded)}
                          className="min-h-[36px] px-3 rounded-lg border border-white/[0.08] bg-[#0b0b0f] hover:bg-[#13131a] text-xs text-[#b8b3aa] whitespace-nowrap shrink-0 self-start sm:self-auto"
                        >
                          {allExpanded ? 'Recolher detalhes' : 'Expandir detalhes'}
                        </button>
                      )}
                    </div>

                    {/* Severity Filter Bar for Audit Items */}
                    {hasSeverities && (
                      <div
                        className="flex flex-wrap items-center gap-1.5 mb-4"
                        role="group"
                        aria-label="Filtrar por severidade"
                      >
                        {SEVERITY_OPTIONS.map((opt) => {
                          const isSelected = severityFilter === opt.id;
                          const count = showAllSubSections
                            ? severityCounts[opt.id]
                            : (sub.items ?? []).filter(
                                (it) => opt.id === 'ALL' || it.severity === opt.id,
                              ).length;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => setSeverityFilter(opt.id)}
                              className={`min-h-[36px] px-3 rounded-md border text-xs font-medium whitespace-nowrap transition-colors ${
                                isSelected
                                  ? 'border-[#e89b3c] bg-[#e89b3c]/12 text-[#f3efe7]'
                                  : 'border-white/[0.08] bg-[#0b0b0f] text-[#9e9a92] hover:text-[#f3efe7]'
                              }`}
                            >
                              <span>{opt.label}</span>
                              <span className="ml-1.5 font-mono text-[11px] text-[#7c7870] tabular-nums">
                                {count}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Clean Hairline Item Rows (No Nested Cards) */}
                    {sub.items && (
                      <div className="border-t border-white/[0.08]">
                        {filteredItems.length === 0 ? (
                          <p className="py-6 text-sm text-[#8a857d]">
                            Nenhum item encontrado para o filtro selecionado.
                          </p>
                        ) : (
                          filteredItems.map((item) => {
                            const isDone = completedIds.has(item.id);
                            const hasDetails = Boolean(
                              item.problem ||
                                item.action ||
                                (item.details && item.details.length > 0),
                            );
                            const isExpanded = expandedItems.has(item.id);

                            return (
                              <div
                                key={item.id}
                                className="border-b border-white/[0.08] py-4"
                              >
                                <div className="flex items-start gap-2">
                                  <button
                                    type="button"
                                    onClick={() => toggleCompleted(item.id)}
                                    aria-label={`Marcar "${item.title}" como concluído`}
                                    aria-pressed={isDone}
                                    className="-ml-2 -mt-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-[#e89b3c]"
                                  >
                                    <span
                                      className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${
                                        isDone
                                          ? 'bg-emerald-400 border-emerald-400 text-[#04120b]'
                                          : 'bg-[#0b0b0f] border-white/[0.2] text-transparent hover:border-[#e89b3c]'
                                      }`}
                                    >
                                      <Check className="w-3.5 h-3.5 stroke-[2.75]" />
                                    </span>
                                  </button>

                                  <div className="flex-1 min-w-0">
                                    {(item.severity || item.tag || item.fileRef) && (
                                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#8e8980] mb-1">
                                        {item.severity && (
                                          <span
                                            className={`font-mono text-[11px] font-semibold ${getSeverityTextClass(
                                              item.severity,
                                            )}`}
                                          >
                                            ● {item.severity}
                                          </span>
                                        )}
                                        {item.severity && (item.tag || item.fileRef) && (
                                          <span aria-hidden="true">·</span>
                                        )}
                                        {item.tag && <span>{item.tag}</span>}
                                        {item.tag && item.fileRef && (
                                          <span aria-hidden="true">·</span>
                                        )}
                                        {item.fileRef && (
                                          <span className="font-mono text-[11px] text-[#9e9a92] break-all">
                                            {item.fileRef}
                                          </span>
                                        )}
                                      </div>
                                    )}

                                    {hasDetails ? (
                                      <button
                                        type="button"
                                        onClick={() => toggleExpanded(item.id)}
                                        aria-expanded={isExpanded}
                                        className="w-full text-left flex items-start justify-between gap-3 group min-h-[28px]"
                                      >
                                        <span
                                          className={`text-[15px] font-medium leading-snug transition-colors ${
                                            isDone
                                              ? 'line-through text-[#7c7870]'
                                              : 'text-[#f3efe7] group-hover:text-[#e89b3c]'
                                          }`}
                                        >
                                          {item.title}
                                        </span>
                                        <span className="text-[#7c7870] group-hover:text-[#e89b3c] shrink-0 mt-0.5">
                                          {isExpanded ? (
                                            <ChevronUp className="w-4 h-4" />
                                          ) : (
                                            <ChevronDown className="w-4 h-4" />
                                          )}
                                        </span>
                                      </button>
                                    ) : (
                                      <div
                                        className={`text-[15px] font-medium leading-snug ${
                                          isDone
                                            ? 'line-through text-[#7c7870]'
                                            : 'text-[#f3efe7]'
                                        }`}
                                      >
                                        {item.title}
                                      </div>
                                    )}

                                    {hasDetails && isExpanded && (
                                      <div className="mt-3 space-y-2 text-sm text-[#cfcbc2] leading-relaxed">
                                        {item.problem && (
                                          <p>
                                            <strong className="text-[#f3efe7] font-semibold">
                                              Problema:{' '}
                                            </strong>
                                            {item.problem}
                                          </p>
                                        )}
                                        {item.action && (
                                          <p>
                                            <strong className="text-[#e89b3c] font-semibold">
                                              Ação:{' '}
                                            </strong>
                                            {item.action}
                                          </p>
                                        )}
                                        {item.details?.map((line, i) => (
                                          <p key={i}>{line}</p>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}

                    {/* Tables */}
                    {sub.tables?.map((tbl, idx) => (
                      <div
                        key={idx}
                        className="mt-5 rounded-xl border border-white/[0.08] bg-[#0b0b0f] overflow-x-auto"
                      >
                        {tbl.caption && (
                          <div className="px-4 py-2.5 border-b border-white/[0.08] text-xs font-medium text-[#9e9a92]">
                            {tbl.caption}
                          </div>
                        )}
                        <table className="w-full text-left border-collapse text-xs sm:text-[13px]">
                          <thead>
                            <tr className="border-b border-white/[0.08] bg-white/[0.02]">
                              {tbl.headers.map((head) => (
                                <th
                                  key={head}
                                  className="px-4 py-3 font-semibold text-[#b8b3aa] whitespace-nowrap"
                                >
                                  {head}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {tbl.rows.map((row, rIdx) => (
                              <tr
                                key={rIdx}
                                className="border-b border-white/[0.06] last:border-b-0"
                              >
                                {row.map((cell, cIdx) => (
                                  <td
                                    key={cIdx}
                                    className={`px-4 py-3 align-top leading-relaxed ${
                                      cIdx === 0
                                        ? 'font-medium text-[#f3efe7] min-w-[160px]'
                                        : 'text-[#c9c4bb]'
                                    }`}
                                  >
                                    {cell}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}

                    {/* Callout Block (No thick left accent stripe!) */}
                    {sub.callout && (
                      <div className="mt-5 rounded-xl border border-white/[0.1] bg-[#0b0b0f] p-5">
                        <h3 className="font-display text-sm sm:text-base font-semibold text-[#e89b3c] mb-3">
                          {sub.callout.title}
                        </h3>
                        <ul className="space-y-2.5 text-sm text-[#d4cfc6] leading-relaxed list-disc pl-5">
                          {sub.callout.items.map((line, i) => (
                            <li key={i}>{line}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                );
              })}
            </div>

            {/* Desktop Chapter Stepper Footer */}
            <div className="hidden lg:flex items-center justify-between gap-4 mt-12 pt-6 border-t border-white/[0.08]">
              {prevSection ? (
                <button
                  type="button"
                  onClick={() => selectSection(prevSection.id)}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-white/[0.1] bg-[#0b0b0f] hover:bg-[#13131a] text-sm font-medium text-[#e5e0d5] inline-flex items-center gap-2 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4 text-[#9e9a92]" />
                  <span>{prevSection.navTitle}</span>
                </button>
              ) : (
                <span />
              )}

              {nextSection ? (
                <button
                  type="button"
                  onClick={() => selectSection(nextSection.id)}
                  className="min-h-[44px] px-4 py-2 rounded-lg bg-[#e89b3c] hover:bg-[#f0a74b] text-[#090704] text-sm font-semibold inline-flex items-center gap-2 transition-colors"
                >
                  <span>{nextSection.navTitle}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <span />
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Mobile Fixed Thumb Bar — 58px height (+ 52px top bar = 110px <= 15% of 844px) */}
      <nav
        aria-label="Navegação móvel entre seções"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 h-[58px] border-t border-white/[0.08] bg-[#07070a]/95 backdrop-blur-md px-3 grid grid-cols-3 items-center gap-2"
      >
        <button
          type="button"
          disabled={!prevSection}
          onClick={() => prevSection && selectSection(prevSection.id)}
          className="min-h-[44px] px-2 rounded-lg text-xs font-medium text-[#e5e0d5] inline-flex items-center justify-start gap-1.5 disabled:opacity-30"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="truncate">Anterior</span>
        </button>

        <button
          type="button"
          onClick={() => setMobileSheetOpen(true)}
          aria-label="Abrir índice de seções"
          className="min-h-[44px] px-3 rounded-lg border border-white/[0.12] bg-[#111116] text-xs font-medium text-[#f3efe7] inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
        >
          <List className="w-3.5 h-3.5 text-[#e89b3c]" />
          <span className="font-mono tabular-nums">
            {activeSectionIdx + 1}/{ROADMAP_SECTIONS.length}
          </span>
        </button>

        <button
          type="button"
          disabled={!nextSection}
          onClick={() => nextSection && selectSection(nextSection.id)}
          className="min-h-[44px] px-2 rounded-lg text-xs font-semibold text-[#e89b3c] inline-flex items-center justify-end gap-1.5 disabled:opacity-30"
        >
          <span className="truncate">Próxima</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </nav>

      {/* Mobile Bottom Sheet Index Drawer */}
      {mobileSheetOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-end lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Escolher seção do roadmap"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMobileSheetOpen(false);
          }}
        >
          <div className="w-full max-h-[78dvh] rounded-t-2xl border-t border-white/[0.14] bg-[#0b0b0f] px-4 pt-3 pb-6 overflow-y-auto">
            <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-3" />
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="font-display text-base font-semibold text-[#f3efe7]">
                  Seções do Roadmap
                </h2>
                <p className="text-xs font-mono text-[#9e9a92] tabular-nums">
                  {overallProgress.completed}/{overallProgress.total} itens concluídos
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMobileSheetOpen(false)}
                aria-label="Fechar índice"
                className="min-h-[44px] min-w-[44px] rounded-lg border border-white/[0.1] bg-[#121218] inline-flex items-center justify-center text-[#e5e0d5]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              {ROADMAP_SECTIONS.map((sec) => {
                const isActive = sec.id === activeSection.id;
                const stats = computeSectionProgress(sec, completedIds);
                return (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => selectSection(sec.id)}
                    className={`w-full min-h-[48px] px-3.5 py-2.5 rounded-xl border text-left flex items-center justify-between gap-3 ${
                      isActive
                        ? 'bg-[#15151d] border-[#e89b3c]/50 text-[#f3efe7]'
                        : 'bg-[#08080b] border-white/[0.06] text-[#a7a299]'
                    }`}
                  >
                    <span className="flex items-baseline gap-2.5 min-w-0">
                      <span
                        className={`font-mono text-xs tabular-nums ${
                          isActive ? 'text-[#e89b3c]' : 'text-[#6c6860]'
                        }`}
                      >
                        {sec.indexLabel}
                      </span>
                      <span className="text-sm font-medium truncate">
                        {sec.navTitle}
                      </span>
                    </span>
                    {stats.total > 0 && (
                      <span className="font-mono text-xs text-[#7c7870] tabular-nums shrink-0">
                        {stats.completed}/{stats.total}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="mt-4 pt-3 border-t border-white/[0.08] flex items-center gap-2">
              <button
                type="button"
                onClick={handleDownloadStandaloneHtml}
                className="flex-1 min-h-[44px] px-3 rounded-xl border border-white/[0.1] bg-[#121218] text-xs font-medium text-[#e5e0d5] inline-flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4 text-[#e89b3c]" />
                <span>Baixar HTML Offline</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Instant Search Modal (Cmd/Ctrl + K) */}
      {searchOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-start justify-center px-4 pt-16 sm:pt-20 pb-6"
          role="dialog"
          aria-modal="true"
          aria-label="Busca global no roadmap"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSearchOpen(false);
          }}
        >
          <div className="w-full max-w-xl max-h-[75dvh] rounded-xl border border-white/[0.15] bg-[#0b0b0f] flex flex-col overflow-hidden shadow-2xl">
            <div className="flex items-center gap-2 px-4 border-b border-white/[0.08]">
              <Search className="w-4 h-4 text-[#9e9a92] shrink-0" />
              <input
                ref={searchInputRef}
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar fase, arquivo, Jolt, MLS-MPM, 4L, glints..."
                aria-label="Termo de busca no roadmap"
                className="flex-1 h-12 bg-transparent text-sm text-[#f3efe7] placeholder:text-[#6c6860] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setSearchOpen(false)}
                aria-label="Fechar busca"
                className="min-h-[36px] px-2.5 rounded-md text-xs text-[#9e9a92] hover:text-[#f3efe7]"
              >
                Esc
              </button>
            </div>

            <div className="overflow-y-auto p-2">
              {searchQuery.trim() === '' ? (
                <p className="px-3 py-6 text-xs text-[#8a857d] text-center">
                  Digite qualquer termo técnico para pular direto para a seção correspondente.
                </p>
              ) : searchResults.length === 0 ? (
                <p className="px-3 py-6 text-xs text-[#8a857d] text-center">
                  Nenhum resultado encontrado para “{searchQuery}”.
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {searchResults.map((hit, idx) => (
                    <button
                      key={`${hit.sectionId}-${hit.subSectionId}-${hit.itemId ?? idx}`}
                      type="button"
                      onClick={() => {
                        if (hit.itemId) {
                          setExpandedItems((prev) => new Set(prev).add(hit.itemId!));
                        }
                        selectSection(hit.sectionId, hit.subSectionId);
                        setSearchOpen(false);
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-[#14141c] transition-colors"
                    >
                      <div className="flex items-center gap-2 text-[11px] font-mono text-[#e89b3c] mb-0.5">
                        <span>
                          {hit.sectionIndexLabel} · {hit.subSectionCode}
                        </span>
                        <span className="text-[#7c7870] font-sans truncate">
                          {hit.subSectionTitle}
                        </span>
                      </div>
                      <div className="text-sm font-medium text-[#f3efe7]">
                        {hit.title}
                      </div>
                      <div className="text-xs text-[#9e9a92] line-clamp-1 mt-0.5">
                        {hit.snippet}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
