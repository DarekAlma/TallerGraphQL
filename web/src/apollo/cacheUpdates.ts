/**
 * ============================================================================
 *  ACTUALIZACION DE LA CACHE TRAS CADA COMANDO
 * ============================================================================
 *
 * Regla general: despues de una mutation NO se vuelve a pedir al servidor lo
 * que la propia respuesta ya trae. Se escribe directamente en la cache
 * normalizada y todos los componentes que observan esos datos se repintan.
 *
 * Hay tres niveles, de menos a mas trabajo manual:
 *
 *   1. NORMALIZACION AUTOMATICA. Si la mutation devuelve una entidad con
 *      `__typename` + `id` (p. ej. el `Cart` de `addMedicationToCart`), Apollo
 *      la fusiona sola. No hace falta escribir nada.
 *
 *   2. `update(cache, result)`. Cuando la respuesta afecta a datos que NO
 *      vienen en ella: la raiz `activeCart` pasa de null a un carrito nuevo, o
 *      un carrito deja de estar activo tras `placeOrder`.
 *
 *   3. `optimisticResponse`. La interfaz muestra el resultado esperado antes
 *      de que responda el servidor; cuando llega la respuesta real, la capa
 *      optimista se descarta y se aplica la verdadera (o se revierte si el
 *      comando fue rechazado).
 *
 * Estas funciones viven aqui y no dentro de cada pagina porque varias
 * pantallas ejecutan los mismos comandos (catalogo y ficha abren carrito; la
 * pagina del pedido ejecuta las tres transiciones).
 */
import type { ApolloCache } from '@apollo/client';
import { ACTIVE_CART } from '../graphql/operations';
import type { Cart, Money, OrderStatus } from '../types';

/* -------------------------------------------------------------------------- */
/* Carrito                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `createCart` abre un carrito que la raiz `activeCart` aun no conoce (valia
 * null). La normalizacion no puede adivinar que ese carrito es "el activo",
 * asi que se lo decimos escribiendo la consulta `ActiveCart` con el payload.
 * Sustituye al antiguo `refetchQueries: [ACTIVE_CART]`: un viaje menos.
 */
export function writeActiveCart(cache: ApolloCache, cart: Cart | null | undefined) {
  if (!cart) return;
  cache.writeQuery({ query: ACTIVE_CART, data: { activeCart: cart } });
}

/**
 * Tras `placeOrder` el carrito queda CHECKED_OUT: deja de ser el activo.
 *
 *   · `activeCart` → null: el contador de la barra superior baja a 0 al
 *     instante, sin consultar al servidor.
 *   · El objeto `Cart` se expulsa de la cache (`evict` + `gc`).
 *   · `myOrders` se invalida para que el historial se pida de nuevo al entrar.
 *     No se inserta la orden a mano porque el historial sale del READ MODEL y
 *     la proyeccion aun no existe (consistencia eventual): inventarla en el
 *     cliente seria mostrar algo que el lado de lectura todavia no confirma.
 */
export function closeActiveCart(cache: ApolloCache, cartId: string) {
  cache.modify({
    id: 'ROOT_QUERY',
    fields: {
      activeCart: () => null,
      myOrders: (_value, { DELETE }) => DELETE,
    },
  });
  cache.evict({ id: cache.identify({ __typename: 'Cart', id: cartId }) });
  cache.gc();
}

/* -------------------------------------------------------------------------- */
/* Respuestas optimistas del carrito                                           */
/* -------------------------------------------------------------------------- */

const copFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function money(amount: number, template: Money): Money {
  return { ...template, amount, formatted: copFormatter.format(amount) };
}

/**
 * Carrito tal como deberia quedar tras cambiar la cantidad de una linea.
 *
 * Solo se recalculan los campos aritmeticos (cantidades y totales). Los que
 * dependen de reglas de negocio (`blockers`, `readyForCheckout`) se dejan como
 * estaban: los decide el dominio en el servidor, y la respuesta real los
 * corrige un instante despues. El cliente nunca replica invariantes.
 */
export function optimisticCartWithQuantity(cart: Cart, medicationId: string, quantity: number): Cart {
  const lines = cart.lines.map((line) =>
    line.medication.id === medicationId
      ? { ...line, quantity, subtotal: money(line.unitPrice.amount * quantity, line.subtotal) }
      : line,
  );
  return recalculate(cart, lines);
}

/** Carrito tal como deberia quedar tras retirar un medicamento. */
export function optimisticCartWithout(cart: Cart, medicationId: string): Cart {
  const lines = cart.lines.filter((line) => line.medication.id !== medicationId);
  return {
    ...recalculate(cart, lines),
    prescriptionRequirements: cart.prescriptionRequirements.filter((r) => r.medication.id !== medicationId),
  };
}

function recalculate(cart: Cart, lines: Cart['lines']): Cart {
  return {
    ...cart,
    lines,
    itemCount: lines.length,
    unitsCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotal: money(
      lines.reduce((sum, line) => sum + line.unitPrice.amount * line.quantity, 0),
      cart.subtotal,
    ),
  };
}

/** Envuelve el carrito optimista con la forma de `CartCommandPayload`. */
export function optimisticCartPayload(field: string, cart: Cart) {
  return {
    [field]: { __typename: 'CartCommandPayload', success: true, cart, errors: [] },
  };
}

/* -------------------------------------------------------------------------- */
/* Transiciones de la orden                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `approveOrder`, `dispatchOrder` y `cancelOrder` devuelven un ACUSE
 * (`OrderAcknowledgement`), no la proyeccion: es CQRS. Por eso Apollo no puede
 * fusionarlo solo con la `OrderProjection` que esta en pantalla (son tipos
 * distintos).
 *
 * Lo que si sabemos con certeza es el nuevo estado confirmado por el write
 * model. Se escribe en la proyeccion en cache y se marca como
 * `CATCHING_UP / stale`: la interfaz cambia el estado al instante y muestra
 * "poniendose al dia" hasta que la Subscription entregue la proyeccion
 * reconstruida, que reemplaza estos valores por los definitivos.
 */
export function applyOrderTransition(
  cache: ApolloCache,
  ack: { id: string; status: OrderStatus } | null | undefined,
) {
  if (!ack) return;

  cache.modify({
    id: cache.identify({ __typename: 'OrderProjection', id: ack.id }),
    fields: {
      status: () => ack.status,
      projection: (existing: any) => (existing ? { ...existing, state: 'CATCHING_UP', stale: true } : existing),
    },
  });

  // El mismo pedido puede estar tambien en el listado "Mis pedidos".
  cache.modify({
    id: cache.identify({ __typename: 'OrderSummary', id: ack.id }),
    fields: { status: () => ack.status },
  });
}
