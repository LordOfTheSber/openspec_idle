/**
 * Общие механизмы оболочки: место для действий раздела в шапке страницы и
 * всплывающие уведомления об итогах операций.
 */
import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon.js';

const ActionsTarget = createContext<HTMLElement | null>(null);

export const ActionsTargetProvider = ActionsTarget.Provider;

/**
 * Действия раздела в строке заголовка страницы. Раздел рисует их у себя, а
 * оказываются они рядом с заголовком — так у каждого раздела одна строка
 * управления, а не две.
 */
export function PageActions({ children }: { readonly children: ReactNode }) {
  const target = useContext(ActionsTarget);
  if (target === null) return <div className="page-actions">{children}</div>;
  return createPortal(children, target);
}

export type ToastKind = 'ok' | 'bad' | 'info';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly title: string;
  readonly detail?: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

type Notify = (toast: Omit<Toast, 'id'>) => void;

const ToastContext = createContext<Notify>(() => undefined);

/** Показывает уведомление об итоге операции. */
export function useNotify(): Notify {
  return useContext(ToastContext);
}

/** Сколько живёт уведомление, мс. */
export const TOAST_MS = 6000;

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);

  const notify = useCallback<Notify>(
    (toast) => {
      counter.current += 1;
      const id = counter.current;
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);
      setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toasts" role="status" aria-live="polite" data-testid="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`} data-testid="toast">
            <Icon name={toast.kind === 'ok' ? 'checkCircle' : toast.kind === 'bad' ? 'error' : 'info'} size={16} className="toast-icon" />
            <div className="toast-body">
              <b>{toast.title}</b>
              {toast.detail !== undefined && <span>{toast.detail}</span>}
            </div>
            {toast.action !== undefined && (
              <button
                type="button"
                className="btn small ghost"
                onClick={() => {
                  toast.action?.run();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button type="button" className="icon-btn small" aria-label="Закрыть уведомление" onClick={() => dismiss(toast.id)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Ширина элемента — для раскладок, зависящих от панели, а не от окна. */
export function useWidth<T extends HTMLElement>(): [(element: T | null) => void, number | null] {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}
