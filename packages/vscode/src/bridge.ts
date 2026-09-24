import { type HostMessage, parseViewMessage } from '@openspec-ide/core';
import { type EmbeddedBackend, OutsideWorkspaceError, resolveInsideWorkspace } from '@openspec-ide/server';

/** Что нужно мосту между панелью и бэкендом. */
export interface BridgeDeps {
  readonly backend: Pick<EmbeddedBackend, 'request'>;
  /** Отправляет сообщение в панель. */
  readonly post: (message: HostMessage) => unknown;
  /** Открывает файл рабочего пространства в редакторе. */
  readonly openFile: (path: string, line: number | null) => Promise<void>;
  /** Панель загрузилась и готова принимать навигацию. */
  readonly onReady: () => void;
  /** Сообщение о сбое, который панель показать не может. */
  readonly warn: (message: string) => void;
}

/**
 * Обрабатывает одно сообщение панели.
 *
 * Запрос, не прошедший разбор, всё равно получает ответ с отказом, если у
 * него есть номер, — иначе вызов в панели ждал бы вечно.
 */
export async function handleViewMessage(raw: unknown, deps: BridgeDeps): Promise<void> {
  const parsed = parseViewMessage(raw);
  if (!parsed.ok) {
    const id = requestId(raw);
    if (id !== null) {
      await deps.post({ kind: 'response', id, status: 400, body: { error: parsed.reason } });
    } else {
      deps.warn(`Панель OpenSpec прислала некорректное сообщение: ${parsed.reason}`);
    }
    return;
  }

  const message = parsed.message;
  switch (message.kind) {
    case 'ready':
      deps.onReady();
      return;

    case 'open-file':
      await deps.openFile(message.path, message.line);
      return;

    case 'request': {
      let status: number;
      let body: unknown;
      try {
        ({ status, body } = await deps.backend.request(message.method, message.path, message.body));
      } catch (error) {
        status = 500;
        body = { error: error instanceof Error ? error.message : String(error) };
      }
      await deps.post({ kind: 'response', id: message.id, status, body });
      return;
    }
  }
}

function requestId(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { kind, id } = raw as { kind?: unknown; id?: unknown };
  return kind === 'request' && typeof id === 'number' && Number.isInteger(id) ? id : null;
}

/**
 * Абсолютный путь файла, который панели разрешено открыть, или `null`.
 *
 * Та же канонизация, что защищает файловые маршруты бэкенда: переходы `..` и
 * символические ссылки наружу отклоняются.
 */
export function resolvePanelPath(root: string | null, path: string): string | null {
  if (root === null) return null;
  try {
    return resolveInsideWorkspace(root, path);
  } catch (error) {
    if (error instanceof OutsideWorkspaceError) return null;
    throw error;
  }
}
