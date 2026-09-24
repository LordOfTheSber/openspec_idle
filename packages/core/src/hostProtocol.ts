/**
 * Протокол сообщений между панелью разделов (webview) и расширением VS Code.
 *
 * Панель не видит ни сети, ни процесса расширения: всё общение идёт
 * сообщениями `postMessage`. Обе стороны разбирают входящие сообщения этими
 * функциями и не доверяют тому, что не прошло разбор, — сообщение в webview
 * можно отправить и из разметки, попавшей в панель.
 */

/** Разделы, которые открываются в панели. */
export const PANEL_SECTIONS = [
  'board',
  'deltas',
  'metrics',
  'agent',
  'processes',
  'settings',
  'search',
] as const;

export type PanelSection = (typeof PANEL_SECTIONS)[number];

/** Методы API, доступные панели. */
export const API_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

export type ApiMethod = (typeof API_METHODS)[number];

/** Выбранный в панели объект — то же, что выбор в дереве интерфейса. */
export interface PanelSelection {
  readonly kind: 'change' | 'artifact' | 'capability' | 'schema' | 'archived';
  readonly id: string;
  readonly parent?: string;
}

/** Событие бэкенда, пересылаемое в панель. */
export interface HostEvent {
  readonly type: string;
  readonly payload: unknown;
}

/** Сообщения панели расширению. */
export type ViewMessage =
  | {
      readonly kind: 'request';
      readonly id: number;
      readonly method: ApiMethod;
      readonly path: string;
      readonly body?: unknown;
    }
  | { readonly kind: 'open-file'; readonly path: string; readonly line: number | null }
  /**
   * Открыть предпросмотр архивации в редакторе сравнения VS Code. Панель
   * передаёт только имена: текст спека после архивации расширение получает от
   * бэкенда само, чтобы панель не могла подсунуть в редактор произвольный текст.
   */
  | { readonly kind: 'preview-archive'; readonly change: string; readonly capability: string | null }
  | { readonly kind: 'ready' };

/** Сообщения расширения панели. */
export type HostMessage =
  | { readonly kind: 'response'; readonly id: number; readonly status: number; readonly body: unknown }
  | { readonly kind: 'event'; readonly event: HostEvent }
  | {
      readonly kind: 'navigate';
      readonly section: PanelSection;
      readonly selection: PanelSelection | null;
      /** Запуск агента по артефакту, который нужно сразу подготовить. */
      readonly agent?: AgentIntent;
    };

/** Генерация артефакта агентом: какой артефакт и с каким замыслом. */
export interface AgentIntent {
  readonly artifact: string;
  readonly brief: string | null;
}

/** Предел длины замысла в сообщении — тот же, что у сборщика промпта. */
export const MAX_INTENT_BRIEF = 4000;

/** Итог разбора входящего сообщения. */
export type Parsed<T> = { readonly ok: true; readonly message: T } | { readonly ok: false; readonly reason: string };

/**
 * Путь, который панели разрешено запрашивать.
 *
 * Только маршруты `/api/`, без переходов `..`, без обратных косых и без
 * потока событий: поток в панель идёт сообщениями, а запрос к нему никогда не
 * завершится.
 */
export function isPanelApiPath(path: string): boolean {
  if (!path.startsWith('/api/')) return false;
  if (path.includes('\\')) return false;
  const pathname = path.split('?')[0] ?? '';
  if (pathname.split('/').some((segment) => segment === '..' || segment === '.')) return false;
  if (pathname === '/api/events' || pathname.startsWith('/api/events/')) return false;
  return true;
}

const SELECTION_KINDS: readonly PanelSelection['kind'][] = [
  'change',
  'artifact',
  'capability',
  'schema',
  'archived',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSelection(value: unknown): PanelSelection | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { kind, id, parent } = value;
  if (typeof kind !== 'string' || !(SELECTION_KINDS as readonly string[]).includes(kind)) return undefined;
  if (typeof id !== 'string' || id === '') return undefined;
  if (parent !== undefined && typeof parent !== 'string') return undefined;
  return parent === undefined
    ? { kind: kind as PanelSelection['kind'], id }
    : { kind: kind as PanelSelection['kind'], id, parent };
}

