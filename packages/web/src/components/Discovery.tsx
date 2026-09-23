import { useEffect, useState } from 'react';
import { MODULE_KINDS, MODULE_KIND_LABEL, type ModuleDef, type ModuleKind } from '@openspec-ide/core';
import { ApiError, discoverModules, saveModules, type DiscoveryResult, type ModuleInput } from '../lib/api.js';

interface DraftRow extends ModuleInput {
  readonly keep: boolean;
  readonly manifest: string;
}

/**
 * Обнаружение модулей: черновик карты по манифестам сборки. Ничего не
 * пишется без подтверждения: вид и префикс угадываются и могут ошибаться.
 * При существующей карте показываются только новые модули и расхождения
 * зависимостей.
 */
export function Discovery({
  existing,
  onCancel,
  onSaved,
}: {
  readonly existing: readonly ModuleDef[];
  readonly onCancel: (() => void) | null;
  readonly onSaved: () => void;
}) {
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    void discoverModules()
      .then((found) => {
        if (!current) return;
        setResult(found);
        const fresh = found.diff === null ? found.modules : found.diff.added;
        setRows(
          fresh.map((module) => ({
            id: module.id,
            title: module.title,
            kind: module.kind,
            path: module.path,
            specs: module.specs,
            group: module.group,
            dependsOn: module.dependsOn,
            keep: true,
            manifest: module.manifest,
          })),
        );
      })
      .catch((problem: unknown) => {
        if (current) setError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      current = false;
    };
  }, []);

  const update = (index: number, patch: Partial<DraftRow>): void =>
    setRows((current) => {
      const previousId = current[index]?.id;
      return current.map((row, position) => {
        if (position === index) return { ...row, ...patch };
        // Переименование модуля переносится в зависимости остальных строк.
        if (patch.id !== undefined && previousId !== undefined && row.dependsOn.includes(previousId)) {
          return { ...row, dependsOn: row.dependsOn.map((id) => (id === previousId ? patch.id! : id)) };
        }
        return row;
      });
    });

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const kept = rows.filter((row) => row.keep);
      const keptIds = new Set([...existing.map((module) => module.id), ...kept.map((row) => row.id)]);
      const changes = result?.diff?.dependencyChanges ?? [];
      const merged: ModuleInput[] = existing.map((module) => {
        const change = changes.find((entry) => entry.id === module.id);
        let dependsOn = [...module.dependsOn];
        if (change !== undefined && accepted[module.id] === true) {
          dependsOn = [...dependsOn.filter((id) => !change.remove.includes(id)), ...change.add.filter((id) => !dependsOn.includes(id))];
        }
        return { ...module, path: module.path ?? '', dependsOn };
      });
      for (const row of kept) {
        merged.push({
          id: row.id.trim(),
          title: row.title.trim(),
          kind: row.kind,
          path: row.path,
          specs: row.specs.trim(),
          group: row.group === null || row.group.trim() === '' ? null : row.group.trim(),
          // Зависимость на убранный из черновика модуль в карту не попадает.
          dependsOn: row.dependsOn.filter((id) => keptIds.has(id)),
        });
      }
      await saveModules(merged);
      onSaved();
    } catch (problem) {
      setError(problem instanceof ApiError || problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }

  const changes = result?.diff?.dependencyChanges ?? [];
  const nothingNew = result !== null && rows.length === 0 && changes.length === 0;

  return (
    <div className="discovery" data-testid="discovery">
      <p className="pane-title">Обнаружение модулей</p>
      <p className="muted">
        Модули найдены по манифестам сборки: <code>package.json</code>, <code>pom.xml</code>, <code>build.gradle</code>,{' '}
        <code>go.mod</code>, <code>*.csproj</code>, <code>pyproject.toml</code>. Каталоги зависимостей и сборки и файлы из{' '}
        <code>.gitignore</code> пропущены. Проверьте черновик — карта запишется в <code>openspec/modules.yaml</code> только после
        сохранения.
      </p>
      {result === null && error === null && <p className="empty">Обход репозитория…</p>}
      {error !== null && (
        <p className="notice error" role="alert" data-testid="discovery-error">
          {error}
        </p>
      )}
      {nothingNew && (
        <p className="notice info" data-testid="discovery-nothing">
          Карта совпадает с кодом: новых модулей и расхождений зависимостей нет.
        </p>
      )}
      {result?.diff?.missing !== undefined && result.diff.missing.length > 0 && (
        <p className="notice info">
          В каталогах модулей {result.diff.missing.join(', ')} манифест не найден — проверьте карту вручную.
        </p>
      )}

      {rows.length > 0 && (
        <table className="discovery-table">
          <thead>
            <tr>
              <th>В карту</th>
              <th>id</th>
              <th>Название</th>
              <th>Вид</th>
              <th>Префикс спеков</th>
              <th>Группа</th>
              <th>Каталог и зависимости</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.path} className={row.keep ? '' : 'off'} data-testid={`draft-${row.path}`}>
                <td>
                  <input type="checkbox" checked={row.keep} aria-label={`Включить ${row.id}`} onChange={(event) => update(index, { keep: event.target.checked })} />
                </td>
                <td>
                  <input value={row.id} aria-label="id" onChange={(event) => update(index, { id: event.target.value })} />
                </td>
                <td>
                  <input value={row.title} aria-label="Название" onChange={(event) => update(index, { title: event.target.value })} />
                </td>
                <td>
                  <select value={row.kind} aria-label="Вид" onChange={(event) => update(index, { kind: event.target.value as ModuleKind })}>
                    {MODULE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {MODULE_KIND_LABEL[kind]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input value={row.specs} aria-label="Префикс спеков" onChange={(event) => update(index, { specs: event.target.value })} />
                </td>
                <td>
                  <input value={row.group ?? ''} aria-label="Группа" onChange={(event) => update(index, { group: event.target.value })} />
                </td>
                <td className="muted">
                  <span className="mono">{row.path}</span>
                  <br />
                  {row.dependsOn.length === 0 ? 'без зависимостей' : `→ ${row.dependsOn.join(', ')}`}
                  <br />
                  <span className="small">{row.manifest}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {changes.length > 0 && (
        <div className="discovery-deps" data-testid="discovery-deps">
          <p className="grp">Зависимости в коде расходятся с картой</p>
          {changes.map((change) => (
            <label key={change.id}>
              <input
                type="checkbox"
                checked={accepted[change.id] === true}
                onChange={(event) => setAccepted((current) => ({ ...current, [change.id]: event.target.checked }))}
              />
              <code>{change.id}</code>
              {change.add.length > 0 && <span className="added"> + {change.add.join(', ')}</span>}
              {change.remove.length > 0 && <span className="removed"> − {change.remove.join(', ')}</span>}
            </label>
          ))}
        </div>
      )}

      <div className="row-actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy || result === null || (rows.every((row) => !row.keep) && !Object.values(accepted).some(Boolean))}
          onClick={() => void save()}
          data-testid="discovery-save"
        >
          Сохранить карту
        </button>
        {onCancel !== null && (
          <button type="button" className="btn" onClick={onCancel}>
            Отмена
          </button>
        )}
      </div>
    </div>
  );
}
