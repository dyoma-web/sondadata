import { z } from 'zod';

/**
 * AnalysisReport — el contrato central de SondaData.
 *
 * Principios que este esquema hace cumplir:
 *  1. Todo hallazgo y toda relación llevan evidencia SQL trazable (`Evidence`).
 *  2. Los scores se desglosan por señal y las penalizaciones se nombran una a una;
 *     nunca existe un número opaco.
 *  3. El artefacto es autocontenido: la UI y el informe se renderizan completos
 *     desde este JSON sin volver a tocar los datos crudos.
 *  4. Versionado: `schemaVersion` cambia con el contrato, `algorithmVersion`
 *     con la lógica que produjo cada sección.
 */

// ───────────────────────── Bloques base ─────────────────────────

/** Consulta determinista + resultado que respalda una afirmación de la UI. */
export const Evidence = z.object({
  label: z.string().min(1),
  sql: z.string().min(1),
  /** Resultado serializado de la consulta (filas, escalar o resumen). */
  result: z.unknown(),
  /** Si el cálculo se hizo sobre muestra, aquí consta el tamaño y el total. */
  sampleSize: z.number().int().positive().nullable().default(null),
  totalRows: z.number().int().nonnegative().nullable().default(null),
});
export type Evidence = z.infer<typeof Evidence>;

export const Severity = z.enum(['critical', 'warning', 'info']);
export type Severity = z.infer<typeof Severity>;

export const Confidence = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof Confidence>;

/** Estadística que declara si es exacta o estimada (regla heredada de DataSketch). */
export const Stat = z.object({
  value: z.number(),
  exact: z.boolean(),
});
export type Stat = z.infer<typeof Stat>;

// ───────────────────────── Fuentes ─────────────────────────

export const SourceOrigin = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    fileName: z.string(),
    sheet: z.string().nullable().default(null),
    /** Rango interpretado cuando el archivo era un "Excel humano" (p.ej. "A4:G4316"). */
    range: z.string().nullable().default(null),
    contentHash: z.string(),
    /** Interpretación confirmada por el usuario en Pantalla 1. */
    interpretation: z
      .object({
        headerRow: z.number().int().positive(),
        discardedRows: z.array(z.number().int().positive()),
        confirmedByUser: z.boolean(),
      })
      .nullable()
      .default(null),
  }),
  z.object({
    kind: z.literal('database'),
    engine: z.enum(['postgresql', 'mysql']),
    schemaName: z.string(),
    tableName: z.string(),
    sampled: z.boolean(),
    sampleRows: z.number().int().positive().nullable().default(null),
  }),
]);
export type SourceOrigin = z.infer<typeof SourceOrigin>;

export const SemanticType = z.enum([
  'identifier',
  'date',
  'datetime',
  'currency',
  'percentage',
  'geo_lat',
  'geo_lon',
  'geo_country',
  'geo_city',
  'geo_admin', // municipio / departamento / división administrativa
  'email',
  'phone',
  'person_document',
  'person_name',
  'address',
  'category',
  'free_text',
  'boolean_coded',
  'number',
  'integer',
  'unknown',
]);
export type SemanticType = z.infer<typeof SemanticType>;

