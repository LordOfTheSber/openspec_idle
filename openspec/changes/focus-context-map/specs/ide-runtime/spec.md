# Spec Delta: ide-runtime

## REMOVED Requirements

### Requirement: Конфигурация IDE

**Reason**: Файл `.openspec-ide/config.json` содержал только настройки агента, который удалён.
**Migration**: Файл больше не читается и может быть удалён; каталог `.openspec-ide/` остаётся для метрик.
