import {
  AnalysisReport,
  emptyReport,
  PRODUCT,
  type DbConnection,
  type StageName,
  type StageRun,
} from '@sondadata/schema';
import { DuckSession } from './duckdb.js';

/** Etiquetas humanas de cada etapa, tal como se muestran en la pantalla de progreso. */
export const STAGE_LABELS: Record<StageName, string> = {
  ingest: 'Leyendo tus archivos',
  profile: 'Entendiendo cada columna',
  keys: 'Buscando identificadores',
  relationships: 'Detectando relaciones entre tus fuentes',
  fuzzy_graph: 'Buscando conexiones menos evidentes',
  bridges: 'Preparando tablas auxiliares',
  quality: 'Revisando la calidad de los datos',
  joins: 'Calculando qué cruces son posibles',
  report: 'Redactando el informe',
};

export interface PipelineContext {
  session: DuckSession;
  /** Carpeta con los archivos de entrada del job (puede estar vacía si hay conexión). */
  inputDir: string;
  /** Conexión viva de solo lectura, si la fuente es una base de datos. */
  connection?: DbConnection | null;
  report: AnalysisReport;
  /** Emisor de progreso hacia job_events. */
  emit: (stage: StageName, message: string) => void;
}

export type Stage = {
  name: StageName;
  run: (ctx: PipelineContext) => Promise<void>;
};

export interface PipelineResult {
  report: AnalysisReport;
  failedStages: StageName[];
}

/**
 * Ejecuta las etapas en orden sobre una sesión efímera. Una etapa que falla no
 * tumba el pipeline: se registra el error y se continúa (criterio F8 adelantado,
 * porque cambiarlo después costaría más que hacerlo bien desde el principio).
 */
export async function runPipeline(params: {
  jobId: string;
  projectName: string;
  inputDir: string;
  connection?: DbConnection | null;
  stages: Stage[];
  seed?: number;
  emit?: (stage: StageName, message: string) => void;
}): Promise<PipelineResult> {
  const { jobId, projectName, inputDir, stages } = params;
  const emit = params.emit ?? (() => {});
  const session = await DuckSession.createEphemeral(jobId);
  const report = emptyReport({
    jobId,
    projectName,
    engineVersion: PRODUCT.engineVersion,
    schemaVersion: PRODUCT.schemaVersion,
    seed: params.seed ?? 1,
  });
  const failedStages: StageName[] = [];

  try {
    for (const stage of stages) {
      const runInfo: StageRun = {
        name: stage.name,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        humanLabel: STAGE_LABELS[stage.name],
      };
      report.pipeline.push(runInfo);
      emit(stage.name, `${STAGE_LABELS[stage.name]}…`);
      try {
        await stage.run({ session, inputDir, connection: params.connection ?? null, report, emit });
        runInfo.status = 'done';
      } catch (err) {
        runInfo.status = 'failed';
        runInfo.error = err instanceof Error ? err.message : String(err);
        failedStages.push(stage.name);
        emit(stage.name, `Hubo un problema en esta etapa; continuamos con el resto.`);
      } finally {
        runInfo.finishedAt = new Date().toISOString();
      }
    }
    // El artefacto siempre sale validado: si esto lanza, es un bug del motor.
    const validated = AnalysisReport.parse(report);
    return { report: validated, failedStages };
  } finally {
    await session.destroy();
  }
}
