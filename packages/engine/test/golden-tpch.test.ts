import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DuckSession, defaultStages, runPipeline } from '../src/index.js';

/**
 * PRUEBA DE ORO (F2, spec §6): tomar un esquema relacional conocido (TPC-H),
 * eliminar toda declaración de FK exportándolo a CSVs sueltos, y verificar que
 * el sistema reconstruye ≥90% de las relaciones originales con CERO falsos
 * positivos de confianza alta. Es la vara del producto entero.
 */

/** Las 9 FK de una sola columna del esquema TPC-H. */
const TPCH_FKS: [string, string, string, string][] = [
  ['nation', 'n_regionkey', 'region', 'r_regionkey'],
  ['customer', 'c_nationkey', 'nation', 'n_nationkey'],
  ['supplier', 's_nationkey', 'nation', 'n_nationkey'],
  ['orders', 'o_custkey', 'customer', 'c_custkey'],
  ['lineitem', 'l_orderkey', 'orders', 'o_orderkey'],
  ['lineitem', 'l_partkey', 'part', 'p_partkey'],
  ['lineitem', 'l_suppkey', 'supplier', 's_suppkey'],
  ['partsupp', 'ps_partkey', 'part', 'p_partkey'],
  ['partsupp', 'ps_suppkey', 'supplier', 's_suppkey'],
];

describe('prueba de oro — TPC-H sin FKs declaradas', () => {
  it(
    'reconstruye ≥90% de las FK con cero falsos positivos de confianza alta',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sondadata-tpch-'));
      const gen = await DuckSession.createInMemory();
      try {
        // genera TPC-H pequeño y exporta a CSV (sin restricciones: solo datos)
        await gen.run(`INSTALL tpch; LOAD tpch; CALL dbgen(sf = 0.02)`);
        const tables = ['region', 'nation', 'customer', 'supplier', 'part', 'partsupp', 'orders', 'lineitem'];
        for (const t of tables) {
          await gen.run(`COPY ${t} TO '${dir.replace(/\\/g, '/')}/${t}.csv' (HEADER, DELIMITER ',')`);
        }
      } finally {
        await gen.destroy();
      }

      const { report } = await runPipeline({
        jobId: 'golden-tpch',
        projectName: 'TPC-H',
        inputDir: dir,
        stages: defaultStages,
      });
      rmSync(dir, { recursive: true, force: true });

      const bySource = new Map(report.sources.map((s) => [s.id, s.technicalName.replace(/\.csv$/, '')]));
      const foundKeys = report.relationships.map((r) => ({
        child: bySource.get(r.leftSourceId)!,
        childCol: r.leftColumns[0]!,
        parent: bySource.get(r.rightSourceId)!,
        parentCol: r.rightColumns[0]!,
        confidence: r.confidence,
        classification: r.classification,
        score: r.score,
      }));

      const isTrueFk = (f: (typeof foundKeys)[0]) =>
        TPCH_FKS.some(
          ([c, cc, p, pc]) =>
            (f.child === c && f.childCol === cc && f.parent === p && f.parentCol === pc) ||
            // tolera orientación invertida cuando ambos lados son llaves (1:1 aparente)
            (f.child === p && f.childCol === pc && f.parent === c && f.parentCol === cc),
        );

      const recovered = TPCH_FKS.filter(([c, cc, p, pc]) =>
        foundKeys.some(
          (f) =>
            ((f.child === c && f.childCol === cc && f.parent === p && f.parentCol === pc) ||
              (f.child === p && f.childCol === pc && f.parent === c && f.parentCol === cc)) &&
            f.confidence !== 'low',
        ),
      );
      const highFalsePositives = foundKeys.filter((f) => f.confidence === 'high' && !isTrueFk(f));

      // trazas útiles cuando falle
      const missing = TPCH_FKS.filter((fk) => !recovered.includes(fk));
      if (missing.length > 0) console.log('FK no recuperadas:', missing);
      if (highFalsePositives.length > 0) console.log('Falsos positivos altos:', highFalsePositives);

      expect(recovered.length / TPCH_FKS.length).toBeGreaterThanOrEqual(0.9);
      expect(highFalsePositives).toEqual([]);
    },
    300_000,
  );
});
