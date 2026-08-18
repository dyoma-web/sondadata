import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnalysisJob, type AnalysisReport } from '@sondadata/schema';

/**
 * Almacén de jobs y artefactos.
 *
 * MVP local: JSON sobre disco. La interfaz está pensada para que el driver de
 * producción (Supabase: tabla `analysis_jobs` + Storage privado) sea un
 * reemplazo directo sin tocar el resto del worker.
 */
export interface JobStore {
  create(job: AnalysisJob): void;
  get(id: string): AnalysisJob | null;
  update(job: AnalysisJob): void;
  list(): AnalysisJob[];
  nextQueued(): AnalysisJob | null;
  saveArtifact(jobId: string, report: AnalysisReport): string;
  readArtifact(jobId: string): AnalysisReport | null;
}

export class FileJobStore implements JobStore {
  private readonly jobsDir: string;
  private readonly artifactsDir: string;

  constructor(dataDir: string) {
    this.jobsDir = join(dataDir, 'jobs');
    this.artifactsDir = join(dataDir, 'artifacts');
    mkdirSync(this.jobsDir, { recursive: true });
    mkdirSync(this.artifactsDir, { recursive: true });
  }

  create(job: AnalysisJob): void {
    this.update(job);
  }

  get(id: string): AnalysisJob | null {
    try {
      const raw = readFileSync(join(this.jobsDir, `${id}.json`), 'utf8');
      return AnalysisJob.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  update(job: AnalysisJob): void {
    writeFileSync(join(this.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2), 'utf8');
  }

  list(): AnalysisJob[] {
    return readdirSync(this.jobsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.get(f.replace(/\.json$/, '')))
      .filter((j): j is AnalysisJob => j !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  nextQueued(): AnalysisJob | null {
    return (
      this.list()
        .filter((j) => j.status === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null
    );
  }

  saveArtifact(jobId: string, report: AnalysisReport): string {
    const path = join(this.artifactsDir, `${jobId}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
    return path;
  }

  readArtifact(jobId: string): AnalysisReport | null {
    try {
      return JSON.parse(readFileSync(join(this.artifactsDir, `${jobId}.json`), 'utf8')) as AnalysisReport;
    } catch {
      return null;
    }
  }
}
