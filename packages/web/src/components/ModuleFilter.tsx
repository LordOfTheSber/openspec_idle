import { useEffect, useRef, useState } from 'react';
import { groupModules, type ModuleDef } from '@openspec-ide/core';

/**
 * Фильтр по модулям — общий для доски, поиска и метрик: выбранные модули
 * сохраняются при переключении разделов.
 */
export function ModuleFilter({
  modules,
  value,
  onChange,
}: {
  readonly modules: readonly ModuleDef[];
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (modules.length === 0) return null;
  const toggle = (id: string): void =>
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);

  return (
    <div className="module-filter" ref={box} data-testid="module-filter">
      <button type="button" className={`btn ${value.length > 0 ? 'on' : ''}`} onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        {value.length === 0 ? 'Все модули' : `Модули: ${value.join(', ')}`} ▾
      </button>
      {value.length > 0 && (
        <button type="button" className="btn ghost" onClick={() => onChange([])} aria-label="Сбросить фильтр модулей">
          ✕
        </button>
      )}
      {open && (
        <div className="module-filter-pop" role="listbox" aria-multiselectable="true">
          {groupModules(modules).map((group) => (
            <div key={group.title}>
              <p className="grp">{group.title}</p>
              {group.modules.map((module) => (
                <label key={module.id}>
                  <input
                    type="checkbox"
                    checked={value.includes(module.id)}
                    onChange={() => toggle(module.id)}
                    data-testid={`filter-module-${module.id}`}
                  />
                  <span className="mono">{module.id}</span>
                  <span className="muted">{module.title}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
