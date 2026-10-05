# Tasks

## 1. Модель

- [x] 1.1 Правило `error-order` в `packages/core/src/specQuality.ts`, сравнение сценариев `scenarioConsistency` в `packages/core/src/specConsistency.ts`; проверка — тесты «порядок ошибок» и «согласованность сценариев» в `packages/core/src/specConsistency.test.ts`
  ↳ spec-consistency / Два кода без порядка
  ↳ spec-consistency / Порядок задан
  ↳ spec-consistency / Противоречие внутри требования
  ↳ spec-consistency / Один триггер в двух спеках
  ↳ spec-consistency / Копия требования в дельте
- [x] 1.2 Исполняемые правила `artifactRuleIssues` и ключ `artifacts` в `parseQualityConfig`; ссылки плана на тесты `planTestReferences` и `planTestRefIssues`; сверка с кодом `specCodeIssues`; регресс `metricRegressions`; проверка — тесты «исполняемые правила артефактов», «ссылки плана на тесты», «спека ↔ код модулей домена», «регресс относительно базовой ревизии» в `packages/core/src/specConsistency.test.ts`
  ↳ spec-consistency / Решение без альтернативы
  ↳ spec-consistency / Пункт плана без проверки
  ↳ spec-consistency / Пустой раздел не проверяется
  ↳ spec-consistency / Тест переименован
  ↳ spec-consistency / Начало имени
  ↳ spec-consistency / Число найдено в другой записи
  ↳ spec-consistency / Граница без литерала

## 2. Сервер и CI

- [x] 2.1 Файлы артефактов в `/api/authoring`; `projectQualityIssues` (файлы тестов, код модулей домена по карте контекста) и маршрут `GET /api/quality/project`; `baselineSources` по `git ls-tree` и `git show`; `--baseline` в `openspec-ide-check`; проверка — тесты `packages/server/src/check.test.ts` «quality: правило артефактов, …» и «quality --baseline: …», `node packages/check/dist/openspec-ide-check.mjs --only quality --baseline HEAD` на этом репозитории — код 0
  ↳ spec-consistency / Файла теста нет
  ↳ spec-consistency / Сообщение изменилось в коде
  ↳ spec-consistency / Расплывчатые слова в PR
  ↳ spec-consistency / Неизвестная ревизия

## 3. Редактор

- [x] 3.1 Замечания `/api/quality/project` в коллекции `openspec-quality`: загрузка при перечитывании источников, сохранение при пересчёте документа; проверка — дымовой тест `packages/vscode/src/smoke.test.ts` «правило артефактов из quality.yaml и ссылка плана на пропавший тест — в «Проблемах»»
  ↳ spec-consistency / Правило артефактов в «Проблемах»

## 4. Документация и данные

- [x] 4.1 `openspec/quality.yaml` с правилами `design-alternative` и `task-acceptance`; исправлены ссылки на тесты в планах `add-context-control`, `add-context-usefulness`, `add-context-selection`; README — правила согласованности, `artifacts`, `--baseline`; контекст модулей; проверка — `npm run verify` и `npm run test:e2e` проходят, `openspec validate add-spec-consistency --strict` проходит
