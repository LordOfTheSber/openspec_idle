import type {
  ApiMethod,
  Board,
  ConformanceReport,
  SchemaDocument,
  CapabilityMap,
  ChangeSummary,
  ContextMap,
  ItemMetrics,
  QualityLevel,
  QualityOverview,
  QualityRule,
  MetricsExport,
  DeltaView,
  DriftReport,
  RequirementComparison,
  SearchHit,
  SpecChange,
  StructureIssue,
  StructureNode,
  StructureSpecError,
  Trace,
  WorkspaceTree,
} from '@openspec-ide/core';
import { apiTransport, pageToken } from './transport.js';

/** Состояние рабочего пространства, отданное сервером. */
export type WorkspaceResponse =
  | { readonly state: 'not-initialized'; readonly hint: string; readonly message: string }
  | {
      readonly state: 'cli-missing';
      readonly notice: {
        readonly title: string;
        readonly tool: string;
        readonly install: string;
        /** Что делать, если CLI установлен, но IDE его не видит. */
        readonly hint: string;
        readonly configured: string | null;
        readonly searched: readonly string[];
      };
    }
  | {
      readonly state: 'ready';
      readonly root: string;
      readonly tree: WorkspaceTree;
      readonly errors: readonly string[];
    };

/** Токен сессии, встроенный сервером в отданную страницу. */
export const sessionToken = pageToken;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Выполняет запрос текущим транспортом и разбирает отказ.
 *
 * 409 с версией с диска — конфликт записи файла; прочие 409 (например,
 * занятый запуском change) — обычный отказ с пояснением.
 */
async function call<T>(method: ApiMethod, path: string, body?: unknown): Promise<T> {
  const response = await apiTransport().request(method, path, body);
  if (response.status >= 200 && response.status < 300) return response.body as T;

  const payload = isRecord(response.body) ? response.body : null;
  const disk = payload?.['disk'] as ArtifactFile | undefined;
  const filePath = payload?.['path'];
  if (response.status === 409 && disk !== undefined && typeof filePath === 'string') {
    throw new StaleWriteConflict(filePath, disk, typeof payload?.['error'] === 'string' ? payload['error'] : '');
  }
  const details = payload?.['details'];
  const output = payload?.['output'];
  if (isUnknownRoute(response.status, payload)) {
    throw new ApiError(unknownRouteMessage(path), [], '', payload ?? {});
  }
  throw new ApiError(
    typeof payload?.['error'] === 'string' ? payload['error'] : `Запрос ${path} завершился с кодом ${response.status}`,
    Array.isArray(details) ? details.filter((item): item is string => typeof item === 'string') : [],
    typeof output === 'string' ? output : '',
    payload ?? {},
  );
}

/**
 * Бэкенд не знает маршрута — это стандартный 404 Fastify, а не отказ самого
 * маршрута (у тех всегда своё пояснение).
 *
 * На практике так бывает в VS Code, когда .vsix той же версии поставлен
 * поверх прежнего: панель загружает новый интерфейс с диска, а хост
 * расширений до перезагрузки окна держит в памяти старый бэкенд.
 */
function isUnknownRoute(status: number, payload: Record<string, unknown> | null): boolean {
  return (
    status === 404 &&
    payload?.['error'] === 'Not Found' &&
    typeof payload['message'] === 'string' &&
    payload['message'].startsWith('Route ')
  );
}

function unknownRouteMessage(path: string): string {
  const route = path.split('?')[0] ?? path;
  return (
    `Бэкенд не знает маршрута ${route}: интерфейс новее запущенного бэкенда. ` +
    'Если расширение только что обновлено, перезагрузите окно VS Code ' +
    '(команда «Developer: Reload Window»).'
  );
}

function get<T>(path: string): Promise<T> {
  return call<T>('GET', path);
}

/** Состояние бэкенда: по ревизии API видно, не старше ли он интерфейса. */
export function fetchHealth(): Promise<{ status: 'ok'; apiRevision?: number }> {
  return get<{ status: 'ok'; apiRevision?: number }>('/api/health');
}

export function fetchWorkspace(): Promise<WorkspaceResponse> {
  return get<WorkspaceResponse>('/api/workspace');
}

export function fetchSearch(query: string, kinds: readonly string[]): Promise<{ hits: SearchHit[] }> {
  const params = new URLSearchParams({ q: query });
  if (kinds.length > 0) params.set('kinds', kinds.join(','));
  return get<{ hits: SearchHit[] }>(`/api/search?${params.toString()}`);
}

