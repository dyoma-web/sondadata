import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generateFixtures } from '../src/index.js';

const dirA = mkdtempSync(join(tmpdir(), 'sondadata-fx-a-'));
const dirB = mkdtempSync(join(tmpdir(), 'sondadata-fx-b-'));

afterAll(() => {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe('generateFixtures', () => {
  it('es determinista en los CSV: misma semilla ⇒ mismos archivos byte a byte', async () => {
    const a = await generateFixtures(dirA, { seed: 123 });
    const b = await generateFixtures(dirB, { seed: 123 });
    expect(a.files).toEqual(b.files);
    for (const f of a.files.filter((f) => f.endsWith('.csv'))) {
      expect(readFileSync(join(dirA, f), 'utf8')).toEqual(readFileSync(join(dirB, f), 'utf8'));
    }
  });

  it('planta los 10 defectos documentados', async () => {
    const manifest = await generateFixtures(dirA, { seed: 20260810 });
    expect(manifest.plantedDefects).toHaveLength(10);

    // #6: exactamente 312 huérfanos (proyecto ≥ 900)
    const pagos = readFileSync(join(dirA, 'pagos.csv'), 'utf8').split('\n').slice(1);
    const orphans = pagos.filter((l) => Number(l.split(',')[1]) >= 900).length;
    expect(orphans).toBe(312);

    // #7: tres formatos de fecha en la misma columna
    const fechas = pagos.map((l) => l.split(',')[2]!);
    expect(fechas.some((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))).toBe(true);
    expect(fechas.some((f) => /^\d{2}\/\d{2}\/\d{4}$/.test(f))).toBe(true);

    // #10b: 14 filas con valor_total roto
    const broken = pagos.filter((l) => {
      const parts = l.split(',');
      return Number(parts[3]) * Number(parts[4]) !== Number(parts[5]);
    }).length;
    expect(broken).toBe(14);

    // #9: el XLSX existe
    expect(existsSync(join(dirA, 'ejecucion_2024.xlsx'))).toBe(true);

    // #1: beneficiarios tiene más filas que personas distintas
    const benef = readFileSync(join(dirA, 'beneficiarios.csv'), 'utf8').split('\n').slice(1);
    const docs = new Set(benef.map((l) => l.split(',')[0]));
    expect(benef.length).toBeGreaterThan(docs.size);

    // writeManifest:false no escribe expected.json
    const dirC = mkdtempSync(join(tmpdir(), 'sondadata-fx-c-'));
    try {
      await generateFixtures(dirC, { seed: 1, writeManifest: false });
      expect(existsSync(join(dirC, 'expected.json'))).toBe(false);
    } finally {
      rmSync(dirC, { recursive: true, force: true });
    }
  });
});
