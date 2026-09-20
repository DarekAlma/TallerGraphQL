/**
 * ============================================================================
 *  CQRS · LADO ESCRITURA · Manejadores de comando
 * ============================================================================
 *
 * Un COMANDO expresa una INTENCION de negocio, no una operacion CRUD.
 * No existe `updateOrder(campos)`. Existen `placeOrder`, `approveOrder`,
 * `dispatchOrder` y `cancelOrder`, cada uno con sus precondiciones, sus
 * invariantes y su evento resultante. Eso es lo que hace que el sistema se
 * pueda auditar: el log de eventos cuenta QUE quiso hacer el negocio, no que
 * columnas cambiaron.
 *
 * Anatomia comun de todo manejador:
 *
 *   1. AUTORIZAR    · ¿hay sesion? ¿el agregado es de este paciente?
 *   2. CARGAR       · traer el agregado bloqueado (FOR UPDATE) si va a mutar.
 *   3. VALIDAR      · invariantes puras de `ordering.domain.ts`.
 *   4. MUTAR        · escribir el write model.
 *   5. EMITIR       · anexar el evento a `domain_events` EN LA MISMA TRANSACCION.
 *   6. CONFIRMAR    · COMMIT.
 *   7. PROYECTAR    · ya fuera de la transaccion, y de forma asincrona,
 *                     notificar al proyector. Aqui nace la consistencia eventual.
 *
 * Los pasos 1-6 son atomicos. El 7 no, y ES INTENCIONAL: si la proyeccion
 * fuera sincrona, el lado de lectura y el de escritura estarian acoplados y
 * no habria CQRS, solo dos tablas.
 */
import { withTransaction, type TransactionClient } from '../../db/pool.js';
import { errors, type AnyDomainError } from '../../shared/errors.js';
import { log, color } from '../../shared/logger.js';
import { pubsub, TOPICS } from '../../shared/pubsub.js';
import { availabilityOf, canTransition, evaluateCheckout, type EvaluableLine, type OrderStatus } from './ordering.domain.js';
import { CART_LINES_SQL, type CartLineRow, type OrderRow } from './ordering.repository.js';
import { scheduleProjection } from '../projections/order.projector.js';

/* -------------------------------------------------------------------------- */
/* Resultado de comando                                                        */
/* -------------------------------------------------------------------------- */

export interface CommandResult<T> {
  success: boolean;
  data: T | null;
  errors: AnyDomainError[];
}

const ok = <T>(data: T): CommandResult<T> => ({ success: true, data, errors: [] });
const reject = <T>(...list: AnyDomainError[]): CommandResult<T> => ({
  success: false,
  data: null,
  errors: list,
});

/**
 * Excepcion interna para abortar una transaccion por motivos de NEGOCIO.
 *
 * Se lanza solo para forzar el ROLLBACK; se captura de inmediato en el borde
 * del comando y se convierte en `errors[]` del payload. Nunca escapa hacia
 * GraphQL como excepcion.
 */
class DomainRejection extends Error {
  constructor(public readonly domainErrors: AnyDomainError[]) {
    super('Comando rechazado por invariantes de dominio');
  }
}

/* -------------------------------------------------------------------------- */
/* Utilidades compartidas                                                      */
/* -------------------------------------------------------------------------- */

function toEvaluableLines(rows: CartLineRow[]): EvaluableLine[] {
  return rows.map((r) => ({
    medicationId: r.medication_id,
    medicationName: r.medication_name,
    medicationSku: r.medication_sku,
    presentation: r.presentation,
    quantity: r.quantity,
    unitPrice: Number(r.unit_price_cop),
    stock: r.stock,
    requiresPrescription: r.requires_prescription,
  }));
}

/**
 * Carga un carrito comprobando propiedad y estado.
 * `forUpdate` bloquea la fila: imprescindible cuando el comando va a mutarla,
 * para que dos peticiones simultaneas del mismo paciente no se pisen.
 */
