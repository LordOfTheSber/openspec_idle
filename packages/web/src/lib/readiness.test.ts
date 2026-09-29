import { describe, expect, it } from 'vitest';
import { readiness } from './readiness.js';

describe('готовность к архивации', () => {
  it('артефакты, план и чистая валидация при покрытии 4/5 и без предпросмотра — 3 из 5', () => {
    const result = readiness({
      artifacts: { done: 4, total: 4 },
      plan: { complete: 7, total: 7 },
      validationErrors: 0,
      coverage: { covered: 4, total: 5 },
      preview: null,
    });

    expect(result.passed).toBe(3);
    expect(result.checks.find((check) => check.id === 'coverage')).toMatchObject({ state: 'fail', detail: '4/5' });
    expect(result.checks.find((check) => check.id === 'preview')?.state).toBe('unknown');
  });

  it('всё выполнено — 5 из 5', () => {
    const result = readiness({
      artifacts: { done: 4, total: 4 },
      plan: { complete: 3, total: 3 },
      validationErrors: 0,
      coverage: { covered: 0, total: 0 },
      preview: 'ready',
    });

    expect(result.passed).toBe(5);
  });

  it('план без пунктов и валидация с ошибками не выполнены', () => {
    const result = readiness({
      artifacts: { done: 2, total: 4 },
      plan: { complete: 0, total: 0 },
      validationErrors: 2,
      coverage: null,
      preview: 'refused',
    });

    expect(result.passed).toBe(0);
    expect(result.checks.map((check) => check.detail)).toEqual(['2/4', 'нет пунктов', 'ошибок: 2', '…', 'CLI отклонит']);
  });
});
