import type { BridgeProposal, TableSource } from '@sondadata/schema';
import type { Stage } from '../pipeline.js';
import type { DuckSession } from '../duckdb.js';

/**
 * Etapa 5 — Tablas puente (§3.5). Dos casos:
 *
 * 1. Listas embebidas en una celda («salud, educación, agua»): la fuente
 *    número uno de relaciones N:M ocultas en datasets reales de gestión.
 * 2. N:M resuelta por duplicación de filas: una tabla cuya llave real es
 *    compuesta (entidad + entidad) con los atributos de una de ellas copiados.
 *
 * El DDL y el SQL de poblado se generan y se EJECUTAN en la copia DuckDB del
 * job para reportar métricas reales; nada toca las fuentes del usuario y nada
 * se materializa como entregable sin confirmación (meaning.confirmedByUser).
 */

const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
let bridgeCounter = 0;

const SEPARATORS = [', ', '; ', ' | '] as const;

async function detectEmbeddedList(
  session: DuckSession,
  source: TableSource,
  report: { bridgeProposals: BridgeProposal[] },
  keyColumn: string | null,
  emit: (stage: 'bridges', msg: string) => void,
): Promise<void> {
  for (const col of source.columns) {
    if (!/VARCHAR|TEXT/.test(col.physicalType.toUpperCase())) continue;
    if (col.isPersonalData || (col.lengthAvg ?? 0) > 80) continue;

    for (const sep of SEPARATORS) {
      const sepEsc = sep.trim().replace(/'/g, "''");
      const shareSql = `SELECT AVG(CASE WHEN ${q(col.name)} LIKE '%${sepEsc}%' THEN 1.0 ELSE 0.0 END)::DOUBLE AS share
FROM "${source.id}" WHERE ${q(col.name)} IS NOT NULL`;
      const share = await session.scalar<number>(shareSql);
      if (share === null || share < 0.15) continue;

      const idCol = keyColumn ?? source.columns[0]!.name;
      const bridgeName = `${source.businessName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}_${col.name.toLowerCase()}`;
      const populateSql = `SELECT ${q(idCol)}, trim(valor) AS ${q(col.name + '_valor')}
FROM "${source.id}", UNNEST(string_split(${q(col.name)}, '${sepEsc}')) AS t(valor)
WHERE ${q(col.name)} IS NOT NULL AND trim(valor) <> ''`;
      const ddl = `CREATE TABLE ${bridgeName} (
  ${idCol} VARCHAR NOT NULL,
  ${col.name}_valor VARCHAR NOT NULL,
  PRIMARY KEY (${idCol}, ${col.name}_valor)
);`;

      // ejecuta el poblado en la copia local para medir el resultado real
      const tmpName = `bridge_${bridgeCounter}`;
      await session.run(`CREATE TABLE "${tmpName}" AS ${populateSql}`);
      const rows = await session.scalar<number>(`SELECT COUNT(*)::INT FROM "${tmpName}"`);
      const distinctValues = await session.scalar<number>(
        `SELECT COUNT(DISTINCT ${q(col.name + '_valor')})::INT FROM "${tmpName}"`,
      );
      const degrees = (
        await session.query<{ avg_d: number; max_d: number }>(
          `SELECT AVG(d)::DOUBLE AS avg_d, MAX(d)::INT AS max_d FROM (SELECT COUNT(*) AS d FROM "${tmpName}" GROUP BY ${q(idCol)})`,
        )
      )[0]!;

      report.bridgeProposals.push({
        id: `bridge-${bridgeCounter++}`,
        kind: 'embedded_list',
        resolution: 'association',
        title: `${source.businessName} · ${col.name}`,
        description: `${source.rowCount.toLocaleString('es')} filas guardan varios valores en una sola casilla, separados por «${sep.trim()}». Separarlos permite contar y cruzar sin partir la columna a mano.`,
        sourceIds: [source.id],
        proposedTableName: bridgeName,
        meaning: null,
        ddl,
        populateSql,
        resultMetrics: {
          rows,
          orphansLeft: 0,
          orphansRight: 0,
          avgDegreeLeft: degrees.avg_d ?? 0,
          avgDegreeRight: 0,
          maxDegreeLeft: degrees.max_d ?? 0,
          maxDegreeRight: 0,
        },
        evidence: [
          { label: 'Proporción de celdas con lista', sql: shareSql, result: { share }, sampleSize: null, totalRows: source.rowCount },
          {
            label: 'Resultado del poblado (ejecutado en la copia de análisis)',
            sql: populateSql,
            result: { rows, distinctValues },
            sampleSize: null,
            totalRows: null,
          },
        ],
      });
      emit(
        'bridges',
        `«${source.businessName}»: la columna ${col.name} guarda listas; separarla produciría ${rows.toLocaleString('es')} filas con ${distinctValues} valores distintos.`,
      );
      break; // un separador por columna
    }
  }
}

async function detectDuplicationNM(
  session: DuckSession,
  source: TableSource,
  compositeKey: string[],
  report: { bridgeProposals: BridgeProposal[] },
  emit: (stage: 'bridges', msg: string) => void,
): Promise<void> {
  const [colA, colB] = compositeKey;
  if (!colA || !colB) return;

  // Compuerta: solo es una N:M "resuelta por duplicación" si algún atributo
  // depende de UN solo componente de la llave (p.ej. el nombre se repite con el
  // documento). Una tabla de resumen con grano compuesto (municipio × trimestre)
  // no debe generar puente.
  const nonKey = source.columns.filter((c) => !compositeKey.includes(c.name));
  let duplicatedAttrs = 0;
  for (const attr of nonKey.slice(0, 8)) {
    for (const comp of [colA, colB]) {
      const distinct = await session.query<{ nc: number; np: number }>(
        `SELECT COUNT(DISTINCT ${q(comp)})::INT AS nc, COUNT(DISTINCT (${q(comp)}::VARCHAR || '␟' || COALESCE(${q(attr.name)}::VARCHAR,'')))::INT AS np FROM "${source.id}"`,
      );
      const { nc, np } = distinct[0]!;
      if (nc > 1 && np === nc) {
        duplicatedAttrs++;
        break;
      }
    }
  }
  if (duplicatedAttrs === 0) return;

  const attrs = nonKey.map((c) => c.name);

  const bridgeName = `${source.businessName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}_puente`;
  const populateSql = `SELECT DISTINCT ${q(colA)}, ${q(colB)} FROM "${source.id}" WHERE ${q(colA)} IS NOT NULL AND ${q(colB)} IS NOT NULL`;
  const ddl = `CREATE TABLE ${bridgeName} (
  ${colA} VARCHAR NOT NULL,
  ${colB} VARCHAR NOT NULL,
  PRIMARY KEY (${colA}, ${colB})
);`;

  const tmpName = `bridge_${bridgeCounter}`;
  await session.run(`CREATE TABLE "${tmpName}" AS ${populateSql}`);
  const rows = await session.scalar<number>(`SELECT COUNT(*)::INT FROM "${tmpName}"`);
  const distinctA = await session.scalar<number>(`SELECT COUNT(DISTINCT ${q(colA)})::INT FROM "${tmpName}"`);
  const distinctB = await session.scalar<number>(`SELECT COUNT(DISTINCT ${q(colB)})::INT FROM "${tmpName}"`);
  const degA = (
    await session.query<{ avg_d: number; max_d: number }>(
      `SELECT AVG(d)::DOUBLE AS avg_d, MAX(d)::INT AS max_d FROM (SELECT COUNT(*) AS d FROM "${tmpName}" GROUP BY ${q(colA)})`,
    )
  )[0]!;
  const degB = (
    await session.query<{ avg_d: number; max_d: number }>(
      `SELECT AVG(d)::DOUBLE AS avg_d, MAX(d)::INT AS max_d FROM (SELECT COUNT(*) AS d FROM "${tmpName}" GROUP BY ${q(colB)})`,
    )
  )[0]!;

  report.bridgeProposals.push({
    id: `bridge-${bridgeCounter++}`,
    kind: 'n_m',
    resolution: 'association',
    title: `${source.businessName}: ${colA} ↔ ${colB}`,
    description: `Cada ${colA} puede aparecer con varios ${colB} y viceversa; hoy esa relación se resuelve repitiendo filas (los demás datos${attrs.length > 0 ? ` — ${attrs.slice(0, 3).join(', ')}… —` : ''} se copian en cada repetición). Una tabla puente evita contar de más.`,
    sourceIds: [source.id],
    proposedTableName: bridgeName,
    meaning: null,
    ddl,
    populateSql,
    resultMetrics: {
      rows,
      orphansLeft: 0,
      orphansRight: 0,
      avgDegreeLeft: degA.avg_d ?? 0,
      avgDegreeRight: degB.avg_d ?? 0,
      maxDegreeLeft: degA.max_d ?? 0,
      maxDegreeRight: degB.max_d ?? 0,
    },
    evidence: [
      {
        label: 'Pares distintos frente a filas totales',
        sql: populateSql,
        result: { rows, distinctA, distinctB, totalRows: source.rowCount },
        sampleSize: null,
        totalRows: source.rowCount,
      },
    ],
  });
  emit(
    'bridges',
    `«${source.businessName}»: relación de varios a varios entre ${colA} y ${colB}; la tabla puente tendría ${rows.toLocaleString('es')} filas (${distinctA} × ${distinctB}).`,
  );
}

export const bridgesStage: Stage = {
  name: 'bridges',
  run: async ({ session, report, emit }) => {
    for (const source of report.sources) {
      if (source.rowCount === 0 || source.columns.length === 0) continue;
      const key = report.keyCandidates.find((k) => k.sourceId === source.id);

      await detectEmbeddedList(
        session,
        source,
        report,
        key?.kind === 'simple' && key.isExact ? key.columns[0]! : null,
        emit,
      );

      if (key?.kind === 'composite' && key.isExact && key.columns.length === 2) {
        await detectDuplicationNM(session, source, key.columns, report, emit);
      }
    }
  },
};
