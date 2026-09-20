/**
 * ORDERING · Resolvers del lado de ESCRITURA (comandos) y del carrito.
 *
 * Los resolvers de Mutation son deliberadamente finos: autorizan, delegan en
 * el manejador de comando correspondiente y traducen su resultado al payload
 * del schema. Ni una sola regla de negocio vive aqui; todas estan en
 * `ordering.domain.ts` y `ordering.commands.ts`.
 *
 * Esa delgadez es lo que hace que el dominio sea reutilizable: si manana el
 * mismo comando se disparara desde una cola de mensajes o una tarea
 * programada, no habria que reescribir nada.
 */
import { errors, type AnyDomainError } from '../../shared/errors.js';
import { money } from '../../shared/money.js';
import { evaluateCheckout, type EvaluableLine } from './ordering.domain.js';
import * as commands from './ordering.commands.js';
import { commitTimeOf } from '../projections/order.projector.js';
import type { GraphQLContext } from '../../graphql/context.js';
import type { CartLineRow, CartRow, PrescriptionRow } from './ordering.repository.js';

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                  */
/* -------------------------------------------------------------------------- */

/** Payload de fallo por falta de sesion, con la forma que espera cada mutation. */
const unauthenticated = (extra: Record<string, unknown> = {}) => ({
  success: false,
  errors: [errors.unauthenticated()],
  ...extra,
});

function toEvaluableLines(rows: CartLineRow[]): EvaluableLine[] {
  return rows.map((r) => ({
    medicationId: r.medication_id,
    medicationName: r.medication_name,
    medicationSku: r.medication_sku,
    presentation: r.presentation,
    quantity: r.quantity,
    unitPrice: Number(r.unit_price_cop),
    stock: r.stock,
    requiresPrescription: r.requires_prescription,
  }));
}

/**
 * Invalida la cache de DataLoader de un carrito tras mutarlo.
 *
 * Es un detalle facil de olvidar y con consecuencias visibles: la cache de
 * DataLoader vive durante toda la peticion, asi que si el resolver de la
 * mutation ya habia leido las lineas ANTES de escribir, devolveria el carrito
 * viejo en la respuesta. Limpiarla garantiza que el payload refleje el estado
 * posterior al comando.
 */
function invalidateCart(ctx: GraphQLContext, cartId: string) {
  ctx.loaders.cartLinesByCartId.clear(cartId);
  ctx.loaders.prescriptionsByCartId.clear(cartId);
}

/** Traduce el acuse de recibo del comando al tipo `OrderAcknowledgement`. */
function toAcknowledgement(ack: commands.OrderAcknowledgement) {
  return {
    id: ack.id,
    orderNumber: ack.orderNumber,
    status: ack.status,
    total: money(ack.total),
    placedAt: ack.placedAt,
    // En el instante del acuse la proyeccion AUN NO existe: el comando acaba
    // de confirmar y el proyector esta agendado. Decirlo explicitamente es
    // mas honesto que devolver datos que todavia no son ciertos.
    projection: {
      state: 'CATCHING_UP',
      projectedAt: null,
      lagMs: 0,
      lastEventId: null,
      version: ack.version,
      stale: true,
    },
  };
}

/** Recupera el carrito para devolverlo dentro del payload de un comando. */
async function cartPayload(ctx: GraphQLContext, cartId: string) {
  invalidateCart(ctx, cartId);
  return ctx.repos.ordering.findCart(cartId);
}

/* -------------------------------------------------------------------------- */
/* Resolvers                                                                   */
/* -------------------------------------------------------------------------- */