/** Разбирает сообщение, пришедшее от панели. */
export function parseViewMessage(value: unknown): Parsed<ViewMessage> {
  if (!isRecord(value)) return { ok: false, reason: 'Сообщение не является объектом' };

  switch (value['kind']) {
    case 'ready':
      return { ok: true, message: { kind: 'ready' } };

    case 'request': {
      const { id, method, path, body } = value;
      if (typeof id !== 'number' || !Number.isInteger(id)) {
        return { ok: false, reason: 'У запроса нет целочисленного идентификатора' };
      }
      if (typeof method !== 'string' || !(API_METHODS as readonly string[]).includes(method)) {
        return { ok: false, reason: `Недопустимый метод запроса «${String(method)}»` };
      }
      if (typeof path !== 'string' || !isPanelApiPath(path)) {
        return { ok: false, reason: `Путь «${String(path)}» недоступен панели` };
      }
      return {
        ok: true,
        message:
          body === undefined
            ? { kind: 'request', id, method: method as ApiMethod, path }
            : { kind: 'request', id, method: method as ApiMethod, path, body },
      };
    }

    case 'open-file': {
      const { path, line } = value;
      if (typeof path !== 'string' || path === '') {
        return { ok: false, reason: 'Не указан путь файла' };
      }
      if (line !== null && line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
        return { ok: false, reason: 'Номер строки должен быть положительным целым' };
      }
      return { ok: true, message: { kind: 'open-file', path, line: typeof line === 'number' ? line : null } };
    }

    case 'preview-archive': {
      const { change, capability } = value;
      if (typeof change !== 'string' || !isSafeName(change)) {
        return { ok: false, reason: 'Некорректное имя change' };
      }
      if (capability !== null && capability !== undefined && (typeof capability !== 'string' || !isSafeCapability(capability))) {
        return { ok: false, reason: 'Некорректный путь capability' };
      }
      return {
        ok: true,
        message: { kind: 'preview-archive', change, capability: typeof capability === 'string' ? capability : null },
      };
    }

    default:
      return { ok: false, reason: `Неизвестный вид сообщения «${String(value['kind'])}»` };
  }
}

/** Цель агента в навигации: `null` — её нет, `undefined` — она некорректна. */
function parseAgentIntent(value: unknown): AgentIntent | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  const { artifact, brief } = value;
  if (typeof artifact !== 'string' || !isSafeName(artifact)) return undefined;
  if (brief !== null && brief !== undefined && (typeof brief !== 'string' || brief.length > MAX_INTENT_BRIEF)) {
    return undefined;
  }
  return { artifact, brief: typeof brief === 'string' && brief.trim() !== '' ? brief : null };
}

/** Имя change: один сегмент пути без переходов наверх. */
function isSafeName(name: string): boolean {
  return name !== '' && !/[\\/]/.test(name) && !name.startsWith('.');
}

/** Путь capability: сегменты через `/`, без пустых, `.` и `..`. */
function isSafeCapability(path: string): boolean {
  if (path === '' || path.includes('\\')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Разбирает сообщение, пришедшее от расширения. */
export function parseHostMessage(value: unknown): Parsed<HostMessage> {
  if (!isRecord(value)) return { ok: false, reason: 'Сообщение не является объектом' };

  switch (value['kind']) {
    case 'response': {
      const { id, status, body } = value;
      if (typeof id !== 'number' || typeof status !== 'number') {
        return { ok: false, reason: 'У ответа нет идентификатора или кода' };
      }
      return { ok: true, message: { kind: 'response', id, status, body } };
    }

    case 'event': {
      const event = value['event'];
      if (!isRecord(event) || typeof event['type'] !== 'string') {
        return { ok: false, reason: 'У события нет типа' };
      }
      return { ok: true, message: { kind: 'event', event: { type: event['type'], payload: event['payload'] ?? null } } };
    }

    case 'navigate': {
      const { section } = value;
      if (typeof section !== 'string' || !(PANEL_SECTIONS as readonly string[]).includes(section)) {
        return { ok: false, reason: `Неизвестный раздел «${String(section)}»` };
      }
      const selection = parseSelection(value['selection'] ?? null);
      if (selection === undefined) return { ok: false, reason: 'Некорректный выбор' };
      const agent = parseAgentIntent(value['agent']);
      if (agent === undefined) return { ok: false, reason: 'Некорректная цель агента' };
      return {
        ok: true,
        message:
          agent === null
            ? { kind: 'navigate', section: section as PanelSection, selection }
            : { kind: 'navigate', section: section as PanelSection, selection, agent },
      };
    }

    default:
      return { ok: false, reason: `Неизвестный вид сообщения «${String(value['kind'])}»` };
  }
}
