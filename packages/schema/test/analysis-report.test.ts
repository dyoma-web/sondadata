import { describe, expect, it } from 'vitest';
import { AnalysisReport, emptyReport, Finding, PRODUCT, Relationship } from '../src/index.js';

describe('AnalysisReport', () => {
  it('produce un artefacto vacío válido', () => {
    const report = emptyReport({
      jobId: 'job-test',
      projectName: 'Demo',
      engineVersion: PRODUCT.engineVersion,
      schemaVersion: PRODUCT.schemaVersion,
      seed: 42,
    });
    expect(() => AnalysisReport.parse(report)).not.toThrow();
    expect(report.sources).toEqual([]);
    expect(report.meta.llmUsed).toBe(false);
  });

  it('rechaza un hallazgo sin evidencia', () => {
    const bad = {
      id: 'f1',
      severity: 'critical',
      category: 'orphan_records',
      title: '312 pagos apuntan a un contrato que no existe',
      consequence: 'Las cifras de ejecución reportadas están infladas.',
      sourceIds: ['pagos'],
      evidence: [], // ← prohibido: sin evidencia no hay hallazgo
    };
    expect(() => Finding.parse(bad)).toThrow();
  });

  it('rechaza una relación sin desglose de señales', () => {
    const bad = {
      id: 'r1',
      leftSourceId: 'a',
      leftColumns: ['x'],
      rightSourceId: 'b',
      rightColumns: ['y'],
      status: 'inferred',
      classification: 'solid',
      cardinality: '1:N',
      score: 0.9, // score sin señales desglosadas → inválido
      confidence: 'high',
      penalties: [],
      normalizations: [],
      limitations: [],
      explanation: 'x',
      evidence: [{ label: 'inclusión', sql: 'SELECT 1', result: 1 }],
      algorithmVersion: '0.1.0',
    };
    expect(() => Relationship.parse(bad)).toThrow();
  });

  it('acepta una relación completa con señales y penalizaciones', () => {
    const ok = Relationship.parse({
      id: 'r2',
      leftSourceId: 'actividades',
      leftColumns: ['municipio_nombre'],
      rightSourceId: 'municipios',
      rightColumns: ['nombre_mpio'],
      status: 'inferred',
      classification: 'partial',
      cardinality: 'N:1',
      score: 0.64,
      confidence: 'medium',
      signals: {
        typeCompatibility: 1,
        lexicalSimilarity: 0.8,
        semanticSimilarity: null,
        valueInclusionLeftInRight: 0.71,
        valueInclusionRightInLeft: 0.55,
        parentUniqueness: 0.86,
        cardinalityConsistency: 0.7,
      },
      penalties: [
        {
          reason: 'inconsistent_formats',
          plainText: 'Los nombres se escriben de formas distintas en cada archivo.',
          delta: -0.12,
        },
      ],
      normalizations: ['trim', 'casefold', 'unaccent'],
      sampleSize: 10000,
      limitations: ['Calculado sobre una muestra de 10.000 filas.'],
      explanation: 'Nadie declaró esta relación: la deducimos comparando los valores.',
      evidence: [{ label: 'coincidencia', sql: 'SELECT …', result: { ratio: 0.71 } }],
      algorithmVersion: '0.1.0',
    });
    expect(ok.userDecision).toBe('pending');
    expect(ok.viaPath).toEqual([]);
  });
});
