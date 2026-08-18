import type { ColumnProfile, Finding, TableSource } from '@sondadata/schema';
import type { PipelineContext, Stage } from '../pipeline.js';
import type { DuckSession } from '../duckdb.js';
import { jaroWinkler } from '../similarity.js';

/**
 * Etapa 6 — Diagnóstico estructural y de calidad (§3.6).
 * Cada detección técnica se traduce a UNA consecuencia de negocio, nunca a una
 * etiqueta teórica. Nada de "tercera forma normal" en los títulos.
 */

const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
let findCounter = 0;

function pushFinding(report: { findings: Finding[] }, f: Omit<Finding, 'id'>): void {
  report.findings.push({ ...f, id: `find-q${findCounter++}` });
}

/** Abreviaturas frecuentes en nombres de lugares/entidades en español. */
const ABBREVIATIONS: Record<string, string> = {
  sta: 'santa',
  sto: 'santo',
  s: 'san',
  sn: 'san',
  dc: '',
  av: 'avenida',
  cra: 'carrera',
  dpto: 'departamento',
  mpio: 'municipio',
};

/** Normalización básica en JS (espejo de la SQL) + expansión de abreviaturas. */
function normalizeJs(v: string): string {
  return v
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((t) => ABBREVIATIONS[t] ?? t)
    .filter((t) => t !== '')
    .join(' ')
    .trim();
}

interface Cluster {
  representative: string;
  variants: { value: string; count: number }[];
}

/** Agrupa valores casi-duplicados: normalización + Jaro-Winkler + contención de tokens. */
export function clusterVariants(values: { value: string; count: number }[]): Cluster[] {
  const byNorm = new Map<string, { value: string; count: number }[]>();
  for (const v of values) {
    const n = normalizeJs(v.value);
    if (n === '') continue;
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n)!.push(v);
  }
  const clusters: { norm: string; variants: { value: string; count: number }[] }[] = [...byNorm.entries()].map(
    ([norm, variants]) => ({ norm, variants }),
  );
  // fusiona clusters cuyos representantes se parecen o se contienen
  clusters.sort((a, b) => b.variants.reduce((s, v) => s + v.count, 0) - a.variants.reduce((s, v) => s + v.count, 0));
  const merged: { norm: string; variants: { value: string; count: number }[] }[] = [];
  const digitsOf = (s: string) => s.replace(/[^0-9]/g, '');
  for (const c of clusters) {
    const target = merged.find((m) => {
      // «Actividad 1» y «Actividad 2» NO son variantes del mismo valor: si los
      // números difieren, son registros distintos de una serie.
      const dm = digitsOf(m.norm);
      const dc = digitsOf(c.norm);
      if (dm !== dc && dm !== '' && dc !== '') return false;
      if (jaroWinkler(m.norm, c.norm) >= 0.88) return true;
      // contención de tokens: «santa rosa cauca» pertenece al grupo «santa rosa»
      const tm = new Set(m.norm.split(' '));
      const tc = new Set(c.norm.split(' '));
      const [small, big] = tm.size <= tc.size ? [tm, tc] : [tc, tm];
      return small.size >= 2 && [...small].every((t) => big.has(t));
    });
    if (target) target.variants.push(...c.variants);
    else merged.push({ norm: c.norm, variants: [...c.variants] });
  }
  return merged.map((m) => ({
    representative: m.variants.sort((a, b) => b.count - a.count)[0]!.value,
    variants: m.variants,
  }));
}

