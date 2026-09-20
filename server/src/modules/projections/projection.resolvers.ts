/**
 * CQRS · LADO LECTURA · Resolvers de proyecciones y tiempo real.
 *
 * Aqui se resuelve la pregunta central del Escenario C:
 *   "¿que ve el usuario mientras la orden esta siendo validada?"
 *
 * La respuesta esta en la union `OrderQueryResult`, que obliga al cliente a
 * distinguir tres desenlaces en lugar de recibir un `null` ambiguo:
 *
 *   OrderProjection        → la proyeccion esta lista. Datos definitivos.
 *   OrderProjectionPending → el comando se confirmo, el proyector no termino.
 *                            Estado transitorio y normal, NO un error.
 *   NotFoundError          → no existe ninguna orden con ese id.
 */
import { withFilter } from 'graphql-subscriptions';
import { money } from '../../shared/money.js';
import { errors } from '../../shared/errors.js';
import { pubsub, TOPICS } from '../../shared/pubsub.js';
import { env } from '../../config/env.js';
import { commitTimeOf } from './order.projector.js';
import type { GraphQLContext } from '../../graphql/context.js';
import type { OrderProjectionRow, ProjectedItem } from './projection.repository.js';

/* -------------------------------------------------------------------------- */
/* Metadatos de consistencia eventual                                          */
/* -------------------------------------------------------------------------- */

/**
 * Construye `ProjectionMetadata` a partir de una fila del read model.
 *
 * `stale` se calcula comparando la version que refleja la proyeccion con la
 * version real del agregado en el write model. Si el write model va por
 * delante, lo decimos: es preferible que la UI muestre "sincronizando" a que
 * presente datos viejos como si fueran definitivos.
 */
function projectionMetadata(row: OrderProjectionRow) {
  const committedAt = commitTimeOf(row.order_id);
  const projectedAt = row.projected_at instanceof Date ? row.projected_at : new Date(row.projected_at);
  const stale = typeof row.write_version === 'number' && row.write_version > row.version;

  return {
    state: stale ? 'CATCHING_UP' : 'SYNCED',
    projectedAt,
    lagMs: committedAt ? Math.max(0, projectedAt.getTime() - committedAt) : 0,
    lastEventId: String(row.last_event_id),
    version: row.version,
    stale,
  };
}

