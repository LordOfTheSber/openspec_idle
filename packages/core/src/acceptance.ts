/**
 * Выделение критерия приёмки из формулировки пункта плана.
 *
 * Схема OpenSpec требует, чтобы каждая задача называла способ своей проверки
 * прямо в тексте. Критерий не хранится отдельно и не редактируется отдельно —
 * он извлекается из формулировки, чтобы не расходиться с ней.
 */

/** Разобранная формулировка пункта. */
export interface AcceptanceSplit {
  /** Что сделать. */
  readonly work: string;
  /** Как проверить; `null`, если в формулировке способа проверки нет. */
  readonly criterion: string | null;
}

// Явный разделитель, принятый в этом проекте: «…; проверка — …».
const RE_EXPLICIT = /^(.*?)[;,]?\s*(?:проверка|приёмка|приемка|verification|check)\s*[—:-]\s*(.+)$/iu;

// Неявная форма: «… и проверить, что …», «… и убедиться …», «… and verify …».
// Граница слова задана через `(?!\p{L})`, а не `\b`: в JavaScript `\b` знает
// только латиницу и между кириллической буквой и запятой не срабатывает.
// Разделитель обязателен — иначе «Панель проверок» сошла бы за критерий.
const RE_IMPLICIT =
  /^(.*?)(?:,\s*|\s+(?:и|and)\s+|;\s*)((?:проверить|проверив|убедиться|убедившись|verify|ensure|check)(?!\p{L}).+)$/iu;

/** Делит формулировку пункта на работу и критерий приёмки. */
export function splitAcceptance(text: string): AcceptanceSplit {
  const trimmed = text.trim();

  const explicit = RE_EXPLICIT.exec(trimmed);
  if (explicit?.[1] !== undefined && explicit[2] !== undefined && explicit[1].trim() !== '') {
    return { work: explicit[1].trim(), criterion: explicit[2].trim() };
  }

  const implicit = RE_IMPLICIT.exec(trimmed);
  if (implicit?.[1] !== undefined && implicit[2] !== undefined && implicit[1].trim() !== '') {
    return { work: implicit[1].trim(), criterion: implicit[2].trim() };
  }

  return { work: trimmed, criterion: null };
}
