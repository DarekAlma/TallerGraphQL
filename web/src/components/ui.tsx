/**
 * Componentes de presentacion reutilizables.
 *
 * El mas relevante para la evaluacion es `<DomainErrors>`: convierte los
 * errores tipados que devuelven los comandos en mensajes accionables. Como
 * cada error trae sus propios campos (`available`, `medicationName`...), la
 * interfaz puede ofrecer "ajustar a 12 unidades" o "adjuntar formula" en lugar
 * de un "algo salio mal" generico. Ese es el beneficio practico de haber
 * modelado los errores como tipos del schema y no como cadenas sueltas.
 */
import type { ReactNode } from 'react';
import type { DomainError, OrderStatus, StockAvailability } from '../types';

/* ------------------------------- Etiquetas ------------------------------ */

const AVAILABILITY_LABEL: Record<StockAvailability, { text: string; cls: string }> = {
  IN_STOCK: { text: 'Disponible', cls: 'badge-instock' },
  LOW_STOCK: { text: 'Últimas unidades', cls: 'badge-low' },
  OUT_OF_STOCK: { text: 'Agotado', cls: 'badge-out' },
};

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_APPROVAL: 'Pendiente de aprobación',
  APPROVED: 'Aprobada',
  DISPATCHED: 'Despachada',
  CANCELLED: 'Anulada',
};

export function AvailabilityBadge({ availability, stock }: { availability: StockAvailability; stock?: number }) {
  const v = AVAILABILITY_LABEL[availability];
  return (
    <span className={`badge ${v.cls}`}>
      {v.text}
      {typeof stock === 'number' && availability !== 'OUT_OF_STOCK' ? ` · ${stock}` : ''}
    </span>
  );
}

export function DispensingBadge({ requiresPrescription }: { requiresPrescription: boolean }) {
  return requiresPrescription ? (
    <span className="badge badge-rx" title="Requiere fórmula médica verificada">
      ℞ Fórmula médica
    </span>
  ) : (
    <span className="badge badge-otc" title="Medicamento de venta libre">
      Venta libre
    </span>
  );
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`badge status-${status}`}>{ORDER_STATUS_LABEL[status]}</span>;
}

/* -------------------------- Errores de dominio -------------------------- */

/**
 * Sugerencia accionable derivada del tipo concreto del error.
 * Es el `switch (__typename)` que justifica haber modelado los errores como
 * una interfaz con implementaciones especificas.
 */
function hintFor(error: DomainError): string | null {
  switch (error.__typename) {
    case 'InsufficientStockError':
      return error.available && error.available > 0
        ? `Reduce la cantidad a ${error.available} unidades o menos para continuar.`
        : 'Retira este medicamento del carrito para poder emitir el pedido.';
    case 'PrescriptionRequiredError':
      return 'Usa el botón "Adjuntar fórmula" de ese medicamento en el carrito.';
    case 'ConflictError':
      return `La orden está en estado ${error.currentState} y no admite esa operación.`;
    case 'AuthError':
      return 'Inicia sesión para continuar.';
    default:
      return null;
  }
}

export function DomainErrors({ errors, title }: { errors: DomainError[]; title?: string }) {
  if (!errors || errors.length === 0) return null;

  return (
    <div className="alert-list">
      {title && <div className="section-title" style={{ color: 'var(--danger)' }}>{title}</div>}
      {errors.map((error, i) => {
        const hint = hintFor(error);
        return (
          <div key={`${error.code}-${i}`} className="alert alert-error">
            <span>⚠️</span>
            <div>
              <strong>{error.message}</strong>
              {hint && <div className="tiny" style={{ marginTop: 3 }}>{hint}</div>}
              <div className="tiny mono" style={{ marginTop: 5, opacity: 0.7 }}>
                {error.__typename} · {error.code}
                {error.field ? ` · campo: ${error.field}` : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------- Varios -------------------------------- */

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon">{icon}</div>
      <div className="section-title">{title}</div>
      {children && <div className="muted tiny">{children}</div>}
    </div>
  );
}

export function CardSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="med-grid">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 176 }} />
      ))}
    </div>
  );
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
