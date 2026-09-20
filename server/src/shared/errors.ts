/**
 * Fabricas de errores de dominio.
 *
 * Decision de diseno clave del taller:
 *   Un error de NEGOCIO ("no hay stock", "falta la formula medica") NO es una
 *   excepcion. Es un resultado valido del comando, previsto por el dominio.
 *   Por eso se devuelve como DATO tipado dentro del payload, y no lanzando.
 *
 * Solo lanzamos excepciones GraphQL para fallos del TRANSPORTE o de
 * programacion (token ausente en una operacion protegida, caida de la base de
 * datos, etc.), que si son excepcionales.
 *
 * Cada objeto lleva `__typename` explicito para que GraphQL sepa que miembro
 * concreto de la interfaz `DomainError` esta devolviendo.
 */

export type DomainErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'OUT_OF_STOCK'
  | 'INSUFFICIENT_STOCK'
  | 'PRESCRIPTION_REQUIRED'
  | 'PRESCRIPTION_REJECTED'
  | 'CART_EMPTY'
  | 'CART_ALREADY_CHECKED_OUT'
  | 'INVALID_STATE_TRANSITION';

export interface BaseDomainError {
  __typename: string;
  code: DomainErrorCode;
  message: string;
  field?: string | null;
}

export const errors = {
  validation(message: string, field?: string): BaseDomainError {
    return { __typename: 'ValidationError', code: 'VALIDATION_FAILED', message, field: field ?? null };
  },

  notFound(entity: string, entityId: string | number, message?: string) {
    return {
      __typename: 'NotFoundError',
      code: 'NOT_FOUND' as const,
      message: message ?? `No se encontro ${entity} con identificador ${entityId}.`,
      field: null,
      entity,
      entityId: String(entityId),
    };
  },

  unauthenticated(message = 'Debes iniciar sesion para ejecutar esta operacion.') {
    return { __typename: 'AuthError', code: 'UNAUTHENTICATED' as const, message, field: null };
  },

  forbidden(message = 'No tienes permiso sobre este recurso.') {
    return { __typename: 'AuthError', code: 'FORBIDDEN' as const, message, field: null };
  },

  /** El agregado esta en un estado que no admite el comando solicitado. */
  conflict(currentState: string, attemptedTransition: string, message?: string) {
    return {
      __typename: 'ConflictError',
      code: 'INVALID_STATE_TRANSITION' as const,
      message:
        message ??
        `No se puede ejecutar "${attemptedTransition}" sobre una orden en estado ${currentState}.`,
      field: null,
      currentState,
      attemptedTransition,
    };
  },

  cartAlreadyCheckedOut(cartId: string) {
    return {
      __typename: 'ConflictError',
      code: 'CART_ALREADY_CHECKED_OUT' as const,
      message: 'Este carrito ya fue convertido en una orden y no admite cambios.',
      field: 'cartId',
      currentState: 'CHECKED_OUT',
      attemptedTransition: `modificar carrito ${cartId}`,
    };
  },

  cartEmpty() {
    return {
      __typename: 'ValidationError',
      code: 'CART_EMPTY' as const,
      message: 'El carrito no tiene medicamentos. Agrega al menos uno antes de emitir la orden.',
      field: 'cartId',
    };
  },

  /** INVARIANTE DE INVENTARIO. */
  insufficientStock(m: {
    medicationId: number | string;
    medicationName: string;
    medicationSku: string;
    requested: number;
    available: number;
  }) {
    const outOfStock = m.available <= 0;
    return {
      __typename: 'InsufficientStockError',
      code: (outOfStock ? 'OUT_OF_STOCK' : 'INSUFFICIENT_STOCK') as DomainErrorCode,
      message: outOfStock
        ? `"${m.medicationName}" esta agotado en este momento.`
        : `Solo quedan ${m.available} unidades de "${m.medicationName}" y solicitaste ${m.requested}.`,
      field: 'quantity',
      medicationId: String(m.medicationId),
      medicationName: m.medicationName,
      medicationSku: m.medicationSku,
      requested: m.requested,
      available: m.available,
    };
  },

  /** INVARIANTE REGULATORIA. */
  prescriptionRequired(m: {
    medicationId: number | string;
    medicationName: string;
    medicationSku: string;
  }) {
    return {
      __typename: 'PrescriptionRequiredError',
      code: 'PRESCRIPTION_REQUIRED' as const,
      message:
        `"${m.medicationName}" es un medicamento de venta bajo formula medica. ` +
        'Adjunta la prescripcion antes de emitir la orden.',
      field: 'prescriptions',
      medicationId: String(m.medicationId),
      medicationName: m.medicationName,
      medicationSku: m.medicationSku,
    };
  },

  prescriptionRejected(medicationName: string) {
    return {
      __typename: 'ValidationError',
      code: 'PRESCRIPTION_REJECTED' as const,
      message: `La formula medica de "${medicationName}" fue rechazada. Adjunta una valida.`,
      field: 'prescriptions',
    };
  },
};

export type AnyDomainError = ReturnType<(typeof errors)[keyof typeof errors]>;

/**
 * Resolvedor de tipo para la interfaz `DomainError`.
 * GraphQL necesita saber, en tiempo de ejecucion, que tipo concreto devolver.
 * Como cada fabrica ya escribe `__typename`, basta con leerlo.
 */
export const resolveDomainErrorType = (obj: { __typename?: string }) => obj.__typename ?? 'ValidationError';