async function loadOwnedCart(
  tx: TransactionClient,
  cartId: string,
  patientId: string,
  forUpdate = true,
) {
  const { rows } = await tx.query<{ id: string; patient_id: string; status: string }>(
    `SELECT id, patient_id, status FROM carts WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [cartId],
    'cmd.loadCart',
  );
  const cart = rows[0];
  if (!cart) throw new DomainRejection([errors.notFound('Cart', cartId, 'El carrito no existe.')]);
  if (cart.patient_id !== patientId) {
    throw new DomainRejection([errors.forbidden('Este carrito pertenece a otro paciente.')]);
  }
  if (cart.status !== 'OPEN') throw new DomainRejection([errors.cartAlreadyCheckedOut(cartId)]);
  return cart;
}

/** Anexa un evento de dominio dentro de la transaccion en curso (outbox). */
async function appendEvent(
  tx: TransactionClient,
  event: { aggregateType: string; aggregateId: string; type: string; payload: Record<string, unknown> },
) {
  const { rows } = await tx.query<{ id: string; occurred_at: Date }>(
    `INSERT INTO domain_events (aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, occurred_at`,
    [event.aggregateType, event.aggregateId, event.type, JSON.stringify(event.payload)],
    'cmd.appendEvent',
  );
  log.command(`evento ${color.bold}${event.type}${color.reset} anexado (id=${rows[0].id})`);
  return rows[0];
}

/** Publica los movimientos de inventario hacia las Subscriptions. */
function publishStockChanges(
  changes: { id: number; sku: string; name: string; previousStock: number; stock: number }[],
  reason: string,
) {
  for (const c of changes) {
    void pubsub.publish(TOPICS.STOCK_CHANGED, {
      stockChanged: {
        medicationId: String(c.id),
        medicationSku: c.sku,
        medicationName: c.name,
        previousStock: c.previousStock,
        stock: c.stock,
        availability: availabilityOf(c.stock),
        occurredAt: new Date(),
        reason,
      },
    });
  }
}

/** Convierte una DomainRejection en payload; deja escapar el resto. */
function asRejection<T>(error: unknown): CommandResult<T> {
  if (error instanceof DomainRejection) return reject<T>(...error.domainErrors);
  throw error;
}

/* ========================================================================== */
/* COMANDOS DE CARRITO                                                        */
/* ========================================================================== */

export async function createCart(input: { medicationId?: string | null; quantity?: number | null }, patientId: string) {
  try {
    return ok(
      await withTransaction('createCart', async (tx) => {
        // Reutilizamos el carrito abierto si ya existe: abrir uno nuevo en cada
        // visita dejaria carritos huerfanos y confundiria al paciente.
        const existing = await tx.query<{ id: string }>(
          `SELECT id FROM carts WHERE patient_id = $1 AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1`,
          [patientId],
          'cmd.createCart.findOpen',
        );

        let cartId = existing.rows[0]?.id;
        if (!cartId) {
          const created = await tx.query<{ id: string }>(
            `INSERT INTO carts (patient_id) VALUES ($1) RETURNING id`,
            [patientId],
            'cmd.createCart.insert',
          );
          cartId = created.rows[0].id;
          log.command(`carrito ${color.bold}${cartId}${color.reset} abierto para el paciente ${patientId}`);
        }

        if (input.medicationId) {
          await addLineWithinTransaction(tx, cartId, Number(input.medicationId), input.quantity ?? 1);
        }
        return cartId;
      }),
    );
  } catch (error) {
    return asRejection<string>(error);
  }
}

/** Logica compartida por `createCart(conItem)` y `addMedicationToCart`. */
async function addLineWithinTransaction(
  tx: TransactionClient,
  cartId: string,
  medicationId: number,
  quantity: number,
) {
  const med = await tx.query<{ id: number; name: string; sku: string; price_cop: number; stock: number }>(
    `SELECT id, name, sku, price_cop, stock FROM medications WHERE id = $1`,
    [medicationId],
    'cmd.addLine.loadMedication',
  );
  const medication = med.rows[0];
  if (!medication) {
    throw new DomainRejection([errors.notFound('Medication', medicationId)]);
  }

  // Cantidad ya presente en el carrito: la validacion es sobre el TOTAL
  // resultante, no sobre el incremento.
  const current = await tx.query<{ quantity: number }>(
    `SELECT quantity FROM cart_items WHERE cart_id = $1 AND medication_id = $2`,
    [cartId, medicationId],
    'cmd.addLine.currentQty',
  );
  const resulting = (current.rows[0]?.quantity ?? 0) + quantity;

  if (medication.stock < resulting) {
    throw new DomainRejection([
      errors.insufficientStock({
        medicationId: medication.id,
        medicationName: medication.name,
        medicationSku: medication.sku,
        requested: resulting,
        available: medication.stock,
      }),
    ]);
  }

  await tx.query(
    `INSERT INTO cart_items (cart_id, medication_id, quantity, unit_price_cop)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (cart_id, medication_id)
     DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`,
    [cartId, medicationId, quantity, medication.price_cop],
    'cmd.addLine.upsert',
  );
  await tx.query(`UPDATE carts SET updated_at = NOW() WHERE id = $1`, [cartId], 'cmd.touchCart');
}

export async function addMedicationToCart(
  input: { cartId: string; medicationId: string; quantity: number },
  patientId: string,
) {
  try {
    return ok(
      await withTransaction('addMedicationToCart', async (tx) => {
        await loadOwnedCart(tx, input.cartId, patientId);
        await addLineWithinTransaction(tx, input.cartId, Number(input.medicationId), input.quantity);
        return input.cartId;
      }),
    );
  } catch (error) {
    return asRejection<string>(error);
  }
}

export async function changeCartLineQuantity(
  input: { cartId: string; medicationId: string; quantity: number },
  patientId: string,
) {
  try {
    return ok(
      await withTransaction('changeCartLineQuantity', async (tx) => {
        await loadOwnedCart(tx, input.cartId, patientId);

        const med = await tx.query<{ id: number; name: string; sku: string; stock: number }>(
          `SELECT id, name, sku, stock FROM medications WHERE id = $1`,
          [Number(input.medicationId)],
          'cmd.changeQty.loadMedication',
        );
        const medication = med.rows[0];
        if (!medication) throw new DomainRejection([errors.notFound('Medication', input.medicationId)]);

        if (medication.stock < input.quantity) {
          throw new DomainRejection([
            errors.insufficientStock({
              medicationId: medication.id,
              medicationName: medication.name,
              medicationSku: medication.sku,
              requested: input.quantity,
              available: medication.stock,
            }),
          ]);
        }

        const updated = await tx.query(
          `UPDATE cart_items SET quantity = $3 WHERE cart_id = $1 AND medication_id = $2`,
          [input.cartId, Number(input.medicationId), input.quantity],
          'cmd.changeQty.update',
        );
        if (updated.rowCount === 0) {
          throw new DomainRejection([
            errors.validation('Ese medicamento no esta en el carrito.', 'medicationId'),
          ]);
        }
        await tx.query(`UPDATE carts SET updated_at = NOW() WHERE id = $1`, [input.cartId], 'cmd.touchCart');
        return input.cartId;
      }),
    );
  } catch (error) {
    return asRejection<string>(error);
  }
}

export async function removeMedicationFromCart(
  input: { cartId: string; medicationId: string },
  patientId: string,
) {
  try {
    return ok(
      await withTransaction('removeMedicationFromCart', async (tx) => {
        await loadOwnedCart(tx, input.cartId, patientId);
        await tx.query(
          `DELETE FROM cart_items WHERE cart_id = $1 AND medication_id = $2`,
          [input.cartId, Number(input.medicationId)],
          'cmd.removeLine',
        );
        // Al retirar el medicamento tambien desaparece su exigencia regulatoria:
        // guardar una receta huerfana solo generaria confusion.
        await tx.query(
          `DELETE FROM prescriptions WHERE cart_id = $1 AND medication_id = $2`,
          [input.cartId, Number(input.medicationId)],
          'cmd.removeOrphanPrescription',
        );
        await tx.query(`UPDATE carts SET updated_at = NOW() WHERE id = $1`, [input.cartId], 'cmd.touchCart');
        return input.cartId;
      }),
    );
  } catch (error) {
    return asRejection<string>(error);
  }
}

/* ========================================================================== */
/* COMANDO · Adjuntar formula medica                                          */
/* ========================================================================== */

export async function attachPrescription(
  input: {
    cartId: string;
    medicationId: string;
    doctorName: string;
    doctorLicense: string;
    issuedAt: string;
    documentUrl?: string | null;
  },
  patientId: string,
) {
  try {
    return ok(
      await withTransaction('attachPrescription', async (tx) => {
        await loadOwnedCart(tx, input.cartId, patientId);

        const med = await tx.query<{ id: number; name: string; requires_prescription: boolean }>(
          `SELECT id, name, requires_prescription FROM medications WHERE id = $1`,
          [Number(input.medicationId)],
          'cmd.attachPrescription.loadMedication',
        );
        const medication = med.rows[0];
        if (!medication) throw new DomainRejection([errors.notFound('Medication', input.medicationId)]);

        // Invariante: adjuntar receta a un OTC no tiene sentido regulatorio.
        if (!medication.requires_prescription) {
          throw new DomainRejection([
            errors.validation(
              `"${medication.name}" es de venta libre y no admite formula medica.`,
              'medicationId',
            ),
          ]);
        }

        // Invariante: el registro medico debe tener formato plausible.
        if (!/^[A-Za-z0-9.\-\s]{5,}$/.test(input.doctorLicense)) {
          throw new DomainRejection([
            errors.validation(
              'El registro medico del prescriptor no tiene un formato valido (minimo 5 caracteres alfanumericos).',
              'doctorLicense',
            ),
          ]);
        }

        // Invariante regulatoria: una formula no puede venir del futuro ni
        // estar vencida. En Colombia la vigencia habitual es de 30 dias para
        // antibioticos; usamos 180 dias como limite general del taller.
        const issued = new Date(`${input.issuedAt}T00:00:00Z`);
        const today = new Date();
        const ageDays = (today.getTime() - issued.getTime()) / 86_400_000;
        if (ageDays < -1) {
          throw new DomainRejection([
            errors.validation('La fecha de expedicion de la formula no puede estar en el futuro.', 'issuedAt'),
          ]);
        }
        if (ageDays > 180) {
          throw new DomainRejection([
            errors.validation('La formula medica esta vencida (mas de 180 dias de expedida).', 'issuedAt'),
          ]);
        }

        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO prescriptions (cart_id, medication_id, doctor_name, doctor_license, issued_at, document_url, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'SUBMITTED')
           ON CONFLICT (cart_id, medication_id) DO UPDATE SET
             doctor_name    = EXCLUDED.doctor_name,
             doctor_license = EXCLUDED.doctor_license,
             issued_at      = EXCLUDED.issued_at,
             document_url   = EXCLUDED.document_url,
             status         = 'SUBMITTED',
             created_at     = NOW()
           RETURNING id`,
          [
            input.cartId,
            Number(input.medicationId),
            input.doctorName,
            input.doctorLicense,
            input.issuedAt,
            input.documentUrl ?? null,
          ],
          'cmd.attachPrescription.upsert',
        );

        log.command(
          `formula medica adjuntada a "${medication.name}" en el carrito ${input.cartId} (registro ${input.doctorLicense})`,
        );
        return { cartId: input.cartId, prescriptionId: rows[0].id };
      }),
    );
  } catch (error) {
    return asRejection<{ cartId: string; prescriptionId: string }>(error);
  }
}

