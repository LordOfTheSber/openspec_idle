import { describe, expect, it } from 'vitest';
import {
  type AuthoringEdit,
  type AuthoringSources,
  authoringIssues,
  codeActions,
  codeLenses,
  completions,
  definition,
  documentKind,
  hover,
  planSymbols,
  workspaceSymbols,
} from './authoring.js';

const MAIN = [
  '# data-export',
  '',
  '## Purpose',
  '',
  'Выгрузка данных пользователя.',
  '',
  '## Requirements',
  '',
  '### Requirement: Выгрузка данных',
  '',
  'Система ДОЛЖНА (SHALL) выгружать данные в CSV.',
  '',
  '#### Scenario: Успешная выгрузка',
  '',
  '- **WHEN** пользователь запрашивает выгрузку',
  '- **THEN** отдаётся файл CSV',
  '',
  '#### Scenario: Пустой набор данных',
  '',
  '- **WHEN** данных нет',
  '- **THEN** отдаётся пустой файл',
  '',
  '### Requirement: Кодировка файла',
  '',
  'Система ДОЛЖНА (SHALL) отдавать UTF-8.',
  '',
  '#### Scenario: Кодировка выгрузки',
  '',
  '- **WHEN** файл отдан',
  '- **THEN** он в UTF-8',
  '',
].join('\n');

const DELTA = [
  '# Spec Delta: data-export', // 1
  '', // 2
  '## MODIFIED Requirements', // 3
  '', // 4
  '### Requirement: Выгрузка данных', // 5
  '', // 6
  'Система ДОЛЖНА (SHALL) выгружать данные с ограничением.', // 7
  '', // 8
  '#### Scenario: Успешная выгрузка', // 9
  '', // 10
  '- **WHEN** пользователь запрашивает выгрузку', // 11
  '- **THEN** отдаётся файл CSV', // 12
  '', // 13
  '## ADDED Requirements', // 14
  '', // 15
  '### Requirement: Ограничение объёма', // 16
  '', // 17
  'Система ДОЛЖНА (SHALL) ограничивать объём.', // 18
  '', // 19
  '#### Scenario: Превышен объём', // 20
  '', // 21
  '- **WHEN** объём превышает предел', // 22
  '- **THEN** выгрузка разбивается на части', // 23
  '', // 24
].join('\n');

const PLAN = [
  '## 1. Ядро', // 1
  '', // 2
  '- [x] 1.1 Ограничить объём выгрузки', // 3
  '  ↳ data-export / Превышен объём', // 4
  '- [ ] 1.2 Что-то ещё', // 5
  '', // 6
  '## 2. Документация', // 7
  '', // 8
  '- [ ] 2.1 README', // 9
  '', // 10
].join('\n');

const SPEC_PATH = 'openspec/specs/data-export/spec.md';
const DELTA_PATH = 'openspec/changes/add-limits/specs/data-export/spec.md';
const PLAN_PATH = 'openspec/changes/add-limits/tasks.md';

function sources(overrides: { delta?: string; plan?: string | null; main?: string | null } = {}): AuthoringSources {
  const main = overrides.main === undefined ? MAIN : overrides.main;
  const plan = overrides.plan === undefined ? PLAN : overrides.plan;
  return {
    mainSpecs: main === null ? [] : [{ capability: 'data-export', path: SPEC_PATH, text: main }],
    changes: [
      {
        name: 'add-limits',
        deltas: [{ capability: 'data-export', path: DELTA_PATH, text: overrides.delta ?? DELTA }],
        plan: plan === null ? null : { path: PLAN_PATH, text: plan },
      },
    ],
  };
}

