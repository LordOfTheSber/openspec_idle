import { describe, expect, it } from 'vitest';
import {
  TrackedItemNotFoundError,
  isDoneMarker,
  parseTrackedDocument,
  toggleTrackedItem,
} from './trackedItems.js';

const TASKS = `# Tasks

## 1. Каркас

- [x] 1.1 Поднять пакеты и проверить сборкой
- [ ] 1.2 Завести verify и проверить прогоном

## 2. Работа

- [ ] 2.1 Реализовать и проверить тестом
- [ ] 2.2 Проверить приёмкой
`;

/** Файл с намеренно неровным форматированием. */
const MESSY = `# Tasks

##   1.   Группа с лишними пробелами

  -   [ x ]   1.1   Отмечен непривычно
-[ ] 1.2 Без пробела после дефиса — CLI такой пункт считает
*  [X] 1.3 Звёздочка и заглавная X
- [~] 1.4 Тильда — это не выполнено
- [-] 1.5 Дефис — тоже не выполнено
- [] 1.6 Пустые скобки без пробела
Просто строка без чекбокса — пунктом не считается
`;

describe('разбор отслеживаемого артефакта', () => {
  it('считает пункты и выполненные среди них', () => {
    const document = parseTrackedDocument(TASKS);

    expect(document.total).toBe(4);
    expect(document.complete).toBe(1);
  });

  it('привязывает пункты к группам', () => {
    const document = parseTrackedDocument(TASKS);

    expect(document.groups.map((group) => group.title)).toEqual(['Каркас', 'Работа']);
    expect(document.items.map((item) => item.group)).toEqual([1, 1, 2, 2]);
    expect(document.items.map((item) => item.index)).toEqual([1, 2, 1, 2]);
  });

  it('извлекает объявленный номер и текст пункта отдельно', () => {
    const item = parseTrackedDocument(TASKS).items[0];

    expect(item?.declaredNumber).toBe('1.1');
    expect(item?.text).toBe('Поднять пакеты и проверить сборкой');
  });

  it('выполненным считается только маркер x в любом регистре и с пробелами', () => {
    expect(isDoneMarker('x')).toBe(true);
    expect(isDoneMarker(' x ')).toBe(true);
    expect(isDoneMarker('X')).toBe(true);
    expect(isDoneMarker('~')).toBe(false);
    expect(isDoneMarker('-')).toBe(false);
    expect(isDoneMarker('')).toBe(false);
  });

  it('неровное форматирование разбирается по тем же правилам, что у CLI', () => {
    const document = parseTrackedDocument(MESSY);

    // Числа сверены с выводом CLI на фикстуре messy-tasks: 6 пунктов, 2 из
    // них выполнены. Строка без пробела после дефиса пунктом считается.
    expect(document.total).toBe(6);
    expect(document.complete).toBe(2);
  });

  it('строка без чекбокса пунктом не считается', () => {
    const document = parseTrackedDocument(MESSY);

    expect(document.items.some((item) => item.text.includes('Просто строка'))).toBe(false);
  });

  it('пустой файл даёт пустой разбор', () => {
    expect(parseTrackedDocument('')).toMatchObject({ total: 0, complete: 0 });
  });
});

describe('переключение отметки пункта', () => {
  it('отметка выполнения ставит x и не трогает остальные строки', () => {
    const next = toggleTrackedItem(TASKS, 6, true);

    expect(next.split('\n')[5]).toBe('- [x] 1.2 Завести verify и проверить прогоном');
    // Остальные строки побайтово те же.
    const before = TASKS.split('\n');
    const after = next.split('\n');
    for (let index = 0; index < before.length; index += 1) {
      if (index === 5) continue;
      expect(after[index]).toBe(before[index]);
    }
  });

  it('снятие отметки очищает скобки и пересчитывает прогресс', () => {
    const next = toggleTrackedItem(TASKS, 5, false);

    expect(next.split('\n')[4]).toBe('- [ ] 1.1 Поднять пакеты и проверить сборкой');
    expect(parseTrackedDocument(next).complete).toBe(0);
  });

  it('на неровном форматировании меняются только скобки', () => {
    const document = parseTrackedDocument(MESSY);
    const item = document.items[0];
    expect(item).toBeDefined();
    if (item === undefined) return;

    const next = toggleTrackedItem(MESSY, item.line, false);

    expect(next).toContain('  -   [ ]   1.1   Отмечен непривычно');
    // Длина файла меняется ровно на сжатие маркера с « x » до « ».
    expect(MESSY.length - next.length).toBe(item.markerLength - 1);
    expect(next.split('\n').length).toBe(MESSY.split('\n').length);
  });

  it('отступ и маркер списка сохраняются', () => {
    const document = parseTrackedDocument(MESSY);
    const star = document.items.find((item) => item.text.includes('Звёздочка'));
    if (star === undefined) return;

    const next = toggleTrackedItem(MESSY, star.line, false);
    expect(next).toContain('*  [ ] 1.3 Звёздочка и заглавная X');
  });

  it('повторное переключение возвращает исходное состояние', () => {
    const off = toggleTrackedItem(TASKS, 5, false);
    const on = toggleTrackedItem(off, 5, true);

    expect(on).toBe(TASKS);
  });

  it('строка без пункта даёт понятную ошибку', () => {
    expect(() => toggleTrackedItem(TASKS, 1, true)).toThrow(TrackedItemNotFoundError);
  });
});
