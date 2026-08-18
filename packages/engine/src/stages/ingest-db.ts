import type { DbConnection } from '@sondadata/schema';
import type { PipelineContext } from '../pipeline.js';

/**
 * Ingesta desde una base de datos viva (§2): SIEMPRE de solo lectura
 * (ATTACH … READ_ONLY), primero metadatos y luego una muestra acotada por
 * tabla. Nunca se copia una tabla completa por encima del límite configurado
 * y jamás se emite una sentencia de escritura contra la fuente.
 */

/** Quita credenciales de cualquier mensaje de error antes de propagarlo. */
export function sanitizeDbError(message: string, conn: DbConnection): string {
  let out = message;
  for (const secret of [conn.password, conn.user, conn.host]) {
    if (secret && secret.length > 0) out = out.split(secret).join('•••');
  }
  return out.slice(0, 300);
}

function attachString(conn: DbConnection): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const parts = [
    `host=${esc(conn.host)}`,
    `port=${conn.port}`,
    conn.engine === 'postgresql' ? `dbname=${esc(conn.database)}` : `database=${esc(conn.database)}`,
    `user=${esc(conn.user)}`,
  ];
  // un password vacío rompe el parser del DSN: se omite
  if (conn.password !== '') parts.push(`password=${esc(conn.password)}`);
  return parts.join(' ');
}

export async function ingestDatabase(ctx: PipelineContext): Promise<void> {
  const { session, report, emit } = ctx;
  const conn = ctx.connection!;
  const ext = conn.engine === 'postgresql' ? 'postgres' : 'mysql';

  await session.run(`INSTALL ${ext}; LOAD ${ext};`);
  await session.run(
    `ATTACH '${attachString(conn)}' AS ext_db (TYPE ${ext}, READ_ONLY)`,
  );
  emit('ingest', `Conexión de solo lectura establecida con ${conn.database}.`);

  // 1) metadatos primero: lista de tablas del esquema
  // Solo el esquema pedido: en MySQL el "schema" es la propia base de datos.
  const schemaFilter = conn.engine === 'postgresql' ? (conn.schemaName ?? 'public') : conn.database;
  const tables = await session.query<{ table_name: string; schema_name: string }>(
    `SELECT table_name, schema_name FROM duckdb_tables() WHERE database_name = 'ext_db'
     AND schema_name = '${schemaFilter.replace(/'/g, "''")}'
     ORDER BY table_name LIMIT 200`,
  );
  emit('ingest', `${tables.length} tablas encontradas en el esquema.`);

  for (const t of tables) {
    const tableName = `src_db_${t.table_name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}`;
    const fq = `ext_db."${t.schema_name.replace(/"/g, '""')}"."${t.table_name.replace(/"/g, '""')}"`;
    try {
      const total = await session.scalar<number>(`SELECT COUNT(*)::BIGINT FROM ${fq}`);
      const sampled = total > conn.sampleRows;
      // 2) muestra acotada: nunca la tabla completa por encima del límite
      await session.run(
        `CREATE TABLE "${tableName}" AS SELECT * FROM ${fq} ${sampled ? `USING SAMPLE ${conn.sampleRows} ROWS` : ''}`,
      );
      const rowCount = await session.scalar<number>(`SELECT COUNT(*)::INT FROM "${tableName}"`);
      report.sources.push({
        id: tableName,
        technicalName: t.table_name,
        businessName: t.table_name,
        origin: {
          kind: 'database',
          engine: conn.engine,
          schemaName: t.schema_name,
          tableName: t.table_name,
          sampled,
          sampleRows: sampled ? conn.sampleRows : null,
        },
        rowCount,
        columns: [],
        ingestWarnings: sampled
          ? [`Tabla con ${total.toLocaleString('es')} filas; se analizó una muestra de ${conn.sampleRows.toLocaleString('es')}.`]
          : [],
      });
      emit('ingest', `«${t.table_name}»: ${rowCount.toLocaleString('es')} filas${sampled ? ' (muestra)' : ''}.`);
    } catch (err) {
      report.sources.push({
        id: tableName,
        technicalName: t.table_name,
        businessName: t.table_name,
        origin: { kind: 'database', engine: conn.engine, schemaName: t.schema_name, tableName: t.table_name, sampled: false, sampleRows: null },
        rowCount: 0,
        columns: [],
        ingestWarnings: [`No se pudo leer: ${sanitizeDbError(err instanceof Error ? err.message : String(err), conn)}`],
      });
      emit('ingest', `«${t.table_name}» no se pudo leer; el resto continúa.`);
    }
  }
  await session.run(`DETACH ext_db`);
}
