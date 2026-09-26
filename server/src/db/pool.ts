/**
 * Acceso a PostgreSQL (Supabase) mediante el driver nativo `pg`.
 *
 * ¿Por que `pg` y no `supabase-js`?
 *   1. El mandato Zero-REST del taller aplica al canal frontend <-> backend.
 *      Usar `supabase-js` en el backend significaria meter PostgREST (HTTP REST)
 *      dentro de nuestra propia arquitectura, justo lo que el taller quiere evitar.
 *   2. Necesitamos TRANSACCIONES reales (BEGIN / COMMIT / ROLLBACK) para la
 *      reserva atomica de inventario. PostgREST no las ofrece.
 *   3. Necesitamos escribir `WHERE id = ANY($1)` a mano para que el DataLoader
 *      colapse N consultas en UNA. Ese SQL es la evidencia que pide el video.
 *
 * Este modulo ademas instrumenta cada consulta: numero, etiqueta, duracion y
 * filas devueltas. Asi el log del servidor demuestra el batching.
 */
import pg from 'pg';
import { env } from '../config/env.js';
import { log, color } from '../shared/logger.js';

const { Pool } = pg;

/* ------------------------------------------------------------------ *
 * Parsers de tipos
 * ------------------------------------------------------------------ */
// Por defecto `pg` devuelve NUMERIC como string (para no perder precision).
// Nuestros precios caben de sobra en un double, asi que los convertimos a
// number y evitamos ensuciar toda la capa de dominio con parseFloat().
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v: string) => Number.parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number.parseInt(v, 10));

/**
 * Supabase exige TLS siempre. Un PostgreSQL local levantado para pruebas no lo
 * ofrece, asi que la deteccion es automatica en funcion del host: nadie tiene
 * que acordarse de cambiar una bandera al alternar entre uno y otro.
 */
const isLocalDatabase = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(env.databaseUrl);

export const pool = new Pool({
  connectionString: env.databaseUrl,
  // `rejectUnauthorized: false` acepta el certificado gestionado de Supabase
  // sin tener que distribuir su CA root en cada maquina del equipo.
  ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
  max: 10,
  // Abrir una conexion nueva contra Supabase (TCP + TLS + autenticacion en el
  // pooler) cuesta ~1 s; reutilizar una ya abierta, ~100 ms. Con el valor por
  // defecto (cerrar tras 30 s ociosa) casi cada clic en un filtro pagaba ese
  // segundo extra. Mantenemos las conexiones vivas 10 minutos y con TCP
  // keep-alive para que el pooler no las corte por inactividad.
  idleTimeoutMillis: 600_000,
  keepAlive: true,
  connectionTimeoutMillis: 15_000,
  // Nombre visible en pg_stat_activity del dashboard de Supabase.
  application_name: 'afirmative-pill-graphql',
});

pool.on('error', (err) => log.error('Error inesperado en el pool de PostgreSQL:', err.message));

/* ------------------------------------------------------------------ *
 * Instrumentacion
 * ------------------------------------------------------------------ */

/** Estadisticas de SQL acumuladas durante UNA operacion GraphQL. */
export interface SqlStats {
  requestId: string;
  operationName: string;
  queries: number;
  batchedQueries: number;
  keysResolvedInBatch: number;
  totalMs: number;
}

export interface QueryMeta {
  /** Etiqueta legible, p. ej. 'catalog.search' o 'DataLoader:medicationById'. */
  label: string;
  /** Si la consulta resuelve varias claves a la vez (DataLoader), cuantas. */
  batchKeys?: number;
  /** Estadisticas de la peticion GraphQL en curso, si existen. */
  stats?: SqlStats;
}

let globalQueryCounter = 0;

