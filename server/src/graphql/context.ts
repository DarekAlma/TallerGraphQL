/**
 * Contexto de GraphQL: se construye UNA VEZ POR PETICION.
 *
 * Es el objeto que reciben todos los resolvers como tercer argumento. Contiene
 * tres cosas, y el hecho de que se cree por peticion es esencial en las tres:
 *
 *   · loaders · Los DataLoaders y su cache. Si fueran globales, la cache
 *               sobreviviria entre usuarios y un paciente veria el inventario
 *               que ya cambio para otro. Al vivir aqui, se destruyen al
 *               terminar la peticion.
 *
 *   · repos   · Repositorios ligados al objeto `stats` de esta peticion, para
 *               poder contar cuantas consultas SQL costo cada operacion
 *               GraphQL. Esa cuenta es la evidencia del DataLoader.
 *
 *   · auth    · Identidad derivada del JWT de la cabecera Authorization.
 */
import { randomUUID } from 'node:crypto';
import type { SqlStats } from '../db/pool.js';
import { createCatalogRepository } from '../modules/catalog/catalog.repository.js';
import { createCatalogLoaders, type CatalogLoaders } from '../modules/catalog/catalog.loaders.js';
import { createOrderingRepository } from '../modules/ordering/ordering.repository.js';
import { createOrderingLoaders, type OrderingLoaders } from '../modules/ordering/ordering.loaders.js';
import { createProjectionRepository } from '../modules/projections/projection.repository.js';
import { createIdentityRepository, verifyToken } from '../modules/identity/identity.service.js';

export interface GraphQLContext {
  requestId: string;
  stats: SqlStats;
  auth: {
    /** Id del paciente autenticado, o null si es un visitante anonimo. */
    patientId: string | null;
  };
  repos: {
    catalog: ReturnType<typeof createCatalogRepository>;
    ordering: ReturnType<typeof createOrderingRepository>;
    projections: ReturnType<typeof createProjectionRepository>;
    identity: ReturnType<typeof createIdentityRepository>;
  };
  loaders: CatalogLoaders & OrderingLoaders;
}

/** Construye el contexto a partir de la cabecera Authorization. */
export function buildContext(authorizationHeader: string | undefined, operationName = 'anonymous'): GraphQLContext {
  const requestId = randomUUID().slice(0, 8);

  const stats: SqlStats = {
    requestId,
    operationName,
    queries: 0,
    batchedQueries: 0,
    keysResolvedInBatch: 0,
    totalMs: 0,
  };

  const catalog = createCatalogRepository(stats);
  const ordering = createOrderingRepository(stats);

  return {
    requestId,
    stats,
    auth: { patientId: verifyToken(authorizationHeader) },
    repos: {
      catalog,
      ordering,
      projections: createProjectionRepository(stats),
      identity: createIdentityRepository(stats),
    },
    // Loaders nuevos en cada peticion: cache aislada y sin fugas entre usuarios.
    loaders: {
      ...createCatalogLoaders(catalog),
      ...createOrderingLoaders(ordering),
    },
  };
}
