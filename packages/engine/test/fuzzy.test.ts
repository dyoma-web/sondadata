import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalysisReport as Report } from '@sondadata/schema';
import { generateFixtures } from '@sondadata/fixtures';
import { defaultStages, findIndirectRoutes, runPipeline } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'sondadata-f3-'));
let report: Report;

beforeAll(async () => {
  await generateFixtures(dir, { seed: 20260810 });
  const result = await runPipeline({ jobId: 'f3-test', projectName: 'F3', inputDir: dir, stages: defaultStages });
  report = result.report;
}, 240_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const name = (id: string) => report.sources.find((s) => s.id === id)?.technicalName ?? id;
const rel = (child: string, childCol: string, parent: string) =>
  report.relationships.find(
    (r) => name(r.leftSourceId) === child && r.leftColumns[0] === childCol && name(r.rightSourceId) === parent,
  );

describe('F3 · aceptación — cruces difusos y tablas puente', () => {
  it('encuentra la relación con llave en formatos distintos (P-0001 vs 1) vía normalización', () => {
    const r = rel('actividades.csv', 'proyecto', 'proyectos.csv');
    expect(r).toBeDefined();
    expect(r!.normalizations).toContain('digits');
    expect(r!.classification).toBe('solid');
    expect(r!.confidence).toBe('high');
  });

  it('detecta los 312 huérfanos de pagos como integridad rota, con hallazgo crítico', () => {
    const r = rel('pagos.csv', 'proyecto', 'proyectos.csv');
    expect(r).toBeDefined();
    expect(r!.classification).toBe('broken_integrity');

    const finding = report.findings.find((f) => f.category === 'orphan_records' && f.affectedRows === 312);
    expect(finding, 'hallazgo de 312 huérfanos').toBeDefined();
    expect(finding!.severity).toBe('critical');
    expect(finding!.title).toContain('312');
    expect(finding!.evidence[0]!.sql).toContain('NOT IN');
  });

  it('conecta actividades con municipios pese a las variantes de escritura (candidata, no afirmación)', () => {
    const r = rel('actividades.csv', 'municipio_nombre', 'municipios.csv');
    expect(r).toBeDefined();
    expect(r!.normalizations).toContain('basic');
    expect(['partial', 'broken_integrity']).toContain(r!.classification);
    expect(r!.confidence).not.toBe('high'); // sin resolver variantes, no puede afirmarse
  });

  it('encuentra al menos una ruta indirecta de 2 saltos', () => {
    const routes = findIndirectRoutes(report.relationships, 3);
    expect(routes.length).toBeGreaterThan(0);
    const twoHop = routes.filter((r) => r.path.length === 2);
    expect(twoHop.length, 'rutas de exactamente 2 saltos').toBeGreaterThan(0);
    // toda ruta declara sus tablas intermedias y su score acumulado
    for (const r of routes) {
      expect(r.via.length).toBe(r.path.length - 1);
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    // ejemplo concreto: entidades se puede cruzar con pagos pasando por proyectos
    const viaProyectos = routes.find((r) => r.via.some((v) => name(v) === 'proyectos.csv') && r.path.length === 2);
    expect(viaProyectos, 'alguna ruta de 2 saltos que pasa por proyectos').toBeDefined();
  });

  it('propone la tabla puente de la lista embebida (sectores) con métricas ejecutadas', () => {
    const bridge = report.bridgeProposals.find((b) => b.kind === 'embedded_list' && b.title.includes('sectores'));
    expect(bridge).toBeDefined();
    expect(bridge!.resultMetrics!.rows).toBeGreaterThan(400); // explota a más filas que actividades
    expect(bridge!.ddl).toContain('CREATE TABLE');
    expect(bridge!.populateSql).toContain('string_split');
    expect(bridge!.meaning).toBeNull(); // nada se genera sin confirmación
  });

  it('propone la tabla puente de la N:M resuelta por duplicación (beneficiarios)', () => {
    const bridge = report.bridgeProposals.find((b) => b.kind === 'n_m');
    expect(bridge).toBeDefined();
    expect(bridge!.resultMetrics!.rows).toBe(1959); // pares distintos documento×proyecto
    expect(bridge!.resultMetrics!.avgDegreeLeft).toBeGreaterThan(1); // una persona, varios proyectos
  });
});