/** Адрес потока событий с токеном в строке запроса. */
export function eventsUrl(): string {
  return `/api/events?token=${encodeURIComponent(sessionToken())}`;
}

/** Файл артефакта с версией содержимого. */
export interface ArtifactFile {
  readonly path: string;
  readonly content: string;
  readonly version: string;
}

/** Расхождение версии редактора и версии на диске. */
export class StaleWriteConflict extends Error {
  constructor(
    readonly path: string,
    readonly disk: ArtifactFile,
    message: string,
  ) {
    super(message);
    this.name = 'StaleWriteConflict';
  }
}

function send<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown): Promise<T> {
  return call<T>(method, path, body);
}

/** Отказ сервера с пояснениями — например, перечнем нарушений схемы. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly details: readonly string[],
    /** Вывод CLI, приложенный к отказу. */
    readonly output: string = '',
    /** Тело ответа целиком — для полей, специфичных для отказа. */
    readonly payload: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function fetchFile(path: string): Promise<ArtifactFile> {
  return get<ArtifactFile>(`/api/file?path=${encodeURIComponent(path)}`);
}

export function saveFile(
  path: string,
  content: string,
  baseVersion: string | null,
): Promise<ArtifactFile> {
  return send<ArtifactFile>('/api/file', 'PUT', { path, content, baseVersion });
}

export function createArtifactFile(
  change: string,
  artifact: string,
  capabilityPath?: string,
): Promise<{ path: string; content: string }> {
  return send<{ path: string; content: string }>('/api/artifact', 'POST', {
    change,
    artifact,
    capabilityPath,
  });
}

/** Результат прогона валидации, как его отдаёт сервер. */
export interface ValidationRunResponse {
  readonly change: string;
  readonly entries: readonly {
    readonly level: 'ERROR' | 'WARNING' | 'INFO';
    readonly message: string;
    readonly file: string | null;
    readonly line: number | null;
  }[];
  readonly valid: boolean;
  readonly superseded: boolean;
  readonly error: string | null;
}

export function fetchValidation(change: string): Promise<ValidationRunResponse> {
  return get<ValidationRunResponse>(`/api/validate?change=${encodeURIComponent(change)}`);
}

/** Заготовки для вставки в артефакт. */
export function fetchSnippets(): Promise<Record<string, string>> {
  return get<Record<string, string>>('/api/snippets');
}

/** Дельты change, как их отдаёт сервер. */
export interface ChangeDeltasResponse {
  readonly change: string;
  readonly views: readonly DeltaView[];
}

export function fetchDeltas(change: string): Promise<ChangeDeltasResponse> {
  return get<ChangeDeltasResponse>(`/api/deltas?change=${encodeURIComponent(change)}`);
}

export function fetchComparison(
  change: string,
  capability: string,
  requirement: string,
): Promise<{ comparison: RequirementComparison | null }> {
  const params = new URLSearchParams({ change, capability, requirement });
  return get<{ comparison: RequirementComparison | null }>(
    `/api/compare?${params.toString()}`,
  );
}

export function fetchCapabilityMap(): Promise<CapabilityMap> {
  return get<CapabilityMap>('/api/capability-map');
}

/** Структурный вид основного спека. */
export interface SpecResponse {
  readonly spec: {
    readonly capability: string;
    readonly purpose: string | null;
    readonly purposeIsPlaceholder: boolean;
    readonly requirements: readonly {
      readonly name: string;
      readonly line: number;
      readonly description: string;
      readonly scenarios: readonly { readonly name: string; readonly line: number }[];
    }[];
    readonly scenarioCount: number;
  } | null;
}

export function fetchSpec(capability: string): Promise<SpecResponse> {
  return get<SpecResponse>(`/api/spec?capability=${encodeURIComponent(capability)}`);
}

export function fetchBoard(): Promise<Board> {
  return get<Board>('/api/board');
}

/** Пересечения, устаревшие дельты и забытые changes. */
export function fetchDrift(): Promise<DriftReport> {
  return get<DriftReport>('/api/drift');
}

export function createChange(name: string, schema?: string): Promise<{ created: string }> {
  return send<{ created: string }>('/api/change', 'POST', { name, schema });
}

export function archiveChange(name: string): Promise<{ archived: string }> {
  return send<{ archived: string }>('/api/archive', 'POST', { name });
}

/** Итог проверки структуры папок, как его отдаёт сервер. */
export interface StructureReport {
  readonly configured: boolean;
  readonly path: string;
  readonly errors: readonly StructureSpecError[];
  readonly issues: readonly StructureIssue[];
  readonly tree: readonly StructureNode[];
  readonly ok: boolean;
}

