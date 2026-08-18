export { DuckSession } from './duckdb.js';
export { runPipeline, STAGE_LABELS, type PipelineContext, type Stage, type PipelineResult } from './pipeline.js';
export { ingestStage } from './stages/ingest.js';
export { profileStage } from './stages/profile.js';
export { keysStage } from './stages/keys.js';
export { relationshipsStage } from './stages/relationships.js';
export { inferSemantic, maskValue, type SemanticInput, type SemanticResult } from './semantic.js';
export { interpretWorksheet, readWorkbook, toCsv, type SheetInterpretation } from './xlsx.js';
export { nameSimilarity, jaroWinkler, normalizeIdentifier } from './similarity.js';
export { scoreRelationship, classifyInclusion, SCORING_VERSION, type ScoreInput, type ScoreResult } from './scoring.js';
export { normalizeSql, CHAIN_LABELS, type NormalizationChain } from './normalize.js';
export { findIndirectRoutes, type IndirectRoute } from './routes.js';
export { bridgesStage } from './stages/bridges.js';
export { qualityStage, clusterVariants } from './stages/quality.js';
export { joinsStage } from './stages/joins.js';
export { executeJoin, executeBridge, type ExecutedResult } from './execute.js';
export { renderReportHtml } from './report/html.js';
export { renderReportDocx } from './report/docx.js';
export { prioritizeFindings } from './report/common.js';
import { ingestStage } from './stages/ingest.js';
import { profileStage } from './stages/profile.js';
import { keysStage } from './stages/keys.js';
import { relationshipsStage } from './stages/relationships.js';
import { bridgesStage } from './stages/bridges.js';
import { qualityStage } from './stages/quality.js';
import { joinsStage } from './stages/joins.js';
import type { Stage } from './pipeline.js';

/** Pipeline por defecto del MVP. Las etapas se irán añadiendo fase a fase. */
export const defaultStages: Stage[] = [
  ingestStage,
  profileStage,
  keysStage,
  relationshipsStage,
  bridgesStage,
  qualityStage,
  joinsStage,
];
