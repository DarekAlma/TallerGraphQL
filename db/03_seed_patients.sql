-- =====================================================================
-- Afirmative Pill · 03_seed_patients.sql
-- Pacientes de demostracion.
--
-- El taller prohibe autenticar por REST, asi que el login es una MUTATION
-- de GraphQL (`signIn`). Necesitamos entonces usuarios reales en la base.
--
-- Las contrasenas se hashean con bcrypt usando pgcrypto (`crypt` + `gen_salt('bf')`),
-- de modo que el hash NUNCA queda escrito en texto plano en este archivo ni en
-- el repositorio. El backend las verifica con bcryptjs, que es compatible con
-- el formato $2a$ que genera pgcrypto.
--
-- Credenciales de demo (las tres comparten la misma clave):
--   ana.gomez@correo.com     / afirmative123
--   carlos.rueda@correo.com  / afirmative123
--   lucia.mendez@correo.com  / afirmative123
-- =====================================================================

BEGIN;

INSERT INTO patients (id, email, full_name, document_id, password_hash) VALUES
  ('11111111-1111-4111-8111-111111111111', 'ana.gomez@correo.com',
   'Ana María Gómez',   'CC 1.020.334.556', crypt('afirmative123', gen_salt('bf', 10))),
  ('22222222-2222-4222-8222-222222222222', 'carlos.rueda@correo.com',
   'Carlos Rueda',      'CC 79.884.221',    crypt('afirmative123', gen_salt('bf', 10))),
  ('33333333-3333-4333-8333-333333333333', 'lucia.mendez@correo.com',
   'Lucía Méndez',      'CC 52.771.903',    crypt('afirmative123', gen_salt('bf', 10)))
ON CONFLICT (id) DO UPDATE SET
  email         = EXCLUDED.email,
  full_name     = EXCLUDED.full_name,
  document_id   = EXCLUDED.document_id,
  password_hash = EXCLUDED.password_hash;

COMMIT;

SELECT id, email, full_name FROM patients ORDER BY email;
