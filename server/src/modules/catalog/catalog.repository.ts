/**
 * CATALOGO · Repositorio de lectura.
 *
 * Todo el SQL del lado de consulta vive aqui. Los resolvers no escriben SQL:
 * solo orquestan. Esa separacion permite leer de un vistazo que consultas
 * ejecuta el sistema y comprobar que estan indexadas.
 *
 * Las funciones `...ByIds` son las que consumen los DataLoaders: todas usan
 * `WHERE columna = ANY($1)`, que es la traduccion literal de "dame estas N
 * entidades en UNA sola ida a la base de datos".
 */
import { query, type SqlStats } from '../../db/pool.js';

/* -------------------------------------------------------------------------- */
/* Tipos de fila                                                               */
/* -------------------------------------------------------------------------- */

export interface MedicationRow {
  id: number;
  sku: string;
  name: string;
  active_ingredient: string;
  category_id: number;
  manufacturer_id: number;
  dosage: string;
  presentation: string;
  price_cop: number;
  stock: number;
  requires_prescription: boolean;
  description: string | null;
}

export interface CategoryRow {
  id: number;
  slug: string;
  name: string;
}

export interface ManufacturerRow {
  id: number;
  name: string;
}

export interface MedicationFilterInput {
  search?: string | null;
  categories?: string[] | null;
  manufacturerIds?: string[] | null;
  dispensingRule?: 'OVER_THE_COUNTER' | 'PRESCRIPTION_REQUIRED' | null;
  onlyAvailable?: boolean | null;
  minPrice?: number | null;
  maxPrice?: number | null;
}

export interface MedicationSortInput {
  field: 'NAME' | 'PRICE' | 'STOCK' | 'RELEVANCE';
  direction: 'ASC' | 'DESC';
}

/**
 * Columnas del catalogo, SIEMPRE cualificadas con el alias `m`.
 *
 * La cualificacion no es cosmetica: la busqueda hace JOIN con `categories`,
 * que tambien tiene `id` y `name`. Sin el prefijo, PostgreSQL rechaza la
 * consulta con "column reference \"id\" is ambiguous".
 */
const MEDICATION_COLUMNS = `
  m.id, m.sku, m.name, m.active_ingredient, m.category_id, m.manufacturer_id,
  m.dosage, m.presentation, m.price_cop, m.stock, m.requires_prescription, m.description
`;

/* -------------------------------------------------------------------------- */
/* Construccion dinamica del WHERE                                             */
/* -------------------------------------------------------------------------- */

/**
 * Traduce el input GraphQL a una clausula WHERE parametrizada.
 *
 * Importante: NUNCA se concatena un valor del usuario dentro del SQL. Todos
 * entran como `$1, $2, ...`, de modo que la inyeccion SQL es imposible por
 * construccion.
 */
function buildWhere(
  filter: MedicationFilterInput | null | undefined,
  options: {
    /** Dimension que se ignora (facetas disyuntivas, ver `facets()`). */
    exclude?: 'categories' | 'manufacturers';
    /** Lista de parametros compartida, para combinar varios WHERE en una consulta. */
    params?: unknown[];
  } = {},
) {
  const conditions: string[] = [];
  const params: unknown[] = options.params ?? [];
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filter?.search && filter.search.trim() !== '') {
    const term = `%${filter.search.trim()}%`;
    const ph = p(term);
    // Los indices GIN + trigramas de 01_schema.sql hacen que estos ILIKE
    // con comodin inicial NO degeneren en escaneo secuencial.
    conditions.push(`(m.name ILIKE ${ph} OR m.active_ingredient ILIKE ${ph} OR m.sku ILIKE ${ph})`);
  }

  if (options.exclude !== 'categories' && filter?.categories && filter.categories.length > 0) {
    conditions.push(`c.slug = ANY(${p(filter.categories)})`);
  }

  if (options.exclude !== 'manufacturers' && filter?.manufacturerIds && filter.manufacturerIds.length > 0) {
    const ids = filter.manufacturerIds.map((id) => Number.parseInt(id, 10)).filter(Number.isFinite);
    conditions.push(`m.manufacturer_id = ANY(${p(ids)})`);
  }

  if (filter?.dispensingRule) {
    conditions.push(`m.requires_prescription = ${p(filter.dispensingRule === 'PRESCRIPTION_REQUIRED')}`);
  }

  if (filter?.onlyAvailable) {
    conditions.push('m.stock > 0');
  }

  if (typeof filter?.minPrice === 'number') conditions.push(`m.price_cop >= ${p(filter.minPrice)}`);
  if (typeof filter?.maxPrice === 'number') conditions.push(`m.price_cop <= ${p(filter.maxPrice)}`);

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function buildOrderBy(sort: MedicationSortInput | null | undefined, search?: string | null): string {
  const dir = sort?.direction === 'DESC' ? 'DESC' : 'ASC';
  switch (sort?.field) {
    case 'PRICE':
      return `ORDER BY m.price_cop ${dir}, m.id ASC`;
    case 'STOCK':
      return `ORDER BY m.stock ${dir}, m.id ASC`;
    case 'RELEVANCE':
      // similarity() viene de pg_trgm: ordena por parecido real al texto
      // buscado en lugar de alfabeticamente.
      return search && search.trim() !== ''
        ? `ORDER BY GREATEST(similarity(m.name, $SEARCH), similarity(m.active_ingredient, $SEARCH)) DESC, m.id ASC`
        : `ORDER BY m.name ASC, m.id ASC`;
    case 'NAME':
    default:
      return `ORDER BY m.name ${dir}, m.id ASC`;
  }
}

