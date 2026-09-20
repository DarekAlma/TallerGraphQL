-- =====================================================================
-- Afirmative Pill · 01_schema.sql
-- Esquema PostgreSQL (Supabase) para la arquitectura GraphQL + CQRS.
--
-- El esquema esta dividido EXPLICITAMENTE en tres zonas, porque asi es como
-- se materializa CQRS a nivel de persistencia:
--
--   ZONA 1 · CATALOGO (lado lectura, alta concurrencia de consultas)
--   ZONA 2 · WRITE MODEL (lado escritura, normalizado y transaccional)
--   ZONA 3 · EVENT STORE + READ MODEL (proyecciones, consistencia eventual)
--
-- Ejecutar UNA sola vez en el SQL Editor de Supabase antes de 02 y 03.
-- Es idempotente: se puede re-ejecutar sin romper nada.
-- =====================================================================

-- pg_trgm habilita indices GIN para busquedas ILIKE '%texto%' sin secuencial.
-- Es la extension que hace que el buscador del catalogo sea "bien indexado".
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- pgcrypto aporta gen_random_uuid() para las claves de los agregados.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =====================================================================
-- ZONA 1 · CATALOGO  (READ-HEAVY)
-- ---------------------------------------------------------------------
-- El XLSX del taller venia como una tabla plana de 12 columnas. Lo
-- normalizamos en 3 tablas a proposito: al separar categoria y laboratorio
-- en entidades propias, resolver `medication.category` y
-- `medication.manufacturer` en GraphQL genera el clasico problema N+1
-- (1 query de medicamentos + N queries de relaciones). Ese es justamente
-- el problema que el DataLoader va a colapsar a 1 + 1 + 1 consultas.
-- =====================================================================

CREATE TABLE IF NOT EXISTS categories (
  id    SMALLSERIAL PRIMARY KEY,
  slug  TEXT NOT NULL UNIQUE,   -- se mapea 1:1 al enum GraphQL TherapeuticCategory
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS manufacturers (
  id    SMALLSERIAL PRIMARY KEY,
  slug  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS medications (
  id                    INTEGER PRIMARY KEY,
  sku                   TEXT    NOT NULL UNIQUE,
  name                  TEXT    NOT NULL,
  active_ingredient     TEXT    NOT NULL,
  category_id           SMALLINT NOT NULL REFERENCES categories(id),
  manufacturer_id       SMALLINT NOT NULL REFERENCES manufacturers(id),
  dosage                TEXT    NOT NULL,
  presentation          TEXT    NOT NULL,
  price_cop             NUMERIC(12,2) NOT NULL CHECK (price_cop >= 0),
  -- INVARIANTE DE BASE DE DATOS: el stock jamas puede ser negativo.
  -- Es la ultima linea de defensa: aunque el codigo tuviera un bug de
  -- concurrencia, PostgreSQL rechaza la transaccion.
  stock                 INTEGER NOT NULL CHECK (stock >= 0),
  requires_prescription BOOLEAN NOT NULL DEFAULT FALSE,
  description           TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- Indices del catalogo (criterio "consultas bien indexadas") ----
-- 1) Busqueda por texto parcial en nombre comercial y principio activo.
--    GIN + trigramas: convierte un seq-scan con ILIKE '%amox%' en index scan.
CREATE INDEX IF NOT EXISTS idx_medications_name_trgm
  ON medications USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_medications_ingredient_trgm
  ON medications USING GIN (active_ingredient gin_trgm_ops);

-- 2) Filtros facetados por categoria / laboratorio (los FK del DataLoader).
CREATE INDEX IF NOT EXISTS idx_medications_category      ON medications (category_id);
CREATE INDEX IF NOT EXISTS idx_medications_manufacturer  ON medications (manufacturer_id);

-- 3) Ordenamiento por precio y paginacion estable (precio, id como desempate).
CREATE INDEX IF NOT EXISTS idx_medications_price         ON medications (price_cop, id);

-- 4) Indice parcial: las consultas "solo venta libre" (OTC) son el caso
--    mas frecuente del paciente sin receta; el indice parcial es mucho
--    mas pequeno que uno completo sobre el booleano.
CREATE INDEX IF NOT EXISTS idx_medications_otc
  ON medications (id) WHERE requires_prescription = FALSE;

-- 5) Disponibilidad: solo indexamos lo que tiene stock (el 100% de las
--    busquedas de "disponible ahora" caen aqui).
CREATE INDEX IF NOT EXISTS idx_medications_in_stock
  ON medications (stock) WHERE stock > 0;


-- =====================================================================
-- ZONA 2 · WRITE MODEL  (COMMAND SIDE)
-- ---------------------------------------------------------------------
-- Modelo normalizado, transaccional, pensado para PROTEGER INVARIANTES.
-- Nunca se consulta directamente desde las pantallas: las pantallas leen
-- de la ZONA 3. Esta es la segregacion fisica de CQRS.
-- =====================================================================

CREATE TABLE IF NOT EXISTS patients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  document_id   TEXT NOT NULL,
  password_hash TEXT NOT NULL,   -- la autenticacion tambien viaja por GraphQL (Zero-REST)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Carrito = agregado de trabajo del paciente antes de emitir la orden.
