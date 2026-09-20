/**
 * Diagnostico rapido de la conexion y del estado de Supabase.
 *
 *     npm run db:check
 *
 * Util antes de grabar el video: confirma de un vistazo que la conexion vive,
 * que el dataset esta completo, que los indices existen y que no hay eventos
 * de dominio atascados sin proyectar.
 */
import { pool } from '../src/db/pool.js';
import { log, color } from '../src/shared/logger.js';

async function main() {
  log.rule('DIAGNOSTICO DE SUPABASE');

  const client = await pool.connect();
  try {
    const version = await client.query<{ v: string }>('SELECT version() AS v');
    log.ok(version.rows[0].v.split(',')[0]);

    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM medications)::int      AS medicamentos,
        (SELECT COUNT(*) FROM categories)::int       AS categorias,
        (SELECT COUNT(*) FROM manufacturers)::int    AS laboratorios,
        (SELECT COUNT(*) FROM patients)::int         AS pacientes,
        (SELECT COUNT(*) FROM carts)::int            AS carritos,
        (SELECT COUNT(*) FROM orders)::int           AS ordenes,
        (SELECT COUNT(*) FROM order_read_model)::int AS proyecciones,
        (SELECT COUNT(*) FROM domain_events)::int    AS eventos,
        (SELECT COUNT(*) FROM domain_events WHERE processed_at IS NULL)::int AS pendientes
    `);
    const c = counts.rows[0];

    console.log(`
  ${color.bold}CATALOGO${color.reset} (lado lectura)
    medicamentos ......... ${c.medicamentos}
    categorias ........... ${c.categorias}
    laboratorios ......... ${c.laboratorios}

  ${color.bold}WRITE MODEL${color.reset} (lado escritura)
    pacientes ............ ${c.pacientes}
    carritos ............. ${c.carritos}
    ordenes .............. ${c.ordenes}

  ${color.bold}CQRS${color.reset} (event store y proyecciones)
    eventos de dominio ... ${c.eventos}
    proyecciones ......... ${c.proyecciones}
    sin proyectar ........ ${c.pendientes}${c.pendientes > 0 ? '  <-- el outbox poller los recuperara' : ''}
`);

    const indexes = await client.query<{ tablename: string; indexname: string }>(
      `SELECT tablename, indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
        ORDER BY tablename, indexname`,
    );
    console.log(`  ${color.bold}INDICES${color.reset} (${indexes.rowCount} definidos)`);
    for (const i of indexes.rows) console.log(`    ${i.tablename.padEnd(20)} ${i.indexname}`);

    // Comprobacion de que el buscador del catalogo usa el indice GIN de
    // trigramas y no cae en un escaneo secuencial.
    const plan = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM medications WHERE name ILIKE '%amox%'`,
    );
    const planText = plan.rows.map((r) => r['QUERY PLAN']).join(' ');
    console.log(`\n  ${color.bold}PLAN DE BUSQUEDA${color.reset} (ILIKE '%amox%')`);
    for (const r of plan.rows) console.log(`    ${r['QUERY PLAN']}`);
    if (/Bitmap Index Scan|Index Scan/.test(planText)) {
      log.ok('La busqueda por texto usa indice.');
    } else {
      log.warn(
        'El planificador eligio escaneo secuencial. Con 50 filas es lo normal y ' +
          'lo mas rapido; el indice GIN entra en juego al crecer la tabla.',
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  log.error(error.message);
  process.exit(1);
});
