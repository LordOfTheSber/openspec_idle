import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

test.describe('трассировка сценариев', () => {
  let ide: LaunchedIde;

  test.beforeEach(async () => {
    ide = await launchIde('full-change', { writable: true });
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('непокрытый сценарий закрывается пунктом плана со ссылкой', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('nav-board').click();
    await page.getByTestId('card-open-full-feature').click();
    await page.getByTestId('detail-trace').click();

    await expect(page.locator('.toolbar h1')).toHaveText('Дельты');
    await expect(page.getByTestId('trace-coverage')).toHaveText('0 из 1');
    await expect(page.getByTestId('trace-scenario-Успешная выгрузка')).toHaveAttribute('data-covered', 'false');

    const tasks = join(ide.root, 'openspec/changes/full-feature/tasks.md');
    const before = readFileSync(tasks, 'utf8');
    await page.getByTestId('trace-add-item').click();

    await expect(page.getByTestId('trace-coverage')).toHaveText('1 из 1');
    await expect(page.getByTestId('toast')).toContainText('Пункт добавлен в план');
    const after = readFileSync(tasks, 'utf8');
    expect(after).toContain('- [ ] 2.2 Успешная выгрузка\n  ↳ data-export / Успешная выгрузка\n');
    // Остальные строки плана не тронуты.
    expect(after.replace('- [ ] 2.2 Успешная выгрузка\n  ↳ data-export / Успешная выгрузка\n', '')).toBe(before);
  });

  test('«Только пробелы» оставляет непокрытые сценарии', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('change-full-feature').click();
    await page.getByTestId('nav-deltas').click();
    await page.getByTestId('tab-trace').click();

    await page.getByTestId('trace-gaps-only').click();
    await expect(page.getByTestId('trace-scenario-Успешная выгрузка')).toBeVisible();
    await expect(page.getByTestId('trace-item-1.1')).toHaveCount(0);
  });
});
