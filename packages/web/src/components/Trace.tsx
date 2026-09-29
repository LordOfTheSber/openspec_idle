import { useEffect, useMemo, useState } from 'react';
import type { TraceScenario } from '@openspec-ide/core';
import { type TraceResponse, addTraceItem, fetchTrace } from '../lib/api.js';
import { plural } from '../lib/format.js';
import { readPref, writePref } from '../lib/prefs.js';
import {
  SCENARIO_HEIGHT,
  SLOT_HEIGHT,
  agentTask,
  layoutTrace,
  parseStep,
} from '../lib/traceLayout.js';
import { useNotify, useWidth } from '../lib/ui.js';
import { Icon } from './Icon.js';

const MODES = ['all', 'gaps'] as const;

/**
 * Трассировка change: сценарии контракта → пункты плана → проверка приёмки.
 * Непокрытый сценарий — пробел, для которого есть «Добавить пункт в план» и
 * «Копировать задачу для агента».
 */
export function Trace({
  change,
  revision,
  onOpenFile,
}: {
  readonly change: string;
  readonly revision: number;
  readonly onOpenFile: (path: string, line: number | null) => void;
}) {
  const [data, setData] = useState<TraceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<(typeof MODES)[number]>(() => readPref('trace-mode', MODES, 'all'));
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [graphRef, width] = useWidth<HTMLDivElement>();
  const notify = useNotify();

  useEffect(() => {
    let current = true;
    void fetchTrace(change)
      .then((result) => {
        if (!current) return;
        setData(result);
        setError(null);
      })
      .catch((problem: unknown) => {
        if (current) setError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      current = false;
    };
  }, [change, revision]);

  const layout = useMemo(() => (data === null ? null : layoutTrace(data.trace, mode === 'gaps')), [data, mode]);

  // По умолчанию выбран первый пробел — ради него вкладку и открывают.
  useEffect(() => {
    if (data === null) return;
    if (selected !== null && data.trace.scenarios.some((scenario) => scenario.key === selected)) return;
    const covered = new Set(data.trace.covered);
    setSelected(data.trace.scenarios.find((scenario) => !covered.has(scenario.key))?.key ?? null);
  }, [data, selected]);

  useEffect(() => setCopied(false), [selected]);

  if (error !== null && data === null) {
    return (
      <p className="notice error" role="alert">
        {error}
      </p>
    );
  }
  if (data === null || layout === null) {
    return (
      <div className="page-skeleton" aria-busy="true" aria-label="Загрузка трассировки">
        <div className="skeleton-grid">
          <span className="skeleton" style={{ height: 64 }} />
          <span className="skeleton" style={{ height: 64 }} />
          <span className="skeleton" style={{ height: 64 }} />
        </div>
        <span className="skeleton" style={{ height: 280 }} />
      </div>
    );
  }

  const { trace } = data;
  const total = trace.scenarios.length;
  const coveredCount = trace.covered.length;
  const coveredSet = new Set(trace.covered);
  const passed = trace.items.filter((item) => data.metrics[item.key]?.passed === true).length;
  const files = new Set(trace.items.flatMap((item) => data.metrics[item.key]?.files ?? []));
  const dangling = trace.items.flatMap((item) =>
    item.references.filter((reference) => !reference.resolved).map((reference) => ({ item, reference })),
  );
  const scenario = trace.scenarios.find((entry) => entry.key === selected) ?? null;

  if (total === 0) {
    return (
      <div className="state-card" data-testid="trace-empty">
        <span className="state-icon info">
          <Icon name="trace" size={22} />
        </span>
        <h2>В дельтах нет сценариев для покрытия</h2>
        <p>Трассировка связывает сценарии добавленных и изменённых требований с пунктами плана.</p>
      </div>
    );
  }

  const graphWidth = Math.max(640, width ?? 900);
  const col = {
    s: { x: 0, w: graphWidth * 0.4 },
    i: { x: graphWidth * 0.47, w: graphWidth * 0.27 },
    a: { x: graphWidth * 0.78, w: graphWidth * 0.22 },
  };
  const curve = (x1: number, y1: number, x2: number, y2: number): string => {
    const mid = (x1 + x2) / 2;
    return `M${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  };

  async function addItem(target: TraceScenario): Promise<void> {
    setBusy(true);
    try {
      const next = await addTraceItem(change, {
        capability: target.capability,
        requirement: target.requirement,
        scenario: target.name,
      });
      setData(next);
      notify({
        kind: 'ok',
        title: 'Пункт добавлен в план',
        detail: target.name,
        ...(next.planPath === null ? {} : { action: { label: 'Открыть план', run: () => onOpenFile(next.planPath ?? '', null) } }),
      });
    } catch (problem) {
      notify({ kind: 'bad', title: 'Пункт не добавлен', detail: problem instanceof Error ? problem.message : String(problem) });
    } finally {
      setBusy(false);
    }
  }

  async function copyTask(target: TraceScenario): Promise<void> {
    try {
      await navigator.clipboard.writeText(agentTask(change, target, data?.planPath ?? null));
      setCopied(true);
    } catch {
      notify({ kind: 'bad', title: 'Буфер обмена недоступен' });
    }
  }

  return (
    <div className="trace" data-testid="trace">
      <div className="trace-main">
        <div className="trace-summary">
          <div className="tile">
            <CoverageRing value={coveredCount} total={total} />
            <div>
              <b data-testid="trace-coverage">
                {coveredCount} из {total}
              </b>
              <span>сценариев покрыты пунктами плана</span>
            </div>
          </div>
          <div className="tile">
            <CoverageRing value={passed} total={Math.max(1, trace.items.length)} />
            <div>
              <b>
                {passed} из {trace.items.length}
              </b>
              <span>пунктов с пройденной приёмкой</span>
            </div>
          </div>
          <div className="tile">
            <span className="tile-icon">
              <Icon name="file" size={20} />
            </span>
            <div>
              <b>{plural(files.size, ['файл', 'файла', 'файлов'])}</b>
              <span>кода затронуто пунктами</span>
            </div>
          </div>
        </div>

        <div className="trace-toolbar">
          <div className="segmented" role="group" aria-label="Показать">
            <button
              type="button"
              aria-pressed={mode === 'all'}
              onClick={() => {
                setMode('all');
                writePref('trace-mode', 'all');
              }}
            >
              Все связи
            </button>
            <button
              type="button"
              aria-pressed={mode === 'gaps'}
              onClick={() => {
                setMode('gaps');
                writePref('trace-mode', 'gaps');
              }}
              data-testid="trace-gaps-only"
            >
              Только пробелы · {total - coveredCount}
            </button>
          </div>
          <span className="muted small">
            <span className="legend-line solid" /> явная ссылка <span className="legend-line dashed" /> по названию
          </span>
        </div>

        <div className="trace-graph" ref={graphRef}>
          {layout.scenarios.length === 0 ? (
            <p className="notice ok">Все сценарии покрыты пунктами плана.</p>
          ) : (
            <div className="trace-canvas" style={{ height: layout.height, width: graphWidth }}>
              <svg width={graphWidth} height={layout.height} className="trace-edges" aria-hidden="true">
                {layout.edges.map((edge, index) => (
                  <path
                    key={`${edge.scenario}-${index}`}
                    d={curve(col.s.w, edge.from, col.i.x, edge.to)}
                    className={`trace-edge ${edge.kind} ${edge.scenario === selected ? 'hot' : ''}`}
                  />
                ))}
                {layout.slots.map((slot) =>
                  slot.kind === 'item' ? (
                    <path
                      key={`acc-${slot.item.line}`}
                      d={`M${col.i.x + col.i.w} ${slot.y + SLOT_HEIGHT / 2} L${col.a.x} ${slot.y + SLOT_HEIGHT / 2}`}
                      className={`trace-edge acc ${data.metrics[slot.item.key]?.passed === true ? 'passed' : ''}`}
                    />
                  ) : null,
                )}
              </svg>
              <span className="trace-col-head" style={{ left: col.s.x }}>
                Сценарии контракта <span className="badge">{total}</span>
              </span>
              <span className="trace-col-head" style={{ left: col.i.x }}>
                Пункты плана <span className="badge">{trace.items.length}</span>
              </span>
              <span className="trace-col-head" style={{ left: col.a.x }}>
                Приёмка и файлы
              </span>
              {layout.groups.map((group) => (
                <span key={group.key} className="trace-group" style={{ top: group.y, left: col.s.x, width: col.s.w }}>
                  <Icon name="spec" size={13} />
                  <span className="mono">{group.capability}</span>
                  <span className="muted">·</span>
                  <span>{group.requirement}</span>
                </span>
              ))}
              {layout.scenarios.map((box) => (
                <button
                  key={box.scenario.key}
                  type="button"
                  className={`trace-scenario ${box.covered ? 'covered' : 'gap'} ${box.scenario.key === selected ? 'selected' : ''}`}
                  style={{ top: box.y, left: col.s.x, width: col.s.w, height: SCENARIO_HEIGHT }}
                  onClick={() => setSelected(box.scenario.key)}
                  aria-pressed={box.scenario.key === selected}
                  data-testid={`trace-scenario-${box.scenario.name}`}
                  data-covered={box.covered}
                >
                  <Icon name={box.covered ? 'checkCircle' : 'alert'} size={15} />
                  <span className="t">{box.scenario.name}</span>
                </button>
              ))}
              {layout.slots.map((slot) => {
                if (slot.kind === 'gap') {
                  return (
                    <button
                      key={`gap-${slot.scenario.key}`}
                      type="button"
                      className="trace-gap"
                      style={{ top: slot.y + 10, left: col.i.x, height: SLOT_HEIGHT - 20 }}
                      onClick={() => setSelected(slot.scenario.key)}
                    >
                      <Icon name="plus" size={13} />
                      Нет пункта плана
                    </button>
                  );
                }
                const metrics = data.metrics[slot.item.key];
                const free = !trace.links.some((link) => link.item === slot.item.line);
                return [
                  <button
                    key={`item-${slot.item.line}`}
                    type="button"
                    className={`trace-item ${free ? 'free' : ''}`}
                    style={{ top: slot.y, left: col.i.x, width: col.i.w, height: SLOT_HEIGHT }}
                    onClick={() => data.planPath !== null && onOpenFile(data.planPath, slot.item.line)}
                    title={slot.item.text}
                    data-testid={`trace-item-${slot.item.declaredNumber ?? slot.item.line}`}
                  >
                    <span className="trace-item-head">
                      <span className="mono muted">{slot.item.declaredNumber ?? '•'}</span>
                      <Icon name={slot.item.done ? 'check' : 'circle'} size={13} className={slot.item.done ? 'ok-icon' : 'muted'} />
                      <span className="muted small">{free ? 'без сценария' : slot.item.done ? 'готово' : 'не готово'}</span>
                    </span>
                    <span className="t">{slot.item.text}</span>
                  </button>,
                  <div
                    key={`acc-${slot.item.line}`}
                    className="trace-acc"
                    style={{ top: slot.y, left: col.a.x, width: col.a.w, height: SLOT_HEIGHT }}
                  >
                    {metrics?.passed === true ? (
                      <span className="status ok">
                        <Icon name="checkCircle" size={14} />
                        Приёмка пройдена
                      </span>
                    ) : metrics?.passed === false ? (
                      <span className="status bad">
                        <Icon name="error" size={14} />
                        Приёмка не пройдена
                      </span>
                    ) : (
                      <span className="status unknown">
                        <Icon name="circle" size={14} />
                        {metrics?.criterion === null || metrics === undefined ? 'Нет критерия' : 'Не запускалась'}
                      </span>
                    )}
                    <span className="muted small">
                      <Icon name="file" size={12} /> {plural(metrics?.files.length ?? 0, ['файл', 'файла', 'файлов'])}
                    </span>
                  </div>,
                ];
              })}
            </div>
          )}
        </div>
      </div>

      <aside className="trace-aside" aria-label="Сценарий">
        {scenario === null ? (
          <div className="trace-help">
            <p className="section-label">Как связывать</p>
            <p>
              Под пунктом плана напишите строку со ссылкой на сценарий или требование — связь станет явной:
            </p>
            <pre className="code-sample">{`- [ ] 2.2 Предупреждение без CLI\n  ↳ vscode-extension / Команда без CLI`}</pre>
            <p className="muted">
              Без ссылки IDE находит связь по названию сценария или требования в тексте пункта и рисует её пунктиром.
            </p>
          </div>
        ) : (
          <ScenarioPanel
            scenario={scenario}
            covered={coveredSet.has(scenario.key)}
            data={data}
            busy={busy}
            copied={copied}
            onAdd={() => void addItem(scenario)}
            onCopy={() => void copyTask(scenario)}
            onClose={() => setSelected(null)}
            onOpenFile={onOpenFile}
          />
        )}
        {dangling.length > 0 && (
          <div className="trace-dangling" data-testid="trace-dangling">
            <p className="section-label">
              Висячие ссылки <span className="badge warn">{dangling.length}</span>
            </p>
            {dangling.map(({ item, reference }) => (
              <button
                key={`${reference.line}`}
                type="button"
                className="detail-row row-hover"
                onClick={() => data.planPath !== null && onOpenFile(data.planPath, reference.line)}
              >
                <Icon name="alert" size={14} className="warn-icon" />
                <span className="mono small">{item.declaredNumber ?? item.line}</span>
                <span className="small">
                  {reference.capability} / {reference.target}
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

function ScenarioPanel({
  scenario,
  covered,
  data,
  busy,
  copied,
  onAdd,
  onCopy,
  onClose,
  onOpenFile,
}: {
  readonly scenario: TraceScenario;
  readonly covered: boolean;
  readonly data: TraceResponse;
  readonly busy: boolean;
  readonly copied: boolean;
  readonly onAdd: () => void;
  readonly onCopy: () => void;
  readonly onClose: () => void;
  readonly onOpenFile: (path: string, line: number | null) => void;
}) {
  const links = data.trace.links.filter((link) => link.scenario === scenario.key);
  const items = links
    .map((link) => ({ link, item: data.trace.items.find((entry) => entry.line === link.item) }))
    .filter((entry) => entry.item !== undefined);
  const lastGroup = data.trace.items.at(-1)?.group;
  const nextNumber =
    lastGroup === undefined ? null : `${lastGroup}.${data.trace.items.filter((item) => item.group === lastGroup).length + 1}`;

  return (
    <div className="scenario-panel" data-testid="trace-scenario-panel">
      <div className="scenario-panel-head">
        {covered ? (
          <span className="chip ok">
            <Icon name="check" size={12} />
            Покрыт
          </span>
        ) : (
          <span className="chip warn">
            <Icon name="alert" size={12} />
            Пробел в покрытии
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div>
        <div className="mono muted small">
          {scenario.capability} · {scenario.requirement}
        </div>
        <h2 className="scenario-title">{scenario.name}</h2>
      </div>
      <dl className="steps">
        {scenario.steps.map((step, index) => {
          const parsed = parseStep(step);
          return [
            <dt key={`t${index}`} className="mono">
              {parsed.label}
            </dt>,
            <dd key={`d${index}`}>{parsed.text}</dd>,
          ];
        })}
      </dl>
      {covered ? (
        <div className="scenario-links">
          <p className="section-label">Пункты плана</p>
          {items.map(({ link, item }) =>
            item === undefined ? null : (
              <button
                key={item.line}
                type="button"
                className="detail-row row-hover"
                onClick={() => data.planPath !== null && onOpenFile(data.planPath, item.line)}
              >
                <span className="mono small muted">{item.declaredNumber ?? '•'}</span>
                <span className="small grow">{item.text}</span>
                <span className={link.kind === 'explicit' ? 'chip ok' : 'chip'}>
                  {link.kind === 'explicit' ? 'ссылка' : 'по названию'}
                </span>
              </button>
            ),
          )}
        </div>
      ) : (
        <>
          <p className="muted">
            Сценарий есть в контракте, но ни один пункт плана на него не ссылается — поведение может не попасть в код.
          </p>
          {data.planPath !== null && (
            <div>
              <p className="section-label">Будет добавлено в {data.planPath.split('/').pop()}</p>
              <pre className="code-sample">
                {`- [ ] ${nextNumber === null ? '' : `${nextNumber} `}${scenario.name}\n  ↳ ${scenario.capability} / ${scenario.name}`}
              </pre>
            </div>
          )}
          <div className="scenario-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy || data.planPath === null}
              title={data.planPath === null ? 'Схема не объявила отслеживаемый артефакт — пункт некуда добавить' : undefined}
              onClick={onAdd}
              data-testid="trace-add-item"
            >
              <Icon name="plus" size={14} />
              Добавить пункт в план
            </button>
            <button type="button" className="btn" onClick={onCopy} data-testid="trace-copy-task">
              <Icon name={copied ? 'check' : 'copy'} size={14} />
              {copied ? 'Скопировано' : 'Копировать задачу для агента'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CoverageRing({ value, total }: { readonly value: number; readonly total: number }) {
  const radius = 22;
  const length = 2 * Math.PI * radius;
  const share = total === 0 ? 1 : value / total;
  const percent = Math.round(share * 100);
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" className="ring" aria-hidden="true">
      <circle cx="28" cy="28" r={radius} className="ring-track" />
      <circle
        cx="28"
        cy="28"
        r={radius}
        className={share >= 1 ? 'ring-value complete' : 'ring-value warn'}
        strokeDasharray={`${length * share} ${length}`}
        transform="rotate(-90 28 28)"
      />
      <text x="28" y="29" textAnchor="middle" dominantBaseline="middle" className="ring-text">
        {percent}%
      </text>
    </svg>
  );
}
