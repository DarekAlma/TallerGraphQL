/**
 * Bus de publicacion/suscripcion en memoria.
 *
 * Alimenta las GraphQL Subscriptions. El proyector publica aqui despues de
 * reconstruir la proyeccion, y los clientes conectados por WebSocket reciben
 * el evento.
 *
 * Nota de arquitectura: `PubSub` de `graphql-subscriptions` es in-process, lo
 * que es correcto para este taller (una sola instancia de Apollo Server). En
 * produccion con varias replicas se sustituiria por `graphql-redis-subscriptions`
 * o similar SIN tocar ni el schema ni los resolvers: el punto de extension ya
 * esta aislado en este modulo.
 */
import { PubSub } from 'graphql-subscriptions';

export const pubsub = new PubSub();

/** Nombres de los canales. Centralizados para evitar errores de tipeo. */
export const TOPICS = {
  ORDER_STATUS_CHANGED: 'ORDER_STATUS_CHANGED',
  STOCK_CHANGED: 'STOCK_CHANGED',
} as const;
