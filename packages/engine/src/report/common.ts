import type { AnalysisReport, Finding, Relationship } from '@sondadata/schema';

/** Utilidades compartidas por los generadores de informe (HTML y docx). */

export const fmtInt = (n: number): string => n.toLocaleString('es-CO');
export const fmtPct = (n: number): string => `${Math.round(n * 100)}%`;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LEVEL: Record<string, number> = { high: 3, medium: 2, low: 1 };
const SEV: Record<string, number> = { critical: 3, warning: 2, info: 1 };

export const SEV_ES: Record<string, string> = { critical: 'Crítico', warning: 'Atención', info: 'Informativo' };
export const LEVEL_ES: Record<string, string> = { high: 'Alto', medium: 'Medio', low: 'Bajo' };
export const CONF_ES: Record<string, string> = { high: 'alta', medium: 'media', low: 'baja' };
export const CLASS_ES: Record<string, string> = {
  declared: 'Declarada en los datos',
  solid: 'Verificada',
  broken_integrity: 'Con registros sin correspondencia',
  partial: 'Parcial, por confirmar',
  domain_coincidence: 'Coincidencia de dominio',
};

/** Prioriza hallazgos por severidad y por impacto ÷ esfuerzo (spec §3.8). */
export function prioritizeFindings(report: AnalysisReport): Finding[] {
  const score = (f: Finding): number => {
    const sev = SEV[f.severity] ?? 1;
    const impact = LEVEL[f.remediation?.impact ?? 'low'] ?? 1;
    const effort = LEVEL[f.remediation?.effort ?? 'medium'] ?? 2;
    return sev * 10 + impact / effort;
  };
  return [...report.findings].sort((a, b) => score(b) - score(a));
}

/** Relaciones que vale la pena mostrar en el cuerpo del informe. */
export function reportableRelationships(report: AnalysisReport): Relationship[] {
  return report.relationships
    .filter((r) => r.userDecision !== 'rejected' && r.confidence !== 'low' && r.classification !== 'domain_coincidence')
    .sort((a, b) => b.score - a.score);
}

export function sourceName(report: AnalysisReport, id: string): string {
  return report.sources.find((s) => s.id === id)?.businessName ?? id;
}

export function reportDate(report: AnalysisReport): string {
  return new Date(report.meta.createdAt).toLocaleDateString('es-CO', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}