export const ColumnProfile = z.object({
  name: z.string(),
  position: z.number().int().nonnegative(),
  physicalType: z.string(),
  semanticType: SemanticType,
  semanticConfidence: Confidence,
  /** Datos personales: sus valores nunca salen del worker ni van al LLM; en UI van enmascarados. */
  isPersonalData: z.boolean(),
  rowCount: z.number().int().nonnegative(),
  nullCount: z.number().int().nonnegative(),
  /** Vacíos que no son NULL: "", "N/A", "-", "NULL", "#N/A", 0 sospechoso. */
  emptyLikeCount: z.number().int().nonnegative(),
  distinctCount: z.number().int().nonnegative(),
  uniquenessRatio: z.number().min(0).max(1),
  min: z.string().nullable().default(null),
  max: z.string().nullable().default(null),
  mean: z.number().nullable().default(null),
  median: z.number().nullable().default(null),
  p95: z.number().nullable().default(null),
  /** Top-20 valores con frecuencia; enmascarados si la columna es personal. */
  topValues: z.array(z.object({ value: z.string(), count: z.number().int().nonnegative() })),
  lengthMin: z.number().int().nonnegative().nullable().default(null),
  lengthMax: z.number().int().nonnegative().nullable().default(null),
  lengthAvg: z.number().nullable().default(null),
  /** Patrones dominantes con dígitos colapsados a 9 y letras a A. */
  dominantPatterns: z.array(z.object({ pattern: z.string(), share: z.number().min(0).max(1) })),
  /** Riesgos detectados a nivel de columna, p.ej. fecha ambigua DD/MM vs MM/DD. */
  risks: z.array(z.string()),
});
export type ColumnProfile = z.infer<typeof ColumnProfile>;

export const TableSource = z.object({
  id: z.string(),
  /** Nombre técnico original (archivo/tabla). */
  technicalName: z.string(),
  /** Nombre de negocio propuesto (LLM o plantilla); editable por el usuario. */
  businessName: z.string(),
  origin: SourceOrigin,
  rowCount: z.number().int().nonnegative(),
  columns: z.array(ColumnProfile),
  ingestWarnings: z.array(z.string()),
});
export type TableSource = z.infer<typeof TableSource>;

// ───────────────────────── Llaves ─────────────────────────

export const KeyCandidate = z.object({
  sourceId: z.string(),
  columns: z.array(z.string()).min(1).max(3),
  kind: z.enum(['simple', 'composite']),
  uniquenessRatio: z.number().min(0).max(1),
  nullCount: z.number().int().nonnegative(),
  /** true si alcanza 100% unicidad y 0 nulos; si no, es "mejor candidata" y genera hallazgo. */
  isExact: z.boolean(),
  evidence: Evidence,
});
export type KeyCandidate = z.infer<typeof KeyCandidate>;

// ───────────────────────── Relaciones ─────────────────────────

/** Señales independientes del score; siempre reportadas por separado. */
export const RelationshipSignals = z.object({
  typeCompatibility: z.number().min(0).max(1),
  lexicalSimilarity: z.number().min(0).max(1),
  semanticSimilarity: z.number().min(0).max(1).nullable().default(null),
  /** Inclusión de valores del lado hijo en el padre (tras normalización). */
  valueInclusionLeftInRight: z.number().min(0).max(1),
  valueInclusionRightInLeft: z.number().min(0).max(1),
  parentUniqueness: z.number().min(0).max(1),
  cardinalityConsistency: z.number().min(0).max(1),
});
export type RelationshipSignals = z.infer<typeof RelationshipSignals>;

export const Penalty = z.object({
  reason: z.string(),
  /** Texto en lenguaje llano para la UI ("Los nombres se escriben de formas distintas…"). */
  plainText: z.string(),
  delta: z.number().max(0),
});
export type Penalty = z.infer<typeof Penalty>;

export const Cardinality = z.enum(['1:1', '1:N', 'N:1', 'N:M', 'unknown']);
export type Cardinality = z.infer<typeof Cardinality>;

