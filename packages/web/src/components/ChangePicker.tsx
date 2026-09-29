import { useEffect, useRef, useState } from 'react';
import type { TreeChange } from '@openspec-ide/core';
import { columnTitle, phaseOf } from '../lib/phase.js';
import { Icon } from './Icon.js';

/**
 * Выбор change в шапке раздела — вместо дерева рабочего пространства слева:
 * разделу нужен только один выбор, а дерево в VS Code и так есть.
 */
export function ChangePicker({
  changes,
  value,
  onChange,
}: {
  readonly changes: readonly TreeChange[];
  readonly value: string | null;
  readonly onChange: (change: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement | null>(null);
  const current = changes.find((item) => item.name === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function choose(name: string): void {
    setOpen(false);
    onChange(name);
  }

  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className="btn picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Изменение"
        onClick={() => {
          setActive(Math.max(0, changes.findIndex((item) => item.name === value)));
          setOpen((state) => !state);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        data-testid="change-picker"
      >
        <Icon name="branch" size={15} className="muted" />
        {current === null ? (
          <span className="muted">Выберите change</span>
        ) : (
          <>
            <span className="mono picker-name">{current.name}</span>
            <span className="chip">{columnTitle(phaseOf(current))}</span>
          </>
        )}
        <Icon name="chevronDown" size={14} className="muted" />
      </button>
      {open && (
        <ul
          className="picker-list"
          role="listbox"
          aria-label="Активные изменения"
          tabIndex={-1}
          ref={(element) => element?.focus()}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((index) => Math.min(changes.length - 1, index + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const item = changes[active];
              if (item !== undefined) choose(item.name);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {changes.length === 0 && <li className="empty">Активных изменений нет</li>}
          {changes.map((item, index) => (
            <li
              key={item.name}
              role="option"
              aria-selected={item.name === value}
              className={index === active ? 'active' : undefined}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(item.name)}
              data-testid={`picker-option-${item.name}`}
            >
              <span className="mono">{item.name}</span>
              <span className="spacer" />
              <span className="muted">{columnTitle(phaseOf(item))}</span>
              {item.progress !== null && item.progress.total > 0 && (
                <span className="badge">
                  {item.progress.complete}/{item.progress.total}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Предложение выбрать change, когда раздел открыт без выбора. */
export function ChooseChange({
  changes,
  what,
  onChange,
}: {
  readonly changes: readonly TreeChange[];
  readonly what: string;
  readonly onChange: (change: string) => void;
}) {
  return (
    <div className="choose-change" data-testid="choose-change">
      <p className="empty">Выберите изменение, чтобы увидеть {what}.</p>
      <ul>
        {changes.map((item) => (
          <li key={item.name}>
            <button type="button" className="choose-row row-hover" onClick={() => onChange(item.name)}>
              <Icon name="branch" size={15} className="muted" />
              <span className="mono">{item.name}</span>
              <span className="spacer" />
              <span className="muted">{columnTitle(phaseOf(item))}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