async function nearDuplicates(session: DuckSession, source: TableSource, ctx: PipelineContext): Promise<void> {
  for (const col of source.columns) {
    if (col.isPersonalData || !/VARCHAR|TEXT/.test(col.physicalType.toUpperCase())) continue;
    if (!['geo_admin', 'category', 'unknown'].includes(col.semanticType)) continue;
    if (col.distinctCount < 4 || col.distinctCount > 500 || source.rowCount < 20) continue;
    // columnas casi únicas no son catálogos con variantes, son texto por fila
    if (col.uniquenessRatio > 0.9) continue;
    // las listas embebidas ya tienen su propia propuesta de tabla puente
    const total = col.topValues.reduce((s, v) => s + v.count, 0);
    const withSeparator = col.topValues.filter((v) => /[,;|] /.test(v.value)).reduce((s, v) => s + v.count, 0);
    if (total > 0 && withSeparator / total > 0.15) continue;

    const sql = `SELECT ${q(col.name)}::VARCHAR AS v, COUNT(*)::INT AS c FROM "${source.id}" WHERE ${q(col.name)} IS NOT NULL GROUP BY 1 ORDER BY c DESC LIMIT 500`;
    const values = (await session.query<{ v: string; c: number }>(sql)).map((r) => ({ value: r.v, count: r.c }));
    const clusters = clusterVariants(values);
    const multi = clusters.filter((c) => c.variants.length > 1);
    if (clusters.length >= values.length * 0.9 || multi.length === 0) continue;

    pushFinding(ctx.report, {
      severity: 'warning',
      category: 'near_duplicates',
      title: `«${col.name}» en ${source.businessName} tiene ${values.length} valores distintos, pero probablemente sean ${clusters.length} reales escritos de formas diferentes.`,
      consequence: `Cualquier conteo o suma por ${col.name} quedará partido entre las variantes («${multi[0]!.variants[0]!.value}», «${multi[0]!.variants[1]!.value}»…). Estos son los ${multi.length} grupos que hay que unificar.`,
      sourceIds: [source.id],
      columns: [{ sourceId: source.id, column: col.name }],
      affectedRows: multi.reduce((s, c) => s + c.variants.reduce((x, v) => x + v.count, 0), 0),
      evidence: [
        {
          label: 'Valores y frecuencias agrupados por similitud',
          sql,
          result: multi.map((c) => ({ grupo: c.representative, variantes: c.variants })),
          sampleSize: null,
          totalRows: source.rowCount,
        },
      ],
      remediation: {
        suggestion: `Unificar la escritura de ${col.name} usando el valor más frecuente de cada grupo como forma canónica.`,
        impact: 'high',
        effort: 'low',
      },
    });
    ctx.emit('quality', `«${source.businessName}»: ${col.name} mezcla formas de escribir los mismos valores.`);
  }
}

function ghostColumns(source: TableSource, ctx: PipelineContext): void {
  if (source.rowCount < 50) return;
  for (const col of source.columns) {
    const emptyish = col.nullCount + col.emptyLikeCount;
    const ratio = emptyish / Math.max(1, col.rowCount);
    if (ratio < 0.95) continue;
    pushFinding(ctx.report, {
      severity: 'info',
      category: 'ghost_column',
      title: `«${col.name}» en ${source.businessName} está vacía en el ${(ratio * 100).toFixed(1).replace('.', ',')}% de las filas.`,
      consequence: 'Ocupa espacio y genera dudas: o se completa, o se documenta por qué existe, o se elimina.',
      sourceIds: [source.id],
      columns: [{ sourceId: source.id, column: col.name }],
      affectedRows: emptyish,
      evidence: [
        {
          label: 'Conteo de vacíos',
          sql: `SELECT COUNT(*) - COUNT(NULLIF(trim(${q(col.name)}::VARCHAR), '')) AS vacios FROM "${source.id}"`,
          result: { vacios: emptyish, total: col.rowCount },
          sampleSize: null,
          totalRows: col.rowCount,
        },
      ],
      remediation: null,
    });
  }
}

