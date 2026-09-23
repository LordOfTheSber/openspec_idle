/**
 * Ссылки между требованиями спек: markdown-ссылка на `spec.md` другой
 * capability с якорем заголовка требования по правилам GitHub. Та же ссылка
 * кликабельна при просмотре репозитория в GitHub и GitLab.
 */

/**
 * Якорь заголовка по правилам GitHub: нижний регистр, всё кроме букв, цифр,
 * пробела, дефиса и подчёркивания убирается, пробелы — в дефисы. Буквы
 * любого алфавита сохраняются.
 */
export function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Якорь требования: `Счета / Нумерация` → `requirement-счета--нумерация`. */
export function requirementAnchor(name: string): string {
  return headingSlug(`Requirement: ${name}`);
}

/** Ссылка на требование или спеку, найденная в тексте. */
export interface SpecLink {
  /** Строка файла, начиная с 1. */
  readonly line: number;
  readonly label: string;
  /** Как записано в файле: `../km/core/spec.md#requirement-кэш-ответов`. */
  readonly href: string;
  /** Путь capability цели. */
  readonly capability: string;
  /** Якорь без `#`; `null` — ссылка на спеку целиком. */
  readonly anchor: string | null;
}

const RE_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Находит в тексте ссылки на `spec.md` других capability. Относительный путь
 * разрешается от итогового места спеки — `specs/<capability>/` — и для
 * основной спеки, и для дельты в change: дельта после архивации переезжает
 * туда же, и ссылка должна остаться верной.
 */
export function parseSpecLinks(text: string, fromCapability: string): SpecLink[] {
  const links: SpecLink[] = [];
  text.split('\n').forEach((raw, index) => {
    for (const match of raw.matchAll(RE_LINK)) {
      const href = match[2]!;
      if (/^[a-z][\w+.-]*:/i.test(href)) continue; // http:, mailto: и прочие внешние
      const [path = '', hash] = href.split('#', 2);
      if (!/(^|\/)spec\.md$/.test(path)) continue;
      const target = resolvePath(`specs/${fromCapability}`, path);
      if (target === null || !target.startsWith('specs/')) continue;
      const capability = target.slice('specs/'.length).replace(/\/spec\.md$/, '');
      if (capability === '' || capability === 'spec.md') continue;
      links.push({
        line: index + 1,
        label: match[1]!,
        href,
        capability,
        anchor: hash === undefined || hash === '' ? null : safeDecode(hash),
      });
    }
  });
  return links;
}

/** Относительная ссылка на требование из спеки `fromCapability`. */
export function requirementHref(fromCapability: string, toCapability: string, requirement: string | null): string {
  const path = relativePath(`specs/${fromCapability}`, `specs/${toCapability}/spec.md`);
  return requirement === null ? path : `${path}#${requirementAnchor(requirement)}`;
}

/** Markdown-ссылка для вставки: `[km/core: Кэш ответов](../km/core/spec.md#…)`. */
export function requirementLink(fromCapability: string, toCapability: string, requirement: string): string {
  return `[${toCapability}: ${requirement}](${requirementHref(fromCapability, toCapability, requirement)})`;
}

/** Требование, на которое указывает якорь, среди имён спеки. */
export function findByAnchor(anchor: string, names: readonly string[]): string | null {
  const wanted = anchor.toLowerCase();
  return names.find((name) => requirementAnchor(name) === wanted) ?? null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Разрешает относительный путь от каталога; `null` — выход за корень. */
export function resolvePath(fromDir: string, relative: string): string | null {
  const parts = relative.startsWith('/') ? [] : fromDir.split('/').filter(Boolean);
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

/** Относительный путь от каталога до файла, оба от одного корня. */
export function relativePath(fromDir: string, to: string): string {
  const from = fromDir.split('/').filter(Boolean);
  const target = to.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < target.length - 1 && from[common] === target[common]) common += 1;
  const up = from.length - common;
  const rest = target.slice(common);
  return [...Array.from({ length: up }, () => '..'), ...rest].join('/') || '.';
}
