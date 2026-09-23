import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  type AgentSettings,
  type AgentStatus,
  type ApprovalMode,
  type IdeConfigResponse,
  fetchAgentStatus,
  fetchConfig,
  probeAgent,
  saveConfig,
} from '../lib/api.js';

interface Mode {
  readonly id: ApprovalMode;
  readonly title: string;
  readonly hint: string;
  readonly warn?: boolean;
}

export const MODES: readonly Mode[] = [
  { id: 'plan', title: 'plan — только анализ', hint: 'Файлы не изменяются, команды не запускаются. Результат — предложенный план.' },
  {
    id: 'default',
    title: 'default — подтверждать изменения',
    hint: 'Значение по умолчанию. Правка файлов и команды требуют подтверждения; в неинтерактивном запуске они отклоняются.',
  },
  { id: 'auto-edit', title: 'auto-edit — правки без вопросов', hint: 'Файлы правятся автоматически, команды подтверждаются.' },
  { id: 'auto', title: 'auto — решает классификатор', hint: 'Безопасные действия подтверждаются автоматически, рискованные блокируются.' },
  {
    id: 'yolo',
    title: 'yolo — подтверждать всё',
    hint: 'Агент меняет файлы и запускает команды без остановки. Каждый запуск в этом режиме требует явного согласия.',
    warn: true,
  },
];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function Settings() {
  const [loaded, setLoaded] = useState<IdeConfigResponse | null>(null);
  const [draft, setDraft] = useState<AgentSettings | null>(null);
  const [extraArgs, setExtraArgs] = useState('');
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [probing, setProbing] = useState(false);

  const load = useCallback(async () => {
    const [config, agent] = await Promise.all([fetchConfig(), fetchAgentStatus()]);
    setLoaded(config);
    setDraft(config.config.agent);
    setExtraArgs(config.config.agent.extraArgs.join('\n'));
    setStatus(agent);
  }, []);

  useEffect(() => {
    void load().catch((error: unknown) => setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) }));
  }, [load]);

  if (loaded === null || draft === null) return <p className="empty">Загрузка настроек…</p>;

  const update = (patch: Partial<AgentSettings>) => {
    setDraft({ ...draft, ...patch });
    setMessage(null);
  };

  const save = async () => {
    try {
      const next = {
        ...loaded.config,
        agent: {
          ...draft,
          extraArgs: extraArgs
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== ''),
        },
      };
      const result = await saveConfig(next);
      setDraft(result.config.agent);
      setMessage({ ok: true, text: 'Настройки сохранены в .openspec-ide/config.json.' });
      setStatus(await fetchAgentStatus());
    } catch (error) {
      setMessage({ ok: false, text: error instanceof ApiError || error instanceof Error ? error.message : String(error) });
    }
  };

  const probe = async () => {
    setProbing(true);
    try {
      setStatus(await probeAgent());
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setProbing(false);
    }
  };

  const probeResult = status?.probe ?? null;

  return (
    <div className="settings" data-testid="settings">
      <div className="settings-bar">
        <span className="crumbs">.openspec-ide/config.json</span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => void probe()} disabled={probing} data-testid="probe">
          {probing ? 'Проверка…' : 'Проверить подключение'}
        </button>
        <button type="button" className="btn primary" onClick={() => void save()} data-testid="settings-save">
          Сохранить
        </button>
      </div>

      {loaded.parseError !== null && (
        <p className="notice error" role="alert">
          Файл настроек не разбирается: {loaded.parseError}. Показаны значения по умолчанию.
        </p>
      )}
      {message !== null && (
        <p className={`notice ${message.ok ? 'ok' : 'error'}`} role={message.ok ? 'status' : 'alert'} data-testid="settings-message">
          {message.text}
        </p>
      )}

      {probeResult !== null &&
        (probeResult.ok ? (
          <div className="notice ok" data-testid="probe-result" data-ok="true">
            <span>
              {draft.command} {probeResult.version} — найден ({probeResult.bin}),{' '}
              {probeResult.streaming
                ? `потоковый вывод ${probeResult.format} поддерживается`
                : `вывод ${probeResult.format ?? '—'}`}
              . Проверено {formatTime(probeResult.checkedAt)}.
            </span>
            {probeResult.notice !== null && <p className="probe-notice" data-testid="probe-notice">{probeResult.notice}</p>}
          </div>
        ) : (
          <div className="notice error" data-testid="probe-result" data-ok="false">
            <span>{probeResult.error}</span>
            {probeResult.bin === null && probeResult.searched.length > 0 && (
              <ul className="failure-details" data-testid="probe-searched">
                {probeResult.searched.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

      {status !== null && status.blockers.length > 0 && (
        <div className="notice info" data-testid="agent-blockers">
          <span>Запуск агента пока недоступен:</span>
          <ul className="failure-details">
            {status.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="settings-grid">
        <section>
          <p className="pane-title">GigaCode CLI</p>
          <div className="field">
            <label htmlFor="agent-command">Исполняемый файл</label>
            <input id="agent-command" value={draft.command} onChange={(event) => update({ command: event.target.value })} />
            <p className="hint">Имя ищется в PATH; путь со слэшем берётся как есть. Проверка сообщает, какие пути просмотрены.</p>
          </div>
          <div className="field">
            <label htmlFor="agent-model">Модель</label>
            <input
              id="agent-model"
              value={draft.model ?? ''}
              placeholder="по умолчанию CLI"
              onChange={(event) => update({ model: event.target.value.trim() === '' ? null : event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="agent-env">Переменная с учётными данными</label>
            <input
              id="agent-env"
              value={draft.credentialsEnv ?? ''}
              placeholder="не требуется"
              onChange={(event) => update({ credentialsEnv: event.target.value.trim() === '' ? null : event.target.value.trim() })}
            />
            <p className="hint">
              Только <b>имя</b> переменной окружения. Значение ключа IDE не хранит и не показывает: задайте его в среде,
              из которой запускается IDE, например <code>export {draft.credentialsEnv ?? 'GIGACODE_API_KEY'}=…</code>.
            </p>
            {status !== null && status.credentials.env !== null && (
              <p className={`hint ${status.credentials.set ? 'ok' : 'warn'}`} data-testid="credentials-state">
                {status.credentials.set
                  ? `Переменная ${status.credentials.env} задана в среде сервера.`
                  : `Переменная ${status.credentials.env} не задана в среде сервера — настройка не завершена.`}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="agent-extra">Дополнительные аргументы CLI</label>
            <textarea
              id="agent-extra"
              rows={3}
              value={extraArgs}
              placeholder={'по одному в строке, например\n--auth-type\nopenai'}
              onChange={(event) => {
                setExtraArgs(event.target.value);
                setMessage(null);
              }}
            />
            <p className="hint">Секреты сюда не пишутся: флаги вида <code>--api-key</code> отклоняются при сохранении.</p>
          </div>
        </section>

        <section>
          <p className="pane-title">Режим подтверждения действий</p>
          <div className="modes" role="radiogroup" aria-label="Режим подтверждения по умолчанию">
            {MODES.map((mode) => (
              <label key={mode.id} className={`mode ${mode.warn === true ? 'warn' : ''}`}>
                <input
                  type="radio"
                  name="approval-mode"
                  value={mode.id}
                  checked={draft.approvalMode === mode.id}
                  onChange={() => update({ approvalMode: mode.id })}
                />
                <span>
                  <b>{mode.title}</b>
                  <span className="hint">{mode.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <p className="pane-title" style={{ marginTop: 16 }}>
            Бюджет запуска
          </p>
          <div className="field">
            <label htmlFor="agent-wall">Предел времени</label>
            <input id="agent-wall" value={draft.maxWallTime} onChange={(event) => update({ maxWallTime: event.target.value })} />
            <p className="hint">
              Передаётся как <code>--max-wall-time</code>: <code>90</code>, <code>30s</code>, <code>15m</code>, <code>1.5h</code>.
            </p>
          </div>
          <div className="field">
            <label htmlFor="agent-tools">Предел вызовов инструментов</label>
            <input
              id="agent-tools"
              type="number"
              min={1}
              value={draft.maxToolCalls}
              onChange={(event) => update({ maxToolCalls: Number(event.target.value) })}
            />
            <p className="hint">
              Передаётся как <code>--max-tool-calls</code>.
            </p>
          </div>
          {status !== null && (
            <div className="field">
              <label>Команда запуска</label>
              <pre className="diff-preview" data-testid="effective-command">
                {status.effective.command}
              </pre>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
