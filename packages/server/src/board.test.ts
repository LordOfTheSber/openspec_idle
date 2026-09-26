import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardService, ChangeOperationError } from './board.js';
import { canonicalize } from './fs/workspace.js';
import { OpenspecClient } from './openspec/client.js';
import { SchemaReader } from './schemaDefinition.js';
import { WorkspaceReader } from './workspace.js';

const OPENSPEC_BIN = fileURLToPath(new URL('../../../node_modules/.bin/openspec', import.meta.url));

let root: string;

function service(fixture: string): BoardService {
  const source = fileURLToPath(new URL(`../../../tests/fixtures/${fixture}`, import.meta.url));
  cpSync(source, root, { recursive: true });
  const client = new OpenspecClient({ root, bin: OPENSPEC_BIN });
  return new BoardService(
    client,
    new WorkspaceReader(client),
    new SchemaReader(client),
    OPENSPEC_BIN,
  );
}

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-board-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('доска на встроенной схеме', () => {
  it('колонки идут по зависимостям артефактов', async () => {
    const board = await service('full-change').readBoard();

    expect(board.columns.map((column) => column.id)).toEqual([
      'proposal',
      'specs',
      'design',
      'tasks',
      'ready',
      'in-progress',
      'to-archive',
    ]);
  });

  it('change с частично выполненными пунктами стоит в колонке «В работе»', async () => {
    const board = await service('full-change').readBoard();
    const card = board.cards.find((item) => item.change === 'full-feature');

    expect(card?.column).toBe('in-progress');
    expect(card?.progress).toEqual({ complete: 2, total: 4 });
    expect(card?.schema).toBe('spec-driven');
  });

  it('метка артефакта на карточке знает путь его файла', async () => {
    const board = await service('full-change').readBoard();
    const card = board.cards.find((item) => item.change === 'full-feature');

    expect(card?.artifacts.find((artifact) => artifact.id === 'proposal')?.path).toBe(
      'openspec/changes/full-feature/proposal.md',
    );
  });

  it('у несозданного артефакта пути нет', async () => {
    const board = await service('bare-change').readBoard();
    const card = board.cards.find((item) => item.change === 'bare-feature');

    expect(card?.artifacts.every((artifact) => artifact.path === null)).toBe(true);
  });

  it('change без артефактов стоит в колонке первого артефакта и не проверялся', async () => {
    const board = await service('bare-change').readBoard();
    const card = board.cards.find((item) => item.change === 'bare-feature');

    expect(card?.column).toBe('proposal');
    expect(card?.validationUnknown).toBe(true);
  });
});

describe('доска на собственной схеме', () => {
  it('колонки берутся из её артефактов', async () => {
    const board = await service('custom-schema').readBoard();
    const ids = board.columns.filter((column) => column.isArtifact).map((column) => column.id);

    expect(ids).toEqual(['research', 'proposal', 'specs', 'spec-review', 'design', 'plan']);
  });

  it('прогресс считается по её отслеживаемому артефакту', async () => {
    const board = await service('custom-schema').readBoard();
    const card = board.cards.find((item) => item.change === 'team-feature');

    expect(card?.schema).toBe('team-flow');
    expect(card?.progress).toEqual({ complete: 1, total: 3 });
    expect(card?.column).toBe('in-progress');
  });
});

describe('отказы от правил SDD на доске', () => {
  it('карточка change несёт действующие отказы его схемы', async () => {
    const boards = service('custom-schema');
    const path = join(root, 'openspec/schemas/team-flow/schema.yaml');
    writeFileSync(
      path,
      `${readFileSync(path, 'utf8')}sdd_waivers:\n  - rule: sdd/motivation-first\n    reason: Исследование заменяет предложение\n  - rule: sdd/reachable\n`,
    );
    const board = await boards.readBoard();
    const card = board.cards.find((item) => item.change === 'team-feature');

    // Отказ без причины не действует и на карточку не попадает.
    expect(card?.waivers).toEqual([
      { rule: 'sdd/motivation-first', reason: 'Исследование заменяет предложение' },
    ]);
  });

  it('у схемы без отказов признака нет', async () => {
    const board = await service('full-change').readBoard();
    expect(board.cards.every((card) => card.waivers.length === 0)).toBe(true);
  });
});

