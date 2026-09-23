import { useEffect, useState } from 'react';
import type { CapabilityMap } from '@openspec-ide/core';
import { fetchCapabilityMap } from '../lib/api.js';

/** Карта связей capability и активных changes. */
export function CapabilityMapView() {
  const [map, setMap] = useState<CapabilityMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void fetchCapabilityMap()
      .then((result) => {
        if (current) setMap(result);
      })
      .catch((problem: unknown) => {
        if (current) setError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      current = false;
    };
  }, []);

  if (error !== null) {
    return (
      <p className="notice error" role="alert">
        {error}
      </p>
    );
  }
  if (map === null) return <p className="empty">Загрузка карты связей…</p>;
  if (map.nodes.length === 0) {
    return <p className="empty">В проекте пока нет ни capability, ни дельт.</p>;
  }

  return (
    <ul className="capability-map" data-testid="capability-map">
      {map.nodes.map((node) => (
        <li key={node.capability} data-testid={`map-${node.capability}`}>
          <div className="cap-head">
            <span className="nm mono">{node.capability}</span>
            {!node.exists && (
              <span className="chip" title="Появится в спеках после архивации">
                новая
              </span>
            )}
            {node.dangling && (
              <span className="chip bad" data-testid="dangling">
                висячая
              </span>
            )}
          </div>

          {node.links.length === 0 ? (
            <p className="empty">Активных изменений нет</p>
          ) : (
            <ul className="cap-links">
              {node.links.map((link) => (
                <li key={link.change}>
                  <span className="mono">{link.change}</span>
                  {link.conflictingRequirements.length > 0 && (
                    <span className="conflict" data-testid="conflict">
                      конфликт: {link.conflictingRequirements.join(', ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
