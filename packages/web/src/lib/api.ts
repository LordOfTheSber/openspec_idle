import type {
  CapabilityMap,
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
    throw new Error(`Запрос ${path} завершился с кодом ${response.status}`);
  }
  return (await response.json()) as T;
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

  if (response.status === 409) {
    const payload = (await response.json()) as { error: string; path: string; disk: ArtifactFile };
    throw new StaleWriteConflict(payload.path, payload.disk, payload.error);
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Запрос ${path} завершился с кодом ${response.status}`);
  }
  return (await response.json()) as T;
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
