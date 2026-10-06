import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

const DELTA = 'openspec/changes/full-feature/specs/data-export/spec.md';

/** Дельта с расплывчатым словом: одно предупреждение vague-wording. */
function prepare(root: string): void {
  writeFileSync(
    join(root, DELTA),
    [
      '# Spec Delta: data-export',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Выгрузка данных',
      '',
      'Система ДОЛЖНА (SHALL) выгружать данные пользователя в валидном формате CSV.',
      '',
      '#### Scenario: Успешная выгрузка',
      '',
      '- **WHEN** пользователь запрашивает выгрузку',
      '- **THEN** отдаётся файл CSV со всеми его данными',
      '',
    ].join('\n'),
  );
}

test.describe('раздел «Качество»', () => {
  let ide: LaunchedIde;

  test.beforeEach(async () => {
    ide = await launchIde('full-change', { writable: true, prepare });
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('метрики, файлы и замечание; исключение с причиной и его снятие', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('nav-quality').click();

    await expect(page.getByTestId('quality-no-config')).toBeVisible();
    await expect(page.getByTestId('quality-metric-ambiguityDensity')).toContainText('1 слово');
    const row = page.getByTestId(`quality-file-${DELTA}`);
    await expect(row).toContainText('data-export');
    await row.click();

    const detail = page.getByTestId('quality-file-detail');
    await expect(detail).toContainText('Выгрузка данных');
    await expect(detail.getByTestId('quality-issue')).toContainText('«валидном»');

    await detail.getByTestId('quality-exclude').click();
    await detail.getByTestId('quality-exclude-reason').fill('формат из договора');
    await detail.getByTestId('quality-exclude-confirm').click();

    await expect(page.getByTestId('quality-exclusions')).toContainText('формат из договора');
    await expect(page.getByTestId('quality-level-warning')).toContainText('0');
    const yaml = readFileSync(join(ide.root, 'openspec/quality.yaml'), 'utf8');
    expect(yaml).toMatch(/- rule: vague-wording\n\s+path: openspec\/changes\/full-feature\/specs\/data-export\/spec\.md\n\s+requirement: Выгрузка данных\n\s+reason: формат из договора/);

    await page.getByTestId('quality-show-excluded').locator('input').check();
    await expect(page.getByTestId('quality-file-detail')).toContainText('исключено: формат из договора');

    await page.getByTestId('quality-exclusion-remove').click();
    await expect(page.getByTestId('quality-exclusions')).toHaveCount(0);
    await expect(page.getByTestId('quality-level-warning')).toContainText('1');
  });

  test('по правилам: уровень «выключено» пишется в quality.yaml и снимает замечания', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('nav-quality').click();
    await page.getByTestId('quality-by-rules').click();
    await page.getByTestId('quality-rule-vague-wording').click();

    const card = page.getByTestId('quality-rule-card');
    await expect(card).toContainText('Расплывчатые слова');
    await card.getByTestId('quality-rule-level').selectOption('off');

    await expect(card).toContainText('Правило выключено');
    await expect(page.getByTestId('quality-rule-vague-wording')).toContainText('выкл.');
    expect(readFileSync(join(ide.root, 'openspec/quality.yaml'), 'utf8')).toContain('vague-wording: off');
  });

  test('с доски: чип качества на карточке и переход в раздел с фильтром по change', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('nav-board').click();
    await expect(page.getByTestId('card-quality-full-feature')).toContainText('качество 1');

    await page.getByTestId('card-open-full-feature').click();
    await page.getByTestId('detail-quality-open').click();

    await expect(page.getByTestId('quality-focus')).toContainText('full-feature');
    await expect(page.getByTestId(`quality-file-${DELTA}`)).toBeVisible();
  });

  test('живое обновление, создание quality.yaml, плашка порога и узкая панель', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('nav-quality').click();
    await expect(page.getByTestId('quality-level-warning')).toContainText('1');

    const delta = join(ide.root, DELTA);
    writeFileSync(delta, readFileSync(delta, 'utf8').replace('в валидном формате CSV', 'в валидном формате CSV и т. д.'));
    await expect(page.getByTestId('quality-metric-ambiguityDensity')).toContainText('2 слова');

    await page.getByTestId('quality-init').click();
    await expect(page.getByTestId('quality-no-config')).toHaveCount(0);
    const created = readFileSync(join(ide.root, 'openspec/quality.yaml'), 'utf8');
    expect(created).toContain('scope: all');
    expect(created).toContain('# exclude:');

    writeFileSync(join(ide.root, 'openspec/quality.yaml'), `${created}thresholds:\n  ambiguityDensity: 0.05\n`);
    await expect(page.getByTestId('quality-threshold')).toContainText('Порог не выполнен: расплывчатых слов на 100');
    await expect(page.getByTestId('quality-threshold')).toContainText('при пороге 0,05');

    await page.setViewportSize({ width: 420, height: 900 });
    await expect(page.getByTestId('quality')).toHaveClass(/narrow/);
    await expect(page.locator('div[data-testid="quality-files"]')).toBeVisible();
  });
});
