import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AnalysisReport } from '@sondadata/schema';
import { FileJobStore } from '../src/store.js';
import { JobRunner } from '../src/runner.js';

const dataDir = mkdtempSync(join(tmpdir(), 'sondadata-worker-'));
const inputDir = mkdtempSync(join(tmpdir(), 'sondadata-input-'));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(inputDir, { recursive: true, force: true });
});

describe('ciclo de job (criterio de aceptación F0)', () => {
  it('recorre queued → running → done y produce un artefacto válido', async () => {
    writeFileSync(join(inputDir, 'datos.csv'), 'id,valor\n1,100\n2,200\n3,300\n', 'utf8');

    const store = new FileJobStore(dataDir);
    store.create({
      id: 'f0-demo',
      projectName: 'Demo F0',
      status: 'queued',
      inputDir,
      connectionEncrypted: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      events: [],
      artifactPath: null,
    });

    const runner = new JobRunner(store, 999999);
    await runner.tick(); // un tick procesa el job completo

    const job = store.get('f0-demo');
    expect(job?.status).toBe('done');
    expect(job?.startedAt).not.toBeNull();
    expect(job?.finishedAt).not.toBeNull();
    expect(job?.events.length).toBeGreaterThan(0);

    const report = store.readArtifact('f0-demo');
    expect(report).not.toBeNull();
    expect(() => AnalysisReport.parse(report)).not.toThrow();
    expect(report?.sources[0]?.rowCount).toBe(3);
  });
});
