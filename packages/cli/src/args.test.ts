import { describe, expect, it } from 'vitest';
import { ArgsError, parseArgs } from './args.js';

describe('разбор аргументов openspec-ide', () => {
  it('без аргументов берёт текущий каталог, свободный порт и открывает браузер', () => {
    const options = parseArgs([]);
    expect(options).toMatchObject({ path: '.', port: null, open: true, dev: false });
  });

  it('принимает путь, порт и отказ от открытия браузера', () => {
    const options = parseArgs(['./some/project', '--port', '7410', '--no-open']);
    expect(options).toMatchObject({ path: './some/project', port: 7410, open: false });
  });

  it('принимает порт в форме --port=7410', () => {
    expect(parseArgs(['--port=7410']).port).toBe(7410);
  });

  it('отвергает порт вне допустимого диапазона', () => {
    expect(() => parseArgs(['--port', '70000'])).toThrow(ArgsError);
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/Недопустимый порт/);
  });

  it('требует значение для --port', () => {
    expect(() => parseArgs(['--port'])).toThrow(/требует номер порта/);
  });

  it('отвергает неизвестную опцию и второй путь', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Неизвестная опция/);
    expect(() => parseArgs(['a', 'b'])).toThrow(/Лишний аргумент/);
  });
});
