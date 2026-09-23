import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

const OPENSPEC = fileURLToPath(new URL('../../node_modules/@fission-ai/openspec/bin/openspec.js', import.meta.url));
const FAKE_EDITOR = fileURLToPath(new URL('../editor/fake-editor.mjs', import.meta.url));

async function openSection(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Разделы' }).getByRole('button', { name, exact: true }).click();
}

async function openSpec(page: Page, url: string, capability: string, anchor?: string): Promise<void> {
  const params = new URLSearchParams({ spec: capability });
  if (anchor !== undefined) params.set('req', anchor);
  await page.goto(`${url}/#${params.toString()}`);
  await expect(page.getByTestId('module-spec')).toBeVisible();
}

function card(page: Page, name: string) {
  return page.getByTestId(`req-${name}`);
}

async function waitForCoverage(page: Page): Promise<void> {
  await expect(page.getByTestId('coverage-filter-none')).toBeVisible({ timeout: 20_000 });
}

test.describe('спека модуля', () => {
  let ide: LaunchedIde;
  let editorLog: string;

  test.beforeEach(async () => {
    editorLog = join(mkdtempSync(join(tmpdir(), 'osi-editor-log-')), 'calls.jsonl');
    ide = await launchIde('monorepo', { writable: true, env: { FAKE_EDITOR_LOG: editorLog } });
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('оглавление, поиск по сценарию и открытие требования по адресу', async ({ page }) => {
    await openSpec(page, ide.url, 'billing', 'requirement-счета--нумерация-счетов');
    await expect(card(page, 'Счета / Нумерация счетов').getByRole('button', { name: /Нумерация счетов/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('spec-overview')).toContainText('services/billing');
    await expect(page.getByTestId('spec-counts')).toHaveText('3 разд. · 3 треб. · 3 сцен.');

    await page.getByTestId('toc-Счета / НДС').click();
    await expect(page.getByTestId('toc-Счета / НДС')).toHaveClass(/sel/);

    await page.getByTestId('spec-search').fill('вся сумма');
    await expect(card(page, 'Возвраты / Полный возврат')).toBeVisible();
    await expect(card(page, 'Счета / Нумерация счетов')).toHaveCount(0);
    await expect(page.getByTestId('toc-Возвраты')).toContainText('1 совп.');
    await expect(page.getByTestId('toc-Счета')).toContainText('0 совп.');
  });

  test('признак активного change со сравнением и история требования', async ({ page }) => {
    await openSpec(page, ide.url, 'km/core');
    await card(page, 'Кэш ответов').getByTestId('req-change').click();
    await expect(page.getByTestId('req-compare')).toContainText('Сброс по событию');

    await openSpec(page, ide.url, 'billing', 'requirement-счета--нумерация-счетов');
    await card(page, 'Счета / Нумерация счетов').getByTestId('load-history').click();
    const history = page.getByTestId('req-history');
    await expect(history.locator('li')).toHaveCount(3);
    await expect(history).toContainText('2026-08-20 · billing-sections · переименовывается (было «Нумерация счетов»)');
    await history.getByRole('button', { name: /invoice-prefix/ }).click();
    await expect(page.getByTestId('history-diff')).toContainText('с префиксом организации');
  });

  test('вставка ссылки из редактора дельты и обратная ссылка у цели', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByTestId('tree-module-billing').getByTestId('change-add-invoice-export').click();
    await page.getByTestId('delta-files').getByRole('button', { name: 'specs/billing/spec.md' }).click();
    // Ссылка вставляется в позицию курсора — в конец описания требования.
    await page.locator('.cm-line', { hasText: 'выгружать счета за период' }).click();
    await page.keyboard.press('End');
    await page.getByTestId('insert-link').click();
    await page.getByLabel('Поиск требования').fill('Кэш');
    await page.getByTestId('pick-km/core:Кэш ответов').click();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByTestId('dirty-marker')).toHaveCount(0);
    expect(readFileSync(join(ide.root, 'openspec/changes/add-invoice-export/specs/billing/spec.md'), 'utf8')).toContain(
      'за период в CSV.[km/core: Кэш ответов](../km/core/spec.md#requirement-кэш-ответов)',
    );

    await openSpec(page, ide.url, 'km/core', 'requirement-кэш-ответов');
    const backlinks = card(page, 'Кэш ответов').getByTestId('req-backlinks');
    await expect(backlinks).toContainText('web-ui: Список счетов');
    await expect(backlinks).toContainText('billing: Счета / Выгрузка счетов');
    await expect(backlinks).toContainText('в change add-invoice-export');
  });

  test('трассировка: Kotlin и TypeScript, фрагмент, «по имени», фильтр без покрытия', async ({ page }) => {
    await openSpec(page, ide.url, 'billing', 'requirement-счета--нумерация-счетов');
    await waitForCoverage(page);
    const numbering = card(page, 'Счета / Нумерация счетов');
    await expect(numbering.getByTestId('req-coverage')).toHaveAttribute('data-state', 'full');
    await numbering.getByTestId('trace-code').getByRole('button', { name: /InvoiceNumbers\.kt:3/ }).click();
    await expect(numbering.getByTestId('snippet')).toContainText('class InvoiceNumbers');
    await expect(numbering.getByTestId('trace-test')).toContainText('InvoiceNumbersTest.kt:5');

    await page.getByTestId('coverage-filter-none').click();
    await expect(card(page, 'Счета / НДС / Округление')).toBeVisible();
    await expect(card(page, 'Счета / Нумерация счетов')).toHaveCount(0);

    await openSpec(page, ide.url, 'web-ui', 'requirement-список-счетов');
    await waitForCoverage(page);
    const list = card(page, 'Список счетов');
    await expect(list.getByTestId('trace-code')).toContainText('ui/src/InvoiceList.tsx:1');
    await expect(list.getByTestId('trace-probable')).toContainText('ui/src/InvoiceList.test.tsx:3');
    await expect(list.getByTestId('trace-probable')).toContainText('по имени');
  });

  test('связи на графе: ссылка без зависимости в карте, добавление зависимости; ссылки в деталях change', async ({ page }) => {
    await page.goto(ide.url);
    await openSection(page, 'Модули');
    await expect(page.getByTestId('link-edge-web-ui-billing')).toHaveAttribute('data-kind', 'mismatch');
    await expect(page.getByTestId('link-edge-billing-km/core')).toHaveAttribute('data-kind', 'link');
    await expect(page.getByTestId('broken-tags')).toContainText('теперь оно называется Счета / Нумерация счетов');
    await page.getByTestId('mismatch-web-ui-billing').getByTestId('add-dependency').click();
    await expect(page.getByTestId('link-mismatches')).toHaveCount(0);
    expect(readFileSync(join(ide.root, 'openspec/modules.yaml'), 'utf8')).toContain('dependsOn: [km/core, km/ui-kit, billing]');

    await openSection(page, 'Обозреватель');
    await page.getByTestId('tree-module-km/core').getByTestId('change-add-invoice-export').click();
    await expect(page.getByTestId('affected-links')).toContainText('Список счетов');
  });

  test('настройка редактора и открытие места через заглушку', async ({ page }) => {
    await page.goto(ide.url);
    await openSection(page, 'Настройки');
    await page.getByLabel('Редактор', { exact: true }).selectOption('idea');
    await page.getByLabel('Команда или путь').fill(FAKE_EDITOR);
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-message')).toContainText('сохранены');
    const config = JSON.parse(readFileSync(join(ide.root, '.openspec-ide/config.json'), 'utf8')) as { editor: unknown };
    expect(config.editor).toEqual({ kind: 'idea', command: FAKE_EDITOR });

    await openSpec(page, ide.url, 'billing', 'requirement-счета--нумерация-счетов');
    await waitForCoverage(page);
    await card(page, 'Счета / Нумерация счетов').getByTestId('trace-code').getByTestId('open-in-editor').click();
    await expect.poll(() => (existsSync(editorLog) ? readFileSync(editorLog, 'utf8') : '')).toContain('--line');
    const [args] = readFileSync(editorLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(args?.slice(0, 2)).toEqual(['--line', '3']);
    expect(args?.[2]).toMatch(/InvoiceNumbers\.kt$/);
  });
});

test.describe('приёмка: спека модуля, ссылки и метки в жизненном цикле change', () => {
  let ide: LaunchedIde;

  test.beforeEach(async () => {
    ide = await launchIde('monorepo', {
      writable: true,
      prepare: (root) => {
        rmSync(join(root, 'openspec/changes/add-cache-ttl'), { recursive: true, force: true });
        const change = join(root, 'openspec/changes/rename-numbering');
        mkdirSync(join(change, 'specs/billing'), { recursive: true });
        writeFileSync(join(change, '.openspec.yaml'), 'schema: spec-driven\ncreated: 2026-09-20\n');
        writeFileSync(join(change, 'proposal.md'), '## Why\n\nКороче имя требования.\n\n## What Changes\n\n- Переименование.\n');
        writeFileSync(
          join(change, 'specs/billing/spec.md'),
          '## RENAMED Requirements\n\n- FROM: `### Requirement: Счета / Нумерация счетов`\n- TO: `### Requirement: Счета / Номер счёта`\n',
        );
        writeFileSync(join(change, 'tasks.md'), '## 1. Имя\n\n- [x] 1.1 Переименовать требование\n');
      },
    });
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('change с MODIFIED и RENAMED: затронутое и метки к обновлению; после архивации — история и покрытие', async ({ page }) => {
    // Спека сервиса с разделами и ссылкой на библиотеку КМ.
    await openSpec(page, ide.url, 'billing', 'requirement-возвраты--полный-возврат');
    await expect(page.getByTestId('spec-toc')).toContainText('Возвраты');
    await expect(card(page, 'Возвраты / Полный возврат').getByTestId('spec-link')).toHaveText('km/core: Кэш ответов');
    await expect(card(page, 'Счета / Нумерация счетов').getByTestId('req-change')).toContainText('rename-numbering: переименовывается');

    // MODIFIED в библиотеке: затронуты ссылающиеся требования сервисов.
    await page.goto(ide.url);
    await page.getByTestId('tree-module-km/core').getByTestId('change-add-invoice-export').click();
    await expect(page.getByTestId('affected-links')).toContainText('Полный возврат');

    // RENAMED: метки в коде и тестах, которые нужно обновить.
    await page.getByTestId('tree-module-billing').getByTestId('change-rename-numbering').click();
    const tags = page.getByTestId('tags-to-update');
    await expect(tags).toContainText('InvoiceNumbers.kt:3');
    await expect(tags).toContainText('InvoiceNumbersTest.kt:5');
    await expect(tags).toContainText('«Счета / Нумерация счетов» → «Счета / Номер счёта»');

    // Архивация.
    await openSection(page, 'Доска');
    await page.getByTestId('card-rename-numbering').click();
    await page.getByTestId('archive').click();
    await page.getByTestId('archive-confirmed').click();
    await expect(page.getByTestId('card-rename-numbering')).toHaveCount(0);

    // История продолжается через переименование, метки со старым именем — битые с подсказкой.
    await openSpec(page, ide.url, 'billing', 'requirement-счета--номер-счёта');
    const renamed = card(page, 'Счета / Номер счёта');
    await renamed.getByTestId('load-history').click();
    await expect(renamed.getByTestId('req-history').locator('li')).toHaveCount(4);
    await expect(renamed.getByTestId('req-history')).toContainText('rename-numbering · переименовывается');
    await waitForCoverage(page);
    await expect(renamed.getByTestId('req-coverage')).toHaveAttribute('data-state', 'probable');

    await openSection(page, 'Модули');
    await expect(page.getByTestId('broken-tags')).toContainText('InvoiceNumbers.kt:3');
    await expect(page.getByTestId('broken-tags')).toContainText('теперь оно называется Счета / Номер счёта');

    const validate = execFileSync(process.execPath, [OPENSPEC, 'validate', '--specs', '--strict'], { cwd: ide.root, encoding: 'utf8' });
    expect(validate).toMatch(/passed/);
  });
});
