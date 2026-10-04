import { useState } from 'react';
import {
  type ContextFile,
  type ContextMap as ContextMapModel,
  type ContextUsefulness,
  type ModuleFreshness,
  LARGE_FILE_TOKENS,
  LOW_USEFULNESS,
  USEFULNESS_MIN_TOKENS,
  contextBundle,
} from '@openspec-ide/core';
import { nodeKey } from '../lib/contextLayout.js';
import { formatAge, formatShare, formatTokens, plural } from '../lib/format.js';
import { inVsCode, openInEditor } from '../lib/host.js';

/** Сколько самых тяжёлых файлов показывать до «Показать все». */
const TOP_FILES = 12;

/** Путь файла: в VS Code — ссылка на файл и строку, в браузере — текст. */
export function FileLink({ path, line = null }: { readonly path: string; readonly line?: number | null }) {
  const label = line === null ? path : `${path}:${line}`;
  return inVsCode() ? (
    <button type="button" className="linkish mono" onClick={() => openInEditor(path, line)} title={label}>
      {label}
    </button>
  ) : (
    <span className="mono" title={label}>
      {label}
    </span>
  );
}

/** Оценка токенов со знаком «≈»: точного числа без токенизатора модели нет. */
export function tokens(value: number): string {
  return `≈\u00a0${formatTokens(value)}`;
}

/** Свежесть `context.md` относительно кода модуля одной фразой. */
export function FreshnessNote({ freshness }: { readonly freshness: ModuleFreshness | null }) {
  if (freshness === null) return <span className="muted">нет данных git</span>;
  const age = formatAge(freshness.contextDate);
  if (freshness.uncommitted) return <span className="chip ok">правится сейчас</span>;
  if (freshness.commitsAfter === 0) {
    return (
      <span>
        <span className="chip ok">актуален</span>
        {age !== null && <span className="muted"> · правка {age}</span>}
      </span>
    );
  }
  return (
    <span>
      <span className="chip warn">
        отстаёт на {plural(freshness.commitsAfter, ['коммит', 'коммита', 'коммитов'])}
      </span>
      {age !== null && <span className="muted"> · контекст правили {age}</span>}
    </span>
  );
}

function fileKind(file: ContextFile): string {
  switch (file.kind) {
    case 'general':
      return 'общий';
    case 'module':
      return `модуль ${file.owner ?? ''}`;
    case 'spec':
      return `домен ${file.owner ?? ''}`;
    case 'adr':
      return 'ADR';
  }
}

function Meter({
  value,
  max,
  label,
  over = false,
  tone,
}: {
  readonly value: number;
  readonly max: number;
  readonly label: string;
  readonly over?: boolean;
  /** Цвет полосы по качеству: `good`, `mid`, `low`; без него — обычный. */
  readonly tone?: 'good' | 'mid' | 'low';
}) {
  const width = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <span className={['bar', over ? 'over' : null, tone ?? null].filter(Boolean).join(' ')}>
      <span className="track">
        <span className="fill" style={{ width: `${width}%` }} />
      </span>
      <span className="val">{label}</span>
    </span>
  );
}

/**
 * Вид «Контроль» раздела «Контекст»: сколько весит контекст, что в нём лишнее
 * и указывает ли он на то, что есть в проекте.
 */
export function ContextControl({ map, onShow }: { readonly map: ContextMapModel; readonly onShow: (key: string) => void }) {
  return (
    <div className="ctx-control" data-testid="context-control">
      <VolumeCard map={map} onShow={onShow} />
      <UsefulnessCard map={map} />
      <ExcessCard map={map} />
      <RealityCard map={map} onShow={onShow} />
    </div>
  );
}

