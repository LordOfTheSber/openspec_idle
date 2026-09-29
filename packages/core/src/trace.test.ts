import { describe, expect, it } from 'vitest';
import { buildDeltaView } from './delta.js';
import {
  appendPlanItem,
  buildTrace,
  normalizeTraceName,
  planReferences,
  scenarioKey,
  splitReference,
} from './trace.js';

const IDE_RUNTIME = `## ADDED Requirements

### Requirement: Поиск CLI OpenSpec

Система ДОЛЖНА находить CLI.

#### Scenario: CLI установлен глобально, но не виден в PATH процесса

- **WHEN** CLI лежит в каталоге глобальной установки npm
- **THEN** CLI находится

#### Scenario: Путь скопирован из Git Bash

- **WHEN** задан путь вида /c/Users/dev
- **THEN** он переводится в путь Windows

## REMOVED Requirements

### Requirement: Конфигурация IDE

**Reason**: не нужна
**Migration**: удалить файл

#### Scenario: Чтение настроек при запуске

- **WHEN** IDE запускается
- **THEN** настройки читаются
`;

const VSCODE = `## MODIFIED Requirements

### Requirement: Путь к CLI OpenSpec в настройках

Расширение ДОЛЖНО брать путь из настройки.

#### Scenario: Путь исправлен в настройках

- **WHEN** пользователь указывает путь
- **THEN** бэкенд перезапускается

#### Scenario: Команда без CLI

- **WHEN** CLI не найден
- **THEN** показывается предупреждение
`;

const VIEWS = [buildDeltaView('ide-runtime', IDE_RUNTIME), buildDeltaView('vscode-extension', VSCODE)];

const PLAN = `# Tasks

## 1. Поиск

- [x] 1.1 Поиск CLI в каталогах npm; проверка — тесты locate
  ↳ ide-runtime / Поиск CLI OpenSpec
- [x] 1.2 Разбор путей: путь скопирован из Git Bash переводится в путь Windows

## 2. Настройка

- [ ] 2.1 Настройка cliPath
  -> vscode-extension / Путь исправлен в настройках
  ↳ vscode-extension / Несуществующий сценарий
`;

const key = (capability: string, requirement: string, scenario: string): string =>
  scenarioKey(capability, requirement, scenario);

describe('трассировка сценариев', () => {
  it('берёт сценарии ADDED и MODIFIED и пропускает REMOVED', () => {
    const trace = buildTrace(VIEWS, PLAN);

    expect(trace.scenarios.map((item) => item.name)).toEqual([
      'CLI установлен глобально, но не виден в PATH процесса',
      'Путь скопирован из Git Bash',
      'Путь исправлен в настройках',
      'Команда без CLI',
    ]);
  });

  it('ссылка на требование покрывает все его сценарии явно', () => {
    const trace = buildTrace(VIEWS, PLAN);
    const item = trace.items.find((entry) => entry.declaredNumber === '1.1');

    const linked = trace.links.filter((entry) => entry.item === item?.line);
    expect(linked.map((entry) => entry.kind)).toEqual(['explicit', 'explicit']);
    expect(linked.map((entry) => entry.scenario)).toEqual([
      key('ide-runtime', 'Поиск CLI OpenSpec', 'CLI установлен глобально, но не виден в PATH процесса'),
      key('ide-runtime', 'Поиск CLI OpenSpec', 'Путь скопирован из Git Bash'),
    ]);
  });

  it('без ссылок связь предполагается по названию сценария', () => {
    const trace = buildTrace(VIEWS, PLAN);
    const item = trace.items.find((entry) => entry.declaredNumber === '1.2');

    expect(trace.links.filter((entry) => entry.item === item?.line)).toEqual([
      { scenario: key('ide-runtime', 'Поиск CLI OpenSpec', 'Путь скопирован из Git Bash'), item: item?.line, kind: 'inferred' },
    ]);
  });

  it('ссылка стрелкой `->` тоже распознаётся, а висячая ссылка не покрывает ничего', () => {
    const trace = buildTrace(VIEWS, PLAN);
    const item = trace.items.find((entry) => entry.declaredNumber === '2.1');

    expect(item?.references.map((entry) => [entry.target, entry.resolved])).toEqual([
      ['Путь исправлен в настройках', true],
      ['Несуществующий сценарий', false],
    ]);
  });

  it('считает покрытие и оставляет непокрытый сценарий пробелом', () => {
    const trace = buildTrace(VIEWS, PLAN);

    expect(trace.covered).toHaveLength(3);
    expect(trace.covered).not.toContain(key('vscode-extension', 'Путь к CLI OpenSpec в настройках', 'Команда без CLI'));
  });

  it('у пункта с явной ссылкой связь по названию не предполагается', () => {
    const plan = `## 1. Работа

- [ ] 1.1 Путь скопирован из Git Bash и Команда без CLI
  ↳ vscode-extension / Команда без CLI
`;
    const trace = buildTrace(VIEWS, plan);

    expect(trace.links).toEqual([
      { scenario: key('vscode-extension', 'Путь к CLI OpenSpec в настройках', 'Команда без CLI'), item: 3, kind: 'explicit' },
    ]);
  });

  it('короткие названия по тексту пункта не сопоставляются', () => {
    const views = [
      buildDeltaView(
        'x',
        '## ADDED Requirements\n\n### Requirement: Экспорт\n\nДОЛЖНА.\n\n#### Scenario: Экспорт\n\n- **WHEN** a\n- **THEN** b\n',
      ),
    ];
    const trace = buildTrace(views, '## 1. Г\n\n- [ ] 1.1 Экспорт отчёта\n');

    expect(trace.links).toEqual([]);
  });

  it('без плана сценарии есть, а покрытия нет', () => {
    const trace = buildTrace(VIEWS, null);

    expect(trace.scenarios).toHaveLength(4);
    expect(trace.covered).toEqual([]);
  });
});