function apply(text: string, edits: readonly AuthoringEdit[]): string {
  const lines = text.split('\n');
  const offset = (line: number, character: number): number =>
    lines.slice(0, line - 1).reduce((sum, item) => sum + item.length + 1, 0) + character;
  let result = text;
  for (const edit of [...edits].sort((a, b) => offset(b.range.startLine, b.range.startCharacter) - offset(a.range.startLine, a.range.startCharacter))) {
    const start = offset(edit.range.startLine, edit.range.startCharacter);
    const end = offset(edit.range.endLine, edit.range.endCharacter);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}

function replaceLine(text: string, line: number, value: string): string {
  const lines = text.split('\n');
  lines[line - 1] = value;
  return lines.join('\n');
}

describe('вид документа', () => {
  it('различает основной спек, дельту и план, а предложение change не обслуживает', () => {
    const all = sources();
    expect(documentKind(all, SPEC_PATH)).toEqual({ kind: 'spec', capability: 'data-export' });
    expect(documentKind(all, DELTA_PATH)).toEqual({ kind: 'delta', change: 'add-limits', capability: 'data-export' });
    expect(documentKind(all, 'openspec\\changes\\add-limits\\tasks.md')).toEqual({ kind: 'plan', change: 'add-limits' });
    expect(documentKind(all, 'openspec/changes/add-limits/proposal.md')).toBeNull();
    expect(completions(all, 'openspec/changes/add-limits/proposal.md', '', 1, 0)).toEqual([]);
    expect(codeLenses(all, 'openspec/changes/add-limits/proposal.md', '')).toEqual([]);
  });
});

describe('структура плана и символы', () => {
  it('структура плана: группы с пунктами, выполненные отмечены', () => {
    const symbols = planSymbols(PLAN);
    expect(symbols.map((symbol) => symbol.name)).toEqual(['1. Ядро', '2. Документация']);
    expect(symbols[0]?.detail).toBe('1/2');
    expect(symbols[0]?.children.map((child) => [child.name, child.detail])).toEqual([
      ['1.1 Ограничить объём выгрузки', '✓ выполнен · ссылок: 1'],
      ['1.2 Что-то ещё', 'не выполнен'],
    ]);
    expect(symbols[0]?.endLine).toBe(6);
    expect(symbols[0]?.children[0]?.endLine).toBe(4);
  });

  it('поиск требования по проекту находит основной спек и версию в дельте', () => {
    const found = workspaceSymbols(sources(), 'выгрузка');
    const requirements = found.filter((item) => item.kind === 'requirement');
    expect(requirements.map((item) => [item.name, item.container, item.location.line])).toEqual([
      ['Выгрузка данных', 'data-export', 9],
      ['Выгрузка данных', 'data-export · MODIFIED · add-limits', 5],
    ]);
    expect(found.some((item) => item.kind === 'scenario' && item.name === 'Успешная выгрузка')).toBe(true);
  });
});

describe('дополнения в дельте', () => {
  it('имя для MODIFIED — требования основного спека, кроме уже изменённых', () => {
    const text = replaceLine(DELTA, 13, '### Requirement: ');
    const items = completions(sources(), DELTA_PATH, text, 13, '### Requirement: '.length);
    const names = items.filter((item) => item.kind === 'requirement').map((item) => item.label);
    expect(names).toEqual(['Кодировка файла']);
    expect(items.find((item) => item.label === 'Кодировка файла')?.replaceFrom).toBe('### Requirement: '.length);
  });

  it('в секции ADDED имена основного спека не предлагаются', () => {
    const text = replaceLine(DELTA, 24, '### Requirement: ');
    const items = completions(sources(), DELTA_PATH, text, 24, '### Requirement: '.length);
    expect(items.filter((item) => item.kind === 'requirement')).toEqual([]);
  });

  it('без основного спека — только заголовки секций и шаблоны', () => {
    const items = completions(sources({ main: null }), DELTA_PATH, replaceLine(DELTA, 13, '##'), 13, 2);
    expect(items.map((item) => item.kind).sort()).toEqual(['section', 'section', 'section', 'section', 'template', 'template']);
    expect(items.find((item) => item.kind === 'section')?.insertText).toBe('## ADDED Requirements');
    const names = completions(sources({ main: null }), DELTA_PATH, replaceLine(DELTA, 13, '### Requirement: '), 13, 17);
    expect(names.filter((item) => item.kind === 'requirement')).toEqual([]);
  });

  it('в RENAMED после FROM: предлагается заголовок в обратных кавычках', () => {
    const text = `${DELTA}\n## RENAMED Requirements\n\n- FROM: `;
    const line = text.split('\n').length;
    const items = completions(sources(), DELTA_PATH, text, line, '- FROM: '.length);
    expect(items.filter((item) => item.kind === 'requirement').map((item) => item.insertText)).toEqual([
      '`### Requirement: Выгрузка данных`',
      '`### Requirement: Кодировка файла`',
    ]);
  });

  it('шаблон требования — сниппет с ДОЛЖНА и сценарием WHEN/THEN', () => {
    const template = completions(sources(), SPEC_PATH, MAIN, 8, 0).find((item) => item.label === 'Требование со сценарием');
    expect(template?.snippet).toBe(true);
    expect(template?.insertText).toContain('ДОЛЖНА (SHALL)');
    expect(template?.insertText).toContain('- **WHEN**');
  });
});

describe('дополнение ссылки в плане', () => {
  it('после ↳ предлагает требования и сценарии ADDED и MODIFIED дельт change', () => {
    const text = replaceLine(PLAN, 6, '  ↳ ');
    const items = completions(sources(), PLAN_PATH, text, 6, 4);
    expect(items.map((item) => item.label)).toEqual([
      'data-export / Ограничение объёма',
      'data-export / Превышен объём',
      'data-export / Выгрузка данных',
      'data-export / Успешная выгрузка',
    ]);
    expect(items[0]?.replaceFrom).toBe(4);
  });
});

describe('проверка ссылок дельты', () => {
  it('опечатка в MODIFIED — ошибка на строке заголовка с похожим именем', () => {
    const text = replaceLine(DELTA, 5, '### Requirement: Выгрузка даных');
    const issues = authoringIssues(sources({ delta: text }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: DELTA_PATH, line: 5, level: 'error', code: 'delta/missing-target' });
    expect(issues[0]?.message).toContain('«Выгрузка данных»');
  });

  it('имя, отличающееся регистром, — ошибка, похожее имя первым', () => {
    const text = replaceLine(DELTA, 5, '### Requirement: выгрузка   данных');
    const [issue] = authoringIssues(sources({ delta: text }));
    expect(issue?.code).toBe('delta/missing-target');
    expect(issue?.suggestions[0]).toBe('Выгрузка данных');
  });

  it('ADDED существующего требования — ошибка', () => {
    const text = replaceLine(DELTA, 16, '### Requirement: Кодировка файла');
    const [issue] = authoringIssues(sources({ delta: text }));
    expect(issue).toMatchObject({ line: 16, code: 'delta/already-exists' });
    expect(issue?.message).toContain('архивация откажет');
  });

  it('RENAMED: FROM несуществующего — на строке FROM, TO существующего — на строке TO', () => {
    const text = `${DELTA}\n## RENAMED Requirements\n\n- FROM: \`### Requirement: Нет такого\`\n- TO: \`### Requirement: Кодировка файла\`\n`;
    const issues = authoringIssues(sources({ delta: text }));
    const lines = text.split('\n');
    expect(issues.map((issue) => [issue.code, lines[issue.line - 1]?.slice(0, 7)])).toEqual([
      ['delta/missing-target', '- FROM:'],
      ['delta/already-exists', '- TO: `'],
    ]);
  });

  it('MODIFIED без основного спека — ошибка «спека нет»', () => {
    const issues = authoringIssues(sources({ main: null }));
    expect(issues.map((issue) => issue.code)).toEqual(['delta/missing-spec']);
  });

  it('исправная дельта замечаний не даёт, заголовок в блоке кода не считается', () => {
    expect(authoringIssues(sources())).toEqual([]);
    const fenced = `${DELTA}\n\`\`\`\n### Requirement: Кодировка файла\n\`\`\`\n`;
    expect(authoringIssues(sources({ delta: fenced }))).toEqual([]);
  });
});

describe('ссылки плана', () => {
  it('висячая ссылка — предупреждение на строке ссылки', () => {
    const plan = replaceLine(PLAN, 4, '  ↳ data-export / Нет такого сценария');
    const issues = authoringIssues(sources({ plan }));
    expect(issues).toEqual([
      expect.objectContaining({ path: PLAN_PATH, line: 4, level: 'warning', code: 'plan/unresolved-reference' }),
    ]);
    expect(authoringIssues(sources({ plan }), DELTA_PATH)).toEqual([]);
  });

  it('переход к сценарию открывает дельту на строке сценария', () => {
    expect(definition(sources(), PLAN_PATH, PLAN, 4)).toEqual([{ path: DELTA_PATH, line: 20 }]);
  });

  it('наведение показывает требование и шаги сценария', () => {
    const text = hover(sources(), PLAN_PATH, PLAN, 4);
    expect(text).toContain('data-export / Ограничение объёма');
    expect(text).toContain('#### Scenario: Превышен объём');
    expect(text).toContain('- **WHEN** объём превышает предел');
    expect(hover(sources(), PLAN_PATH, PLAN, 3)).toBeNull();
  });

  it('ссылка на требование ведёт к его заголовку', () => {
    const plan = replaceLine(PLAN, 4, '  ↳ data-export / Ограничение объёма');
    expect(definition(sources({ plan }), PLAN_PATH, plan, 4)).toEqual([{ path: DELTA_PATH, line: 16 }]);
  });
});

describe('быстрые исправления', () => {
  it('замена имени на похожее снимает ошибку', () => {
    const text = replaceLine(DELTA, 5, '### Requirement: Выгрузка даных');
    const [action] = codeActions(sources({ delta: text }), DELTA_PATH, text, 5);
    expect(action?.title).toBe('Заменить на «Выгрузка данных»');
    const fixed = apply(text, action?.edits ?? []);
    expect(fixed.split('\n')[4]).toBe('### Requirement: Выгрузка данных');
    expect(authoringIssues(sources({ delta: fixed }))).toEqual([]);
  });

  it('копирование требования ставит тело основного спека и не трогает строки вне блока', () => {
    const actions = codeActions(sources(), DELTA_PATH, DELTA, 5);
    const copy = actions.find((action) => action.title === 'Скопировать требование из основного спека');
    expect(copy).toBeDefined();
    const result = apply(DELTA, copy?.edits ?? []);
    const lines = result.split('\n');

    expect(lines.slice(0, 5)).toEqual(DELTA.split('\n').slice(0, 5));
    const added = lines.indexOf('## ADDED Requirements');
    expect(lines.slice(added)).toEqual(DELTA.split('\n').slice(13));
    const block = lines.slice(5, added).join('\n');
    expect(block).toContain('#### Scenario: Пустой набор данных');
    expect(block).toContain('Система ДОЛЖНА (SHALL) выгружать данные в CSV.');
    expect(block).not.toContain('с ограничением');
  });

  it('копирование последнего требования файла сохраняет перевод строки в конце', () => {
    const text = '## MODIFIED Requirements\n\n### Requirement: Кодировка файла\n\nСтарый текст.\n';
    const all = sources({ delta: text });
    const copy = codeActions(all, DELTA_PATH, text, 3).find((action) => action.title.startsWith('Скопировать'));
    const result = apply(text, copy?.edits ?? []);
    expect(result).toBe(
      '## MODIFIED Requirements\n\n### Requirement: Кодировка файла\n\nСистема ДОЛЖНА (SHALL) отдавать UTF-8.\n\n#### Scenario: Кодировка выгрузки\n\n- **WHEN** файл отдан\n- **THEN** он в UTF-8\n',
    );
  });

  it('для ADDED исправлений нет', () => {
    expect(codeActions(sources(), DELTA_PATH, DELTA, 16)).toEqual([]);
  });
});

describe('подсказки над строками', () => {
  it('непокрытое требование — «добавить пункт», покрытое — число пунктов, изменённое — переход к основному спеку', () => {
    const lenses = codeLenses(sources(), DELTA_PATH, DELTA);
    expect(lenses.map((lens) => [lens.line, lens.title])).toEqual([
      [5, 'Не покрыт планом — добавить пункт'],
      [5, 'Основной спек'],
      [16, 'Пунктов плана: 1'],
    ]);
    expect(lenses[0]?.action).toEqual({
      kind: 'add-plan-item',
      change: 'add-limits',
      capability: 'data-export',
      requirement: 'Выгрузка данных',
    });
    expect(lenses[1]?.action).toEqual({ kind: 'open', location: { path: SPEC_PATH, line: 9 } });
    expect(lenses[2]?.action).toEqual({ kind: 'open', location: { path: PLAN_PATH, line: 3 } });
  });

  it('без плана «добавить пункт» не предлагается', () => {
    const lenses = codeLenses(sources({ plan: null }), DELTA_PATH, DELTA);
    expect(lenses.map((lens) => lens.title)).toEqual(['Основной спек']);
  });

  it('над пунктом плана — число покрытых сценариев', () => {
    const lenses = codeLenses(sources(), PLAN_PATH, PLAN);
    expect(lenses).toEqual([
      { line: 3, title: 'Покрывает сценариев: 1', action: { kind: 'open', location: { path: DELTA_PATH, line: 20 } } },
    ]);
  });
});
