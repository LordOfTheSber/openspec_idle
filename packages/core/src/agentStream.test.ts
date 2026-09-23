import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NdjsonSplitter,
  type RunTally,
  classifyOutcome,
  emptyTally,
  parseAgentJsonOutput,
  parseAgentLine,
  tallyMessage,
} from './agentStream.js';

/** Потоки, записанные с настоящего CLI (см. tests/agent/README.md). */
const RECORDED = fileURLToPath(new URL('../../../tests/agent/qwen-code-0.24.4/', import.meta.url));

function recorded(name: string): string {
  return readFileSync(`${RECORDED}${name}`, 'utf8');
}

function tallyOf(text: string): RunTally {
  const splitter = new NdjsonSplitter();
  let tally = emptyTally();
  for (const line of splitter.push(text)) tally = tallyMessage(tally, parseAgentLine(line));
  const rest = splitter.end();
  if (rest !== null) tally = tallyMessage(tally, parseAgentLine(rest));
  return tally;
}

function ending(tally: RunTally, extra: Partial<Parameters<typeof classifyOutcome>[0]> = {}) {
  return {
    exitCode: 0,
    stoppedByUser: false,
    watchdogFired: false,
    stderr: '',
    tally,
    maxToolCalls: 120,
    budgetExitCode: 55,
    ...extra,
  };
}

describe('разбор записанных потоков', () => {
  it('успешный запуск: сессия, вызов инструмента, итог и расход из итога', () => {
    const tally = tallyOf(recorded('stream-read.jsonl'));

    expect(tally.sessionId).not.toBeNull();
    expect(tally.model).toBe('test-model');
    expect(tally.toolCalls).toBe(1);
    expect(tally.tokensIn).toBe(320);
    expect(tally.tokensOut).toBe(42);
    expect(tally.finalText).toBe('Готово: пункт выполнен.');
    expect(tally.result?.ok).toBe(true);
    // Чтение файл не меняет.
    expect(tally.files).toEqual([]);
    expect(classifyOutcome(ending(tally))).toBe('success');
  });

  it('запись файла попадает в список затронутых', () => {
    const tally = tallyOf(recorded('stream-write.jsonl'));
    expect(tally.files).toEqual(['/workspace/notes.md']);
  });

  it('превышение предела вызовов: исход по тексту ошибки, собранный расход сохранён', () => {
    const tally = tallyOf(recorded('stream-toolbudget.jsonl'));
    const outcome = classifyOutcome(
      ending(tally, { exitCode: 55, stderr: recorded('stream-toolbudget.stderr'), maxToolCalls: 0 }),
    );

    expect(outcome).toBe('budget-tools');
    expect(tally.result).toBeNull();
    expect(tally.tokensIn).toBe(120);
    expect(tally.toolCalls).toBe(1);
  });

  it('превышение предела времени — отдельный исход', () => {
    const tally = tallyOf(recorded('stream-walltime.jsonl'));
    expect(classifyOutcome(ending(tally, { exitCode: 55, stderr: recorded('stream-walltime.stderr') }))).toBe(
      'budget-time',
    );
    // Модель ничего не ответила: расхода нет, и это не ноль.
    expect(tally.tokensIn).toBeNull();
  });

  it('ошибка API: итог с ошибкой и ненулевой код — неуспех', () => {
    const tally = tallyOf(recorded('stream-apierror.jsonl'));
    expect(tally.result?.ok).toBe(false);
    expect(tally.result?.error).toMatch(/401/);
    expect(classifyOutcome(ending(tally, { exitCode: 1 }))).toBe('failure');
  });

  it('одноразовый вывод разбирается в те же показатели', () => {
    let tally = emptyTally();
    for (const message of parseAgentJsonOutput(recorded('oneshot-read.json'))) tally = tallyMessage(tally, message);
    expect(tally.toolCalls).toBe(1);
    expect(tally.tokensIn).toBe(320);
    expect(tally.result?.ok).toBe(true);
  });
});

describe('устойчивость разбора', () => {
  it('событие неизвестного типа сохраняется как есть, обработка продолжается', () => {
    const lines = [
      '{"type":"thought_summary","text":"думаю"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"дальше"}]}}',
    ].join('\n');
    const splitter = new NdjsonSplitter();
    const events = splitter.push(`${lines}\n`).flatMap((line) => parseAgentLine(line).events);

    expect(events[0]).toEqual({ kind: 'unknown', raw: { type: 'thought_summary', text: 'думаю' } });
    expect(events[1]).toEqual({ kind: 'text', text: 'дальше' });
  });

  it('неизвестный блок содержимого сохраняется, соседние разбираются', () => {
    const { events } = parseAgentLine(
      '{"type":"assistant","message":{"content":[{"type":"image","data":"x"},{"type":"text","text":"ок"}]}}',
    );
    expect(events.map((event) => event.kind)).toEqual(['unknown', 'text']);
  });

  it('строка, разорванная между кусками, собирается целиком', () => {
    const splitter = new NdjsonSplitter();
    expect(splitter.push('{"type":"assistant","mess')).toEqual([]);
    const lines = splitter.push('age":{"content":"привет"}}\n');
    expect(parseAgentLine(lines[0] ?? '').events).toEqual([{ kind: 'text', text: 'привет' }]);
  });

  it('оборванная последняя строка отмечается и не роняет разбор', () => {
    const text = `${recorded('stream-read.jsonl').split('\n').slice(0, 4).join('\n')}\n{"type":"result","subtype":"succ`;
    const tally = tallyOf(text);

    expect(tally.unknownEvents).toBe(1);
    expect(tally.toolCalls).toBe(1);
    expect(tally.result).toBeNull();
  });
});

describe('исход запуска', () => {
  it('остановка пользователем важнее кода возврата', () => {
    expect(classifyOutcome(ending(emptyTally(), { exitCode: null, stoppedByUser: true }))).toBe('aborted');
  });

  it('сторожевой таймер IDE — превышение времени', () => {
    expect(classifyOutcome(ending(emptyTally(), { exitCode: null, watchdogFired: true }))).toBe('budget-time');
  });

  it('код бюджета без текста: какой предел превышен, решает счётчик вызовов', () => {
    const many = { ...emptyTally(), toolCalls: 6 };
    expect(classifyOutcome(ending(many, { exitCode: 55, maxToolCalls: 5 }))).toBe('budget-tools');
    expect(classifyOutcome(ending(emptyTally(), { exitCode: 55, maxToolCalls: 5 }))).toBe('budget-time');
  });
});
