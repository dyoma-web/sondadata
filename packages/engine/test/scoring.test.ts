import { describe, expect, it } from 'vitest';
import { classifyInclusion, scoreRelationship } from '../src/scoring.js';
import { jaroWinkler, nameSimilarity, normalizeIdentifier } from '../src/similarity.js';

const baseSignals = {
  typeCompatibility: 1,
  lexicalSimilarity: 1,
  semanticSimilarity: null,
  valueInclusionLeftInRight: 1,
  valueInclusionRightInLeft: 1,
  parentUniqueness: 1,
  cardinalityConsistency: 1,
};

describe('similitud léxica', () => {
  it('normaliza acentos, camelCase y sinónimos', () => {
    expect(normalizeIdentifier('FechaInicio')).toEqual(['fecha', 'inicio']);
    expect(normalizeIdentifier('start_date')).toEqual(['start', 'fecha']);
    expect(normalizeIdentifier('Año')).toEqual(['anio']);
  });
  it('jaroWinkler da 1 a idénticos y >0.8 a cercanos', () => {
    expect(jaroWinkler('proyecto', 'proyecto')).toBe(1);
    expect(jaroWinkler('proyecto', 'proyectos')).toBeGreaterThan(0.8);
  });
  it('nameSimilarity une columnas equivalentes y separa las ajenas', () => {
    expect(nameSimilarity('id_proyecto', 'proyecto_id')).toBe(1);
    expect(nameSimilarity('fecha', 'date')).toBe(1);
    expect(nameSimilarity('linenumber', 'nationkey')).toBeLessThan(0.75);
  });
});

describe('scoring de relaciones', () => {
  it('FK perfecta con nombres iguales → confianza alta', () => {
    const r = scoreRelationship({
      signals: baseSignals,
      inclusion: 1,
      childNullRatio: 0,
      parentDistinct: 1000,
      parentIsKey: true,
      parentCoverage: 0.8,
      patternMismatch: false,
      denseIntegerNameMismatch: false,
    });
    expect(r.confidence).toBe('high');
    expect(r.penalties).toEqual([]);
  });

  it('inclusión perfecta con nombres ajenos y cobertura ínfima NO llega a alta', () => {
    // el caso "cantidad ⊆ llave de cliente": coincidencia numérica casual
    const r = scoreRelationship({
      signals: { ...baseSignals, lexicalSimilarity: 0.3 },
      inclusion: 1,
      childNullRatio: 0,
      parentDistinct: 1500,
      parentIsKey: true,
      parentCoverage: 0.03,
      patternMismatch: false,
      denseIntegerNameMismatch: false,
    });
    expect(r.confidence).not.toBe('high');
    expect(r.penalties.some((p) => p.reason === 'low_parent_coverage')).toBe(true);
  });

  it('dominio pequeño no-llave → coincidencia de dominio, nunca alta', () => {
    const r = scoreRelationship({
      signals: { ...baseSignals, parentUniqueness: 0.4 },
      inclusion: 1,
      childNullRatio: 0,
      parentDistinct: 3, // p.ej. columna "anio"
      parentIsKey: false,
      parentCoverage: 1,
      patternMismatch: false,
      denseIntegerNameMismatch: false,
    });
    expect(r.domainCoincidence).toBe(true);
    expect(r.confidence).not.toBe('high');
  });

  it('clasificación por inclusión sigue los umbrales de la spec', () => {
    expect(classifyInclusion(1, false)).toBe('solid');
    expect(classifyInclusion(0.98, false)).toBe('solid');
    expect(classifyInclusion(0.85, false)).toBe('broken_integrity');
    expect(classifyInclusion(0.5, false)).toBe('partial');
    expect(classifyInclusion(0.2, false)).toBeNull();
    expect(classifyInclusion(0.9, true)).toBe('domain_coincidence');
  });
});
