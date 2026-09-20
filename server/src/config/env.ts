/**
 * Carga y validacion de la configuracion del backend.
 *
 * Toda la configuracion entra por variables de entorno (archivo `.env`), nunca
 * hardcodeada. Si falta algo critico el proceso muere de inmediato con un
 * mensaje claro, en lugar de arrancar y fallar a mitad de una demostracion.
 */
import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(
      `\n[config] Falta la variable de entorno obligatoria: ${name}\n` +
        `         Copia server/.env.example a server/.env y completala.\n`,
    );
    process.exit(1);
  }
  return value.trim();
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export const env = {
  /** Puerto HTTP del servidor Apollo. El unico endpoint expuesto sera /graphql. */
  port: optionalInt('PORT', 4000),

  /** Cadena de conexion de PostgreSQL en Supabase. */
  databaseUrl: required('DATABASE_URL'),

  /** Secreto para firmar los JWT que emite la mutation `signIn`. */
  jwtSecret: process.env.JWT_SECRET?.trim() || 'afirmative-pill-dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN?.trim() || '12h',

  /** Origenes permitidos para CORS (el frontend de Vite). */
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  /**
   * Retardo artificial del proyector, en milisegundos.
   *
   * CQRS implica consistencia eventual: la proyeccion de lectura se actualiza
   * DESPUES de que el comando confirma. En un sistema real ese retardo es de
   * milisegundos y resulta invisible. Lo exageramos a proposito (1500 ms) para
   * que en el video se pueda VER el estado "CATCHING_UP" en la interfaz.
   * Poner 0 para comportamiento de produccion.
   */
  projectionDelayMs: optionalInt('PROJECTION_DELAY_MS', 1500),

  /** Cada cuanto el poller del outbox recoge eventos huerfanos (ms). */
  outboxPollIntervalMs: optionalInt('OUTBOX_POLL_INTERVAL_MS', 5000),

  /** Si true, cada consulta SQL se imprime en consola (evidencia del DataLoader). */
  logSql: optionalBool('LOG_SQL', true),

  isProduction: process.env.NODE_ENV === 'production',
} as const;
