/**
 * CATALOGO · Resolvers (lado lectura).
 *
 * Patron aplicado en todo el modulo: los resolvers de `Query` devuelven las
 * FILAS CRUDAS de la base de datos, y son los resolvers de campo de cada tipo
 * los que las traducen al contrato GraphQL.
 *
 * ¿Por que importa? Porque un resolver de campo SOLO se ejecuta si el cliente
 * pidio ese campo. Si la pantalla de listado pide unicamente
 * `{ name price { formatted } }`, los resolvers de `category`, `manufacturer` y
 * `relatedMedications` jamas corren, y por tanto sus DataLoaders nunca tocan la
 * base de datos. Esa es la defensa real contra el over-fetching: no es que se
 * recorte la respuesta al final, es que el trabajo nunca se hace.
 */
import { money } from '../../shared/money.js';
import { availabilityOf } from '../ordering/ordering.domain.js';
import type { GraphQLContext } from '../../graphql/context.js';
import type { CategoryRow, ManufacturerRow, MedicationRow } from './catalog.repository.js';

/* -------------------------------------------------------------------------- */
/* Cursores                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cursor opaco = base64 del desplazamiento.
 *
 * Se codifica a proposito: el cliente no debe interpretarlo ni construirlo a
 * mano. Manana podemos cambiar a paginacion por keyset sin romper a nadie,
 * porque nadie depende de su contenido.
 */
const encodeCursor = (offset: number) => Buffer.from(`offset:${offset}`).toString('base64');

