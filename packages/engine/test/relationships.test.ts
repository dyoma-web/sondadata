import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalysisReport as Report } from '@sondadata/schema';
import { generateFixtures } from '@sondadata/fixtures';
import { defaultStages, runPipeline } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'sondadata-f2-'));
let report: Report;

beforeAll(async () => {
  await generateFixtures(dir, { seed: 20260810 });
  const result = await runPipeline({ jobId: 'f2-test', projectName: 'F2', inputDir: dir, stages: defaultStages });
  report = result.report;
}, 180_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const name = (id: string) => report.sources.find((s) => s.id === id)?.technicalName ?? id;
const rel = (child: string, childCol: string, parent: string) =>
  report.relationships.find(
    (r) => name(r.leftSourceId) === child && r.leftColumns[0] === childCol && name(r.rightSourceId) === parent,
  );

describe('F2 · llaves y relaciones sobre el fixture', () => {
  it('encuentra las llaves primarias correctas', () => {
    const keys = new Map(report.keyCandidates.map((k) => [name(k.sourceId), k]));
    expect(keys.get('proyectos.csv')?.columns).toEqual(['id_proyecto']);
    expect(keys.get('proyectos.csv')?.isExact).toBe(true);
    expect(keys.get('pagos.csv')?.columns).toEqual(['id_pago']);
    expect(keys.get('actividades.csv')?.columns).toEqual(['id_actividad']);
    // beneficiarios no tiene llave simple: la llave real es compuesta
    // (documento + id_proyecto), porque las personas se repiten entre proyectos
    const benef = keys.get('beneficiarios.csv');
    expect(benef).toBeDefined();
    if (benef!.isExact) expect(benef!.kind).toBe('composite');
  });

  it('detecta beneficiarios → proyectos como relación sólida', () => {
    const r = rel('beneficiarios.csv', 'id_proyecto', 'proyectos.csv');
    expect(r).toBeDefined();
    expect(r!.classification).toBe('solid');
    expect(r!.confidence).toBe('high');
    expect(r!.cardinality).toBe('N:1');
  });

  it('detecta actividades → entidades por NIT', () => {
    const r = rel('actividades.csv', 'entidad_nit', 'entidades.csv');
    expect(r).toBeDefined();
    expect(['solid', 'partial']).toContain(r!.classification);
  });

  it('encuentra la relación con llave de formato distinto (P-0001 vs 1) vía normalización', () => {
    const r = rel('actividades.csv', 'proyecto', 'proyectos.csv');
    expect(r).toBeDefined();
    expect(r!.normalizations).toContain('digits');
  });

  it('no eleva a alta confianza los casos negativos (anio, codigo)', () => {
    for (const r of report.relationships) {
      const cols = [...r.leftColumns, ...r.rightColumns].join(',');
      if (/anio|codigo/.test(cols)) {
        expect(r.confidence, `${cols} no debería ser confianza alta`).not.toBe('high');
      }
    }
  });

  it('toda relación inferida lleva señales desglosadas y evidencia SQL', () => {
    expect(report.relationships.length).toBeGreaterThan(0);
    for (const r of report.relationships) {
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.evidence[0]!.sql).toContain('SELECT');
      expect(r.signals.valueInclusionLeftInRight).toBeGreaterThan(0);
      expect(r.explanation.length).toBeGreaterThan(10);
    }
  });
});
