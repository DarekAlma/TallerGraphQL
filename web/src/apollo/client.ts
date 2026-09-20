/**
 * ============================================================================
 *  APOLLO CLIENT · Configuracion del arbol de contexto
 * ============================================================================
 *
 * Esta es la unica puerta de salida de datos de toda la aplicacion. No existe
 * ni un `fetch()` ni un `axios` en ningun componente: si un dato no llega por
 * aqui, no llega. Eso es lo que hace verificable el mandato Zero-REST.
 *
 * CADENA DE LINKS (se recorre de arriba abajo)
 * --------------------------------------------
 *
 *      errorLink ──► authLink ──► auditLink ──► split(operacion)
 *                                                  │
 *                        ¿es Subscription? ────────┤
 *                                 sí │             │ no
 *                                    ▼             ▼
 *                            GraphQLWsLink      HttpLink
 *                          ws://…/graphql    POST http://…/graphql
 *
 *   · errorLink · centraliza el tratamiento de fallos de red y de GraphQL.
 *   · authLink  · inyecta `Authorization: Bearer <token>` en cada operacion.
 *   · auditLink · registra cada operacion para el panel de inspeccion Zero-REST.
 *   · split     · decide transporte segun el TIPO de operacion, no segun la URL.
 *
 * El `split` final es la pieza elegante: Queries y Mutations viajan por HTTP y
 * las Subscriptions por WebSocket, pero el componente que las usa no se entera.
 * `useQuery` y `useSubscription` se escriben igual.
 */
import { ApolloClient, HttpLink, InMemoryCache, split, ApolloLink } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient } from 'graphql-ws';
import { recordOperation } from './operationLog';
import { getStoredToken } from '../state/session';

const HTTP_URI = import.meta.env.VITE_GRAPHQL_HTTP ?? 'http://localhost:4000/graphql';
const WS_URI = import.meta.env.VITE_GRAPHQL_WS ?? 'ws://localhost:4000/graphql';

/* -------------------------------------------------------------------------- */
/* Transportes                                                                 */
/* -------------------------------------------------------------------------- */

/** Queries y Mutations: un unico POST a /graphql. */
const httpLink = new HttpLink({ uri: HTTP_URI });

/**
 * Subscriptions sobre WebSocket.
 * El token no puede ir en cabeceras (un WS no las lleva tras el handshake),
 * asi que viaja en `connectionParams`, que el backend lee en `buildContext`.
 */
const wsLink = new GraphQLWsLink(
  createClient({
    url: WS_URI,
    lazy: true,
    retryAttempts: 5,
    connectionParams: () => {
      const token = getStoredToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
  }),
);

/* -------------------------------------------------------------------------- */
/* Links de la cadena                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Autenticacion.
 * El token se lee en CADA operacion, no una sola vez al arrancar: asi, en
 * cuanto `signIn` lo guarda, la siguiente operacion ya sale autenticada sin
 * tener que reconstruir el cliente.
 */
const authLink = setContext((_operation, previousContext) => {
  const token = getStoredToken();
  return {
    headers: {
      ...previousContext.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
});

/**
 * Auditoria de operaciones.
 *
 * Alimenta el panel "Inspector Zero-REST" de la interfaz. Registra el nombre y
 * el tipo de cada operacion junto con la URL a la que salio, para poder
 * demostrar en pantalla —sin abrir DevTools— que el 100% del trafico va a
 * /graphql y ni una sola peticion va a un endpoint REST.
 */
const auditLink = new ApolloLink((operation, forward) => {
  const definition = getMainDefinition(operation.query);
  const kind =
    definition.kind === 'OperationDefinition' ? definition.operation : 'query';

  recordOperation({
    name: operation.operationName || '(anonima)',
    kind,
    endpoint: kind === 'subscription' ? WS_URI : HTTP_URI,
    variables: operation.variables,
    at: new Date(),
  });

  return forward(operation);
});

/** Tratamiento centralizado de errores de transporte. */
const errorLink = onError(({ error, operation }) => {
  console.error(`[Apollo] fallo en la operacion "${operation.operationName}":`, error);
});

/* -------------------------------------------------------------------------- */
/* Cache normalizada                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Configuracion de la cache en memoria.
 *
 * Apollo normaliza por `__typename` + `id`. Eso tiene una consecuencia muy
 * util para esta aplicacion: cuando la Subscription entrega la proyeccion
 * actualizada de una orden, Apollo la fusiona SOLA con la que ya estaba en
 * cache —porque comparten id— y la pantalla se repinta sin un solo refetch.
 */
const cache = new InMemoryCache({
  typePolicies: {
    Query: {
      fields: {
        /**
         * Paginacion acumulativa del catalogo ("cargar mas").
         *
         * `keyArgs` excluye deliberadamente `after`: todas las paginas de una
         * misma combinacion de filtro y orden comparten entrada de cache y se
         * van concatenando. Si `after` formara parte de la clave, cada pagina
         * seria una entrada distinta y el listado parpadearia al avanzar.
         */
        medications: {
          keyArgs: ['filter', 'sort'],
          merge(existing: any, incoming: any, { args }) {
            // Sin cursor = primera pagina o filtro nuevo: se reemplaza.
            if (!args?.after || !existing) return incoming;
            return {
              ...incoming,
              edges: [...(existing.edges ?? []), ...(incoming.edges ?? [])],
              nodes: [...(existing.nodes ?? []), ...(incoming.nodes ?? [])],
            };
          },
        },
      },
    },

    // La proyeccion se identifica por el id de la orden: es lo que permite que
    // el evento de la Subscription actualice la pantalla automaticamente.
    OrderProjection: { keyFields: ['id'] },
    Medication: { keyFields: ['id'] },
    Cart: { keyFields: ['id'] },

    // `Money` es un objeto de valor sin identidad propia: se incrusta dentro de
    // su padre en lugar de normalizarse como entidad independiente.
    Money: { keyFields: false },
    ProjectionMetadata: { keyFields: false },
  },
});

/* -------------------------------------------------------------------------- */
/* Cliente                                                                     */
/* -------------------------------------------------------------------------- */

export const apolloClient = new ApolloClient({
  link: ApolloLink.from([
    errorLink,
    authLink,
    auditLink,
    split(
      // El unico criterio de enrutamiento es el TIPO de operacion GraphQL.
      ({ query }) => {
        const definition = getMainDefinition(query);
        return definition.kind === 'OperationDefinition' && definition.operation === 'subscription';
      },
      wsLink,
      httpLink,
    ),
  ]),
  cache,
  devtools: { enabled: true },
  defaultOptions: {
    watchQuery: {
      // `cache-and-network` pinta al instante lo que haya en cache y refresca
      // en segundo plano: percepcion de velocidad sin servir datos obsoletos.
      fetchPolicy: 'cache-and-network',
    },
  },
});

export const GRAPHQL_ENDPOINTS = { http: HTTP_URI, ws: WS_URI };