export function fetchStructure(): Promise<StructureReport> {
  return get<StructureReport>('/api/structure');
}

/** Карта контекста: модули, домены, ADR и связи между ними. */
export function fetchContextMap(): Promise<ContextMap> {
  return get<ContextMap>('/api/context-map');
}

/** Сводка раздела «Качество»: правила, файлы, замечания, исключения, пороги. */
export function fetchQuality(): Promise<QualityOverview> {
  return get<QualityOverview>('/api/quality');
}

/** Создаёт `openspec/quality.yaml` из заготовки. */
export function initQuality(): Promise<QualityOverview> {
  return send<QualityOverview>('/api/quality/init', 'POST', {});
}

/** Задаёт уровень правила в quality.yaml; `null` — вернуть уровень по умолчанию. */
export function setQualityRule(rule: QualityRule, level: QualityLevel | 'off' | null): Promise<QualityOverview> {
  return send<QualityOverview>('/api/quality/rule', 'POST', { rule, level });
}

/** Новое исключение: правило (или все) в файле или шаблоне пути и, если задано, в требовании. */
export interface QualityExclusionInput {
  readonly rule: QualityRule | null;
  readonly path: string | null;
  readonly requirement: string | null;
  readonly reason: string | null;
}

export function addQualityExclusion(exclusion: QualityExclusionInput): Promise<QualityOverview> {
  return send<QualityOverview>('/api/quality/exclusions', 'POST', exclusion);
}

export function removeQualityExclusion(index: number): Promise<QualityOverview> {
  return send<QualityOverview>(`/api/quality/exclusions?index=${index}`, 'DELETE', undefined);
}

/** Создаёт `openspec/structure.yaml` по текущей раскладке `openspec/`. */
export function initStructure(): Promise<StructureReport> {
  return send<StructureReport>('/api/structure/init', 'POST', {});
}

/** Основной спек, который архивация создаст или изменит. */
export interface SpecPreview extends SpecChange {
  readonly capability: string;
  readonly path: string;
  readonly before: string | null;
  readonly after: string;
}

/** Исход предпросмотра архивации. */
export type ArchiveOutcome = 'ready' | 'validation-failed' | 'refused';

/** Предпросмотр архивации change, как его отдаёт сервер. */
export interface ArchivePreviewResponse {
  readonly change: string;
  readonly outcome: ArchiveOutcome;
  readonly problems: readonly {
    readonly code: string | null;
    readonly message: string;
    readonly fix: string | null;
  }[];
  readonly output: string;
  readonly warnings: readonly string[];
  readonly totals: {
    readonly added: number;
    readonly modified: number;
    readonly removed: number;
    readonly renamed: number;
  } | null;
  readonly specs: readonly SpecPreview[];
}

/** Строит предпросмотр архивации: прогон CLI на временной копии проекта. */
export function fetchArchivePreview(change: string): Promise<ArchivePreviewResponse> {
  return get<ArchivePreviewResponse>(`/api/archive/preview?change=${encodeURIComponent(change)}`);
}

/** Пункты отслеживаемого артефакта change. */
export interface TrackedItemsResponse {
  readonly change: string;
  readonly path: string | null;
  readonly items: readonly {
    readonly line: number;
    readonly text: string;
    readonly declaredNumber: string | null;
    readonly group: number;
    readonly done: boolean;
  }[];
  readonly groups: readonly { readonly number: number; readonly title: string }[];
  readonly complete: number;
  readonly total: number;
}

export function fetchItems(change: string): Promise<TrackedItemsResponse> {
  return get<TrackedItemsResponse>(`/api/items?change=${encodeURIComponent(change)}`);
}

export function toggleItem(
  change: string,
  line: number,
  done: boolean,
): Promise<TrackedItemsResponse> {
  return send<TrackedItemsResponse>('/api/items', 'PUT', { change, line, done });
}

/** Метрики change, как их отдаёт сервер. */
export type MetricsResponse =
  | {
      readonly change: string;
      readonly tracked: true;
      readonly trackedPath: string;
      readonly summary: ChangeSummary;
      readonly items: readonly ItemMetrics[];
      readonly removed: readonly ItemMetrics[];
      readonly recovered: boolean;
    }
  | { readonly change: string; readonly tracked: false; readonly reason: string };

export function fetchMetrics(change: string): Promise<MetricsResponse> {
  return get<MetricsResponse>(`/api/metrics?change=${encodeURIComponent(change)}`);
}

export function startItem(change: string, key: string): Promise<MetricsResponse> {
  return send<MetricsResponse>('/api/metrics/start', 'POST', { change, key });
}

