import type { Cardinality, ColumnProfile, Relationship, TableSource } from '@sondadata/schema';
import type { Stage } from '../pipeline.js';
import type { DuckSession } from '../duckdb.js';
import { nameSimilarity, normalizeIdentifier } from '../similarity.js';
import { classifyInclusion, scoreRelationship, SCORING_VERSION } from '../scoring.js';
import { CHAIN_LABELS, normalizeSql, type NormalizationChain } from '../normalize.js';

/**
 * Etapa 4 — Inferencia de relaciones (§3.3 + §3.4).
 * Prefiltro barato (tipos, rangos, patrones, nombres) → verificación de
 * inclusión en SQL probando cadenas de normalización (exacta → básica →
 * solo dígitos) → clasificación por cobertura de FILAS y scoring desglosado.
 *
 * La clasificación usa cobertura de filas (qué parte de los registros hijos
 * encuentra a su padre) y no solo inclusión de valores distintos: 312
 * huérfanos sobre 3.000 filas son integridad rota aunque representen muchos
 * valores distintos.
 */

type TypeGroup = 'numeric' | 'text' | 'date' | 'bool' | 'other';

function typeGroup(c: ColumnProfile): TypeGroup {
  const t = c.physicalType.toUpperCase();
  if (/INT|DECIMAL|DOUBLE|FLOAT|HUGEINT/.test(t)) return 'numeric';
  if (/DATE|TIMESTAMP/.test(t)) return 'date';
  if (/BOOL/.test(t)) return 'bool';
  if (/VARCHAR|TEXT|STRING/.test(t)) return 'text';
  return 'other';
}

function numericPattern(c: ColumnProfile): boolean {
  const top = c.dominantPatterns[0]?.pattern ?? '';
  return /^9+(\.9+)?$/.test(top);
}

/** El patrón dominante contiene dígitos (p.ej. "A-9999"): candidata a cadena `digits`. */
function hasDigitsPattern(c: ColumnProfile): boolean {
  return /9/.test(c.dominantPatterns[0]?.pattern ?? '');
}

function rangesOverlap(a: ColumnProfile, b: ColumnProfile): boolean {
  const aMin = Number(a.min);
  const aMax = Number(a.max);
  const bMin = Number(b.min);
  const bMax = Number(b.max);
  if ([aMin, aMax, bMin, bMax].some((x) => Number.isNaN(x))) return true;
  return aMax >= bMin && bMax >= aMin;
}

/** Tokens genéricos que no aportan significado al comparar nombres de columna. */
const GENERIC_TOKENS = new Set(['id', 'key', 'cod', 'codigo', 'num', 'no']);

function tokenOverlap(a: string, b: string, excludeGeneric = false): number {
  const filter = (ts: string[]) => (excludeGeneric ? ts.filter((t) => !GENERIC_TOKENS.has(t)) : ts);
  const ta = new Set(filter(normalizeIdentifier(a)));
  const tb = new Set(filter(normalizeIdentifier(b)));
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / Math.max(ta.size, tb.size);
}

interface CandidatePair {
  a: ColumnProfile;
  b: ColumnProfile;
  /** Cadenas de normalización aplicables al par, en orden de preferencia. */
  chains: { chain: NormalizationChain; typeCompatibility: number }[];
  nameSim: number;
}

