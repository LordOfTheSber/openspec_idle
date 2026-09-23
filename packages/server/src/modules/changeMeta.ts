import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OPENSPEC_DIR } from '@openspec-ide/core';

const MODULES_KEY = /^modules:[^\n]*\n(?:[ \t]+-[^\n]*\n)*/m;

/**
 * Записывает модули change в ключ `modules` его `.openspec.yaml`. Остальные
 * строки файла не трогаются побайтово: файл принадлежит CLI OpenSpec.
 */
export function withModules(text: string, modules: readonly string[]): string {
  const line = modules.length === 0 ? '' : `modules: [${modules.map(quote).join(', ')}]\n`;
  const normalized = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  if (MODULES_KEY.test(normalized)) return normalized.replace(MODULES_KEY, line);
  return `${normalized}${line}`;
}

function quote(id: string): string {
  return /^[\w./-]+$/.test(id) ? id : JSON.stringify(id);
}

export async function writeChangeModules(root: string, change: string, modules: readonly string[]): Promise<void> {
  const path = join(root, OPENSPEC_DIR, 'changes', change, '.openspec.yaml');
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // Файла нет — CLI его не создал; ключ станет его единственным содержимым.
  }
  const next = withModules(text, modules);
  if (next === text) return;
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, next, 'utf8');
  await rename(temporary, path);
}
