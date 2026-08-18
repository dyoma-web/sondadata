import { emptyReport, PRODUCT, type AnalysisReport, type DbConnection } from '@sondadata/schema';
import { DuckSession } from './duckdb.js';
import { ingestStage } from './stages/ingest.js';
import { normalizeSql, type NormalizationChain } from './normalize.js';

/**
 * Ejecución de cruces y puentes (el "segundo paso explícito" de la spec §3.7):
 * re-ingiere la fuente del job en una sesión efímera nueva (los nombres de
 * tabla son deterministas, así que el SQL del artefacto sigue siendo válido),
 * materializa el resultado y lo exporta saneado. Nunca toca las fuentes.
 */

export interface ExecutedResult {
  rows: number;
  outputPath: string;
}

async function withIngestedSession<T>(
  jobId: string,
  inputDir: string,
  connection: DbConnection | null,
  fn: (session: DuckSession, report: AnalysisReport) => Promise<T>,
): Promise<T> {
  const session = await DuckSession.createEphemeral(`exec-${jobId}`);
  try {
    const report = emptyReport({
      jobId,
      projectName: 'exec',
      engineVersion: PRODUCT.engineVersion,
      schemaVersion: PRODUCT.schemaVersion,
      seed: 1,
    });
    await ingestStage.run({ session, inputDir, connection, report, emit: () => {} });
    return await fn(session, report);
  } finally {
    await session.destroy();
  }
}

const q = (n: string) => `"${n.replace(/"/g, '""')}"`;

/**
 * Exporta una consulta a CSV neutralizando la inyección de fórmulas: toda celda
 * de texto que empiece por `=`, `+`, `@` (o `-` sin ser un número) se prefija
 * con un apóstrofo para que una hoja de cálculo no la ejecute.
 */
async function copySanitized(session: DuckSession, query: string, outputPath: string): Promise<number> {
  await session.run(`CREATE OR REPLACE TEMP VIEW _sondadata_res AS ${query}`);
  const cols = await session.query<{ column_name: string; column_type: string }>(`DESCRIBE _sondadata_res`);
  const selectList = cols
    .map((c) => {
      if (!/VARCHAR|TEXT/.test(c.column_type.toUpperCase())) return q(c.column_name);
      const col = q(c.column_name);
      return `CASE WHEN regexp_matches(${col}, '^[=+@]') OR regexp_matches(${col}, '^-[^0-9.]')
        THEN chr(39) || ${col} ELSE ${col} END AS ${q(c.column_name)}`;
    })
    .join(', ');
  const out = outputPath.replace(/\\/g, '/').replace(/'/g, "''");
  await session.run(`COPY (SELECT ${selectList} FROM _sondadata_res) TO '${out}' (HEADER, DELIMITER ',')`);
  return session.scalar<number>(`SELECT COUNT(*)::INT FROM _sondadata_res`);
}

export async function executeJoin(params: {
  jobId: string;
  inputDir: string;
  connection?: DbConnection | null;
  leftSourceId: string;
  rightSourceId: string;
  leftColumn: string;
  rightColumn: string;
  chain: NormalizationChain;
  outputPath: string;
}): Promise<ExecutedResult> {
  return withIngestedSession(params.jobId, params.inputDir, params.connection ?? null, async (session) => {
    const el = normalizeSql(`l.${q(params.leftColumn)}`, params.chain);
    const er = normalizeSql(`r.${q(params.rightColumn)}`, params.chain);
    const joinSql = `SELECT l.*, r.* FROM "${params.leftSourceId}" l LEFT JOIN "${params.rightSourceId}" r ON ${el} = ${er}`;
    const rows = await copySanitized(session, joinSql, params.outputPath);
    return { rows, outputPath: params.outputPath };
  });
}

export async function executeBridge(params: {
  jobId: string;
  inputDir: string;
  connection?: DbConnection | null;
  populateSql: string;
  outputPath: string;
}): Promise<ExecutedResult> {
  return withIngestedSession(params.jobId, params.inputDir, params.connection ?? null, async (session) => {
    const rows = await copySanitized(session, params.populateSql, params.outputPath);
    return { rows, outputPath: params.outputPath };
  });
}
