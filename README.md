# Afirmative Pill · Arquitectura GraphQL + CQRS

E-commerce farmacéutico construido para el taller práctico de **Patrones
Arquitectónicos**. Resuelve los tres escenarios del enunciado bajo dos
restricciones no negociables: **cero endpoints REST** y **separación estricta
entre lecturas y escrituras (CQRS)**, con persistencia en **PostgreSQL alojado
en Supabase**.

```
React 18 + Apollo Client  ──POST /graphql──▶  Apollo Server 5  ──▶  Supabase
        (Vite)            ──ws:// /graphql─▶  (Node 20 + TS)         PostgreSQL
```

| | |
|---|---|
| **Backend** | Apollo Server 5 · Express 5 · TypeScript · DataLoader · graphql-ws |
| **Frontend** | React 18 · Apollo Client 4 · Vite 6 · React Router |
| **Base de datos** | PostgreSQL 16 en Supabase, accedida con el driver nativo `pg` |
| **Dataset** | Los 50 medicamentos reales provistos por el taller |

---

## Índice

1. [Qué es esto y qué problema resuelve](#1-qué-es-esto-y-qué-problema-resuelve)
2. [Puesta en marcha](#2-puesta-en-marcha)
3. [Diagrama de arquitectura](#3-diagrama-de-arquitectura)
4. [El schema SDL](#4-el-schema-sdl)
5. [Cómo se aplicó CQRS](#5-cómo-se-aplicó-cqrs)
6. [Cómo se mitigó el problema N+1](#6-cómo-se-mitigó-el-problema-n1)
7. [Cumplimiento del mandato Zero-REST](#7-cumplimiento-del-mandato-zero-rest)
8. [Consistencia eventual: qué ve el usuario mientras tanto](#8-consistencia-eventual-qué-ve-el-usuario-mientras-tanto)
9. [El frontend y la caché de Apollo](#9-el-frontend-y-la-caché-de-apollo)
10. [Decisiones de diseño y sus porqués](#10-decisiones-de-diseño-y-sus-porqués)
11. [Mapa del repositorio](#11-mapa-del-repositorio)
12. [Verificación](#12-verificación)

---

## 1. Qué es esto y qué problema resuelve

Afirmative Pill vende medicamentos en línea. Eso suena a e-commerce corriente,
pero el enunciado plantea cuatro tensiones que un CRUD normal no resuelve bien:

| Tensión del enunciado | Cómo la resuelve este proyecto |
|---|---|
| **Unos medicamentos son de venta libre y otros exigen fórmula médica verificada.** Vender mal tiene consecuencias legales. | Una invariante de dominio evaluada **dentro de la transacción**. El comando `placeOrder` rechaza el pedido con un error tipado `PrescriptionRequiredError` que dice exactamente qué medicamento y qué falta. |
| **El inventario debe reservarse de forma atómica.** Vender lo que no hay es inaceptable. | `SELECT ... FOR UPDATE` sobre las filas de inventario, descuento con guarda `stock >= cantidad` y `CHECK (stock >= 0)` en la propia tabla. Tres capas de defensa, todas dentro de un `BEGIN/COMMIT`. |
| **Las fichas técnicas son pesadas y las redes móviles lentas.** REST provoca over-fetching. | GraphQL con selección de campos. El listado pide 6 campos y la ficha pide 20: misma API, mismo resolver, respuestas de tamaño radicalmente distinto. |
| **El catálogo tiene millones de lecturas; el pago y la validación son escrituras complejas.** | CQRS: modelos, tablas y rutas de código separados para leer y para escribir. |

El objetivo de la herramienta no es «vender pastillas»: es **demostrar que estas
cuatro tensiones se resuelven con decisiones de arquitectura**, no con parches.

---

## 2. Puesta en marcha

### Requisitos

- **Node.js 20 o superior** (`node -v` para comprobarlo)
- Una cuenta gratuita de **Supabase**

### Paso 1 · Base de datos

Sigue **[docs/GUIA-SUPABASE.md](docs/GUIA-SUPABASE.md)**. Es una guía detallada
que va desde crear la cuenta hasta verificar que los 50 medicamentos están
cargados. Resumen:

```bash
# En el SQL Editor de Supabase, ejecutar en este orden:
#   db/01_schema.sql        → tablas, índices y extensiones
#   db/02_seed_catalog.sql  → los 50 medicamentos (50 / 14 / 16 / 27)
#   db/03_seed_patients.sql → 3 pacientes de demostración
```

### Paso 2 · Backend

```bash
cd server
npm install
cp .env.example .env     # y pega tu DATABASE_URL de Supabase
npm run db:check         # verifica la conexión: debe decir "medicamentos ... 50"
npm run dev
```

El servidor queda en **<http://localhost:4000/graphql>**. Abrir esa URL en el
navegador muestra **Apollo Sandbox**, donde se puede explorar el schema y
ejecutar operaciones a mano.

### Paso 3 · Frontend

En otra terminal:

```bash
cd web
npm install
npm run dev
```

La aplicación queda en **<http://localhost:5173>**.

### Paso 4 · Entrar

| Correo | Contraseña |
|---|---|
| `ana.gomez@correo.com` | `afirmative123` |
| `carlos.rueda@correo.com` | `afirmative123` |
| `lucia.mendez@correo.com` | `afirmative123` |

### Reiniciar la demo

```bash
npm run db:setup --prefix server
```

Devuelve el catálogo y el stock a su estado original. Es idempotente.

---

## 3. Diagrama de arquitectura

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  NAVEGADOR                                                                    │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐     │
│   │  <ApolloProvider>          ← árbol de contexto en la raíz de React   │     │
│   │                                                                     │     │
│   │   Catálogo   Ficha   Carrito   Pedido        InMemoryCache          │     │
│   │  useQuery  useQuery useMutation useSubscription   (normalizada       │     │
│   │      │        │         │            │            por __typename+id) │     │
│   │      └────────┴─────────┴────────────┘                              │     │
│   │                      │                                              │     │
│   │        errorLink → authLink → auditLink → split(tipo de operación)   │     │
│   │                                            │           │            │     │
│   └────────────────────────────────────────────┼───────────┼────────────┘     │
└────────────────────────────────────────────────┼───────────┼──────────────────┘
                         Query / Mutation        │           │   Subscription
                         POST http://…/graphql   ▼           ▼   ws://…/graphql
┌───────────────────────────────────────────────────────────────────────────────┐
│  APOLLO SERVER 5  ·  una sola ruta: /graphql  ·  CERO endpoints REST          │
│                                                                               │
│   schema.graphql  ─── 7 scalars propios · 11 enums · 2 interfaces · 1 unión   │
│                                                                               │
│  ╔══════════════════════════════╗      ╔═══════════════════════════════════╗  │
│  ║  LADO LECTURA (Query)        ║      ║  LADO ESCRITURA (Mutation)        ║  │
│  ║                              ║      ║                                   ║  │
│  ║  catalog.resolvers           ║      ║  ordering.resolvers               ║  │
│  ║        │                     ║      ║        │                          ║  │
│  ║        ▼                     ║      ║        ▼                          ║  │
│  ║  ┌────────────────────┐      ║      ║  ordering.commands                ║  │
│  ║  │    DataLoaders     │      ║      ║   · placeOrder   · approveOrder   ║  │
│  ║  │  batch + caché     │      ║      ║   · cancelOrder  · dispatchOrder  ║  │
│  ║  │  POR PETICIÓN      │      ║      ║        │                          ║  │
│  ║  └────────────────────┘      ║      ║        ▼                          ║  │
│  ║        │                     ║      ║  ordering.domain  (puro, sin I/O) ║  │
│  ║        ▼                     ║      ║   · invariante de inventario      ║  │
│  ║  catalog.repository          ║      ║   · invariante de prescripción    ║  │
│  ║  projection.repository       ║      ║   · máquina de estados            ║  │
│  ╚══════════════════════════════╝      ╚═══════════════════════════════════╝  │
│                 ▲                                    │                        │
│                 │                                    │ evento en la MISMA      │
│                 │                                    │ transacción (outbox)    │
│                 │          ┌─────────────────────────▼──────────────┐          │
│                 └──────────│  order.projector                       │          │
│      reconstruye la        │   · camino rápido: tras el COMMIT      │          │
│      proyección            │   · red de seguridad: poller del outbox│          │
│                            │   · publica a PubSub → Subscriptions   │          │
│                            └────────────────────────────────────────┘          │
└───────────────────────────────────────────────────────────────────────────────┘
                                        │  driver `pg` · SQL + transacciones
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  SUPABASE · PostgreSQL 16                                                     │
│                                                                               │
│  ZONA 1 · CATÁLOGO          ZONA 2 · WRITE MODEL      ZONA 3 · CQRS           │
│  ┌──────────────┐           ┌──────────────┐          ┌────────────────────┐  │
│  │ medications  │◀──┐       │ patients     │          │ domain_events      │  │
│  │ categories   │   │       │ carts        │          │  (log append-only) │  │
│  │ manufacturers│   │       │ cart_items   │          ├────────────────────┤  │
│  └──────────────┘   └───────│ prescriptions│          │ order_read_model   │  │
│   8 índices                 │ orders       │          │  (desnormalizado,  │  │
│   (GIN trigramas,           │ order_items  │          │   JSONB, sin JOINs)│  │
│    parciales, compuestos)   └──────────────┘          └────────────────────┘  │
│                              normalizado,              1 SELECT por PK         │
│                              transaccional                                     │
└───────────────────────────────────────────────────────────────────────────────┘
```

### El recorrido de un pedido, paso a paso

```
 1. El paciente pulsa "Confirmar pedido"
       │
 2. useMutation(PLACE_ORDER) ────POST /graphql────▶ resolver placeOrder
       │
 3.                                                 BEGIN
 4.                                                   bloquear carrito     FOR UPDATE
 5.                                                   bloquear inventario  FOR UPDATE OF m
 6.                                                   evaluar invariantes  (dominio puro)
 7.                                                   descontar stock      guarda stock >= qty
 8.                                                   crear orden + líneas
 9.                                                   cerrar carrito
10.                                                   anexar OrderPlaced   ← outbox
11.                                                 COMMIT
       │
12. ◀── acuse de recibo: { id, orderNumber, status, projection: CATCHING_UP }
       │                                                   │
13. La UI navega a /pedidos/:id                            │ (asíncrono)
14. query order(id) → OrderProjectionPending               ▼
       │                                            order.projector
15. Banner "sincronizando…"                          reconstruye order_read_model
       │                                             publica a PubSub
       │                                                   │
16. ◀──── Subscription orderStatusChanged ─────────────────┘
          (el evento trae la proyección dentro)
       │
17. Apollo la normaliza en caché por su `id` → la pantalla se completa sola
```

---

## 4. El schema SDL

**Archivo:** [`server/src/graphql/schema.graphql`](server/src/graphql/schema.graphql)
(~750 líneas, documentado sección por sección)

El schema **es** el contrato donde se hace visible el patrón CQRS: la mitad de
arriba es el lado de lectura, la de abajo el de escritura.

### Inventario del contrato

| Elemento | Cantidad | Ejemplos |
|---|---|---|
| Scalars personalizados | **7** | `DateTime`, `Date`, `UUID`, `PositiveInt`, `NonEmptyString`, `Decimal`, `URL` |
| Enums | **11** | `TherapeuticCategory`, `OrderStatus`, `DispensingRule`, `ProjectionState`, `DomainErrorCode` |
| Interfaces | **2** | `Node`, `DomainError` |
| Uniones | **1** | `OrderQueryResult` |
| Object types | 44 | `Medication`, `Cart`, `OrderProjection`, `Money`… |
| Input types | 12 | `MedicationFilter`, `PlaceOrderInput`, `AttachPrescriptionInput`… |
| Queries | 11 | |
| Mutations (comandos) | 10 | |
| Subscriptions | 2 | |

### Por qué 7 scalars propios

Un scalar personalizado valida **en el borde del sistema**, antes de que un dato
inválido llegue a un resolver o a la base de datos:

```graphql
addMedicationToCart(input: { cartId: "...", medicationId: "3", quantity: 0 })
```

`quantity` es `PositiveInt!`. GraphQL rechaza la operación con
*«PositiveInt: la cantidad debe ser mayor que cero»* **sin ejecutar un solo
resolver ni abrir una transacción**. La regla «no se piden cero cajas» vive en
el contrato, no repartida en `if`s por todo el código.

Lo mismo con `UUID` (formato), `Decimal` (no negativo, 2 decimales),
`NonEmptyString` (recorta y exige contenido) y `Date` (rechaza `2026-02-31`).

### Por qué los errores son datos, no excepciones

Todo comando devuelve un payload con `errors: [DomainError!]!`. `DomainError`
es una **interfaz** con seis implementaciones. Cada una aporta los campos que su
caso necesita:

```graphql
type InsufficientStockError implements DomainError {
  code: DomainErrorCode!
  message: String!
  field: String
  medicationName: String!
  requested: Int!      # ← lo que pidió el paciente
  available: Int!      # ← lo que hay de verdad
}
```

Gracias a `requested` y `available`, la interfaz puede ofrecer *«reduce la
cantidad a 40 unidades»* en lugar de un genérico «algo salió mal». Eso es lo que
compra modelar los errores como tipos del schema:

```graphql
errors {
  __typename
  message
  ... on InsufficientStockError { requested available }
  ... on PrescriptionRequiredError { medicationName medicationSku }
}
```

Un fallo de negocio no es una excepción del transporte: es un resultado previsto
del dominio, y viaja como dato.

### Por qué `Money` es un objeto y no un `Float`

```graphql
type Money { amount: Decimal!, currency: CurrencyCode!, formatted: String! }
```

El servidor entrega el número exacto **y** su representación local
(`"$ 46.000"`). El cliente no tiene que adivinar la moneda ni replicar
`Intl.NumberFormat` en cada componente.

### Por qué una unión para consultar una orden

```graphql
union OrderQueryResult = OrderProjection | OrderProjectionPending | NotFoundError
```

Si `order(id)` devolviera `OrderProjection` anulable, un `null` sería ambiguo:
¿no existe, o todavía no está proyectada? La unión **obliga** al cliente a
tratar los tres casos por separado. Ver §8.

---

## 5. Cómo se aplicó CQRS

CQRS significa separar el modelo que **cambia** el estado del modelo que lo
**consulta**. Aquí la separación es real en cuatro niveles.

### Nivel 1 · Separación en la base de datos

| | Lado ESCRITURA | Lado LECTURA |
|---|---|---|
| **Tablas** | `carts`, `cart_items`, `prescriptions`, `orders`, `order_items` | `order_read_model` |
| **Forma** | Normalizada, 5 tablas con claves foráneas | Desnormalizada, 1 tabla con JSONB embebido |
| **Consulta típica** | JOINs + `SELECT ... FOR UPDATE` dentro de transacción | `SELECT * FROM order_read_model WHERE order_id = $1` |
| **JOINs para pintar una orden** | 4 | **0** |
| **Optimizada para** | Proteger invariantes | Responder rápido |

Es la misma información en dos formas distintas, cada una diseñada para su
trabajo. Ese contraste **es** el patrón.

### Nivel 2 · Separación en el schema

Los comandos no devuelven el modelo de lectura. Devuelven un **acuse de recibo**:

```graphql
type OrderAcknowledgement {
  id: UUID!
  orderNumber: String!
  status: OrderStatus!          # estado según el WRITE model
  total: Money!
  projection: ProjectionMetadata!   # "tu proyección todavía no está lista"
}
```

El comando confirma la **intención**; los datos para mostrar se piden después al
lado de lectura. Si `placeOrder` devolviera la orden completa, los dos lados
estarían acoplados y no habría CQRS: habría dos tablas y un nombre bonito.

### Nivel 3 · Comandos con nombre de intención

No existe `updateOrder(campos)`. Existen:

| Comando | Intención de negocio | Invariante que protege |
|---|---|---|
| `placeOrder` | Emitir el pedido | Stock suficiente + fórmulas adjuntas |
| `approveOrder` | Verificar fórmulas y aceptar | Solo desde `PENDING_APPROVAL` |
| `dispatchOrder` | Enviar al domicilio | Solo desde `APPROVED` |
| `cancelOrder` | Anular y devolver inventario | Solo desde estados no terminales |
| `attachPrescription` | Aportar soporte regulatorio | Registro médico válido, fórmula vigente |

El log de eventos cuenta **qué quiso hacer el negocio**, no qué columnas
cambiaron. Eso es lo que hace auditable el sistema.

### Nivel 4 · Invariantes en un módulo puro

[`ordering.domain.ts`](server/src/modules/ordering/ordering.domain.ts) no importa
`pg` ni `graphql`. Solo recibe datos y devuelve veredictos.

Eso permite algo que vale la pena señalar en la sustentación: **la misma función
se usa en los dos lados**.

- El comando `placeOrder` la llama para decidir si acepta.
- El campo de lectura `Cart.blockers` la llama para que la interfaz sepa, **antes
  de intentarlo**, por qué el checkout está bloqueado.

No hay reglas duplicadas en el navegador. El botón «Confirmar pedido» se
deshabilita porque el servidor lo dijo, y el veredicto coincidirá con el del
comando porque es literalmente el mismo código.

### La transacción de `placeOrder`

```sql
BEGIN
  SELECT … FROM carts WHERE id = $1 FOR UPDATE           -- 1. bloquear carrito
  SELECT … FROM cart_items ci JOIN medications m …
    ORDER BY ci.medication_id FOR UPDATE OF m            -- 2. bloquear inventario
  -- 3. evaluar invariantes (dominio puro, sin SQL)
  UPDATE medications m SET stock = m.stock - v.qty
    FROM (SELECT UNNEST($1::int[]) id, UNNEST($2::int[]) qty) v
   WHERE m.id = v.id AND m.stock >= v.qty                -- 4. descuento con guarda
  INSERT INTO orders …                                   -- 5. crear orden
  INSERT INTO order_items … FROM UNNEST(…)               -- 6. líneas (snapshot)
  UPDATE carts SET status = 'CHECKED_OUT'                -- 7. cerrar carrito
  INSERT INTO domain_events … 'OrderPlaced'              -- 8. outbox
COMMIT
```

Dos detalles que no son obvios:

- **`ORDER BY ci.medication_id` antes de `FOR UPDATE`.** Fija un orden de
  adquisición de cerrojos idéntico para todas las transacciones. Sin él, dos
  pacientes comprando los mismos dos medicamentos en orden inverso se
  bloquearían mutuamente (*deadlock*).
- **El evento se anexa dentro de la transacción** (patrón *transactional
  outbox*). O se guardan el cambio y su evento, o no se guarda ninguno. Es
  imposible que quede una orden confirmada sin su evento.

Si cualquier paso falla → `ROLLBACK`: no se descuenta inventario, no se crea
orden, no se emite evento.

---

## 6. Cómo se mitigó el problema N+1

### El problema

GraphQL resuelve campo por campo. Esta consulta, perfectamente razonable:

```graphql
query { medications(first: 12) { nodes {
  name
  category { name medicationCount }
  manufacturer { name medicationCount }
  relatedMedications(limit: 3) { name }
} } }
```

provocaría, con una implementación ingenua:

```
  1 consulta  → los 12 medicamentos
+ 12 consultas → la categoría de cada uno, una por una
+ 12 consultas → el laboratorio de cada uno
+ 12 consultas → los relacionados de cada uno
+ 8            → los conteos de cada categoría y laboratorio
= 45 viajes a Supabase para pintar UNA pantalla
```

### La solución: DataLoader

[`catalog.loaders.ts`](server/src/modules/catalog/catalog.loaders.ts) define seis
loaders. Cada uno hace dos cosas, **por petición HTTP**:

1. **Batching.** En lugar de ejecutar cada `load(id)` al instante, los acumula
   durante el tick actual del event loop y al final llama una sola vez a la
   función de lote:
   ```sql
   SELECT id, slug, name FROM categories WHERE id = ANY($1)   -- $1 = [3,7,7,11,3,…]
   ```
2. **Caché por petición.** Si dos medicamentos comparten categoría, esa categoría
   se pide una vez.

### Resultado medido

Ejecutando exactamente esa consulta contra el servidor, el log imprime:

```
BATCH #0293  DataLoader:categoryById — 9 claves resueltas en 1 sola consulta
BATCH #0294  DataLoader:manufacturerById — 8 claves resueltas en 1 sola consulta
BATCH #0295  DataLoader:medicationsByCategory — 9 claves resueltas en 1 sola consulta
BATCH #0296  DataLoader:medicationCountByCategory — 9 claves resueltas en 1 sola consulta
BATCH #0297  DataLoader:medicationCountByManufacturer — 8 claves resueltas en 1 sola consulta
──────── RESUMEN · MedicationsFull ────────
INFO   7 consultas SQL en 8.9ms · 5 en lote resolvieron 43 claves
INFO   DataLoader evitó 38 consultas (habrían sido 45 sin batching)
```

**45 → 7 consultas.** Esa salida de consola es la evidencia que pide el video.

### Dos detalles críticos de implementación

**1. Los loaders se crean por petición, nunca globales.**

```ts
// graphql/context.ts — se ejecuta UNA VEZ POR PETICIÓN
loaders: { ...createCatalogLoaders(catalog), ...createOrderingLoaders(ordering) }
```

Si fueran globales, la caché sobreviviría entre usuarios y un paciente podría ver
el stock que ya cambió para otro. Al vivir en el contexto, se destruyen al
terminar la petición.

**2. El orden del resultado del lote debe coincidir con el de las claves.**

SQL no garantiza el orden de `ANY()`. Por eso todos los loaders indexan el
resultado en un `Map` y lo reordenan. Omitirlo produce bugs silenciosos en los
que un medicamento muestra la categoría de otro.

### El N+1 «hermano»: varios campos, mismo origen

El tipo `Cart` tiene siete campos que se alimentan de los mismos datos
(`lines`, `itemCount`, `unitsCount`, `subtotal`, `prescriptionRequirements`,
`readyForCheckout`, `blockers`). Sin loader, pintar un carrito costaría 7
consultas. Con `cartLinesByCartId`, cuesta 1.

---

## 7. Cumplimiento del mandato Zero-REST

El taller prohíbe endpoints REST **en el canal de clientes**. Aquí está cómo se
verifica:

| Prueba | Resultado |
|---|---|
| Rutas HTTP declaradas en el backend | **Una**: `app.use('/graphql', …)`. No hay un solo `app.get` / `app.post` en el proyecto. |
| `GET /api/medications` | `404 { "error": "ZERO_REST_MANDATE", … }` — el servidor **rechaza explícitamente** cualquier otra ruta. |
| Autenticación | `mutation signIn` — no existe `POST /login`. |
| Health-check | `query health` — ni siquiera esto usa REST. |
| Subscriptions | `ws://…/graphql`, la **misma** ruta. |
| `fetch`/`axios` en el frontend | Ninguno. Todo sale por la cadena de links de Apollo Client. |

### El inspector Zero-REST

La aplicación incluye un panel flotante que lista en vivo cada operación
enviada, con su tipo y su URL de destino:

```
  Inspector Zero-REST
   6          3           1              0
  QUERIES  MUTATIONS  SUBSCRIPT.   LLAMADAS REST
  ───────────────────────────────────────────────
  MUT  ApproveOrder            localhost:4000/graphql
  QUE  OrderProjectionQuery    localhost:4000/graphql
  SUB  OrderStatusChanged      localhost:4000/graphql
  …
  10/10 operaciones hacia /graphql
```

Existe por una razón práctica: DevTools también lo demuestra, pero en una
grabación se ve pequeño y mezclado con las peticiones del propio Vite (HMR,
módulos, sourcemaps). Este panel muestra el mismo hecho sin ambigüedad.

También funciona como canario: si alguien introdujera un `fetch()` a un endpoint
REST, no aparecería en la lista y el contador dejaría de cuadrar.

### Sobre el backend y la base de datos

El mandato acota la restricción al canal **frontend ↔ backend** («todas las
interacciones de red entre el frontend y el backend», «ninguna vista del
cliente»). El canal backend ↔ base de datos es otro, y ahí el enunciado solo
exige **PostgreSQL alojado en Supabase**.

Por eso se usa el driver nativo `pg` y no `supabase-js`: este último habla
PostgREST (HTTP REST) por debajo, lo cual sería irónico en un taller titulado
Zero-REST, y además impediría tres cosas que la rúbrica sí valora:
transacciones reales, `WHERE id = ANY($1)` para el batching del DataLoader, e
índices propios.

---

## 8. Consistencia eventual: qué ve el usuario mientras tanto

El enunciado pregunta explícitamente: *«¿qué ve el usuario mientras la orden está
siendo validada o el stock se está sincronizando?»*.

### La respuesta en el schema

```graphql
enum ProjectionState {
  SYNCED        # la proyección refleja todos los eventos confirmados
  CATCHING_UP   # el comando se confirmó, el proyector aún no terminó
  NOT_FOUND
}

type ProjectionMetadata {
  state: ProjectionState!
  projectedAt: DateTime
  lagMs: Int!          # el retraso, MEDIDO y expuesto, no escondido
  lastEventId: ID
  version: Int!
  stale: Boolean!      # ¿el write model ya avanzó más allá de la proyección?
}
```

`stale` se calcula comparando la versión que refleja la proyección con la versión
real del agregado en el modelo de escritura. Si el write model va por delante, el
sistema **lo dice**, en lugar de presentar datos viejos como definitivos.

### La respuesta en la interfaz

1. **t=0** · El comando confirma. La orden existe y el stock ya está reservado.
   La respuesta trae `projection: { state: CATCHING_UP }`.
2. **t=0** · `order(id)` devuelve `OrderProjectionPending` — no `null`, no un
   error. Un estado legítimo y transitorio, con su propio mensaje y su
   `retryAfterMs`.
3. La UI pinta un banner *«Sincronizando la proyección de lectura»* con el
   estado ya confirmado por el write model.
4. **t≈1.5s** · El proyector termina y publica el evento.
5. La Subscription entrega la proyección ya reconstruida. Apollo la normaliza
   por su `id` y **la pantalla se completa sola**.

Hay además un `pollInterval` de respaldo por si el WebSocket no estuviera
disponible: dos caminos independientes hacia la convergencia.

> El retraso es **artificial y configurable** (`PROJECTION_DELAY_MS`). En
> producción valdría `0` y el desfase sería imperceptible. Se exagera a 1500 ms
> para que el estado transitorio sea visible durante la demostración.

### Garantía de convergencia: el transactional outbox

Escenario incómodo: el `COMMIT` se completa, se devuelve el acuse al paciente y
el proceso muere antes de proyectar. Esa orden quedaría para siempre en
«sincronizando».

Por eso el evento se anexa **dentro de la transacción** y existe un poller que
barre `domain_events WHERE processed_at IS NULL`. Al reiniciar, la orden se
proyecta y el sistema converge.

Esa es la diferencia entre **consistencia eventual** (converge, con garantía) y
**simple inconsistencia** (nunca converge).

> El poller aplica un **periodo de gracia** antes de reclamar un evento: uno
> emitido hace 200 ms no está perdido, está esperando su proyección agendada.
> Sin esa gracia, el poller pisaría al camino rápido y produciría eventos
> duplicados hacia los suscriptores.

### Una consecuencia honesta

`myOrders` se sirve del read model. Una orden emitida hace menos que
`PROJECTION_DELAY_MS` **todavía no aparece en esa lista**. No es un bug: es el
precio de desacoplar, y con el retraso en `0` (producción) resulta invisible.
Se documenta aquí porque ocultarlo sería justo lo contrario de lo que pide el
criterio «tratamiento de consistencia eventual».

---

## 9. El frontend y la caché de Apollo

### El árbol de contexto

```tsx
// web/src/main.tsx
<ApolloProvider client={apolloClient}>
  <BrowserRouter><App /></BrowserRouter>
</ApolloProvider>
```

`ApolloProvider` envuelve **todo** el árbol de React. Cualquier componente, a
cualquier profundidad, usa `useQuery` / `useMutation` / `useSubscription` sin
recibir el cliente por props. Y la caché normalizada es única y compartida.

### La cadena de links

```
errorLink → authLink → auditLink → split(¿es Subscription?)
                                       │ sí            │ no
                                       ▼               ▼
                                 GraphQLWsLink      HttpLink
                                 ws://…/graphql   POST http://…/graphql
```

El `split` decide el transporte según el **tipo de operación**, no según la URL.
El componente que la usa no se entera: `useQuery` y `useSubscription` se
escriben igual.

### Tres usos de la caché que vale la pena mirar

**1. Actualización quirúrgica desde una Subscription** (catálogo):

```ts
client.cache.modify({
  id: client.cache.identify({ __typename: 'Medication', id: event.medicationId }),
  fields: { stock: () => event.stock, availability: () => event.availability },
});
```

Se tocan dos campos del medicamento afectado. No se invalida la consulta, no se
refetchea nada, el resto de la pantalla ni se entera.

**2. Normalización automática** (seguimiento del pedido):

El evento `orderStatusChanged` trae la proyección completa dentro. Como
`OrderProjection` se identifica por su `id`, Apollo la fusiona sola con la que ya
tenía. **Cero refetch.**

**3. Paginación acumulativa** (`typePolicies`):

```ts
medications: {
  keyArgs: ['filter', 'sort'],   // ← `after` queda FUERA de la clave, a propósito
  merge(existing, incoming, { args }) {
    if (!args?.after || !existing) return incoming;
    return { ...incoming, nodes: [...existing.nodes, ...incoming.nodes] };
  },
}
```

Todas las páginas de una misma combinación de filtro y orden comparten entrada de
caché y se concatenan. Si `after` formara parte de la clave, cada página sería una
entrada distinta y el listado parpadearía al avanzar.

### El conmutador de vista: over-fetching en vivo

La pantalla de catálogo alterna entre dos documentos contra **el mismo campo**:

| | `MedicationsCondensed` | `MedicationsFull` |
|---|---|---|
| Campos pedidos | 6 | ~20 + 3 relaciones anidadas |
| Consultas SQL | **2** | **7** |
| Sin DataLoader serían | 2 | 45 |

Cambiar de vista en la interfaz y mirar la pestaña Network demuestra, en un
gesto, la defensa de GraphQL contra el over-fetching. Bajo REST harían falta dos
endpoints distintos, o devolver siempre todo.

---

## 10. Decisiones de diseño y sus porqués

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Driver `pg` | `supabase-js` | Transacciones reales, `ANY($1)` para el batching, índices propios. Y `supabase-js` mete PostgREST (HTTP REST) dentro de la arquitectura. |
| Normalizar el XLSX en 3 tablas | Importar la tabla plana | Sin relaciones no hay problema N+1 que mitigar, que es el 40% de la rúbrica. |
| Errores como datos tipados | `throw new GraphQLError` | Un fallo de negocio es un resultado previsto, no una excepción. Y los campos específicos (`available`, `requested`) permiten una UI accionable. |
| Un solo `schema.graphql` | SDL repartido por módulo | El entregable pide «definición completa del Schema SDL». Un archivo se revisa de una sentada; la modularidad vive en `modules/`. |
| Monolito modular | Federación con subgraphs | El enunciado admite ambos. Cada carpeta de `modules/` ya es un candidato natural a subgraph si algún día se federa. |
| Reconstruir la proyección entera | Aplicar deltas por evento | Es idempotente (proyectar dos veces da el mismo resultado) y permite regenerar la tabla desde cero si cambia su forma. |
| `PubSub` en memoria | Redis | Correcto para una instancia. El punto de extensión está aislado en `shared/pubsub.ts`: cambiarlo no toca schema ni resolvers. |
| Retraso de proyección configurable | Proyección síncrona | Síncrona volvería a acoplar lectura y escritura: dos tablas, no CQRS. |
| Tipos TS escritos a mano | GraphQL Code Generator | El repositorio se clona y arranca sin un paso de generación previo. |

---

## 11. Mapa del repositorio

```
TallerGraphQL/
│
├── db/                              ← SQL para Supabase (ejecutar en orden)
│   ├── 01_schema.sql                  tablas, 8 índices, extensiones, secuencia
│   ├── 02_seed_catalog.sql            los 50 medicamentos del dataset
│   └── 03_seed_patients.sql           3 pacientes (bcrypt vía pgcrypto)
│
├── docs/
│   ├── GUIA-SUPABASE.md             ← cómo cargar el dataset y conectar (paso a paso)
│   └── GUION-VIDEO.md               ← guion de la sustentación de 5-8 min
│
├── server/                          ← BACKEND · Apollo Server 5
│   ├── .env.example                   plantilla de configuración
│   ├── scripts/
│   │   ├── setup-db.ts                `npm run db:setup`  · carga los 3 SQL
│   │   ├── check-db.ts                `npm run db:check`  · diagnóstico
│   │   └── schema-check.ts            `npm run schema:check` · valida el contrato
│   └── src/
│       ├── index.ts                   arranque · UNA ruta: /graphql · plugin de auditoría SQL
│       ├── config/env.ts              configuración validada
│       ├── db/pool.ts                 driver pg · transacciones · instrumentación
│       ├── graphql/
│       │   ├── schema.graphql       ★ EL CONTRATO (entregable)
│       │   ├── scalars.ts             los 7 scalars personalizados
│       │   ├── context.ts           ★ loaders + repos POR PETICIÓN
│       │   └── resolvers.ts           composición modular
│       ├── shared/                    errores de dominio, Money, PubSub, logger
│       └── modules/
│           ├── catalog/             ── LADO LECTURA (catálogo)
│           │   ├── catalog.repository.ts     SQL, incluido WHERE id = ANY($1)
│           │   ├── catalog.loaders.ts      ★ MITIGACIÓN DEL N+1
│           │   └── catalog.resolvers.ts
│           ├── identity/              login por Mutation (Zero-REST)
│           ├── ordering/            ── LADO ESCRITURA (comandos)
│           │   ├── ordering.domain.ts      ★ INVARIANTES (puro, sin I/O)
│           │   ├── ordering.commands.ts    ★ TRANSACCIONES + outbox
│           │   ├── ordering.loaders.ts
│           │   ├── ordering.repository.ts
│           │   └── ordering.resolvers.ts
│           └── projections/         ── LADO LECTURA (órdenes)
│               ├── order.projector.ts      ★ CONSISTENCIA EVENTUAL
│               ├── projection.repository.ts  1 SELECT, 0 JOINs
│               └── projection.resolvers.ts   unión + Subscriptions
│
└── web/                             ← FRONTEND · React + Apollo Client
    └── src/
        ├── main.tsx                 ★ ApolloProvider en la raíz
        ├── App.tsx                    barra superior y rutas
        ├── apollo/
        │   ├── client.ts            ★ links, split HTTP/WS, typePolicies
        │   └── operationLog.ts        store del inspector Zero-REST
        ├── graphql/operations.ts    ★ todas las operaciones, con fragmentos
        ├── components/
        │   ├── ui.tsx                 badges y errores de dominio accionables
        │   └── ZeroRestInspector.tsx ★ evidencia visual de Zero-REST
        └── pages/
            ├── CatalogPage.tsx      ── Escenario A · conmutador de vista
            ├── MedicationDetailPage.tsx
            ├── CartPage.tsx         ── Escenario B · invariantes y fórmulas
            ├── OrderPage.tsx        ── Escenario C · proyección y tiempo real
            ├── OrdersPage.tsx
            └── SignInPage.tsx
```

---

## 12. Verificación

### Comprobar el contrato sin arrancar nada

```bash
npm run schema:check --prefix server
```

Construye el schema ejecutable uniendo el SDL con los resolvers. Si un resolver
apunta a un campo inexistente (o al revés), falla aquí en un segundo, no a mitad
de la demostración.

### Comprobar la base de datos

```bash
npm run db:check --prefix server
```

Imprime versión de PostgreSQL, conteos por tabla, lista de índices y el plan de
ejecución de una búsqueda por texto.

### Comprobar los tipos

```bash
npm run typecheck
```

### Estado de las pruebas

El sistema se validó de punta a punta contra un PostgreSQL 16 real, cubriendo
**44 aserciones** sobre: carga del dataset, rechazo de rutas REST, autenticación,
selección de campos, filtros y facetas, validación de scalars, las dos
invariantes de negocio, el descuento y la devolución atómicos de inventario, la
máquina de estados, el aislamiento entre pacientes, la unión `OrderQueryResult`,
la transición `CATCHING_UP → SYNCED`, el vaciado del outbox y las dos
Subscriptions sobre WebSocket. **Todas pasan.**

---

## Guion para el video

Ver **[docs/GUION-VIDEO.md](docs/GUION-VIDEO.md)** — incluye minutaje, qué
mostrar en pantalla y qué decir en cada tramo, alineado con los cuatro criterios
de la rúbrica.
