import type { Confidence, Penalty, RelationshipSignals } from '@sondadata/schema';

/**
 * Fórmula de scoring de relaciones inferidas (importada de la spec DataSketch,
 * §6.6): transparente, versionada y cubierta por pruebas. El score final es
 * la suma ponderada de señales más penalizaciones explícitas; el desglose
 * completo viaja en el artefacto — nunca existe un número opaco.
 */

export const SCORING_VERSION = '1.0.0';

/** Pesos base. `semanticSimilarity` (embeddings) llega después del MVP: su peso se reparte. */
const WEIGHTS = {
  typeCompatibility: 0.18,
  lexicalSimilarity: 0.22, // 0.17 + mitad del peso semántico
  valueInclusion: 0.3, // 0.25 + mitad del peso semántico
  parentUniqueness: 0.2,
  cardinalityConsistency: 0.1,
} as const;

export interface ScoreInput {
  signals: RelationshipSignals;
  /** Inclusión del hijo en el padre: la señal de valores que puntúa. */
  inclusion: number;
  /** Ratio de nulos de la columna hija (penaliza). */
  childNullRatio: number;
  /** Cardinalidad distinta del lado referenciado. */
  parentDistinct: number;
  /** true si el lado referenciado es una llave detectada (única y sin nulos). */
  parentIsKey: boolean;
  /** Qué parte del catálogo referenciado usa realmente el hijo (0..1). */
  parentCoverage: number;
  /** true si los patrones dominantes de ambos lados difieren. */
  patternMismatch: boolean;
  /**
   * true si ambos lados son enteros y los nombres no comparten ningún token:
   * el riesgo clásico de llaves densas (1..N ⊆ 1..M por pura aritmética).
   */
  denseIntegerNameMismatch: boolean;
}

export interface ScoreResult {
  score: number;
  confidence: Confidence;
  penalties: Penalty[];
  /** true si debe presentarse como coincidencia de dominio, no como referencia. */
  domainCoincidence: boolean;
}

export function scoreRelationship(input: ScoreInput): ScoreResult {
  const s = input.signals;

  let score =
    WEIGHTS.typeCompatibility * s.typeCompatibility +
    WEIGHTS.lexicalSimilarity * s.lexicalSimilarity +
    WEIGHTS.valueInclusion * input.inclusion +
    WEIGHTS.parentUniqueness * s.parentUniqueness +
    WEIGHTS.cardinalityConsistency * s.cardinalityConsistency;

  const penalties: Penalty[] = [];
  const addPenalty = (reason: string, plainText: string, delta: number) => {
    penalties.push({ reason, plainText, delta });
    score += delta;
  };

  if (input.childNullRatio > 0.3) {
    addPenalty(
      'high_null_ratio',
      `El ${Math.round(input.childNullRatio * 100)}% de los registros no tiene valor en esta columna.`,
      -0.08,
    );
  }
  if (input.patternMismatch) {
    addPenalty(
      'inconsistent_formats',
      'Los valores se escriben con formatos distintos en cada archivo.',
      -0.1,
    );
  }
  // Cobertura ínfima del catálogo referenciado: típico de coincidencias casuales
  // entre columnas numéricas genéricas (una cantidad "incluida" en una llave).
  if (input.parentCoverage < 0.1 && input.parentDistinct >= 20) {
    addPenalty(
      'low_parent_coverage',
      `Los valores del lado hijo solo tocan el ${Math.max(1, Math.round(input.parentCoverage * 100))}% del catálogo referenciado.`,
      -0.2,
    );
  }
  // Llaves enteras densas con nombres ajenos: 1..N cabe en 1..M por aritmética,
  // no por referencia. Nunca debe salir como afirmación de alta confianza.
  if (input.denseIntegerNameMismatch) {
    addPenalty(
      'integer_domain_name_mismatch',
      'Ambas columnas son secuencias de números enteros y sus nombres no se parecen: la coincidencia puede ser numérica, no una referencia real.',
      -0.25,
    );
  }

  // Dominio compartido: el lado referenciado tiene muy pocos valores distintos
  // y no es una llave de su tabla (años, meses, categorías). Inclusión perfecta espuria.
  const domainCoincidence = input.parentDistinct < 20 && !input.parentIsKey;
  if (domainCoincidence) {
    addPenalty(
      'shared_domain',
      `Solo hay ${input.parentDistinct} valores distintos en el lado referenciado: la coincidencia puede ser por dominio compartido, no por referencia.`,
      -0.25,
    );
  }

  score = Math.max(0, Math.min(1, score));

  // Umbrales de DataSketch §6.6; una coincidencia de dominio nunca es confianza alta.
  let confidence: Confidence = score >= 0.8 ? 'high' : score >= 0.6 ? 'medium' : 'low';
  if (domainCoincidence && confidence === 'high') confidence = 'medium';

  return { score, confidence, penalties, domainCoincidence };
}

/** Clasificación por ratio de inclusión (spec SONDA §3.3). */
export function classifyInclusion(inclusion: number, domainCoincidence: boolean):
  | 'solid'
  | 'broken_integrity'
  | 'partial'
  | 'domain_coincidence'
  | null {
  if (domainCoincidence) return inclusion >= 0.3 ? 'domain_coincidence' : null;
  if (inclusion >= 0.98) return 'solid';
  if (inclusion >= 0.75) return 'broken_integrity';
  if (inclusion >= 0.3) return 'partial';
  return null;
}
