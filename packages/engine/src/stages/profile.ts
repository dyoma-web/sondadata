import type { ColumnProfile } from '@sondadata/schema';
import type { Stage } from '../pipeline.js';
import type { DuckSession } from '../duckdb.js';
import { inferSemantic, maskValue } from '../semantic.js';

/** Valores que son "vacío" sin ser NULL. */
const EMPTY_LIKE = `('', 'N/A', 'NA', 'n/a', '-', 'NULL', 'null', '#N/A', '#REF!', 'S/D', 's/d')`;

interface BaseStats {
  n: number;
  nn: number;
  nd: number;
  mn: string | null;
  mx: string | null;
}

async function profileColumn(
  session: DuckSession,
  table: string,
  col: { name: string; type: string },
  position: number,
): Promise<ColumnProfile> {
  const q = `"${col.name.replace(/"/g, '""')}"`;
  const t = `"${table}"`;
  const isNumeric = /INT|DECIMAL|DOUBLE|FLOAT|HUGEINT/.test(col.type.toUpperCase());
  const isVarchar = /VARCHAR|TEXT|STRING/.test(col.type.toUpperCase());

  const base = (
    await session.query<BaseStats>(`
      SELECT COUNT(*)::INT AS n,
             COUNT(${q})::INT AS nn,
             COUNT(DISTINCT ${q})::INT AS nd,
             MIN(${q})::VARCHAR AS mn,
             MAX(${q})::VARCHAR AS mx
      FROM ${t}`)
  )[0]!;

  const emptyLike = isVarchar
    ? await session.scalar<number>(
        `SELECT COALESCE(SUM(CASE WHEN trim(${q}) IN ${EMPTY_LIKE} THEN 1 ELSE 0 END), 0)::INT FROM ${t} WHERE ${q} IS NOT NULL`,
      )
    : 0;

  let mean: number | null = null;
  let median: number | null = null;
  let p95: number | null = null;
  if (isNumeric) {
    const stats = (
      await session.query<{ mean: number | null; med: number | null; p95: number | null }>(
        `SELECT AVG(${q})::DOUBLE AS mean, MEDIAN(${q})::DOUBLE AS med, QUANTILE_CONT(${q}, 0.95)::DOUBLE AS p95 FROM ${t}`,
      )
    )[0]!;
    mean = stats.mean;
    median = stats.med;
    p95 = stats.p95;
  }

  let lengthMin: number | null = null;
  let lengthMax: number | null = null;
  let lengthAvg: number | null = null;
  if (isVarchar) {
    const len = (
      await session.query<{ lmin: number | null; lmax: number | null; lavg: number | null }>(
        `SELECT MIN(LENGTH(${q}))::INT AS lmin, MAX(LENGTH(${q}))::INT AS lmax, AVG(LENGTH(${q}))::DOUBLE AS lavg FROM ${t} WHERE ${q} IS NOT NULL`,
      )
    )[0]!;
    lengthMin = len.lmin;
    lengthMax = len.lmax;
    lengthAvg = len.lavg;
  }

  const topValues = (
    await session.query<{ v: string; c: number }>(
      `SELECT ${q}::VARCHAR AS v, COUNT(*)::INT AS c FROM ${t} WHERE ${q} IS NOT NULL GROUP BY 1 ORDER BY c DESC, v LIMIT 20`,
    )
  ).map((r) => ({ value: r.v, count: r.c }));

  // Patrones dominantes: dígitos → 9, letras → A (colapsando repeticiones largas no; spec pide colapso simple)
  const dominantPatterns = isVarchar
    ? (
        await session.query<{ p: string; c: number }>(
          `SELECT regexp_replace(regexp_replace(${q}::VARCHAR, '[0-9]', '9', 'g'), '[A-Za-zÁÉÍÓÚÑáéíóúñ]', 'A', 'g') AS p,
                  COUNT(*)::INT AS c
           FROM ${t} WHERE ${q} IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 3`,
        )
      ).map((r) => ({ pattern: r.p, share: base.nn > 0 ? r.c / base.nn : 0 }))
    : [];

  const uniquenessRatio = base.nn > 0 ? base.nd / base.nn : 0;
  const semantic = inferSemantic({
    name: col.name,
    physicalType: col.type,
    topValues,
    distinctCount: base.nd,
    rowCount: base.n,
    avgLength: lengthAvg,
    uniquenessRatio,
  });

  // Datos personales: los valores nunca salen del worker sin máscara.
  const personal = semantic.isPersonalData;
  return {
    name: col.name,
    position,
    physicalType: col.type,
    semanticType: semantic.semanticType,
    semanticConfidence: semantic.confidence,
    isPersonalData: personal,
    rowCount: base.n,
    nullCount: base.n - base.nn,
    emptyLikeCount: emptyLike,
    distinctCount: base.nd,
    uniquenessRatio,
    min: personal ? null : base.mn,
    max: personal ? null : base.mx,
    mean,
    median,
    p95,
    topValues: personal ? topValues.map((tv) => ({ value: maskValue(tv.value), count: tv.count })) : topValues,
    lengthMin,
    lengthMax,
    lengthAvg,
    dominantPatterns,
    risks: semantic.risks,
  };
}

/**
 * Etapa 2 — Perfilado por columna (§3.1): tipo físico y semántico, nulos y
 * vacíos-que-no-son-nulos, cardinalidad, stats, top-20, longitudes, patrones
 * dominantes y marcado de datos personales (con enmascaramiento obligatorio).
 */
export const profileStage: Stage = {
  name: 'profile',
  run: async ({ session, report, emit }) => {
    for (const source of report.sources) {
      if (source.rowCount === 0) continue;
      const cols = await session.query<{ column_name: string; column_type: string }>(
        `DESCRIBE "${source.id}"`,
      );
      const profiles: ColumnProfile[] = [];
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i]!;
        profiles.push(await profileColumn(session, source.id, { name: c.column_name, type: c.column_type }, i));
      }
      source.columns = profiles;
      const personales = profiles.filter((p) => p.isPersonalData).length;
      emit(
        'profile',
        `«${source.technicalName}»: ${profiles.length} columnas entendidas` +
          (personales > 0 ? `, ${personales} con datos personales (enmascaradas).` : '.'),
      );
    }
  },
};
