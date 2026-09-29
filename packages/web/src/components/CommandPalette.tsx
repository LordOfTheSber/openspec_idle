import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit, SearchKind } from '@openspec-ide/core';
import { fetchSearch } from '../lib/api.js';
import { Icon, type IconName } from './Icon.js';

/** Команда палитры. */
export interface PaletteCommand {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
  /** Дополнительные слова, по которым команда находится. */
  readonly keywords?: string;
  readonly run: () => void;
}

type Filter = 'all' | 'command' | SearchKind;

const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: 'all', label: 'Всё' },
  { id: 'command', label: 'Команды' },
  { id: 'requirement', label: 'Требования' },
  { id: 'scenario', label: 'Сценарии' },
  { id: 'change', label: 'Изменения' },
  { id: 'capability', label: 'Спеки' },
  { id: 'schema', label: 'Процессы' },
];

const GROUP_ORDER: readonly Exclude<Filter, 'all'>[] = ['command', 'requirement', 'scenario', 'change', 'capability', 'schema'];

const HIT_ICON: Record<SearchKind, IconName> = {
  requirement: 'spec',
  scenario: 'list',
  change: 'branch',
  capability: 'spec',
  schema: 'workflow',
};

type Entry =
  | { readonly kind: 'command'; readonly command: PaletteCommand }
  | { readonly kind: SearchKind; readonly hit: SearchHit };

/** Где лежит найденное: владелец и, для файлов change, путь внутри него. */
function where(hit: SearchHit): string {
  const line = hit.line === null ? '' : `:${hit.line}`;
  const prefix = `openspec/changes/${hit.owner}/`;
  if (hit.file !== null && hit.file.startsWith(prefix)) return `${hit.owner} · ${hit.file.slice(prefix.length)}${line}`;
  return `${hit.owner}${line}`;
}

