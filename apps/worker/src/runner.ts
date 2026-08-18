import { defaultStages, runPipeline } from '@sondadata/engine';
import type { AnalysisJob, DbConnection } from '@sondadata/schema';
import type { JobStore } from './store.js';
import { decryptJson } from './crypto.js';

/**
 * Ciclo del worker: toma el siguiente job en cola (polling; sin cola externa
 * en el MVP), lo ejecuta sobre una sesión DuckDB efímera y guarda el artefacto.
 */
export class JobRunner {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: JobStore,
    private readonly pollMs = 2000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Un tick: si no hay job corriendo, toma el siguiente de la cola. Expuesto para tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    const job = this.store.nextQueued();
    if (!job) return;
    this.running = true;
    try {
      await this.runJob(job);
    } finally {
      this.running = false;
    }
  }

  private async runJob(job: AnalysisJob): Promise<void> {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.store.update(job);

    try {
      let connection: DbConnection | null = null;
      if (job.connectionEncrypted) {
        try {
          connection = decryptJson<DbConnection>(job.connectionEncrypted);
        } catch {
          throw new Error('No se pudieron descifrar las credenciales de la conexión (¿cambió la clave del servidor?).');
        }
      }
      const { report, failedStages } = await runPipeline({
        jobId: job.id,
        projectName: job.projectName,
        inputDir: job.inputDir,
        connection,
        stages: defaultStages,
        emit: (stage, message) => {
          job.events.push({ at: new Date().toISOString(), stage, message });
          this.store.update(job);
        },
      });
      job.artifactPath = this.store.saveArtifact(job.id, report);
      job.status = 'done';
      if (failedStages.length > 0) {
        job.events.push({
          at: new Date().toISOString(),
          stage: 'report',
          message: `Etapas con problemas: ${failedStages.join(', ')}. El resto del análisis está completo.`,
        });
      }
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = new Date().toISOString();
      this.store.update(job);
    }
  }
}
