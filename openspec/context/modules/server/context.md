# Контекст модуля server

Пакет `@openspec-ide/server`: Fastify-приложение `createApp()` в
`src/server.ts`. Все возможности IDE — маршруты `/api/*`; интерфейс, расширение
и `openspec-ide-check` ходят только через них, поэтому правила у всех одни.

## Режимы запуска

- **Встроенный** — `createEmbeddedBackend()` в `src/embedded.ts`: приложение
  без порта, запросы через `app.inject()`, наблюдатель и шина событий. Так
  работают расширение и CI-проверка.
- **HTTP** — `startServer()` на `127.0.0.1` для разработки интерфейса
  (`npm run dev`): токен сессии в каждом запросе (`src/http/session.ts`),
  обновления — SSE `/api/events`.

## Внешний мир

- CLI OpenSpec — только `src/openspec/client.ts` поверх `src/openspec/exec.ts`
  (`--json`, разбор ответа, понятная ошибка); поиск исполняемого файла вне
  `PATH` редактора — `src/openspec/locate.ts`, запуск `.cmd` на Windows —
  `src/process/platform.ts`.
- git — `src/git.ts`: `execFile` без оболочки, `GIT_OPTIONAL_LOCKS=0`, любой
  сбой — «нет данных», а не ошибка.
- Файлы — только внутри корня: пути канонизируются после `realpath`
  (`src/http/paths.ts`, `src/fs/workspace.ts`); запись — с проверкой версии
  содержимого, чтобы не затереть чужую правку.
- Наблюдатель `src/watcher.ts` (chokidar) следит за `openspec/` и объединяет
  события в одно обновление — архивация меняет десятки файлов разом.

## Сервисы

Каждый раздел — свой класс рядом с маршрутом: `src/board.ts`,
`src/deltas.ts`, `src/metrics.ts` и `src/metricsStore.ts` (журнал событий в
каталоге `.openspec-ide`), `src/structure.ts`, `src/contextMap.ts`,
`src/drift.ts`, `src/trace.ts`, `src/archivePreview.ts` (настоящий
`openspec archive` на временной копии), `src/schemaRegistry.ts`,
`src/validation.ts`, `src/check.ts` (прогон проверок для CI),
`src/authoring.ts` (тексты спеков, дельт и планов для редактора) и
`src/quality.ts` (`openspec/quality.yaml`, файлы реестра кодов ошибок, файлы
тестов из планов, код модулей домена, спеки ревизии git для `--baseline`,
правка `rules` и `exclude` с сохранением комментариев).

## Как менять

- Маршрут добавляется в `src/server.ts`, логика — в сервисе, правило — в `core`.
- Ошибка пользователя — исключение с кодом 4xx и русским сообщением; остальное
  обработчик ошибок превращает в 500 с текстом.
- Тесты — на временных каталогах или копиях `tests/fixtures/`, без сети.
