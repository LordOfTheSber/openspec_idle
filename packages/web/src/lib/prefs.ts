/**
 * Настройки вида, которые помнит конкретный пользователь в конкретном окне:
 * режим доски, показ пустых колонок.
 *
 * Хранилище может быть недоступно (приватное окно, запрет сайта, webview без
 * хранилища), поэтому каждое обращение защищено, а при сбое действует
 * значение по умолчанию.
 */
export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = globalThis.localStorage?.getItem(`openspec-ide:${key}`);
    return value !== null && value !== undefined && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(`openspec-ide:${key}`, value);
  } catch {
    // Без хранилища настройка просто не переживёт перезагрузку.
  }
}

/** Список строк, который помнит окно, например набор выбранных узлов. */
export function readListPref(key: string): string[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(`openspec-ide:${key}`) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function writeListPref(key: string, values: readonly string[]): void {
  writePref(key, JSON.stringify(values));
}
