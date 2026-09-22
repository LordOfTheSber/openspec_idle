# Spec Delta: data-export

## MODIFIED Requirements

### Requirement: Выгрузка данных

Система ДОЛЖНА (SHALL) выгружать данные пользователя в форматах CSV и JSON.

#### Scenario: Успешная выгрузка

- **WHEN** пользователь запрашивает выгрузку
- **THEN** отдаётся файл со всеми его данными

## REMOVED Requirements

### Requirement: Устаревшая выгрузка
**Reason**: Заменена новой выгрузкой
**Migration**: Используйте /api/v2/export

## RENAMED Requirements

### Requirement: Кодировка выгрузки
FROM: `### Requirement: Кодировка файла`
TO: `### Requirement: Кодировка выгрузки`
