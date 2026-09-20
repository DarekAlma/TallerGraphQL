/**
 * ============================================================================
 *  MITIGACION DEL PROBLEMA N+1 · DataLoaders del catalogo
 * ============================================================================
 *
 * EL PROBLEMA
 * -----------
 * GraphQL resuelve campo por campo. Esta consulta, perfectamente normal:
 *
 *     query { medications(first: 12) { nodes { name category { name } } } }
 *
 * hace que el servidor ejecute:
 *     1 consulta  → los 12 medicamentos
 *   + 12 consultas → la categoria de CADA medicamento, una por una
 *   = 13 viajes a Supabase para pintar una sola pantalla.
 *
 * Con `manufacturer` ademas de `category` serian 25. Con `relatedMedications`
 * encima, 37. Eso es el problema N+1, y en una red movil con 12 pacientes
 * concurrentes tumba el servicio.
 *
 * LA SOLUCION
 * -----------
 * DataLoader hace dos cosas, ambas por peticion HTTP:
 *
 *   1. BATCHING. En lugar de ejecutar cada `load(id)` al instante, los acumula
 *      durante el tick actual del event loop de Node y al final llama UNA sola
 *      vez a la funcion de lote con todas las claves:
 *          SELECT ... WHERE id = ANY($1)   -- $1 = [3, 7, 7, 11, 3, ...]
 *
 *   2. CACHE POR PETICION. Si dos medicamentos comparten categoria, esa
 *      categoria se pide UNA vez. La cache se destruye al terminar la
 *      peticion, asi que nunca se sirven datos obsoletos entre usuarios.
 *
 * Resultado: 13 consultas → 2. Y con manufacturer + related: 37 → 4.
 *
 * REGLA CRITICA
 * -------------
 * Los loaders se crean DENTRO de `createContext()`, es decir, uno nuevo por
 * cada peticion. Si fueran globales, la cache sobreviviria entre usuarios y
 * un paciente podria ver el stock que ya cambio para otro.
 *
 * CONTRATO DE DataLoader
 * ----------------------
 * La funcion de lote DEBE devolver un array del mismo tamano y EN EL MISMO
 * ORDEN que las claves recibidas. Como SQL no garantiza el orden de `ANY()`,
 * indexamos el resultado en un Map y reordenamos. Omitir esto produce bugs
 * silenciosos en los que un medicamento muestra la categoria de otro.
 */
import DataLoader from 'dataloader';
import type { CatalogRepository, CategoryRow, ManufacturerRow, MedicationRow } from './catalog.repository.js';

/** Reordena las filas para que coincidan 1:1 con las claves solicitadas. */
function indexBy<K extends string | number, T>(
  rows: T[],
  keyOf: (row: T) => K,
  keys: readonly K[],
): (T | null)[] {
  const map = new Map<K, T>();
  for (const row of rows) map.set(keyOf(row), row);
  return keys.map((k) => map.get(k) ?? null);
}

export function createCatalogLoaders(repo: CatalogRepository) {
  return {
    /** id de medicamento → ficha. */
    medicationById: new DataLoader<number, MedicationRow | null>(async (ids) => {
      const rows = await repo.medicationsByIds(ids);
      return indexBy(rows, (r) => r.id, ids);
    }),

    /** id de categoria → categoria. Es el loader que mata el N+1 del listado. */
    categoryById: new DataLoader<number, CategoryRow | null>(async (ids) => {
      const rows = await repo.categoriesByIds(ids);
      return indexBy(rows, (r) => r.id, ids);
    }),

    /** id de laboratorio → laboratorio. */
    manufacturerById: new DataLoader<number, ManufacturerRow | null>(async (ids) => {
      const rows = await repo.manufacturersByIds(ids);
      return indexBy(rows, (r) => r.id, ids);
    }),

    /**
     * id de categoria → cuantos medicamentos tiene.
     * Pintar el panel de filtros con las 14 categorias y su conteo ejecuta
     * 1 consulta de categorias + 1 de conteos. Sin loaders serian 15.
     */
    medicationCountByCategory: new DataLoader<number, number>(async (ids) => {
      const rows = await repo.medicationCountByCategoryIds(ids);
      const map = new Map(rows.map((r) => [r.category_id, r.count]));
      return ids.map((id) => map.get(id) ?? 0);
    }),

    medicationCountByManufacturer: new DataLoader<number, number>(async (ids) => {
      const rows = await repo.medicationCountByManufacturerIds(ids);
      const map = new Map(rows.map((r) => [r.manufacturer_id, r.count]));
      return ids.map((id) => map.get(id) ?? 0);
    }),

    /**
     * id de categoria → medicamentos de esa categoria.
     * Alimenta `Medication.relatedMedications`, un resolver ANIDADO DE SEGUNDO
     * NIVEL. Aqui el batching importa aun mas: 12 medicamentos de 5 categorias
     * distintas se resuelven con 1 consulta, no con 12.
     */
    medicationsByCategory: new DataLoader<number, MedicationRow[]>(async (ids) => {
      const rows = await repo.medicationsByCategoryIds(ids);
      const map = new Map<number, MedicationRow[]>();
      for (const row of rows) {
        const list = map.get(row.category_id);
        if (list) list.push(row);
        else map.set(row.category_id, [row]);
      }
      return ids.map((id) => map.get(id) ?? []);
    }),
  };
}

export type CatalogLoaders = ReturnType<typeof createCatalogLoaders>;
