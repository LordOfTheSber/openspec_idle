import type { SearchHit, WorkspaceTree } from '@openspec-ide/core';

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
