import { buildDeltaView, buildTrace } from '@openspec-ide/core';
import { describe, expect, it } from 'vitest';
import { SLOT_GAP, SLOT_HEIGHT, agentTask, layoutTrace, parseStep } from './traceLayout.js';

const SPEC = `## ADDED Requirements

### Requirement: Путь к CLI OpenSpec в настройках

ДОЛЖНО.

#### Scenario: Путь исправлен в настройках

- **WHEN** пользователь указывает путь
- **THEN** бэкенд перезапускается

#### Scenario: Команда без CLI

- **WHEN** CLI не найден
- **THEN** показывается предупреждение
`;

const PLAN = `## 1. Работа

- [x] 1.1 Настройка
  ↳ vscode-extension / Путь исправлен в настройках
- [ ] 1.2 README
`;

const trace = buildTrace([buildDeltaView('vscode-extension', SPEC)], PLAN);

describe('раскладка трассировки', () => {
  it('группа требования, сценарии, пункт, свободный пункт и пробел', () => {
    const layout = layoutTrace(trace);

    expect(layout.groups.map((group) => group.requirement)).toEqual(['Путь к CLI OpenSpec в настройках']);
    expect(layout.scenarios.map((box) => box.covered)).toEqual([true, false]);
    expect(layout.slots.map((slot) => (slot.kind === 'item' ? slot.item.declaredNumber : 'gap'))).toEqual(['1.1', 'gap', '1.2']);
    expect(layout.edges.map((edge) => edge.kind)).toEqual(['explicit', 'gap']);
  });

  it('места не перекрываются', () => {
    const layout = layoutTrace(trace);
    for (let index = 1; index < layout.slots.length; index += 1) {
      const previous = layout.slots[index - 1];
      const current = layout.slots[index];
      expect((current?.y ?? 0) - (previous?.y ?? 0)).toBeGreaterThanOrEqual(SLOT_HEIGHT + SLOT_GAP);
    }
  });

  it('«Только пробелы» оставляет непокрытые сценарии без пунктов плана', () => {
    const layout = layoutTrace(trace, true);

    expect(layout.scenarios.map((box) => box.scenario.name)).toEqual(['Команда без CLI']);
    expect(layout.slots.map((slot) => slot.kind)).toEqual(['gap']);
  });
});

describe('шаги и задача для агента', () => {
  it('шаг WHEN переводится в «КОГДА»', () => {
    expect(parseStep('- **WHEN** CLI не найден')).toEqual({ label: 'КОГДА', text: 'CLI не найден' });
    expect(parseStep('- просто текст')).toEqual({ label: '', text: 'просто текст' });
  });

  it('задача содержит сценарий, шаги и пути @файл', () => {
    const scenario = trace.scenarios[1];
    if (scenario === undefined) throw new Error('нет сценария');
    const text = agentTask('fix-cli', scenario, 'openspec/changes/fix-cli/tasks.md');

    expect(text).toContain('сценарий «Команда без CLI»');
    expect(text).toContain('- КОГДА: CLI не найден');
    expect(text).toContain('↳ vscode-extension / Команда без CLI');
    expect(text).toContain('@openspec/changes/fix-cli/specs/vscode-extension/spec.md');
    expect(text.endsWith('@openspec/changes/fix-cli/tasks.md')).toBe(true);
  });
});
