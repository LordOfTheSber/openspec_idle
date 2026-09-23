import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('чистота пакета core', () => {
  /**
   * core собирается и в сборку страницы тоже, поэтому Node API в нём приводит
   * к падению сборки фронтенда. Правило проверяется тестом, а не соглашением:
   * нарушение иначе всплывает только при сборке web.
   */
  it('не импортирует Node API', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /from\s+'node:[a-z/]+'/.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  it('не импортирует внешние пакеты', () => {
    const offenders = sourceFiles(SRC).filter((file) => {
      const text = readFileSync(file, 'utf8');
      const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      return imports.some((specifier) => !specifier.startsWith('.'));
    });

    expect(offenders).toEqual([]);
  });
});
