/**
 * Implementacion de los 7 scalars personalizados del schema.
 *
 * Un scalar tiene tres funciones:
 *   · serialize()    → como se envia el valor AL cliente.
 *   · parseValue()   → como se recibe desde una VARIABLE de la operacion.
 *   · parseLiteral() → como se recibe escrito EN LINEA en el documento GraphQL.
 *
 * Al validar aqui, cualquier dato invalido se rechaza en el borde del sistema
 * con un error de tipo claro, y ningun resolver tiene que volver a comprobarlo.
 */
import { GraphQLScalarType, GraphQLError, Kind, type ValueNode } from 'graphql';

/** Extrae el valor de un literal, sea string o numerico. */
function literalValue(ast: ValueNode): string | number | null {
  if (ast.kind === Kind.STRING) return ast.value;
  if (ast.kind === Kind.INT) return Number.parseInt(ast.value, 10);
  if (ast.kind === Kind.FLOAT) return Number.parseFloat(ast.value);
  return null;
}

function fail(message: string): never {
  throw new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/* -------------------------------------------------------------------------- */
/* DateTime                                                                    */
/* -------------------------------------------------------------------------- */
export const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  description: 'Instante en el tiempo en formato ISO-8601 con zona horaria.',
  serialize(value) {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) fail('DateTime: la fecha no es valida.');
      return value.toISOString();
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) fail(`DateTime: "${value}" no es una fecha valida.`);
      return d.toISOString();
    }
    return fail('DateTime: se esperaba Date, string o number.');
  },
  parseValue(value) {
    if (typeof value !== 'string') fail('DateTime: se esperaba una cadena ISO-8601.');
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) fail(`DateTime: "${value}" no es una fecha ISO-8601 valida.`);
    return d;
  },
  parseLiteral(ast) {
    const raw = literalValue(ast);
    if (raw === null) fail('DateTime: se esperaba un literal de cadena.');
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) fail(`DateTime: "${raw}" no es una fecha ISO-8601 valida.`);
    return d;
  },
});

/* -------------------------------------------------------------------------- */
/* Date (solo calendario, sin hora)                                            */
/* -------------------------------------------------------------------------- */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') {
    // Acepta tanto 'YYYY-MM-DD' como un ISO completo y se queda con la fecha.
    const candidate = value.slice(0, 10);
    if (!DATE_RE.test(candidate)) fail(`Date: "${value}" no cumple el formato YYYY-MM-DD.`);
    return candidate;
  }
  return fail('Date: se esperaba una cadena YYYY-MM-DD o un objeto Date.');
}

export const DateScalar = new GraphQLScalarType({
  name: 'Date',
  description: 'Fecha de calendario sin hora, en formato ISO-8601 (YYYY-MM-DD).',
  serialize: (value) => toIsoDate(value),
  parseValue(value) {
    const iso = toIsoDate(value);
    // Rechaza fechas imposibles como 2026-02-31, que la regex si deja pasar.
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
      fail(`Date: "${iso}" no existe en el calendario.`);
    }
    return iso;
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) fail('Date: se esperaba un literal de cadena.');
    return toIsoDate(ast.value);
  },
});

/* -------------------------------------------------------------------------- */
/* UUID                                                                        */
/* -------------------------------------------------------------------------- */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    fail(`UUID: "${String(value)}" no es un identificador valido.`);
  }
  return (value as string).toLowerCase();
}

export const UUIDScalar = new GraphQLScalarType({
  name: 'UUID',
  description: 'Identificador universal unico (UUID) de un agregado.',
  serialize: assertUuid,
  parseValue: assertUuid,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING) fail('UUID: se esperaba un literal de cadena.');
    return assertUuid(ast.value);
  },
});

/* -------------------------------------------------------------------------- */
/* PositiveInt                                                                 */
/* -------------------------------------------------------------------------- */
function assertPositiveInt(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    fail(`PositiveInt: "${String(value)}" no es un numero entero.`);
  }
  if (n <= 0) fail(`PositiveInt: la cantidad debe ser mayor que cero (se recibio ${n}).`);
  if (n > 1000) fail(`PositiveInt: ${n} excede el maximo permitido por pedido (1000 unidades).`);
  return n;
}

export const PositiveIntScalar = new GraphQLScalarType({
  name: 'PositiveInt',
  description: 'Entero estrictamente mayor que cero.',
  serialize: assertPositiveInt,
  parseValue: assertPositiveInt,
  parseLiteral: (ast) => {
    const raw = literalValue(ast);
    if (raw === null) fail('PositiveInt: se esperaba un literal numerico.');
    return assertPositiveInt(raw);
  },
});

/* -------------------------------------------------------------------------- */
/* NonEmptyString                                                              */
/* -------------------------------------------------------------------------- */
function assertNonEmpty(value: unknown): string {
  if (typeof value !== 'string') fail('NonEmptyString: se esperaba una cadena.');
  const trimmed = value.trim();
  if (trimmed.length === 0) fail('NonEmptyString: el campo no puede estar vacio.');
  if (trimmed.length > 500) fail('NonEmptyString: el texto excede los 500 caracteres.');
  return trimmed;
}

export const NonEmptyStringScalar = new GraphQLScalarType({
  name: 'NonEmptyString',
  description: 'Cadena con al menos un caracter no vacio (se recorta el espacio sobrante).',
  serialize: assertNonEmpty,
  parseValue: assertNonEmpty,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING) fail('NonEmptyString: se esperaba un literal de cadena.');
    return assertNonEmpty(ast.value);
  },
});

/* -------------------------------------------------------------------------- */
/* Decimal (precision monetaria)                                               */
/* -------------------------------------------------------------------------- */
function assertDecimal(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    fail(`Decimal: "${String(value)}" no es un numero valido.`);
  }
  if (n < 0) fail('Decimal: un valor monetario no puede ser negativo.');
  // Redondeo bancario a 2 decimales para evitar arrastrar errores de coma flotante.
  return Math.round(n * 100) / 100;
}

export const DecimalScalar = new GraphQLScalarType({
  name: 'Decimal',
  description: 'Numero decimal de precision monetaria (2 decimales, no negativo).',
  serialize: assertDecimal,
  parseValue: assertDecimal,
  parseLiteral: (ast) => {
    const raw = literalValue(ast);
    if (raw === null) fail('Decimal: se esperaba un literal numerico.');
    return assertDecimal(raw);
  },
});

/* -------------------------------------------------------------------------- */
/* URL                                                                         */
/* -------------------------------------------------------------------------- */
function assertUrl(value: unknown): string {
  if (typeof value !== 'string') fail('URL: se esperaba una cadena.');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(`URL: "${value}" no es una direccion absoluta valida.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail(`URL: solo se admiten los protocolos http y https (se recibio ${parsed.protocol}).`);
  }
  return parsed.toString();
}

export const URLScalar = new GraphQLScalarType({
  name: 'URL',
  description: 'URL absoluta valida (http o https).',
  serialize: assertUrl,
  parseValue: assertUrl,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING) fail('URL: se esperaba un literal de cadena.');
    return assertUrl(ast.value);
  },
});

/** Mapa de resolvers de scalars, listo para `makeExecutableSchema`. */
export const scalarResolvers = {
  DateTime: DateTimeScalar,
  Date: DateScalar,
  UUID: UUIDScalar,
  PositiveInt: PositiveIntScalar,
  NonEmptyString: NonEmptyStringScalar,
  Decimal: DecimalScalar,
  URL: URLScalar,
};
