/**
 * ============================================================================
 *  OPERACIONES GRAPHQL DEL CLIENTE
 * ============================================================================
 *
 * Todas las operaciones de la aplicacion estan aqui, en un unico archivo, para
 * que el contrato que consume el frontend se pueda revisar de una sentada y
 * contrastar con `schema.graphql`.
 *
 * DOS DECISIONES QUE VALE LA PENA MIRAR CON DETALLE
 * -------------------------------------------------
 *
 * 1. FRAGMENTOS. `MoneyFields`, `DomainErrorFields` y `CartFields` se declaran
 *    una vez y se reutilizan. Cuando el schema evolucione, se toca un sitio.
 *
 * 2. `MEDICATIONS_CONDENSED` frente a `MEDICATIONS_FULL`. Son DOS consultas
 *    contra el MISMO campo `medications`, con distinta seleccion de campos.
 *    Existen para demostrar en vivo la defensa de GraphQL contra el
 *    over-fetching: la pantalla de catalogo alterna entre ambas y en la
 *    pestana Network se ve como la respuesta pasa de unos pocos kilobytes a
 *    varias veces mas, sin cambiar una sola linea del backend.
 *    Bajo REST esto exigiria dos endpoints distintos, o devolver siempre todo.
 */
import { gql } from '@apollo/client';

/* ========================================================================== */
/* FRAGMENTOS REUTILIZABLES                                                   */
/* ========================================================================== */

/** Valor monetario: el servidor entrega el numero Y su formato local. */
export const MONEY_FIELDS = gql`
  fragment MoneyFields on Money {
    amount
    currency
    formatted
  }
`;

/**
 * Errores de dominio.
 *
 * El `... on Tipo` de cada caso permite recoger los campos ESPECIFICOS de cada
 * error. Gracias a esto la interfaz puede ofrecer "ajustar a 12 unidades"
 * cuando faltan existencias, o un boton directo a "adjuntar formula" cuando el
 * problema es regulatorio, en lugar de mostrar siempre el mismo texto generico.
 */
export const DOMAIN_ERROR_FIELDS = gql`
  fragment DomainErrorFields on DomainError {
    __typename
    code
    message
    field
    ... on InsufficientStockError {
      medicationId
      medicationName
      medicationSku
      requested
      available
    }
    ... on PrescriptionRequiredError {
      medicationId
      medicationName
      medicationSku
    }
    ... on NotFoundError {
      entity
      entityId
    }
    ... on ConflictError {
      currentState
      attemptedTransition
    }
  }
`;

/** Estado completo del carrito, incluidos sus bloqueos de checkout. */
export const CART_FIELDS = gql`
  fragment CartFields on Cart {
    id
    status
    itemCount
    unitsCount
    readyForCheckout
    subtotal {
      ...MoneyFields
    }
    lines {
      id
      quantity
      stockWarning
      unitPrice {
        ...MoneyFields
      }
      subtotal {
        ...MoneyFields
      }
      medication {
        id
        sku
        name
        presentation
        dosage
        requiresPrescription
        availability
        stock
      }
    }
    prescriptionRequirements {
      satisfied
      medication {
        id
        name
        sku
      }
      prescription {
        id
        doctorName
        doctorLicense
        issuedAt
        status
      }
    }
    blockers {
      ...DomainErrorFields
    }
  }
  ${MONEY_FIELDS}
  ${DOMAIN_ERROR_FIELDS}
`;

