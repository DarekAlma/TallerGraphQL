/**
 * ============================================================================
 *  ESCENARIO C · Seguimiento del pedido, consistencia eventual y tiempo real
 * ============================================================================
 *
 * Esta pantalla es la respuesta del proyecto a la pregunta del taller:
 * *"¿que ve el usuario mientras la orden esta siendo validada o el stock se
 * esta sincronizando?"*
 *
 * FLUJO COMPLETO
 * --------------
 *   t=0ms    `placeOrder` confirma. El write model ya tiene la orden y el
 *            inventario ya esta descontado. El proyector queda agendado.
 *
 *   t=0ms    Esta pantalla consulta `order(id)`. Como la proyeccion todavia no
 *            existe, la union devuelve `OrderProjectionPending`: se pinta un
 *            banner de "sincronizando" con el estado YA confirmado. Nunca una
 *            pantalla en blanco, nunca un 404, nunca un error.
 *
 *   t≈1.5s   El proyector reconstruye `order_read_model` y publica el evento.
 *
 *   t≈1.5s   Llega por Subscription con la proyeccion dentro. Apollo la
 *            normaliza en cache por su `id` y la pantalla se completa sola.
 *
 * Ademas hay un `pollInterval` de respaldo por si el WebSocket no estuviera
 * disponible: dos caminos independientes hacia la convergencia.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useSubscription } from '@apollo/client/react';
import {
  APPROVE_ORDER,
  CANCEL_ORDER,
  DISPATCH_ORDER,
  ORDER_QUERY,
  ORDER_STATUS_SUBSCRIPTION,
} from '../graphql/operations';
import { DomainErrors, Empty, formatDateTime, OrderStatusBadge } from '../components/ui';
import { applyOrderTransition } from '../apollo/cacheUpdates';
import type { DomainError, OrderProjection, OrderQueryResult } from '../types';

export function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const [errors, setErrors] = useState<DomainError[]>([]);
  const [liveEvents, setLiveEvents] = useState<string[]>([]);

  const { data, loading, refetch, startPolling, stopPolling } = useQuery<{ order: OrderQueryResult }>(
    ORDER_QUERY,
    { variables: { id }, notifyOnNetworkStatusChange: true },
  );

  const result = data?.order;
  const isPending = result?.__typename === 'OrderProjectionPending';

  /* Respaldo: mientras la proyeccion no exista, se reconsulta cada segundo.
     En cuanto llega, se detiene el sondeo y el WebSocket toma el relevo. */
  useEffect(() => {
    if (isPending) startPolling(1000);
    else stopPolling();
    return () => stopPolling();
  }, [isPending, startPolling, stopPolling]);

  /* Tiempo real: el evento trae la proyeccion ya reconstruida. */
  useSubscription(ORDER_STATUS_SUBSCRIPTION, {
    variables: { orderId: id },
    skip: !id,
    onData({ client, data: subscriptionData }) {
      const event = (subscriptionData.data as any)?.orderStatusChanged;
      if (!event) return;

      setLiveEvents((previous) => [
        `${new Date().toLocaleTimeString('es-CO')} · ${event.previousStatus ?? '—'} → ${event.status}`,
        ...previous,
      ]);

      // Si la pantalla ya muestra la proyeccion, no hay nada que hacer: el
      // evento trae la `OrderProjection` y Apollo la fusiona sola por su `id`.
      //
      // Si todavia estabamos en el caso "pendiente", en cache el campo `order`
      // apunta a un `OrderProjectionPending` (OTRO miembro de la union) y la
      // normalizacion no puede cambiarlo sola. En vez de reconsultar, se
      // escribe la proyeccion recibida como resultado de `order(id)`: la
      // pantalla pasa de "sincronizando" a la orden completa sin una peticion.
      if (event.projection) {
        client.cache.writeQuery({
          query: ORDER_QUERY,
          variables: { id },
          data: { order: event.projection },
        });
      } else if (isPending) {
        void refetch();
      }
    },
  });

  // Cada transicion devuelve un acuse con el nuevo estado del write model.
  // `applyOrderTransition` lo refleja al instante en la proyeccion en cache y
  // la marca como "poniendose al dia" hasta que llegue la Subscription.
  const [approve, { loading: approving }] = useMutation(APPROVE_ORDER, {
    update: (cache, { data: r }) => applyOrderTransition(cache, (r as any)?.approveOrder?.order),
  });
  const [dispatchOrder, { loading: dispatching }] = useMutation(DISPATCH_ORDER, {
    update: (cache, { data: r }) => applyOrderTransition(cache, (r as any)?.dispatchOrder?.order),
  });
  const [cancel, { loading: cancelling }] = useMutation(CANCEL_ORDER, {
    update: (cache, { data: r }) => applyOrderTransition(cache, (r as any)?.cancelOrder?.order),
  });

  async function runCommand(mutate: () => Promise<any>, key: string) {
    setErrors([]);
    const response = await mutate();
    const payload = response.data?.[key];
    if (payload && !payload.success) setErrors(payload.errors ?? []);
  }

  if (loading && !result) {
    return (
      <main className="container container-narrow">
        <div className="skeleton" style={{ height: 240 }} />
      </main>
    );
  }

  if (result?.__typename === 'NotFoundError') {
    return (
      <main className="container container-narrow">
        <Empty icon="📭" title="Pedido no encontrado">
          {result.message} <Link to="/pedidos">Ver mis pedidos</Link>
        </Empty>
      </main>
    );
  }

  /* -------------------- Estado transitorio: proyectando ------------------- */
  if (result?.__typename === 'OrderProjectionPending') {
    return (
      <main className="container container-narrow">
        <h1 className="page-title">Pedido confirmado</h1>
        <p className="page-sub">Preparando el resumen de tu pedido…</p>

        <div className="projection-banner projection-syncing mt-3">
          <span className="spinner" />
          <div>
            <strong>Sincronizando la proyección de lectura</strong>
            <div className="tiny">{result.message}</div>
          </div>
        </div>

        <div className="card card-pad mt-3">
          <div className="row-between">
            <span className="muted">Estado confirmado por el modelo de escritura</span>
            <OrderStatusBadge status={result.acknowledgedStatus} />
          </div>
          <div className="row-between mt-2">
            <span className="muted">Versión del agregado</span>
            <span className="mono">{result.projection.version}</span>
          </div>
          <div className="row-between mt-2">
            <span className="muted">Estado de la proyección</span>
            <span className="badge badge-low pulse">{result.projection.state}</span>
          </div>
        </div>

        <div className="demo-note mt-3">
          <b>Esto es consistencia eventual, no un error.</b> El comando ya confirmó: la orden existe y el
          inventario está reservado en el modelo de escritura. Lo que falta es que el proyector reconstruya
          la tabla de lectura <b>order_read_model</b>. La unión del schema modela este estado
          explícitamente como <b>OrderProjectionPending</b>, para que la interfaz sepa mostrar un indicador
          de sincronización en vez de un 404 o una pantalla vacía.
        </div>
      </main>
    );
  }

  const order = result as OrderProjection | undefined;
  if (!order) return null;

  const canApprove = order.status === 'PENDING_APPROVAL';
  const canDispatch = order.status === 'APPROVED';
  const canCancel = order.status === 'PENDING_APPROVAL' || order.status === 'APPROVED';

  return (
    <main className="container container-narrow">
      <Link to="/pedidos" className="tiny muted">
        ← Mis pedidos
      </Link>

      <div className="row-between wrap mt-3">
        <div>
          <h1 className="page-title">{order.orderNumber}</h1>
          <p className="page-sub">Emitido el {formatDateTime(order.placedAt)}</p>
        </div>
        <OrderStatusBadge status={order.status} />
      </div>

      {/* ------------- Trazabilidad de la consistencia eventual ------------- */}
      <div className={`projection-banner mt-3 ${order.projection.stale ? 'projection-syncing' : 'projection-synced'}`}>
        {order.projection.stale ? <span className="spinner" /> : <span>✓</span>}
        <div style={{ flex: 1 }}>
          <strong>
            Proyección {order.projection.state === 'SYNCED' ? 'sincronizada' : 'poniéndose al día'}
          </strong>
          <div className="tiny mono">
            lag {order.projection.lagMs} ms · versión {order.projection.version} · evento{' '}
            {order.projection.lastEventId} · proyectada {formatDateTime(order.projection.projectedAt)}
          </div>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="mt-3">
          <DomainErrors errors={errors} title="Comando rechazado" />
        </div>
      )}

      {/* --------------------- Comandos de back-office --------------------- */}
      <div className="card card-pad mt-3">
        <div className="section-title">Operación del pedido</div>
        <p className="tiny muted mb-3">
          Cada botón dispara un comando distinto. La máquina de estados del dominio decide cuáles son
          válidos: los inválidos ni siquiera se ofrecen, y si se forzaran, el servidor respondería con un{' '}
          <code>ConflictError</code>.
        </p>
        <div className="row wrap">
          <button
            className="btn btn-accent"
            disabled={!canApprove || approving}
            onClick={() => runCommand(() => approve({ variables: { input: { orderId: order.id } } }), 'approveOrder')}
          >
            Verificar fórmulas y aprobar
          </button>
          <button
            className="btn btn-primary"
            disabled={!canDispatch || dispatching}
            onClick={() =>
              runCommand(
                () =>
                  dispatchOrder({
                    variables: { input: { orderId: order.id, trackingCode: `GUIA-${Date.now().toString().slice(-8)}` } },
                  }),
                'dispatchOrder',
              )
            }
          >
            Despachar
          </button>
          <button
            className="btn btn-danger"
            disabled={!canCancel || cancelling}
            onClick={() =>
              runCommand(
                () =>
                  cancel({
                    variables: { input: { orderId: order.id, reason: 'Anulado por el paciente desde la aplicación' } },
                  }),
                'cancelOrder',
              )
            }
          >
            Anular y devolver stock
          </button>
        </div>
      </div>

      {liveEvents.length > 0 && (
        <div className="card card-pad mt-3">
          <div className="section-title">Eventos recibidos por WebSocket</div>
          <div className="stack-sm mono tiny">
            {liveEvents.map((event, index) => (
              <div key={index}>⚡ {event}</div>
            ))}
          </div>
        </div>
      )}

      {/* ----------------------------- Contenido ----------------------------- */}
      <div className="card card-pad mt-3">
        <div className="section-title">Medicamentos</div>
        {order.items.map((item) => (
          <div className="cart-line" key={item.medicationId}>
            <div>
              <div style={{ fontWeight: 600 }}>
                {item.medicationName}
                {item.requiredPrescription && (
                  <span className="badge badge-rx" style={{ marginLeft: 8 }}>
                    ℞
                  </span>
                )}
              </div>
              <div className="tiny muted">
                {item.medicationSku} · {item.presentation} · {item.unitPrice.formatted} c/u
              </div>
            </div>
            <div className="muted">×{item.quantity}</div>
            <div style={{ fontWeight: 700, textAlign: 'right', minWidth: 100 }}>{item.subtotal.formatted}</div>
          </div>
        ))}

        <div className="summary-row summary-total">
          <span>Total</span>
          <span>{order.total.formatted}</span>
        </div>
      </div>

      {order.prescriptions.length > 0 && (
        <div className="card card-pad mt-3">
          <div className="section-title">Fórmulas médicas</div>
          <div className="stack-sm">
            {order.prescriptions.map((prescription) => (
              <div className="row-between" key={prescription.medicationId}>
                <div>
                  <div style={{ fontWeight: 600 }}>{prescription.medicationName}</div>
                  <div className="tiny muted">
                    Dr(a). {prescription.doctorName} · Reg. {prescription.doctorLicense} ·{' '}
                    {prescription.issuedAt}
                  </div>
                </div>
                <span className={`badge ${prescription.status === 'VERIFIED' ? 'badge-otc' : 'badge-low'}`}>
                  {prescription.status === 'VERIFIED' ? 'Verificada' : 'Pendiente de verificación'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Historial reconstruido desde el event store. */}
      <div className="card card-pad mt-3">
        <div className="section-title">Historial del pedido</div>
        <p className="tiny muted mb-3">
          Reconstruido a partir de la tabla <code>domain_events</code>: no es un registro aparte, se deriva de
          los mismos eventos que produjeron cada cambio.
        </p>
        <div className="timeline">
          {order.timeline.map((entry, index) => (
            <div className="timeline-item" key={index}>
              <div className="timeline-dot" />
              <div className="timeline-body">
                <div className="label">{entry.label}</div>
                <div className="when">{formatDateTime(entry.occurredAt)}</div>
                {entry.note && <div className="tiny muted mt-2">{entry.note}</div>}
                <div className="tiny mono faint">{entry.event}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
