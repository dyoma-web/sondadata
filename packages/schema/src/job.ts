import { z } from 'zod';

/** Estados del ciclo de vida de un job de análisis. */
export const JobStatus = z.enum(['queued', 'running', 'done', 'failed', 'canceled']);
export type JobStatus = z.infer<typeof JobStatus>;

/** Conexión viva a una base de datos. SIEMPRE de solo lectura. */
export const DbConnection = z.object({
  engine: z.enum(['postgresql', 'mysql']),
  host: z.string().min(1),
  port: z.number().int().positive(),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
  /** Esquema a analizar (Postgres); en MySQL se usa la base de datos. */
  schemaName: z.string().nullable().default(null),
  /** Máximo de filas muestreadas por tabla. */
  sampleRows: z.number().int().positive().default(200_000),
});
export type DbConnection = z.infer<typeof DbConnection>;

export const JobEvent = z.object({
  at: z.string().datetime(),
  stage: z.string(),
  /** Mensaje en lenguaje humano para la pantalla de progreso. */
  message: z.string(),
});
export type JobEvent = z.infer<typeof JobEvent>;

export const AnalysisJob = z.object({
  id: z.string(),
  projectName: z.string(),
  status: JobStatus,
  /** Carpeta local con los archivos a analizar (MVP local; en producción, Storage). */
  inputDir: z.string(),
  /**
   * Conexión cifrada (AES-256-GCM) cuando la fuente es una base de datos.
   * Nunca se devuelve por la API ni aparece en logs.
   */
  connectionEncrypted: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
  error: z.string().nullable().default(null),
  events: z.array(JobEvent).default([]),
  /** Ruta del artefacto AnalysisReport una vez terminado. */
  artifactPath: z.string().nullable().default(null),
});
export type AnalysisJob = z.infer<typeof AnalysisJob>;
