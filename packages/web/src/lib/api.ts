import type {
  AgentEvent,
  Board,
  RunOutcome,
  ConformanceReport,
  SchemaDocument,
  CapabilityMap,
  ChangeSummary,
  ItemMetrics,
  MetricsExport,
  DeltaView,
  RequirementComparison,
  SearchHit,
  WorkspaceTree,
} from '@openspec-ide/core';

/** Состояние рабочего пространства, отданное сервером. */
export type WorkspaceResponse =
  | { readonly state: 'not-initialized'; readonly hint: string; readonly message: string }
  | {
      readonly state: 'cli-missing';
      readonly notice: {
        readonly title: string;
        readonly tool: string;
        readonly install: string;
        readonly searched: readonly string[];
      };
    }
  | {
      readonly state: 'ready';
      readonly root: string;
      readonly tree: WorkspaceTree;
      readonly errors: readonly string[];
    };

const TOKEN_META = 'openspec-ide-token';

/** Токен сессии, встроенный сервером в отданную страницу. */
export function sessionToken(): string {
  const meta = document.querySelector(`meta[name="${TOKEN_META}"]`);
  return meta?.getAttribute('content') ?? '';
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { 'x-openspec-ide-token': sessionToken() },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | ({ error?: string; details?: string[]; output?: string } & Record<string, unknown>)
      | null;
    throw new ApiError(
      payload?.error ?? `Запрос ${path} завершился с кодом ${response.status}`,
      payload?.details ?? [],
      payload?.output ?? '',
      payload ?? {},
    );
  }
  return (await response.json()) as T;
}

/** Какой CLI OpenSpec работает на сервере. */
export interface CliInfo {
  readonly source: 'project' | 'path' | 'bundled';
  readonly bin: string;
  readonly version: string | null;
}