function VolumeCard({ map, onShow }: { readonly map: ContextMapModel; readonly onShow: (key: string) => void }) {
  const [all, setAll] = useState(false);
  const files = [...map.files].sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
  const shown = all ? files : files.slice(0, TOP_FILES);
  const heaviest = files[0]?.tokens ?? 0;
  const bundles = map.modules
    .map((module) => ({ module, files: contextBundle(map, { modules: [module.id] }).files.length }))
    .sort((a, b) => b.module.bundleTokens - a.module.bundleTokens);
  const largest = Math.max(0, ...bundles.map(({ module }) => Math.max(module.bundleTokens, module.maxTokens ?? 0)));

  return (
    <section className="ctx-control-card" aria-labelledby="ctx-volume">
      <h3 id="ctx-volume">Объём</h3>
      <p className="muted" data-testid="ctx-control-total">
        {tokens(map.totalTokens)} токенов в {plural(files.length, ['файле', 'файлах', 'файлах'])} контекста. Оценка: 4 символа
        латиницы или 2,5 кириллицы на токен; у конкретной модели — до ±35 %.
      </p>
      {files.length === 0 ? (
        <p className="empty">Файлов контекста нет.</p>
      ) : (
        <table className="ctx-control-table" data-testid="ctx-control-files">
          <thead>
            <tr>
              <th scope="col">Файл</th>
              <th scope="col" className="wide">
                Чей
              </th>
              <th scope="col" className="num wide">
                Строк
              </th>
              <th scope="col">Токенов · доля</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((file) => (
              <tr key={file.path} data-testid={`ctx-control-file-${file.path}`}>
                <td>
                  <FileLink path={file.path} />
                  {file.tokens > LARGE_FILE_TOKENS && <span className="chip warn">тяжёлый</span>}
                </td>
                <td className="muted wide">{fileKind(file)}</td>
                <td className="num wide">{file.lines}</td>
                <td>
                  <Meter
                    value={file.tokens}
                    max={heaviest}
                    label={`${tokens(file.tokens)} · ${formatShare(map.totalTokens === 0 ? null : file.tokens / map.totalTokens)}`}
                    over={file.tokens > LARGE_FILE_TOKENS}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {files.length > TOP_FILES && (
        <button type="button" className="btn small" onClick={() => setAll(!all)}>
          {all ? 'Только самые тяжёлые' : `Показать все (${files.length})`}
        </button>
      )}

      {bundles.length > 0 && (
        <>
          <h4>Наборы модулей</h4>
          <p className="muted">
            Набор модуля — общий контекст, модуль и его зависимости по depends_on, спеки их доменов и действующие ADR. Бюджет
            задаётся полем <code>max_tokens</code> в <code>index.md</code>.
          </p>
          <table className="ctx-control-table" data-testid="ctx-control-bundles">
            <thead>
              <tr>
                <th scope="col">Модуль</th>
                <th scope="col" className="num wide">
                  Файлов
                </th>
                <th scope="col">Токенов</th>
                <th scope="col">Полезных</th>
                <th scope="col">Бюджет</th>
              </tr>
            </thead>
            <tbody>
              {bundles.map(({ module, files: count }) => {
                const over = module.maxTokens !== null && module.bundleTokens > module.maxTokens;
                return (
                  <tr key={module.id} data-testid={`ctx-control-bundle-${module.id}`}>
                    <td>
                      <button type="button" className="linkish mono" onClick={() => onShow(nodeKey('module', module.id))}>
                        {module.id}
                      </button>
                    </td>
                    <td className="num wide">{count}</td>
                    <td>
                      <Meter value={module.bundleTokens} max={largest} label={tokens(module.bundleTokens)} over={over} />
                    </td>
                    <td className="ctx-useful-cell" data-testid={`ctx-control-bundle-useful-${module.id}`}>
                      <span className="wide">{tokens(module.bundleUsefulTokens)} · </span>
                      {formatShare(module.bundleTokens === 0 ? null : module.bundleUsefulTokens / module.bundleTokens)}
                    </td>
                    <td>
                      {module.maxTokens === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <span className={over ? 'chip bad' : 'chip ok'}>
                          {over ? 'сверх' : 'в пределах'} {formatTokens(module.maxTokens)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/** Файл отмечен сведением о низкой полезности — по тем же правилам, что и в карте. */
function isLowUseful(file: ContextFile): boolean {
  const usefulness = file.usefulness;
  return usefulness.ballast.empty === 0 && file.tokens >= USEFULNESS_MIN_TOKENS && usefulness.score < LOW_USEFULNESS;
}

/** Цвет коэффициента: от 80 % — хорошо, от 50 % — средне, ниже — плохо. */
function usefulTone(score: number): 'good' | 'mid' | 'low' {
  if (score >= 0.8) return 'good';
  if (score >= LOW_USEFULNESS) return 'mid';
  return 'low';
}

/** Разбивка коэффициента одной строкой — для подсказки и узкой панели. */
export function usefulnessSummary(usefulness: ContextUsefulness): string {
  const { ballast } = usefulness;
  const parts = [
    `плотность ${formatShare(usefulness.density)}`,
    ballast.empty > 0 ? 'пустой файл' : null,
    ballast.duplicate > 0 ? `повторы ≈ ${ballast.duplicate}` : null,
    ballast.placeholder > 0 ? `заготовки ≈ ${ballast.placeholder}` : null,
    ballast.broken > 0 ? `битые пути ≈ ${ballast.broken}` : null,
    usefulness.grounding === null ? null : `привязка ${formatShare(usefulness.grounding)}`,
    usefulness.freshness === null ? null : `свежесть ${usefulness.freshness.toFixed(2).replace('.', ',')}`,
  ];
  return parts.filter((part): part is string => part !== null).join(' · ');
}

function BallastChips({ usefulness }: { readonly usefulness: ContextUsefulness }) {
  const { ballast } = usefulness;
  const chips = [
    ballast.empty > 0 ? 'пустой' : null,
    ballast.duplicate > 0 ? `повторы ${tokens(ballast.duplicate)}` : null,
    ballast.placeholder > 0 ? `заготовки ${tokens(ballast.placeholder)}` : null,
    ballast.broken > 0 ? `битые пути ${tokens(ballast.broken)}` : null,
  ].filter((chip): chip is string => chip !== null);
  if (chips.length === 0) return <span className="muted">—</span>;
  return (
    <span className="ctx-ballast">
      {chips.map((chip) => (
        <span key={chip} className="chip warn">
          {chip}
        </span>
      ))}
    </span>
  );
}

function FreshnessFactor({ usefulness, file, map }: { readonly usefulness: ContextUsefulness; readonly file: ContextFile; readonly map: ContextMapModel }) {
  if (file.kind !== 'module') return <span className="muted">—</span>;
  const module = map.modules.find((item) => item.contextPath === file.path);
  if (module !== undefined && module.codePaths.length === 0) return <span className="muted">не привязан к коду</span>;
  if (usefulness.freshness === null) return <span className="muted">нет данных git</span>;
  if (usefulness.freshness >= 1) return <span className="chip ok">актуален</span>;
  const behind = module?.freshness?.commitsAfter ?? 0;
  return (
    <span className="chip warn">
      {usefulness.freshness.toFixed(2).replace('.', ',')} · {plural(behind, ['коммит', 'коммита', 'коммитов'])}
    </span>
  );
}

/**
 * Карточка «Полезность»: сколько токенов контекста работает, у каких файлов
 * потери и из чего они сложились.
 */
function UsefulnessCard({ map }: { readonly map: ContextMapModel }) {
  const [all, setAll] = useState(false);
  const lost = (file: ContextFile): number => file.tokens - file.usefulness.usefulTokens;
  const losing = map.files.filter((file) => lost(file) > 0).sort((a, b) => lost(b) - lost(a) || a.path.localeCompare(b.path));
  const shown = all ? losing : losing.slice(0, TOP_FILES);
  const rest = map.files.length - losing.length;

  return (
    <section className="ctx-control-card" aria-labelledby="ctx-useful" data-testid="ctx-control-usefulness">
      <h3 id="ctx-useful">Полезность</h3>
      <p className="muted" data-testid="ctx-control-useful-total">
        {tokens(map.usefulTokens)} полезных токенов из {tokens(map.totalTokens)} —{' '}
        {formatShare(map.totalTokens === 0 ? null : map.usefulTokens / map.totalTokens)}.
      </p>
      <p className="muted small">
        Коэффициент = плотность × (0,5 + 0,5 × привязка) × свежесть. Плотность — доля токенов без балласта: повторов, заготовок
        шаблона, абзацев с ненайденными путями. Привязка и свежесть — только у context.md модулей. Это оценка по тексту, а не по
        работе агента.
      </p>
      {losing.length === 0 ? (
        map.files.length > 0 && <p className="muted">Потерь нет: повторов, заготовок и ненайденных путей в контексте нет.</p>
      ) : (
        <table className="ctx-control-table" data-testid="ctx-control-useful-files">
          <thead>
            <tr>
              <th scope="col">Файл</th>
              <th scope="col">Полезно</th>
              <th scope="col" className="num">
                Потеряно
              </th>
              <th scope="col" className="wide">
                Балласт
              </th>
              <th scope="col" className="wide">
                Привязка
              </th>
              <th scope="col" className="wide">
                Свежесть
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((file) => {
              const usefulness = file.usefulness;
              const low = isLowUseful(file);
              return (
                <tr key={file.path} data-testid={`ctx-control-useful-${file.path}`} title={usefulnessSummary(usefulness)}>
                  <td>
                    <FileLink path={file.path} />
                    {low && <span className="chip bad">низкая</span>}
                  </td>
                  <td>
                    <Meter value={usefulness.score} max={1} label={formatShare(usefulness.score)} tone={usefulTone(usefulness.score)} />
                  </td>
                  <td className="num">{tokens(lost(file))}</td>
                  <td className="wide">
                    <BallastChips usefulness={usefulness} />
                  </td>
                  <td className="wide">{usefulness.grounding === null ? <span className="muted">—</span> : formatShare(usefulness.grounding)}</td>
                  <td className="wide">
                    <FreshnessFactor usefulness={usefulness} file={file} map={map} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {losing.length > TOP_FILES && (
        <button type="button" className="btn small" onClick={() => setAll(!all)}>
          {all ? 'Только с наибольшими потерями' : `Показать все (${losing.length})`}
        </button>
      )}
      {losing.length > 0 && rest > 0 && (
        <p className="muted small">
          {rest === 1 ? 'Остальной' : 'Остальные'} {plural(rest, ['файл', 'файла', 'файлов'])} — без потерь.
          {losing.some(isLowUseful) &&
            ' Файл с коэффициентом ниже 50 % отмечен «низкая» — то же сведение есть в списке замечаний.'}
        </p>
      )}
    </section>
  );
}

function ExcessCard({ map }: { readonly map: ContextMapModel }) {
  const empty = map.issues.filter((issue) => issue.kind === 'empty-context');
  const inactive = map.adrs.filter((adr) => !adr.active);
  const wasted = map.duplicates.reduce((sum, duplicate) => sum + duplicate.tokens * (duplicate.occurrences.length - 1), 0);
  const nothing = map.duplicates.length === 0 && empty.length === 0 && map.unusedFiles.length === 0 && inactive.length === 0;

  return (
    <section className="ctx-control-card" aria-labelledby="ctx-excess">
      <h3 id="ctx-excess">Лишнее</h3>
      {nothing && <p className="muted">Повторов, пустых и неиспользуемых файлов нет.</p>}

      {map.duplicates.length > 0 && (
        <div data-testid="ctx-control-duplicates">
          <h4>
            Повторы <span className="muted">· {tokens(wasted)} токенов лишних</span>
          </h4>
          <ul className="ctx-control-list">
            {map.duplicates.map((duplicate) => (
              <li key={`${duplicate.occurrences[0]?.path}:${duplicate.occurrences[0]?.line}`}>
                <q>{duplicate.excerpt}</q>
                <span className="muted"> {tokens(duplicate.tokens)} × {duplicate.occurrences.length}</span>
                <span className="ctx-control-where">
                  {duplicate.occurrences.map((place) => (
                    <FileLink key={`${place.path}:${place.line}`} path={place.path} line={place.line} />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {empty.length > 0 && (
        <div data-testid="ctx-control-empty">
          <h4>Пустой контекст модуля</h4>
          <ul className="ctx-control-list">
            {empty.map((issue) => (
              <li key={issue.path}>
                <FileLink path={issue.path} /> <span className="muted">— только заголовки, в набор нечего положить</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {map.unusedFiles.length > 0 && (
        <div data-testid="ctx-control-unused">
          <h4>Файлы вне наборов</h4>
          <p className="muted">Не входят ни в один набор — агент их не увидит.</p>
          <ul className="ctx-control-list">
            {map.unusedFiles.map((path) => (
              <li key={path}>
                <FileLink path={path} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {inactive.length > 0 && (
        <div data-testid="ctx-control-inactive">
          <h4>Недействующие ADR</h4>
          <p className="muted">В наборы не входят, пока их не выбрать явно или не включить флажок в панели набора.</p>
          <ul className="ctx-control-list">
            {inactive.map((adr) => (
              <li key={adr.path}>
                <FileLink path={adr.path} /> <span className="chip">{adr.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RealityCard({ map, onShow }: { readonly map: ContextMapModel; readonly onShow: (key: string) => void }) {
  const broken = map.references.filter((reference) => !reference.resolved);
  const missingCode = map.modules.flatMap((module) =>
    module.codePaths.filter((code) => !code.exists).map((code) => ({ module: module.id, path: code.path })),
  );
  const withContext = map.modules.filter((module) => module.contextPath !== null);

  return (
    <section className="ctx-control-card" aria-labelledby="ctx-reality">
      <h3 id="ctx-reality">Связь с реальностью</h3>
      <p className="muted" data-testid="ctx-control-references">
        Путей в тексте контекста: {map.references.length}, не найдено: {broken.length}.
      </p>

      {broken.length > 0 && (
        <div data-testid="ctx-control-broken">
          <h4>Пути, которых нет</h4>
          <ul className="ctx-control-list">
            {broken.map((reference) => (
              <li key={`${reference.path}:${reference.line}:${reference.target}`}>
                <span className="mono">{reference.target}</span> <span className="muted">в</span>{' '}
                <FileLink path={reference.path} line={reference.line} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {missingCode.length > 0 && (
        <div>
          <h4>Пути кода, которых нет</h4>
          <ul className="ctx-control-list">
            {missingCode.map((item) => (
              <li key={`${item.module}:${item.path}`}>
                <span className="mono">{item.path}</span> <span className="muted">у модуля</span>{' '}
                <button type="button" className="linkish mono" onClick={() => onShow(nodeKey('module', item.module))}>
                  {item.module}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {withContext.length > 0 && (
        <>
          <h4>Контекст и код модуля</h4>
          <table className="ctx-control-table" data-testid="ctx-control-freshness">
            <thead>
              <tr>
                <th scope="col">Модуль</th>
                <th scope="col" className="wide">
                  Пути кода
                </th>
                <th scope="col">context.md относительно кода</th>
              </tr>
            </thead>
            <tbody>
              {withContext.map((module) => (
                <tr key={module.id} data-testid={`ctx-control-fresh-${module.id}`}>
                  <td>
                    <button type="button" className="linkish mono" onClick={() => onShow(nodeKey('module', module.id))}>
                      {module.id}
                    </button>
                  </td>
                  <td className="wide">
                    {module.codePaths.length === 0 ? (
                      <span className="chip warn">не привязан к коду</span>
                    ) : (
                      <span className="mono">{module.codePaths.map((code) => code.path).join(', ')}</span>
                    )}
                  </td>
                  <td>{module.codePaths.length === 0 ? <span className="muted">—</span> : <FreshnessNote freshness={module.freshness} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
