import type { AnalysisReport } from '@sondadata/schema';
import { escapeHtml, fmtInt, reportableRelationships } from './common.js';

/**
 * Mapa entidad-relación como SVG embebible: nodos en elipse, relaciones
 * declaradas/confirmadas en línea continua e inferidas en punteada.
 */
export function renderErSvg(report: AnalysisReport): string {
  const sources = report.sources.filter((s) => s.rowCount > 0);
  if (sources.length === 0) return '';
  const W = 900;
  const H = 480;
  const cx = W / 2;
  const cy = H / 2;
  const rx = W / 2 - 130;
  const ry = H / 2 - 60;
  const nodeW = 180;
  const nodeH = 52;

  const pos = new Map<string, { x: number; y: number }>();
  sources.forEach((s, i) => {
    const angle = (2 * Math.PI * i) / sources.length - Math.PI / 2;
    pos.set(s.id, { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  });

  const edges = reportableRelationships(report)
    .filter((r) => pos.has(r.leftSourceId) && pos.has(r.rightSourceId))
    .map((r) => {
      const a = pos.get(r.leftSourceId)!;
      const b = pos.get(r.rightSourceId)!;
      const solid = r.userDecision === 'confirmed' || r.status === 'declared';
      const color = solid ? '#3f6b4a' : r.confidence === 'high' ? '#57534b' : '#b54708';
      return `<line x1="${a.x.toFixed(0)}" y1="${a.y.toFixed(0)}" x2="${b.x.toFixed(0)}" y2="${b.y.toFixed(0)}" stroke="${color}" stroke-width="1.6"${solid ? '' : ' stroke-dasharray="6 4"'} />`;
    })
    .join('\n');

  const nodes = sources
    .map((s) => {
      const p = pos.get(s.id)!;
      const critical = report.findings.some((f) => f.severity === 'critical' && f.sourceIds[0] === s.id);
      const x = p.x - nodeW / 2;
      const y = p.y - nodeH / 2;
      return `<g>
  <rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${nodeW}" height="${nodeH}" rx="8" fill="#faf9f6" stroke="${critical ? '#b42318' : '#57534b'}" stroke-width="1.6" />
  <text x="${p.x.toFixed(0)}" y="${(p.y - 6).toFixed(0)}" text-anchor="middle" font-size="13" font-weight="600" fill="#1c1a17">${escapeHtml(s.businessName.slice(0, 24))}</text>
  <text x="${p.x.toFixed(0)}" y="${(p.y + 12).toFixed(0)}" text-anchor="middle" font-size="11" fill="#8a857c">${fmtInt(s.rowCount)} filas</text>
</g>`;
    })
    .join('\n');

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mapa de fuentes y relaciones">
<rect width="${W}" height="${H}" fill="#ffffff" />
${edges}
${nodes}
</svg>`;
}