export function fetchHealth(): Promise<{ readonly cli: CliInfo | null }> {
  return get<{ cli: CliInfo | null }>('/api/health');
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

async function send<T>(path: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'x-openspec-ide-token': sessionToken(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | ({ error?: string; details?: string[]; output?: string; path?: string; disk?: ArtifactFile } & Record<
          string,
          unknown
        >)
      | null;
    // 409 с версией с диска — конфликт записи файла; прочие 409 (например,
    // занятый запуском change) — обычный отказ с пояснением.
    if (response.status === 409 && payload?.disk !== undefined && payload.path !== undefined) {
      throw new StaleWriteConflict(payload.path, payload.disk, payload.error ?? '');
    }
    throw new ApiError(
      payload?.error ?? `Запрос ${path} завершился с кодом ${response.status}`,
      payload?.details ?? [],
      payload?.output ?? '',
      payload ?? {},
    );
  }
  return (await response.json()) as T;
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

export function createChange(name: string, schema?: string): Promise<{ created: string }> {
  return send<{ created: string }>('/api/change', 'POST', { name, schema });
}

export function archiveChange(name: string): Promise<{ archived: string }> {
  return send<{ archived: string }>('/api/archive', 'POST', { name });
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

/** Настройки агента, как они хранятся в конфигурации. */
export interface AgentSettings {
  command: string;
  model: string | null;
  approvalMode: ApprovalMode;
  maxWallTime: string;
  maxToolCalls: number;
  credentialsEnv: string | null;
  secretEnvs: string[];
  extraArgs: string[];
  launch: Record<string, unknown>;
}

export type ApprovalMode = 'plan' | 'default' | 'auto-edit' | 'auto' | 'yolo';

export interface IdeConfigResponse {
  readonly config: { version: 1; agent: AgentSettings } & Record<string, unknown>;
  readonly unknownFields: readonly string[];
  readonly usedDefaults: boolean;
  readonly parseError: string | null;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly bin: string | null;
  readonly searched: readonly string[];
  readonly version: string | null;
  readonly format: string | null;
  readonly streaming: boolean;
  readonly notice: string | null;
  readonly error: string | null;
  readonly checkedAt: string;
}

export interface EffectiveLaunch {
  readonly approvalMode: string;
  readonly maxWallTime: string;
  readonly maxToolCalls: number;
  readonly model: string | null;
  readonly command: string;
  readonly format: string | null;
  readonly streaming: boolean;
  readonly notice: string | null;
}

export interface AgentStatus {
  readonly config: AgentSettings;
  readonly configError: string | null;
  readonly credentials: { readonly env: string | null; readonly set: boolean };
  readonly probe: ProbeResult | null;
  readonly blockers: readonly string[];
  readonly effective: EffectiveLaunch;
}

export type RunTarget = { readonly kind: 'artifact'; readonly artifact: string } | { readonly kind: 'item'; readonly key: string };

export interface AgentRunRecord {
  readonly runId: string;
  readonly change: string;
  readonly target: RunTarget;
  readonly label: string;
  readonly prompt: string;
  readonly approvalMode: string;
  readonly model: string | null;
  readonly format: string;
  readonly streaming: boolean;
  readonly command: string;
  readonly limits: { readonly maxWallTime: string; readonly maxToolCalls: number };
  readonly startedAt: string;
  readonly state: 'running' | 'finished';
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly outcome: RunOutcome | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly toolCalls: number;
  readonly files: readonly string[];
  readonly finalText: string | null;
  readonly error: string | null;
  readonly stderr: string;
  readonly sessionId: string | null;
  readonly unknownEvents: number;
}

export interface AgentTargets {
  readonly change: string;
  readonly schema: string | null;
  readonly artifacts: readonly { readonly id: string; readonly available: boolean; readonly reason: string | null }[];
  readonly items: readonly { readonly key: string; readonly text: string; readonly done: boolean }[];
  readonly running: AgentRunRecord | null;
}

export interface StoredAgentEvent {
  readonly at: string;
  readonly event: AgentEvent;
}

/** Событие запуска, пришедшее по потоку. */
export interface AgentStreamEvent {
  readonly runId: string;
  readonly change: string;
  readonly at: string;
  readonly event: AgentEvent;
  readonly tally: { readonly toolCalls: number; readonly tokensIn: number | null; readonly tokensOut: number | null };
}

export function fetchConfig(): Promise<IdeConfigResponse> {
  return get('/api/config');
}

export function saveConfig(config: IdeConfigResponse['config']): Promise<{ config: IdeConfigResponse['config'] }> {
  return send('/api/config', 'PUT', config);
}

export function fetchAgentStatus(): Promise<AgentStatus> {
  return get('/api/agent/status');
}

export function probeAgent(): Promise<AgentStatus> {
  return send('/api/agent/probe', 'POST', {});
}

export function fetchAgentTargets(change: string): Promise<AgentTargets> {
  return get(`/api/agent/targets?change=${encodeURIComponent(change)}`);
}

export function buildAgentPrompt(
  change: string,
  target: RunTarget,
): Promise<{ change: string; target: RunTarget; label: string; prompt: string; effective: EffectiveLaunch }> {
  return send('/api/agent/prompt', 'POST', { change, target });
}

export function startAgentRun(request: {
  change: string;
  target: RunTarget;
  prompt: string;
  approvalMode: ApprovalMode;
  confirmYolo: boolean;
}): Promise<AgentRunRecord> {
  return send('/api/agent/run', 'POST', request);
}

export function stopAgentRun(runId: string): Promise<{ stopped: boolean }> {
  return send('/api/agent/stop', 'POST', { runId });
}

export function fetchAgentRuns(change: string): Promise<{ runs: AgentRunRecord[] }> {
  return get(`/api/agent/runs?change=${encodeURIComponent(change)}`);
}

export function fetchAgentRun(runId: string): Promise<{ record: AgentRunRecord; events: StoredAgentEvent[] }> {
  return get(`/api/agent/run?id=${encodeURIComponent(runId)}`);
}
