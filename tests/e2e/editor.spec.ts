import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

let ide: LaunchedIde;

test.beforeEach(async () => {
  ide = await launchIde('full-change', { writable: true });
});

test.afterEach(async () => {
  await ide?.stop();
});

const SPEC_FILE = 'openspec/changes/full-feature/specs/data-export/spec.md';

async function openSpecArtifact(page: Page): Promise<void> {
  await page.goto(ide.url);
  await page.getByTestId('artifact-full-feature-specs').click();
  await expect(page.getByTestId('editor')).toBeVisible();
}

test('открывает артефакт и показывает его структуру', async ({ page }) => {
  await openSpecArtifact(page);

  await expect(page.getByTestId('editor')).toContainText('Requirement: Выгрузка данных');
  await expect(page.getByTestId('outline')).toContainText('Выгрузка данных');
  await expect(page.getByTestId('outline')).toContainText('Успешная выгрузка');
});

test('правка помечается несохранённой и сохраняется на диск', async ({ page }) => {
  await openSpecArtifact(page);

  await page.getByTestId('editor').locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n\nДобавлено редактором.\n');

  await expect(page.getByTestId('dirty-marker')).toBeVisible();

  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('dirty-marker')).toHaveCount(0);

  const onDisk = readFileSync(join(ide.root, SPEC_FILE), 'utf8');
  expect(onDisk).toContain('Добавлено редактором.');
});

test('после сохранения показывается результат проверок', async ({ page }) => {
  await openSpecArtifact(page);

  await page.getByTestId('editor').locator('.cm-content').click();
  await page.keyboard.type(' ');
  await page.getByTestId('save-button').click();

  await expect(page.getByTestId('validation-clean')).toContainText('без замечаний');
});

test('сценарий тремя решётками помечается в тексте и в структуре', async ({ page }) => {
  await openSpecArtifact(page);

  await page.getByTestId('editor').locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n### Scenario: Записан неверно\n\n- **WHEN** а\n- **THEN** б\n');

  await expect(page.getByTestId('structure-problems')).toContainText('четырёх');
  await expect(page.locator('.cm-osi-problem')).toHaveCount(1);
});

test('внешняя правка файла блокирует сохранение и показывает версию с диска', async ({ page }) => {
  await openSpecArtifact(page);

  await page.getByTestId('editor').locator('.cm-content').click();
  await page.keyboard.type(' ');

  // Файл меняют извне — так же, как это сделал бы агент.
  const path = join(ide.root, SPEC_FILE);
  writeFileSync(path, `${readFileSync(path, 'utf8')}\nПравка извне.\n`);

  await page.getByTestId('save-button').click();

  const conflict = page.getByTestId('conflict');
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('изменился на диске');
  await conflict.getByText('Версия на диске').click();
  await expect(conflict).toContainText('Правка извне.');
});

test('выбор элемента структуры переводит курсор на его строку', async ({ page }) => {
  await openSpecArtifact(page);

  await page.getByTestId('outline-scenario-Успешная выгрузка').click();

  const activeLine = page.locator('.cm-activeLine');
  await expect(activeLine).toContainText('Scenario: Успешная выгрузка');
});

test('отсутствующий артефакт создаётся из шаблона схемы', async ({ page }) => {
  await launchIde('bare-change', { writable: true }).then(async (bare) => {
    try {
      await page.goto(bare.url);
      await page.getByTestId('artifact-bare-feature-design').click();
      await page.getByRole('button', { name: 'Создать из шаблона' }).click();

      await expect(page.getByTestId('editor')).toBeVisible();
      const created = readFileSync(join(bare.root, 'openspec/changes/bare-feature/design.md'), 'utf8');
      expect(created.length).toBeGreaterThan(0);
    } finally {
      await bare.stop();
    }
  });
});