/* ========================================================================== */
/* COMANDO PRINCIPAL · placeOrder                                             */
/* ========================================================================== */

export interface OrderAcknowledgement {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  total: number;
  placedAt: Date;
  /** Momento exacto del COMMIT: base para medir el lag de la proyeccion. */
  committedAt: number;
  version: number;
}

/**
 * EMITE LA ORDEN.
 *
 * Es el comando critico del sistema y el que concentra las dos invariantes del
 * taller. Todo ocurre dentro de UNA transaccion:
 *
 *   BEGIN
 *     1. Bloquear el carrito                       (FOR UPDATE)
 *     2. Bloquear las filas de inventario          (FOR UPDATE OF m)
 *          ← ordenadas por medication_id para evitar interbloqueos
 *     3. Evaluar invariantes de stock y de receta  (dominio puro)
 *     4. Verificar que el total no cambio bajo los pies del paciente
 *     5. Descontar stock en UNA sentencia con guarda `stock >= qty`
 *     6. Crear la orden y sus lineas (snapshot de nombres y precios)
 *     7. Cerrar el carrito
 *     8. Anexar el evento OrderPlaced             (transactional outbox)
 *   COMMIT
 *
 * Si CUALQUIER paso falla → ROLLBACK: no se descuenta inventario, no se crea
 * orden y no se emite evento. Es imposible que quede una orden confirmada sin
 * su reserva de stock, que es justo lo que el taller senala como riesgo de
 * "consecuencias de salud y sanciones legales graves".
 */
