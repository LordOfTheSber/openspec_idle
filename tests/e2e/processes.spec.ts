import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

async function openProcesses(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('button', { name: 'Процессы' }).click();
  await expect(page.getByTestId('schema-registry')).toBeVisible();
}

async function fork(page: Page, from: string, name: string): Promise<void> {
  await page.getByTestId(`schema-entry-${from}`).click();
  await page.getByLabel('Имя новой схемы').fill(name);
  await page.getByRole('button', { name: `Форк ${from}` }).click();
  await expect(page.getByTestId(`schema-entry-${name}`)).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('schema-designer')).toContainText(name);
}

async function replaceYaml(page: Page, text: string): Promise<void> {
  await page.getByTestId('schema-yaml').locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

async function yamlText(page: Page): Promise<string> {
  return (await page.getByTestId('schema-yaml').locator('.cm-content').innerText()).replace(/\u00a0/g, ' ');
}

test.describe('реестр и создание схем', () => {
  let ide: LaunchedIde;

  test.beforeAll(async () => {
    ide = await launchIde('custom-schema', { writable: true });
    const broken = join(ide.root, 'openspec/schemas/broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'schema.yaml'), 'name: broken\nartifacts:\n  - id: a\n   generates: [\n');
  });

  test.afterAll(async () => {
    await ide?.stop();
  });

  test('реестр показывает источник, схему по умолчанию и нечитаемую схему', async ({ page }) => {
    await openProcesses(page, ide.url);

    await expect(page.getByTestId('schema-entry-team-flow')).toContainText('по умолч.');
    await expect(page.getByTestId('schema-entry-spec-driven')).toBeVisible();
    await expect(page.getByTestId('schema-entry-broken')).toContainText('нечитаема');

    await page.getByTestId('schema-entry-broken').click();
    await expect(page.getByTestId('schema-parse-error')).toContainText(/строка \d+, столбец \d+/);
    await expect(page.getByTestId('yaml-error')).toBeVisible();
    await expect(page.getByTestId('schema-save')).toBeDisabled();

    // Остальные схемы по-прежнему открываются.
    await page.getByTestId('schema-entry-spec-driven').click();
    await expect(page.getByTestId('schema-graph')).toBeVisible();
    await expect(page.getByTestId('schema-resolution')).toContainText('пакет OpenSpec');
  });

  test('форк переносит артефакты, занятое имя отклоняется с предложением открыть', async ({ page }) => {
    await openProcesses(page, ide.url);
    await fork(page, 'team-flow', 'team-copy');

    await expect(page.getByTestId('graph-node-research')).toBeVisible();
    await expect(page.getByTestId('graph-node-spec-review')).toBeVisible();

    await page.getByLabel('Имя новой схемы').fill('team-copy');
    await page.getByRole('button', { name: 'Создать с нуля' }).click();
    await expect(page.getByTestId('create-error')).toContainText('уже существует');
    await page.getByRole('button', { name: 'Открыть team-copy' }).click();
    await expect(page.getByTestId('schema-entry-team-copy')).toHaveAttribute('aria-current', 'true');
  });

  test('форк встроенной с тем же именем помечен как затеняющий', async ({ page }) => {
    await openProcesses(page, ide.url);
    await fork(page, 'spec-driven', 'spec-driven');

    await expect(page.getByTestId('schema-shadows')).toContainText('встроенную');
  });
});

test.describe('конструктор схемы', () => {
  let ide: LaunchedIde;

  test.beforeAll(async () => {
    ide = await launchIde('custom-schema', { writable: true });
  });

  test.afterAll(async () => {
    await ide?.stop();
  });

  test('граф, форма и YAML отражают правки друг друга', async ({ page }) => {
    await openProcesses(page, ide.url);
    await fork(page, 'team-flow', 'sync-flow');

    // Граф → YAML и форма.
    await page.getByLabel('Идентификатор нового артефакта').fill('retro');
    await page.getByLabel('Зависимость нового артефакта').selectOption('plan');
    await page.getByRole('button', { name: '+ Артефакт' }).click();
    await expect(page.getByTestId('graph-node-retro')).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('graph-edge-plan-retro')).toBeAttached();
    await expect(page.getByTestId('artifact-form')).toHaveAttribute('data-artifact', 'retro');
    expect(await yamlText(page)).toMatch(/id: retro[\s\S]*requires:\s*\n\s*- plan/);

    // Форма → YAML и граф.
    await page.getByLabel('Порождает').fill('retro-notes.md');
    await expect(page.getByTestId('graph-node-retro')).toContainText('retro-notes.md');
    expect(await yamlText(page)).toContain('generates: retro-notes.md');

    // YAML → граф и форма.
    const edited = (await yamlText(page)).replace('generates: retro-notes.md', 'generates: retro.md');
    await replaceYaml(page, edited);
    await expect(page.getByTestId('graph-node-retro')).toContainText('retro.md');
    await expect(page.getByLabel('Порождает')).toHaveValue('retro.md');

    await page.getByTestId('schema-save').click();
    await expect(page.getByTestId('schema-dirty')).toHaveCount(0);
    expect(readFileSync(join(ide.root, 'openspec/schemas/sync-flow/schema.yaml'), 'utf8')).toContain(
      'generates: retro.md',
    );
  });

  test('временно некорректный YAML: граф устарел, сохранение заблокировано', async ({ page }) => {
    await openProcesses(page, ide.url);
    await fork(page, 'team-flow', 'broken-edit');

    const valid = await yamlText(page);
    await replaceYaml(page, `${valid}\n  - id: [\n`);
    await expect(page.getByTestId('yaml-error')).toContainText(/строка \d+/);
    await expect(page.getByTestId('graph-stale')).toBeVisible();
    await expect(page.getByTestId('graph-node-research')).toBeVisible();
    await expect(page.getByTestId('schema-save')).toBeDisabled();

    await replaceYaml(page, valid);
    await expect(page.getByTestId('yaml-error')).toHaveCount(0);
    await expect(page.getByTestId('graph-stale')).toHaveCount(0);
  });

  test('удаление артефакта, от которого зависят другие, требует подтверждения', async ({ page }) => {
    await openProcesses(page, ide.url);
    await fork(page, 'team-flow', 'remove-flow');

    await page.getByTestId('graph-node-spec-review').click();
    await page.getByRole('button', { name: 'Удалить артефакт' }).click();
    await expect(page.getByTestId('remove-confirm')).toContainText('plan');
    await page.getByTestId('remove-confirm').getByRole('button', { name: 'Удалить' }).click();

    await expect(page.getByTestId('graph-node-spec-review')).toHaveCount(0);
    const yaml = await yamlText(page);
    expect(yaml).not.toContain('spec-review');
    await page.getByTestId('graph-node-plan').click();
    await expect(page.getByTestId('artifact-form').getByRole('checkbox', { name: 'design' })).toBeChecked();
  });

  test('объявленный, но отсутствующий шаблон можно создать', async ({ page }) => {
    await openProcesses(page, ide.url);
    await fork(page, 'team-flow', 'template-flow');
    await page.getByTestId('graph-node-research').click();
    await page.getByLabel('Шаблон', { exact: true }).fill('research-notes.md');
    await page.getByTestId('schema-save').click();
    await expect(page.getByTestId('schema-dirty')).toHaveCount(0);

    await expect(page.getByTestId('structural-issue').first()).toContainText('research-notes.md');
    await page.getByTestId('graph-node-research').click();
    await expect(page.getByTestId('template-missing')).toBeVisible();
    await page.getByRole('button', { name: 'Создать шаблон' }).click();
    await page.getByLabel('Шаблон research-notes.md').fill('# Исследование\n');
    await page.getByRole('button', { name: 'Сохранить шаблон' }).click();

    await expect(page.getByTestId('template-missing')).toHaveCount(0);
    await expect(page.getByTestId('structural-ok')).toBeVisible();
    expect(
      readFileSync(join(ide.root, 'openspec/schemas/template-flow/templates/research-notes.md'), 'utf8'),
    ).toBe('# Исследование\n');
  });

  test('переход от нарушения к артефакту на графе и полю формы', async ({ page }) => {
    await openProcesses(page, ide.url);
    await fork(page, 'team-flow', 'jump-flow');

    await page.getByTestId('graph-node-design').click();
    await page.getByLabel('Инструкция для агента').fill('');
    await page.getByTestId('graph-node-research').click();

    const violation = page.getByTestId('violation-sdd/artifact-instruction');
    await expect(violation).toContainText('design');
    await expect(page.getByTestId('passed-sdd/behaviour-contract')).toBeVisible();
    await violation.getByRole('button').click();

    await expect(page.getByTestId('graph-node-design')).toHaveAttribute('data-selected', 'true');
    await expect(page.getByLabel('Инструкция для агента')).toBeFocused();
  });

  test('отказ от правила с причиной снимает блокировку, без причины — нет', async ({ page }) => {
    await openProcesses(page, ide.url);
    await fork(page, 'team-flow', 'waiver-flow');

    await page.getByTestId('graph-node-specs').click();
    await page.getByLabel('Порождает').fill('contract.md');
    await expect(page.getByTestId('violation-sdd/behaviour-contract')).toBeVisible();

    await page.getByLabel('Правило для отказа').selectOption('sdd/behaviour-contract');
    await page.getByRole('button', { name: 'Отказаться' }).click();
    await expect(page.getByTestId('violation-sdd/waiver-without-reason')).toBeVisible();
    await expect(page.getByTestId('violation-sdd/behaviour-contract')).toBeVisible();

    await page.getByLabel('Причина отказа от sdd/behaviour-contract').fill('Процесс для хотфиксов без изменения поведения');
    await expect(page.getByTestId('waived-sdd/behaviour-contract')).toContainText('хотфиксов');
    await expect(page.getByTestId('violation-sdd/behaviour-contract')).toHaveCount(0);
  });

  test('предпросмотр без отслеживаемого артефакта предупреждает о неизмеримом прогрессе', async ({
    page,
  }) => {
    await openProcesses(page, ide.url);
    await fork(page, 'team-flow', 'preview-flow');

    await expect(page.getByTestId('schema-preview')).toContainText('отслеживается');
    await page.getByLabel('Отслеживаемый артефакт').selectOption('');
    await expect(page.getByTestId('preview-warning')).toContainText('измеряться не будет');
  });
});

test.describe('назначение схемы', () => {
  let ide: LaunchedIde;

  test.beforeAll(async () => {
    ide = await launchIde('custom-schema', { writable: true });
  });

  test.afterAll(async () => {
    await ide?.stop();
  });

  test('несоответствующая схема сохраняется, но не назначается', async ({ page }) => {
    await openProcesses(page, ide.url);
    await fork(page, 'team-flow', 'no-contract');
    const configBefore = readFileSync(join(ide.root, 'openspec/config.yaml'), 'utf8');

    await page.getByTestId('graph-node-specs').click();
    await page.getByLabel('Порождает').fill('contract.md');
    await page.getByTestId('schema-save').click();
    await expect(page.getByTestId('schema-dirty')).toHaveCount(0);
    await expect(page.getByTestId('assignable')).toHaveAttribute('data-assignable', 'false');
    await expect(page.getByTestId('schema-entry-no-contract')).toContainText('не назн.');

    await page.getByTestId('schema-assign').click();
    await expect(page.getByTestId('assign-result')).toContainText('нельзя назначить');
    await expect(page.getByTestId('assign-result')).toContainText('sdd/behaviour-contract');
    expect(readFileSync(join(ide.root, 'openspec/config.yaml'), 'utf8')).toBe(configBefore);
  });

  test('соответствующая схема назначается, меняется только строка schema', async ({ page }) => {
    await openProcesses(page, ide.url);
    await fork(page, 'team-flow', 'team-next');
    const configBefore = readFileSync(join(ide.root, 'openspec/config.yaml'), 'utf8');

    await expect(page.getByTestId('assignable')).toHaveAttribute('data-assignable', 'true');
    await page.getByTestId('schema-assign').click();
    await expect(page.getByTestId('assign-result')).toContainText('назначена проекту');
    await expect(page.getByTestId('assign-result')).toContainText('только к новым changes');

    expect(readFileSync(join(ide.root, 'openspec/config.yaml'), 'utf8')).toBe(
      configBefore.replace('schema: team-flow', 'schema: team-next'),
    );
    await expect(page.getByTestId('schema-entry-team-next')).toContainText('по умолч.');
  });

  test('отказ от правила виден в реестре и на карточке change этой схемы', async ({ page }) => {
    await openProcesses(page, ide.url);
    await page.getByTestId('schema-entry-team-flow').click();
    await expect(page.getByTestId('schema-designer')).toContainText('team-flow');

    await page.getByLabel('Правило для отказа').selectOption('sdd/motivation-first');
    await page.getByLabel('Причина отказа', { exact: true }).fill('Исследование заменяет предложение');
    await page.getByRole('button', { name: 'Отказаться' }).click();
    await page.getByTestId('schema-save').click();
    await expect(page.getByTestId('schema-dirty')).toHaveCount(0);
    await expect(page.getByTestId('schema-waived')).toContainText('sdd/motivation-first');

    await page.getByRole('button', { name: 'Доска' }).click();
    const card = page.getByTestId('card-team-feature');
    await expect(card.getByTestId('card-waiver')).toBeVisible();
    await page.getByTestId('card-open-team-feature').click();
    await expect(page.getByTestId('change-waivers')).toContainText('Исследование заменяет предложение');
  });
});
