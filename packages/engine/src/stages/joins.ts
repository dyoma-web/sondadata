import type { ColumnProfile, JoinPrediction, Relationship, TableSource } from '@sondadata/schema';
import type { PipelineContext, Stage } from '../pipeline.js';
import type { DuckSession } from '../duckdb.js';
import { normalizeSql, type NormalizationChain } from '../normalize.js';
import { nameSimilarity } from '../similarity.js';

/**
 * Etapa 7 — Simulador de cruces (§3.7): predecir ANTES de ejecutar.
 * La estimación de filas se calcula con los histogramas de frecuencia de la
 * llave (sum(freq_izq × freq_der)), nunca adivinando. Sobre el dataset
 * completo del job la estimación es exacta.
 */

const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
let joinCounter = 0;

interface FreqStats {
  inner_rows: number;
  matched_left: number;
  matched_right: number;
  worst_v: string | null;
  worst_lc: number | null;
  worst_rc: number | null;
}

async function computePrediction(
  session: DuckSession,
  report: PipelineContext['report'],
  left: { s: TableSource; col: ColumnProfile },
  right: { s: TableSource; col: ColumnProfile },
  chain: NormalizationChain,
  relationshipId: string | null,
): Promise<JoinPrediction | null> {
  const el = normalizeSql(q(left.col.name), chain);
  const er = normalizeSql(q(right.col.name), chain);
  const sql = `WITH fl AS (SELECT ${el} AS v, COUNT(*) AS c FROM "${left.s.id}" WHERE ${q(left.col.name)} IS NOT NULL GROUP BY 1),
     fr AS (SELECT ${er} AS v, COUNT(*) AS c FROM "${right.s.id}" WHERE ${q(right.col.name)} IS NOT NULL GROUP BY 1),
     j AS (SELECT fl.v, fl.c AS lc, fr.c AS rc, fl.c * fr.c AS p FROM fl JOIN fr USING (v))
SELECT COALESCE((SELECT SUM(p) FROM j), 0)::BIGINT AS inner_rows,
       COALESCE((SELECT SUM(lc) FROM j), 0)::BIGINT AS matched_left,
       COALESCE((SELECT SUM(rc) FROM j), 0)::BIGINT AS matched_right,
       (SELECT v FROM j ORDER BY p DESC LIMIT 1) AS worst_v,
       (SELECT lc FROM j ORDER BY p DESC LIMIT 1)::INT AS worst_lc,
       (SELECT rc FROM j ORDER BY p DESC LIMIT 1)::INT AS worst_rc`;
  const r = (await session.query<FreqStats>(sql))[0]!;
  if (r.inner_rows === 0) return null;

  const leftRows = left.s.rowCount;
  const rightRows = right.s.rowCount;
  const unmatchedLeft = leftRows - r.matched_left;
  const unmatchedRight = rightRows - r.matched_right;
  const multiplier = leftRows > 0 ? r.inner_rows / leftRows : 0;
  const fanOutRisk = multiplier > 3 && r.inner_rows > Math.max(leftRows, rightRows);
  const matchRateLeft = leftRows > 0 ? r.matched_left / leftRows : 0;
  const matchRateRight = rightRows > 0 ? r.matched_right / rightRows : 0;

  // columnas del lado derecho que quedarían mayormente vacías tras un cruce por la izquierda
  const mostlyNull = right.s.columns
    .filter((c) => c.name !== right.col.name)
    .filter((c) => {
      const nullRatio = c.rowCount > 0 ? (c.nullCount + c.emptyLikeCount) / c.rowCount : 1;
      return 1 - matchRateLeft * (1 - nullRatio) > 0.6;
    })
    .map((c) => c.name)
    .slice(0, 6);

  // catálogo de indicadores: métrica × dimensión × [tiempo], entre ambos lados
  const isMetric = (c: ColumnProfile) => ['currency', 'number', 'integer', 'percentage'].includes(c.semanticType) && !c.isPersonalData;
  const isDim = (c: ColumnProfile) => ['category', 'geo_admin', 'boolean_coded'].includes(c.semanticType) && c.distinctCount >= 3 && c.distinctCount <= 50 && !c.isPersonalData;
  const isTime = (c: ColumnProfile) => ['date', 'datetime'].includes(c.semanticType) && c.risks.length === 0;

  const indicators: JoinPrediction['indicators'] = [];
  const sides: [{ s: TableSource; col: ColumnProfile }, { s: TableSource; col: ColumnProfile }][] = [
    [left, right],
    [right, left],
  ];
  for (const [mSide, dSide] of sides) {
    for (const metric of mSide.s.columns.filter(isMetric).slice(0, 3)) {
      for (const dim of dSide.s.columns.filter(isDim).slice(0, 3)) {
        const time = [...mSide.s.columns, ...dSide.s.columns].find(isTime) ?? null;
        const metricNull = metric.rowCount > 0 ? (metric.nullCount + metric.emptyLikeCount) / metric.rowCount : 1;
        const coverage = Math.max(0, Math.min(1, matchRateLeft * (1 - metricNull)));
        if (coverage < 0.1) continue;
        const joinOn = `${normalizeSql(`l.${q(left.col.name)}`, chain)} = ${normalizeSql(`r.${q(right.col.name)}`, chain)}`;
        const mAlias = mSide.s.id === left.s.id ? 'l' : 'r';
        const dAlias = dSide.s.id === left.s.id ? 'l' : 'r';
        const timeAlias = time ? (mSide.s.columns.includes(time) ? mAlias : dAlias) : null;
        const timeSel = time ? `, date_trunc('quarter', ${timeAlias}.${q(time.name)}::DATE) AS trimestre` : '';
        const timeGroup = time ? ', 2' : '';
        indicators.push({
          id: `ind-${joinCounter}-${indicators.length}`,
          title: `${/currency/.test(metric.semanticType) ? 'Valor de' : 'Total de'} ${metric.name} por ${dim.name}${time ? ' y por trimestre' : ''}`,
          description: `Suma de «${metric.name}» (${mSide.s.businessName}) desglosada por «${dim.name}» (${dSide.s.businessName})${time ? ` a lo largo del tiempo usando «${time.name}»` : ''}.`,
          metricColumn: metric.name,
          dimensionColumn: dim.name,
          timeColumn: time?.name ?? null,
          coverage,
          sql: `SELECT ${dAlias}.${q(dim.name)}${timeSel},
       SUM(${mAlias}.${q(metric.name)}) AS total,
       COUNT(*) AS registros
FROM '${left.s.technicalName}' l
JOIN '${right.s.technicalName}' r ON ${joinOn}
GROUP BY 1${timeGroup}
ORDER BY total DESC;`,
        });
      }
    }
  }
  indicators.sort((a, b) => b.coverage - a.coverage || Number(b.timeColumn !== null) - Number(a.timeColumn !== null));

  const maskWorst = left.col.isPersonalData || right.col.isPersonalData;
  return {
    id: `join-${joinCounter++}`,
    leftSourceId: left.s.id,
    rightSourceId: right.s.id,
    relationshipId,
    keys: [{ left: left.col.name, right: right.col.name }],
    normalizations: chain === 'exact' ? [] : [chain],
    expectedRows: {
      inner: { value: r.inner_rows, exact: true },
      left: { value: r.inner_rows + unmatchedLeft, exact: true },
      full: { value: r.inner_rows + unmatchedLeft + unmatchedRight, exact: true },
    },
    matchRate: { leftInRight: matchRateLeft, rightInLeft: matchRateRight },
    unmatchedLeft,
    unmatchedRight,
    mostlyNullColumnsAfterJoin: mostlyNull,
    fanOut: {
      risk: fanOutRisk,
      multiplier: Math.round(multiplier * 10) / 10,
      worstKey:
        r.worst_v !== null
          ? { value: maskWorst ? '•••' : String(r.worst_v), leftCount: r.worst_lc ?? 0, rightCount: r.worst_rc ?? 0 }
          : null,
      plainWarning: fanOutRisk
        ? `Esta unión produciría ${r.inner_rows.toLocaleString('es')} filas a partir de ${leftRows.toLocaleString('es')}; casi seguro no es lo que quieres. La causa es que «${left.col.name}» no identifica un registro único: el peor caso es «${maskWorst ? '•••' : r.worst_v}» (${r.worst_lc} × ${r.worst_rc}).`
        : null,
    },
    indicators: indicators.slice(0, 6),
    evidence: [
      {
        label: `Histograma de frecuencias de la llave (${chain === 'exact' ? 'sin normalizar' : `normalización: ${chain}`})`,
        sql,
        result: r,
        sampleSize: null,
        totalRows: leftRows,
      },
    ],
  };
}

