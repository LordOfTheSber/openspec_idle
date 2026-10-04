# Tasks

## 1. Модель

- [x] 1.1 `findTokenAntipatterns`, `antipatternMessage`, `antipatternSavings` в `packages/core/src/contextAntipatterns.ts`: семь видов, пороги, исключения, экономия; проверка — модульные тесты `packages/core/src/contextAntipatterns.test.ts` на каждый вид, его исключения и сумму экономии
  ↳ context-map / Русский текст в контексте модуля
  ↳ context-map / Нормативные слова спеки — не капс
- [x] 1.2 `buildContextMap`: `antipatterns` и `savableTokens` у файла, `savableTokens` карты, сведения семи видов с модулем или доменом, недействующие ADR не проверяются; ревизия API — 11; проверка — тест `packages/core/src/contextMap.test.ts` «антипаттерны по токенам — сведения у файла и сумма по карте», `node packages/check/dist/openspec-ide-check.mjs --only context` на этом репозитории — код 0
  ↳ context-map / Капс в общем контексте
  ↳ context-map / Антипаттерны в CI

## 2. Интерфейс

- [x] 2.1 Карточка «Антипаттерны» в виде «Контроль»: экономия всего контекста, файлы по убыванию экономии, чипы находок с полным сообщением в подсказке; проверка — e2e `tests/e2e/context.spec.ts` «вид «Контроль» показывает объём, лишнее, антипаттерны и ненайденные пути»
  ↳ context-map / Файл с капсом в карточке

## 3. Документация

- [x] 3.1 README: антипаттерны в разделе «Контроль контекста», строки в таблице замечаний; навык `context-fill` — шаг про антипаттерны в промпте сжатия; проверка — `npm run verify` и `npm run test:e2e` проходят, `openspec validate add-context-antipatterns --strict` проходит
