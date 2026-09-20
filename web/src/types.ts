/**
 * Tipos del contrato GraphQL, escritos a mano.
 *
 * En un proyecto de mayor tamano se generarian automaticamente desde el schema
 * con GraphQL Code Generator. Aqui se declaran a mano y de forma acotada para
 * que el repositorio no dependa de un paso de generacion previo y se pueda
 * clonar y arrancar sin mas.
 *
 * Los nombres replican exactamente los del SDL: cualquier divergencia entre
 * estos tipos y `schema.graphql` seria un error de mantenimiento.
 */

export type DispensingRule = 'OVER_THE_COUNTER' | 'PRESCRIPTION_REQUIRED';
export type StockAvailability = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
export type OrderStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'DISPATCHED' | 'CANCELLED';
export type PrescriptionStatus = 'SUBMITTED' | 'VERIFIED' | 'REJECTED';
export type ProjectionState = 'SYNCED' | 'CATCHING_UP' | 'NOT_FOUND';

export interface Money {
  amount: number;
  currency: string;
  formatted: string;
}

/**
 * Error de dominio. El `__typename` es el discriminador: gracias a el, un
 * `switch` puede acceder con seguridad a los campos propios de cada variante.
 */
export interface DomainError {
  __typename: string;
  code: string;
  message: string;
  field?: string | null;
  // InsufficientStockError
  medicationId?: string;
  medicationName?: string;
  medicationSku?: string;
  requested?: number;
  available?: number;
  // NotFoundError
  entity?: string;
  entityId?: string;
  // ConflictError
  currentState?: string;
  attemptedTransition?: string;
}

export interface Category {
  id: string;
  code: string;
  name: string;
  medicationCount?: number;
}

export interface Manufacturer {
  id: string;
  name: string;
  medicationCount?: number;
}

export interface Medication {
  id: string;
  sku: string;
  name: string;
  activeIngredient?: string;
  dosage?: string;
  presentation: string;
  description?: string | null;
  price: Money;
  category?: Category;
  manufacturer?: Manufacturer;
  dispensingRule?: DispensingRule;
  requiresPrescription: boolean;
  availability: StockAvailability;
  stock: number;
  relatedMedications?: Medication[];
}

export interface MedicationConnection {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Medication[];
  facets?: CatalogFacets;
}

export interface CatalogFacets {
  categories: { count: number; category: Category }[];
  manufacturers: { count: number; manufacturer: Manufacturer }[];
  dispensing: { rule: DispensingRule; count: number }[];
  priceRange: { min: Money; max: Money };
}

export interface Prescription {
  id: string;
  doctorName: string;
  doctorLicense: string;
  issuedAt: string;
  status: PrescriptionStatus;
}

export interface CartLine {
  id: string;
  quantity: number;
  stockWarning: string | null;
  unitPrice: Money;
  subtotal: Money;
  medication: Medication;
}

export interface PrescriptionRequirement {
  satisfied: boolean;
  medication: Pick<Medication, 'id' | 'name' | 'sku'>;
  prescription: Prescription | null;
}

export interface Cart {
  id: string;
  status: 'OPEN' | 'CHECKED_OUT' | 'ABANDONED';
  itemCount: number;
  unitsCount: number;
  readyForCheckout: boolean;
  subtotal: Money;
  lines: CartLine[];
  prescriptionRequirements: PrescriptionRequirement[];
  blockers: DomainError[];
}

export interface ProjectionMetadata {
  state: ProjectionState;
  projectedAt?: string | null;
  lagMs: number;
  lastEventId?: string | null;
  version: number;
  stale: boolean;
}

export interface OrderLine {
  medicationId: string;
  medicationName: string;
  medicationSku: string;
  presentation: string;
  quantity: number;
  requiredPrescription: boolean;
  unitPrice: Money;
  subtotal: Money;
}

export interface OrderProjection {
  __typename: 'OrderProjection';
  id: string;
  orderNumber: string;
  status: OrderStatus;
  itemCount: number;
  unitsCount: number;
  requiresPrescription: boolean;
  cancellationReason: string | null;
  placedAt: string;
  total: Money;
  patient: { id: string; fullName: string; email: string };
  items: OrderLine[];
  prescriptions: {
    medicationId: string;
    medicationName: string;
    doctorName: string;
    doctorLicense: string;
    issuedAt: string;
    status: PrescriptionStatus;
  }[];
  timeline: { event: string; status: OrderStatus; label: string; occurredAt: string; note: string | null }[];
  projection: ProjectionMetadata;
}

export interface OrderProjectionPending {
  __typename: 'OrderProjectionPending';
  orderId: string;
  acknowledgedStatus: OrderStatus;
  message: string;
  retryAfterMs: number;
  projection: ProjectionMetadata;
}

export interface OrderNotFound {
  __typename: 'NotFoundError';
  code: string;
  message: string;
  entity: string;
  entityId: string;
}

/** Union del schema: obliga a tratar los tres desenlaces posibles. */
export type OrderQueryResult = OrderProjection | OrderProjectionPending | OrderNotFound;

export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  unitsCount: number;
  placedAt: string;
  total: Money;
}

/** Payload comun de los comandos: nunca lanza, siempre devuelve errores tipados. */
export interface CommandPayload<K extends string, T> {
  success: boolean;
  errors: DomainError[];
  // La clave del dato varia segun el comando (cart, order, prescription...).
  cart?: Cart | null;
  order?: T | null;
  prescription?: Prescription | null;
  _key?: K;
}
