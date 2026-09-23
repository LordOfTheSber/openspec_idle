import { isAbsolute, resolve } from 'node:path';

/**
 * Путь к репозиторию из командной строки приложения.
 *
 * Упакованное приложение получает `[exe, путь]`, а запущенное из исходников —
 * `[electron, каталог приложения, путь]`. Ключи Chromium и Electron
 * (`--no-sandbox`, `--inspect=0`) пропускаются и могут стоять где угодно,
 * в том числе перед каталогом приложения.
 */
export function repositoryArgument(
  argv: readonly string[],
  options: { readonly defaultApp: boolean; readonly cwd: string },
): string | null {
  const positional = argv.slice(1).filter((argument) => argument !== '' && !argument.startsWith('-'));
  const path = positional[options.defaultApp ? 1 : 0];
  if (path === undefined) return null;
  return isAbsolute(path) ? path : resolve(options.cwd, path);
}