export const orderingResolvers = {
  Query: {
    async cart(_: unknown, args: { id: string }, ctx: GraphQLContext) {
      const cart = await ctx.repos.ordering.findCart(args.id);
      if (!cart) return null;
      // Un carrito ajeno se comporta como inexistente: no confirmamos ni
      // desmentimos su existencia a quien no es su dueno.
      if (cart.patient_id !== ctx.auth.patientId) return null;
      return cart;
    },

    activeCart(_: unknown, __: unknown, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return null;
      return ctx.repos.ordering.findOpenCartByPatient(ctx.auth.patientId);
    },
  },

  /* ====================== COMANDOS ====================== */
  Mutation: {
    async createCart(_: unknown, args: { input: any }, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return unauthenticated({ cart: null });
      const result = await commands.createCart(args.input ?? {}, ctx.auth.patientId);
      return {
        success: result.success,
        cart: result.data ? await cartPayload(ctx, result.data) : null,
        errors: result.errors,
      };
    },

    async addMedicationToCart(_: unknown, args: { input: any }, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return unauthenticated({ cart: null });
      const result = await commands.addMedicationToCart(args.input, ctx.auth.patientId);
      return {
        success: result.success,
        cart: result.data ? await cartPayload(ctx, result.data) : null,
        errors: result.errors,
      };
    },

    async changeCartLineQuantity(_: unknown, args: { input: any }, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return unauthenticated({ cart: null });
      const result = await commands.changeCartLineQuantity(args.input, ctx.auth.patientId);
      return {
        success: result.success,
        cart: result.data ? await cartPayload(ctx, result.data) : null,
        errors: result.errors,
      };
    },

    async removeMedicationFromCart(_: unknown, args: { input: any }, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return unauthenticated({ cart: null });
      const result = await commands.removeMedicationFromCart(args.input, ctx.auth.patientId);
      return {
        success: result.success,
        cart: result.data ? await cartPayload(ctx, result.data) : null,
        errors: result.errors,
      };
    },

    async attachPrescription(_: unknown, args: { input: any }, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return unauthenticated({ cart: null, prescription: null });
      const result = await commands.attachPrescription(args.input, ctx.auth.patientId);

      if (!result.success || !result.data) {
        return { success: false, cart: null, prescription: null, errors: result.errors };
      }

      invalidateCart(ctx, result.data.cartId);
      const prescriptions = await ctx.loaders.prescriptionsByCartId.load(result.data.cartId);

      return {
        success: true,
        cart: await ctx.repos.ordering.findCart(result.data.cartId),
        prescription: prescriptions.find((p) => p.id === result.data!.prescriptionId) ?? null,
        errors: [],
      };
    },

    /** Comando principal. Ver `ordering.commands.ts` para la transaccion. */
    async placeOrder(_: unknown, args: { input: any }, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return unauthenticated({ order: null });
      const result = await commands.placeOrder(args.input, ctx.auth.patientId);

      if (result.success) {
        // El stock acaba de cambiar: purgamos la cache del catalogo para que
        // cualquier campo que se resuelva despues en ESTA misma peticion lea
        // las existencias reales y no las de hace un instante.
        ctx.loaders.medicationById.clearAll();
        invalidateCart(ctx, args.input.cartId);
      }

      return {
        success: result.success,
        order: result.data ? toAcknowledgement(result.data) : null,
        errors: result.errors,
      };
    },

    async approveOrder(_: unknown, args: { input: any }, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return unauthenticated({ order: null });
      const result = await commands.approveOrder(args.input, ctx.auth.patientId);
      return {
        success: result.success,
        order: result.data ? toAcknowledgement(result.data) : null,
        errors: result.errors,
      };
    },

    async dispatchOrder(_: unknown, args: { input: any }, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return unauthenticated({ order: null });
      const result = await commands.dispatchOrder(args.input, ctx.auth.patientId);
      return {
        success: result.success,
        order: result.data ? toAcknowledgement(result.data) : null,
        errors: result.errors,
      };
    },

    async cancelOrder(_: unknown, args: { input: any }, ctx: GraphQLContext) {
      if (!ctx.auth.patientId) return unauthenticated({ order: null });
      const result = await commands.cancelOrder(args.input, ctx.auth.patientId);
      if (result.success) ctx.loaders.medicationById.clearAll();
      return {
        success: result.success,
        order: result.data ? toAcknowledgement(result.data) : null,
        errors: result.errors,
      };
    },
  },

  /* ====================== TIPOS DEL CARRITO ====================== */
  Cart: {
    patient: async (cart: CartRow, _: unknown, ctx: GraphQLContext) => {
      const patient = await ctx.repos.identity.findById(cart.patient_id);
      return patient
        ? { id: patient.id, fullName: patient.full_name, email: patient.email }
        : { id: cart.patient_id, fullName: 'Desconocido', email: '' };
    },

    lines: (cart: CartRow, _: unknown, ctx: GraphQLContext) =>
      ctx.loaders.cartLinesByCartId.load(cart.id),

    itemCount: async (cart: CartRow, _: unknown, ctx: GraphQLContext) =>
      (await ctx.loaders.cartLinesByCartId.load(cart.id)).length,

    unitsCount: async (cart: CartRow, _: unknown, ctx: GraphQLContext) =>
      (await ctx.loaders.cartLinesByCartId.load(cart.id)).reduce((s, l) => s + l.quantity, 0),

    subtotal: async (cart: CartRow, _: unknown, ctx: GraphQLContext) => {
      const lines = await ctx.loaders.cartLinesByCartId.load(cart.id);
      return money(lines.reduce((s, l) => s + l.quantity * Number(l.unit_price_cop), 0));
    },

    /** Que formulas medicas exige el contenido actual, y cuales ya estan. */
    prescriptionRequirements: async (cart: CartRow, _: unknown, ctx: GraphQLContext) => {
      const [lines, prescriptions] = await Promise.all([
        ctx.loaders.cartLinesByCartId.load(cart.id),
        ctx.loaders.prescriptionsByCartId.load(cart.id),
      ]);
      const byMedication = new Map(prescriptions.map((p) => [p.medication_id, p]));

      return lines
        .filter((l) => l.requires_prescription)
        .map((l) => {
          const prescription = byMedication.get(l.medication_id);
          return {
            medicationId: l.medication_id,
            satisfied: !!prescription && prescription.status !== 'REJECTED',
            prescription: prescription ?? null,
          };
        });
    },

    /**
     * `readyForCheckout` y `blockers` ejecutan EXACTAMENTE la misma funcion de
     * dominio que usara despues el comando `placeOrder`.
     *
     * Esto no es duplicacion, es lo contrario: una sola definicion de las
     * reglas, consultable desde el lado de lectura. La UI puede deshabilitar
     * el boton y explicar por que, sabiendo que el veredicto coincidira con el
     * del comando porque es literalmente el mismo codigo.
     */
    readyForCheckout: async (cart: CartRow, _: unknown, ctx: GraphQLContext) => {
      if (cart.status !== 'OPEN') return false;
      const [lines, prescriptions] = await Promise.all([
        ctx.loaders.cartLinesByCartId.load(cart.id),
        ctx.loaders.prescriptionsByCartId.load(cart.id),
      ]);
      return evaluateCheckout(
        toEvaluableLines(lines),
        prescriptions.map((p) => ({ medicationId: p.medication_id, status: p.status })),
      ).ok;
    },

    blockers: async (cart: CartRow, _: unknown, ctx: GraphQLContext): Promise<AnyDomainError[]> => {
      if (cart.status !== 'OPEN') return [errors.cartAlreadyCheckedOut(cart.id)];
      const [lines, prescriptions] = await Promise.all([
        ctx.loaders.cartLinesByCartId.load(cart.id),
        ctx.loaders.prescriptionsByCartId.load(cart.id),
      ]);
      return evaluateCheckout(
        toEvaluableLines(lines),
        prescriptions.map((p) => ({ medicationId: p.medication_id, status: p.status })),
      ).errors;
    },

    createdAt: (cart: CartRow) => cart.created_at,
    updatedAt: (cart: CartRow) => cart.updated_at,
  },

  CartLine: {
    medication: (line: CartLineRow, _: unknown, ctx: GraphQLContext) =>
      ctx.loaders.medicationById.load(line.medication_id),

    unitPrice: (line: CartLineRow) => money(line.unit_price_cop),
    subtotal: (line: CartLineRow) => money(line.quantity * Number(line.unit_price_cop)),

    /**
     * Aviso temprano de consistencia: el precio se congelo al agregar, pero el
     * stock es el de ahora mismo. Si cayo por debajo de lo pedido, el paciente
     * lo ve en el carrito antes de intentar pagar.
     */
    stockWarning: (line: CartLineRow) => {
      if (line.stock <= 0) return 'Agotado. Retira este medicamento para continuar.';
      if (line.stock < line.quantity) return `Solo quedan ${line.stock} unidades disponibles.`;
      if (line.stock <= 30) return `Últimas ${line.stock} unidades en bodega.`;
      return null;
    },
  },

  PrescriptionRequirement: {
    medication: (req: { medicationId: number }, _: unknown, ctx: GraphQLContext) =>
      ctx.loaders.medicationById.load(req.medicationId),
  },

  Prescription: {
    medication: (p: PrescriptionRow, _: unknown, ctx: GraphQLContext) =>
      ctx.loaders.medicationById.load(p.medication_id),
    doctorName: (p: PrescriptionRow) => p.doctor_name,
    doctorLicense: (p: PrescriptionRow) => p.doctor_license,
    issuedAt: (p: PrescriptionRow) => p.issued_at,
    documentUrl: (p: PrescriptionRow) => p.document_url,
    createdAt: (p: PrescriptionRow) => p.created_at,
  },

  OrderAcknowledgement: {
    /**
     * Recalcula el estado de la proyeccion en el momento de responder.
     * Entre que el comando confirmo y GraphQL serializa la respuesta pueden
     * haber pasado milisegundos suficientes para que el proyector ya termine.
     */
    projection: async (ack: any, _: unknown, ctx: GraphQLContext) => {
      const projection = await ctx.repos.projections.findByOrderId(ack.id);
      if (!projection) return ack.projection;

      const committedAt = commitTimeOf(ack.id);
      return {
        state: 'SYNCED',
        projectedAt: projection.projected_at,
        lagMs: committedAt ? Math.max(0, projection.projected_at.getTime() - committedAt) : 0,
        lastEventId: projection.last_event_id,
        version: projection.version,
        stale: false,
      };
    },
  },
};
