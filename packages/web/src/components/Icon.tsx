/**
 * Иконки панели — встроенный SVG с обводкой цветом текста.
 *
 * Шрифт иконок не подходит: политика панели VS Code пускает шрифты только из
 * файлов расширения, а тянуть пакет ради двух десятков знаков дороже.
 */

const PATHS = {
  board: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="10" y="4" width="5" height="11" rx="1.5" />
      <rect x="17" y="4" width="4" height="7" rx="1.5" />
    </>
  ),
  diff: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M12 7v6M9 10h6M9 17h6" />
    </>
  ),
  chart: <path d="M5 20V11M11 20V5M17 20v-6M3 20h18" />,
  context: (
    <>
      <circle cx="5.5" cy="6" r="2.5" />
      <circle cx="5.5" cy="18" r="2.5" />
      <circle cx="18.5" cy="12" r="2.5" />
      <path d="M8 7l8 4M8 17l8-4" />
    </>
  ),
  structure: (
    <>
      <path d="M5 3v13a3 3 0 0 0 3 3h3M5 8h6" />
      <rect x="12" y="5" width="9" height="6" rx="1.5" />
      <rect x="12" y="15" width="9" height="6" rx="1.5" />
    </>
  ),
  workflow: (
    <>
      <rect x="3" y="3" width="7" height="6" rx="1.5" />
      <rect x="14" y="15" width="7" height="6" rx="1.5" />
      <path d="M6.5 9v3a3 3 0 0 0 3 3H14" />
    </>
  ),
  explorer: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v5h-5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.8 2.8L16.5 9.5" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  alert: (
    <>
      <path d="M12 3.8 2.8 19.5h18.4L12 3.8z" />
      <path d="M12 10v4.2M12 17v.01" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.5v.01" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5" />
    </>
  ),
  filePlus: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5M12 11v6M9 14h6" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  play: <path d="M7 5v14l11-7L7 5z" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  columns: (
    <>
      <rect x="3" y="4" width="7" height="16" rx="1.5" />
      <rect x="14" y="4" width="7" height="16" rx="1.5" />
    </>
  ),
  auto: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M3 12h6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />,
  filter: <path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5z" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="8" strokeDasharray="3.2 3.2" />,
  compare: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5V15a3 3 0 0 0 3 3h6.5M18 15.5V9a3 3 0 0 0-3-3H8.5" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  book: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15z" />
      <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3" />
    </>
  ),
  box: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
    </>
  ),
  spec: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 11h6M9 14h6M9 17h3" />
    </>
  ),
  terminal: <path d="m5 7 5 5-5 5M12 18h7" />,
  branch: (
    <>
      <circle cx="6" cy="5.5" r="2.2" />
      <circle cx="6" cy="18.5" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <path d="M6 7.7v8.6M18 10.2c0 4-6 3.3-11 6.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  download: <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />,
  plug: <path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8zM12 17v4" />,
  trace: (
    <>
      <circle cx="5" cy="6" r="2.2" />
      <circle cx="19" cy="18" r="2.2" />
      <path d="M7.2 6H12a3 3 0 0 1 3 3v6a3 3 0 0 0 3 3h-1" />
      <path d="M5 8.2V18h11.8" strokeDasharray="2 2.4" />
    </>
  ),
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={3} />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  className,
  title,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
  /** Подпись для одиночной иконки со смыслом; без неё иконка скрыта от чтения с экрана. */
  readonly title?: string;
}) {
  return (
    <svg
      className={className === undefined ? 'icon' : `icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title === undefined ? true : undefined}
      role={title === undefined ? undefined : 'img'}
      aria-label={title}
    >
      {title !== undefined && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}