function decodeCursor(cursor?: string | null): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = Number.parseInt(decoded.replace('offset:', ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Forma intermedia que viaja del resolver de Query a los de MedicationConnection.
 *
 * La busqueda NO se ejecuta en el resolver de Query sino de forma perezosa
 * (`load`), la primera vez que un campo la necesita, y se memoriza para el
 * resto. Asi, una consulta que solo pide `facets` (el panel de filtros) no
 * paga un viaje a Supabase para traer filas que nunca va a mostrar. Es la
 * misma idea que el resto del modulo: si el cliente no pide el campo, el
 * trabajo no se hace.
 */
interface ConnectionSource {
  load: () => Promise<{ rows: MedicationRow[]; totalCount: number }>;
  offset: number;
  limit: number;
  filter: unknown;
}

export const catalogResolvers = {
  Query: {
    /**
     * Busqueda facetada del catalogo (Escenario A del taller).
     * Devuelve la fuente intermedia; tanto la busqueda (`load`) como las
     * facetas quedan diferidas a los resolvers de `MedicationConnection`, que
     * solo corren si el cliente pidio esos campos.
     */
    medications(
      _: unknown,
      args: { filter?: any; sort?: any; first?: number | null; after?: string | null },
      ctx: GraphQLContext,
    ): ConnectionSource {
      // Tope duro de pagina: impide que un cliente pida 10.000 filas de golpe
      // y convierta una consulta legitima en una denegacion de servicio.
      const limit = Math.min(Math.max(args.first ?? 12, 1), 50);
      const offset = decodeCursor(args.after);

      let pending: ReturnType<ConnectionSource['load']> | null = null;
      const load = () =>
        (pending ??= ctx.repos.catalog.search({ filter: args.filter, sort: args.sort, limit, offset }));

      return { load, offset, limit, filter: args.filter };
    },

    medication(_: unknown, args: { id: string }, ctx: GraphQLContext) {
      // Incluso para un unico elemento se pasa por el loader: si la misma
      // peticion pide el mismo medicamento desde dos ramas del arbol (p. ej.
      // el detalle y una linea del carrito), se resuelve una sola vez.
      return ctx.loaders.medicationById.load(Number(args.id));
    },

    medicationBySku(_: unknown, args: { sku: string }, ctx: GraphQLContext) {
      return ctx.repos.catalog.medicationBySku(args.sku);
    },

    categories(_: unknown, __: unknown, ctx: GraphQLContext) {
      return ctx.repos.catalog.allCategories();
    },

    manufacturers(_: unknown, __: unknown, ctx: GraphQLContext) {
      return ctx.repos.catalog.allManufacturers();
    },
  },

  /* ------------------------------------------------------------------ */
  MedicationConnection: {
    edges: async (src: ConnectionSource) => {
      const { rows } = await src.load();
      return rows.map((node, i) => ({ cursor: encodeCursor(src.offset + i + 1), node }));
    },

    nodes: async (src: ConnectionSource) => (await src.load()).rows,

    totalCount: async (src: ConnectionSource) => (await src.load()).totalCount,

    pageInfo: async (src: ConnectionSource) => {
      const { rows, totalCount } = await src.load();
      return {
        hasNextPage: src.offset + rows.length < totalCount,
        hasPreviousPage: src.offset > 0,
        startCursor: rows.length > 0 ? encodeCursor(src.offset) : null,
        endCursor: rows.length > 0 ? encodeCursor(src.offset + rows.length) : null,
      };
    },

    /** Diferido: solo se calcula si el cliente pide `facets`. */
    facets: (src: ConnectionSource, _: unknown, ctx: GraphQLContext) =>
      ctx.repos.catalog.facets(src.filter as any),
  },

  CatalogFacets: {
    // Las facetas ya traen el nombre desde el SQL, asi que no hace falta un
    // segundo viaje. Ademas se "siembran" en la cache de los DataLoaders
    // (`prime`): si la misma peticion pide `category` de algun medicamento,
    // la categoria sale de la cache sin volver a Supabase.
    categories: (src: any, _: unknown, ctx: GraphQLContext) =>
      src.categories.map((f: { id: number; slug: string; name: string; count: number }) => {
        const category: CategoryRow = { id: f.id, slug: f.slug, name: f.name };
        ctx.loaders.categoryById.prime(f.id, category);
        return { category, count: f.count };
      }),

    manufacturers: (src: any, _: unknown, ctx: GraphQLContext) =>
      src.manufacturers.map((f: { id: number; name: string; count: number }) => {
        const manufacturer: ManufacturerRow = { id: f.id, name: f.name };
        ctx.loaders.manufacturerById.prime(f.id, manufacturer);
        return { manufacturer, count: f.count };
      }),

    dispensing: (src: any) =>
      src.dispensing.map((f: { requires_prescription: boolean; count: number }) => ({
        rule: f.requires_prescription ? 'PRESCRIPTION_REQUIRED' : 'OVER_THE_COUNTER',
        count: f.count,
      })),

    priceRange: (src: any) => ({ min: money(src.minPrice), max: money(src.maxPrice) }),
  },

  /* ------------------------------------------------------------------ */
  Medication: {
    id: (m: MedicationRow) => String(m.id),
    activeIngredient: (m: MedicationRow) => m.active_ingredient,
    price: (m: MedicationRow) => money(m.price_cop),

    // ---- Los dos resolvers que generan el problema N+1 ----
    // Cada uno se invoca una vez POR MEDICAMENTO de la lista. DataLoader
    // acumula todas esas llamadas del mismo tick y las resuelve en 1 consulta.
    category: (m: MedicationRow, _: unknown, ctx: GraphQLContext) =>
      ctx.loaders.categoryById.load(m.category_id),

    manufacturer: (m: MedicationRow, _: unknown, ctx: GraphQLContext) =>
      ctx.loaders.manufacturerById.load(m.manufacturer_id),

    dispensingRule: (m: MedicationRow) =>
      m.requires_prescription ? 'PRESCRIPTION_REQUIRED' : 'OVER_THE_COUNTER',

    requiresPrescription: (m: MedicationRow) => m.requires_prescription,

    availability: (m: MedicationRow) => availabilityOf(m.stock),

    /** Resolver anidado de segundo nivel, tambien agrupado por DataLoader. */
    async relatedMedications(
      m: MedicationRow,
      args: { limit?: number | null },
      ctx: GraphQLContext,
    ): Promise<MedicationRow[]> {
      const siblings = await ctx.loaders.medicationsByCategory.load(m.category_id);
      return siblings.filter((s) => s.id !== m.id).slice(0, Math.min(args.limit ?? 4, 12));
    },
  },

  Category: {
    id: (c: CategoryRow) => String(c.id),
    code: (c: CategoryRow) => c.slug,
    medicationCount: (c: CategoryRow, _: unknown, ctx: GraphQLContext) =>
      ctx.loaders.medicationCountByCategory.load(c.id),
  },

  Manufacturer: {
    id: (m: ManufacturerRow) => String(m.id),
    medicationCount: (m: ManufacturerRow, _: unknown, ctx: GraphQLContext) =>
      ctx.loaders.medicationCountByManufacturer.load(m.id),
  },
};
