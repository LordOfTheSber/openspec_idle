import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  COVERAGE_LABEL,
  MODULE_KIND_LABEL,
  findByAnchor,
  parseSpecLinks,
  requirementAnchor,
  type RequirementComparison,
} from '@openspec-ide/core';
import {
  fetchComparison,
  fetchCoverage,
  fetchHistory,
  fetchLinks,
  fetchModuleSpec,
  type CoverageState,
  type CoverageView,
  type HistoryEntry,
  type LinkGraph,
  type ModuleSpecView as SpecModel,
  type RequirementView,
  type SpecSection,
} from '../lib/api.js';
import { TracePanel } from './TracePanel.js';

const OPERATION_LABEL: Record<string, string> = {
  ADDED: 'добавляется',
  MODIFIED: 'изменяется',
  REMOVED: 'удаляется',
  RENAMED: 'переименовывается',
};

const COVERAGE_ORDER: readonly CoverageState[] = ['full', 'code', 'tests', 'probable', 'none'];

/** Адрес требования: `#spec=<capability>&req=<якорь>`. */
export function requirementHash(capability: string, anchor: string | null): string {
  const params = new URLSearchParams({ spec: capability });
  if (anchor !== null) params.set('req', anchor);
  return `#${params.toString()}`;
}

export function parseRequirementHash(hash: string): { capability: string; anchor: string | null } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const capability = params.get('spec');
  return capability === null || capability === '' ? null : { capability, anchor: params.get('req') };
}

/**
 * Спека модуля: обзор, оглавление разделов, поиск и карточки требований с
 * признаками changes, покрытия и ссылок.
 */