function candidatePairs(sa: TableSource, sb: TableSource): CandidatePair[] {
  const out: CandidatePair[] = [];
  for (const a of sa.columns) {
    if (a.distinctCount <= 1 || a.semanticType === 'free_text' || a.semanticType === 'boolean_coded') continue;
    for (const b of sb.columns) {
      if (b.distinctCount <= 1 || b.semanticType === 'free_text' || b.semanticType === 'boolean_coded') continue;

      const ga = typeGroup(a);
      const gb = typeGroup(b);
      // La cadena `digits` («P-0001» = 1) es potente pero peligrosa: solo se
      // permite cuando los nombres comparten un token con significado real
      // («proyecto» ↔ «id_proyecto»), nunca por el token genérico «id».
      const digitsAllowed = tokenOverlap(a.name, b.name, true) >= 0.3;
      const chains: CandidatePair['chains'] = [];
      if (ga === gb && ga !== 'other') {
        chains.push({ chain: 'exact', typeCompatibility: 1 });
        if (ga === 'text') chains.push({ chain: 'basic', typeCompatibility: 1 });
        if (ga === 'text' && digitsAllowed && hasDigitsPattern(a) && hasDigitsPattern(b))
          chains.push({ chain: 'digits', typeCompatibility: 0.8 });
      } else if ((ga === 'numeric' && gb === 'text') || (gb === 'numeric' && ga === 'text')) {
        const textSide = ga === 'text' ? a : b;
        if (numericPattern(textSide)) chains.push({ chain: 'exact', typeCompatibility: 0.6 });
        if (digitsAllowed && hasDigitsPattern(textSide)) chains.push({ chain: 'digits', typeCompatibility: 0.6 });
      }
      if (chains.length === 0) continue;
      if (ga === 'numeric' && gb === 'numeric' && !rangesOverlap(a, b)) continue;

      const nameSim = nameSimilarity(a.name, b.name);
      // Al menos un lado debe parecer padre (casi único) o los nombres deben parecerse
      if (a.uniquenessRatio < 0.9 && b.uniquenessRatio < 0.9 && nameSim < 0.75) continue;
      // Compuerta de dominios pequeños: exigimos parecido de nombre
      if (Math.min(a.distinctCount, b.distinctCount) < 20 && tokenOverlap(a.name, b.name) < 0.4) continue;

      out.push({ a, b, chains, nameSim });
    }
  }
  return out.sort((x, y) => y.nameSim - x.nameSim).slice(0, 12);
}

interface InclusionResult {
  na: number;
  nb: number;
  inter: number;
}

const q = (n: string) => `"${n.replace(/"/g, '""')}"`;

async function inclusionForChain(
  session: DuckSession,
  sa: TableSource,
  ca: string,
  sb: TableSource,
  cb: string,
  chain: NormalizationChain,
): Promise<{ result: InclusionResult; sql: string }> {
  const ea = normalizeSql(q(ca), chain);
  const eb = normalizeSql(q(cb), chain);
  const sql = `WITH da AS (SELECT DISTINCT ${ea} AS v FROM "${sa.id}" WHERE ${q(ca)} IS NOT NULL),
     db AS (SELECT DISTINCT ${eb} AS v FROM "${sb.id}" WHERE ${q(cb)} IS NOT NULL)
SELECT (SELECT COUNT(v) FROM da)::INT AS na,
       (SELECT COUNT(v) FROM db)::INT AS nb,
       (SELECT COUNT(*) FROM da JOIN db USING (v))::INT AS inter`;
  const result = (await session.query<InclusionResult>(sql))[0]!;
  return { result, sql };
}

/** Cobertura por filas: qué parte de las filas del hijo encuentra su valor en el padre. */
async function rowCoverage(
  session: DuckSession,
  child: { sId: string; col: string },
  parent: { sId: string; col: string },
  chain: NormalizationChain,
): Promise<{ covered: number; total: number; sql: string }> {
  const ec = normalizeSql(q(child.col), chain);
  const ep = normalizeSql(q(parent.col), chain);
  const sql = `SELECT COUNT(*)::INT AS total,
       SUM(CASE WHEN ${ec} IN (SELECT DISTINCT ${ep} FROM "${parent.sId}" WHERE ${q(parent.col)} IS NOT NULL) THEN 1 ELSE 0 END)::INT AS covered
FROM "${child.sId}" WHERE ${q(child.col)} IS NOT NULL`;
  const r = (await session.query<{ total: number; covered: number }>(sql))[0]!;
  return { covered: r.covered ?? 0, total: r.total, sql };
}

let relCounter = 0;

