import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Sesión DuckDB efímera: una por job, aislada en un directorio temporal propio,
 * destruida (archivo incluido) al terminar o al fallar. Un job nunca puede leer
 * datos de otro.
 */
export class DuckSession {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
    private readonly workDir: string | null,
  ) {}

  /** Crea una sesión sobre archivo en un directorio temporal exclusivo del job. */
  static async createEphemeral(jobId: string): Promise<DuckSession> {
    const workDir = mkdtempSync(join(tmpdir(), `sondadata-${jobId}-`));
    const instance = await DuckDBInstance.create(join(workDir, 'analysis.duckdb'));
    const conn = await instance.connect();
    return new DuckSession(instance, conn, workDir);
  }

  /** Sesión en memoria, para tests. */
  static async createInMemory(): Promise<DuckSession> {
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    return new DuckSession(instance, conn, mkdtempSync(join(tmpdir(), 'sondadata-mem-')));
  }

  /**
   * Directorio de staging del job (archivos intermedios, p.ej. CSV normalizado
   * de un XLSX). Vive dentro del directorio del job y se destruye con él.
   */
  stagingDir(): string {
    const dir = join(this.workDir ?? tmpdir(), 'staging');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Ejecuta SQL y devuelve las filas como objetos planos (BigInt → number). */
  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const reader = await this.conn.runAndReadAll(sql);
    return reader.getRowObjects().map((row) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        out[key] = typeof value === 'bigint' ? Number(value) : value;
      }
      return out as T;
    });
  }

  /** Ejecuta SQL sin leer resultado (DDL, COPY, etc.). */
  async run(sql: string): Promise<void> {
    await this.conn.run(sql);
  }

  /** Devuelve el primer valor de la primera fila (útil para COUNT, ratios). */
  async scalar<T = number>(sql: string): Promise<T> {
    const rows = await this.query(sql);
    const first = rows[0];
    if (!first) throw new Error(`La consulta no devolvió filas: ${sql}`);
    const value = Object.values(first)[0];
    return value as T;
  }

  /** Cierra conexión e instancia y borra el directorio de trabajo del job. */
  async destroy(): Promise<void> {
    try {
      this.conn.closeSync();
      this.instance.closeSync();
    } finally {
      if (this.workDir) {
        // En Windows el sistema puede tardar en liberar el lock del archivo.
        rmSync(this.workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  }
}
