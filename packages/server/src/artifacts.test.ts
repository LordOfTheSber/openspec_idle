import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from './fs/workspace.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactCreationError, createArtifact, resolveArtifactPath } from './artifacts.js';
import { OpenspecClient } from './openspec/client.js';

const OPENSPEC_BIN = fileURLToPath(new URL('../../../node_modules/.bin/openspec', import.meta.url));

let root: string;

/** Копия фикстуры во временном каталоге: тесты создают файлы. */
function useFixture(name: string): OpenspecClient {
  const source = fileURLToPath(new URL(`../../../tests/fixtures/${name}`, import.meta.url));
  cpSync(source, root, { recursive: true });
  return new OpenspecClient({ root, bin: OPENSPEC_BIN });
}

beforeEach(() => {
  root = canonicalize(mkdtempSync(join(tmpdir(), 'osi-artifacts-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('путь создаваемого артефакта', () => {
  it('обычный артефакт пишется по объявленному пути', () => {
    expect(resolveArtifactPath('design.md', { change: 'x', artifact: 'design' })).toBe('design.md');
  });

  it('артефакт со звёздочками требует пути capability', () => {
    expect(() => resolveArtifactPath('specs/**/*.md', { change: 'x', artifact: 'specs' })).toThrow(
      /Укажите путь capability/,
    );
  });

  it('путь capability подставляется в шаблон пути', () => {
    const path = resolveArtifactPath('specs/**/*.md', {
      change: 'x',
      artifact: 'specs',
      capabilityPath: 'identity/user-auth',
    });
    expect(path).toBe('specs/identity/user-auth/spec.md');
  });

  it('попытка выйти вверх по дереву отклоняется', () => {
    expect(() =>
      resolveArtifactPath('specs/**/*.md', {
        change: 'x',
        artifact: 'specs',
        capabilityPath: '../снаружи',
      }),
    ).toThrow(/Недопустимый путь capability/);
  });
});

describe('создание артефакта из шаблона', () => {
  it('создаёт отсутствующий design.md по шаблону встроенной схемы', async () => {
    const client = useFixture('bare-change');

    const created = await createArtifact(client, { change: 'bare-feature', artifact: 'design' });

    expect(created.path).toBe('openspec/changes/bare-feature/design.md');
    expect(existsSync(join(root, created.path))).toBe(true);

    const templates = await client.templates('spec-driven');
    expect(templates.ok).toBe(true);
    if (!templates.ok) return;
    const templatePath = templates.data['design']?.path ?? '';
    expect(created.content).toBe(readFileSync(templatePath, 'utf8'));
  });

  it('создаёт артефакт, объявленный только собственной схемой', async () => {
    const client = useFixture('custom-schema');
    rmSync(join(root, 'openspec', 'changes', 'team-feature', 'review.md'));

    const created = await createArtifact(client, {
      change: 'team-feature',
      artifact: 'spec-review',
    });

    expect(created.path).toBe('openspec/changes/team-feature/review.md');
    expect(created.content).toContain('review');
  });

  it('создаёт файл дельты по пути capability из шаблона схемы', async () => {
    const client = useFixture('bare-change');

    const created = await createArtifact(client, {
      change: 'bare-feature',
      artifact: 'specs',
      capabilityPath: 'identity/user-auth',
    });

    expect(created.path).toBe(
      'openspec/changes/bare-feature/specs/identity/user-auth/spec.md',
    );
    expect(existsSync(join(root, created.path))).toBe(true);
  });

  it('существующий файл не перезаписывается', async () => {
    const client = useFixture('full-change');

    await expect(
      createArtifact(client, { change: 'full-feature', artifact: 'design' }),
    ).rejects.toThrow(/уже существует/);
  });

  it('артефакт, не объявленный схемой, отклоняется с перечнем её артефактов', async () => {
    const client = useFixture('custom-schema');

    await expect(
      createArtifact(client, { change: 'team-feature', artifact: 'tasks' }),
    ).rejects.toThrow(ArtifactCreationError);

    await expect(
      createArtifact(client, { change: 'team-feature', artifact: 'tasks' }),
    ).rejects.toThrow(/spec-review/);
  });
});