export const projectionResolvers = {
  Query: {
    /**
     * Consulta de una orden. UN SELECT por clave primaria contra el read model.
     *
     * Si la proyeccion no esta, NO devolvemos null a secas: comprobamos si la
     * orden existe en el write model para poder distinguir "aun no proyectada"
     * de "no existe". Esa distincion es lo que permite a la UI mostrar un
     * indicador de sincronizacion en vez de un 404.
     */
    async order(_: unknown, args: { id: string }, ctx: GraphQLContext) {
      const projection = await ctx.repos.projections.findByOrderIdWithWriteVersion(args.id);

      if (projection) {
        if (projection.patient_id !== ctx.auth.patientId) {
          return errors.notFound('Order', args.id);
        }
        return { __typename: 'OrderProjection', ...projection };
      }

      // Sin proyeccion: ¿existe la orden en el modelo de escritura?
      const writeModel = await ctx.repos.ordering.findOrder(args.id);

      if (!writeModel || writeModel.patient_id !== ctx.auth.patientId) {
        return errors.notFound('Order', args.id);
      }

      return {
        __typename: 'OrderProjectionPending',
        orderId: writeModel.id,
        acknowledgedStatus: writeModel.status,
        message:
          'Tu pedido fue confirmado y el inventario ya quedo reservado. ' +
          'Estamos preparando el resumen; se actualizara solo en unos segundos.',
        retryAfterMs: Math.max(500, env.projectionDelayMs),
        projection: {
          state: 'CATCHING_UP',
          projectedAt: null,
          lagMs: 0,
          lastEventId: null,
          version: writeModel.version,
          stale: true,
        },
      };
    },

    /** Historial del paciente, servido integramente desde el read model. */
    async myOrders(_: unknown, args: { first?: number | null }, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return [];
      const limit = Math.min(Math.max(args.first ?? 10, 1), 50);
      return ctx.repos.projections.listByPatient(ctx.auth.patientId, limit);
    },
  },

  /* ------------------------------------------------------------------ */
  /** Discriminador de la union: cada rama ya viaja con su `__typename`. */
  OrderQueryResult: {
    __resolveType: (obj: { __typename?: string }) => obj.__typename ?? 'NotFoundError',
  },

  OrderProjection: {
    id: (row: OrderProjectionRow) => row.order_id,
    orderNumber: (row: OrderProjectionRow) => row.order_number,

    patient: (row: OrderProjectionRow) => ({
      id: row.patient_id,
      fullName: row.patient_name,
      email: row.patient_email ?? '',
    }),

    // `items` ya viene desnormalizado en JSONB: cero consultas adicionales.
    items: (row: OrderProjectionRow) => row.items ?? [],
    prescriptions: (row: OrderProjectionRow) => row.prescriptions ?? [],
    timeline: (row: OrderProjectionRow) => row.timeline ?? [],

    total: (row: OrderProjectionRow) => money(row.total_cop),
    itemCount: (row: OrderProjectionRow) => row.item_count,
    unitsCount: (row: OrderProjectionRow) => row.units_count,
    requiresPrescription: (row: OrderProjectionRow) => row.requires_prescription,
    cancellationReason: (row: OrderProjectionRow) => row.cancellation_reason,
    placedAt: (row: OrderProjectionRow) => row.placed_at,
    projection: (row: OrderProjectionRow) => projectionMetadata(row),
  },

  OrderLine: {
    unitPrice: (item: ProjectedItem) => money(item.unitPrice),
    subtotal: (item: ProjectedItem) => money(item.subtotal),

    /**
     * Campo OPCIONAL a proposito.
     *
     * La proyeccion ya trae el snapshot (nombre, SKU, precio pagado), asi que
     * la pantalla de seguimiento no necesita este campo para pintarse. Solo si
     * el cliente lo pide —por ejemplo para ofrecer "volver a comprar"— se va al
     * catalogo, y entonces el DataLoader agrupa TODAS las lineas de la orden
     * en una sola consulta.
     */
    medication: (item: ProjectedItem, _: unknown, ctx: GraphQLContext) =>
      ctx.loaders.medicationById.load(Number(item.medicationId)),
  },

  OrderSummary: {
    id: (row: OrderProjectionRow) => row.order_id,
    orderNumber: (row: OrderProjectionRow) => row.order_number,
    total: (row: OrderProjectionRow) => money(row.total_cop),
    unitsCount: (row: OrderProjectionRow) => row.units_count,
    placedAt: (row: OrderProjectionRow) => row.placed_at,
  },

  /* ------------------------------------------------------------------ */
  Subscription: {
    /**
     * Cambios de estado de UNA orden concreta.
     *
     * `withFilter` descarta en el servidor los eventos de otras ordenes: cada
     * cliente recibe solo lo suyo, en lugar de filtrar en el navegador todo el
     * trafico de la plataforma.
     */
    orderStatusChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterableIterator([TOPICS.ORDER_STATUS_CHANGED]),
        (payload: any, variables?: { orderId: string }) =>
          payload?.orderStatusChanged?.orderId === variables?.orderId,
      ),
    },

    /**
     * Movimientos de inventario del catalogo.
     * Sin `medicationIds` se reciben todos; con la lista, solo los de interes
     * (por ejemplo los medicamentos visibles en la pantalla actual).
     */
    stockChanged: {
      subscribe: withFilter(
        () => pubsub.asyncIterableIterator([TOPICS.STOCK_CHANGED]),
        (payload: any, variables?: { medicationIds?: string[] | null }) => {
          const wanted = variables?.medicationIds;
          if (!wanted || wanted.length === 0) return true;
          return wanted.includes(payload?.stockChanged?.medicationId);
        },
      ),
    },
  },

  OrderStatusChangedEvent: {
    /** La proyeccion reconstruida viaja dentro del propio evento. */
    projection: (event: any) => event.projectionRow ?? null,
  },
};
