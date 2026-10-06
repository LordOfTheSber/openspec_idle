/**
 * Кэш расчётов по тексту файла: результат зависит только от текста (и
 * параметров, вошедших в вид расчёта), поэтому при том же тексте его можно
 * отдать повторно. Функции, которые им пользуются, остаются чистыми — кэш
 * снаружи не виден, — а повторная сборка карты контекста не анализирует
 * заново тексты, которые не менялись.
 *
 * Ключ — сам текст: в браузере, где тоже работает `core`, нет `node:crypto`, а
 * сравнение строк в `Map` линейно по длине, как и хеш, и несравнимо дешевле
 * регулярных выражений анализа. Результаты отдаются как есть — вызывающий код
 * их не меняет (типы `readonly`).
 */
export class TextCache {
  readonly #entries = new Map<string, Map<string, unknown>>();
  #chars = 0;

  /**
   * @param minChars тексты короче не запоминаются: их дешевле посчитать заново
   * @param maxChars предел суммарной длины запомненных текстов, символов
   * @param maxEntries предел числа запомненных текстов
   */
  constructor(
    readonly minChars: number,
    readonly maxChars: number,
    readonly maxEntries: number,
  ) {}

  /** Результат расчёта `kind` для текста: из кэша или посчитанный `compute`. */
  get<T>(text: string, kind: string, compute: () => T): T {
    if (text.length < this.minChars) return compute();
    let results = this.#entries.get(text);
    if (results === undefined) {
      results = new Map();
      this.#entries.set(text, results);
      this.#chars += text.length;
      this.#evict(text);
    } else {
      // Порядок `Map` — порядок вставки: недавно нужный текст уходит в конец.
      this.#entries.delete(text);
      this.#entries.set(text, results);
    }
    if (results.has(kind)) return results.get(kind) as T;
    const value = compute();
    results.set(kind, value);
    return value;
  }

  /** Сколько текстов и символов запомнено. */
  get size(): { readonly entries: number; readonly chars: number } {
    return { entries: this.#entries.size, chars: this.#chars };
  }

  clear(): void {
    this.#entries.clear();
    this.#chars = 0;
  }

  /** Вытесняет давно не нужные тексты, кроме только что добавленного. */
  #evict(keep: string): void {
    for (const text of this.#entries.keys()) {
      if (this.#chars <= this.maxChars && this.#entries.size <= this.maxEntries) return;
      if (text === keep) continue;
      this.#entries.delete(text);
      this.#chars -= text.length;
    }
  }
}

/** Общий кэш анализа текстов контекста. */
export const textCache = new TextCache(2048, 32 * 1024 * 1024, 4096);
