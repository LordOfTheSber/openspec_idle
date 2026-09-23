/**
 * Мост десктопного приложения. В режиме браузера его нет, и интерфейс
 * работает как раньше.
 */
interface DesktopBridge {
  readonly platform: string;
  onSection(callback: (section: string) => void): () => void;
}

export function desktopBridge(): DesktopBridge | null {
  return (window as { openspecDesktop?: DesktopBridge }).openspecDesktop ?? null;
}