export function bindAcceptance(
  change: string,
  key: string,
  command: string,
): Promise<MetricsResponse> {
  return send<MetricsResponse>('/api/metrics/acceptance', 'PUT', { change, key, command });
}

export function runAcceptance(
  change: string,
  key: string,
): Promise<{
  result: { exitCode: number; durationMs: number; output: string; timedOut: boolean };
  view: MetricsResponse;
}> {
  return send('/api/metrics/acceptance/run', 'POST', { change, key });
}

export function fetchMetricsExport(change?: string): Promise<MetricsExport> {
  return get<MetricsExport>(
    change === undefined ? '/api/metrics/export' : `/api/metrics/export?change=${encodeURIComponent(change)}`,
  );
}

/** Схема в реестре. */
export interface RegistryEntry {
  readonly name: string;
  readonly description: string | null;
  readonly source: 'package' | 'project';
  readonly path: string;
  readonly shadows: readonly { readonly source: string; readonly path: string }[];
  readonly isDefault: boolean;
  readonly readable: boolean;
  readonly parseError: string | null;
  readonly cliError: string | null;
  readonly artifacts: readonly string[];
  readonly conformance: {
    readonly errors: number;
    readonly warnings: number;
    readonly assignable: boolean;
    readonly waived: readonly string[];
  } | null;
}

/** Схема, открытая в конструкторе. */
export interface SchemaSource {
  readonly name: string;
  readonly source: 'package' | 'project';
  readonly readOnly: boolean;
  readonly path: string;
  readonly text: string;
  readonly document: SchemaDocument | null;
  readonly yamlError: { message: string; line: number | null; column: number | null } | null;
  readonly templates: readonly {
    readonly artifact: string;
    readonly template: string | null;
    readonly exists: boolean;
  }[];
}

/** Двухслойная проверка схемы. */
export interface SchemaCheck {
  readonly name: string;
  readonly structural: {
    readonly valid: boolean;
    readonly issues: readonly { readonly level: string; readonly message: string; readonly artifact?: string }[];
  };
  readonly sdd: ConformanceReport;
  readonly assignable: boolean;
}

export function fetchSchemas(): Promise<{ schemas: RegistryEntry[]; default: string | null }> {
  return get('/api/schemas');
}

export function fetchSchema(name: string): Promise<SchemaSource> {
  return get(`/api/schema?name=${encodeURIComponent(name)}`);
}

export function saveSchema(name: string, text: string): Promise<SchemaSource> {
  return send('/api/schema', 'PUT', { name, text });
}

export function createSchema(name: string, from: string | null): Promise<SchemaSource> {
  return send('/api/schema', 'POST', { name, from });
}

export function checkSchema(name: string): Promise<SchemaCheck> {
  return get(`/api/schema/check?name=${encodeURIComponent(name)}`);
}

export function assignSchema(
  name: string,
): Promise<{ previous: string | null; activeChanges: number; pinned: string[]; warnings: string[] }> {
  return send('/api/schema/assign', 'POST', { name });
}

export function fetchSchemaTemplate(
  name: string,
  template: string,
): Promise<{ template: string; content: string | null; exists: boolean }> {
  const params = new URLSearchParams({ name, template });
  return get(`/api/schema/template?${params.toString()}`);
}

export function saveSchemaTemplate(name: string, template: string, content: string): Promise<unknown> {
  return send('/api/schema/template', 'PUT', { name, template, content });
}


/** Приёмка и файлы пункта плана — из метрик. */
export interface TraceItemMetrics {
  readonly passed: boolean | null;
  readonly command: string | null;
  readonly criterion: string | null;
  readonly files: readonly string[];
}

/** Трассировка change: сценарии дельт, пункты плана и связи между ними. */
export interface TraceResponse {
  readonly change: string;
  readonly planPath: string | null;
  readonly trace: Trace;
  readonly metrics: Readonly<Record<string, TraceItemMetrics>>;
}

export function fetchTrace(change: string): Promise<TraceResponse> {
  return get<TraceResponse>(`/api/trace?change=${encodeURIComponent(change)}`);
}

/** Дописывает в план пункт со ссылкой на непокрытый сценарий. */
export function addTraceItem(
  change: string,
  target: { capability: string; requirement: string; scenario: string },
): Promise<TraceResponse> {
  return send<TraceResponse>('/api/trace/item', 'POST', { change, ...target });
}

/** Заводит папку модуля контекста с `index.md` и `context.md`. */
export function createContextModule(id: string): Promise<{ index: string; context: string }> {
  return send<{ index: string; context: string }>('/api/context/module', 'POST', { id });
}
