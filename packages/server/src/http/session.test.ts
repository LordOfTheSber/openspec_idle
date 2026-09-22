import { describe, expect, it } from 'vitest';
import { SessionToken } from './session.js';

describe('токен сессии', () => {
  it('принимает собственное значение', () => {
    const token = SessionToken.create();
    expect(token.matches(token.value)).toBe(true);
  });

  it('отвергает чужое значение и отсутствие значения', () => {
    const token = SessionToken.create();
    expect(token.matches('чужой')).toBe(false);
    expect(token.matches(undefined)).toBe(false);
    expect(token.matches('')).toBe(false);
  });

  it('отвергает значение-префикс правильного токена', () => {
    const token = SessionToken.create();
    expect(token.matches(token.value.slice(0, -1))).toBe(false);
  });

  it('различается между двумя созданиями', () => {
    expect(SessionToken.create().value).not.toBe(SessionToken.create().value);
  });
});
