import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Rule {
  readonly pattern: RegExp;
  readonly negate: boolean;
  readonly directoryOnly: boolean;
}

/**
 * Правила корневого `.gitignore` — достаточно, чтобы обход кода не заходил в
 * сгенерированное. Поддерживаются `*`, `**`, `?`, якорь `/`, `!` и `dir/`.
 */
export class GitIgnore {
  readonly #rules: readonly Rule[];

  constructor(text: string) {
    this.#rules = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map(toRule);
  }

  static async load(root: string): Promise<GitIgnore> {
    try {
      return new GitIgnore(await readFile(join(root, '.gitignore'), 'utf8'));
    } catch {
      return new GitIgnore('');
    }
  }

  /** Игнорируется ли путь от корня (через `/`). */
  ignores(path: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const rule of this.#rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.pattern.test(path)) ignored = !rule.negate;
    }
    return ignored;
  }
}

function toRule(line: string): Rule {
  let body = line;
  const negate = body.startsWith('!');
  if (negate) body = body.slice(1);
  const directoryOnly = body.endsWith('/');
  if (directoryOnly) body = body.slice(0, -1);
  // Шаблон со слэшем в начале или середине привязан к корню, иначе — к любому уровню.
  const anchored = body.includes('/');
  if (body.startsWith('/')) body = body.slice(1);
  let regex = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === '*' && body[index + 1] === '*') {
      regex += '.*';
      index += 1;
      if (body[index + 1] === '/') index += 1;
    } else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return { pattern: new RegExp(`${prefix}${regex}(?:/.*)?$`), negate, directoryOnly };
}
