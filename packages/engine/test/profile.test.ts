import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalysisReport, type AnalysisReport as Report } from '@sondadata/schema';
import { generateFixtures } from '@sondadata/fixtures';
import { defaultStages, runPipeline } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'sondadata-f1-'));
let report: Report;

beforeAll(async () => {
  await generateFixtures(dir, { seed: 20260810 });
  const result = await runPipeline({
    jobId: 'f1-test',
    projectName: 'F1',
    inputDir: dir,
    stages: defaultStages,
  });
  report = result.report;
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function source(name: string) {
  const s = report.sources.find((s) => s.technicalName === name);
  if (!s) throw new Error(`Fuente no encontrada: ${name}`);
  return s;
}
function column(sourceName: string, col: string) {
  const c = source(sourceName).columns.find((c) => c.name === col);
  if (!c) throw new Error(`Columna no encontrada: ${sourceName}.${col}`);
  return c;
}

describe('F1 · aceptación — perfilado del fixture sucio', () => {
  it('el artefacto valida y las 6 fuentes están perfiladas', () => {
    expect(() => AnalysisReport.parse(report)).not.toThrow();
    expect(report.sources.length).toBeGreaterThanOrEqual(6);
    for (const s of report.sources) {
      expect(s.columns.length, s.technicalName).toBeGreaterThan(0);
    }
  });

  it('detecta el Excel humano: encabezado en fila 4, totales excluidos', () => {
    const xlsx = source('ejecucion_2024.xlsx');
    expect(xlsx.origin.kind).toBe('file');
    if (xlsx.origin.kind === 'file') {
      expect(xlsx.origin.interpretation?.headerRow).toBe(4);
      expect(xlsx.origin.interpretation?.discardedRows).toContain(1);
      expect(xlsx.origin.interpretation?.confirmedByUser).toBe(false);
    }
    expect(xlsx.rowCount).toBe(12); // 4 trimestres × 3 municipios, sin la fila TOTAL
    expect(xlsx.ingestWarnings.some((w) => w.includes('totales'))).toBe(true);
  });

  it('marca los datos personales de beneficiarios y los enmascara', () => {
    const correo = column('beneficiarios.csv', 'correo');
    expect(correo.semanticType).toBe('email');
    expect(correo.isPersonalData).toBe(true);
    expect(correo.topValues.every((tv) => !tv.value.includes('@ejemplo.org'))).toBe(true);
    expect(correo.min).toBeNull();

    const tel = column('beneficiarios.csv', 'telefono');
    expect(tel.semanticType).toBe('phone');
    expect(tel.isPersonalData).toBe(true);

    const doc = column('beneficiarios.csv', 'documento');
    expect(doc.semanticType).toBe('person_document');
    expect(doc.isPersonalData).toBe(true);

    const nombre = column('beneficiarios.csv', 'nombre_completo');
    expect(nombre.semanticType).toBe('person_name');
    expect(nombre.isPersonalData).toBe(true);
  });

  it('NO marca como personales los nombres de organizaciones (falso positivo)', () => {
    const ent = column('entidades.csv', 'nombre_entidad');
    expect(ent.isPersonalData).toBe(false);
    const proy = column('proyectos.csv', 'nombre');
    expect(proy.isPersonalData).toBe(false);
  });

  it('identifica tipos semánticos clave en las demás fuentes', () => {
    expect(column('proyectos.csv', 'id_proyecto').semanticType).toBe('identifier');
    expect(column('proyectos.csv', 'id_proyecto').uniquenessRatio).toBe(1);
    expect(column('proyectos.csv', 'presupuesto').semanticType).toBe('currency');
    expect(column('proyectos.csv', 'municipio').semanticType).toBe('geo_admin');
    expect(column('actividades.csv', 'fecha').semanticType).toBe('date');
    expect(['category', 'unknown']).toContain(column('actividades.csv', 'sectores').semanticType);
  });

  it('señala el riesgo de fechas mezcladas/ambiguas en pagos.fecha_pago', () => {
    const fecha = column('pagos.csv', 'fecha_pago');
    expect(fecha.semanticType).toBe('date');
    expect(fecha.risks.length).toBeGreaterThan(0);
  });

  it('perfila la columna fantasma: vacía en ~99% de las filas', () => {
    const obs = column('actividades.csv', 'observaciones_2');
    const emptyish = obs.nullCount + obs.emptyLikeCount;
    expect(emptyish / obs.rowCount).toBeGreaterThan(0.95);
  });

  it('los patrones dominantes colapsan dígitos y letras', () => {
    const id = column('proyectos.csv', 'id_proyecto');
    expect(id.dominantPatterns[0]?.pattern).toBe('A-9999');
  });
});
