/**
 * Instalador de la base de datos en Supabase.
 *
 * Ejecuta, en orden, los tres archivos de `db/`:
 *   01_schema.sql        · tablas, indices y secuencia
 *   02_seed_catalog.sql  · los 50 medicamentos del dataset del taller
 *   03_seed_patients.sql · pacientes de demostracion
 *
 * Alternativa manual: pegar esos mismos archivos en el SQL Editor de Supabase.
 * Este script existe para que la carga sea reproducible con un solo comando:
 *
 *     npm run db:setup
 *
 * Es idempotente. Re-ejecutarlo no duplica datos ni rompe nada.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import { log, color } from '../src/shared/logger.js';

const FILES = ['01_schema.sql', '02_seed_catalog.sql', '03_seed_patients.sql'];

async function run() {
  log.rule('INSTALACION DE LA BASE DE DATOS EN SUPABASE');

  const client = await pool.connect();
  try {
    for (const file of FILES) {
      const path = fileURLToPath(new URL(`../../db/${file}`, import.meta.url));
      const sql = readFileSync(path, 'utf8');

      log.info(`Ejecutando ${color.bold}${file}${color.reset} (${(sql.length / 1024).toFixed(1)} KB)...`);
      const started = Date.now();
      await client.query(sql);
      log.ok(`${file} aplicado en ${Date.now() - started}ms`);
    }

    /* --- Verificacion: los numeros deben coincidir con el dataset --- */
    const { rows } = await client.query<{
      medicamentos: number;
      categorias: number;
      laboratorios: number;
      con_formula: number;
      pacientes: number;
    }>(`SELECT
          (SELECT COUNT(*) FROM medications)::int                             AS medicamentos,
          (SELECT COUNT(*) FROM categories)::int                              AS categorias,
          (SELECT COUNT(*) FROM manufacturers)::int                           AS laboratorios,
          (SELECT COUNT(*) FROM medications WHERE requires_prescription)::int AS con_formula,
          (SELECT COUNT(*) FROM patients)::int                                AS pacientes`);

    const r = rows[0];
    log.rule('VERIFICACION');
    console.log(`  Medicamentos cargados ....... ${r.medicamentos}  (esperado: 50)`);
    console.log(`  Categorias terapeuticas ..... ${r.categorias}  (esperado: 14)`);
    console.log(`  Laboratorios ................ ${r.laboratorios}  (esperado: 16)`);
    console.log(`  Con formula medica .......... ${r.con_formula}  (esperado: 27)`);
    console.log(`  Pacientes de demo ........... ${r.pacientes}  (esperado: 3)`);

    if (r.medicamentos === 50 && r.categorias === 14 && r.laboratorios === 16 && r.pacientes === 3) {
      log.ok('Base de datos lista. Ya puedes arrancar el backend con `npm run dev`.');
    } else {
      log.warn('Los conteos no coinciden con lo esperado; revisa los mensajes anteriores.');
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  log.error(`Fallo la instalacion: ${error.message}`);
  if (error.message?.includes('SASL') || error.message?.includes('password')) {
    log.warn('Revisa DATABASE_URL en server/.env: usuario o contrasena incorrectos.');
    log.warn('Si la contrasena tiene caracteres especiales, codificalos (@ -> %40, # -> %23).');
  }
  if (error.message?.includes('ENOTFOUND') || error.message?.includes('ETIMEDOUT')) {
    log.warn('No se pudo alcanzar el host. Verifica que copiaste el "Session pooler" de Supabase.');
  }
  process.exit(1);
});
