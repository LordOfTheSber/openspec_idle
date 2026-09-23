import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Токен сессии, выдаваемый при запуске сервера. */
export class SessionToken {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  /** Создаёт новый случайный токен. Меняется при каждом запуске сервера. */
  static create(): SessionToken {
    return new SessionToken(randomBytes(32).toString('base64url'));
  }

  get value(): string {
    return this.#value;
  }

  /**
   * Сравнивает предъявленный токен с выданным за время, не зависящее от того,
   * сколько символов совпало.
   */
  matches(candidate: string | undefined): boolean {
    if (candidate === undefined) return false;
    const expected = Buffer.from(this.#value, 'utf8');
    const actual = Buffer.from(candidate, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}

/** Имя заголовка, в котором страница предъявляет токен сессии. */
export const SESSION_HEADER = 'x-openspec-ide-token';

/** Имя параметра строки запроса — для потока SSE, где заголовок не задать. */
export const SESSION_QUERY = 'token';
