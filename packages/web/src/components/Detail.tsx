import type { WorkspaceTree } from '@openspec-ide/core';
import type { Selection } from './Tree.js';

const STATE_LABEL: Record<string, string> = {
  missing: 'отсутствует',
  draft: 'черновик',
  done: 'заполнен',
  invalid: 'не проходит валидацию',
};

export function Detail({
  tree,
  selection,
}: {
  readonly tree: WorkspaceTree;
  readonly selection: Selection | null;
}) {
  if (selection === null) {
    return <p className="empty">Выберите элемент в дереве слева.</p>;
  }

  if (selection.kind === 'change' || selection.kind === 'artifact') {
    const changeName = selection.kind === 'change' ? selection.id : (selection.parent ?? '');
    const change = tree.changes.find((item) => item.name === changeName);
    if (change === undefined) return <p className="empty">Изменение не найдено.</p>;

    if (selection.kind === 'change') {
      return (
        <div className="detail">
          <p className="pane-title">
            Изменение <span className="count">{change.schema}</span>
          </p>
          <dl>
            <dt>Схема</dt>
            <dd>{change.schema}</dd>
            <dt>Артефактов</dt>
            <dd>{change.artifacts.length}</dd>
            <dt>Прогресс</dt>
            <dd>
              {change.progress === null || change.progress.total === 0
                ? 'нет отслеживаемых пунктов'
                : `${change.progress.complete}/${change.progress.total}`}
            </dd>
            <dt>Ошибок валидации</dt>
            <dd>{change.errorCount}</dd>
          </dl>
        </div>
      );
    }

    const artifact = change.artifacts.find((item) => item.id === selection.id);
    if (artifact === undefined) return <p className="empty">Артефакт не найден.</p>;

    return (
      <div className="detail">
        <p className="pane-title">
          Артефакт <span className="count">{artifact.id}</span>
        </p>
        <dl>
          <dt>Состояние</dt>
          <dd data-testid="artifact-state">{STATE_LABEL[artifact.state] ?? artifact.state}</dd>
          <dt>Порождает</dt>
          <dd>{artifact.outputPath}</dd>
          <dt>Файлов на диске</dt>
          <dd>{artifact.files.length}</dd>
          {artifact.progress !== null && (
            <>
              <dt>Прогресс</dt>
              <dd>
                {artifact.progress.complete}/{artifact.progress.total}
              </dd>
            </>
          )}
        </dl>
      </div>
    );
  }

  if (selection.kind === 'schema') {
    const schema = tree.schemas.find((item) => item.name === selection.id);
    if (schema === undefined) return <p className="empty">Процесс не найден.</p>;
    return (
      <div className="detail">
        <p className="pane-title">
          Процесс <span className="count">{schema.source}</span>
        </p>
        <dl>
          <dt>Артефакты</dt>
          <dd>{schema.artifacts.join(' → ')}</dd>
          <dt>Источник</dt>
          <dd>{schema.source}</dd>
          <dt>По умолчанию</dt>
          <dd>{schema.isDefault ? 'да' : 'нет'}</dd>
        </dl>
      </div>
    );
  }

  return (
    <div className="detail">
      <p className="pane-title">{selection.kind === 'capability' ? 'Capability' : 'Архив'}</p>
      <dl>
        <dt>Путь</dt>
        <dd>{selection.id}</dd>
      </dl>
    </div>
  );
}