function compact(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** Ejecuta SQL sobre el pool, instrumentando y registrando la operacion. */
export async function query<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  meta: QueryMeta = { label: 'anonymous' },
): Promise<pg.QueryResult<T>> {
  const n = ++globalQueryCounter;
  const started = process.hrtime.bigint();

  try {
    const result = await pool.query<T>(sql, params as any[]);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    if (meta.stats) {
      meta.stats.queries += 1;
      meta.stats.totalMs += ms;
      if (meta.batchKeys && meta.batchKeys > 0) {
        meta.stats.batchedQueries += 1;
        meta.stats.keysResolvedInBatch += meta.batchKeys;
      }
    }

    if (env.logSql) {
      const head = `#${String(n).padStart(4, '0')} ${color.bold}${meta.label}${color.reset}`;
      const tail = `${color.gray}${ms.toFixed(1)}ms · ${result.rowCount} filas${color.reset}`;

      if (meta.batchKeys && meta.batchKeys > 1) {
        // Esta es LA linea que demuestra la mitigacion del problema N+1:
        // una unica consulta resolviendo muchas claves.
        log.batch(
          `${head} — ${color.bold}${meta.batchKeys} claves resueltas en 1 sola consulta${color.reset} ` +
            `(sin DataLoader habrian sido ${meta.batchKeys} consultas) · ${tail}`,
        );
      } else {
        log.sql(`${head} · ${tail}`);
      }
      log.sql(`${color.gray}      ${compact(sql).slice(0, 190)}${color.reset}`);
    }

    return result;
  } catch (error) {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    log.error(`SQL #${n} [${meta.label}] fallo tras ${ms.toFixed(1)}ms: ${(error as Error).message}`);
    log.error(`      ${compact(sql).slice(0, 300)}`);
    throw error;
  }
}

/**
 * Ejecuta `fn` dentro de una transaccion (BEGIN / COMMIT / ROLLBACK).
 *
 * Es la pieza que hace posible la invariante mas dura del taller: reservar
 * inventario de forma atomica. Si cualquier paso falla —stock insuficiente,
 * receta faltante, error de red— se revierte TODO: ni se descuenta stock, ni
 * se crea la orden, ni se publica el evento.
 */
export async function withTransaction<T>(
  label: string,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const txId = `tx:${label}:${Math.random().toString(36).slice(2, 7)}`;
  try {
    await client.query('BEGIN');
    if (env.logSql) log.command(`${color.bold}BEGIN${color.reset} ${color.gray}(${txId})${color.reset}`);

    const result = await fn(makeTransactionClient(client, txId));

    await client.query('COMMIT');
    if (env.logSql) log.command(`${color.green}COMMIT${color.reset} ${color.gray}(${txId})${color.reset}`);
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    log.command(`${color.red}ROLLBACK${color.reset} ${color.gray}(${txId})${color.reset} — ${(error as Error).message}`);
    throw error;
  } finally {
    client.release();
  }
}

export interface TransactionClient {
  query<T extends pg.QueryResultRow = any>(
    sql: string,
    params?: unknown[],
    label?: string,
  ): Promise<pg.QueryResult<T>>;
}

function makeTransactionClient(client: pg.PoolClient, txId: string): TransactionClient {
  return {
    async query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], label = 'tx') {
      const n = ++globalQueryCounter;
      const started = process.hrtime.bigint();
      const result = await client.query<T>(sql, params as any[]);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (env.logSql) {
        log.sql(
          `#${String(n).padStart(4, '0')} ${color.bold}${label}${color.reset} ${color.gray}(${txId})` +
            ` · ${ms.toFixed(1)}ms · ${result.rowCount} filas${color.reset}`,
        );
        log.sql(`${color.gray}      ${compact(sql).slice(0, 190)}${color.reset}`);
      }
      return result;
    },
  };
}

export async function verifyConnection(): Promise<void> {
  const { rows } = await query<{ version: string; db: string }>(
    'SELECT version() AS version, current_database() AS db',
    [],
    { label: 'bootstrap.ping' },
  );
  log.ok(`Conectado a Supabase — ${rows[0].version.split(',')[0]} (db: ${rows[0].db})`);
}

/**
 * Precalienta el pool abriendo varias conexiones al arrancar.
 *
 * Una pantalla del catalogo lanza hasta ~6 consultas concurrentes (busqueda,
 * facetas y los lotes de los DataLoaders). Si el pool solo tuviera una
 * conexion abierta, las demas pagarian el segundo de apertura en el primer
 * uso. Se paga una vez al arrancar el servidor y no delante del usuario.
 */
export async function warmPool(connections = 5): Promise<void> {
  const clients = await Promise.all(Array.from({ length: connections }, () => pool.connect()));
  clients.forEach((client) => client.release());
  log.ok(`Pool precalentado con ${connections} conexiones abiertas`);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
