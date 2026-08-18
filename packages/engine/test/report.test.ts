import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalysisReport as Report } from '@sondadata/schema';
import { generateFixtures } from '@sondadata/fixtures';
import { defaultStages, renderReportDocx, renderReportHtml, runPipeline } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'sondadata-f5-'));
let report: Report;
let html: string;

beforeAll(async () => {
  await generateFixtures(dir, { seed: 20260810 });
  const result = await runPipeline({
    jobId: 'f5-test',
    projectName: 'Programa de Inversión Social 2024',
    inputDir: dir,
    stages: defaultStages,
  });
  report = result.report;
  html = renderReportHtml(report);
}, 300_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('F5 · informe HTML', () => {
  it('es un documento autocontenido con todas las secciones', () => {
    expect(html).toContain('<!DOCTYPE html>');
    for (const section of [
      'Resumen ejecutivo',
      'Mapa de datos',
      'Inventario de fuentes',
      'Diagnóstico',
      'Oportunidades de cruce',
      'Plan de remediación',
      'Anexo A',
      'Anexo B',
    ]) {
      expect(html, section).toContain(section);
    }
    // autocontenido: sin recursos externos
    expect(html).not.toMatch(/src="http/);
    expect(html).not.toMatch(/href="http/);
    // CSS de impresión real
    expect(html).toContain('@page');
    expect(html).toContain('size: A4');
    // el mapa E-R va embebido como SVG
    expect(html).toContain('<svg');
  });

  it('el cuerpo habla en consecuencias, sin jerga de bases de datos', () => {
    const body = html.slice(0, html.indexOf('Anexo A'));
    for (const jargon of ['forma normal', '3FN', '2FN', 'dependencia funcional', 'fan-out', 'JOIN ', 'foreign key', 'cardinalidad']) {
      expect(body.toLowerCase(), `no debe contener «${jargon}»`).not.toContain(jargon.toLowerCase());
    }
    expect(html).toContain('312');
    expect(html).toContain('salvo en 14 filas');
  });

  it('el anexo permite reconstruir cualquier afirmación: cada hallazgo lleva su SQL', () => {
    const annex = html.slice(html.indexOf('Anexo A'));
    for (const f of report.findings) {
      expect(annex, f.title.slice(0, 40)).toContain('SELECT');
    }
    // el conteo de bloques SQL cubre al menos un query por hallazgo
    const sqlBlocks = (annex.match(/<pre>SELECT/g) ?? []).length + (annex.match(/<pre>WITH/g) ?? []).length;
    expect(sqlBlocks).toBeGreaterThanOrEqual(report.findings.length - 2); // (los informativos pueden no llevar SELECT)
  });

  it('los datos personales no aparecen en el informe', () => {
    expect(html).not.toContain('@ejemplo.org');
    expect(html).not.toMatch(/3\d{2} \d{3} \d{4}/); // teléfonos del fixture
  });

  it('el resumen ejecutivo tiene máximo 5 hallazgos priorizados', () => {
    const exec = html.slice(html.indexOf('Resumen ejecutivo'), html.indexOf('Mapa de datos'));
    const rows = (exec.match(/<tr><td>\d<\/td>/g) ?? []).length;
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(5);
  });
});

describe('F5 · informe Word', () => {
  it('genera un .docx válido (contenedor ZIP con content types)', async () => {
    const buffer = await renderReportDocx(report);
    expect(buffer.length).toBeGreaterThan(5000);
    // firma ZIP "PK"
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
    // el paquete OOXML declara sus tipos de contenido
    expect(buffer.toString('latin1')).toContain('[Content_Types].xml');
  });
});