export async function placeOrder(
  input: { cartId: string; acceptedTotal?: number | null; deliveryAddress: string; notes?: string | null },
  patientId: string,
): Promise<CommandResult<OrderAcknowledgement>> {
  try {
    const result = await withTransaction('placeOrder', async (tx) => {
      log.rule('COMANDO placeOrder');

      /* 1 · Carrito bloqueado y verificado */
      await loadOwnedCart(tx, input.cartId, patientId);

      /* 2 · Lineas + inventario BLOQUEADO.
             `FOR UPDATE OF m` bloquea las filas de `medications`, no las del
             carrito. `ORDER BY ci.medication_id` fija un orden de adquisicion
             de cerrojos identico para todas las transacciones: sin eso, dos
             pacientes comprando los mismos dos medicamentos en orden inverso
             se bloquearian mutuamente (deadlock). */
      const linesResult = await tx.query<CartLineRow>(
        `${CART_LINES_SQL.replace('ORDER BY ci.added_at', 'ORDER BY ci.medication_id')} FOR UPDATE OF m`,
        [input.cartId],
        'cmd.placeOrder.lockInventory',
      );
      const lines = toEvaluableLines(linesResult.rows);

      const prescriptionsResult = await tx.query<{ medication_id: number; status: string }>(
        `SELECT medication_id, status FROM prescriptions WHERE cart_id = $1`,
        [input.cartId],
        'cmd.placeOrder.loadPrescriptions',
      );

      /* 3 · Invariantes de dominio (funciones puras, sin SQL) */
      const evaluation = evaluateCheckout(
        lines,
        prescriptionsResult.rows.map((p) => ({
          medicationId: p.medication_id,
          status: p.status as 'SUBMITTED' | 'VERIFIED' | 'REJECTED',
        })),
      );

      if (!evaluation.ok) {
        log.command(
          `${color.red}placeOrder RECHAZADO${color.reset} — ${evaluation.errors.length} invariante(s) violada(s): ` +
            evaluation.errors.map((e) => e.code).join(', '),
        );
        throw new DomainRejection(evaluation.errors);
      }

      /* 4 · El total mostrado al paciente sigue vigente */
      if (typeof input.acceptedTotal === 'number' && Math.abs(input.acceptedTotal - evaluation.total) > 0.01) {
        throw new DomainRejection([
          errors.validation(
            `El total cambio mientras confirmabas (aceptaste $${input.acceptedTotal} y ahora es $${evaluation.total}). Revisa el carrito.`,
            'acceptedTotal',
          ),
        ]);
      }

      /* 5 · Descuento atomico del inventario.
             Una sola sentencia para todas las lineas, con la guarda
             `m.stock >= v.qty`. Si alguna fila no cumple, simplemente no se
             actualiza y el rowCount lo delata. Ademas el CHECK (stock >= 0)
             de la tabla actua como red de seguridad final. */
      const stockUpdate = await tx.query<{ id: number; sku: string; name: string; stock: number }>(
        `UPDATE medications m
            SET stock = m.stock - v.qty, updated_at = NOW()
           FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::int[]) AS qty) v
          WHERE m.id = v.id AND m.stock >= v.qty
      RETURNING m.id, m.sku, m.name, m.stock`,
        [lines.map((l) => l.medicationId), lines.map((l) => l.quantity)],
        'cmd.placeOrder.reserveStock',
      );

      if (stockUpdate.rowCount !== lines.length) {
        // Defensa en profundidad: con las filas bloqueadas esto no deberia
        // ocurrir nunca. Si ocurre, abortamos antes de crear la orden.
        throw new DomainRejection([
          errors.validation(
            'El inventario cambio durante la confirmacion. Intenta de nuevo.',
            'cartId',
          ),
        ]);
      }

      /* 6 · Orden + lineas (con snapshot de nombre, SKU y precio pagado) */
      const requiresPrescription = lines.some((l) => l.requiresPrescription);

      const orderResult = await tx.query<OrderRow>(
        `INSERT INTO orders (order_number, patient_id, cart_id, status, total_cop, requires_prescription)
         VALUES (
           'AP-' || to_char(NOW(), 'YYYY') || '-' || lpad(nextval('order_number_seq')::text, 6, '0'),
           $1, $2, 'PENDING_APPROVAL', $3, $4
         )
         RETURNING id, order_number, status, total_cop, version, placed_at`,
        [patientId, input.cartId, evaluation.total, requiresPrescription],
        'cmd.placeOrder.insertOrder',
      );
      const order = orderResult.rows[0];

      await tx.query(
        `INSERT INTO order_items
           (order_id, medication_id, medication_name, medication_sku, quantity, unit_price_cop, subtotal_cop, required_prescription)
         SELECT $1, u.mid, u.mname, u.msku, u.qty, u.price, u.qty * u.price, u.rx
           FROM UNNEST($2::int[], $3::text[], $4::text[], $5::int[], $6::numeric[], $7::boolean[])
             AS u(mid, mname, msku, qty, price, rx)`,
        [
          order.id,
          lines.map((l) => l.medicationId),
          lines.map((l) => l.medicationName),
          lines.map((l) => l.medicationSku),
          lines.map((l) => l.quantity),
          lines.map((l) => l.unitPrice),
          lines.map((l) => l.requiresPrescription),
        ],
        'cmd.placeOrder.insertItems',
      );

      /* 7 · El carrito queda cerrado e inmutable */
      await tx.query(
        `UPDATE carts SET status = 'CHECKED_OUT', updated_at = NOW() WHERE id = $1`,
        [input.cartId],
        'cmd.placeOrder.closeCart',
      );

      /* 8 · Evento de dominio, en la MISMA transaccion (outbox) */
      const event = await appendEvent(tx, {
        aggregateType: 'Order',
        aggregateId: order.id,
        type: 'OrderPlaced',
        payload: {
          orderNumber: order.order_number,
          patientId,
          cartId: input.cartId,
          total: evaluation.total,
          itemCount: evaluation.itemCount,
          unitsCount: evaluation.unitsCount,
          deliveryAddress: input.deliveryAddress,
          notes: input.notes ?? null,
          requiresPrescription,
        },
      });

      return {
        order,
        eventId: event.id,
        stockChanges: stockUpdate.rows.map((r) => {
          const line = lines.find((l) => l.medicationId === r.id)!;
          return {
            id: r.id,
            sku: r.sku,
            name: r.name,
            previousStock: r.stock + line.quantity,
            stock: r.stock,
          };
        }),
      };
    });

    /* --- Ya fuera de la transaccion: efectos asincronos --------------- */
    const committedAt = Date.now();

    // La proyeccion se agenda, NO se espera. El paciente recibe su acuse de
    // recibo inmediatamente; el modelo de lectura se pondra al dia despues.
    scheduleProjection(result.order.id, result.eventId, 'OrderPlaced');
    publishStockChanges(result.stockChanges, 'ORDER_PLACED');

    log.command(
      `${color.green}orden ${color.bold}${result.order.order_number}${color.reset}${color.green} emitida${color.reset} ` +
        `· total $${result.order.total_cop} · proyeccion agendada`,
    );

    return ok<OrderAcknowledgement>({
      id: result.order.id,
      orderNumber: result.order.order_number,
      status: result.order.status,
      total: Number(result.order.total_cop),
      placedAt: result.order.placed_at,
      committedAt,
      version: result.order.version,
    });
  } catch (error) {
    return asRejection<OrderAcknowledgement>(error);
  }
}