export const Relationship = z.object({
  id: z.string(),
  leftSourceId: z.string(),
  leftColumns: z.array(z.string()).min(1),
  rightSourceId: z.string(),
  rightColumns: z.array(z.string()).min(1),
  /** declared: existía como FK/estructura; inferred: la dedujo el motor. */
  status: z.enum(['declared', 'inferred']),
  /** Clasificación por ratio de inclusión (§3.3 de la spec). */
  classification: z.enum([
    'declared',
    'solid', // inclusión ≥ 0.98
    'broken_integrity', // 0.75–0.98 → hallazgo de integridad
    'partial', // 0.30–0.75 → candidata a confirmar
    'domain_coincidence', // inclusión alta pero dominio de baja cardinalidad
  ]),
  cardinality: Cardinality,
  score: z.number().min(0).max(1),
  confidence: Confidence,
  signals: RelationshipSignals,
  penalties: z.array(Penalty),
  /** Normalizaciones aplicadas a los valores antes de comparar. */
  normalizations: z.array(z.string()),
  /** Ruta indirecta: ids de relaciones intermedias cuando el cruce pasa por otra tabla. */
  viaPath: z.array(z.string()).default([]),
  sampleSize: z.number().int().positive().nullable().default(null),
  limitations: z.array(z.string()),
  explanation: z.string(),
  evidence: z.array(Evidence).min(1),
  /** Decisión del usuario en Pantalla 2. */
  userDecision: z.enum(['pending', 'confirmed', 'rejected']).default('pending'),
  userComment: z.string().nullable().default(null),
  algorithmVersion: z.string(),
});
export type Relationship = z.infer<typeof Relationship>;

// ───────────────────────── Hallazgos ─────────────────────────

export const FindingCategory = z.enum([
  'orphan_records', // integridad referencial rota
  'near_duplicates', // casi-duplicados por normalización
  'embedded_list', // listas dentro de una celda (1FN)
  'redundant_copy', // dependencia transitiva/parcial expresada como copia
  'mirror_column', // columna calculada que no cuadra
  'ghost_column', // columna vacía en ~todas las filas
  'weak_key', // identificador con repetidos
  'ambiguous_date', // formato de fecha no resoluble
  'personal_data', // datos personales detectados
  'inflated_count', // duplicación de filas que infla conteos
  'other',
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const Finding = z.object({
  id: z.string(),
  severity: Severity,
  category: FindingCategory,
  /** Título en consecuencia de negocio, sin jerga: "312 pagos apuntan a un contrato que no existe". */
  title: z.string(),
  /** Qué implica si no se corrige. */
  consequence: z.string(),
  sourceIds: z.array(z.string()).min(1),
  columns: z.array(z.object({ sourceId: z.string(), column: z.string() })).default([]),
  affectedRows: z.number().int().nonnegative().nullable().default(null),
  evidence: z.array(Evidence).min(1),
  remediation: z
    .object({
      suggestion: z.string(),
      impact: z.enum(['high', 'medium', 'low']),
      effort: z.enum(['high', 'medium', 'low']),
    })
    .nullable()
    .default(null),
});
export type Finding = z.infer<typeof Finding>;

// ───────────────────────── Cruces (simulador) ─────────────────────────

export const JoinPrediction = z.object({
  id: z.string(),
  leftSourceId: z.string(),
  rightSourceId: z.string(),
  relationshipId: z.string().nullable().default(null),
  keys: z.array(z.object({ left: z.string(), right: z.string() })).min(1),
  /** Cadena de normalización usada para emparejar la llave (vacío = exacta). */
  normalizations: z.array(z.string()).default([]),
  /** Estimación por histogramas de frecuencia: sum(freq_left[k] * freq_right[k]). */
  expectedRows: z.object({ inner: Stat, left: Stat, full: Stat }),
  matchRate: z.object({ leftInRight: z.number().min(0).max(1), rightInLeft: z.number().min(0).max(1) }),
  unmatchedLeft: z.number().int().nonnegative(),
  unmatchedRight: z.number().int().nonnegative(),
  mostlyNullColumnsAfterJoin: z.array(z.string()),
  fanOut: z.object({
    risk: z.boolean(),
    multiplier: z.number().nullable().default(null),
    worstKey: z.object({ value: z.string(), leftCount: z.number(), rightCount: z.number() }).nullable().default(null),
    plainWarning: z.string().nullable().default(null),
  }),
  indicators: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      metricColumn: z.string(),
      dimensionColumn: z.string(),
      timeColumn: z.string().nullable().default(null),
      coverage: z.number().min(0).max(1),
      sql: z.string(),
    }),
  ),
  evidence: z.array(Evidence).min(1),
});
export type JoinPrediction = z.infer<typeof JoinPrediction>;

