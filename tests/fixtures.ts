import { fileURLToPath } from 'node:url';

/** Корень каталога с фикстурными OpenSpec-проектами. */
export const FIXTURES_ROOT = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Ожидаемое состояние фикстуры, против которого сверяются тесты. */
export interface FixtureExpectation {
  /** Каталог фикстуры относительно FIXTURES_ROOT. */
  readonly dir: string;
  /** Чем этот проект интересен тестам. */
  readonly about: string;
  /** Имя схемы, по которой заведён change, если он есть. */
  readonly schema: string | null;
  /** Имя активного change, если он есть. */
  readonly change: string | null;
  /** Проходит ли `openspec validate <change> --strict`. */
  readonly validates: boolean;
  /** Отмеченных и всего пунктов в отслеживаемом артефакте. */
  readonly tasks: { readonly complete: number; readonly total: number } | null;
}

export const FIXTURES: readonly FixtureExpectation[] = [
  {
    dir: 'empty',
    about: 'инициализированный проект без changes и спеков',
    schema: null,
    change: null,
    validates: true,
    tasks: null,
  },
  {
    dir: 'bare-change',
    about: 'change заведён, но ни один артефакт не создан',
    schema: 'spec-driven',
    change: 'bare-feature',
    validates: false,
    tasks: { complete: 0, total: 0 },
  },
  {
    dir: 'full-change',
    about: 'все артефакты планирования заполнены, работа идёт',
    schema: 'spec-driven',
    change: 'full-feature',
    validates: true,
    tasks: { complete: 2, total: 4 },
  },
  {
    dir: 'archived',
    about: 'основной спек и архивный change',
    schema: null,
    change: null,
    validates: true,
    tasks: null,
  },
  {
    dir: 'delta-ops',
    // MODIFIED здесь намеренно теряет сценарий основного спека: именно этот
    // случай показывает просмотрщик дельт, и CLI на нём ожидаемо ругается.
    about: 'все виды операций дельт, потерянный при копировании сценарий и два change над одной capability',
    schema: 'spec-driven',
    change: 'rework-export',
    validates: false,
    tasks: { complete: 0, total: 1 },
  },
  {
    dir: 'custom-schema',
    about: 'собственная схема: свои артефакты, лишний этап, другой отслеживаемый артефакт',
    schema: 'team-flow',
    change: 'team-feature',
    validates: true,
    tasks: { complete: 1, total: 3 },
  },
] as const;

/** Абсолютный путь к фикстуре по её каталогу. */
export function fixturePath(dir: string): string {
  return new URL(`./fixtures/${dir}/`, import.meta.url).pathname.replace(/\/$/, '');
}