/** Proyeccion completa de una orden (lado lectura). */
export const ORDER_PROJECTION_FIELDS = gql`
  fragment OrderProjectionFields on OrderProjection {
    id
    orderNumber
    status
    itemCount
    unitsCount
    requiresPrescription
    cancellationReason
    placedAt
    total {
      ...MoneyFields
    }
    patient {
      id
      fullName
      email
    }
    items {
      medicationId
      medicationName
      medicationSku
      presentation
      quantity
      requiredPrescription
      unitPrice {
        ...MoneyFields
      }
      subtotal {
        ...MoneyFields
      }
    }
    prescriptions {
      medicationId
      medicationName
      doctorName
      doctorLicense
      issuedAt
      status
    }
    timeline {
      event
      status
      label
      occurredAt
      note
    }
    projection {
      state
      projectedAt
      lagMs
      lastEventId
      version
      stale
    }
  }
  ${MONEY_FIELDS}
`;

/* ========================================================================== */
/* IDENTIDAD                                                                  */
/* ========================================================================== */

/** Login. Sustituye a cualquier `POST /login`: es una Mutation mas. */
export const SIGN_IN = gql`
  mutation SignIn($input: SignInInput!) {
    signIn(input: $input) {
      success
      token
      patient {
        id
        fullName
        email
        documentId
      }
      errors {
        ...DomainErrorFields
      }
    }
  }
  ${DOMAIN_ERROR_FIELDS}
`;

export const ME = gql`
  query Me {
    me {
      id
      fullName
      email
      documentId
    }
  }
`;

/* ========================================================================== */
/* CATALOGO · Escenario A                                                     */
/* ========================================================================== */

/**
 * VISTA CONDENSADA.
 *
 * Exactamente lo que pide la historia de usuario: "nombre, precio,
 * presentacion... sin sobrecargar mi conexion movil con el resto de
 * informacion clinica".
 *
 * Fijese en lo que NO se pide: ni descripcion, ni principio activo, ni
 * laboratorio, ni categoria, ni medicamentos relacionados. Como esos campos no
 * se piden, sus resolvers no se ejecutan y sus DataLoaders no llegan a tocar
 * la base de datos. El ahorro no es de ancho de banda: es de trabajo.
 */
export const MEDICATIONS_CONDENSED = gql`
  query MedicationsCondensed($filter: MedicationFilter, $sort: MedicationSort, $first: Int, $after: String) {
    medications(filter: $filter, sort: $sort, first: $first, after: $after) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        sku
        name
        presentation
        availability
        stock
        requiresPrescription
        price {
          ...MoneyFields
        }
      }
    }
  }
  ${MONEY_FIELDS}
`;

/**
 * VISTA COMPLETA · la misma consulta, pidiendolo todo.
 *
 * Aqui si se piden `category`, `manufacturer` y `relatedMedications`, que son
 * los tres campos que disparan el problema N+1 en el servidor. Ejecutar esta
 * consulta con 12 medicamentos y mirar el log del backend es la demostracion
 * de que DataLoader funciona: en lugar de ~37 consultas, salen 4.
 */
export const MEDICATIONS_FULL = gql`
  query MedicationsFull($filter: MedicationFilter, $sort: MedicationSort, $first: Int, $after: String) {
    medications(filter: $filter, sort: $sort, first: $first, after: $after) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        sku
        name
        activeIngredient
        dosage
        presentation
        description
        dispensingRule
        requiresPrescription
        availability
        stock
        price {
          ...MoneyFields
        }
        category {
          id
          code
          name
          medicationCount
        }
        manufacturer {
          id
          name
          medicationCount
        }
        relatedMedications(limit: 3) {
          id
          name
          presentation
          price {
            ...MoneyFields
          }
        }
      }
    }
  }
  ${MONEY_FIELDS}
`;

/** Facetas del catalogo: conteos reales para el panel de filtros. */
export const CATALOG_FACETS = gql`
  query CatalogFacets($filter: MedicationFilter) {
    medications(filter: $filter, first: 1) {
      totalCount
      facets {
        categories {
          count
          category {
            id
            code
            name
          }
        }
        manufacturers {
          count
          manufacturer {
            id
            name
          }
        }
        dispensing {
          rule
          count
        }
        priceRange {
          min {
            ...MoneyFields
          }
          max {
            ...MoneyFields
          }
        }
      }
    }
  }
  ${MONEY_FIELDS}
`;

