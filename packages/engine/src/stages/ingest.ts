import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { TableSource } from '@sondadata/schema';
import type { PipelineContext, Stage } from '../pipeline.js';
import { readWorkbook, toCsv } from '../xlsx.js';

/** Extensiones legibles. XLSX pasa por el intérprete de "Excel humano". */
const READABLE = new Set(['.csv', '.tsv', '.parquet', '.json', '.jsonl', '.xlsx']);

function readerFor(ext: string, path: string): string {
  const p = path.replace(/'/g, "''");
  switch (ext) {
    case '.csv':
    case '.tsv':
      return `read_csv('${p}', auto_detect=true)`;
    case '.parquet':
      return `read_parquet('${p}')`;
    case '.json':
    case '.jsonl':
      return `read_json('${p}', auto_detect=true)`;
    default:
      throw new Error(`Extensión no soportada: ${ext}`);
  }
}

/**
 * Nombre de tabla DETERMINISTA a partir del archivo (y hoja): mismo input ⇒
 * mismo id de fuente ⇒ el SQL guardado en el artefacto sigue siendo válido si
 * se vuelve a ingerir el mismo directorio (ejecución de cruces y puentes).
 */
function newTableName(fileName: string, suffix = ''): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
  const hash = createHash('sha1').update(`${fileName}${suffix}`).digest('hex').slice(0, 6);
  return `src_${base}${suffix}_${hash}`;
}

function fileSource(partial: Partial<TableSource> & Pick<TableSource, 'id' | 'technicalName' | 'origin'>): TableSource {
  return {
    businessName: partial.technicalName.replace(/\.[^.]+$/, ''),
    rowCount: 0,
    columns: [],
    ingestWarnings: [],
    ...partial,
  } as TableSource;
}

async function ingestFlatFile(ctx: PipelineContext, fileName: string, path: string, contentHash: string): Promise<void> {
  const { session, report, emit } = ctx;
  const ext = extname(fileName).toLowerCase();
  const tableName = newTableName(fileName);
  await session.run(`CREATE TABLE "${tableName}" AS SELECT * FROM ${readerFor(ext, path)}`);
  const rowCount = await session.scalar<number>(`SELECT COUNT(*)::INT AS n FROM "${tableName}"`);
  report.sources.push(
    fileSource({
      id: tableName,
      technicalName: fileName,
      origin: { kind: 'file', fileName, sheet: null, range: null, contentHash, interpretation: null },
      rowCount,
    }),
  );
  emit('ingest', `«${fileName}»: ${rowCount.toLocaleString('es')} filas.`);
}

async function ingestXlsx(ctx: PipelineContext, fileName: string, path: string, contentHash: string): Promise<void> {
  const { session, report, emit } = ctx;
  const sheets = await readWorkbook(path);
  if (sheets.length === 0) {
    throw new Error('El archivo no contiene ninguna hoja con datos tabulares.');
  }
  for (const interp of sheets) {
    const tableName = newTableName(fileName, `_${interp.sheetName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20)}`);
    const staged = join(session.stagingDir(), `${tableName}.csv`);
    writeFileSync(staged, toCsv(interp), 'utf8');
    await session.run(`CREATE TABLE "${tableName}" AS SELECT * FROM ${readerFor('.csv', staged)}`);
    const rowCount = await session.scalar<number>(`SELECT COUNT(*)::INT AS n FROM "${tableName}"`);
    report.sources.push(
      fileSource({
        id: tableName,
        technicalName: fileName,
        businessName: sheets.length > 1 ? `${fileName.replace(/\.[^.]+$/, '')} · ${interp.sheetName}` : fileName.replace(/\.[^.]+$/, ''),
        origin: {
          kind: 'file',
          fileName,
          sheet: interp.sheetName,
          range: `fila ${interp.headerRow + 1} a ${interp.headerRow + interp.dataRows.length}`,
          contentHash,
          interpretation: {
            headerRow: interp.headerRow,
            discardedRows: interp.discardedRows,
            confirmedByUser: false,
          },
        },
        rowCount,
        ingestWarnings: interp.warnings,
      }),
    );
    emit(
      'ingest',
      `«${fileName}» · hoja «${interp.sheetName}»: ${rowCount.toLocaleString('es')} filas` +
        (interp.headerRow > 1 ? ` (encabezado detectado en la fila ${interp.headerRow}).` : '.'),
    );
  }
}

/**
 * Etapa 1 — Ingesta: registra cada archivo legible como tabla DuckDB con su
 * procedencia (nombre, hoja, rango, hash). Los XLSX pasan por la detección de
 * "Excel humano" y llevan su interpretación en el artefacto para que la UI la
 * muestre y el usuario la confirme.
 */
export const ingestStage: Stage = {
  name: 'ingest',
  run: async (ctx) => {
    const { inputDir, report, emit } = ctx;

    // Fuente = base de datos viva (solo lectura, con muestreo)
    if (ctx.connection) {
      const { ingestDatabase } = await import('./ingest-db.js');
      await ingestDatabase(ctx);
      return;
    }

    const files = readdirSync(inputDir)
      .filter((f) => READABLE.has(extname(f).toLowerCase()))
      .filter((f) => f !== 'expected.json') // manifest del fixture, no es una fuente
      .sort();

    for (const fileName of files) {
      const path = join(inputDir, fileName);
      const ext = extname(fileName).toLowerCase();
      const contentHash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
      try {
        if (ext === '.xlsx') {
          await ingestXlsx(ctx, fileName, path, contentHash);
        } else {
          await ingestFlatFile(ctx, fileName, path, contentHash);
        }
      } catch (err) {
        // Un archivo corrupto no tumba el job: se registra y se continúa.
        report.sources.push(
          fileSource({
            id: newTableName(fileName, '_err'),
            technicalName: fileName,
            origin: { kind: 'file', fileName, sheet: null, range: null, contentHash, interpretation: null },
            ingestWarnings: [`No se pudo leer: ${err instanceof Error ? err.message : String(err)}`],
          }),
        );
        emit('ingest', `«${fileName}» no se pudo leer; el resto del análisis continúa.`);
      }
    }
  },
};
