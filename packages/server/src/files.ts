import { createHash } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { resolveInsideWorkspace } from './http/paths.js';

/**
 * Версия содержимого файла.
 *
 * Считается по содержимому, а не по времени изменения: у mtime слишком грубое
 * разрешение, и две правки в одну миллисекунду выглядели бы одинаково.
 */
export function contentVersion(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/** Прочитанный файл артефакта. */
export interface ArtifactFile {
  /** Путь относительно корня рабочего пространства. */
  readonly path: string;
  readonly content: string;
  readonly version: string;
}

/** Файл на диске изменился с тех пор, как его прочитал редактор. */
export class StaleWriteError extends Error {
  constructor(
    readonly path: string,
    readonly disk: ArtifactFile,
  ) {
    super(
      `Файл «${path}» изменился на диске после того, как был открыт в редакторе. ` +
        'Сохранение остановлено, чтобы не потерять чужую правку.',
    );
    this.name = 'StaleWriteError';
  }
}

/** Запись файла не удалась; исходный файл при этом не пострадал. */
export class WriteFailedError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Не удалось записать файл «${path}»: ${reason}. Исходный файл не изменён.`);
    this.name = 'WriteFailedError';
  }
}

/** Операции файловой системы; подменяются в тестах, чтобы проверить сбой записи. */
export interface FileSystemOps {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const REAL_FS: FileSystemOps = { readFile, writeFile, rename, unlink };

/** Читает файл артефакта, проверив, что он внутри рабочего пространства. */
export async function readArtifactFile(
  root: string,
  relativePath: string,
  fs: FileSystemOps = REAL_FS,
): Promise<ArtifactFile> {
  const absolute = resolveInsideWorkspace(root, relativePath);
  const content = await fs.readFile(absolute, 'utf8');
  return { path: relativePath, content, version: contentVersion(content) };
}

/**
 * Сохраняет файл артефакта.
 *
 * Запись атомарная: содержимое пишется во временный файл рядом и
 * переименовывается поверх исходного. При сбое исходный файл остаётся целым —
 * читатель никогда не увидит наполовину записанный артефакт.
 *
 * `baseVersion` — версия, которую редактор прочитал при открытии. Если файл на
 * диске с тех пор изменился, запись останавливается: правку агента или коллеги
 * нельзя затирать молча.
 */
export async function saveArtifactFile(
  root: string,
  relativePath: string,
  content: string,
  baseVersion: string | null,
  fs: FileSystemOps = REAL_FS,
): Promise<ArtifactFile> {
  const absolute = resolveInsideWorkspace(root, relativePath);

  if (baseVersion !== null) {
    let current: string | null = null;
    try {
      current = await fs.readFile(absolute, 'utf8');
    } catch {
      current = null;
    }
    if (current !== null && contentVersion(current) !== baseVersion) {
      throw new StaleWriteError(relativePath, {
        path: relativePath,
        content: current,
        version: contentVersion(current),
      });
    }
  }

  const temporary = join(dirname(absolute), `.${basename(absolute)}.tmp-${process.pid}`);
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, absolute);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw new WriteFailedError(
      relativePath,
      error instanceof Error ? error.message : String(error),
    );
  }

  return { path: relativePath, content, version: contentVersion(content) };
}
