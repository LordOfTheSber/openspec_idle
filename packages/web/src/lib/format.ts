/** Форматирование чисел и длительностей для интерфейса. */

const NUMBER = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const PLURAL = new Intl.PluralRules('ru-RU');

/**
 * Склоняет существительное по числу: `plural(4, ['запуск', 'запуска', 'запусков'])`
 * даёт «4 запуска». Формы — для одного, для нескольких и для многих.
 */
export function plural(count: number, forms: readonly [string, string, string]): string {
  const rule = PLURAL.select(count);
  const form = rule === 'one' ? forms[0] : rule === 'few' ? forms[1] : forms[2];
  return `${count} ${form}`;
}

/** Расход токенов: `61,4 тыс.` вместо `61400`; `null` — «нет данных». */
export function formatTokens(value: number | null): string {
  if (value === null) return 'нет данных';
  if (value >= 1_000_000) return `${NUMBER.format(value / 1_000_000)} млн`;
  if (value >= 1_000) return `${NUMBER.format(value / 1_000)} тыс.`;
  return NUMBER.format(value);
}

/**
 * Длительность: `42 с`, `16 мин`, `3 ч 20 мин`, `12 дн 4 ч`; `null` — прочерк.
 *
 * Время в работе считается по часам на стене, поэтому у долгих задач оно
 * измеряется днями — «4938 ч» читать невозможно.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} дн` : `${days} дн ${restHours} ч`;
}

/** Доля: `36 %`; `null` — прочерк. */
export function formatShare(share: number | null): string {
  return share === null ? '—' : `${Math.round(share * 100)} %`;
}
