import { useEffect, useState } from 'react';
import { fetchAgentTargets } from './api.js';

/**
 * Артефакты change, которые агент может сгенерировать: у них в схеме есть
 * инструкция. `null` — пока неизвестно или агент недоступен; тогда генерация
 * не предлагается.
 */
export function useGenerableArtifacts(change: string, revision = 0): ReadonlySet<string> | null {
  const [available, setAvailable] = useState<ReadonlySet<string> | null>(null);

  useEffect(() => {
    let current = true;
    void fetchAgentTargets(change)
      .then((targets) => {
        if (!current) return;
        setAvailable(new Set(targets.artifacts.filter((artifact) => artifact.available).map((artifact) => artifact.id)));
      })
      .catch(() => {
        if (current) setAvailable(null);
      });
    return () => {
      current = false;
    };
  }, [change, revision]);

  return available;
}
