#!/usr/bin/env node
// Минимальный OpenAI-совместимый сервер для записи потоков CLI без настоящей модели.
// Первый ответ — текст и вызов инструмента, второй (после результата инструмента) — итоговый текст.
//
//   node mock-llm.mjs <порт> <режим: tool|fail> [задержка ответа, мс]
//
// Инструмент и его аргументы задаются переменными TOOL_NAME и TOOL_ARGS (JSON).
import http from 'node:http';

const port = Number(process.argv[2] ?? 18080);
const mode = process.argv[3] ?? 'tool';
const delay = Number(process.argv[4] ?? 0);
let counter = 0;

http
  .createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', async () => {
      const parsed = body === '' ? {} : JSON.parse(body);
      if (!request.url.includes('chat/completions')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
        return;
      }
      if (mode === 'fail') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error' } }));
        return;
      }
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const afterTool = (parsed.messages ?? []).some((message) => message.role === 'tool');
      const base = { id: `c${++counter}`, object: 'chat.completion.chunk', created: 1, model: 'test-model' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (chunk) => response.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`);
      if (!afterTool) {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Посмотрю файл задач.' } }] });
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: process.env.TOOL_NAME ?? 'read_file', arguments: '' } },
                ],
              },
            },
          ],
        });
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: process.env.TOOL_ARGS ?? JSON.stringify({ file_path: process.env.TARGET_FILE }) } },
                ],
              },
            },
          ],
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
      } else {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Готово: пункт выполнен.' } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 12, total_tokens: 212 } });
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  })
  .listen(port, '127.0.0.1');
