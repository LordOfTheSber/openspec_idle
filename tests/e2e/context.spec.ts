import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchIde, type LaunchedIde } from './helpers.js';

test.describe('карта контекста', () => {
  let ide: LaunchedIde;

  test.beforeEach(async () => {
    ide = await launchIde('context-map', { writable: true });
  });

  test.afterEach(async () => {
    await ide?.stop();
  });

  test('граф связывает модули с доменами многие-ко-многим, выбор узла показывает связи и контекст', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByRole('button', { name: 'Контекст' }).click();

    await expect(page.getByTestId('context-summary')).toContainText('2 модуля');
    await expect(page.getByTestId('context-summary')).toContainText('5 доменов');
    await expect(page.getByTestId('context-graph')).toBeVisible();
    // Домен replication — у обоих модулей.
    await expect(page.getByTestId('ctx-edge-domain:sds-master->replication')).toBeAttached();
    await expect(page.getByTestId('ctx-edge-domain:sds-impl->replication')).toBeAttached();
    await expect(page.getByTestId('ctx-edge-depends:sds-master->sds-impl')).toBeAttached();

    await page.getByTestId('ctx-node-domain:replication').click();
    await expect(page.getByTestId('context-details')).toContainText('sds-master');
    await expect(page.getByTestId('context-details')).toContainText('sds-impl');
    await expect(page.getByTestId('context-details')).toContainText('ADR-001-sync-replication');

    await page.getByTestId('ctx-node-module:sds-master').click();
    const bundle = page.getByTestId('context-bundle');
    await expect(bundle).toContainText('openspec/context/1.md');
    await expect(bundle).toContainText('openspec/context/modules/sds-impl/context.md');
    await expect(bundle).toContainText('openspec/specs/servant-master-api/spec.md');

    await expect(page.getByTestId('context-issue-unknown-module')).toContainText('sds-router');
    await expect(page.getByTestId('context-issue-uncovered-domain')).toContainText('cm-cluster-api');
  });

  test('матрица и обновление при правке index.md', async ({ page }) => {
    await page.goto(ide.url);
    await page.getByRole('button', { name: 'Контекст' }).click();
    await page.getByTestId('context-view-matrix').click();

    await expect(page.getByTestId('ctx-cell-sds-master-replication')).toBeVisible();
    await expect(page.getByTestId('ctx-cell-sds-impl-replication')).toBeVisible();
    await expect(page.getByTestId('ctx-cell-sds-impl-cm-cluster-api')).toHaveCount(0);

    writeFileSync(
      join(ide.root, 'openspec/context/modules/sds-impl/index.md'),
      '---\nmodule: sds-impl\ndomains: [replication, servant-master-api, cm-cluster-api]\n---\n',
    );

    await expect(page.getByTestId('ctx-cell-sds-impl-cm-cluster-api')).toBeVisible();
    await expect(page.getByTestId('context-issue-uncovered-domain')).toHaveCount(0);
  });
});