async function mirrorColumns(session: DuckSession, source: TableSource, ctx: PipelineContext): Promise<void> {
  const numeric = source.columns.filter(
    (c) =>
      /INT|DECIMAL|DOUBLE|FLOAT/.test(c.physicalType.toUpperCase()) &&
      !['identifier'].includes(c.semanticType) &&
      c.distinctCount > 1,
  );
  if (numeric.length < 3 || numeric.length > 8 || source.rowCount < 50) return;

  // prioriza objetivos que suenan a total/valor
  const targets = [...numeric].sort((a, b) => Number(/total|valor/.test(b.name)) - Number(/total|valor/.test(a.name)));
  let checks = 0;
  for (const target of targets) {
    for (let i = 0; i < numeric.length && checks < 20; i++) {
      for (let j = i + 1; j < numeric.length && checks < 20; j++) {
        const a = numeric[i]!;
        const b = numeric[j]!;
        if (a.name === target.name || b.name === target.name) continue;
        checks++;
        // cast a DOUBLE: con enteros sin signo (UINT de MySQL) la resta desborda
        const sql = `SELECT SUM(CASE WHEN ABS(${q(a.name)}::DOUBLE * ${q(b.name)}::DOUBLE - ${q(target.name)}::DOUBLE) > 0.005 THEN 1 ELSE 0 END)::INT AS roto,
       COUNT(*)::INT AS n
FROM "${source.id}" WHERE ${q(a.name)} IS NOT NULL AND ${q(b.name)} IS NOT NULL AND ${q(target.name)} IS NOT NULL`;
        const r = (await session.query<{ roto: number; n: number }>(sql))[0]!;
        if (r.n === 0) continue;
        const ratio = r.roto / r.n;
        if (ratio > 0.05) continue;
        if (r.roto > 0) {
          pushFinding(ctx.report, {
            severity: 'warning',
            category: 'mirror_column',
            title: `«${target.name}» en ${source.businessName} es siempre ${a.name} × ${b.name}, salvo en ${r.roto} filas. Revisa esas ${r.roto}.`,
            consequence:
              'O la fórmula está mal aplicada en esas filas, o alguien las editó a mano: en ambos casos los totales que salgan de ahí no cuadran.',
            sourceIds: [source.id],
            columns: [{ sourceId: source.id, column: target.name }],
            affectedRows: r.roto,
            evidence: [{ label: 'Filas donde la fórmula no cuadra', sql, result: r, sampleSize: null, totalRows: r.n }],
            remediation: { suggestion: `Recalcular ${target.name} o corregir las ${r.roto} filas divergentes.`, impact: 'medium', effort: 'low' },
          });
          ctx.emit('quality', `«${source.businessName}»: ${target.name} no cuadra con ${a.name} × ${b.name} en ${r.roto} filas.`);
        }
        return; // una fórmula por tabla es suficiente para el MVP
      }
    }
  }
}

async function redundantCopies(session: DuckSession, source: TableSource, ctx: PipelineContext): Promise<void> {
  if (source.rowCount < 50) return;
  const keyCols = new Set(ctx.report.keyCandidates.filter((k) => k.sourceId === source.id).flatMap((k) => k.columns));
  const determinants = source.columns.filter(
    (c) =>
      !keyCols.has(c.name) &&
      c.distinctCount >= 2 &&
      c.distinctCount <= source.rowCount * 0.5 &&
      c.semanticType !== 'free_text' &&
      !c.isPersonalData,
  );
  const reported = new Set<string>();
  for (const x of determinants.slice(0, 6)) {
    const dependents: string[] = [];
    for (const y of source.columns) {
      if (y.name === x.name || keyCols.has(y.name) || reported.has(y.name)) continue;
      if (y.distinctCount > x.distinctCount) continue; // Y no puede depender de X con más valores
      const sql = `SELECT COUNT(DISTINCT ${q(x.name)})::INT AS nc, COUNT(DISTINCT (${q(x.name)}::VARCHAR || '␟' || COALESCE(${q(y.name)}::VARCHAR, '')))::INT AS np FROM "${source.id}"`;
      const r = (await session.query<{ nc: number; np: number }>(sql))[0]!;
      if (r.np === r.nc && y.distinctCount > 1) dependents.push(y.name);
    }
    if (dependents.length === 0) continue;
    reported.add(x.name);
    dependents.forEach((d) => reported.add(d));
    pushFinding(ctx.report, {
      severity: 'warning',
      category: 'redundant_copy',
      title: `${dependents.map((d) => `«${d}»`).join(' y ')} se repite${dependents.length > 1 ? 'n' : ''} en cada una de las ${source.rowCount.toLocaleString('es')} filas de ${source.businessName} según «${x.name}».`,
      consequence: `Esa información pertenece a un catálogo aparte (${x.distinctCount} valores reales). Si uno cambia, hay que corregirlo en cientos de sitios, y basta un error de tipeo para que los totales se partan.`,
      sourceIds: [source.id],
      columns: [{ sourceId: source.id, column: x.name }, ...dependents.map((d) => ({ sourceId: source.id, column: d }))],
      affectedRows: source.rowCount,
      evidence: [
        {
          label: 'Dependencia verificada sobre el total de filas',
          sql: `SELECT COUNT(DISTINCT ${q(x.name)}) AS valores, COUNT(*) AS filas FROM "${source.id}"`,
          result: { valores: x.distinctCount, filas: source.rowCount, dependientes: dependents },
          sampleSize: null,
          totalRows: source.rowCount,
        },
      ],
      remediation: {
        suggestion: `Extraer ${x.name} y sus datos asociados a una tabla propia y referenciarla.`,
        impact: 'medium',
        effort: 'medium',
      },
    });
    ctx.emit('quality', `«${source.businessName}»: los datos de ${x.name} están copiados en cada fila.`);
  }
}

