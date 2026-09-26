/**
 * ============================================================================
 *  AFIRMATIVE PILL · Arranque del servidor GraphQL
 * ============================================================================
 *
 * Topologia de red del proceso:
 *
 *      ┌──────────────────────────────────────────────────────────┐
 *      │  http://localhost:4000                                   │
 *      │                                                          │
 *      │   POST /graphql   ── Apollo Server (Queries y Mutations)  │
 *      │   ws://  /graphql ── graphql-ws  (Subscriptions)          │
 *      │                                                          │
 *      │   ...y NADA MAS. Ni una sola ruta REST.                   │
 *      └──────────────────────────────────────────────────────────┘
 *
 * CUMPLIMIENTO DEL MANDATO ZERO-REST
 * ----------------------------------
 * Este archivo es la prueba tecnica de la restriccion: en todo el servidor hay
 * exactamente UN `app.use()` con ruta, y apunta a `/graphql`. No existe
 * `app.get`, `app.post`, `app.put` ni `app.delete` en ninguna parte del
 * proyecto. Catalogo, autenticacion, carrito, ordenes y hasta el health-check
 * viajan por operaciones GraphQL. El ultimo bloque de este archivo instala un
 * manejador que responde 404 explicando esto a cualquier cliente que intente
 * una ruta REST.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { makeExecutableSchema } from '@graphql-tools/schema';

import { env } from './config/env.js';
import { log, color } from './shared/logger.js';
import { resolvers } from './graphql/resolvers.js';
import { buildContext, type GraphQLContext } from './graphql/context.js';
import { closePool, verifyConnection, warmPool } from './db/pool.js';
import { startOutboxPoller, stopOutboxPoller } from './modules/projections/order.projector.js';

/* -------------------------------------------------------------------------- */
/* 1 · Schema ejecutable                                                       */
/* -------------------------------------------------------------------------- */

const typeDefs = readFileSync(fileURLToPath(new URL('./graphql/schema.graphql', import.meta.url)), 'utf8');

const schema = makeExecutableSchema({ typeDefs, resolvers });

/* -------------------------------------------------------------------------- */
/* 2 · Plugin de auditoria SQL                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Imprime, al terminar CADA operacion GraphQL, cuantas consultas SQL costo.
 *
 * Es la evidencia que el video de sustentacion debe mostrar: la query
 * `MedicationsFull` pide 12 medicamentos con categoria, laboratorio, conteos y
 * alternativas, y el log demuestra que no costo ~45 consultas sino 6, porque
 * los DataLoaders agruparon.
 */
