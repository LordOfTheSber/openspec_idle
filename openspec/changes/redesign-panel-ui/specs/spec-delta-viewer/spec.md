## MODIFIED Requirements

### Requirement: Карта связей capability и changes

Система ДОЛЖНА (SHALL) показывать для выбранной capability все активные changes,
затрагивающие её, и наоборот — для выбранного change все затрагиваемые
capability. Связи ДОЛЖНЫ строиться по путям файлов дельт. При просмотре дельт
change система ДОЛЖНА предупреждать о capability, которые меняет ещё хотя бы
один активный change, называя эти changes.

#### Scenario: Capability под несколькими changes

- **WHEN** два активных change содержат дельты одной capability
- **THEN** карта показывает обе связи
- **AND** требования, изменяемые обоими changes, помечаются как конфликтующие

#### Scenario: Пересечение при просмотре дельт

- **WHEN** пользователь открывает дельты change, а его capability `ide-runtime` меняет ещё change `focus-context-map`
- **THEN** раздел показывает предупреждение о пересечении по `ide-runtime` с именем `focus-context-map`

#### Scenario: Capability не затронута ни одним change

- **WHEN** ни один активный change не содержит дельт для capability
- **THEN** карта показывает capability без связей
- **AND** сообщает, что активных изменений нет

#### Scenario: Дельта указывает на несуществующую capability

- **WHEN** путь дельты не соответствует ни одному спеку в `openspec/specs/`
- **THEN** связь помечается как висячая
- **AND** предлагается создать новую capability или исправить путь
