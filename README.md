# openspec_idle

Разработка **OpenSpec IDE** — локальной web-среды для работы по методологии
[OpenSpec](https://github.com/Fission-AI/OpenSpec). Сам проект ведётся по OpenSpec:
всё, что будет построено, сначала описано требованиями в `openspec/`.

## Что это будет

Локальный сервер + SPA, запускается командой `openspec-ide` в каталоге проекта и
открывается в браузере. Источник истины — файлы `openspec/` на диске и CLI
`@fission-ai/openspec`; своей базы состояния артефактов у IDE нет.

| Раздел | Назначение |
| --- | --- |
| Обозреватель | Дерево changes, спеков и архива, поиск, живая валидация |
| Редактор | Правка артефактов с подсветкой формата OpenSpec и панелью проверок |
| Дельты | Требования и сценарии структурно, diff против основного спека, карта связей |
| Доска | Фазы жизненного цикла change, операции `validate` и `archive` |
| Метрики | Измерения по каждому пункту плана и сводка по change |
| Агент | Запуск GigaCode CLI с бюджетом, привязанный к пункту плана |

Единственный канал к LLM — **GigaCode CLI** (форк Qwen Code). IDE сама в сеть не
ходит: весь трафик к модели идёт через этот процесс.

## Текущее состояние

Фаза планирования завершена, реализация не начата.

| Артефакт | Состояние |
| --- | --- |
| `proposal.md` | готов |
| `specs/` | 7 capability, 35 требований, 116 сценариев |
| `design.md` | готов |
| `tasks.md` | 49 задач в 10 группах |

Макеты интерфейса: [`docs/mockups/openspec-ide.html`](docs/mockups/openspec-ide.html)
— шесть экранов, каждый подписан требованиями, которые он реализует.

## Работа с проектом

```bash
npm install

npx openspec list                 # активные changes и прогресс
npx openspec show add-openspec-ide # содержимое change
npx openspec status --change add-openspec-ide
npx openspec validate add-openspec-ide --strict
```

Структура:

```
openspec/
  config.yaml                    контекст проекта и правила артефактов
  specs/                         основные спеки (появятся после архивации)
  changes/add-openspec-ide/
    proposal.md                  зачем и что меняется
    design.md                    как это устроено и почему так
    tasks.md                     план работ, у каждой задачи — критерий приёмки
    specs/<capability>/spec.md   требования и сценарии
docs/mockups/                    макеты интерфейса
```

## Capability

| Capability | О чём |
| --- | --- |
| `ide-runtime` | Запуск, разрешение корня, транспорт, безопасность, конфигурация |
| `workspace-explorer` | Навигация, поиск, синхронизация с файловой системой |
| `artifact-editor` | Редактирование артефактов, шаблоны, живая валидация |
| `spec-delta-viewer` | Структурный просмотр, diff дельт, связи capability ↔ changes |
| `workflow-board` | Доска фаз и операции над change |
| `task-metrics` | Метрики по пунктам плана и сводки |
| `agent-bridge` | Интеграция с GigaCode CLI |
