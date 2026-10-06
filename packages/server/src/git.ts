import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Предел времени одного вызова git, мс. */
const GIT_TIMEOUT_MS = 15_000;

/**
 * История проекта из git — для устаревших дельт и забытых changes.
 *
 * git вызывается без оболочки, аргументами-массивом, в корне проекта. Пути —
 * относительно корня, через `/`; `<коммит>:./<путь>` у `git show` тоже
 * считается от текущего каталога, поэтому корень OpenSpec может лежать в
 * подкаталоге репозитория. Любой сбой git — «ничего не известно», а не ошибка:
 * без истории проверки работают по запасным путям.
 */
export class GitHistory {
  readonly #root: string;
  #available: Promise<boolean> | null = null;

  constructor(root: string) {
    this.#root = root;
  }

  /** Корень проекта лежит в рабочем дереве git, и git запускается. */
  available(): Promise<boolean> {
    this.#available ??= this.#run(['rev-parse', '--is-inside-work-tree']).then((out) => out?.trim() === 'true');
    return this.#available;
  }

  /** Коммит, в котором файл появился (первый по времени), и его дата. */
  async firstAdded(path: string): Promise<{ commit: string; date: string } | null> {
    const out = await this.#run(['log', '--diff-filter=A', '--format=%H%x09%cI', '--', path]);
    const last = out
      ?.split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .at(-1);
    if (last === undefined) return null;
    const [commit, date] = last.split('\t');
    return commit === undefined || date === undefined ? null : { commit, date };
  }

  /** Содержимое файла в коммите; `null`, если его там не было. */
  async show(commit: string, path: string): Promise<string | null> {
    return this.#run(['show', `${commit}:./${path}`]);
  }

  /** Дата последнего коммита, затронувшего путь (или любой из путей). */
  async lastCommitDate(path: string | readonly string[]): Promise<string | null> {
    const out = (await this.#run(['log', '-1', '--format=%cI', '--', ...(typeof path === 'string' ? [path] : path)]))?.trim();
    return out === undefined || out === '' ? null : out;
  }

  /** Последний коммит, затронувший путь, и его дата. */
  async lastCommit(path: string): Promise<{ commit: string; date: string } | null> {
    const [commit, date] = ((await this.#run(['log', '-1', '--format=%H%x09%cI', '--', path])) ?? '').trim().split('\t');
    return commit === undefined || commit === '' || date === undefined ? null : { commit, date };
  }

  /** Сколько коммитов после `commit` (не включая его) затронули пути. */
  async commitsAfter(commit: string, paths: readonly string[]): Promise<number | null> {
    const out = (await this.#run(['rev-list', '--count', `${commit}..HEAD`, '--', ...paths]))?.trim();
    const count = out === undefined ? Number.NaN : Number(out);
    return Number.isInteger(count) ? count : null;
  }

  /** Дата первого коммита, затронувшего путь. */
  async firstCommitDate(path: string): Promise<string | null> {
    const out = await this.#run(['log', '--format=%cI', '--', path]);
    return (
      out
        ?.split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .at(-1) ?? null
    );
  }

  /**
   * Снимок состояния репозитория: коммит `HEAD`, время изменения и размер
   * индекса. Пока снимок тот же, история, достижимая из `HEAD`, и статус файла
   * с тем же содержимым не меняются. Без git, без коммитов или при сбое — `null`.
   */
  async snapshot(): Promise<string | null> {
    const [head, index] = ((await this.#run(['rev-parse', 'HEAD', '--git-path', 'index'])) ?? '').trim().split('\n');
    if (head === undefined || !/^[0-9a-f]{40,64}$/.test(head) || index === undefined) return null;
    // Путь индекса — относительно корня или абсолютный (worktree, `GIT_DIR`).
    const info = await stat(resolve(this.#root, index), { bigint: true }).catch(() => null);
    return info === null ? `${head} -` : `${head} ${info.mtimeNs} ${info.size}`;
  }

  /** В пути есть незакоммиченные правки или неотслеживаемые файлы. */
  async hasChanges(path: string): Promise<boolean> {
    const out = await this.#run(['status', '--porcelain', '--untracked-files=all', '--', path]);
    return out !== null && out.trim() !== '';
  }

  #run(args: readonly string[]): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        'git',
        [...args],
        {
          cwd: this.#root,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          // Чтение истории не должно брать блокировку индекса у git самого пользователя.
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
        },
        (error, stdout) => resolve(error === null ? stdout : null),
      );
    });
  }
}
