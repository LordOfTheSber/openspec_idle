/** Имя каталога, по которому опознаётся корень OpenSpec. */
export const OPENSPEC_DIR = 'openspec';

/**
 * Ревизия API бэкенда, которую ожидает интерфейс. Растёт, когда интерфейсу
 * нужны маршруты или поля, которых не было раньше.
 *
 * В VS Code панель загружает интерфейс с диска при каждом открытии, а бэкенд
 * живёт в хосте расширений до перезагрузки окна. После установки новой сборки
 * они расходятся, и сверка ревизии позволяет сказать об этом прямо, а не
 * показывать «Not Found» в отдельных разделах.
 */
export const API_REVISION = 3;

/** Бэкенд старше интерфейса: не сообщает ревизию API или сообщает меньшую. */
export function isStaleBackend(health: unknown): boolean {
  if (typeof health !== 'object' || health === null) return false;
  const revision = (health as { apiRevision?: unknown }).apiRevision;
  return typeof revision !== 'number' || revision < API_REVISION;
}
