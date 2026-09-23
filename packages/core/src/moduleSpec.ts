/**
 * Спека модуля: одна большая спека на сервис, UI или библиотеку. Разделы
 * задаются в имени требования через ` / ` — заголовки `##` внутри требований
 * CLI OpenSpec не переносит (см. `checkModuleSpec`).
 */

export const SECTION_SEPARATOR = ' / ';
export const GENERAL_SECTION = 'Общее';

/** Имя требования, разобранное на разделы. */
export interface SectionedName {
  /** Разделы от внешнего к внутреннему; пусто — раздел «Общее». */
  readonly sections: readonly string[];
  /** Имя требования внутри раздела. */
  readonly short: string;
}

/**
 * Разделитель — косая черта с пробелами: `Счета / НДС / Округление`. Косая
 * черта без пробелов (`km/core`, `A/B-тест`) разделом не считается.
 */
export function splitSections(name: string): SectionedName {
  const parts = name.split(SECTION_SEPARATOR).map((part) => part.trim());
  if (parts.length < 2 || parts.some((part) => part === '')) return { sections: [], short: name.trim() };
  return { sections: parts.slice(0, -1), short: parts[parts.length - 1]! };
}

/** Раздел спеки с требованиями и подразделами. */
export interface SectionNode<T> {
  readonly title: string;
  /** Путь раздела от корня: `['Счета', 'НДС']`. */
  readonly path: readonly string[];
  readonly requirements: readonly T[];
  readonly children: readonly SectionNode<T>[];
  /** Требований в разделе вместе с подразделами. */
  readonly requirementCount: number;
  readonly scenarioCount: number;
}

interface MutableSection<T> {
  title: string;
  path: string[];
  requirements: T[];
  children: MutableSection<T>[];
}

/**
 * Строит дерево разделов в порядке файла: раздел появляется там, где встречено
 * его первое требование. Требования без разделителя — в разделе «Общее».
 */
export function buildSections<T extends { readonly name: string; readonly scenarios: readonly unknown[] }>(
  requirements: readonly T[],
): SectionNode<T>[] {
  const roots: MutableSection<T>[] = [];
  const find = (level: MutableSection<T>[], title: string, path: string[]): MutableSection<T> => {
    let node = level.find((entry) => entry.title === title);
    if (node === undefined) {
      node = { title, path, requirements: [], children: [] };
      level.push(node);
    }
    return node;
  };
  for (const requirement of requirements) {
    const { sections } = splitSections(requirement.name);
    const chain = sections.length === 0 ? [GENERAL_SECTION] : sections;
    let level = roots;
    let node: MutableSection<T> | null = null;
    chain.forEach((title, index) => {
      node = find(level, title, chain.slice(0, index + 1));
      level = node.children;
    });
    (node as MutableSection<T> | null)?.requirements.push(requirement);
  }
  const freeze = (node: MutableSection<T>): SectionNode<T> => {
    const children = node.children.map(freeze);
    return {
      title: node.title,
      path: node.path,
      requirements: node.requirements,
      children,
      requirementCount: node.requirements.length + children.reduce((sum, child) => sum + child.requirementCount, 0),
      scenarioCount:
        node.requirements.reduce((sum, requirement) => sum + requirement.scenarios.length, 0) +
        children.reduce((sum, child) => sum + child.scenarioCount, 0),
    };
  };
  return roots.map(freeze);
}

/** Предупреждение о формате спеки модуля. */
export interface ModuleSpecWarning {
  readonly kind: 'heading-in-requirements' | 'duplicate-requirement' | 'similar-sections';
  readonly line: number;
  readonly message: string;
  /** Для заголовка `##`: сколько требований ниже CLI не увидит. */
  readonly lostRequirements?: number;
}

const RE_H2 = /^##\s+(.+?)\s*$/;
const RE_REQUIREMENT = /^###\s+Requirement:\s*(.+?)\s*$/;

/**
 * Находит конструкции, которые CLI обрабатывает не так, как их видит человек.
 * Проверено на CLI 1.13.1: заголовок `##` после `## Requirements` обрывает
 * раздел — требования ниже `show` не возвращает, `validate` падает.
 */
export function checkModuleSpec(text: string): ModuleSpecWarning[] {
  const lines = text.split('\n');
  const warnings: ModuleSpecWarning[] = [];
  let inRequirements = false;
  let cut: { line: number; title: string } | null = null;
  let lost = 0;
  const seen = new Map<string, number>();
  const sectionSpellings = new Map<string, Map<string, number>>();

  const closeCut = (): void => {
    if (cut !== null && lost > 0) {
      warnings.push({
        kind: 'heading-in-requirements',
        line: cut.line,
        lostRequirements: lost,
        message:
          `Заголовок «## ${cut.title}» внутри раздела Requirements: CLI OpenSpec не увидит требований ниже него (${lost}). ` +
          `Перенесите раздел в имена требований: «${cut.title} / Имя требования».`,
      });
    }
  };

  lines.forEach((raw, index) => {
    const line = index + 1;
    const h2 = RE_H2.exec(raw);
    if (h2?.[1] !== undefined) {
      const title = h2[1];
      if (/^requirements$/i.test(title)) {
        inRequirements = true;
        return;
      }
      if (inRequirements && cut === null) {
        cut = { line, title };
        lost = 0;
      }
      return;
    }
    const requirement = RE_REQUIREMENT.exec(raw);
    if (requirement?.[1] === undefined) return;
    const name = requirement[1];
    if (cut !== null) lost += 1;

    const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
    const first = seen.get(key);
    if (first !== undefined) {
      warnings.push({
        kind: 'duplicate-requirement',
        line,
        message: `Требование «${name}» уже объявлено в строке ${first}: CLI возьмёт только одно из них.`,
      });
    } else {
      seen.set(key, line);
    }

    for (const section of splitSections(name).sections) {
      const normalized = section.toLowerCase().replace(/\s+/g, ' ').trim();
      const spellings = sectionSpellings.get(normalized) ?? new Map<string, number>();
      if (!spellings.has(section)) spellings.set(section, line);
      sectionSpellings.set(normalized, spellings);
    }
  });
  closeCut();

  // Разделы, различающиеся только регистром или пробелами, — это один раздел,
  // записанный по-разному: `Счета` и `счета ` показывались бы порознь.
  for (const spellings of sectionSpellings.values()) {
    if (spellings.size < 2) continue;
    const variants = [...spellings.keys()];
    warnings.push({
      kind: 'similar-sections',
      line: Math.min(...spellings.values()),
      message: `Разделы ${variants.map((variant) => `«${variant}»`).join(', ')} различаются только регистром или пробелами — сведите к одному написанию.`,
    });
  }

  return warnings.sort((a, b) => a.line - b.line);
}

/** Раздел требования для показа: «Счета › НДС». */
export function sectionLabel(name: string): string {
  const { sections } = splitSections(name);
  return sections.length === 0 ? GENERAL_SECTION : sections.join(' › ');
}
