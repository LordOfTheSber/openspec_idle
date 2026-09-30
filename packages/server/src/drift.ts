import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPENSPEC_DIR,
  type DeltaBaseline,
  type DriftChangeInput,
  type DriftReport,
  archivedTouches,
  buildDriftReport,
} from '@openspec-ide/core';
import type { AuthoringService } from './authoring.js';
import type { BoardService } from './board.js';
import { capabilityFromPath } from './deltas.js';
import { GitHistory } from './git.js';
import type { WorkspaceReader } from './workspace.js';

/** Сколько отчёт живёт без событий изменения файлов, мс: коммит файлов не меняет. */
const REPORT_TTL_MS = 30_000;

/**
 * Пересечения, устаревшие дельты и забытые changes: собирает историю (git,
 * архив, даты) и отдаёт её чистой модели `core`.
 */
export class DriftService {
  readonly #root: string;
  readonly #authoring: AuthoringService;
  readonly #board: BoardService | null;
  readonly #workspace: WorkspaceReader;
  readonly #git: GitHistory;
  readonly #now: () => Date;
  #cached: { at: number; report: Promise<DriftReport> } | null = null;

  constructor(options: {
    root: string;
    authoring: AuthoringService;
    board: BoardService | null;
    workspace: WorkspaceReader;
    now?: () => Date;
  }) {
    this.#root = options.root;
    this.#authoring = options.authoring;
    this.#board = options.board;
    this.#workspace = options.workspace;
    this.#git = new GitHistory(options.root);
    this.#now = options.now ?? (() => new Date());
  }

  /** Сбрасывает отчёт: файлы проекта изменились. */
  invalidate(): void {
    this.#cached = null;
  }

  report(): Promise<DriftReport> {
    const at = Date.now();
    if (this.#cached !== null && at - this.#cached.at < REPORT_TTL_MS) return this.#cached.report;
    const report = this.#build();
    this.#cached = { at, report };
    // Неудачная сборка не должна застревать в кэше.
    report.catch(() => {
      if (this.#cached?.report === report) this.#cached = null;
    });
    return report;
  }

  async #build(): Promise<DriftReport> {
    const now = this.#now().toISOString();
    const [sources, { tree }, board, git] = await Promise.all([
      this.#authoring.sources(),
      this.#workspace.readTree(),
      this.#board === null ? Promise.resolve(null) : this.#board.readBoard().catch(() => null),
      this.#git.available(),
    ]);
    const ready = new Set((board?.cards ?? []).filter((card) => card.column === 'to-archive').map((card) => card.change));

    const changes: DriftChangeInput[] = await Promise.all(
      tree.changes.map(async (change) => {
        const dir = `${OPENSPEC_DIR}/changes/${change.name}`;
        const declared = await this.#createdFromMetadata(dir);
        const created = declared ?? (git ? ((await this.#git.firstCommitDate(dir))?.slice(0, 10) ?? null) : null);
        let lastActivity = change.lastModified;
        if (git) {
          lastActivity = (await this.#git.hasChanges(dir)) ? now : ((await this.#git.lastCommitDate(dir)) ?? change.lastModified);
        }
        return { name: change.name, created, lastActivity, readyToArchive: ready.has(change.name) };
      }),
    );

    const baselines: Record<string, DeltaBaseline | null> = {};
    if (git) {
      await Promise.all(
        sources.changes.flatMap((change) =>
          change.deltas.map(async (delta) => {
            const added = await this.#git.firstAdded(delta.path);
            baselines[delta.path] =
              added === null
                ? null
                : { ...added, mainSpec: await this.#git.show(added.commit, `${OPENSPEC_DIR}/specs/${delta.capability}/spec.md`) };
          }),
        ),
      );
    }

    return buildDriftReport({
      sources,
      git,
      now,
      changes,
      baselines,
      archived: archivedTouches(await this.#archives(tree.archived)),
    });
  }

  async #createdFromMetadata(dir: string): Promise<string | null> {
    const text = await readText(join(this.#root, dir, '.openspec.yaml'));
    return /^created:\s*['"]?(\d{4}-\d{2}-\d{2})/m.exec(text ?? '')?.[1] ?? null;
  }

  /** Дельты архивных changes. */
  async #archives(names: readonly string[]): Promise<{ name: string; deltas: { capability: string; text: string }[] }[]> {
    return Promise.all(
      names.map(async (name) => {
        const specsDir = join(this.#root, OPENSPEC_DIR, 'changes', 'archive', name, 'specs');
        const files = await specFiles(specsDir);
        const deltas: { capability: string; text: string }[] = [];
        for (const file of files) {
          const text = await readText(file);
          if (text !== null) deltas.push({ capability: capabilityFromPath(file), text });
        }
        return { name, deltas };
      }),
    );
  }
}

/** Все `spec.md` под каталогом. */
async function specFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await specFiles(full)));
    else if (entry.name === 'spec.md') result.push(full);
  }
  return result;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