describe('разбор ссылок', () => {
  it('путь capability с косой чертой делится по « / »', () => {
    expect(splitReference('identity/user-auth / Вход по паролю')).toEqual({
      capability: 'identity/user-auth',
      target: 'Вход по паролю',
    });
    expect(splitReference('ide-runtime/Поиск')).toEqual({ capability: 'ide-runtime', target: 'Поиск' });
    expect(splitReference('без разделителя')).toBeNull();
  });

  it('ссылки относятся к ближайшему пункту выше и не переходят через заголовок группы', () => {
    const refs = planReferences('## 1. А\n\n↳ a / висячая до пунктов\n- [ ] 1.1 П\n  ↳ a / Б\n## 2. В\n  ↳ a / после заголовка\n');

    expect([...refs.entries()]).toEqual([[4, [{ line: 5, capability: 'a', target: 'Б' }]]]);
  });

  it('названия сравниваются без регистра, кавычек и ё', () => {
    expect(normalizeTraceName('  «Путь»  к  CLI, ЁЖ ')).toBe('путь к cli, еж');
  });
});

describe('дописывание пункта в план', () => {
  const entry = { capability: 'vscode-extension', target: 'Команда без CLI', title: 'Команда без CLI' };

  it('дописывает в конец последней группы с номером и ссылкой, не трогая остальное', () => {
    const result = appendPlanItem(PLAN, entry);
    const before = PLAN.split('\n');
    const after = result.text.split('\n');

    expect(result.number).toBe('2.2');
    expect(after[result.line - 1]).toBe('- [ ] 2.2 Команда без CLI');
    expect(after[result.line]).toBe('  ↳ vscode-extension / Команда без CLI');
    expect(after.length).toBe(before.length + 2);
    expect([...after.slice(0, result.line - 1), ...after.slice(result.line + 1)]).toEqual(before);
  });

  it('новый пункт покрывает сценарий', () => {
    const result = appendPlanItem(PLAN, entry);

    expect(buildTrace(VIEWS, result.text).covered).toHaveLength(4);
  });

  it('встаёт перед следующей группой, если последняя группа не в конце файла', () => {
    const plan = '## 1. А\n\n- [ ] 1.1 Первый\n\n## 2. Б\n\n- [ ] 2.1 Второй\n  продолжение\n\nЗаметка в конце\n';
    const result = appendPlanItem(plan, entry);

    expect(result.text).toBe(
      '## 1. А\n\n- [ ] 1.1 Первый\n\n## 2. Б\n\n- [ ] 2.1 Второй\n  продолжение\n- [ ] 2.2 Команда без CLI\n  ↳ vscode-extension / Команда без CLI\n\nЗаметка в конце\n',
    );
  });

  it('в пустую группу пишет первый пункт', () => {
    const result = appendPlanItem('## 1. Работа\n\n', entry);

    expect(result.text).toBe('## 1. Работа\n\n- [ ] 1.1 Команда без CLI\n  ↳ vscode-extension / Команда без CLI\n');
    expect(result.line).toBe(3);
  });

  it('без групп дописывает пункт без номера в конец файла', () => {
    const result = appendPlanItem('# План\n\n- [ ] Сделать\n', entry);

    expect(result.number).toBeNull();
    expect(result.text).toBe('# План\n\n- [ ] Сделать\n- [ ] Команда без CLI\n  ↳ vscode-extension / Команда без CLI\n');
  });
});
