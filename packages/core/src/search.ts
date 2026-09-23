import { parseSpecMarkdown } from './specMarkdown.js';

/** Тип найденного элемента. */
export type SearchKind = 'change' | 'capability' | 'schema' | 'requirement' | 'scenario';

/** Один результат поиска. */
export interface SearchHit {
  readonly kind: SearchKind;
  /** Текст, по которому было совпадение. */
  readonly title: string;
  /** Кому принадлежит элемент: имя change или путь capability. */
  readonly owner: string;
  /** Файл относительно корня рабочего пространства; `null` у change и схемы. */
  readonly file: string | null;
  /** Строка в файле, начиная с 1; `null`, если элемент не привязан к строке. */
  readonly line: number | null;
}

/** Документ, по которому идёт поиск. */
export interface SearchDocument {
  /** Имя change или путь capability. */
  readonly owner: string;
  /** Путь файла относительно корня рабочего пространства. */
  readonly file: string;
  readonly text: string;
}

/** Что индексируется помимо содержимого файлов. */
export interface SearchNames {
  readonly changes: readonly string[];
  readonly capabilities: readonly string[];
  readonly schemas: readonly string[];
}

/** Поисковый индекс рабочего пространства. */
export class SearchIndex {
  readonly #hits: SearchHit[] = [];

  constructor(names: SearchNames, documents: readonly SearchDocument[]) {
    for (const name of names.changes) {
      this.#hits.push({ kind: 'change', title: name, owner: name, file: null, line: null });
    }
    for (const path of names.capabilities) {
      this.#hits.push({ kind: 'capability', title: path, owner: path, file: null, line: null });
    }
    for (const name of names.schemas) {
      this.#hits.push({ kind: 'schema', title: name, owner: name, file: null, line: null });
    }

    for (const document of documents) {
      const parsed = parseSpecMarkdown(document.text);
      for (const requirement of parsed.requirements) {
        this.#hits.push({
          kind: 'requirement',
          title: requirement.name,
          owner: document.owner,
          file: document.file,
          line: requirement.line,
        });
        for (const scenario of requirement.scenarios) {
          this.#hits.push({
            kind: 'scenario',
            title: scenario.name,
            owner: document.owner,
            file: document.file,
            line: scenario.line,
          });
        }
      }
    }
  }

  get size(): number {
    return this.#hits.length;
  }

  /**
   * Ищет по подстроке без учёта регистра.
   *
   * `kinds` ограничивает выдачу типами элементов; пустой список означает
   * «без ограничения», а не «ничего не искать».
   */
  search(query: string, kinds: readonly SearchKind[] = []): readonly SearchHit[] {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === '') return [];

    const allowed = kinds.length === 0 ? null : new Set(kinds);
    return this.#hits.filter(
      (hit) =>
        (allowed === null || allowed.has(hit.kind)) &&
        hit.title.toLocaleLowerCase().includes(needle),
    );
  }
}
