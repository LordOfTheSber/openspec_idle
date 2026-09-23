import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Недавний репозиторий в том виде, в каком его показывает стартовый экран. */
export interface RecentEntry {
  readonly path: string;
  readonly name: string;
  readonly openedAt: string;
  /** Папка на месте и в ней есть `openspec/`. */
  readonly available: boolean;
}

interface StoredEntry {
  readonly path: string;
  readonly openedAt: string;
}

/** Файловые операции — подменяются в тестах. */
export interface RecentFs {
  read(file: string): string | null;
  write(file: string, text: string): void;
  available(path: string): boolean;
}

export const nodeRecentFs: RecentFs = {
  read: (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  write: (file, text) => {
    mkdirSync(dirname(file), { recursive: true });
    // Через временный файл: оборванная запись не должна стереть список.
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  },
  available: (path) => existsSync(join(path, 'openspec')),
};

/** Предел длины списка: старые репозитории вытесняются. */
export const RECENT_LIMIT = 15;

/**
 * Список недавних репозиториев в профиле пользователя. В репозиторий ничего
 * не пишется: список — настройка машины, а не проекта.
 */
export class RecentList {
  constructor(
    private readonly file: string,
    private readonly fs: RecentFs = nodeRecentFs,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): RecentEntry[] {
    return this.load().map((entry) => ({
      path: entry.path,
      name: basename(entry.path) || entry.path,
      openedAt: entry.openedAt,
      available: this.fs.available(entry.path),
    }));
  }

  /** Поднимает репозиторий в начало списка. */
  add(path: string): void {
    const rest = this.load().filter((entry) => !samePath(entry.path, path));
    this.save([{ path, openedAt: this.now().toISOString() }, ...rest].slice(0, RECENT_LIMIT));
  }

  remove(path: string): void {
    this.save(this.load().filter((entry) => !samePath(entry.path, path)));
  }

  private load(): StoredEntry[] {
    const text = this.fs.read(this.file);
    if (text === null) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is StoredEntry =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as StoredEntry).path === 'string' &&
          typeof (entry as StoredEntry).openedAt === 'string',
      );
    } catch {
      // Испорченный файл не должен мешать запуску: список начнётся заново.
      return [];
    }
  }

  private save(entries: readonly StoredEntry[]): void {
    this.fs.write(this.file, `${JSON.stringify(entries, null, 2)}\n`);
  }
}

/** Пути на Windows сравниваются без учёта регистра. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
