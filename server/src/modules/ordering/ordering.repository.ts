/**
 * ORDERING · Lecturas del modelo de ESCRITURA.
 *
 * Ojo con el matiz de CQRS: estas consultas NO son "el lado de lectura".
 * El lado de lectura del taller es `order_read_model` (las proyecciones).
 *
 * Lo que hay aqui son las lecturas que necesita el propio lado de escritura
 * para poder decidir: cargar el carrito antes de validarlo, recuperar una
 * orden antes de cambiarle el estado. Es "leer para escribir", no "leer para
 * mostrar". Por eso viven en el modulo de ordering y no en projections.
 *
 * La unica excepcion deliberada es el carrito, que el schema si expone como
 * lectura: un carrito es un borrador del propio usuario, se consulta con el
 * mismo dato que se escribe y no tendria sentido proyectarlo.
 */
import { query, type SqlStats } from '../../db/pool.js';

export interface CartRow {
  id: string;
  patient_id: string;
  status: 'OPEN' | 'CHECKED_OUT' | 'ABANDONED';
  created_at: Date;
  updated_at: Date;
}

export interface CartLineRow {
  id: string;
  cart_id: string;
  medication_id: number;
  quantity: number;
  unit_price_cop: number;
  /* Campos traidos del catalogo mediante JOIN, para evaluar invariantes. */
  medication_name: string;
  medication_sku: string;
  presentation: string;
  stock: number;
  requires_prescription: boolean;
  current_price: number;
}

export interface PrescriptionRow {
  id: string;
  cart_id: string;
  medication_id: number;
  doctor_name: string;
  doctor_license: string;
  issued_at: string;
  document_url: string | null;
  status: 'SUBMITTED' | 'VERIFIED' | 'REJECTED';
  created_at: Date;
}

export interface OrderRow {
  id: string;
  order_number: string;
  patient_id: string;
  cart_id: string;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'DISPATCHED' | 'CANCELLED';
  total_cop: number;
  requires_prescription: boolean;
  cancellation_reason: string | null;
  version: number;
  placed_at: Date;
  updated_at: Date;
}

/**
 * SQL reutilizado para traer las lineas del carrito ya enriquecidas con el
 * estado vivo del catalogo. Un solo JOIN evita el N+1 aqui mismo: no pedimos
 * el carrito y luego cada medicamento por separado.
 */
const CART_LINES_SQL = `
  SELECT ci.id, ci.cart_id, ci.medication_id, ci.quantity, ci.unit_price_cop,
         m.name                  AS medication_name,
         m.sku                   AS medication_sku,
         m.presentation          AS presentation,
         m.stock                 AS stock,
         m.requires_prescription AS requires_prescription,
         m.price_cop             AS current_price
    FROM cart_items ci
    JOIN medications m ON m.id = ci.medication_id
   WHERE ci.cart_id = $1
   ORDER BY ci.added_at
`;

export function createOrderingRepository(stats?: SqlStats) {
  const meta = (label: string) => ({ label, stats });

  return {
    async findCart(cartId: string): Promise<CartRow | null> {
      const { rows } = await query<CartRow>(
        `SELECT id, patient_id, status, created_at, updated_at FROM carts WHERE id = $1`,
        [cartId],
        meta('ordering.findCart'),
      );
      return rows[0] ?? null;
    },

    async findOpenCartByPatient(patientId: string): Promise<CartRow | null> {
      const { rows } = await query<CartRow>(
        `SELECT id, patient_id, status, created_at, updated_at
           FROM carts WHERE patient_id = $1 AND status = 'OPEN'
          ORDER BY created_at DESC LIMIT 1`,
        [patientId],
        meta('ordering.findOpenCart'),
      );
      return rows[0] ?? null;
    },

    async cartLines(cartId: string): Promise<CartLineRow[]> {
      const { rows } = await query<CartLineRow>(CART_LINES_SQL, [cartId], meta('ordering.cartLines'));
      return rows;
    },

    async prescriptionsByCart(cartId: string): Promise<PrescriptionRow[]> {
      const { rows } = await query<PrescriptionRow>(
        `SELECT id, cart_id, medication_id, doctor_name, doctor_license,
                to_char(issued_at, 'YYYY-MM-DD') AS issued_at,
                document_url, status, created_at
           FROM prescriptions WHERE cart_id = $1 ORDER BY created_at`,
        [cartId],
        meta('ordering.prescriptionsByCart'),
      );
      return rows;
    },

    /* ------------------- Cargas por lotes (DataLoader) ------------------- */

    /**
     * Lineas de VARIOS carritos en una sola consulta.
     * Aunque una pantalla suele mostrar un unico carrito, exponerlo como lote
     * da la cache por peticion de DataLoader gratis: `Cart.lines`,
     * `Cart.subtotal`, `Cart.readyForCheckout` y `Cart.blockers` necesitan las
     * MISMAS lineas, y sin loader cada campo dispararia su propia consulta.
     */
    async cartLinesByCartIds(cartIds: readonly string[]): Promise<CartLineRow[]> {
      const { rows } = await query<CartLineRow>(
        `SELECT ci.id, ci.cart_id, ci.medication_id, ci.quantity, ci.unit_price_cop,
                m.name                  AS medication_name,
                m.sku                   AS medication_sku,
                m.presentation          AS presentation,
                m.stock                 AS stock,
                m.requires_prescription AS requires_prescription,
                m.price_cop             AS current_price
           FROM cart_items ci
           JOIN medications m ON m.id = ci.medication_id
          WHERE ci.cart_id = ANY($1)
          ORDER BY ci.added_at`,
        [cartIds],
        { label: 'DataLoader:cartLinesByCartId', batchKeys: cartIds.length, stats },
      );
      return rows;
    },

    async prescriptionsByCartIds(cartIds: readonly string[]): Promise<PrescriptionRow[]> {
      const { rows } = await query<PrescriptionRow>(
        `SELECT id, cart_id, medication_id, doctor_name, doctor_license,
                to_char(issued_at, 'YYYY-MM-DD') AS issued_at,
                document_url, status, created_at
           FROM prescriptions WHERE cart_id = ANY($1) ORDER BY created_at`,
        [cartIds],
        { label: 'DataLoader:prescriptionsByCartId', batchKeys: cartIds.length, stats },
      );
      return rows;
    },

    async findOrder(orderId: string): Promise<OrderRow | null> {
      const { rows } = await query<OrderRow>(
        `SELECT id, order_number, patient_id, cart_id, status, total_cop,
                requires_prescription, cancellation_reason, version, placed_at, updated_at
           FROM orders WHERE id = $1`,
        [orderId],
        meta('ordering.findOrder'),
      );
      return rows[0] ?? null;
    },

    /** Cuantos eventos de dominio siguen sin proyectar (diagnostico de `health`). */
    async pendingEventCount(): Promise<number> {
      const { rows } = await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM domain_events WHERE processed_at IS NULL`,
        [],
        meta('ordering.pendingEvents'),
      );
      return rows[0]?.count ?? 0;
    },
  };
}

export type OrderingRepository = ReturnType<typeof createOrderingRepository>;

/** SQL de lineas de carrito, reutilizado tambien dentro de las transacciones. */
export { CART_LINES_SQL };
