import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

test.describe('структура папок', () => {
  let ide: LaunchedIde;

  test.beforeEach(async () => {
    ide = await launchIde('full-change', { writable: true });
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('без описания предлагается создать его, созданное проходит проверку', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByRole('button', { name: 'Структура' }).click();

    await expect(page.getByTestId('structure-not-configured')).toBeVisible();
    await page.getByTestId('structure-init').click();

    await expect(page.getByTestId('structure-summary')).toContainText('соответствует описанию');
    await expect(page.getByTestId('structure-tree')).toContainText('openspec/');
    expect(readFileSync(join(ide.root, 'openspec/structure.yaml'), 'utf8')).toContain('config.yaml: file');
  });

  test('лишний файл в строгой папке появляется без действий пользователя, ошибка описания — со строкой', async ({ page }) => {
    writeFileSync(
      join(ide.root, 'openspec/structure.yaml'),
      'version: 1\nstructure:\n  openspec:\n    structure.yaml: file\n    config.yaml: file\n    specs: "*"\n    changes: "*"\n',
    );
    await page.goto(ide.url);
    await page.getByRole('button', { name: 'Структура' }).click();
    await expect(page.getByTestId('structure-summary')).toContainText('соответствует');

    writeFileSync(join(ide.root, 'openspec/notes.txt'), 'черновик');

    await expect(page.getByTestId('structure-issue-openspec/notes.txt')).toContainText('Лишний файл openspec/notes.txt');
    await expect(page.getByTestId('structure-issue-openspec/notes.txt')).toContainText('строка 3');
    await expect(page.getByTestId('structure-summary')).toContainText('1 нарушение');

    writeFileSync(join(ide.root, 'openspec/structure.yaml'), 'version: 1\nstructure:\n  openspec/specs: "*"\n');
    await page.getByTestId('structure-check').click();
    await expect(page.getByTestId('structure-errors')).toContainText('строка 3');
    await expect(page.getByTestId('structure-errors')).toContainText('не может содержать «/»');
  });
});
