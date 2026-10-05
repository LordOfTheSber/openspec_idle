# Tasks

## 1. Модель

- [ ] 1.1 Разбор требований со строками и правила R1–R13 в `packages/core/src/specQuality.ts`: предложения, шаги с наследованием `AND`, реестры терминов, сравнение слов по общему началу, уровни по умолчанию; проверка — модульные тесты `packages/core/src/specQuality.test.ts` на каждое правило, его исключения и сквозной пример спеки сессий
  ↳ spec-quality / Удалённое требование не проверяется
  ↳ spec-quality / Код из текста без сценария
  ↳ spec-quality / Имя переменной — не код ошибки
  ↳ spec-quality / Непокрытое условие
  ↳ spec-quality / Значение перечисления без сценария
  ↳ spec-quality / Нет сценариев на границах интервала
  ↳ spec-quality / Размер, равный лимиту
  ↳ spec-quality / Ожидание противоречит правилу
  ↳ spec-quality / Вызов метода в THEN
  ↳ spec-quality / THEN о кэше
  ↳ spec-quality / Параметр вне раздела Configuration
  ↳ spec-quality / Непустой реестр из настроек
  ↳ spec-quality / Реестр пуст
  ↳ spec-quality / Подлежащее не из словаря
  ↳ spec-quality / Валидный запрос
  ↳ spec-quality / Сообщение в кавычках
  ↳ spec-quality / Только сценарий с ошибкой
  ↳ spec-quality / Только успешный сценарий
  ↳ spec-quality / Операция и заголовки в одном требовании
  ↳ spec-quality / Обещанный healthcheck
- [ ] 1.2 Настройки и метрики: `parseQualityConfig` и `registryCodes` в `packages/core/src/specQualityConfig.ts`, уровни и `off`, `scope`, реестр кодов, метрики и пороги в `specQuality`; проверка — тесты «настройки проверки качества», «реестр кодов ошибок» и «пороги метрик и уровни правил» в `packages/core/src/specQuality.test.ts`
  ↳ spec-quality / Код без спецификации
  ↳ spec-quality / Код вне реестра
  ↳ spec-quality / Правило выключено
  ↳ spec-quality / Уровень правила повышен
  ↳ spec-quality / Только дельты

## 2. Сервер и CI

- [ ] 2.1 `readQualityConfig` в `packages/server/src/quality.ts` (YAML со строками ключей, файлы реестра от корня проекта), поле `quality` у `/api/authoring`; проверка `quality` в `packages/server/src/check.ts` с именем правила в сообщении и метриками; строка метрик в отчёте `text` в `packages/check/src/report.ts`; проверка — тесты `packages/server/src/check.test.ts` «quality: …» и `packages/check/src/report.test.ts` «метрики проверки качества», `node packages/check/dist/openspec-ide-check.mjs --only quality` на этом репозитории — код 0
  ↳ spec-quality / Неизвестное правило
  ↳ spec-quality / Трассируемость ниже порога
  ↳ spec-quality / Отчёт с метриками
  ↳ spec-quality / Замечание с правилом

## 3. Редактор

- [ ] 3.1 Коллекция диагностик `openspec-quality` в `packages/vscode/src/authoring.ts`: код — имя правила, пересчёт вместе с проверкой ссылок по несохранённому тексту; проверка — дымовой тест `packages/vscode/src/smoke.test.ts` «качество спека при наборе»
  ↳ spec-quality / Замечание при наборе

## 4. Документация

- [ ] 4.1 README: раздел «Качество спеков» с таблицей правил, настройками и метриками, проверка `quality` в разделе CI; `quality.yaml?: file` в `openspec/structure.yaml`; контекст модулей `core`, `server`, `vscode`, `check`; проверка — `npm run verify` и `npm run test:e2e` проходят, `openspec validate add-spec-quality --strict` проходит