/** Ficha detallada de un medicamento (segunda historia del Escenario A). */
export const MEDICATION_DETAIL = gql`
  query MedicationDetail($id: ID!) {
    medication(id: $id) {
      id
      sku
      name
      activeIngredient
      dosage
      presentation
      description
      dispensingRule
      requiresPrescription
      availability
      stock
      price {
        ...MoneyFields
      }
      category {
        id
        code
        name
        medicationCount
      }
      manufacturer {
        id
        name
        medicationCount
      }
      relatedMedications(limit: 4) {
        id
        sku
        name
        presentation
        availability
        requiresPrescription
        price {
          ...MoneyFields
        }
      }
    }
  }
  ${MONEY_FIELDS}
`;

/* ========================================================================== */
/* CARRITO Y COMANDOS · Escenario B                                           */
/* ========================================================================== */

export const ACTIVE_CART = gql`
  query ActiveCart {
    activeCart {
      ...CartFields
    }
  }
  ${CART_FIELDS}
`;

export const CREATE_CART = gql`
  mutation CreateCart($input: CreateCartInput!) {
    createCart(input: $input) {
      success
      cart {
        ...CartFields
      }
      errors {
        ...DomainErrorFields
      }
    }
  }
  ${CART_FIELDS}
  ${DOMAIN_ERROR_FIELDS}
`;

export const ADD_MEDICATION_TO_CART = gql`
  mutation AddMedicationToCart($input: AddMedicationToCartInput!) {
    addMedicationToCart(input: $input) {
      success
      cart {
        ...CartFields
      }
      errors {
        ...DomainErrorFields
      }
    }
  }
  ${CART_FIELDS}
  ${DOMAIN_ERROR_FIELDS}
`;

export const CHANGE_CART_LINE_QUANTITY = gql`
  mutation ChangeCartLineQuantity($input: ChangeCartLineQuantityInput!) {
    changeCartLineQuantity(input: $input) {
      success
      cart {
        ...CartFields
      }
      errors {
        ...DomainErrorFields
      }
    }
  }
  ${CART_FIELDS}
  ${DOMAIN_ERROR_FIELDS}
`;

export const REMOVE_MEDICATION_FROM_CART = gql`
  mutation RemoveMedicationFromCart($input: RemoveMedicationFromCartInput!) {
    removeMedicationFromCart(input: $input) {
      success
      cart {
        ...CartFields
      }
      errors {
        ...DomainErrorFields
      }
    }
  }
  ${CART_FIELDS}
  ${DOMAIN_ERROR_FIELDS}
`;

export const ATTACH_PRESCRIPTION = gql`
  mutation AttachPrescription($input: AttachPrescriptionInput!) {
    attachPrescription(input: $input) {
      success
      prescription {
        id
        doctorName
        doctorLicense
        issuedAt
        status
      }
      cart {
        ...CartFields
      }
      errors {
        ...DomainErrorFields
      }
    }
  }
  ${CART_FIELDS}
  ${DOMAIN_ERROR_FIELDS}
`;

/**
 * COMANDO PRINCIPAL.
 *
 * Observese que la respuesta NO es la orden completa: es un acuse de recibo
 * (`OrderAcknowledgement`) mas el estado de la proyeccion. Eso es CQRS visible
 * desde el cliente: el comando confirma la intencion; los datos para mostrar
 * se piden despues al lado de lectura.
 */
export const PLACE_ORDER = gql`
  mutation PlaceOrder($input: PlaceOrderInput!) {
    placeOrder(input: $input) {
      success
      order {
        id
        orderNumber
        status
        placedAt
        total {
          ...MoneyFields
        }
        projection {
          state
          lagMs
          stale
          version
        }
      }
      errors {
        ...DomainErrorFields
      }
    }
  }
  ${MONEY_FIELDS}
  ${DOMAIN_ERROR_FIELDS}
`;

