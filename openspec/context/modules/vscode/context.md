# Контекст модуля vscode

Пакет `openspec-ide`: расширение VS Code 1.90+, сборка esbuild в CommonJS
(`build.mjs`), упаковка `vsce` в `.vsix`. Бэкенд — встроенный режим `server`
в процессе расширения; интерфейс `web` копируется в каталог `media/web` при
сборке.

## Устройство

- `src/extension.ts` — `OpenspecController`: активация по
  `openspec/config.yaml`, выбор корня (`src/root.ts`), запуск бэкенда,
  команды, наблюдатель файлов, перезапуск при смене `openspec.cliPath`.
- Нативное: дерево (`src/treeProvider.ts` над моделью `src/treeModel.ts`),
  диагностика по коллекциям — валидация, структура, контекст, пересечения
  (модели `src/diagnosticsModel.ts`, `src/structureModel.ts`,
  `src/contextModel.ts`, `src/driftModel.ts`), помощь в редакторе
  (`src/authoring.ts`: дополнение, переходы, быстрые исправления, подсказки).
- Панель: `src/panel.ts` и `src/panelHtml.ts` (строгая CSP, nonce, без сети),
  `src/bridge.ts` пересылает запросы панели во встроенный бэкенд.

## Правила

- Логика решений — в моделях без `vscode`, их проверяет `src/units.test.ts`;
  `src/smoke.test.ts` грузит собранный бандл с подменённым модулем
  `src/testing/fakeVscode.ts` (нужен `npm run build`).
- Замечание из бэкенда переводится в диагностику на строке (с 0), уровни —
  Error, Warning, Information.
- После установки новой сборки нужен «Reload Window»: панель берёт новый
  интерфейс сразу, а бэкенд живёт до перезагрузки окна.