/** Совпадение для сравнения: без регистра и ё. */
function fold(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

/** Подсвечивает первое вхождение запроса в тексте. */
export function Highlight({ text, query }: { readonly text: string; readonly query: string }) {
  const needle = fold(query.trim());
  const at = needle === '' ? -1 : fold(text).indexOf(needle);
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

/**
 * Палитра поиска и команд (Ctrl+K): требования, сценарии, changes, спеки и
 * схемы — прежним маршрутом поиска, команды панели — на месте.
 */
export function CommandPalette({
  commands,
  onClose,
  onOpenHit,
}: {
  readonly commands: readonly PaletteCommand[];
  readonly onClose: () => void;
  readonly onOpenHit: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [hits, setHits] = useState<readonly SearchHit[]>([]);
  const [searched, setSearched] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => previous?.focus?.();
  }, []);

  // Поиск с задержкой: запрос к CLI не нужен на каждую букву.
  useEffect(() => {
    const text = query.trim();
    if (text === '') {
      setHits([]);
      setSearched('');
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void fetchSearch(text, [])
        .then((result) => {
          if (!current) return;
          setHits(result.hits);
          setSearched(text);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);

  const matchedCommands = useMemo(() => {
    const needle = fold(query.trim());
    return commands.filter((command) => needle === '' || fold(`${command.title} ${command.keywords ?? ''}`).includes(needle));
  }, [commands, query]);

  const counts = useMemo(() => {
    const result: Record<string, number> = { command: matchedCommands.length };
    for (const hit of hits) result[hit.kind] = (result[hit.kind] ?? 0) + 1;
    result['all'] = matchedCommands.length + hits.length;
    return result;
  }, [hits, matchedCommands]);

  const groups = useMemo(() => {
    const result: { kind: Exclude<Filter, 'all'>; entries: Entry[] }[] = [];
    for (const kind of GROUP_ORDER) {
      if (filter !== 'all' && filter !== kind) continue;
      const entries: Entry[] =
        kind === 'command'
          ? matchedCommands.map((command) => ({ kind: 'command', command }))
          : hits.filter((hit) => hit.kind === kind).map((hit) => ({ kind, hit }));
      if (entries.length > 0) result.push({ kind, entries });
    }
    return result;
  }, [filter, hits, matchedCommands]);

  const flat = groups.flatMap((group) => group.entries);

  useEffect(() => setActive(0), [query, filter]);

  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function run(entry: Entry | undefined): void {
    if (entry === undefined) return;
    onClose();
    if (entry.kind === 'command') entry.command.run();
    else onOpenHit(entry.hit);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(flat.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(flat[active]);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const position = FILTERS.findIndex((item) => item.id === filter);
      const step = event.shiftKey ? -1 : 1;
      const next = FILTERS[(position + step + FILTERS.length) % FILTERS.length];
      if (next !== undefined) setFilter(next.id);
    }
  }

  const labelOf = (kind: Exclude<Filter, 'all'>): string => FILTERS.find((item) => item.id === kind)?.label ?? kind;
  let index = -1;

  return (
    <div className="palette-scrim" onMouseDown={onClose} data-testid="palette">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Поиск и команды"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="palette-input">
          <Icon name="search" size={18} className="muted" />
          <input
            ref={input}
            value={query}
            placeholder="Требование, сценарий, change или команда"
            aria-label="Поиск по рабочему пространству"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            onChange={(event) => setQuery(event.target.value)}
            data-testid="palette-input"
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-filters" role="group" aria-label="Тип элемента">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="chip"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              data-testid={`palette-filter-${item.id}`}
            >
              {item.label} <span className="muted">{counts[item.id] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="palette-results" id="palette-results" role="listbox" ref={list} data-testid="palette-results">
          {groups.length === 0 && (
            <p className="empty palette-empty" data-testid="search-empty">
              {query.trim() === ''
                ? 'Начните вводить — поиск идёт по артефактам, спекам, схемам и командам.'
                : searched === query.trim()
                  ? `По запросу «${query.trim()}» ничего не найдено${filter === 'all' ? '' : ' с текущим фильтром — снимите его'}.`
                  : 'Идёт поиск…'}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.kind} className="palette-group">
              <p className="section-label">
                {labelOf(group.kind)} <span className="badge">{group.entries.length}</span>
              </p>
              {group.entries.map((entry) => {
                index += 1;
                const position = index;
                const isActive = position === active;
                if (entry.kind === 'command') {
                  return (
                    <div
                      key={entry.command.id}
                      role="option"
                      aria-selected={isActive}
                      data-active={isActive}
                      className="palette-row"
                      onMouseEnter={() => setActive(position)}
                      onClick={() => run(entry)}
                      data-testid={`palette-command-${entry.command.id}`}
                    >
                      <Icon name={entry.command.icon} size={16} className="palette-row-icon" />
                      <span className="palette-title">
                        <Highlight text={entry.command.title} query={query} />
                      </span>
                      {isActive && <span className="kbd">Enter</span>}
                    </div>
                  );
                }
                const hit = entry.hit;
                return (
                  <div
                    key={`${hit.kind}-${hit.owner}-${hit.title}-${hit.line ?? position}`}
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive}
                    className="palette-row"
                    onMouseEnter={() => setActive(position)}
                    onClick={() => run(entry)}
                    data-testid="palette-hit"
                  >
                    <Icon name={HIT_ICON[hit.kind]} size={16} className="palette-row-icon" />
                    <span className="palette-title">
                      <Highlight text={hit.title} query={query} />
                    </span>
                    <span className="palette-where mono" title={hit.file ?? undefined}>
                      {where(hit)}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> выбрать
          </span>
          <span>
            <span className="kbd">Enter</span> открыть
          </span>
          <span>
            <span className="kbd">Tab</span> следующий фильтр
          </span>
          {query.trim() !== '' && searched !== query.trim() && (
            <span className="palette-searching" data-testid="palette-searching">
              <Icon name="refresh" size={13} />
              идёт поиск
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
