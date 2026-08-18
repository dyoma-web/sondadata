import type { ColumnProfile, KeyCandidate, TableSource } from '@sondadata/schema';
import type { Stage } from '../pipeline.js';
import type { DuckSession } from '../duckdb.js';

/**
 * Etapa 3 — Llaves primarias (§3.2).
 * Simples: unicidad 100% y 0 nulos, ordenadas por nombre sugerente > tipo >
 * posición > ancho. Compuestas: solo si no hay simple, hasta 2 columnas,
 * podadas. Si nada llega al 100%, se reporta la mejor candidata con su ratio.
 */

const ID_NAME_RE = /(^id$)|(^id_)|(_id$)|(^codigo)|(^cod_)|(_key$)|(^documento$)/;

function nameScore(name: string): number {
  const n = name.toLowerCase();
  if (ID_NAME_RE.test(n)) return 2;
  if (n.includes('id') || n.includes('cod')) return 1;
  return 0;
}
function typeScore(c: ColumnProfile): number {
  if (/INT/.test(c.physicalType.toUpperCase())) return 2;
  if (c.semanticType === 'identifier') return 2;
  if (/UUID/.test(c.physicalType.toUpperCase())) return 2;
  return 0;
}

function rankSimpleCandidates(cols: ColumnProfile[]): ColumnProfile[] {
  return [...cols].sort((a, b) => {
    const byName = nameScore(b.name) - nameScore(a.name);
    if (byName !== 0) return byName;
    const byType = typeScore(b) - typeScore(a);
    if (byType !== 0) return byType;
    if (a.position !== b.position) return a.position - b.position;
    return (a.lengthAvg ?? 0) - (b.lengthAvg ?? 0);
  });
}

async function findComposite(
  session: DuckSession,
  source: TableSource,
): Promise<KeyCandidate | null> {
  // Poda: fuera cardinalidad 1, texto libre, fechas con hora y medidas
  // (dinero, porcentajes, números sueltos): una medida no identifica filas.
  const eligible = source.columns
    .filter(
      (c) =>
        c.distinctCount > 1 &&
        !['free_text', 'datetime', 'currency', 'percentage', 'number'].includes(c.semanticType) &&
        c.nullCount === 0,
    )
    .sort((a, b) => b.uniquenessRatio - a.uniquenessRatio)
    .slice(0, 6); // solo las 6 más prometedoras

  const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
  let best: KeyCandidate | null = null;
  let checks = 0;
  for (let i = 0; i < eligible.length && checks < 12; i++) {
    for (let j = i + 1; j < eligible.length && checks < 12; j++) {
      const a = eligible[i]!;
      const b = eligible[j]!;
      // prueba primero combinaciones cuyo producto de cardinalidades supere el conteo
      if (a.distinctCount * b.distinctCount < source.rowCount) continue;
      checks++;
      const sql = `SELECT COUNT(DISTINCT (${q(a.name)}::VARCHAR || '' || ${q(b.name)}::VARCHAR))::INT AS nd, COUNT(*)::INT AS n FROM "${source.id}"`;
      const row = (await session.query<{ nd: number; n: number }>(sql))[0]!;
      const ratio = row.n > 0 ? row.nd / row.n : 0;
      if (!best || ratio > best.uniquenessRatio) {
        best = {
          sourceId: source.id,
          columns: [a.name, b.name],
          kind: 'composite',
          uniquenessRatio: ratio,
          nullCount: 0,
          isExact: ratio === 1,
          evidence: { label: 'Unicidad de la combinación', sql, result: row, sampleSize: null, totalRows: row.n },
        };
        if (ratio === 1) return best;
      }
    }
  }
  return best;
}

export const keysStage: Stage = {
  name: 'keys',
  run: async ({ session, report, emit }) => {
    for (const source of report.sources) {
      if (source.rowCount === 0 || source.columns.length === 0) continue;

      // Las medidas (dinero, porcentajes, números sueltos) no son identificadores
      // aunque resulten únicas por casualidad en tablas pequeñas.
      const MEASURE_TYPES = new Set(['currency', 'percentage', 'number']);
      const exact = rankSimpleCandidates(
        source.columns.filter(
          (c) =>
            c.uniquenessRatio === 1 &&
            c.nullCount === 0 &&
            c.rowCount > 0 &&
            !MEASURE_TYPES.has(c.semanticType) &&
            !(c.semanticType === 'free_text'),
        ),
      );
      if (exact.length > 0) {
        const col = exact[0]!;
        report.keyCandidates.push({
          sourceId: source.id,
          columns: [col.name],
          kind: 'simple',
          uniquenessRatio: 1,
          nullCount: 0,
          isExact: true,
          evidence: {
            label: 'Unicidad verificada en el perfilado',
            sql: `SELECT COUNT(DISTINCT "${col.name}")::INT AS nd, COUNT(*)::INT AS n FROM "${source.id}"`,
            result: { nd: col.distinctCount, n: col.rowCount },
            sampleSize: null,
            totalRows: col.rowCount,
          },
        });
        emit('keys', `«${source.businessName}»: identificador encontrado (${col.name}).`);
        continue;
      }

      // Sin candidata simple exacta → compuesta de 2 columnas
      const composite = await findComposite(session, source);
      if (composite && composite.uniquenessRatio > 0.99) {
        report.keyCandidates.push(composite);
        emit('keys', `«${source.businessName}»: identificador compuesto (${composite.columns.join(' + ')}).`);
        continue;
      }

      // Mejor candidata imperfecta: se reporta con su ratio real
      const bestImperfect = rankSimpleCandidates(source.columns.filter((c) => c.uniquenessRatio > 0.5));
      const cand = bestImperfect[0];
      if (cand) {
        const repeated = cand.rowCount - cand.distinctCount;
        report.keyCandidates.push({
          sourceId: source.id,
          columns: [cand.name],
          kind: 'simple',
          uniquenessRatio: cand.uniquenessRatio,
          nullCount: cand.nullCount,
          isExact: false,
          evidence: {
            label: 'Mejor candidata (imperfecta)',
            sql: `SELECT COUNT(DISTINCT "${cand.name}")::INT AS nd, COUNT(*)::INT AS n FROM "${source.id}"`,
            result: { nd: cand.distinctCount, n: cand.rowCount },
            sampleSize: null,
            totalRows: cand.rowCount,
          },
        });
        emit(
          'keys',
          `«${source.businessName}»: no hay un identificador perfecto; el mejor es ${cand.name} con ${repeated.toLocaleString('es')} repetidos.`,
        );
      } else {
        emit('keys', `«${source.businessName}»: ninguna columna identifica sus filas.`);
      }
    }
  },
};
