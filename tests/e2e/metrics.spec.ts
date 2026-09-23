import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

async function openMetrics(page: Page, url: string, change: string): Promise<void> {
  await page.goto(url);
  await page.getByTestId(`change-${change}`).click();
  await page.getByRole('button', { name: 'Метрики' }).click();
  await expect(page.getByTestId('metrics')).toBeVisible();
}

test.describe('метрики на встроенной схеме', () => {
  let ide: LaunchedIde;

  test.beforeEach(async () => {
    ide = await launchIde('full-change', { writable: true });
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('сводка показывает долю выполненных и «нет данных» вместо нуля', async ({ page }) => {
    await openMetrics(page, ide.url, 'full-feature');

    const summary = page.getByTestId('metrics-summary');
    await expect(summary).toContainText('50 %');
    await expect(summary).toContainText('2 из 4 пунктов');
    // Агент ещё не запускался — расход не ноль, а отсутствие данных.
    await expect(page.getByTestId('tokens-total')).toHaveText('нет данных');
  });

  test('таблица показывает каждый пункт плана с критерием приёмки', async ({ page }) => {
    await openMetrics(page, ide.url, 'full-feature');

    for (const key of ['1.1', '1.2', '1.3', '2.1']) {
      await expect(page.getByTestId(`metrics-row-${key}`)).toBeVisible();
    }
    await page.getByTestId('metrics-row-1.3').click();
    await expect(page.getByTestId('criterion')).toContainText('проверить тестом на таймаут');
  });

  test('взятие пункта в работу меняет его состояние', async ({ page }) => {
    await openMetrics(page, ide.url, 'full-feature');

    await page.getByTestId('metrics-row-1.3').click();
    await page.getByTestId('start-item').click();

    await expect(page.getByTestId('metrics-row-1.3')).toContainText('в работе');
    expect(readFileSync(join(ide.root, '.openspec-ide/runs.jsonl'), 'utf8')).toContain(
      'item-started',
    );
  });

  test('красная проверка у выполненного пункта даёт расхождение', async ({ page }) => {
    await openMetrics(page, ide.url, 'full-feature');

    await page.getByTestId('metrics-row-1.2').click();
    await page.getByLabel('Команда проверки приёмки').fill('echo тест упал; exit 1');
    await page.getByRole('button', { name: 'Привязать' }).click();
    await page.getByTestId('run-acceptance').click();

    await expect(page.getByTestId('check-output')).toContainText('код 1');
    await expect(page.getByTestId('check-output')).toContainText('тест упал');
    await expect(page.getByTestId('metrics-row-1.2')).toContainText('расхождение');
    await expect(page.getByTestId('mismatches')).toHaveText('1');
  });

  test('каталог метрик создан и исключён из git, файлы openspec/ не тронуты', async ({ page }) => {
    const tasks = join(ide.root, 'openspec/changes/full-feature/tasks.md');
    const before = readFileSync(tasks, 'utf8');

    await openMetrics(page, ide.url, 'full-feature');
    await expect(page.getByTestId('metrics-table')).toBeVisible();

    expect(existsSync(join(ide.root, '.openspec-ide/.gitignore'))).toBe(true);
    expect(readFileSync(tasks, 'utf8')).toBe(before);
  });

  test('отметка в обход IDE отражается в метриках', async ({ page }) => {
    await openMetrics(page, ide.url, 'full-feature');
    await expect(page.getByTestId('metrics-row-1.3')).toContainText('не начата');

    const tasks = join(ide.root, 'openspec/changes/full-feature/tasks.md');
    writeFileSync(tasks, readFileSync(tasks, 'utf8').replace('- [ ] 1.3', '- [x] 1.3'));

    await expect(async () => {
      await page.reload();
      await page.getByTestId('change-full-feature').click();
      await page.getByRole('button', { name: 'Метрики' }).click();
      await expect(page.getByTestId('metrics-row-1.3')).toContainText('готово', {
        timeout: 1000,
      });
    }).toPass({ timeout: 15_000 });
  });
});

test.describe('метрики на собственной схеме', () => {
  let ide: LaunchedIde;

  test.beforeAll(async () => {
    ide = await launchIde('custom-schema', { writable: true });
  });

  test.afterAll(async () => {
    await ide?.stop();
  });

  test('пункты берутся из plan.md, объявленного схемой', async ({ page }) => {
    await openMetrics(page, ide.url, 'team-feature');

    await expect(page.getByText('openspec/changes/team-feature/plan.md')).toBeVisible();
    await expect(page.getByTestId('metrics-summary')).toContainText('1 из 3 пунктов');
  });
});
