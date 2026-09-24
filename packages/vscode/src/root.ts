import { resolveOpenspecRoot } from '@openspec-ide/server';

/** Итог выбора корня OpenSpec по папкам рабочей области. */
export type WorkspaceRoot =
  | { readonly kind: 'found'; readonly root: string; readonly folder: string }
  | { readonly kind: 'not-found'; readonly folders: readonly string[] };

/**
 * Выбирает корень OpenSpec: первая по порядку папка рабочей области, в которой
 * или выше которой по дереву есть `openspec/`. Поиск вверх — тот же, что у CLI.
 */
export function pickWorkspaceRoot(folders: readonly string[]): WorkspaceRoot {
  for (const folder of folders) {
    const resolution = resolveOpenspecRoot(folder);
    if (resolution.kind === 'found') return { kind: 'found', root: resolution.root, folder };
  }
  return { kind: 'not-found', folders };
}
