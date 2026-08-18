import type { AnalysisReport, Finding } from '@sondadata/schema';
import { PRODUCT } from '@sondadata/schema';
import {
  CLASS_ES,
  CONF_ES,
  escapeHtml,
  fmtInt,
  fmtPct,
  LEVEL_ES,
  prioritizeFindings,
  reportableRelationships,
  reportDate,
  SEV_ES,
  sourceName,
} from './common.js';
import { renderErSvg } from './er-svg.js';

/**
 * Informe HTML autocontenido e imprimible (§3.8). Español formal (usted), tono
 * de consultoría, sin jerga en el cuerpo. El anexo técnico contiene todas las
 * métricas de soporte: es lo que hace defendible el informe.
 */

const e = escapeHtml;

function sevBadge(f: Finding): string {
  const cls = f.severity === 'critical' ? 'crit' : f.severity === 'warning' ? 'warn' : 'info';
  return `<span class="sev ${cls}">${SEV_ES[f.severity]}</span>`;
}

export function renderReportHtml(report: AnalysisReport): string {
  const prioritized = prioritizeFindings(report);
  const top5 = prioritized.filter((f) => f.severity !== 'info').slice(0, 5);
  const rels = reportableRelationships(report);
  const totalRows = report.sources.reduce((s, x) => s + x.rowCount, 0);
  const criticals = report.findings.filter((f) => f.severity === 'critical').length;
  const warnings = report.findings.filter((f) => f.severity === 'warning').length;
  const personalSources = report.sources.filter((s) => s.columns.some((c) => c.isPersonalData));
  const withRemediation = prioritized.filter((f) => f.remediation !== null);

  const resumen = `Se analizaron ${report.sources.length} fuentes con ${fmtInt(totalRows)} registros. ` +
    (criticals > 0
      ? `Se identificó ${criticals === 1 ? 'un problema crítico' : `${criticals} problemas críticos`} que afecta${criticals === 1 ? '' : 'n'} directamente las cifras que hoy se reportan, además de ${warnings} asuntos que requieren atención. `
      : `No se identificaron problemas críticos; ${warnings} asuntos requieren atención. `) +
    `Cada afirmación de este informe enlaza con la consulta y la métrica que la sustentan (Anexo técnico).`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Diagnóstico de datos — ${e(report.meta.projectName)}</title>
<style>
  :root { --ink:#1c1a17; --ink2:#57534b; --muted:#8a857c; --line:#dcd8d0; --green:#3f6b4a; --amber:#b54708; --red:#b42318; --paper:#faf9f6; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color:var(--ink); line-height:1.55; font-size:11.5pt; background:#fff; }
  .page { max-width: 760px; margin: 0 auto; padding: 2.2rem 2rem; }
  h1 { font-size: 24pt; font-weight: 700; line-height:1.2; }
  h2 { font-size: 15pt; margin: 2.2rem 0 0.7rem; border-bottom: 2px solid var(--ink); padding-bottom: 0.25rem; }
  h3 { font-size: 12pt; margin: 1.3rem 0 0.4rem; }
  p { margin-bottom: 0.7rem; }
  .cover { text-align:left; padding-top: 4rem; min-height: 60vh; }
  .cover .kicker { text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink2); font-size: 9.5pt; margin-bottom: 1rem; }
  .cover .meta { color: var(--muted); margin-top: 2.5rem; font-size: 10.5pt; }
  table { width: 100%; border-collapse: collapse; margin: 0.6rem 0 1rem; font-size: 10pt; }
  th { text-align:left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink2); border-bottom: 1.5px solid var(--ink); padding: 0.35rem 0.5rem; }
  td { border-bottom: 1px solid var(--line); padding: 0.4rem 0.5rem; vertical-align: top; }
  .sev { display:inline-block; font-size:8pt; font-weight:700; padding:0.05rem 0.5rem; border-radius: 99px; font-family: Arial, sans-serif; }
  .sev.crit { background:#fdeceb; color:var(--red); }
  .sev.warn { background:#fdf3e6; color:var(--amber); }
  .sev.info { background:#f0ede7; color:var(--ink2); }
  .mono, pre { font-family: Consolas, 'Courier New', monospace; font-size: 8.5pt; }
  pre { background: #f4f2ed; border: 1px solid var(--line); border-radius: 4px; padding: 0.6rem; overflow-x: auto; white-space: pre-wrap; margin: 0.4rem 0; }
  .figure { margin: 1rem 0; }
  .figure svg { width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
  .caption { font-size: 9pt; color: var(--muted); margin-top: 0.3rem; }
  .finding { margin-bottom: 1rem; }
  .finding p { margin: 0.25rem 0 0; }
  .consequence { color: var(--ink2); font-size: 10.5pt; }
  .footer { margin-top: 3rem; padding-top: 0.8rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 9pt; display:flex; justify-content:space-between; font-family: Arial, sans-serif; }
  a { color: #1f4e79; }
  @media print {
    @page { size: A4; margin: 18mm 16mm; }
    body { font-size: 10.5pt; }
    .page { max-width: none; padding: 0; }
    .cover { min-height: 85vh; page-break-after: always; }
    h2 { page-break-after: avoid; }
    section { page-break-inside: auto; }
    .finding, tr, .figure { page-break-inside: avoid; }
    pre { white-space: pre-wrap; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
<div class="page">

<div class="cover">
  <div class="kicker">Diagnóstico de datos</div>
  <h1>${e(report.meta.projectName)}</h1>
  <p style="margin-top:0.8rem; color:var(--ink2); font-size:12pt;">Estado real de la información, problemas que afectan sus cifras y cruces que puede aprovechar.</p>
  <div class="meta">
    <p>Generado el ${reportDate(report)} · ${report.sources.length} fuentes · ${fmtInt(totalRows)} registros</p>
    <p>${e(PRODUCT.name)} · motor ${e(report.meta.engineVersion)} · toda cifra de este documento es verificable en el anexo técnico</p>
  </div>
</div>

<section>
<h2>1. Resumen ejecutivo</h2>
<p>${e(resumen)}</p>
${personalSources.length > 0 ? `<p>Las fuentes ${personalSources.map((s) => `«${e(s.businessName)}»`).join(', ')} contienen datos personales; en este informe y en la herramienta aparecen enmascarados.</p>` : ''}
${
  top5.length > 0
    ? `<table>
<thead><tr><th style="width:28px">Nº</th><th>Hallazgo</th><th style="width:70px">Impacto</th><th style="width:70px">Esfuerzo</th></tr></thead>
<tbody>
${top5
  .map(
    (f, i) => `<tr><td>${i + 1}</td><td>${sevBadge(f)} ${e(f.title)}</td><td>${LEVEL_ES[f.remediation?.impact ?? 'medium']}</td><td>${LEVEL_ES[f.remediation?.effort ?? 'medium']}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`
    : '<p>No se identificaron problemas de relevancia ejecutiva.</p>'
}
</section>

<section>
<h2>2. Mapa de datos</h2>
<div class="figure">
${renderErSvg(report)}
<p class="caption">Figura 1. Fuentes analizadas y sus relaciones. Línea continua: relación declarada o confirmada. Línea punteada: relación deducida por el sistema a partir de la coincidencia de valores, pendiente de confirmación.</p>
</div>
${
  rels.length > 0
    ? `<table>
<thead><tr><th>Desde</th><th>Hacia</th><th>Por</th><th>Estado</th><th>Confianza</th></tr></thead>
<tbody>
${rels
  .map(
    (r) =>
      `<tr><td>${e(sourceName(report, r.leftSourceId))}</td><td>${e(sourceName(report, r.rightSourceId))}</td><td class="mono">${e(r.leftColumns.join('+'))} → ${e(r.rightColumns.join('+'))}</td><td>${CLASS_ES[r.classification] ?? r.classification}${r.normalizations.length > 0 ? ' (unificando escritura)' : ''}</td><td>${CONF_ES[r.confidence]}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`
    : ''
}
</section>

<section>
<h2>3. Inventario de fuentes</h2>
<table>
<thead><tr><th>Fuente</th><th>Procedencia</th><th>Filas</th><th>Columnas</th><th>Observación</th></tr></thead>
<tbody>
${report.sources
  .map((s) => {
    const origin =
      s.origin.kind === 'file'
        ? `${e(s.origin.fileName)}${s.origin.sheet ? ` · hoja «${e(s.origin.sheet)}»` : ''}`
        : 'conexión de base de datos';
    const interp =
      s.origin.kind === 'file' && s.origin.interpretation
        ? `Encabezado leído en la fila ${s.origin.interpretation.headerRow}; ${s.origin.interpretation.discardedRows.length} filas de título o totales excluidas.`
        : '';
    const warn = s.ingestWarnings.length > 0 && !interp ? e(s.ingestWarnings[0]!) : interp;
    return `<tr><td>${e(s.businessName)}</td><td class="mono">${origin}<br>huella ${s.origin.kind === 'file' ? e(s.origin.contentHash) : ''}</td><td>${fmtInt(s.rowCount)}</td><td>${s.columns.length}</td><td>${warn || '—'}</td></tr>`;
  })
  .join('\n')}
</tbody></table>
<p class="caption">La «huella» identifica el contenido exacto de cada archivo analizado: si el archivo cambia, la huella cambia.</p>
</section>

<section>
<h2>4. Diagnóstico</h2>
${
  prioritized.length === 0
    ? '<p>No se identificaron problemas de calidad.</p>'
    : prioritized
        .map(
          (f, i) => `<div class="finding">
<h3>4.${i + 1} ${sevBadge(f)} ${e(f.title)}</h3>
<p class="consequence">${e(f.consequence)}</p>
${f.remediation ? `<p class="consequence"><strong>Acción sugerida:</strong> ${e(f.remediation.suggestion)}</p>` : ''}
<p class="caption">Evidencia: anexo A.${i + 1}${f.affectedRows !== null ? ` · ${fmtInt(f.affectedRows)} registros afectados` : ''}</p>
</div>`,
        )
        .join('\n')
}
</section>

<section>
<h2>5. Oportunidades de cruce</h2>
${
  report.joinPredictions.length === 0
    ? '<p>No se identificaron cruces viables entre las fuentes.</p>'
    : report.joinPredictions
        .filter((p) => !p.fanOut.risk)
        .slice(0, 5)
        .map((p) => {
          const l = sourceName(report, p.leftSourceId);
          const r = sourceName(report, p.rightSourceId);
          return `<h3>${e(l)} con ${e(r)}</h3>
<p>Uniendo por «${e(p.keys[0]!.left)}» se obtienen ${fmtInt(p.expectedRows.inner.value)} registros combinados (coincide el ${fmtPct(p.matchRate.leftInRight)} de ${e(l)}${p.unmatchedLeft > 0 ? `; ${fmtInt(p.unmatchedLeft)} registros quedarían fuera` : ''}).</p>
${
  p.indicators.length > 0
    ? `<p>Indicadores que este cruce habilita:</p><ul style="margin:0 0 0.8rem 1.4rem;">${p.indicators
        .slice(0, 4)
        .map((ind) => `<li>${e(ind.title)} <span class="caption">(cobertura ${fmtPct(ind.coverage)}; consulta lista en el anexo B)</span></li>`)
        .join('')}</ul>`
    : ''
}`;
        })
        .join('\n')
}
${report.joinPredictions
  .filter((p) => p.fanOut.risk)
  .map(
    (p) => `<h3>Advertencia: ${e(sourceName(report, p.leftSourceId))} con ${e(sourceName(report, p.rightSourceId))}</h3>
<p class="consequence">${e(p.fanOut.plainWarning ?? '')} Cualquier suma sobre ese resultado estaría equivocada.</p>`,
  )
  .join('\n')}
${
  report.bridgeProposals.length > 0
    ? `<h3>Tablas auxiliares propuestas</h3><ul style="margin:0 0 0.8rem 1.4rem;">${report.bridgeProposals
        .map(
          (b) =>
            `<li>${e(b.title)}: ${e(b.description)} ${b.resultMetrics ? `<span class="caption">(${fmtInt(b.resultMetrics.rows)} filas resultantes)</span>` : ''}</li>`,
        )
        .join('')}</ul>`
    : ''
}
</section>

<section>
<h2>6. Plan de remediación</h2>
${
  withRemediation.length === 0
    ? '<p>Sin acciones pendientes.</p>'
    : `<table>
<thead><tr><th style="width:28px">Nº</th><th>Acción</th><th style="width:70px">Impacto</th><th style="width:70px">Esfuerzo</th></tr></thead>
<tbody>
${withRemediation
  .map((f, i) => `<tr><td>${i + 1}</td><td>${e(f.remediation!.suggestion)}<br><span class="caption">${e(f.title)}</span></td><td>${LEVEL_ES[f.remediation!.impact]}</td><td>${LEVEL_ES[f.remediation!.effort]}</td></tr>`)
  .join('\n')}
</tbody></table>
<p class="caption">Ordenado por impacto sobre las cifras dividido por esfuerzo de corrección.</p>`
}
</section>

<section>
<h2>Anexo A. Evidencia de los hallazgos</h2>
<p class="caption">Cada consulta puede ejecutarse sobre los archivos originales con cualquier herramienta compatible con SQL (por ejemplo DuckDB). Los valores de columnas con datos personales están enmascarados.</p>
${prioritized
  .map(
    (f, i) => `<h3>A.${i + 1} ${e(f.title)}</h3>
${f.evidence
  .map(
    (ev) => `<p class="caption">${e(ev.label)}${ev.sampleSize ? ` · muestra de ${fmtInt(ev.sampleSize)} filas` : ''}</p>
<pre>${e(ev.sql)}</pre>
<pre>Resultado: ${e(JSON.stringify(ev.result).slice(0, 600))}</pre>`,
  )
  .join('\n')}`,
  )
  .join('\n')}
</section>

<section>
<h2>Anexo B. Consultas de los indicadores</h2>
${
  report.joinPredictions.flatMap((p) => p.indicators).length === 0
    ? '<p>—</p>'
    : report.joinPredictions
        .flatMap((p) => p.indicators)
        .slice(0, 12)
        .map((ind) => `<h3>${e(ind.title)}</h3><pre>${e(ind.sql)}</pre>`)
        .join('\n')
}
</section>

<section>
<h2>Anexo C. Método y trazabilidad</h2>
<p>Este diagnóstico fue producido por ${e(PRODUCT.name)} (motor ${e(report.meta.engineVersion)}, contrato de datos ${e(report.schemaVersion)}, algoritmo de relaciones ${e(rels[0]?.algorithmVersion ?? '—')}). Todos los cálculos son deterministas: el mismo conjunto de archivos produce el mismo resultado (semilla ${report.meta.seed}). ${report.meta.llmUsed ? 'Los textos explicativos fueron redactados con apoyo de un modelo de lenguaje; ninguna cifra proviene de él.' : 'Ningún texto ni cifra de este informe proviene de un modelo de lenguaje.'}</p>
<p>Las relaciones deducidas se puntúan combinando señales verificables (coincidencia de valores, unicidad del lado referenciado, parecido de los nombres, compatibilidad de tipos), con penalizaciones explícitas que se muestran en la herramienta. Ninguna relación con penalizaciones grandes o catálogos diminutos se presenta como afirmación.</p>
</section>

<div class="footer">
  <span>${e(PRODUCT.name)} · diagnóstico generado automáticamente y revisado por el usuario</span>
  <span>${e(report.meta.projectName)} · ${reportDate(report)}</span>
</div>

</div>
</body>
</html>`;
}