/* ========================================================================== */
/* PROYECCIONES Y TIEMPO REAL · Escenario C                                   */
/* ========================================================================== */

/**
 * Consulta de la orden proyectada.
 *
 * La union obliga a tratar los tres desenlaces. El caso
 * `OrderProjectionPending` es el que responde a la pregunta del taller: no es
 * un error ni una pantalla en blanco, es un estado con su propio mensaje y su
 * propio tiempo de reintento sugerido.
 */
export const ORDER_QUERY = gql`
  query OrderProjectionQuery($id: UUID!) {
    order(id: $id) {
      __typename
      ... on OrderProjection {
        ...OrderProjectionFields
      }
      ... on OrderProjectionPending {
        orderId
        acknowledgedStatus
        message
        retryAfterMs
        projection {
          state
          lagMs
          stale
          version
        }
      }
      ... on NotFoundError {
        code
        message
        entity
        entityId
      }
    }
  }
  ${ORDER_PROJECTION_FIELDS}
`;

export const MY_ORDERS = gql`
  query MyOrders($first: Int) {
    myOrders(first: $first) {
      id
      orderNumber
      status
      unitsCount
      placedAt
      total {
        ...MoneyFields
      }
    }
  }
  ${MONEY_FIELDS}
`;

export const APPROVE_ORDER = gql`
  mutation ApproveOrder($input: ApproveOrderInput!) {
    approveOrder(input: $input) {
      success
      order {
        id
        status
      }
      errors {
        ...DomainErrorFields
      }
    }
  }
  ${DOMAIN_ERROR_FIELDS}
`;

export const DISPATCH_ORDER = gql`
  mutation DispatchOrder($input: DispatchOrderInput!) {
    dispatchOrder(input: $input) {
      success
      order {
        id
        status
      }
      errors {
        ...DomainErrorFields
      }
    }
  }
  ${DOMAIN_ERROR_FIELDS}
`;

export const CANCEL_ORDER = gql`
  mutation CancelOrder($input: CancelOrderInput!) {
    cancelOrder(input: $input) {
      success
      order {
        id
        status
      }
      errors {
        ...DomainErrorFields
      }
    }
  }
  ${DOMAIN_ERROR_FIELDS}
`;

/**
 * SUBSCRIPTION · seguimiento en tiempo real.
 *
 * El evento trae la proyeccion ya reconstruida. Como `OrderProjection` se
 * normaliza en cache por su `id`, Apollo Client fusiona el dato entrante con
 * el que ya tenia y la pantalla se repinta sola: cero refetch, cero
 * `window.location.reload()`.
 */
export const ORDER_STATUS_SUBSCRIPTION = gql`
  subscription OrderStatusChanged($orderId: UUID!) {
    orderStatusChanged(orderId: $orderId) {
      eventId
      orderId
      orderNumber
      previousStatus
      status
      occurredAt
      reason
      projection {
        ...OrderProjectionFields
      }
    }
  }
  ${ORDER_PROJECTION_FIELDS}
`;

/**
 * SUBSCRIPTION · inventario en vivo.
 * Permite que el catalogo actualice el stock cuando otro paciente compra,
 * sin recargar la pagina.
 */
export const STOCK_SUBSCRIPTION = gql`
  subscription StockChanged {
    stockChanged {
      medicationId
      medicationSku
      medicationName
      previousStock
      stock
      availability
      reason
      occurredAt
    }
  }
`;

/* ========================================================================== */
/* DIAGNOSTICO                                                                */
/* ========================================================================== */

/** Health-check por GraphQL: ni siquiera esto usa REST. */
export const HEALTH = gql`
  query Health {
    health {
      status
      schemaVersion
      database
      medicationsLoaded
      projectionDelayMs
      pendingEvents
      uptimeSeconds
    }
  }
`;
