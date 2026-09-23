import { useState } from 'react';
import { matchesModuleFilter, type SearchKind } from '@openspec-ide/core';
import { fetchSearch, type ModuleSearchHit } from '../lib/api.js';

const KIND_LABEL: Record<SearchKind, string> = {
  change: 'изменение',
  capability: 'capability',
  schema: 'процесс',
  requirement: 'требование',
  scenario: 'сценарий',
};

const FILTERS: readonly { value: string; label: string }[] = [
  { value: '', label: 'всё' },
  { value: 'requirement', label: 'только требования' },
  { value: 'scenario', label: 'только сценарии' },
  { value: 'change', label: 'только изменения' },
  { value: 'capability', label: 'только capability' },
  { value: 'schema', label: 'только процессы' },
];

export function Search({ moduleFilter = [] }: { readonly moduleFilter?: readonly string[] }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [found, setHits] = useState<ModuleSearchHit[] | null>(null);
  // Фильтр по модулям: процессы общие и модулю не принадлежат — остаются.
  const hits =
    found === null
      ? null
      : found.filter((hit) => hit.kind === 'schema' || matchesModuleFilter(hit.modules, moduleFilter));
  const [busy, setBusy] = useState(false);

  async function run(nextQuery: string, nextKind: string): Promise<void> {
    if (nextQuery.trim() === '') {
      setHits(null);
      return;
    }
    setBusy(true);
    try {
      const result = await fetchSearch(nextQuery, nextKind === '' ? [] : [nextKind]);
      setHits(result.hits);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(query, kind);
        }}
      >
        <input
          id="search-query"
          type="search"
          value={query}
          placeholder="Требование, сценарий, capability…"
          aria-label="Поиск по рабочему пространству"
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          id="search-kind"
          value={kind}
          aria-label="Тип элемента"
          onChange={(event) => {
            setKind(event.target.value);
            void run(query, event.target.value);
          }}
        >
          {FILTERS.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>
      </form>

      {hits === null ? (
        <p className="empty">Введите запрос, чтобы искать по требованиям и сценариям.</p>
      ) : hits.length === 0 ? (
        <p className="empty" data-testid="search-empty">
          По запросу «{query}» ничего не найдено
          {kind === '' && moduleFilter.length === 0 ? '' : ' с текущим фильтром'}
          {moduleFilter.length > 0 && found !== null && found.length > 0 ? ` (вне выбранных модулей — ${found.length})` : ''}.
        </p>
      ) : (
        <>
          <p className="pane-title">
            Найдено <span className="count">{hits.length}</span>
            {busy && ' · идёт поиск'}
          </p>
          <ul className="hits" data-testid="search-hits">
            {hits.map((hit, position) => (
              <li key={`${hit.kind}-${hit.owner}-${hit.line ?? position}`}>
                <span className="kind">{KIND_LABEL[hit.kind]}</span>
                <span>
                  {hit.title}
                  <span className="where">
                    {hit.modules.length > 0 && <span className="chip module">{hit.modules.join(', ')}</span>} {hit.owner}
                    {hit.file === null ? '' : ` · ${hit.file}`}
                    {hit.line === null ? '' : `:${hit.line}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
