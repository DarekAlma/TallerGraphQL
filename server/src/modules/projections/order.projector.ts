/**
 * ============================================================================
 *  CQRS · LADO LECTURA · Proyector de ordenes
 * ============================================================================
 *
 * El proyector es la bisagra entre los dos lados de CQRS. Consume eventos de
 * dominio y reconstruye `order_read_model`, una tabla DESNORMALIZADA pensada
 * para una sola cosa: que la pantalla de seguimiento se resuelva con UN SELECT
 * por id, sin un solo JOIN.
 *
 * POR QUE ESTO ES CONSISTENCIA EVENTUAL (Y POR QUE ESTA BIEN)
 * -----------------------------------------------------------
 * El comando confirma (COMMIT) y responde al paciente de inmediato. La
 * proyeccion se reconstruye DESPUES. Durante esa ventana —milisegundos en
 * produccion— el write model y el read model no coinciden.
 *
 * Eso NO es un error: es el precio que se paga por desacoplar lectura y
 * escritura, y es exactamente lo que el taller pide "contemplar". La respuesta
 * de este proyecto a la pregunta *"¿que ve el usuario mientras tanto?"* es:
 *
 *   1. El comando devuelve un ACUSE DE RECIBO con el estado ya confirmado.
 *   2. La query `order(id)` devuelve `OrderProjectionPending` (no null, no
 *      error) mientras la proyeccion no existe.
 *   3. La UI pinta un indicador de "sincronizando" con los datos del acuse.
 *   4. Cuando el proyector termina, publica por Subscription la proyeccion ya
 *      lista y la pantalla se completa sola.
 *
 * DOS CAMINOS HACIA EL PROYECTOR
 * ------------------------------
 *   · Camino rapido: el comando llama a `scheduleProjection()` tras el COMMIT.
 *   · Red de seguridad: `startOutboxPoller()` barre periodicamente los eventos
 *     con `processed_at IS NULL`. Si el proceso se cayo justo despues del
 *     COMMIT y antes de proyectar, al reiniciar se recuperan igual. Esto es lo
 *     que convierte el patron en un TRANSACTIONAL OUTBOX de verdad y no en un
 *     simple "avisar y cruzar los dedos".
 */
import { query, withTransaction } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { log, color } from '../../shared/logger.js';
import { pubsub, TOPICS } from '../../shared/pubsub.js';
import { EVENT_LABELS } from '../ordering/ordering.domain.js';
import { createProjectionRepository } from './projection.repository.js';

/**
 * Momento del COMMIT de cada orden, en memoria.
 * Sirve para medir el lag real de la proyeccion y exponerlo en
 * `ProjectionMetadata.lagMs` en lugar de inventarlo.
 */
const commitTimestamps = new Map<string, number>();

export function markCommitted(orderId: string) {
  commitTimestamps.set(orderId, Date.now());
}

export function commitTimeOf(orderId: string): number | undefined {
  return commitTimestamps.get(orderId);
}

/* -------------------------------------------------------------------------- */
/* Reconstruccion de la proyeccion                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reconstruye por completo la proyeccion de una orden a partir del write model
 * y del event store.
 *
 * Se reconstruye entera en lugar de aplicar deltas: con volumenes de un
 * e-commerce farmaceutico es mas barato en mantenimiento, es idempotente
 * (proyectar dos veces el mismo evento da el mismo resultado) y permite
 * regenerar la tabla de lectura desde cero si algun dia cambia su forma.
 */
