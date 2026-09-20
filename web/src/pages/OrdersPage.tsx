/**
 * Historial de pedidos.
 *
 * Esta pantalla NO toca el modelo de escritura. Se sirve por completo de
 * `order_read_model`, la tabla desnormalizada del lado de lectura: un unico
 * SELECT con indice por `(patient_id, placed_at DESC)`, sin un solo JOIN, por
 * muchas ordenes e items que acumule el paciente.
 *
 * Ese es el rendimiento que compra CQRS a cambio de aceptar la consistencia
 * eventual.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@apollo/client/react';
import { MY_ORDERS } from '../graphql/operations';
import { getStoredToken } from '../state/session';
import { Empty, formatDateTime, OrderStatusBadge } from '../components/ui';
import type { OrderSummary } from '../types';

export function OrdersPage() {
  const hasSession = !!getStoredToken();
  const { data, loading } = useQuery<{ myOrders: OrderSummary[] }>(MY_ORDERS, {
    variables: { first: 20 },
    skip: !hasSession,
  });

  if (!hasSession) {
    return (
      <main className="container container-narrow">
        <Empty icon="🔒" title="Inicia sesión para ver tus pedidos">
          <Link to="/entrar">Ir a iniciar sesión</Link>
        </Empty>
      </main>
    );
  }

  const orders = data?.myOrders ?? [];

  return (
    <main className="container container-narrow">
      <h1 className="page-title">Mis pedidos</h1>
      <p className="page-sub">Servidos desde el modelo de lectura proyectado.</p>

      {loading && orders.length === 0 && <div className="skeleton mt-3" style={{ height: 180 }} />}

      {!loading && orders.length === 0 && (
        <Empty icon="📦" title="Aún no tienes pedidos">
          <Link to="/">Explorar el catálogo</Link>
        </Empty>
      )}

      <div className="stack mt-3">
        {orders.map((order) => (
          <Link key={order.id} to={`/pedidos/${order.id}`} className="card card-pad">
            <div className="row-between wrap">
              <div>
                <div style={{ fontWeight: 650 }}>{order.orderNumber}</div>
                <div className="tiny muted">
                  {formatDateTime(order.placedAt)} · {order.unitsCount} unidades
                </div>
              </div>
              <div className="row" style={{ gap: 14 }}>
                <span style={{ fontWeight: 700 }}>{order.total.formatted}</span>
                <OrderStatusBadge status={order.status} />
              </div>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
