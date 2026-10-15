# Tasks

## 1. Модель

- [x] 1.1 `buildContextMap` и `contextBundle` в `packages/core/src/contextMap.ts`: модуль с файлом метаданных и списком файлов, `files`, `groupFiles`, `section`, группы на карте, вид файла `group`, файл метаданных в наборе только с текстом, порядок по номерам, пустота по каждой части, свежесть по всем файлам; ревизия API — 13; проверка — тесты `packages/core/src/contextMap.test.ts` «карта контекста: произвольная раскладка»
  ↳ context-map / Модуль из нумерованных частей
  ↳ context-map / Общий контекст группы
  ↳ context-map / Прежний index.md без текста
  ↳ context-map / Пустая часть
  ↳ context-map / Весь контекст в файле метаданных
- [x] 1.2 Обход `scanContext` в `packages/server/src/contextMap.ts`: модули на любой глубине и в любых разделах, группы, модуль без файла метаданных, файлы вне наборов; свежесть по всем файлам модуля (`lastCommit` и `hasChanges` с несколькими путями в `packages/server/src/git.ts`); сверка спеков с кодом в `packages/server/src/quality.ts` по тем же модулям; проверка — тесты `packages/server/src/contextMap.test.ts` «раскладка контекста: разделы, группы, вложенные модули», фикстура `context-layered` без замечаний, `packages/server/src/check.test.ts` с модулем `modules/back/export`
  ↳ context-map / Модуль конфигурации без части тестирования
  ↳ context-map / Новый раздел
  ↳ context-map / Папка модуля без файла метаданных
  ↳ context-map / Файл не .md в папке модуля
  ↳ context-map / Свежесть по любой части
- [x] 1.3 «Создать модуль…» с группами в имени и в раскладке проекта; проверка — тесты `packages/server/src/contextMap.test.ts` и `packages/server/src/trace.test.ts`
  ↳ context-map / Модуль в группе
  ↳ context-map / Проект на прежней раскладке
  ↳ context-map / Недопустимое имя

## 2. Интерфейс

- [x] 2.1 Карточка модуля — папка, все файлы, объём и полезность по файлам модуля; пустое состояние и форма создания объясняют раскладку; вид файла «группа» и подписи в виде «Контроль»; проверка — e2e `tests/e2e/context.spec.ts` «модули в группе modules/back/: карточка перечисляет части, набор берёт их по номерам, новая часть подхватывается»

## 3. Документация

- [x] 3.1 README (разделы «Контекст модулей» и «Контроль контекста», пример `structure.yaml`), `openspec/config.yaml`, README расширения, навык `context-fill` в `.claude/skills/` и `.agents/skills/` с промптом перевода модуля на нумерованные части; проверка — пример `structure.yaml` из README проходит на фикстуре `context-layered` (`openspec-ide-check --only structure,context`), `npm run verify` и `npm run test:e2e` проходят, `openspec validate generalize-context-layout --strict` проходит
