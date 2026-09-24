# Spec Delta: ide-runtime

## REMOVED Requirements

### Requirement: Запуск IDE в каталоге проекта

**Reason**: Точкой входа становится расширение VS Code (capability
`vscode-extension`). Отдельный бинарь `openspec-ide`, порт и открытие браузера
больше не нужны: бэкенд работает внутри процесса расширения.

**Migration**: Установить расширение `openspec-ide` в VS Code и открыть каталог
проекта как рабочую область. Вместо `openspec-ide <путь>` — «Файл → Открыть
папку». HTTP-режим бэкенда сохраняется только для разработки интерфейса
(`npm run dev`) и сквозных тестов.