const sqlAuditPlugin = {
  async requestDidStart() {
    return {
      async willSendResponse({ contextValue, operationName }: any) {
        const ctx = contextValue as GraphQLContext;
        if (!ctx?.stats || ctx.stats.queries === 0) return;

        const { queries, batchedQueries, keysResolvedInBatch, totalMs } = ctx.stats;
        // Sin DataLoader, cada clave agrupada habria sido una consulta aparte.
        const withoutLoaders = queries - batchedQueries + keysResolvedInBatch;
        const saved = withoutLoaders - queries;

        log.rule(`RESUMEN · ${operationName ?? 'operacion anonima'}`);
        log.info(
          `${color.bold}${queries} consultas SQL${color.reset} en ${totalMs.toFixed(1)}ms` +
            (batchedQueries > 0
              ? ` · ${batchedQueries} en lote resolvieron ${keysResolvedInBatch} claves`
              : ''),
        );
        if (saved > 0) {
          log.info(
            `${color.magenta}DataLoader evito ${color.bold}${saved}${color.reset}${color.magenta} consultas` +
              `${color.reset} (habrian sido ${withoutLoaders} sin batching)`,
          );
        }
      },
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 3 · Servidores HTTP y WebSocket                                             */
/* -------------------------------------------------------------------------- */

const app = express();
const httpServer = http.createServer(app);

/**
 * Servidor WebSocket para las Subscriptions, montado en la MISMA ruta
 * `/graphql`. Asi el cliente solo necesita conocer una direccion y en DevTools
 * se ve con claridad que todo el trafico —HTTP y WS— va al mismo endpoint.
 */
const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });

const wsCleanup = useServer(
  {
    schema,
    // Las Subscriptions tambien necesitan contexto (loaders, repos, sesion).
    // El token viaja en `connectionParams` porque un WebSocket no lleva
    // cabeceras HTTP despues del handshake.
    context: async (ctx) => {
      const params = ctx.connectionParams as Record<string, string> | undefined;
      return buildContext(params?.Authorization ?? params?.authorization, 'subscription');
    },
    onConnect: () => {
      log.info(`${color.cyan}WS${color.reset} cliente suscrito`);
    },
    onDisconnect: () => {
      log.info(`${color.cyan}WS${color.reset} cliente desconectado`);
    },
  },
  wsServer,
);

const apollo = new ApolloServer<GraphQLContext>({
  schema,
  introspection: true, // Necesario para que Apollo Sandbox explore el schema.
  plugins: [
    ApolloServerPluginDrainHttpServer({ httpServer }),
    sqlAuditPlugin,
    // Cierre ordenado del servidor WebSocket junto con el HTTP.
    {
      async serverWillStart() {
        return {
          async drainServer() {
            await wsCleanup.dispose();
          },
        };
      },
    },
  ],
  /**
   * Formateo de errores.
   * Recuerdese que los errores de NEGOCIO no llegan aqui: viajan como datos en
   * `payload.errors`. Lo que pasa por esta funcion son fallos reales, y en
   * produccion se les oculta el stack.
   */
  formatError: (formatted, raw) => {
    log.error(`GraphQL: ${formatted.message}`);
    if (env.isProduction) {
      return { message: formatted.message, extensions: { code: formatted.extensions?.code } };
    }
    return formatted;
  },
});

/* -------------------------------------------------------------------------- */
/* 4 · Arranque                                                                */
/* -------------------------------------------------------------------------- */

async function main() {
  log.rule('AFIRMATIVE PILL · BACKEND GRAPHQL + CQRS');

  await verifyConnection();
  await warmPool();
  await apollo.start();

  app.use(
    '/graphql',
    cors<cors.CorsRequest>({ origin: env.corsOrigins, credentials: true }),
    express.json({ limit: '1mb' }),
    expressMiddleware(apollo, {
      context: async ({ req }) =>
        buildContext(req.headers.authorization, (req.body as any)?.operationName ?? 'anonima'),
    }),
  );

  /**
   * Cualquier otra ruta es un error, y lo decimos con todas las letras.
   * Este manejador es la aplicacion literal del mandato Zero-REST: no es que
   * "no hayamos escrito" endpoints REST, es que el servidor los rechaza.
   */
  app.use((req, res) => {
    res.status(404).json({
      error: 'ZERO_REST_MANDATE',
      message:
        'Este backend no expone endpoints REST. Toda comunicacion debe cursar por ' +
        'operaciones GraphQL (Query, Mutation o Subscription) contra POST /graphql.',
      attempted: `${req.method} ${req.originalUrl}`,
      graphqlEndpoint: `http://localhost:${env.port}/graphql`,
    });
  });

  startOutboxPoller();

  await new Promise<void>((resolve) => httpServer.listen(env.port, resolve));

  log.ok(`GraphQL  ${color.bold}http://localhost:${env.port}/graphql${color.reset}`);
  log.ok(`WebSocket ${color.bold}ws://localhost:${env.port}/graphql${color.reset}  (Subscriptions)`);
  log.info(`CORS permitido para: ${env.corsOrigins.join(', ')}`);
  log.info(
    `Retardo de proyeccion: ${color.bold}${env.projectionDelayMs}ms${color.reset} ` +
      `${color.gray}(hace visible la consistencia eventual; 0 = produccion)${color.reset}`,
  );
  log.rule('SERVIDOR LISTO');
}

/* -------------------------------------------------------------------------- */
/* 5 · Cierre ordenado                                                         */
/* -------------------------------------------------------------------------- */

async function shutdown(signal: string) {
  log.warn(`${signal} recibido; cerrando de forma ordenada...`);
  stopOutboxPoller();
  try {
    await apollo.stop();
    await closePool();
  } catch (error) {
    log.error(`Error durante el cierre: ${(error as Error).message}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((error) => {
  log.error(`No se pudo arrancar el servidor: ${error.message}`);
  console.error(error);
  process.exit(1);
});
