import type { BoardCard } from '@openspec-ide/core';
import { NODE_STATE_LABEL, type Thread as ThreadModel } from '../lib/thread.js';

/**
 * «Нить change»: узлы артефактов схемы и завершающий «Архив». Отрезок перед
 * архивом заполняется по прогрессу плана. Узел созданного артефакта открывает
 * его файл; состояние различается формой узла, а не только цветом.
 */
export function Thread({
  card,
  thread,
  labels = false,
  onOpen,
}: {
  readonly card: BoardCard;
  readonly thread: ThreadModel;
  /** Подписи под узлами — в панели деталей. */
  readonly labels?: boolean;
  readonly onOpen?: (artifactId: string, path: string | null) => void;
}) {
  const last = thread.nodes.length - 1;
  return (
    <div className={labels ? 'thread labeled' : 'thread'} role="list" aria-label={`Путь изменения ${card.change}`}>
      {thread.nodes.map((node, index) => {
        const title = `${node.id}: ${NODE_STATE_LABEL[node.state]}`;
        const segment =
          index < last ? (
            <span
              className={`thread-seg ${node.state === 'done' && thread.nodes[index + 1]?.state !== 'todo' ? 'on' : ''}`}
              aria-hidden="true"
            />
          ) : null;
        const content = (
          <>
            <span className={`thread-node ${node.state}`} aria-hidden="true" />
            {labels && <span className={`thread-label ${node.state}`}>{node.id}</span>}
          </>
        );
        return (
          <span key={node.id} className="thread-step" role="listitem">
            {node.path !== null && onOpen !== undefined ? (
              <button
                type="button"
                className="thread-hit"
                title={`${title} — открыть ${node.path}`}
                aria-label={`${title}, открыть файл`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(node.id, node.path);
                }}
                data-testid={`card-artifact-${card.change}-${node.id}`}
              >
                {content}
              </button>
            ) : (
              <span className="thread-hit" title={title} aria-label={title}>
                {content}
              </span>
            )}
            {segment}
          </span>
        );
      })}
      <span className="thread-seg plan" aria-hidden="true">
        <i className={thread.fill >= 100 ? 'complete' : undefined} style={{ width: `${thread.fill}%` }} />
      </span>
      <span className="thread-step" role="listitem">
        <span
          className="thread-hit"
          title={thread.archive === 'ready' ? 'Архив: готов к архивации' : 'Архив: не готов'}
          aria-label={thread.archive === 'ready' ? 'Архив: готов к архивации' : 'Архив: не готов'}
        >
          <span className={`thread-node archive ${thread.archive}`} aria-hidden="true" />
          {labels && <span className="thread-label">Архив</span>}
        </span>
      </span>
    </div>
  );
}
