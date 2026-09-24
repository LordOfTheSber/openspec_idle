import { describe, expect, it } from 'vitest';
import { isPanelApiPath, parseHostMessage, parseViewMessage } from './hostProtocol.js';

describe('протокол панели: сообщения панели', () => {
  it('принимает запрос к API с телом', () => {
    const parsed = parseViewMessage({
      kind: 'request',
      id: 7,
      method: 'PUT',
      path: '/api/file',
      body: { path: 'openspec/x.md', content: '' },
    });

    expect(parsed).toEqual({
      ok: true,
      message: {
        kind: 'request',
        id: 7,
        method: 'PUT',
        path: '/api/file',
        body: { path: 'openspec/x.md', content: '' },
      },
    });
  });

  it('отклоняет сообщение неизвестного вида', () => {
    const parsed = parseViewMessage({ kind: 'eval', code: 'process.exit()' });
    expect(parsed.ok).toBe(false);
  });

  it('отклоняет не объект', () => {
    expect(parseViewMessage('request').ok).toBe(false);
    expect(parseViewMessage(null).ok).toBe(false);
    expect(parseViewMessage([1]).ok).toBe(false);
  });

  it('отклоняет запрос без идентификатора и с дробным идентификатором', () => {
    expect(parseViewMessage({ kind: 'request', method: 'GET', path: '/api/board' }).ok).toBe(false);
    expect(parseViewMessage({ kind: 'request', id: 1.5, method: 'GET', path: '/api/board' }).ok).toBe(false);
  });

  it('отклоняет неизвестный метод', () => {
    expect(parseViewMessage({ kind: 'request', id: 1, method: 'TRACE', path: '/api/board' }).ok).toBe(false);
  });

  it('отклоняет запрос к пути вне /api/', () => {
    for (const path of ['/', '/etc/passwd', 'api/board', 'http://example.com/api/board']) {
      expect(parseViewMessage({ kind: 'request', id: 1, method: 'GET', path }).ok).toBe(false);
    }
  });

  it('принимает открытие файла со строкой и без неё', () => {
    expect(parseViewMessage({ kind: 'open-file', path: 'openspec/a.md', line: 12 })).toEqual({
      ok: true,
      message: { kind: 'open-file', path: 'openspec/a.md', line: 12 },
    });
    expect(parseViewMessage({ kind: 'open-file', path: 'openspec/a.md' })).toEqual({
      ok: true,
      message: { kind: 'open-file', path: 'openspec/a.md', line: null },
    });
  });

  it('отклоняет открытие файла с отрицательной строкой или без пути', () => {
    expect(parseViewMessage({ kind: 'open-file', path: 'a.md', line: 0 }).ok).toBe(false);
    expect(parseViewMessage({ kind: 'open-file', path: '', line: 1 }).ok).toBe(false);
  });

  it('принимает запрос сравнения архивации по имени change и capability', () => {
    expect(parseViewMessage({ kind: 'preview-archive', change: 'add-x', capability: 'identity/user-auth' })).toEqual({
      ok: true,
      message: { kind: 'preview-archive', change: 'add-x', capability: 'identity/user-auth' },
    });
    expect(parseViewMessage({ kind: 'preview-archive', change: 'add-x' })).toEqual({
      ok: true,
      message: { kind: 'preview-archive', change: 'add-x', capability: null },
    });
  });

  it('отклоняет запрос сравнения с путями наружу и с текстом вместо имён', () => {
    expect(parseViewMessage({ kind: 'preview-archive', change: '../x', capability: null }).ok).toBe(false);
    expect(parseViewMessage({ kind: 'preview-archive', change: 'a', capability: '../../etc' }).ok).toBe(false);
    expect(parseViewMessage({ kind: 'preview-archive', change: 'a', capability: { after: '# spec' } }).ok).toBe(false);
    expect(parseViewMessage({ kind: 'preview-archive', change: '' }).ok).toBe(false);
  });
});

describe('протокол панели: пути API', () => {
  it('пропускает маршруты API со строкой запроса', () => {
    expect(isPanelApiPath('/api/workspace')).toBe(true);
    expect(isPanelApiPath('/api/file?path=openspec%2Fx.md')).toBe(true);
  });

  it('не пропускает переходы вверх и обратные косые', () => {
    expect(isPanelApiPath('/api/../etc/passwd')).toBe(false);
    expect(isPanelApiPath('/api/./board')).toBe(false);
    expect(isPanelApiPath('/api\\..\\x')).toBe(false);
  });

  it('не пропускает поток событий: он приходит сообщениями', () => {
    expect(isPanelApiPath('/api/events')).toBe(false);
    expect(isPanelApiPath('/api/events?token=x')).toBe(false);
  });
});

describe('протокол панели: сообщения расширения', () => {
  it('разбирает ответ, событие и навигацию', () => {
    expect(parseHostMessage({ kind: 'response', id: 1, status: 409, body: { error: 'x' } }).ok).toBe(true);
    expect(parseHostMessage({ kind: 'event', event: { type: 'workspace-changed' } })).toEqual({
      ok: true,
      message: { kind: 'event', event: { type: 'workspace-changed', payload: null } },
    });
    expect(
      parseHostMessage({
        kind: 'navigate',
        section: 'metrics',
        selection: { kind: 'change', id: 'add-export' },
      }),
    ).toEqual({
      ok: true,
      message: { kind: 'navigate', section: 'metrics', selection: { kind: 'change', id: 'add-export' } },
    });
  });

  it('отклоняет навигацию в неизвестный раздел и с некорректным выбором', () => {
    expect(parseHostMessage({ kind: 'navigate', section: 'explorer', selection: null }).ok).toBe(false);
    expect(
      parseHostMessage({ kind: 'navigate', section: 'board', selection: { kind: 'file', id: 'x' } }).ok,
    ).toBe(false);
  });
});

describe('сверка ревизии API', () => {
  it('бэкенд без ревизии или со старой ревизией считается устаревшим', async () => {
    const { API_REVISION, isStaleBackend } = await import('./constants.js');

    expect(isStaleBackend({ status: 'ok' })).toBe(true);
    expect(isStaleBackend({ status: 'ok', apiRevision: API_REVISION - 1 })).toBe(true);
    expect(isStaleBackend({ status: 'ok', apiRevision: API_REVISION })).toBe(false);
    expect(isStaleBackend(null)).toBe(false);
  });
});
