import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

async function openBoard(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('button', { name: 'Доска' }).click();
  await expect(page.getByTestId('board')).toBeVisible();
}

test.describe('доска на встроенной схеме', () => {
  let ide: LaunchedIde;

  test.beforeAll(async () => {
    ide = await launchIde('full-change', { writable: true });
  });

  test.afterAll(async () => {
    await ide?.stop();
  });

  test('колонки идут по зависимостям артефактов и заканчиваются рабочими', async ({ page }) => {
    await openBoard(page, ide.url);

    for (const id of ['proposal', 'specs', 'design', 'tasks', 'ready', 'in-progress', 'to-archive']) {
      await expect(page.getByTestId(`column-${id}`)).toBeVisible();
    }
  });

  test('карточка стоит в колонке «В работе» и несёт схему и прогресс', async ({ page }) => {
    await openBoard(page, ide.url);

    const card = page.getByTestId('card-full-feature');
    await expect(page.getByTestId('column-in-progress')).toContainText('full-feature');
    await expect(card).toContainText('spec-driven');
    await expect(card).toContainText('2/4 пунктов');
  });

  test('отметка пункта пишется в файл и не трогает остальные строки', async ({ page }) => {
    await openBoard(page, ide.url);
    await page.getByTestId('card-full-feature').click();

    const path = join(ide.root, 'openspec/changes/full-feature/tasks.md');
    const before = readFileSync(path, 'utf8');

    await page.getByTestId('item-1.3').check();
    await expect(page.getByTestId('card-full-feature')).toContainText('3/4 пунктов');

    const after = readFileSync(path, 'utf8');
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const changed = beforeLines.filter((line, index) => line !== afterLines[index]);

    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('1.3');
  });

  test('все выполненные пункты переводят карточку в «Готово к архивации»', async ({ page }) => {
    await openBoard(page, ide.url);
    await page.getByTestId('card-full-feature').click();

    for (const number of ['1.3', '2.1']) {
      const checkbox = page.getByTestId(`item-${number}`);
      if (!(await checkbox.isChecked())) await checkbox.check();
    }

    await expect(page.getByTestId('column-to-archive')).toContainText('full-feature');
  });

  test('недопустимое имя change отклоняется с выводом команды', async ({ page }) => {
    await openBoard(page, ide.url);

    await page.getByTestId('new-change').click();
    await page.getByLabel('Имя изменения').fill('Имя С Пробелами');
    await page.getByRole('button', { name: 'Создать' }).click();

    await expect(page.getByTestId('board-error')).toBeVisible();
    await expect(page.getByTestId('column-proposal')).not.toContainText('Имя С Пробелами');
  });
});

test.describe('доска на собственной схеме', () => {
  let ide: LaunchedIde;

  test.beforeAll(async () => {
    ide = await launchIde('custom-schema', { writable: true });
  });

  test.afterAll(async () => {
    await ide?.stop();
  });

  test('колонки берутся из артефактов собственной схемы', async ({ page }) => {
    await openBoard(page, ide.url);

    await expect(page.getByTestId('column-research')).toBeVisible();
    await expect(page.getByTestId('column-spec-review')).toBeVisible();
    await expect(page.getByTestId('column-plan')).toBeVisible();
    await expect(page.getByTestId('column-tasks')).toHaveCount(0);
  });

  test('новый change создаётся выбранной схемой и попадает в её первую колонку', async ({
    page,
  }) => {
    await openBoard(page, ide.url);

    await page.getByTestId('new-change').click();
    await page.getByLabel('Имя изменения').fill('new-feature');
    await page.getByLabel('Схема процесса').selectOption('team-flow');
    await page.getByRole('button', { name: 'Создать' }).click();

    await expect(page.getByTestId('column-research')).toContainText('new-feature');
    await expect(page.getByTestId('card-new-feature')).toContainText('не проверялся');
  });

  test('отметка пункта пишется в plan.md, а не в tasks.md', async ({ page }) => {
    await openBoard(page, ide.url);
    await page.getByTestId('card-team-feature').click();

    await page.getByTestId('item-1.2').check();

    // Отметка ставится сразу, а запись идёт на сервер — ждём подтверждения
    // от него, прежде чем читать файл.
    await expect(page.getByTestId('card-team-feature')).toContainText('2/3 пунктов');

    const plan = readFileSync(join(ide.root, 'openspec/changes/team-feature/plan.md'), 'utf8');
    expect(plan).toContain('[x] 1.2');
    expect(existsSync(join(ide.root, 'openspec/changes/team-feature/tasks.md'))).toBe(false);
  });

  test('архивация невыполненного change требует подтверждения', async ({ page }) => {
    await openBoard(page, ide.url);
    await page.getByTestId('card-team-feature').click();

    await page.getByTestId('archive').click();

    await expect(page.getByTestId('archive-confirm')).toContainText('не выполнено пунктов');
  });
});