export async function projectOrder(orderId: string, lastEventId: string): Promise<void> {
  const started = Date.now();

  await withTransaction('projectOrder', async (tx) => {
    /* 1 · Cabecera de la orden + datos del paciente */
    const orderResult = await tx.query<{
      id: string;
      order_number: string;
      patient_id: string;
      cart_id: string;
      status: string;
      total_cop: number;
      requires_prescription: boolean;
      cancellation_reason: string | null;
      version: number;
      placed_at: Date;
      patient_name: string;
      patient_email: string;
    }>(
      `SELECT o.id, o.order_number, o.patient_id, o.cart_id, o.status, o.total_cop,
              o.requires_prescription, o.cancellation_reason, o.version, o.placed_at,
              p.full_name AS patient_name, p.email AS patient_email
         FROM orders o
         JOIN patients p ON p.id = o.patient_id
        WHERE o.id = $1`,
      [orderId],
      'proj.loadOrder',
    );
    const order = orderResult.rows[0];
    if (!order) {
      log.warn(`proyector: la orden ${orderId} no existe en el write model; se omite.`);
      return;
    }

    /* 2 · Lineas, con la presentacion traida del catalogo */
    const items = await tx.query<any>(
      `SELECT oi.medication_id, oi.medication_name, oi.medication_sku,
              oi.quantity, oi.unit_price_cop, oi.subtotal_cop, oi.required_prescription,
              m.presentation
         FROM order_items oi
         JOIN medications m ON m.id = oi.medication_id
        WHERE oi.order_id = $1
        ORDER BY oi.medication_name`,
      [orderId],
      'proj.loadItems',
    );

    /* 3 · Formulas medicas asociadas al carrito que origino la orden */
    const prescriptions = await tx.query<any>(
      `SELECT pr.medication_id, m.name AS medication_name, pr.doctor_name, pr.doctor_license,
              to_char(pr.issued_at, 'YYYY-MM-DD') AS issued_at, pr.status
         FROM prescriptions pr
         JOIN medications m ON m.id = pr.medication_id
        WHERE pr.cart_id = $1
        ORDER BY m.name`,
      [order.cart_id],
      'proj.loadPrescriptions',
    );

    /* 4 · Linea de tiempo reconstruida desde el EVENT STORE.
           Este es el valor real de tener un log de eventos: el historial no se
           guarda aparte "por si acaso", se deriva de la misma fuente que
           produjo los cambios, asi que no puede desincronizarse. */
    const events = await tx.query<{
      id: string;
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `SELECT id, event_type, payload, occurred_at
         FROM domain_events
        WHERE aggregate_type = 'Order' AND aggregate_id = $1
        ORDER BY id`,
      [orderId],
      'proj.loadEvents',
    );

    const timeline = events.rows.map((e) => ({
      event: e.event_type,
      status: (e.payload?.status as string) ?? (e.event_type === 'OrderPlaced' ? 'PENDING_APPROVAL' : order.status),
      label: EVENT_LABELS[e.event_type] ?? e.event_type,
      occurredAt: e.occurred_at,
      note:
        (e.payload?.reason as string) ??
        (e.payload?.trackingCode ? `Guía de transporte: ${e.payload.trackingCode}` : null),
    }));

    const unitsCount = items.rows.reduce((sum: number, i: any) => sum + i.quantity, 0);

    /* 5 · UPSERT de la proyeccion */
    await tx.query(
      `INSERT INTO order_read_model (
         order_id, order_number, patient_id, patient_name, status, total_cop,
         item_count, units_count, requires_prescription, items, prescriptions,
         timeline, cancellation_reason, placed_at, last_event_id, projected_at, version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,NOW(),$16)
       ON CONFLICT (order_id) DO UPDATE SET
         status                = EXCLUDED.status,
         total_cop             = EXCLUDED.total_cop,
         item_count            = EXCLUDED.item_count,
         units_count           = EXCLUDED.units_count,
         requires_prescription = EXCLUDED.requires_prescription,
         items                 = EXCLUDED.items,
         prescriptions         = EXCLUDED.prescriptions,
         timeline              = EXCLUDED.timeline,
         cancellation_reason   = EXCLUDED.cancellation_reason,
         -- GREATEST: si dos proyecciones de la misma orden terminan en
         -- desorden, el puntero al ultimo evento aplicado nunca retrocede.
         last_event_id         = GREATEST(order_read_model.last_event_id, EXCLUDED.last_event_id),
         projected_at          = NOW(),
         version               = EXCLUDED.version`,
      [
        order.id,
        order.order_number,
        order.patient_id,
        order.patient_name,
        order.status,
        order.total_cop,
        items.rowCount,
        unitsCount,
        order.requires_prescription,
        JSON.stringify(
          items.rows.map((i: any) => ({
            medicationId: String(i.medication_id),
            medicationName: i.medication_name,
            medicationSku: i.medication_sku,
            presentation: i.presentation,
            quantity: i.quantity,
            unitPrice: Number(i.unit_price_cop),
            subtotal: Number(i.subtotal_cop),
            requiredPrescription: i.required_prescription,
          })),
        ),
        JSON.stringify(
          prescriptions.rows.map((p: any) => ({
            medicationId: String(p.medication_id),
            medicationName: p.medication_name,
            doctorName: p.doctor_name,
            doctorLicense: p.doctor_license,
            issuedAt: p.issued_at,
            status: p.status,
          })),
        ),
        JSON.stringify(timeline),
        order.cancellation_reason,
        order.placed_at,
        lastEventId,
        order.version,
      ],
      'proj.upsertReadModel',
    );

    /* 6 · El evento queda marcado como procesado: sale del outbox pendiente */
    await tx.query(
      `UPDATE domain_events SET processed_at = NOW() WHERE id = $1 AND processed_at IS NULL`,
      [lastEventId],
      'proj.markProcessed',
    );
  });

  const lag = commitTimestamps.has(orderId) ? Date.now() - commitTimestamps.get(orderId)! : Date.now() - started;
  log.projection(
    `orden ${color.bold}${orderId.slice(0, 8)}${color.reset} proyectada ` +
      `(evento ${lastEventId}) · ${color.bold}lag ${lag}ms${color.reset}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Publicacion hacia las Subscriptions                                         */
/* -------------------------------------------------------------------------- */

async function publishProjection(orderId: string, eventId: string, eventType: string, previousStatus?: string) {
  const repo = createProjectionRepository();
  // Se usa la variante "conWriteVersion" porque el evento que viaja al cliente
  // debe incluir la proyeccion COMPLETA (con el correo del paciente) y poder
  // declarar honestamente si ya esta al dia respecto al modelo de escritura.
  const projection = await repo.findByOrderIdWithWriteVersion(orderId);
  if (!projection) return;

  await pubsub.publish(TOPICS.ORDER_STATUS_CHANGED, {
    orderStatusChanged: {
      eventId,
      orderId,
      orderNumber: projection.order_number,
      previousStatus: previousStatus ?? null,
      status: projection.status,
      occurredAt: new Date(),
      reason: projection.cancellation_reason ?? null,
      // La proyeccion ya reconstruida viaja DENTRO del evento: Apollo Client la
      // normaliza en cache por su `id` y la pantalla se actualiza sin refetch.
      projectionRow: projection,
      eventType,
    },
  });

  log.projection(`evento ${color.bold}${eventType}${color.reset} publicado a los suscriptores de ${orderId.slice(0, 8)}`);
}

/* -------------------------------------------------------------------------- */
/* Agendamiento (camino rapido)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Agenda la reconstruccion de una proyeccion tras un COMMIT.
 *
 * Es deliberadamente "fire and forget": el comando NO espera a que termine.
 * Si esperara, volveriamos a acoplar escritura y lectura y perderiamos la
 * ventaja de CQRS.
 *
 * `env.projectionDelayMs` anade un retardo artificial (1500 ms por defecto)
 * para que el estado CATCHING_UP sea visible en la demostracion. En
 * produccion se pondria a 0.
 */
export function scheduleProjection(
  orderId: string,
  eventId: string,
  eventType: string,
  previousStatus?: string,
): void {
  markCommitted(orderId);

  const run = async () => {
    try {
      await projectOrder(orderId, eventId);
      await publishProjection(orderId, eventId, eventType, previousStatus);
    } catch (error) {
      // El fallo no se propaga al paciente: su comando YA fue confirmado.
      // El poller del outbox reintentara, porque el evento sigue sin marcar.
      log.error(`proyector: fallo al proyectar la orden ${orderId}: ${(error as Error).message}`);
    }
  };

  if (env.projectionDelayMs > 0) {
    log.projection(
      `proyeccion de ${orderId.slice(0, 8)} agendada en ${env.projectionDelayMs}ms ` +
        `${color.gray}(retardo artificial para hacer visible la consistencia eventual)${color.reset}`,
    );
    setTimeout(run, env.projectionDelayMs);
  } else {
    void run();
  }
}

/* -------------------------------------------------------------------------- */
/* Poller del outbox (red de seguridad)                                        */
/* -------------------------------------------------------------------------- */

let pollerHandle: NodeJS.Timeout | null = null;

/**
 * Recoge los eventos que quedaron sin proyectar.
 *
 * Escenario que cubre: el COMMIT se completo, se devolvio el acuse al paciente
 * y el proceso murio antes de ejecutar `projectOrder`. Sin esta red, esa orden
 * quedaria para siempre en estado "sincronizando". Con ella, al siguiente
 * barrido se proyecta y el sistema converge.
 *
 * Esta es la diferencia entre consistencia eventual (converge, con garantia) y
 * simple inconsistencia (nunca converge).
 */
export function startOutboxPoller(): void {
  if (pollerHandle) return;

  /**
   * Periodo de gracia antes de considerar "huerfano" un evento.
   *
   * Sin el, el poller pisaria a la proyeccion ya agendada: un evento emitido
   * hace 200 ms todavia esta esperando su `setTimeout` de 1500 ms, no esta
   * perdido. Reclamarlo provocaria una proyeccion duplicada y, peor, un evento
   * duplicado hacia los suscriptores.
   *
   * Solo se recoge lo que lleva parado bastante mas de lo que tarda el camino
   * rapido; eso si es sintoma de que ese camino fallo.
   */
  const graceSeconds = Math.max(env.projectionDelayMs * 3, 5000) / 1000;

  const sweep = async () => {
    try {
      const { rows } = await query<{ id: string; aggregate_id: string; event_type: string }>(
        `SELECT id, aggregate_id, event_type
           FROM domain_events
          WHERE processed_at IS NULL
            AND aggregate_type = 'Order'
            AND occurred_at < NOW() - make_interval(secs => $1)
          ORDER BY id
          LIMIT 20`,
        [graceSeconds],
        { label: 'outbox.sweep' },
      );

      if (rows.length === 0) return;
      log.warn(`outbox: ${rows.length} evento(s) pendiente(s) de proyectar; recuperando...`);

      for (const event of rows) {
        await projectOrder(event.aggregate_id, event.id);
        await publishProjection(event.aggregate_id, event.id, event.event_type);
      }
    } catch (error) {
      log.error(`outbox: fallo el barrido: ${(error as Error).message}`);
    }
  };

  pollerHandle = setInterval(sweep, env.outboxPollIntervalMs);
  // `unref` evita que este temporizador mantenga vivo el proceso de Node.
  pollerHandle.unref?.();
  log.info(`Outbox poller activo (cada ${env.outboxPollIntervalMs}ms)`);
}

export function stopOutboxPoller(): void {
  if (pollerHandle) clearInterval(pollerHandle);
  pollerHandle = null;
}