/* -------------------------------------------------------------------------- */
/* Repositorio                                                                 */
/* -------------------------------------------------------------------------- */

export function createCatalogRepository(stats?: SqlStats) {
  const meta = (label: string, batchKeys?: number) => ({ label, batchKeys, stats });

  return {
    /** Busqueda paginada. Devuelve la pagina y el total que cumple el filtro. */
    async search(args: {
      filter?: MedicationFilterInput | null;
      sort?: MedicationSortInput | null;
      limit: number;
      offset: number;
    }) {
      const where = buildWhere(args.filter);
      const search = args.filter?.search ?? null;

      let orderBy = buildOrderBy(args.sort, search);
      const params = [...where.params];
      if (orderBy.includes('$SEARCH')) {
        params.push(search);
        orderBy = orderBy.replaceAll('$SEARCH', `$${params.length}`);
      }

      const limitPh = `$${params.length + 1}`;
      const offsetPh = `$${params.length + 2}`;

      // `COUNT(*) OVER()` devuelve el total que cumple el filtro en cada fila de
      // la pagina, asi que pagina y total salen en UN solo viaje a Supabase en
      // lugar de dos consultas en serie (cada viaje cuesta ~100 ms de red).
      const result = await query<MedicationRow & { total_count: number }>(
        `SELECT ${MEDICATION_COLUMNS}, COUNT(*) OVER()::int AS total_count
           FROM medications m
           JOIN categories c ON c.id = m.category_id
           ${where.sql}
           ${orderBy}
           LIMIT ${limitPh} OFFSET ${offsetPh}`,
        [...params, args.limit, args.offset],
        meta('catalog.search'),
      );

      if (result.rows.length > 0 || args.offset === 0) {
        return { rows: result.rows, totalCount: result.rows[0]?.total_count ?? 0 };
      }

      // Pagina vacia mas alla del final: la ventana no aporta filas de las que
      // leer el total, y solo en este caso raro se paga una consulta extra.
      const total = await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM medications m
           JOIN categories c ON c.id = m.category_id
           ${where.sql}`,
        where.params,
        meta('catalog.searchCount'),
      );
      return { rows: [], totalCount: total.rows[0]?.count ?? 0 };
    },

    /**
     * Facetas de la busqueda actual (conteos por categoria, laboratorio,
     * regimen de dispensacion y rango de precios).
     *
     * Dos decisiones:
     *
     *   · UNA sola consulta. Las agregaciones y los nombres de categorias y
     *     laboratorios salen juntos (CTEs + `json_agg` + JOIN). Antes los
     *     nombres se resolvian en un segundo viaje via DataLoader.
     *
     *   · FACETAS DISYUNTIVAS. Los conteos de categoria se calculan ignorando
     *     el propio filtro de categoria (y lo mismo con laboratorio). Si no,
     *     al marcar "Analgesicos" las demas categorias desaparecerian del
     *     panel y seria imposible marcar una segunda: el filtro es un OR
     *     dentro de la dimension, y la faceta debe decir cuantos resultados
     *     SUMARIA cada opcion.
     */
    async facets(filter?: MedicationFilterInput | null) {
      const params: unknown[] = [];
      const all = buildWhere(filter, { params });
      const withoutCategories = buildWhere(filter, { params, exclude: 'categories' });
      const withoutManufacturers = buildWhere(filter, { params, exclude: 'manufacturers' });

      const { rows } = await query<{
        categories: { id: number; slug: string; name: string; count: number }[] | null;
        manufacturers: { id: number; name: string; count: number }[] | null;
        dispensing: { requires_prescription: boolean; count: number }[] | null;
        min_price: number | null;
        max_price: number | null;
      }>(
        `WITH filtered AS (
           SELECT m.* FROM medications m JOIN categories c ON c.id = m.category_id ${all.sql}
         ),
         for_categories AS (
           SELECT m.* FROM medications m JOIN categories c ON c.id = m.category_id ${withoutCategories.sql}
         ),
         for_manufacturers AS (
           SELECT m.* FROM medications m JOIN categories c ON c.id = m.category_id ${withoutManufacturers.sql}
         )
         SELECT
           (SELECT json_agg(x ORDER BY x.name) FROM (
              SELECT c.id, c.slug, c.name, COUNT(*)::int AS count
                FROM for_categories f JOIN categories c ON c.id = f.category_id
               GROUP BY c.id) x
           ) AS categories,
           (SELECT json_agg(x ORDER BY x.name) FROM (
              SELECT mf.id, mf.name, COUNT(*)::int AS count
                FROM for_manufacturers f JOIN manufacturers mf ON mf.id = f.manufacturer_id
               GROUP BY mf.id) x
           ) AS manufacturers,
           (SELECT json_agg(x) FROM (
              SELECT requires_prescription, COUNT(*)::int AS count
                FROM filtered GROUP BY requires_prescription) x
           ) AS dispensing,
           (SELECT MIN(price_cop) FROM filtered) AS min_price,
           (SELECT MAX(price_cop) FROM filtered) AS max_price`,
        params,
        meta('catalog.facets'),
      );

      const r = rows[0];
      return {
        categories: r?.categories ?? [],
        manufacturers: r?.manufacturers ?? [],
        dispensing: r?.dispensing ?? [],
        minPrice: r?.min_price ?? 0,
        maxPrice: r?.max_price ?? 0,
      };
    },

    /* ------------------- Cargas por lotes (DataLoader) ------------------- */

    /**
     * N medicamentos en UNA consulta. Sin esto, resolver `OrderLine.medication`
     * para una orden de 5 items dispararia 5 SELECT independientes.
     */
    async medicationsByIds(ids: readonly number[]) {
      const { rows } = await query<MedicationRow>(
        `SELECT ${MEDICATION_COLUMNS} FROM medications m WHERE m.id = ANY($1)`,
        [ids],
        meta('DataLoader:medicationById', ids.length),
      );
      return rows;
    },

    async categoriesByIds(ids: readonly number[]) {
      const { rows } = await query<CategoryRow>(
        `SELECT id, slug, name FROM categories WHERE id = ANY($1)`,
        [ids],
        meta('DataLoader:categoryById', ids.length),
      );
      return rows;
    },

    async manufacturersByIds(ids: readonly number[]) {
      const { rows } = await query<ManufacturerRow>(
        `SELECT id, name FROM manufacturers WHERE id = ANY($1)`,
        [ids],
        meta('DataLoader:manufacturerById', ids.length),
      );
      return rows;
    },

    /** Conteo de medicamentos por categoria, para las N categorias pedidas. */
    async medicationCountByCategoryIds(ids: readonly number[]) {
      const { rows } = await query<{ category_id: number; count: number }>(
        `SELECT category_id, COUNT(*)::int AS count
           FROM medications WHERE category_id = ANY($1) GROUP BY category_id`,
        [ids],
        meta('DataLoader:medicationCountByCategory', ids.length),
      );
      return rows;
    },

    async medicationCountByManufacturerIds(ids: readonly number[]) {
      const { rows } = await query<{ manufacturer_id: number; count: number }>(
        `SELECT manufacturer_id, COUNT(*)::int AS count
           FROM medications WHERE manufacturer_id = ANY($1) GROUP BY manufacturer_id`,
        [ids],
        meta('DataLoader:medicationCountByManufacturer', ids.length),
      );
      return rows;
    },

    /**
     * Medicamentos de varias categorias a la vez, para `relatedMedications`.
     *
     * `ROW_NUMBER() OVER (PARTITION BY category_id ...)` limita a 12 por
     * categoria DENTRO de la propia consulta, para no traer las 50 filas
     * completas cuando solo se van a mostrar 4 por medicamento.
     */
    async medicationsByCategoryIds(ids: readonly number[], perCategory = 12) {
      const { rows } = await query<MedicationRow>(
        `SELECT ${MEDICATION_COLUMNS} FROM (
           SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.category_id ORDER BY m.stock DESC, m.id) AS rn
             FROM medications m
            WHERE m.category_id = ANY($1)
         ) m
         WHERE m.rn <= $2`,
        [ids, perCategory],
        meta('DataLoader:medicationsByCategory', ids.length),
      );
      return rows;
    },

    /* ------------------------- Consultas simples ------------------------- */

    async medicationBySku(sku: string) {
      const { rows } = await query<MedicationRow>(
        `SELECT ${MEDICATION_COLUMNS} FROM medications m WHERE m.sku = $1`,
        [sku],
        meta('catalog.medicationBySku'),
      );
      return rows[0] ?? null;
    },

    async allCategories() {
      const { rows } = await query<CategoryRow>(
        `SELECT id, slug, name FROM categories ORDER BY name`,
        [],
        meta('catalog.allCategories'),
      );
      return rows;
    },

    async allManufacturers() {
      const { rows } = await query<ManufacturerRow>(
        `SELECT id, name FROM manufacturers ORDER BY name`,
        [],
        meta('catalog.allManufacturers'),
      );
      return rows;
    },
  };
}

export type CatalogRepository = ReturnType<typeof createCatalogRepository>;
