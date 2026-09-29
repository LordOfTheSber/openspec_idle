/**
 * «Нить change» — этапы жизни change одной линией: артефакты схемы в порядке
 * зависимостей и завершающий узел «Архив». Строится из карточки доски, без
 * отдельного запроса к бэкенду.
 */
import type { BoardCard } from '@openspec-ide/core';

/** Состояние узла нити. */
export type ThreadNodeState = 'done' | 'next' | 'skipped' | 'todo';

export interface ThreadNode {
  readonly id: string;
  readonly state: ThreadNodeState;
  /** Файл артефакта относительно корня; `null`, если его нет. */
  readonly path: string | null;
}

export interface Thread {
  readonly nodes: readonly ThreadNode[];
  /** Узел «Архив»: change готов к архивации или ещё нет. */
  readonly archive: 'ready' | 'todo';
  /** Доля выполненных пунктов плана, 0–100. */
  readonly fill: number;
  /** Артефакт, который создать следующим; `null`, если все созданы. */
  readonly next: string | null;
}

export const NODE_STATE_LABEL: Record<ThreadNodeState, string> = {
  done: 'есть',
  next: 'следующий шаг',
  skipped: 'пропущен',
  todo: 'не начат',
};

/** Собирает нить по карточке доски. */
export function buildThread(card: BoardCard): Thread {
  const position = card.artifacts.findIndex((artifact) => artifact.id === card.column);
  const nodes = card.artifacts.map((artifact, index): ThreadNode => {
    const path = artifact.path ?? null;
    if (artifact.done) return { id: artifact.id, state: 'done', path };
    if (artifact.id === card.column) return { id: artifact.id, state: 'next', path };
    // Карточка уже дальше этого артефакта — значит, схема не требует его для
    // следующих шагов, и он пропущен.
    if (position === -1 || index < position) return { id: artifact.id, state: 'skipped', path };
    return { id: artifact.id, state: 'todo', path };
  });
  const progress = card.progress;
  const fill =
    progress === null || progress.total === 0 ? 0 : Math.round((progress.complete / progress.total) * 100);
  return {
    nodes,
    archive: card.column === 'to-archive' ? 'ready' : 'todo',
    fill,
    next: nodes.find((node) => node.state === 'next')?.id ?? null,
  };
}

/** Короткая подпись состояния карточки под нитью. */
export function threadCaption(card: BoardCard, thread: Thread): string {
  const progress = card.progress;
  const plan = progress !== null && progress.total > 0 ? `${progress.complete}/${progress.total} пунктов` : null;
  const skipped = thread.nodes.filter((node) => node.state === 'skipped').map((node) => node.id);
  const parts: string[] = [];
  if (thread.next !== null) parts.push(`следующий шаг — ${thread.next}`);
  if (skipped.length > 0) parts.push(`пропущен ${skipped.join(', ')}`);
  if (card.column === 'ready') parts.push('можно начинать');
  if (card.column === 'in-progress') parts.push('реализация');
  if (card.column === 'to-archive') parts.push('готов к архивации');
  parts.push(plan ?? 'нет пунктов');
  return parts.join(' · ');
}