export function ModuleSpecView({
  capability,
  initialAnchor,
  revision,
  onOpenChange,
  onOpenSpec,
  onOpenSettings,
}: {
  readonly capability: string;
  readonly initialAnchor: string | null;
  /** Счётчик изменений на диске и в индексе кода: спека перечитывается. */
  readonly revision: number;
  readonly onOpenChange: (change: string) => void;
  readonly onOpenSpec: (capability: string, anchor: string | null) => void;
  readonly onOpenSettings?: () => void;
}) {
  const [spec, setSpec] = useState<SpecModel | null>(null);
  const [coverage, setCoverage] = useState<CoverageView | null>(null);
  const [links, setLinks] = useState<LinkGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CoverageState | null>(null);
  const [open, setOpen] = useState<string | null>(initialAnchor);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(initialAnchor), [initialAnchor, capability]);

  useEffect(() => {
    let current = true;
    void Promise.all([fetchModuleSpec(capability), fetchLinks()])
      .then(([model, graph]) => {
        if (!current) return;
        setSpec(model);
        setLinks(graph);
        setError(null);
      })
      .catch((problem: unknown) => {
        if (current) setError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      current = false;
    };
  }, [capability, revision]);

  // Покрытие приходит по мере индексации кода: пока индекс строится, опрос.
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = (): void => {
      void fetchCoverage(capability)
        .then((result) => {
          if (!current) return;
          setCoverage(result);
          if (result.index.state !== 'ready') timer = setTimeout(load, 700);
        })
        .catch(() => undefined);
    };
    load();
    return () => {
      current = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [capability, revision]);

  // Открытое требование — в адресе: его можно скопировать и открыть позже.
  useEffect(() => {
    if (spec === null) return;
    const hash = requirementHash(capability, open);
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }, [capability, open, spec]);

  useEffect(() => {
    if (spec === null || open === null) return;
    const target = body.current?.querySelector(`[data-anchor="${CSS.escape(open)}"]`);
    target?.scrollIntoView({ block: 'center' });
    // Только при загрузке спеки и переходе по адресу, а не при каждом раскрытии.
  }, [spec]);

  const traces = useMemo(
    () => new Map((coverage?.requirements ?? []).map((trace) => [trace.requirement, trace])),
    [coverage],
  );

  const matches = useCallback(
    (requirement: RequirementView): boolean => {
      if (filter !== null && traces.get(requirement.name)?.state !== filter) return false;
      const needle = query.trim().toLowerCase();
      if (needle === '') return true;
      return [requirement.name, requirement.description, ...requirement.scenarios.flatMap((scenario) => [scenario.name, ...scenario.steps])]
        .some((text) => text.toLowerCase().includes(needle));
    },
    [filter, query, traces],
  );

  if (error !== null) return <p className="notice error">{error}</p>;
  if (spec === null) return <p className="empty">Загрузка спеки…</p>;

  const count = (section: SpecSection): number =>
    section.requirements.filter(matches).length + section.children.reduce((sum, child) => sum + count(child), 0);
  const filtering = query.trim() !== '' || filter !== null;

  return (
    <div className="module-spec" data-testid="module-spec">
      <section className="spec-overview" data-testid="spec-overview">
        <p className="pane-title">
          Спека {spec.capability}
          {spec.module !== null && <span className="count">{MODULE_KIND_LABEL[spec.module.kind]}</span>}
        </p>
        {spec.purpose !== null && <p className="purpose">{spec.purpose}</p>}
        <dl className="overview-facts">
          {spec.module !== null && (
            <>
              <dt>Модуль</dt>
              <dd className="mono">
                {spec.module.id} · {spec.module.path ?? '—'}
              </dd>
            </>
          )}
          <dt>Состав</dt>
          <dd data-testid="spec-counts">
            {spec.counts.sections} разд. · {spec.counts.requirements} треб. · {spec.counts.scenarios} сцен.
          </dd>
          <dt>Связи</dt>
          <dd>
            исходящих {spec.links.outgoing} · входящих {spec.links.incoming}
          </dd>
          <dt>Changes</dt>
          <dd>
            {spec.activeChanges.length === 0
              ? 'нет активных'
              : spec.activeChanges.map((change) => (
                  <button key={change} type="button" className="link mono" onClick={() => onOpenChange(change)}>
                    {change}
                  </button>
                ))}
          </dd>
        </dl>
        <div className="coverage-summary" data-testid="coverage-summary">
          {coverage === null || coverage.index.state !== 'ready' ? (
            <span className="muted small" data-testid="index-progress">
              Индексация кода… {coverage?.index.processed ?? 0}/{coverage?.index.files || '?'} файлов
            </span>
          ) : (
            COVERAGE_ORDER.map((state) => (
              <button
                key={state}
                type="button"
                className={`chip coverage ${state} ${filter === state ? 'on' : ''}`}
                onClick={() => setFilter((current) => (current === state ? null : state))}
                data-testid={`coverage-filter-${state}`}
                aria-pressed={filter === state}
              >
                {COVERAGE_LABEL[state]} · {coverage.summary[state]}
              </button>
            ))
          )}
        </div>
      </section>

      {spec.warnings.length > 0 && (
        <div className="notice error" role="alert" data-testid="spec-warnings">
          <ul className="failure-details">
            {spec.warnings.map((warning) => (
              <li key={`${warning.kind}-${warning.line}`}>
                строка {warning.line}: {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="spec-layout">
        <nav className="spec-toc" aria-label="Оглавление спеки" data-testid="spec-toc">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск в спеке…"
            aria-label="Поиск в спеке"
            data-testid="spec-search"
          />
          <TocLevel
            sections={spec.sections}
            active={activeSection}
            count={filtering ? count : null}
            onPick={(key) => {
              setActiveSection(key);
              body.current?.querySelector(`[data-section="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'start' });
            }}
          />
        </nav>
        <div className="spec-body" ref={body}>
          {spec.sections.map((section) => (
            <SectionBlock
              key={section.path.join('/')}
              section={section}
              capability={capability}
              active={activeSection}
              matches={matches}
              query={query.trim()}
              open={open}
              onToggle={(anchor) => setOpen((current) => (current === anchor ? null : anchor))}
              traces={traces}
              links={links}
              onOpenChange={onOpenChange}
              onOpenSpec={onOpenSpec}
              onOpenSettings={onOpenSettings}
            />
          ))}
          {filtering && spec.sections.every((section) => count(section) === 0) && (
            <p className="empty" data-testid="spec-no-matches">
              Нет требований под условия поиска.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function TocLevel({
  sections,
  active,
  count,
  onPick,
}: {
  readonly sections: readonly SpecSection[];
  readonly active: string | null;
  readonly count: ((section: SpecSection) => number) | null;
  readonly onPick: (key: string) => void;
}) {
  return (
    <ul>
      {sections.map((section) => {
        const key = section.path.join(' / ');
        return (
          <li key={key}>
            <button
              type="button"
              className={`toc-item ${active === key ? 'sel' : ''}`}
              onClick={() => onPick(key)}
              data-testid={`toc-${key}`}
            >
              <span>{section.title}</span>
              <span className="n">
                {count === null ? `${section.requirementCount} · ${section.scenarioCount}` : `${count(section)} совп.`}
              </span>
            </button>
            {section.children.length > 0 && <TocLevel sections={section.children} active={active} count={count} onPick={onPick} />}
          </li>
        );
      })}
    </ul>
  );
}

interface SectionProps {
  readonly section: SpecSection;
  readonly capability: string;
  readonly active: string | null;
  readonly matches: (requirement: RequirementView) => boolean;
  readonly query: string;
  readonly open: string | null;
  readonly onToggle: (anchor: string) => void;
  readonly traces: ReadonlyMap<string, CoverageView['requirements'][number]>;
  readonly links: LinkGraph | null;
  readonly onOpenChange: (change: string) => void;
  readonly onOpenSpec: (capability: string, anchor: string | null) => void;
  readonly onOpenSettings: (() => void) | undefined;
}

function SectionBlock(props: SectionProps) {
  const { section, active } = props;
  const key = section.path.join(' / ');
  const visible = section.requirements.filter(props.matches);
  const depth = section.path.length;
  return (
    <section className={`spec-section ${active === key ? 'sel' : ''}`} data-section={key}>
      {depth === 1 ? <h2>{section.title}</h2> : <h3>{section.path.join(' › ')}</h3>}
      {visible.map((requirement) => (
        <RequirementCard key={requirement.anchor} requirement={requirement} {...props} />
      ))}
      {section.children.map((child) => (
        <SectionBlock key={child.path.join('/')} {...props} section={child} />
      ))}
    </section>
  );
}

function RequirementCard({
  requirement,
  capability,
  query,
  open,
  onToggle,
  traces,
  links,
  onOpenSpec,
  onOpenSettings,
}: SectionProps & { readonly requirement: RequirementView }) {
  const expanded = open === requirement.anchor;
  const trace = traces.get(requirement.name);
  const [comparison, setComparison] = useState<{ change: string; result: RequirementComparison | null } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const incoming = (links?.links ?? []).filter(
    (link) => link.toCapability === capability && link.toRequirement === requirement.name,
  );

  async function compare(change: string): Promise<void> {
    const result = await fetchComparison(change, capability, requirement.name);
    setComparison({ change, result: result.comparison });
  }

  return (
    <article
      className={`req-card ${expanded ? 'open' : ''} ${requirement.proposedBy !== null ? 'proposed' : ''}`}
      data-anchor={requirement.anchor}
      data-testid={`req-${requirement.name}`}
    >
      <header>
        <button type="button" className="req-title" onClick={() => onToggle(requirement.anchor)} aria-expanded={expanded}>
          <span className="tw">{expanded ? '▾' : '▸'}</span>
          <Highlighted text={requirement.short} query={query} />
        </button>
        <span className="req-badges">
          {requirement.changes.map((change) => (
            <button
              key={`${change.change}-${change.operation}`}
              type="button"
              className={`chip op ${change.operation.toLowerCase()}`}
              onClick={() => void compare(change.change)}
              title="Сравнить с предлагаемым текстом"
              data-testid="req-change"
            >
              {change.change}: {OPERATION_LABEL[change.operation] ?? change.operation}
            </button>
          ))}
          {trace !== undefined && (
            <span className={`chip coverage ${trace.state}`} data-testid="req-coverage" data-state={trace.state}>
              {COVERAGE_LABEL[trace.state]}
            </span>
          )}
          {(requirement.outgoing > 0 || requirement.incoming > 0) && (
            <span className="chip" title="Ссылки на требования других модулей: исходящие и входящие">
              ↗{requirement.outgoing} ↙{requirement.incoming}
            </span>
          )}
        </span>
      </header>

      {comparison !== null && (
        <div className="req-compare" data-testid="req-compare">
          <p className="grp">
            Сравнение с {comparison.change}
            <button type="button" className="link" onClick={() => setComparison(null)}>
              скрыть
            </button>
          </p>
          {comparison.result === null ? (
            <p className="empty small">Требование удаляется или переименовывается — предлагаемого текста нет.</p>
          ) : (
            <>
              <pre className="diff-preview">
                {comparison.result.description.map((line, index) => (
                  <div key={index} className={line.kind}>
                    {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
                    {line.text}
                  </div>
                ))}
              </pre>
              {comparison.result.addedScenarios.length > 0 && <p className="small added">+ сценарии: {comparison.result.addedScenarios.join(', ')}</p>}
              {comparison.result.removedScenarios.length > 0 && <p className="small removed">− сценарии: {comparison.result.removedScenarios.join(', ')}</p>}
            </>
          )}
        </div>
      )}

      {expanded && (
        <div className="req-body">
          {requirement.proposedBy !== null && (
            <p className="notice info small">Предлагается в change {requirement.proposedBy} — в основной спеке его ещё нет.</p>
          )}
          <p className="req-text">
            <RichText text={requirement.description} capability={capability} query={query} onOpenSpec={onOpenSpec} />
          </p>
          {requirement.scenarios.map((scenario) => (
            <div key={scenario.line} className="scenario">
              <p className="scenario-name">
                <Highlighted text={scenario.name} query={query} />
              </p>
              <ul>
                {scenario.steps.map((step, index) => (
                  <li key={index}>
                    <Step text={step} capability={capability} query={query} onOpenSpec={onOpenSpec} />
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="req-actions">
            <button
              type="button"
              className="btn small"
              onClick={() => {
                const url = `${window.location.origin}${window.location.pathname}${requirementHash(capability, requirement.anchor)}`;
                void navigator.clipboard?.writeText(url).then(() => setCopied(true));
              }}
              data-testid="copy-address"
            >
              {copied ? 'Адрес скопирован' : 'Скопировать адрес'}
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => void fetchHistory(capability, requirement.name).then((result) => setHistory(result.entries))}
              data-testid="load-history"
            >
              История
            </button>
          </div>

          {history !== null && (
            <section className="req-history" data-testid="req-history">
              <p className="grp">История · {history.length}</p>
              {history.length === 0 && <p className="empty small">В архиве changes требование не встречается.</p>}
              <ol>
                {history.map((entry, index) => (
                  <li key={`${entry.change}-${index}`}>
                    <button type="button" className="link" onClick={() => setHistoryOpen((current) => (current === index ? null : index))}>
                      {entry.date ?? '—'} · {entry.change} · {OPERATION_LABEL[entry.operation] ?? entry.operation}
                      {entry.renamedFrom !== null && ` (было «${entry.renamedFrom}»)`}
                    </button>
                    {historyOpen === index && (
                      <pre className="diff-preview" data-testid="history-diff">
                        {entry.diff.length === 0
                          ? 'Текст не менялся.'
                          : entry.diff.map((line, position) => (
                              <div key={position} className={line.kind}>
                                {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
                                {line.text}
                              </div>
                            ))}
                      </pre>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section data-testid="req-backlinks">
            <p className="grp">Ссылаются · {incoming.length}</p>
            {incoming.length === 0 ? (
              <p className="empty small">Ни одно требование на это не ссылается.</p>
            ) : (
              <ul className="link-list">
                {incoming.map((link) => (
                  <li key={`${link.file}:${link.line}`}>
                    <button
                      type="button"
                      className="link"
                      onClick={() => onOpenSpec(link.fromCapability, link.fromRequirement === null ? null : requirementAnchor(link.fromRequirement))}
                    >
                      {link.fromModule ?? link.fromCapability}: {link.fromRequirement ?? 'спека'}
                    </button>
                    {link.change !== null && <span className="chip warn">в change {link.change}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <p className="grp">Код и тесты</p>
            <TracePanel trace={trace} onOpenSettings={onOpenSettings} />
          </section>
        </div>
      )}
    </article>
  );
}

/** Шаг сценария: WHEN, THEN и AND выделены. */
function Step({ text, ...rest }: { readonly text: string; readonly capability: string; readonly query: string; readonly onOpenSpec: (capability: string, anchor: string | null) => void }) {
  const match = /^-\s+\*\*(\w+)\*\*\s*(.*)$/.exec(text);
  if (match === null) return <RichText text={text} {...rest} />;
  return (
    <>
      <b className="kw">{match[1]}</b> <RichText text={match[2] ?? ''} {...rest} />
    </>
  );
}

const RE_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Текст с кликабельными ссылками на требования и подсветкой найденного. */
function RichText({
  text,
  capability,
  query,
  onOpenSpec,
}: {
  readonly text: string;
  readonly capability: string;
  readonly query: string;
  readonly onOpenSpec: (capability: string, anchor: string | null) => void;
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(RE_LINK)) {
    const index = match.index;
    parts.push(<Highlighted key={`t${last}`} text={text.slice(last, index)} query={query} />);
    const [link] = parseSpecLinks(match[0], capability);
    parts.push(
      link === undefined ? (
        <span key={`l${index}`}>{match[1]}</span>
      ) : (
        <SpecLinkChip key={`l${index}`} label={match[1] ?? ''} capability={link.capability} anchor={link.anchor} onOpenSpec={onOpenSpec} />
      ),
    );
    last = index + match[0].length;
  }
  parts.push(<Highlighted key="tail" text={text.slice(last)} query={query} />);
  return <>{parts}</>;
}

const previewCache = new Map<string, Promise<SpecModel | null>>();

/** Ссылка на требование другого модуля: переход и превью цели при наведении. */
function SpecLinkChip({
  label,
  capability,
  anchor,
  onOpenSpec,
}: {
  readonly label: string;
  readonly capability: string;
  readonly anchor: string | null;
  readonly onOpenSpec: (capability: string, anchor: string | null) => void;
}) {
  const [preview, setPreview] = useState<{ title: string; text: string; scenarios: string[] } | 'missing' | null>(null);
  const [shown, setShown] = useState(false);

  function load(): void {
    setShown(true);
    if (preview !== null) return;
    let pending = previewCache.get(capability);
    if (pending === undefined) {
      pending = fetchModuleSpec(capability).catch(() => null);
      previewCache.set(capability, pending);
    }
    void pending.then((spec) => {
      if (spec === null) return setPreview('missing');
      const all = flatten(spec.sections);
      const name = anchor === null ? null : findByAnchor(anchor, all.map((item) => item.name));
      const target = all.find((item) => item.name === name);
      if (anchor === null) setPreview({ title: `Спека ${capability}`, text: spec.purpose ?? '', scenarios: [] });
      else if (target === undefined) setPreview('missing');
      else setPreview({ title: `${capability}: ${target.name}`, text: target.description, scenarios: target.scenarios.map((item) => item.name) });
    });
  }

  return (
    <span className="spec-link-wrap" onMouseEnter={load} onMouseLeave={() => setShown(false)} onFocus={load} onBlur={() => setShown(false)}>
      <button type="button" className={`spec-link ${preview === 'missing' ? 'broken' : ''}`} onClick={() => onOpenSpec(capability, anchor)} data-testid="spec-link">
        {label}
      </button>
      {shown && preview !== null && (
        <span className="spec-link-preview" role="tooltip" data-testid="spec-link-preview">
          {preview === 'missing' ? (
            'Цель ссылки не найдена'
          ) : (
            <>
              <b>{preview.title}</b>
              <span>{preview.text.replace(RE_LINK, '$1')}</span>
              {preview.scenarios.length > 0 && <span className="muted">Сценарии: {preview.scenarios.join(', ')}</span>}
            </>
          )}
        </span>
      )}
    </span>
  );
}

function flatten(sections: readonly SpecSection[]): RequirementView[] {
  return sections.flatMap((section) => [...section.requirements, ...flatten(section.children)]);
}

function Highlighted({ text, query }: { readonly text: string; readonly query: string }) {
  if (query === '') return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let index = lower.indexOf(needle); index !== -1; index = lower.indexOf(needle, from)) {
    parts.push(<Fragment key={`t${from}`}>{text.slice(from, index)}</Fragment>);
    parts.push(<mark key={`m${index}`}>{text.slice(index, index + needle.length)}</mark>);
    from = index + needle.length;
  }
  parts.push(<Fragment key="tail">{text.slice(from)}</Fragment>);
  return <>{parts}</>;
}
