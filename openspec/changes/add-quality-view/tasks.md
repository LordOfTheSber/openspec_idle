# Tasks

## 1. Модель

- [x] 1.1 Исключения: `exclude` в `parseQualityConfig`, `pathMatches`, `applyExclusions`, `requirement` у замечаний, исключённый целиком файл вне метрик; проверка — тесты «исключения правил» в `packages/core/src/qualityOverview.test.ts`
  ↳ quality-view / Правило в требовании
  ↳ quality-view / Старые спеки исключены целиком
  ↳ quality-view / Исключение без условий
- [x] 1.2 Каталог `QUALITY_RULE_INFO`, сводка `qualityOverview`, подсказка о другом модуле в `specCodeIssues`; проверка — тесты «сводка раздела «Качество»» и «цитата нашлась в другом модуле» в `packages/core/src/qualityOverview.test.ts`
  ↳ quality-view / Сообщение в модуле без домена

## 2. Сервер

- [x] 2.1 Маршруты `GET /api/quality`, `POST /api/quality/init`, `POST /api/quality/rule`, `POST|DELETE /api/quality/exclusions`; правка `quality.yaml` с сохранением комментариев; строки элементов списков; ревизия API — 12; проверка — тесты `packages/server/src/quality.test.ts`
  ↳ quality-view / Уровень по умолчанию

## 3. Интерфейс

- [x] 3.1 Раздел «Качество» в `packages/web/src/components/Quality.tsx`: плитки, фильтры, правила, файлы, замечания по требованиям, карточка правила с уровнем, исключение из строки и список исключений, пороги, ошибки настроек, создание `quality.yaml`, узкая раскладка; проверка — e2e `tests/e2e/quality.spec.ts`
  ↳ quality-view / Файлы по убыванию предупреждений
  ↳ quality-view / Изменение файлов проекта
  ↳ quality-view / Замечания файла по требованиям
  ↳ quality-view / Правило выключено из раздела
  ↳ quality-view / Исключить с причиной
  ↳ quality-view / Снять исключение
  ↳ quality-view / Порог не выполнен
  ↳ quality-view / Создать настройки
  ↳ quality-view / Панель рядом с редактором
- [x] 3.2 Чип качества на карточке доски, блок «Качество» в деталях change с переходом в раздел по change; проверка — e2e `tests/e2e/quality.spec.ts` «с доски: чип качества на карточке и переход в раздел с фильтром по change»
  ↳ quality-view / Чип и переход с доски

## 4. VS Code

- [x] 4.1 Команда «OpenSpec: Качество спеков», раздел панели, «⚠ N» у change и спеков в дереве; проверка — тест `packages/vscode/src/treeModel.test.ts` «отметки качества в дереве»
  ↳ quality-view / Счётчик в дереве

## 5. Документация

- [x] 5.1 README — раздел «Качество» и исключения; контекст модулей `web`, `vscode`, `core`, `server`; проверка — `npm run verify` и `npm run test:e2e` проходят, `openspec validate add-quality-view --strict` проходит
