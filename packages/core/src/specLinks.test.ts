import { describe, expect, it } from 'vitest';
import { findByAnchor, headingSlug, parseSpecLinks, relativePath, requirementAnchor, requirementHref, requirementLink } from './specLinks.js';

describe('якорь требования по правилам GitHub', () => {
  it('кириллица, знаки препинания и « / »', () => {
    expect(requirementAnchor('Кэш ответов')).toBe('requirement-кэш-ответов');
    expect(requirementAnchor('Счета / Нумерация счетов')).toBe('requirement-счета--нумерация-счетов');
    expect(requirementAnchor('НДС: округление (до копеек), v2!')).toBe('requirement-ндс-округление-до-копеек-v2');
    expect(headingSlug('Ёлка_и-ёж 2')).toBe('ёлка_и-ёж-2');
  });

  it('поиск требования по якорю', () => {
    expect(findByAnchor('requirement-кэш-ответов', ['Кэш ответов', 'Другое'])).toBe('Кэш ответов');
    expect(findByAnchor('Requirement-Кэш-Ответов', ['Кэш ответов'])).toBe('Кэш ответов');
    expect(findByAnchor('requirement-нет', ['Кэш ответов'])).toBeNull();
  });
});

describe('ссылки между спеками', () => {
  it('разбирает ссылку на требование и на спеку целиком, внешние пропускает', () => {
    const text = [
      'Сбрасывать кэш ([km/core: Кэш ответов](../km/core/spec.md#requirement-кэш-ответов)).',
      'См. [авторизацию](../auth/spec.md) и [сайт](https://example.com/spec.md).',
      '[заметка](../notes.md)',
    ].join('\n');
    expect(parseSpecLinks(text, 'billing')).toEqual([
      { line: 1, label: 'km/core: Кэш ответов', href: '../km/core/spec.md#requirement-кэш-ответов', capability: 'km/core', anchor: 'requirement-кэш-ответов' },
      { line: 2, label: 'авторизацию', href: '../auth/spec.md', capability: 'auth', anchor: null },
    ]);
  });

  it('якорь в процентной кодировке раскодируется', () => {
    const [link] = parseSpecLinks('[x](../km/core/spec.md#requirement-%D0%BA%D1%8D%D1%88)', 'billing');
    expect(link?.anchor).toBe('requirement-кэш');
  });

  it('относительный путь от вложенной capability', () => {
    expect(requirementHref('km/core', 'billing', 'Счета / Нумерация счетов')).toBe(
      '../../billing/spec.md#requirement-счета--нумерация-счетов',
    );
    expect(requirementHref('billing', 'km/core', null)).toBe('../km/core/spec.md');
    expect(requirementHref('billing/invoices', 'billing/refunds', null)).toBe('../refunds/spec.md');
    expect(relativePath('specs/a', 'specs/a/spec.md')).toBe('spec.md');
  });

  it('ссылка из дельты разрешается одинаково до и после архивации', () => {
    // Вставка в дельту change `add-x` для capability billing строит путь от specs/billing/.
    const link = requirementLink('billing', 'km/core', 'Кэш ответов');
    expect(link).toBe('[km/core: Кэш ответов](../km/core/spec.md#requirement-кэш-ответов)');
    // В дельте (changes/add-x/specs/billing/spec.md) и в спеке после архивации
    // (specs/billing/spec.md) разбор идёт от capability — цель одна и та же.
    const inDelta = parseSpecLinks(link, 'billing')[0];
    const archived = parseSpecLinks(link, 'billing')[0];
    expect(inDelta).toEqual(archived);
    expect(inDelta?.capability).toBe('km/core');
  });

  it('путь за пределы specs не считается ссылкой на спеку', () => {
    expect(parseSpecLinks('[x](../../../README/spec.md)', 'billing')).toEqual([]);
  });
});
