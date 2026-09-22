import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Готовит HTML страницы, встраивая в неё токен сессии.
 *
 * Токен передаётся страницей в каждом запросе, поэтому он должен попасть в неё
 * при отдаче: держать его в localStorage нельзя — он живёт ровно один запуск
 * сервера.
 */
export function injectToken(html: string, token: string): string {
  const meta = `<meta name="openspec-ide-token" content="${escapeAttribute(token)}">`;
  return html.includes('</head>')
    ? html.replace('</head>', `  ${meta}\n</head>`)
    : `${meta}\n${html}`;
}

/** Читает собранную страницу SPA. */
export async function readBuiltPage(distDir: string): Promise<string | null> {
  try {
    return await readFile(join(distDir, 'index.html'), 'utf8');
  } catch {
    return null;
  }
}

/** Страница-заглушка, когда SPA ещё не собрана. */
export function placeholderPage(reason: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>OpenSpec IDE</title>
</head>
<body>
<main>
<h1>Интерфейс не собран</h1>
<p>${escapeText(reason)}</p>
<p>Соберите его командой <code>npm run build</code> или запустите <code>npm run dev</code>.</p>
</main>
</body>
</html>
`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
