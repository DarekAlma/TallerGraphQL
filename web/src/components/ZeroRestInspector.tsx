/**
 * INSPECTOR ZERO-REST
 *
 * Panel flotante que lista, en vivo, cada operacion que la aplicacion envia al
 * servidor, con su tipo (query / mutation / subscription) y la URL de destino.
 *
 * Existe por una razon muy concreta del taller: el video debe demostrar "que
 * todas las llamadas van a /graphql". DevTools lo prueba, pero en una
 * grabacion suele verse pequeno y mezclado con peticiones del propio Vite
 * (HMR, modulos, sourcemaps). Este panel muestra el mismo hecho de forma
 * inequivoca y dentro de la aplicacion.
 *
 * Lee del store `operationLog`, que alimenta el `auditLink` de la cadena de
 * Apollo. Si algun dia alguien introdujera un `fetch()` a un endpoint REST, no
 * apareceria aqui... y el contador de operaciones dejaria de cuadrar con lo
 * que muestra la pantalla. Es un canario, no solo un adorno.
 */
import { useSyncExternalStore, useState } from 'react';
import { getOperations, subscribeToOperations, clearOperations } from '../apollo/operationLog';
import { GRAPHQL_ENDPOINTS } from '../apollo/client';

export function ZeroRestInspector() {
  const operations = useSyncExternalStore(subscribeToOperations, getOperations);
  const [open, setOpen] = useState(false);

  const counts = {
    query: operations.filter((o) => o.kind === 'query').length,
    mutation: operations.filter((o) => o.kind === 'mutation').length,
    subscription: operations.filter((o) => o.kind === 'subscription').length,
  };

  // Toda operacion sale hacia una de las dos URLs de GraphQL. Si este numero
  // fuera distinto de `operations.length`, habria trafico fuera del contrato.
  const toGraphQL = operations.filter(
    (o) => o.endpoint === GRAPHQL_ENDPOINTS.http || o.endpoint === GRAPHQL_ENDPOINTS.ws,
  ).length;

  return (
    <div className="inspector">
      <div className="inspector-head" onClick={() => setOpen((v) => !v)}>
        <span className="dot" />
        <span className="title">Inspector Zero-REST</span>
        <span className="toggle">{open ? 'ocultar ▾' : `${operations.length} operaciones ▸`}</span>
      </div>

      {open && (
        <>
          <div className="inspector-stats">
            <div className="inspector-stat">
              <div className="n">{counts.query}</div>
              <div className="l">Queries</div>
            </div>
            <div className="inspector-stat">
              <div className="n">{counts.mutation}</div>
              <div className="l">Mutations</div>
            </div>
            <div className="inspector-stat">
              <div className="n">{counts.subscription}</div>
              <div className="l">Subscript.</div>
            </div>
            <div className="inspector-stat" style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div className="n" style={{ color: toGraphQL === operations.length ? '#22c55e' : '#ef4444' }}>
                {operations.length - toGraphQL}
              </div>
              <div className="l">Llamadas REST</div>
            </div>
          </div>

          <div className="inspector-list">
            {operations.length === 0 && (
              <div className="inspector-foot">Sin operaciones todavía. Navega por el catálogo.</div>
            )}
            {operations.map((op) => (
              <div key={op.id} className="inspector-op">
                <span className={`k k-${op.kind}`}>{op.kind.slice(0, 3)}</span>
                <span className="n">{op.name}</span>
                <span className="u">{op.endpoint.replace(/^https?:\/\/|^wss?:\/\//, '')}</span>
              </div>
            ))}
          </div>

          <div className="inspector-foot">
            <div className="row-between">
              <span>
                {toGraphQL}/{operations.length} operaciones hacia <b>/graphql</b>
              </span>
              <button className="btn btn-sm btn-ghost" style={{ color: '#94a3b8' }} onClick={clearOperations}>
                limpiar
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
