import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalysisReport, type AnalysisReport as Report } from '@sondadata/schema';
import { generateFixtures } from '@sondadata/fixtures';
import { clusterVariants, defaultStages, runPipeline } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'sondadata-f4-'));
let report: Report;

beforeAll(async () => {
  await generateFixtures(dir, { seed: 20260810 });
  const result = await runPipeline({ jobId: 'f4-test', projectName: 'F4', inputDir: dir, stages: defaultStages });
  report = result.report;
}, 300_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const byCat = (cat: string) => report.findings.filter((f) => f.category === cat);
const name = (id: string) => report.sources.find((s) => s.id === id)?.technicalName ?? id;

describe('clusterVariants (unidad)', () => {
  it('agrupa las 5 formas de escribir un municipio', () => {
    const clusters = clusterVariants([
      { value: 'Santa Rosa', count: 10 },
      { value: 'Sta. Rosa', count: 5 },
      { value: 'SANTA ROSA', count: 4 },
      { value: 'santa rosa (Cauca)', count: 2 },
      { value: 'Sta Rosa', count: 1 },
      { value: 'La Esperanza', count: 8 },
    ]);
    expect(clusters.length).toBe(2);
    const santaRosa = clusters.find((c) => c.representative === 'Santa Rosa');
    expect(santaRosa!.variants.length).toBe(5);
  });
});

describe('F4 · diagnóstico de calidad sobre el fixture', () => {
  it('el artefacto completo valida contra el contrato', () => {
    expect(() => AnalysisReport.parse(report)).not.toThrow();
  });

  it('casi-duplicados: detecta las variantes de municipio como grupos a unificar', () => {
    const f = byCat('near_duplicates').find((f) => f.title.includes('municipio'));
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(Array.isArray(f!.evidence[0]!.result)).toBe(true);
  });

  it('casi-duplicados: NO marca series numeradas ni columnas de listas (falsos positivos)', () => {
    const titles = byCat('near_duplicates').map((f) => f.title);
    expect(titles.some((t) => t.includes('descripcion'))).toBe(false);
    expect(titles.some((t) => t.includes('concepto'))).toBe(false);
    expect(titles.some((t) => t.includes('sectores'))).toBe(false);
    expect(titles.some((t) => t.includes('«nombre»'))).toBe(false);
  });

  it('el catálogo de municipios NO se marca como datos personales', () => {
    const f = byCat('personal_data').find((f) => name(f.sourceIds[0]!) === 'municipios.csv');
    expect(f).toBeUndefined();
  });

  it('columna fantasma: observaciones_2 vacía ~99%', () => {
    const f = byCat('ghost_column').find((f) => f.title.includes('observaciones_2'));
    expect(f).toBeDefined();
  });

  it('columna espejo: valor_total no cuadra en exactamente 14 filas', () => {
    const f = byCat('mirror_column')[0];
    expect(f).toBeDefined();
    expect(f!.title).toContain('valor_total');
    expect(f!.affectedRows).toBe(14);
  });

  it('copia redundante: el nombre de la entidad se repite en actividades según el NIT', () => {
    const f = byCat('redundant_copy').find((f) => name(f.sourceIds[0]!) === 'actividades.csv');
    expect(f).toBeDefined();
    expect(f!.title).toMatch(/entidad/);
  });

  it('fechas mezcladas: fecha_pago genera hallazgo de atención', () => {
    const f = byCat('ambiguous_date').find((f) => f.title.includes('fecha_pago'));
    expect(f).toBeDefined();
  });

  it('conteo inflado: beneficiarios cuenta personas de más si se suman filas', () => {
    const f = byCat('inflated_count')[0];
    expect(f).toBeDefined();
    expect(f!.title).toContain('800');
  });

  it('datos personales: hallazgo informativo en beneficiarios', () => {
    const f = byCat('personal_data').find((f) => name(f.sourceIds[0]!) === 'beneficiarios.csv');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('info');
  });
});

describe('F4 · simulador de cruces', () => {
  it('predice el cruce actividades × proyectos con exactitud (estimador por frecuencias)', () => {
    const pred = report.joinPredictions.find(
      (p) => name(p.leftSourceId) === 'actividades.csv' && name(p.rightSourceId) === 'proyectos.csv',
    );
    expect(pred).toBeDefined();
    // cada actividad tiene exactamente un proyecto existente → inner = 400
    expect(pred!.expectedRows.inner.value).toBe(400);
    expect(pred!.expectedRows.inner.exact).toBe(true);
    expect(pred!.fanOut.risk).toBe(false);
  });

  it('el cruce por fecha dispara la advertencia de explosión con el multiplicador', () => {
    const pred = report.joinPredictions.find((p) => p.relationshipId === null && p.keys[0]!.left.includes('fecha'));
    expect(pred, 'predicción del cruce tentador por fecha').toBeDefined();
    expect(pred!.fanOut.risk).toBe(true);
    expect(pred!.fanOut.multiplier).toBeGreaterThan(3);
    expect(pred!.fanOut.plainWarning).toContain('no identifica un registro único');
    expect(pred!.fanOut.worstKey).not.toBeNull();
  });

  it('el catálogo de indicadores propone métrica × dimensión con SQL copiable', () => {
    const withIndicators = report.joinPredictions.filter((p) => p.indicators.length > 0);
    expect(withIndicators.length).toBeGreaterThan(0);
    const ind = withIndicators[0]!.indicators[0]!;
    expect(ind.sql).toContain('GROUP BY');
    expect(ind.coverage).toBeGreaterThan(0);
    expect(ind.description.length).toBeGreaterThan(10);
  });

  it('los pagos huérfanos aparecen como registros que quedan fuera del cruce', () => {
    const pred = report.joinPredictions.find(
      (p) => name(p.leftSourceId) === 'pagos.csv' && name(p.rightSourceId) === 'proyectos.csv',
    );
    expect(pred).toBeDefined();
    expect(pred!.unmatchedLeft).toBe(312);
  });
});
