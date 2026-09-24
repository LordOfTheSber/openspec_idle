/** Что нужно, чтобы превратить собранную страницу в разметку панели. */
export interface PanelHtmlOptions {
  /** Адрес ресурса собранного интерфейса для webview по относительному пути. */
  readonly assetUri: (relative: string) => string;
  /** `webview.cspSource` — источник, из которого webview отдаёт файлы расширения. */
  readonly cspSource: string;
  /** Одноразовое значение для скриптов этой загрузки панели. */
  readonly nonce: string;
}

const LOCAL = /^\.\/(?!.*\.\.)[\w./-]+$/;

/**
 * Готовит собранную страницу интерфейса к показу в webview.
 *
 * Адреса `./assets/...` переписываются на адреса webview. Скрипт получает
 * nonce, только если он загружается из собранного интерфейса; любой другой
 * `<script>` вырезается. Политика безопасности не разрешает сеть, встроенные
 * скрипты и ресурсы вне расширения.
 */
export function renderPanelHtml(html: string, options: PanelHtmlOptions): string {
  const { assetUri, cspSource, nonce } = options;

  let result = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_match, attrs: string) => {
    const src = /\bsrc="([^"]*)"/i.exec(attrs)?.[1];
    if (src === undefined || !LOCAL.test(src)) return '';
    const kept = attrs
      .replace(/\s*\bsrc="[^"]*"/i, '')
      .replace(/\s*\bcrossorigin(="[^"]*")?/gi, '')
      .replace(/\s*\bnonce="[^"]*"/gi, '');
    return `<script${kept} nonce="${nonce}" src="${assetUri(src.slice(2))}"></script>`;
  });

  result = result.replace(/<link\b([^>]*)>/gi, (match, attrs: string) => {
    const href = /\bhref="([^"]*)"/i.exec(attrs)?.[1];
    if (href === undefined) return match;
    if (!LOCAL.test(href)) return '';
    const kept = attrs.replace(/\s*\bhref="[^"]*"/i, '').replace(/\s*\bcrossorigin(="[^"]*")?/gi, '');
    return `<link${kept} href="${assetUri(href.slice(2))}">`;
  });

  const policy = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    // CodeMirror и React пишут стили в атрибуты и элементы <style>.
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');

  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  return /<head[^>]*>/i.test(result)
    ? result.replace(/<head([^>]*)>/i, `<head$1>\n    ${meta}`)
    : `${meta}\n${result}`;
}

/** Случайное значение nonce. */
export function createNonce(random: (size: number) => Uint8Array): string {
  return Buffer.from(random(18)).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}
