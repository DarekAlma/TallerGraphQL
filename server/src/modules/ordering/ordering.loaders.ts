/**
 * DataLoaders del carrito.
 *
 * El tipo `Cart` del schema tiene seis campos que se alimentan de los MISMOS
 * datos: `lines`, `itemCount`, `unitsCount`, `subtotal`,
 * `prescriptionRequirements`, `readyForCheckout` y `blockers`.
 *
 * Sin DataLoader, pedir el carrito completo lanzaria una consulta por cada uno
 * de esos campos (7 consultas para pintar un carrito). Con la cache por
 * peticion, la primera lo trae y las seis restantes lo reutilizan: 1 consulta.
 *
 * Es el mismo problema N+1 del catalogo, pero en su variante "varios campos
 * hermanos comparten origen" en lugar de "un campo se repite por cada fila".
 */
import DataLoader from 'dataloader';
import type { CartLineRow, OrderingRepository, PrescriptionRow } from './ordering.repository.js';

/** Agrupa filas por su clave foranea, preservando el orden de las claves. */
function groupBy<T, K extends string>(rows: T[], keyOf: (row: T) => K, keys: readonly K[]): T[][] {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  }
  return keys.map((k) => map.get(k) ?? []);
}

export function createOrderingLoaders(repo: OrderingRepository) {
  return {
    cartLinesByCartId: new DataLoader<string, CartLineRow[]>(async (cartIds) => {
      const rows = await repo.cartLinesByCartIds(cartIds);
      return groupBy(rows, (r) => r.cart_id, cartIds);
    }),

    prescriptionsByCartId: new DataLoader<string, PrescriptionRow[]>(async (cartIds) => {
      const rows = await repo.prescriptionsByCartIds(cartIds);
      return groupBy(rows, (r) => r.cart_id, cartIds);
    }),
  };
}

export type OrderingLoaders = ReturnType<typeof createOrderingLoaders>;
