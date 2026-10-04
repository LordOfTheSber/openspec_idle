# Tasks

## 1. Модель

- [x] 1.1 `contextControl.ts` в `core`: оценка токенов, извлечение ссылок из markdown, кандидаты путей, повторы абзацев, пустой контекст, статус ADR; проверка — модульные тесты `packages/core/src/contextControl.test.ts`
  ↳ context-map / Лишнее в контексте
- [x] 1.2 `buildContextMap` и `contextBundle`: размеры файлов, `max_tokens`, новые замечания, `active` у ADR, `tokens` и `skippedAdrs` набора, параметр `inactiveAdrs`; проверка — тесты `packages/core/src/contextMap.test.ts` на каждое новое замечание, бюджет и пропуск ADR
  ↳ context-map / Объём контекста
  ↳ context-map / Отменённые ADR вне набора

## 2. Сервер

- [x] 2.1 Чтение текстов контекста, проверка путей ссылок, файлы вне наборов, свежесть по git (`GitHistory.lastCommit`, `commitsAfter`); проверка — тесты `packages/server/src/contextMap.test.ts`, в том числе на временном репозитории git с коммитом в код после контекста и без git
  ↳ context-map / Связь контекста с реальностью

## 3. Интерфейс и VS Code

- [x] 3.1 Вид «Контроль», токены в сводке, в карточке модуля и наборе, флажок «недействующие ADR», уровень «сведение» в замечаниях; проверка — e2e `tests/e2e/context.spec.ts` «вид Контроль показывает объём, лишнее и ненайденные пути»
  ↳ context-map / Вид «Контроль» раздела «Контекст»
- [x] 3.2 Сведения карты контекста — уровнем Information в панели «Проблемы»; проверка — тест `packages/vscode/src/units.test.ts`
- [x] 3.3 Узкая панель: колонки «Чей», «Строк», «Файлов», «Пути кода» скрываются уже 640 px; макеты `docs/mockups/context-control.html`; проверка — снимок раздела на ширине 520 px совпадает с экраном «Узкая панель» макета

## 4. Документация и контекст проекта

- [x] 4.1 README: раздел «Контроль контекста», поле `max_tokens`, таблица замечаний; проверка — `npm run verify` проходит, `openspec validate add-context-control --strict` проходит
- [x] 4.2 Контекст репозитория в `openspec/context/`: общий контекст, пять модулей с `max_tokens`, шесть ADR (один — `superseded`), правило `context?` в `openspec/structure.yaml`; проверка — `openspec-ide-check --only structure,context` без ошибок, все пути в тексте найдены, наборы модулей в пределах бюджетов