export const relationshipsStage: Stage = {
  name: 'relationships',
  run: async ({ session, report, emit }) => {
    const sources = report.sources.filter((s) => s.rowCount > 0 && s.columns.length > 0);

    for (let i = 0; i < sources.length; i++) {
      for (let j = i + 1; j < sources.length; j++) {
        const sa = sources[i]!;
        const sb = sources[j]!;
        const found: Relationship[] = [];

        for (const pair of candidatePairs(sa, sb)) {
          // prueba las cadenas en orden y se queda con la mejor inclusión
          let best: {
            chain: NormalizationChain;
            typeCompatibility: number;
            result: InclusionResult;
            sql: string;
            inclusion: number;
          } | null = null;
          for (const c of pair.chains) {
            const { result, sql } = await inclusionForChain(session, sa, pair.a.name, sb, pair.b.name, c.chain);
            if (result.na === 0 || result.nb === 0 || result.inter === 0) continue;
            const aIsParent = pair.a.uniquenessRatio >= pair.b.uniquenessRatio;
            const childDistinct = aIsParent ? result.nb : result.na;
            const inclusion = result.inter / childDistinct;
            if (!best || inclusion > best.inclusion + 0.01) {
              best = { chain: c.chain, typeCompatibility: c.typeCompatibility, result, sql, inclusion };
            }
            if (best.inclusion >= 0.98) break;
          }
          if (!best || best.inclusion < 0.2) continue;

          const aIsParent = pair.a.uniquenessRatio >= pair.b.uniquenessRatio;
          const child = aIsParent
            ? { s: sb, c: pair.b, distinct: best.result.nb }
            : { s: sa, c: pair.a, distinct: best.result.na };
          const parent = aIsParent
            ? { s: sa, c: pair.a, distinct: best.result.na }
            : { s: sb, c: pair.b, distinct: best.result.nb };

          const cov = await rowCoverage(
            session,
            { sId: child.s.id, col: child.c.name },
            { sId: parent.s.id, col: parent.c.name },
            best.chain,
          );
          const coverage = cov.total > 0 ? cov.covered / cov.total : 0;
          if (coverage < 0.3) continue;

          const parentIsKey = parent.c.uniquenessRatio === 1 && parent.c.nullCount === 0;
          const parentCoverage = best.result.inter / parent.distinct;
          const signals = {
            typeCompatibility: best.typeCompatibility,
            lexicalSimilarity: pair.nameSim,
            semanticSimilarity: null,
            valueInclusionLeftInRight: best.inclusion,
            valueInclusionRightInLeft: parentCoverage,
            parentUniqueness: parent.c.uniquenessRatio,
            cardinalityConsistency: parent.c.uniquenessRatio >= 0.99 ? 1 : 0.5,
          };
          const patternMismatch =
            best.chain !== 'exact' ||
            (typeGroup(pair.a) === 'text' &&
              typeGroup(pair.b) === 'text' &&
              (pair.a.dominantPatterns[0]?.pattern ?? '') !== (pair.b.dominantPatterns[0]?.pattern ?? ''));
          const bothInteger =
            /INT/.test(pair.a.physicalType.toUpperCase()) && /INT/.test(pair.b.physicalType.toUpperCase());
          const digitsWithForeignNames = best.chain === 'digits' && tokenOverlap(pair.a.name, pair.b.name) < 0.3;

          const scored = scoreRelationship({
            signals,
            inclusion: coverage,
            childNullRatio: child.c.rowCount > 0 ? child.c.nullCount / child.c.rowCount : 0,
            parentDistinct: parent.distinct,
            parentIsKey,
            parentCoverage,
            patternMismatch: patternMismatch && best.chain === 'exact',
            denseIntegerNameMismatch: (bothInteger || digitsWithForeignNames) && tokenOverlap(pair.a.name, pair.b.name) < 0.3,
          });
          const classification = classifyInclusion(coverage, scored.domainCoincidence);
          if (!classification) continue;

          const childUnique = child.c.uniquenessRatio >= 0.99;
          const parentUnique = parent.c.uniquenessRatio >= 0.99;
          const cardinality: Cardinality =
            childUnique && parentUnique ? '1:1' : parentUnique ? 'N:1' : childUnique ? '1:N' : 'N:M';

          const pct = Math.round(coverage * 100);
          const normNote = best.chain === 'exact' ? '' : ` (${CHAIN_LABELS[best.chain]})`;
          const explanation =
            classification === 'solid'
              ? `El ${pct}% de los registros de ${child.s.businessName} encuentra su valor de «${child.c.name}» en ${parent.s.businessName}${normNote}.`
              : classification === 'broken_integrity'
                ? `El ${pct}% de los registros coincide${normNote}, pero el resto apunta a valores que no existen en ${parent.s.businessName}.`
                : classification === 'domain_coincidence'
                  ? `Los valores coinciden, pero el catálogo referenciado es muy pequeño: puede ser coincidencia por dominio compartido, no una referencia real.`
                  : `Solo el ${pct}% de los registros coincide${normNote}: puede ser una relación parcial o una superposición casual. Revísala antes de usarla.`;

          found.push({
            id: `rel-${relCounter++}`,
            leftSourceId: child.s.id,
            leftColumns: [child.c.name],
            rightSourceId: parent.s.id,
            rightColumns: [parent.c.name],
            status: 'inferred',
            classification,
            cardinality,
            score: scored.score,
            confidence: scored.confidence,
            signals,
            penalties: scored.penalties,
            normalizations: best.chain === 'exact' ? [] : [best.chain],
            viaPath: [],
            sampleSize: null,
            limitations:
              best.chain === 'exact'
                ? []
                : [`Coincidencia lograda ${CHAIN_LABELS[best.chain]}; conviene unificar la escritura en el origen.`],
            explanation,
            evidence: [
              { label: 'Inclusión de valores distintos', sql: best.sql, result: best.result, sampleSize: null, totalRows: null },
              {
                label: 'Cobertura por filas',
                sql: cov.sql,
                result: { covered: cov.covered, total: cov.total },
                sampleSize: null,
                totalRows: cov.total,
              },
            ],
            userDecision: 'pending',
            userComment: null,
            algorithmVersion: SCORING_VERSION,
          });
        }

        found.sort((x, y) => y.score - x.score);
        for (const rel of found.slice(0, 3)) {
          report.relationships.push(rel);
          const childName = sources.find((s) => s.id === rel.leftSourceId)?.businessName;
          const parentName = sources.find((s) => s.id === rel.rightSourceId)?.businessName;
          emit(
            'relationships',
            `«${childName}» se conecta con «${parentName}» por ${rel.leftColumns[0]} (confianza ${
              rel.confidence === 'high' ? 'alta' : rel.confidence === 'medium' ? 'media' : 'baja'
            }).`,
          );

          if (rel.classification === 'broken_integrity' && rel.confidence === 'high') {
            const chain = (rel.normalizations[0] as NormalizationChain | undefined) ?? 'exact';
            const ec = normalizeSql(q(rel.leftColumns[0]!), chain);
            const ep = normalizeSql(q(rel.rightColumns[0]!), chain);
            const orphanSql = `SELECT COUNT(*)::INT AS n FROM "${rel.leftSourceId}"
WHERE ${q(rel.leftColumns[0]!)} IS NOT NULL
  AND ${ec} NOT IN (SELECT DISTINCT ${ep} FROM "${rel.rightSourceId}" WHERE ${q(rel.rightColumns[0]!)} IS NOT NULL)`;
            const orphans = await session.scalar<number>(orphanSql);
            report.findings.push({
              id: `find-${rel.id}`,
              severity: 'critical',
              category: 'orphan_records',
              title: `${orphans.toLocaleString('es')} registros de ${childName} apuntan a un valor de «${rel.leftColumns[0]}» que no existe en ${parentName}.`,
              consequence:
                'Cualquier suma o conteo que dependa de este cruce dejará esos registros por fuera o los contará mal.',
              sourceIds: [rel.leftSourceId, rel.rightSourceId],
              columns: [{ sourceId: rel.leftSourceId, column: rel.leftColumns[0]! }],
              affectedRows: orphans,
              evidence: [
                { label: 'Registros sin correspondencia', sql: orphanSql, result: { n: orphans }, sampleSize: null, totalRows: null },
              ],
              remediation: {
                suggestion: `Revisar de dónde salieron esos registros de ${childName} y completar el catálogo de ${parentName} o corregir los valores.`,
                impact: 'high',
                effort: 'medium',
              },
            });
          }
        }
      }
    }
  },
};
