import { useEffect, useMemo, useState } from 'react';
import { fetchRequirementIndex } from '../lib/api.js';

interface Target {
  readonly capability: string;
  readonly module: string | null;
  readonly name: string;
}

/** Выбор требования любого модуля для вставки ссылки. */
export function LinkPicker({
  exclude,
  onPick,
  onClose,
}: {
  /** Спека, в которую вставляется ссылка: её требования не предлагаются первыми. */
  readonly exclude: string;
  readonly onPick: (target: Target) => void;
  readonly onClose: () => void;
}) {
  const [all, setAll] = useState<Target[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void fetchRequirementIndex().then((result) => setAll(result.requirements));
  }, []);

  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (all ?? [])
      .filter((target) => needle === '' || `${target.capability} ${target.name}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(a.capability === exclude) - Number(b.capability === exclude))
      .slice(0, 50);
  }, [all, exclude, query]);

  return (
    <div className="link-picker" role="dialog" aria-label="Ссылка на требование" data-testid="link-picker">
      <div className="link-picker-head">
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Требование любого модуля…"
          aria-label="Поиск требования"
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            if (event.key === 'Enter' && found[0] !== undefined) onPick(found[0]);
          }}
        />
        <button type="button" className="btn small" onClick={onClose}>
          Отмена
        </button>
      </div>
      {all === null ? (
        <p className="empty small">Загрузка требований…</p>
      ) : (
        <ul>
          {found.map((target) => (
            <li key={`${target.capability}:${target.name}`}>
              <button type="button" className="link" onClick={() => onPick(target)} data-testid={`pick-${target.capability}:${target.name}`}>
                <span className="chip module">{target.module ?? target.capability}</span> {target.name}
              </button>
            </li>
          ))}
          {found.length === 0 && <li className="empty small">Не найдено</li>}
        </ul>
      )}
    </div>
  );
}
