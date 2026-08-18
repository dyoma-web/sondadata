import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AnalysisReport } from '@sondadata/schema';
import { defaultStages, DuckSession, runPipeline } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'sondadata-test-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('DuckSession', () => {
  it('ejecuta SQL y convierte BigInt a number', async () => {
    const s = await DuckSession.createInMemory();
    try {
      const rows = await s.query<{ x: number }>('SELECT 42::BIGINT AS x');
      expect(rows[0]?.x).toBe(42);
    } finally {
      await s.destroy();
    }
  });
});

describe('runPipeline (F0)', () => {
  it('ingiere CSVs, produce un AnalysisReport válido y sobrevive a un archivo corrupto', async () => {
    writeFileSync(
      join(dir, 'proyectos.csv'),
      'id_proyecto,nombre,municipio\nP-0001,Agua potable,Santa Rosa\nP-0002,Educación rural,Sta. Rosa\n',
      'utf8',
    );
    writeFileSync(join(dir, 'roto.json'), '{esto no es json valido', 'utf8');

    const events: string[] = [];
    const { report, failedStages } = await runPipeline({
      jobId: 'test-1',
      projectName: 'Demo',
      inputDir: dir,
      stages: defaultStages,
      emit: (_stage, msg) => events.push(msg),
    });

    // El artefacto siempre valida contra el contrato
    expect(() => AnalysisReport.parse(report)).not.toThrow();
    // La etapa no falla por un archivo corrupto: falla esa tabla y continúa
    expect(failedStages).toEqual([]);
    const proyectos = report.sources.find((s) => s.technicalName === 'proyectos.csv');
    const roto = report.sources.find((s) => s.technicalName === 'roto.json');
    expect(proyectos?.rowCount).toBe(2);
    expect(roto?.ingestWarnings.length).toBeGreaterThan(0);
    expect(report.pipeline[0]?.status).toBe('done');
    expect(events.some((e) => e.includes('proyectos.csv'))).toBe(true);
  });
});