function dateRisks(source: TableSource, ctx: PipelineContext): void {
  for (const col of source.columns) {
    if (col.risks.length === 0) continue;
    pushFinding(ctx.report, {
      severity: 'warning',
      category: 'ambiguous_date',
      title: `«${col.name}» en ${source.businessName}: ${col.risks[0]!.replace(/^La columna /, 'la columna ')}`,
      consequence:
        'Mientras no se unifique el formato, ordenar o filtrar por esta fecha puede mezclar meses con días y producir series temporales incorrectas.',
      sourceIds: [source.id],
      columns: [{ sourceId: source.id, column: col.name }],
      affectedRows: null,
      evidence: [
        {
          label: 'Patrones dominantes detectados',
          sql: `SELECT regexp_replace(${q(col.name)}::VARCHAR, '[0-9]', '9', 'g') AS patron, COUNT(*) FROM "${source.id}" GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
          result: col.dominantPatterns,
          sampleSize: null,
          totalRows: col.rowCount,
        },
      ],
      remediation: { suggestion: 'Convertir toda la columna a formato AAAA-MM-DD confirmando con la fuente qué es día y qué es mes.', impact: 'medium', effort: 'low' },
    });
  }
}

function personalData(source: TableSource, ctx: PipelineContext): void {
  const personal = source.columns.filter((c) => c.isPersonalData);
  if (personal.length === 0) return;
  pushFinding(ctx.report, {
    severity: 'info',
    category: 'personal_data',
    title: `${source.businessName} contiene datos personales en ${personal.length} columnas (${personal.map((c) => c.name).join(', ')}).`,
    consequence:
      'Se muestran enmascarados y nunca salen del análisis ni del informe. Si compartes los archivos originales, hazlo solo con quien deba ver esos datos.',
    sourceIds: [source.id],
    columns: personal.map((c) => ({ sourceId: source.id, column: c.name })),
    affectedRows: source.rowCount,
    evidence: [
      {
        label: 'Columnas marcadas por tipo semántico',
        sql: '-- detección heurística local (nombre + patrón de valores); no se consultaron los valores fuera del análisis',
        result: personal.map((c) => ({ columna: c.name, tipo: c.semanticType })),
        sampleSize: null,
        totalRows: null,
      },
    ],
    remediation: null,
  });
}

function inflatedCounts(ctx: PipelineContext): void {
  for (const bridge of ctx.report.bridgeProposals) {
    if (bridge.kind !== 'n_m' || !bridge.resultMetrics) continue;
    const source = ctx.report.sources.find((s) => s.id === bridge.sourceIds[0]);
    if (!source) continue;
    const ev = bridge.evidence[0]?.result as { distinctA?: number } | undefined;
    const persons = ev?.distinctA ?? Math.round(bridge.resultMetrics.rows / Math.max(1, bridge.resultMetrics.avgDegreeLeft));
    pushFinding(ctx.report, {
      severity: 'warning',
      category: 'inflated_count',
      title: `En ${source.businessName} hay ${persons.toLocaleString('es')} registros reales repartidos en ${source.rowCount.toLocaleString('es')} filas: contar filas infla los totales.`,
      consequence: `La misma entidad aparece una vez por cada combinación. Todo conteo debe hacerse sobre valores distintos, o usando la tabla auxiliar propuesta en Cruces.`,
      sourceIds: [source.id],
      columns: [],
      affectedRows: source.rowCount - persons,
      evidence: bridge.evidence,
      remediation: { suggestion: `Generar la tabla auxiliar «${bridge.proposedTableName}» y contar sobre ella.`, impact: 'high', effort: 'low' },
    });
  }
}

export const qualityStage: Stage = {
  name: 'quality',
  run: async (ctx) => {
    const { session, report } = ctx;
    for (const source of report.sources) {
      if (source.rowCount === 0 || source.columns.length === 0) continue;
      await nearDuplicates(session, source, ctx);
      ghostColumns(source, ctx);
      await mirrorColumns(session, source, ctx);
      await redundantCopies(session, source, ctx);
      dateRisks(source, ctx);
      personalData(source, ctx);
    }
    inflatedCounts(ctx);
  },
};