export const joinsStage: Stage = {
  name: 'joins',
  run: async (ctx) => {
    const { session, report, emit } = ctx;
    const bySource = new Map(report.sources.map((s) => [s.id, s]));
    const col = (sId: string, name: string) => bySource.get(sId)?.columns.find((c) => c.name === name);

    // 1) predicción para las mejores relaciones encontradas
    const rels = report.relationships
      .filter((r) => r.confidence !== 'low' && r.userDecision !== 'rejected' && r.classification !== 'domain_coincidence')
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    for (const rel of rels) {
      const ls = bySource.get(rel.leftSourceId);
      const rs = bySource.get(rel.rightSourceId);
      const lc = col(rel.leftSourceId, rel.leftColumns[0]!);
      const rc = col(rel.rightSourceId, rel.rightColumns[0]!);
      if (!ls || !rs || !lc || !rc) continue;
      const chain = (rel.normalizations[0] as NormalizationChain | undefined) ?? 'exact';
      const pred = await computePrediction(session, report, { s: ls, col: lc }, { s: rs, col: rc }, chain, rel.id);
      if (pred) {
        report.joinPredictions.push(pred);
        emit(
          'joins',
          `Cruce ${ls.businessName} × ${rs.businessName}: ${pred.expectedRows.inner.value.toLocaleString('es')} filas esperadas, ${pred.indicators.length} indicadores viables.`,
        );
      }
    }

    // 2) cruces "tentadores" por fecha entre tablas (el clásico que explota):
    //    se calculan para poder ADVERTIR antes de que el usuario lo intente.
    const dateCols = report.sources.flatMap((s) =>
      s.columns.filter((c) => ['date', 'datetime'].includes(c.semanticType)).map((c) => ({ s, c })),
    );
    let dateChecks = 0;
    for (let i = 0; i < dateCols.length && dateChecks < 2; i++) {
      for (let j = i + 1; j < dateCols.length && dateChecks < 2; j++) {
        const a = dateCols[i]!;
        const b = dateCols[j]!;
        if (a.s.id === b.s.id) continue;
        if (nameSimilarity(a.c.name, b.c.name) < 0.5) continue;
        const already = report.joinPredictions.some(
          (p) =>
            (p.leftSourceId === a.s.id && p.rightSourceId === b.s.id) ||
            (p.leftSourceId === b.s.id && p.rightSourceId === a.s.id),
        );
        if (already) continue;
        dateChecks++;
        const pred = await computePrediction(session, report, { s: a.s, col: a.c }, { s: b.s, col: b.c }, 'exact', null);
        if (pred) {
          report.joinPredictions.push(pred);
          if (pred.fanOut.risk) {
            emit('joins', `Aviso: cruzar ${a.s.businessName} con ${b.s.businessName} por fecha multiplicaría las filas ×${pred.fanOut.multiplier}.`);
          }
        }
      }
    }
  },
};
