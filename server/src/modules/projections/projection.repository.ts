/**
 * CQRS · LADO LECTURA · Repositorio de proyecciones.
 *
 * Comparese con `ordering.repository.ts` (lado escritura) para ver la
 * segregacion en accion:
 *
 *   ESCRITURA · 4 tablas normalizadas, JOINs, bloqueos FOR UPDATE,
 *               transacciones. Optimizado para PROTEGER INVARIANTES.
 *
 *   LECTURA   · 1 tabla desnormalizada, 1 SELECT por clave primaria, cero
 *               JOINs, cero bloqueos. Optimizado para RESPONDER RAPIDO.
 *
 * Ese contraste es, literalmente, el patron CQRS.
 */
import { query, type SqlStats } from '../../db/pool.js';

export interface OrderProjectionRow {
  order_id: string;
  order_number: string;
  patient_id: string;
  patient_name: string;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'DISPATCHED' | 'CANCELLED';
  total_cop: number;
  item_count: number;
  units_count: number;
  requires_prescription: boolean;
  items: ProjectedItem[];
  prescriptions: ProjectedPrescription[];
  timeline: ProjectedTimelineEntry[];
  cancellation_reason: string | null;
  placed_at: Date;
  last_event_id: string;
  projected_at: Date;
  version: number;
  /** Se rellena solo en `findByOrderIdWithWriteVersion`. */
  write_version?: number;
  patient_email?: string;
}

export interface ProjectedItem {
  medicationId: string;
  medicationName: string;
  medicationSku: string;
  presentation: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  requiredPrescription: boolean;
}

export interface ProjectedPrescription {
  medicationId: string;
  medicationName: string;
  doctorName: string;
  doctorLicense: string;
  issuedAt: string;
  status: 'SUBMITTED' | 'VERIFIED' | 'REJECTED';
}

export interface ProjectedTimelineEntry {
  event: string;
  status: string;
  label: string;
  occurredAt: string;
  note: string | null;
}

export function createProjectionRepository(stats?: SqlStats) {
  const meta = (label: string) => ({ label, stats });

  return {
    /**
     * UN SELECT por clave primaria. Sin JOINs. Esto es lo que hace que la
     * pantalla de seguimiento responda en un digito de milisegundos por mucho
     * que crezca el historial.
     */
    async findByOrderId(orderId: string): Promise<OrderProjectionRow | null> {
      const { rows } = await query<OrderProjectionRow>(
        `SELECT * FROM order_read_model WHERE order_id = $1`,
        [orderId],
        meta('projection.findByOrderId'),
      );
      return rows[0] ?? null;
    },

    /**
     * Igual que la anterior, pero trae ademas la version del WRITE model y el
     * correo del paciente.
     *
     * Comparar `version` (proyeccion) con `write_version` (orden real) es lo
     * que permite responder con honestidad a `ProjectionMetadata.stale`: si el
     * write model ya avanzo mas alla de lo proyectado, la UI lo sabe y lo
     * muestra en vez de ensenar datos viejos como si fueran definitivos.
     */
    async findByOrderIdWithWriteVersion(orderId: string): Promise<OrderProjectionRow | null> {
      const { rows } = await query<OrderProjectionRow>(
        `SELECT rm.*, o.version AS write_version, p.email AS patient_email
           FROM order_read_model rm
           JOIN orders o   ON o.id = rm.order_id
           JOIN patients p ON p.id = rm.patient_id
          WHERE rm.order_id = $1`,
        [orderId],
        meta('projection.findByOrderIdWithVersion'),
      );
      return rows[0] ?? null;
    },

    /** Historial del paciente, servido integramente desde el read model. */
    async listByPatient(patientId: string, limit: number) {
      const { rows } = await query<OrderProjectionRow>(
        `SELECT order_id, order_number, status, total_cop, units_count, placed_at
           FROM order_read_model
          WHERE patient_id = $1
          ORDER BY placed_at DESC
          LIMIT $2`,
        [patientId, limit],
        meta('projection.listByPatient'),
      );
      return rows;
    },
  };
}

export type ProjectionRepository = ReturnType<typeof createProjectionRepository>;
