/**
 * Composicion del mapa de resolvers.
 *
 * Cada modulo (catalog, identity, ordering, projections) exporta sus propios
 * resolvers y aqui se fusionan. Es la expresion en codigo del "monolito
 * modular" que admite el taller: un unico Apollo Server, pero con fronteras de
 * modulo nitidas. Si manana se quisiera federar en subgraphs, cada carpeta de
 * `modules/` ya es un candidato natural a servicio independiente.
 */
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { scalarResolvers } from './scalars.js';
import { resolveDomainErrorType } from '../shared/errors.js';
import { catalogResolvers } from '../modules/catalog/catalog.resolvers.js';
import { identityResolvers } from '../modules/identity/identity.resolvers.js';
import { orderingResolvers } from '../modules/ordering/ordering.resolvers.js';
import { projectionResolvers } from '../modules/projections/projection.resolvers.js';
import type { GraphQLContext } from './context.js';

const startedAt = Date.now();

const healthResolvers = {
  Query: {
    /**
     * Diagnostico del sistema, expuesto como Query.
     *
     * Detalle de cumplimiento del mandato Zero-REST: lo habitual seria un
     * `GET /health`. Aqui no existe: hasta el health-check viaja por /graphql.
     */
    async health(_: unknown, __: unknown, ctx: GraphQLContext) {
      const [meds, pending] = await Promise.all([
        query<{ count: number }>('SELECT COUNT(*)::int AS count FROM medications', [], {
          label: 'health.medicationCount',
          stats: ctx.stats,
        }),
        ctx.repos.ordering.pendingEventCount(),
      ]);

      return {
        status: 'ok',
        schemaVersion: '1.0.0',
        database: 'Supabase PostgreSQL',
        medicationsLoaded: meds.rows[0]?.count ?? 0,
        projectionDelayMs: env.projectionDelayMs,
        pendingEvents: pending,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      };
    },
  },
};

/**
 * Fusion manual de los mapas.
 *
 * Se hace a mano y no con una utilidad de merge profundo para que quede
 * explicito que modulo aporta cada raiz: `Query` recibe campos de los cuatro
 * modulos, `Mutation` de dos, y `Subscription` solo de projections.
 */
export const resolvers = {
  ...scalarResolvers,

  Query: {
    ...healthResolvers.Query,
    ...catalogResolvers.Query,
    ...identityResolvers.Query,
    ...orderingResolvers.Query,
    ...projectionResolvers.Query,
  },

  Mutation: {
    ...identityResolvers.Mutation,
    ...orderingResolvers.Mutation,
  },

  Subscription: {
    ...projectionResolvers.Subscription,
  },

  /**
   * Discriminador de la interfaz `DomainError`.
   *
   * Cada fabrica de `shared/errors.ts` escribe su `__typename`, asi que basta
   * con leerlo. Sin esto, GraphQL no sabria si un error concreto debe
   * serializarse como `InsufficientStockError` o como `ValidationError`, y el
   * cliente perderia los campos especificos de cada uno.
   */
  DomainError: { __resolveType: resolveDomainErrorType },

  // ----- Tipos del catalogo -----
  MedicationConnection: catalogResolvers.MedicationConnection,
  CatalogFacets: catalogResolvers.CatalogFacets,
  Medication: catalogResolvers.Medication,
  Category: catalogResolvers.Category,
  Manufacturer: catalogResolvers.Manufacturer,

  // ----- Identidad -----
  Patient: identityResolvers.Patient,

  // ----- Carrito y comandos -----
  Cart: orderingResolvers.Cart,
  CartLine: orderingResolvers.CartLine,
  PrescriptionRequirement: orderingResolvers.PrescriptionRequirement,
  Prescription: orderingResolvers.Prescription,
  OrderAcknowledgement: orderingResolvers.OrderAcknowledgement,

  // ----- Proyecciones y tiempo real -----
  OrderQueryResult: projectionResolvers.OrderQueryResult,
  OrderProjection: projectionResolvers.OrderProjection,
  OrderLine: projectionResolvers.OrderLine,
  OrderSummary: projectionResolvers.OrderSummary,
  OrderStatusChangedEvent: projectionResolvers.OrderStatusChangedEvent,
};
