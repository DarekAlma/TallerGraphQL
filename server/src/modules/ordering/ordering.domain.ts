/**
 * ============================================================================
 *  DOMINIO · Invariantes de negocio farmaceutico
 * ============================================================================
 *
 * Este modulo es intencionadamente PURO: no importa `pg`, no importa `graphql`,
 * no hace entrada/salida. Solo recibe datos y devuelve veredictos.
 *
 * ¿Por que aislarlo asi?
 *   · Las reglas del negocio farmaceutico son el activo mas valioso del
 *     sistema y las que un regulador auditaria. Tienen que poder leerse sin
 *     atravesar SQL ni resolvers.
 *   · La MISMA funcion se usa en dos sitios: al validar el comando `placeOrder`
 *     (lado escritura) y al calcular `Cart.blockers` (lado lectura, para que la
 *     UI avise antes de intentar). Una sola fuente de verdad, cero divergencia.
 *
 * Las dos invariantes no negociables del taller:
 *   1. INVENTARIO   · no se puede vender lo que no hay en bodega.
 *   2. REGULATORIA  · no se puede despachar un medicamento de formula medica
 *                     sin el soporte de la prescripcion.
 */
import { errors, type AnyDomainError } from '../../shared/errors.js';

/** Linea del carrito enriquecida con el estado actual del medicamento. */
export interface EvaluableLine {
  medicationId: number;
  medicationName: string;
  medicationSku: string;
  presentation: string;
  quantity: number;
  unitPrice: number;
  /** Stock leido en este instante (dentro de la transaccion, si aplica). */
  stock: number;
  requiresPrescription: boolean;
}

export interface EvaluablePrescription {
  medicationId: number;
  status: 'SUBMITTED' | 'VERIFIED' | 'REJECTED';
}

/* -------------------------------------------------------------------------- */
/* Invariante 1 · Inventario                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Verifica que haya existencias suficientes para cada linea.
 *
 * Nota de concurrencia: esta funcion es pura, asi que solo es fiable si el
 * `stock` que recibe fue leido con `SELECT ... FOR UPDATE` dentro de la misma
 * transaccion que hara el descuento. De lo contrario, entre la lectura y la
 * escritura otro paciente podria haberse llevado las ultimas unidades.
 * `placeOrder` lo hace exactamente asi.
 */
export function checkStockInvariant(lines: EvaluableLine[]): AnyDomainError[] {
  const found: AnyDomainError[] = [];
  for (const line of lines) {
    if (line.stock < line.quantity) {
      found.push(
        errors.insufficientStock({
          medicationId: line.medicationId,
          medicationName: line.medicationName,
          medicationSku: line.medicationSku,
          requested: line.quantity,
          available: line.stock,
        }),
      );
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Invariante 2 · Prescripcion medica                                          */
/* -------------------------------------------------------------------------- */

/**
 * Verifica que todo medicamento con `requiresPrescription = true` tenga su
 * formula medica adjunta y no rechazada.
 *
 * Se acepta una receta en estado SUBMITTED (adjuntada, pendiente de revision):
 * el taller exige el SOPORTE antes de "transicionar la orden a estado
 * aceptado". Por eso la orden nace en PENDING_APPROVAL y solo pasa a APPROVED
 * cuando el regente de farmacia la verifica (comando `approveOrder`).
 * Una receta REJECTED no sirve: equivale a no tenerla.
 */
export function checkPrescriptionInvariant(
  lines: EvaluableLine[],
  prescriptions: EvaluablePrescription[],
): AnyDomainError[] {
  const byMedication = new Map(prescriptions.map((p) => [p.medicationId, p]));
  const found: AnyDomainError[] = [];

  for (const line of lines) {
    if (!line.requiresPrescription) continue;

    const prescription = byMedication.get(line.medicationId);

    if (!prescription) {
      found.push(
        errors.prescriptionRequired({
          medicationId: line.medicationId,
          medicationName: line.medicationName,
          medicationSku: line.medicationSku,
        }),
      );
      continue;
    }

    if (prescription.status === 'REJECTED') {
      found.push(errors.prescriptionRejected(line.medicationName));
    }
  }

  return found;
}

/* -------------------------------------------------------------------------- */
/* Evaluacion conjunta                                                         */
/* -------------------------------------------------------------------------- */

export interface CheckoutEvaluation {
  ok: boolean;
  errors: AnyDomainError[];
  total: number;
  itemCount: number;
  unitsCount: number;
}

/**
 * Evalua TODAS las invariantes de una vez y calcula el total.
 *
 * Devuelve la lista completa de problemas, no el primero que encuentra: si al
 * paciente le faltan dos recetas y le sobra la cantidad de un tercer producto,
 * queremos decirselo todo junto y no obligarlo a tres intentos.
 */
export function evaluateCheckout(
  lines: EvaluableLine[],
  prescriptions: EvaluablePrescription[],
): CheckoutEvaluation {
  const found: AnyDomainError[] = [];

  if (lines.length === 0) {
    found.push(errors.cartEmpty());
  }

  found.push(...checkStockInvariant(lines));
  found.push(...checkPrescriptionInvariant(lines, prescriptions));

  const total = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  const unitsCount = lines.reduce((sum, l) => sum + l.quantity, 0);

  return {
    ok: found.length === 0,
    errors: found,
    total: Math.round(total * 100) / 100,
    itemCount: lines.length,
    unitsCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Maquina de estados de la orden                                              */
/* -------------------------------------------------------------------------- */

export type OrderStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'DISPATCHED' | 'CANCELLED';

/**
 * Transiciones permitidas. Declararlas como dato (y no como una cadena de
 * `if`) hace que la regla sea evidente y facil de auditar:
 *
 *      PENDING_APPROVAL ──approve──► APPROVED ──dispatch──► DISPATCHED
 *             │                          │
 *             └────────cancel────────────┴──► CANCELLED   (devuelve inventario)
 *
 * Una orden DISPATCHED o CANCELLED es terminal: no admite mas comandos.
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_APPROVAL: ['APPROVED', 'CANCELLED'],
  APPROVED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Deriva el semaforo de disponibilidad a partir del stock crudo. */
export function availabilityOf(stock: number): 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' {
  if (stock <= 0) return 'OUT_OF_STOCK';
  if (stock <= 30) return 'LOW_STOCK';
  return 'IN_STOCK';
}

/** Etiqueta legible de cada evento, para la linea de tiempo de la UI. */
export const EVENT_LABELS: Record<string, string> = {
  OrderPlaced: 'Pedido recibido y stock reservado',
  OrderApproved: 'Fórmulas médicas verificadas · pedido aprobado',
  OrderDispatched: 'Pedido despachado al domicilio',
  OrderCancelled: 'Pedido anulado · inventario devuelto a bodega',
};