// ───────────────────────── Tablas puente ─────────────────────────

export const BridgeProposal = z.object({
  id: z.string(),
  kind: z.enum(['n_m', 'embedded_list']),
  /** Taxonomía de resolución (heredada de DataSketch): qué es realmente esta relación. */
  resolution: z.enum(['association', 'shared_dimension', 'identity_map', 'do_not_resolve']),
  title: z.string(),
  description: z.string(),
  sourceIds: z.array(z.string()).min(1),
  proposedTableName: z.string(),
  /** Confirmación de significado previa a generar (grano, temporalidad). */
  meaning: z
    .object({
      rowMeaning: z.string(),
      repeatsOverTime: z.boolean(),
      confirmedByUser: z.boolean(),
    })
    .nullable()
    .default(null),
  ddl: z.string(),
  populateSql: z.string(),
  resultMetrics: z
    .object({
      rows: z.number().int().nonnegative(),
      orphansLeft: z.number().int().nonnegative(),
      orphansRight: z.number().int().nonnegative(),
      avgDegreeLeft: z.number(),
      avgDegreeRight: z.number(),
      maxDegreeLeft: z.number().int(),
      maxDegreeRight: z.number().int(),
    })
    .nullable()
    .default(null),
  evidence: z.array(Evidence).min(1),
});
export type BridgeProposal = z.infer<typeof BridgeProposal>;

// ───────────────────────── Pipeline y artefacto ─────────────────────────

export const StageName = z.enum([
  'ingest',
  'profile',
  'keys',
  'relationships',
  'fuzzy_graph',
  'bridges',
  'quality',
  'joins',
  'report',
]);
export type StageName = z.infer<typeof StageName>;

export const StageRun = z.object({
  name: StageName,
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
  error: z.string().nullable().default(null),
  /** Etiqueta en lenguaje humano para la pantalla de progreso. */
  humanLabel: z.string(),
});
export type StageRun = z.infer<typeof StageRun>;

export const AnalysisReport = z.object({
  schemaVersion: z.string(),
  meta: z.object({
    jobId: z.string(),
    projectName: z.string(),
    createdAt: z.string().datetime(),
    engineVersion: z.string(),
    /** Semilla de todo muestreo: mismo input ⇒ mismo artefacto. */
    seed: z.number().int(),
    locale: z.string().default('es'),
    /** true si los textos narrados provienen de plantilla determinista (sin LLM). */
    llmUsed: z.boolean(),
  }),
  pipeline: z.array(StageRun),
  sources: z.array(TableSource),
  keyCandidates: z.array(KeyCandidate),
  relationships: z.array(Relationship),
  findings: z.array(Finding),
  joinPredictions: z.array(JoinPrediction),
  bridgeProposals: z.array(BridgeProposal),
});
export type AnalysisReport = z.infer<typeof AnalysisReport>;

/** Crea un artefacto vacío válido: el punto de partida de todo job. */
export function emptyReport(params: {
  jobId: string;
  projectName: string;
  engineVersion: string;
  schemaVersion: string;
  seed: number;
  createdAt?: string;
}): AnalysisReport {
  return AnalysisReport.parse({
    schemaVersion: params.schemaVersion,
    meta: {
      jobId: params.jobId,
      projectName: params.projectName,
      createdAt: params.createdAt ?? new Date().toISOString(),
      engineVersion: params.engineVersion,
      seed: params.seed,
      locale: 'es',
      llmUsed: false,
    },
    pipeline: [],
    sources: [],
    keyCandidates: [],
    relationships: [],
    findings: [],
    joinPredictions: [],
    bridgeProposals: [],
  });
}