describe('операции над change', () => {
  it('создаёт change выбранной схемой', async () => {
    const instance = service('custom-schema');

    await instance.createChange('new-feature', 'team-flow');

    expect(existsSync(join(root, 'openspec/changes/new-feature/.openspec.yaml'))).toBe(true);
    const board = await instance.readBoard();
    const card = board.cards.find((item) => item.change === 'new-feature');
    expect(card?.schema).toBe('team-flow');
    expect(card?.column).toBe('research');
  });

  it('недопустимое имя change отклоняется с выводом команды', async () => {
    const instance = service('full-change');

    await expect(instance.createChange('Недопустимое Имя С Пробелами')).rejects.toThrow(
      ChangeOperationError,
    );
  });

  it('архивация переносит change в архив и обновляет спеки', async () => {
    const instance = service('full-change');
    // Архивация требует выполненных пунктов и валидного change.
    const tasks = join(root, 'openspec/changes/full-feature/tasks.md');
    const text = readFileSync(tasks, 'utf8').replace(/- \[ \]/g, '- [x]');
    writeFileSync(tasks, text);

    await instance.archiveChange('full-feature');

    expect(existsSync(join(root, 'openspec/specs/data-export/spec.md'))).toBe(true);
    expect(existsSync(join(root, 'openspec/changes/full-feature'))).toBe(false);
  });

  it('ошибка архивации не меняет состояния и отдаёт вывод команды', async () => {
    const instance = service('full-change');

    await expect(instance.archiveChange('нет-такого')).rejects.toThrow(ChangeOperationError);
    expect(existsSync(join(root, 'openspec/changes/full-feature'))).toBe(true);
  });
});

describe('пункты отслеживаемого артефакта', () => {
  it('отдаёт пункты с их строками и прогрессом', async () => {
    const items = await service('full-change').readTrackedItems('full-feature');

    expect(items.path).toBe('openspec/changes/full-feature/tasks.md');
    expect(items.total).toBe(4);
    expect(items.complete).toBe(2);
    expect(items.items[0]?.declaredNumber).toBe('1.1');
  });

  it('отметка меняет только скобки чекбокса', async () => {
    const instance = service('full-change');
    const path = join(root, 'openspec/changes/full-feature/tasks.md');
    const before = readFileSync(path, 'utf8');

    const items = await instance.readTrackedItems('full-feature');
    const pending = items.items.find((item) => !item.done);
    expect(pending).toBeDefined();
    if (pending === undefined) return;

    const after = await instance.toggleItem('full-feature', pending.line, true);

    expect(after.complete).toBe(3);
    const text = readFileSync(path, 'utf8');
    const beforeLines = before.split('\n');
    const afterLines = text.split('\n');
    for (let index = 0; index < beforeLines.length; index += 1) {
      if (index === pending.line - 1) continue;
      expect(afterLines[index]).toBe(beforeLines[index]);
    }
  });

  it('на собственной схеме отметка пишется в её отслеживаемый файл', async () => {
    const instance = service('custom-schema');
    const items = await instance.readTrackedItems('team-feature');

    expect(items.path).toBe('openspec/changes/team-feature/plan.md');

    const pending = items.items.find((item) => !item.done);
    if (pending === undefined) return;
    await instance.toggleItem('team-feature', pending.line, true);

    const text = readFileSync(join(root, 'openspec/changes/team-feature/plan.md'), 'utf8');
    expect(text.split('\n')[pending.line - 1]).toContain('[x]');
    // Файл tasks.md встроенной схемы при этом не появляется.
    expect(existsSync(join(root, 'openspec/changes/team-feature/tasks.md'))).toBe(false);
  });

  it('снятие отметки пересчитывает прогресс', async () => {
    const instance = service('full-change');
    const items = await instance.readTrackedItems('full-feature');
    const done = items.items.find((item) => item.done);
    if (done === undefined) return;

    const after = await instance.toggleItem('full-feature', done.line, false);
    expect(after.complete).toBe(1);
  });
});