/* ========================================================================== */
/* COMANDOS DE TRANSICION DE ESTADO                                           */
/* ========================================================================== */

/**
 * Implementacion comun de las transiciones de estado de una orden.
 *
 * Centralizarla garantiza que las tres (aprobar, despachar, anular) compartan
 * exactamente el mismo contrato: bloqueo, validacion de la maquina de estados,
 * incremento de version, evento y proyeccion agendada.
 */
async function transitionOrder(
  orderId: string,
  patientId: string,
  target: OrderStatus,
  eventType: string,
  options: {
    label: string;
    payload?: Record<string, unknown>;
    /** Efectos adicionales dentro de la transaccion (p. ej. devolver stock). */
    onTransition?: (tx: TransactionClient, order: OrderRow) => Promise<void>;
    cancellationReason?: string;
  },
): Promise<CommandResult<OrderAcknowledgement>> {
  try {
    const result = await withTransaction(eventType, async (tx) => {
      log.rule(`COMANDO ${options.label}`);

      const { rows } = await tx.query<OrderRow>(
        `SELECT id, order_number, patient_id, cart_id, status, total_cop,
                requires_prescription, version, placed_at
           FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId],
        'cmd.transition.loadOrder',
      );
      const order = rows[0];
      if (!order) throw new DomainRejection([errors.notFound('Order', orderId, 'La orden no existe.')]);
      if (order.patient_id !== patientId) {
        throw new DomainRejection([errors.forbidden('Esta orden pertenece a otro paciente.')]);
      }

      // Maquina de estados: la unica puerta por la que puede pasar el comando.
      if (!canTransition(order.status, target)) {
        throw new DomainRejection([errors.conflict(order.status, options.label)]);
      }

      await options.onTransition?.(tx, order);

      const updated = await tx.query<OrderRow>(
        `UPDATE orders
            SET status = $2,
                version = version + 1,
                updated_at = NOW(),
                cancellation_reason = COALESCE($3, cancellation_reason)
          WHERE id = $1
      RETURNING id, order_number, status, total_cop, version, placed_at`,
        [orderId, target, options.cancellationReason ?? null],
        'cmd.transition.update',
      );

      const event = await appendEvent(tx, {
        aggregateType: 'Order',
        aggregateId: orderId,
        type: eventType,
        payload: {
          orderNumber: order.order_number,
          previousStatus: order.status,
          status: target,
          ...options.payload,
        },
      });

      return { order: updated.rows[0], previousStatus: order.status, eventId: event.id };
    });

    const committedAt = Date.now();
    scheduleProjection(result.order.id, result.eventId, eventType, result.previousStatus);

    return ok<OrderAcknowledgement>({
      id: result.order.id,
      orderNumber: result.order.order_number,
      status: result.order.status,
      total: Number(result.order.total_cop),
      placedAt: result.order.placed_at,
      committedAt,
      version: result.order.version,
    });
  } catch (error) {
    return asRejection<OrderAcknowledgement>(error);
  }
}

/**
 * Aprueba la orden. Es el momento en que las formulas medicas pasan de
 * SUBMITTED a VERIFIED: el taller exige el soporte "antes de transicionar la
 * orden a estado aceptado", y este es ese punto exacto.
 */
export async function approveOrder(input: { orderId: string }, patientId: string) {
  return transitionOrder(input.orderId, patientId, 'APPROVED', 'OrderApproved', {
    label: 'approveOrder',
    onTransition: async (tx, order) => {
      const verified = await tx.query(
        `UPDATE prescriptions SET status = 'VERIFIED'
          WHERE cart_id = $1 AND status = 'SUBMITTED'`,
        [order.cart_id],
        'cmd.approveOrder.verifyPrescriptions',
      );
      if ((verified.rowCount ?? 0) > 0) {
        log.command(`${verified.rowCount} formula(s) medica(s) verificada(s)`);
      }
    },
  });
}

export async function dispatchOrder(input: { orderId: string; trackingCode?: string | null }, patientId: string) {
  return transitionOrder(input.orderId, patientId, 'DISPATCHED', 'OrderDispatched', {
    label: 'dispatchOrder',
    payload: { trackingCode: input.trackingCode ?? null },
  });
}

/**
 * Anula la orden y DEVUELVE el inventario reservado.
 *
 * La devolucion ocurre dentro de la misma transaccion que el cambio de estado:
 * o la orden queda anulada Y el stock restituido, o no pasa nada. Nunca puede
 * quedar inventario "fantasma" reservado por una orden que ya no existe.
 */
export async function cancelOrder(input: { orderId: string; reason: string }, patientId: string) {
  const restored: { id: number; sku: string; name: string; previousStock: number; stock: number }[] = [];

  const result = await transitionOrder(input.orderId, patientId, 'CANCELLED', 'OrderCancelled', {
    label: 'cancelOrder',
    payload: { reason: input.reason },
    cancellationReason: input.reason,
    onTransition: async (tx, order) => {
      const returned = await tx.query<{ id: number; sku: string; name: string; stock: number; returned: number }>(
        `UPDATE medications m
            SET stock = m.stock + v.qty, updated_at = NOW()
           FROM (SELECT medication_id AS id, quantity AS qty FROM order_items WHERE order_id = $1) v
          WHERE m.id = v.id
      RETURNING m.id, m.sku, m.name, m.stock, v.qty AS returned`,
        [order.id],
        'cmd.cancelOrder.restoreStock',
      );
      for (const r of returned.rows) {
        restored.push({
          id: r.id,
          sku: r.sku,
          name: r.name,
          previousStock: r.stock - r.returned,
          stock: r.stock,
        });
      }
      log.command(`inventario devuelto a bodega para ${returned.rowCount} medicamento(s)`);
    },
  });

  if (result.success) publishStockChanges(restored, 'ORDER_CANCELLED');
  return result;
}
