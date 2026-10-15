# Tasks

## 1. Модель

- [ ] 1.1 Формат `openspec-run/1` и его разбор `parseRunReport` в `packages/core/src/runReport.ts`: обязательные поля, версия, «нет данных» вместо нуля; новые необязательные поля `run-finished` (`cacheRead`, `cacheWrite`, `model`, `agent`, `searches`, `callsBeforeFirstEdit`, `filesEdited`); проверка — модульные тесты нового файла `runReport.test.ts` рядом с моделью на полный отчёт, отчёт без токенов и неизвестную версию
  ↳ task-metrics / Полный отчёт
  ↳ task-metrics / Отчёт без расхода токенов
  ↳ task-metrics / Отчёт неизвестной версии
  ↳ task-metrics / Отчёт без обязательного поля
- [ ] 1.2 Привязка `bindRun` по цепочке правил в `packages/core/src/runReport.ts`; проверка — модульные тесты на каждое правило и на два пункта, отмеченных во время запуска
  ↳ task-metrics / Явная привязка
  ↳ task-metrics / Пункт взят в работу
  ↳ task-metrics / Пункт отмечен во время запуска
  ↳ task-metrics / Несколько пунктов отмечены во время запуска
  ↳ task-metrics / Запуск вне change
- [ ] 1.3 Свёртка: доля разведки, сводки по сценариям (строки `↳`) и модулям контекста (`code_paths`), признак «с первого раза», кандидаты на аудит; проверка — тесты `packages/core/src/metrics.test.ts` на запуск без правок, запуск в двух модулях и порог в 5 запусков
  ↳ task-metrics / Запуск с правкой
  ↳ task-metrics / Запуск без правок
  ↳ task-metrics / Расход на сценарий
  ↳ task-metrics / Запуск в двух модулях
  ↳ task-metrics / Модуль с высокой долей разведки
  ↳ task-metrics / Задача с первого раза
  ↳ task-metrics / Задача возвращалась в работу

## 2. Приём

- [ ] 2.1 Приём inbox в `packages/server/src/metrics.ts`: при запуске бэкенда и по событию наблюдателя, дедупликация по `runId`, удаление записанных, предупреждение о неверных; `/api/metrics` — новые поля, `API_REVISION` +1; проверка — тесты `packages/server/src/metrics.test.ts` на временном каталоге: отчёт при открытой и закрытой IDE, повтор `runId`, файлы `openspec/` не изменились
  ↳ task-metrics / Появление файла в inbox при открытой IDE
  ↳ task-metrics / Отчёт записан при закрытой IDE
  ↳ task-metrics / Повторный отчёт
- [ ] 2.2 Проверка `metrics` в `openspec-ide-check`: приём inbox и предупреждения о неверных отчётах; проверка — тест `packages/check/src/report.test.ts` и `node packages/check/dist/openspec-ide-check.mjs --only metrics` с двумя отчётами — код 0
  ↳ task-metrics / Приём при проверке metrics в CI

## 3. Адаптер Claude Code

- [ ] 3.1 Команда `openspec-ide-check report-run`: данные хука из стандартного ввода, разбор транскрипта (`message.usage`, `message.model`, блоки `tool_use`), курсор сессии в inbox, тихий выход при ошибке; проверка — тест на записанном транскрипте из `tests/fixtures/` с двумя вызовами подряд и с отсутствующим файлом
  ↳ task-metrics / Два отчёта одной сессии
  ↳ task-metrics / Транскрипт не найден или не разбирается

## 4. Интерфейс и документация

- [ ] 4.1 Раздел «Метрики»: столбцы токенов по видам и доли разведки, сводки «по сценариям» и «по модулям» с отметкой кандидатов на аудит, признак «с первого раза»; проверка — e2e `tests/e2e/metrics.spec.ts` на фикстуре с журналом из трёх запусков
- [ ] 4.2 README: подключение хука `Stop` в `.claude/settings.json`, формат отчёта для других агентов, переменные `OPENSPEC_CHANGE` и `OPENSPEC_TASK`; навык `context-audit` — сводка по модулям как источник приоритетов аудита; проверка — `npm run verify` и `npm run test:e2e` проходят, `openspec validate add-agent-run-metrics --strict` проходит
