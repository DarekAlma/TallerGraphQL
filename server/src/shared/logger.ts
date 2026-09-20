/**
 * Logger minimalista con color ANSI.
 *
 * No es decoracion: el video de sustentacion exige mostrar "evidencia en logs
 * del servidor de como el DataLoader agrupa las consultas a Supabase en una
 * unica operacion en lote". Estos colores y prefijos hacen que esa evidencia
 * sea legible de un vistazo en la grabacion.
 */
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

export const color = c;

const ts = () => c.gray + new Date().toISOString().slice(11, 23) + c.reset;

export const log = {
  info: (msg: string, ...rest: unknown[]) =>
    console.log(`${ts()} ${c.blue}INFO ${c.reset} ${msg}`, ...rest),

  ok: (msg: string, ...rest: unknown[]) =>
    console.log(`${ts()} ${c.green}OK   ${c.reset} ${msg}`, ...rest),

  warn: (msg: string, ...rest: unknown[]) =>
    console.log(`${ts()} ${c.yellow}WARN ${c.reset} ${msg}`, ...rest),

  error: (msg: string, ...rest: unknown[]) =>
    console.error(`${ts()} ${c.red}ERROR${c.reset} ${msg}`, ...rest),

  /** Consultas SQL contra Supabase. */
  sql: (msg: string) => console.log(`${ts()} ${c.cyan}SQL  ${c.reset} ${msg}`),

  /** Agrupacion en lote hecha por un DataLoader. */
  batch: (msg: string) => console.log(`${ts()} ${c.magenta}BATCH${c.reset} ${msg}`),

  /** Lado de escritura: comandos de dominio. */
  command: (msg: string) => console.log(`${ts()} ${c.yellow}CMD  ${c.reset} ${msg}`),

  /** Lado de lectura: proyector / consistencia eventual. */
  projection: (msg: string) => console.log(`${ts()} ${c.green}PROJ ${c.reset} ${msg}`),

  /** Separador visual entre operaciones GraphQL (util al grabar el video). */
  rule: (title: string) =>
    console.log(`${c.gray}${'─'.repeat(12)} ${c.bold}${title}${c.reset}${c.gray} ${'─'.repeat(Math.max(0, 60 - title.length))}${c.reset}`),
};
