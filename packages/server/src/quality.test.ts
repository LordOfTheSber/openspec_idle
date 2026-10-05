import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QualityOverview } from '@openspec-ide/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURES_ROOT } from '../../../tests/fixtures.js';
import { type EmbeddedBackend, createEmbeddedBackend } from './embedded.js';
import { canonicalize } from './fs/workspace.js';

let root: string | null = null;
let backend: EmbeddedBackend | null = null;

afterEach(async () => {
  await backend?.close();
  backend = null;
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

const DELTA = 'openspec/changes/full-feature/specs/data-export/spec.md';

async function open(): Promise<{ dir: string; api: EmbeddedBackend }> {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-quality-')));
  cpSync(join(FIXTURES_ROOT, 'full-change'), root, { recursive: true });
  writeFileSync(
    join(root, DELTA),
    [
      '# Spec Delta: data-export',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Выгрузка данных',
      '',
      'Система ДОЛЖНА (SHALL) выгружать данные в валидном формате CSV.',
      '',
      '#### Scenario: Успешная выгрузка',
      '',
      '- **WHEN** пользователь запрашивает выгрузку',
      '- **THEN** отдаётся файл CSV',
      '',
    ].join('\n'),
  );
  backend = await createEmbeddedBackend({ root, watch: false, metrics: false });
  return { dir: root, api: backend };
}

async function call<T>(api: EmbeddedBackend, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const reply = await api.request(method, path, body);
  return { status: reply.status, body: reply.body as T };
}

describe('раздел «Качество»: маршруты', () => {
  it('сводка: правила, файлы, changes и признак отсутствия настроек', async () => {
    const { api } = await open();
    const { status, body } = await call<QualityOverview>(api, 'GET', '/api/quality');
    expect(status).toBe(200);
    expect(body.config).toMatchObject({ exists: false, path: 'openspec/quality.yaml' });
    expect(body.rules.find((rule) => rule.id === 'vague-wording')).toMatchObject({ counts: { warning: 1 }, level: 'warning', configured: false });
    expect(body.files[0]).toMatchObject({ path: DELTA, kind: 'delta', change: 'full-feature', counts: { warning: 1 } });
    expect(body.changes).toContainEqual({ name: 'full-feature', error: 0, warning: 1, info: 0 });
  });

  it('уровень правила записывается в rules, null возвращает умолчание; комментарии сохраняются', async () => {
    const { dir, api } = await open();
    expect((await call<QualityOverview>(api, 'POST', '/api/quality/init')).status).toBe(200);
    expect((await call<{ error: string }>(api, 'POST', '/api/quality/init')).status).toBe(409);

    const off = await call<QualityOverview>(api, 'POST', '/api/quality/rule', { rule: 'vague-wording', level: 'off' });
    expect(off.body.rules.find((rule) => rule.id === 'vague-wording')).toMatchObject({ level: 'off', configured: true, counts: { warning: 0 } });
    const text = readFileSync(join(dir, 'openspec/quality.yaml'), 'utf8');
    expect(text).toContain('vague-wording: off');
    expect(text).toContain('# Настройки проверки качества спеков');

    const reset = await call<QualityOverview>(api, 'POST', '/api/quality/rule', { rule: 'vague-wording', level: null });
    expect(reset.body.rules.find((rule) => rule.id === 'vague-wording')).toMatchObject({ level: 'warning', configured: false, counts: { warning: 1 } });

    expect((await call<{ error: string }>(api, 'POST', '/api/quality/rule', { rule: 'nope', level: 'off' })).status).toBe(400);
  });

  it('исключение снимает замечание, удаление возвращает его', async () => {
    const { dir, api } = await open();
    const added = await call<QualityOverview>(api, 'POST', '/api/quality/exclusions', {
      rule: 'vague-wording',
      path: DELTA,
      requirement: 'Выгрузка данных',
      reason: 'формат из договора',
    });
    expect(added.status).toBe(200);
    expect(added.body.totals).toMatchObject({ warning: 0, excluded: 1 });
    expect(added.body.excluded[0]).toMatchObject({ rule: 'vague-wording', exclusion: 0, requirement: 'Выгрузка данных' });
    expect(added.body.config.exclusions[0]).toMatchObject({ reason: 'формат из договора', line: expect.any(Number) });
    expect(readFileSync(join(dir, 'openspec/quality.yaml'), 'utf8')).toMatch(/exclude:\n\s+- rule: vague-wording/);

    const removed = await call<QualityOverview>(api, 'DELETE', '/api/quality/exclusions?index=0');
    expect(removed.body.totals).toMatchObject({ warning: 1, excluded: 0 });
    expect(readFileSync(join(dir, 'openspec/quality.yaml'), 'utf8')).not.toMatch(/^exclude:/m);

    expect((await call<{ error: string }>(api, 'DELETE', '/api/quality/exclusions?index=3')).status).toBe(404);
    expect((await call<{ error: string }>(api, 'POST', '/api/quality/exclusions', { reason: 'всё' })).status).toBe(400);
  });

  it('файл настроек не разбирается — правка отказывает с 409', async () => {
    const { dir, api } = await open();
    writeFileSync(join(dir, 'openspec/quality.yaml'), 'rules: [\n');
    const reply = await call<{ error: string }>(api, 'POST', '/api/quality/rule', { rule: 'atomicity', level: 'off' });
    expect(reply.status).toBe(409);
    expect(reply.body.error).toContain('не разбирается');
  });
});
