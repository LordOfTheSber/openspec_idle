# Записанный интерфейс CLI агента

IDE запускает агента через GigaCode CLI — форк Qwen Code. Флаги запуска и формат
потока событий здесь не предполагаются, а записаны с настоящей сборки CLI:

| Каталог | Что это |
|---|---|
| `qwen-code-0.24.4/` | вывод `--help` и потоки `stream-json` сборки Qwen Code 0.24.4 (npm `@qwen-code/qwen-code`), от которой унаследован интерфейс GigaCode CLI |
| `stub/` | заглушка CLI для тестов: воспроизводит записанные потоки |

В каждом каталоге сборки:

- `help.txt` — вывод `--help`; `packages/server/src/agent/launch.test.ts` сверяет
  с ним шаблон аргументов IDE: все флаги, режимы подтверждения и форматы вывода;
- `stream-*.jsonl` и `*.stderr` — вывод реальных запусков против
  `mock-llm.mjs` (OpenAI-совместимая заглушка модели): чтение файла, запись файла,
  превышение предела вызовов (код 55), превышение предела времени (код 55),
  ошибка API; `oneshot-read.json` — одноразовый формат `--output-format json`;
- `recording.json` — сборка, версия и коды выхода.

Пути рабочего каталога в записях заменены на `/workspace`.

## Запись с установленной сборки GigaCode CLI

Публично GigaCode CLI не распространяется, поэтому эталон записан с Qwen Code.
Когда сборка GigaCode установлена, запишите её интерфейс рядом:

```sh
node tests/agent/record.mjs gigacode tests/agent/gigacode-<версия>
npx vitest run packages/server/src/agent packages/core/src/agentStream.test.ts
```

Тест сверки проходит по всем каталогам с `help.txt`: если флаги сборки разошлись
с шаблоном по умолчанию, он укажет, какой флаг не найден. Расхождение правится в
`.openspec-ide/config.json` (`agent.launch.args`) без изменения кода IDE.