CREATE TABLE IF NOT EXISTS carts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'OPEN'
             CHECK (status IN ('OPEN','CHECKED_OUT','ABANDONED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_carts_patient_open
  ON carts (patient_id) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS cart_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id        UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  medication_id  INTEGER NOT NULL REFERENCES medications(id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  -- Precio congelado al momento de agregar: el precio del catalogo puede
  -- cambiar, pero lo que el paciente vio es lo que se cobra.
  unit_price_cop NUMERIC(12,2) NOT NULL,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Un medicamento aparece UNA sola vez por carrito (se suma la cantidad).
  UNIQUE (cart_id, medication_id)
);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items (cart_id);

-- Soporte de formula medica. Un registro por medicamento con receta.
CREATE TABLE IF NOT EXISTS prescriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id        UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  medication_id  INTEGER NOT NULL REFERENCES medications(id),
  doctor_name    TEXT NOT NULL,
  doctor_license TEXT NOT NULL,   -- registro medico del prescriptor
  issued_at      DATE NOT NULL,
  document_url   TEXT,
  status         TEXT NOT NULL DEFAULT 'SUBMITTED'
                 CHECK (status IN ('SUBMITTED','VERIFIED','REJECTED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cart_id, medication_id)
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_cart ON prescriptions (cart_id);

-- Consecutivo legible de ordenes (AP-2026-000042). Una secuencia de
-- PostgreSQL garantiza unicidad sin bloqueos ni condiciones de carrera,
-- a diferencia de un COUNT(*)+1 calculado en la aplicacion.
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1;

-- Orden = agregado transaccional resultante del comando placeOrder.
CREATE TABLE IF NOT EXISTS orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number          TEXT NOT NULL UNIQUE,
  patient_id            UUID NOT NULL REFERENCES patients(id),
  cart_id               UUID NOT NULL REFERENCES carts(id),
  status                TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                        CHECK (status IN ('PENDING_APPROVAL','APPROVED','DISPATCHED','CANCELLED')),
  total_cop             NUMERIC(14,2) NOT NULL CHECK (total_cop >= 0),
  requires_prescription BOOLEAN NOT NULL DEFAULT FALSE,
  cancellation_reason   TEXT,
  -- version = numero de eventos aplicados al agregado. Sirve para
  -- detectar si la proyeccion ya esta al dia (consistencia eventual).
  version               INTEGER NOT NULL DEFAULT 1,
  placed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_patient ON orders (patient_id, placed_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  medication_id   INTEGER NOT NULL REFERENCES medications(id),
  medication_name TEXT NOT NULL,   -- snapshot: el nombre pudo cambiar despues
  medication_sku  TEXT NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cop  NUMERIC(12,2) NOT NULL,
  subtotal_cop    NUMERIC(14,2) NOT NULL,
  required_prescription BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);


-- =====================================================================
-- ZONA 3 · EVENT STORE + READ MODEL  (QUERY SIDE)
-- ---------------------------------------------------------------------
-- domain_events es un log append-only. El command handler escribe el write
-- model Y el evento DENTRO DE LA MISMA TRANSACCION (patron Transactional
-- Outbox): o se guardan ambos o no se guarda ninguno, nunca hay un estado
-- confirmado sin su evento.
--
-- order_read_model es la PROYECCION: una tabla desnormalizada, pensada para
-- que la pantalla de seguimiento se resuelva con UN SELECT por id y sin JOINs.
-- =====================================================================

CREATE TABLE IF NOT EXISTS domain_events (
  id             BIGSERIAL PRIMARY KEY,
  aggregate_type TEXT NOT NULL,          -- 'Order' | 'Cart'
  aggregate_id   UUID NOT NULL,
  event_type     TEXT NOT NULL,          -- 'OrderPlaced', 'OrderApproved', ...
  payload        JSONB NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = el proyector todavia no lo proceso. Este es el "outbox pendiente".
  processed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_domain_events_aggregate
  ON domain_events (aggregate_type, aggregate_id, id);
-- Indice parcial sobre lo NO procesado: el poller del proyector solo mira aqui.
CREATE INDEX IF NOT EXISTS idx_domain_events_pending
  ON domain_events (id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS order_read_model (
  order_id              UUID PRIMARY KEY,
  order_number          TEXT NOT NULL,
  patient_id            UUID NOT NULL,
  patient_name          TEXT NOT NULL,
  status                TEXT NOT NULL,
  total_cop             NUMERIC(14,2) NOT NULL,
  item_count            INTEGER NOT NULL,
  units_count           INTEGER NOT NULL,
  requires_prescription BOOLEAN NOT NULL,
  -- Desnormalizado: items y recetas viajan embebidos como JSONB. La pantalla
  -- de seguimiento NO necesita ningun JOIN para pintarse completa.
  items                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  prescriptions         JSONB NOT NULL DEFAULT '[]'::jsonb,
  timeline              JSONB NOT NULL DEFAULT '[]'::jsonb,
  cancellation_reason   TEXT,
  placed_at             TIMESTAMPTZ NOT NULL,
  -- Trazabilidad de la consistencia eventual: hasta que evento se aplico,
  -- cuando se aplico y que version del agregado refleja.
  last_event_id         BIGINT NOT NULL,
  projected_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version               INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_order_read_model_patient
  ON order_read_model (patient_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_read_model_status
  ON order_read_model (status);
