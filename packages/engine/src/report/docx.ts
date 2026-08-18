import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { AnalysisReport, Finding } from '@sondadata/schema';
import { PRODUCT } from '@sondadata/schema';
import {
  CLASS_ES,
  CONF_ES,
  fmtInt,
  fmtPct,
  LEVEL_ES,
  prioritizeFindings,
  reportableRelationships,
  reportDate,
  SEV_ES,
  sourceName,
} from './common.js';

/** Informe .docx para Word: mismo contenido que el HTML, sin el diagrama SVG. */

function h1(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 160 } });
}
function h2(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } });
}
function p(text: string, opts: { italics?: boolean; bold?: boolean } = {}): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, italics: opts.italics, bold: opts.bold })], spacing: { after: 120 } });
}
function mono(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, font: 'Consolas', size: 16 })],
    spacing: { after: 80 },
  });
}
function cell(text: string, bold = false): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold, size: 19 })] })],
  });
}
function table(header: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: header.map((t) => cell(t, true)), tableHeader: true }),
      ...rows.map((r) => new TableRow({ children: r.map((t) => cell(t)) })),
    ],
  });
}

export async function renderReportDocx(report: AnalysisReport): Promise<Buffer> {
  const prioritized = prioritizeFindings(report);
  const top5 = prioritized.filter((f) => f.severity !== 'info').slice(0, 5);
  const rels = reportableRelationships(report);
  const totalRows = report.sources.reduce((s, x) => s + x.rowCount, 0);
  const withRemediation = prioritized.filter((f: Finding) => f.remediation !== null);

  const children: (Paragraph | Table)[] = [
    new Paragraph({
      children: [new TextRun({ text: 'DIAGNÓSTICO DE DATOS', bold: true, size: 20, color: '57534B' })],
      spacing: { after: 200 },
    }),
    new Paragraph({
      children: [new TextRun({ text: report.meta.projectName, bold: true, size: 52 })],
      spacing: { after: 200 },
    }),
    p(
      `Generado el ${reportDate(report)} · ${report.sources.length} fuentes · ${fmtInt(totalRows)} registros · ${PRODUCT.name} (motor ${report.meta.engineVersion})`,
      { italics: true },
    ),

    h1('1. Resumen ejecutivo'),
    p(
      `Se analizaron ${report.sources.length} fuentes con ${fmtInt(totalRows)} registros. Cada afirmación de este informe está respaldada por una consulta verificable (Anexo A).`,
    ),
    ...(top5.length > 0
      ? [
          table(
            ['Nº', 'Hallazgo', 'Nivel', 'Impacto', 'Esfuerzo'],
            top5.map((f, i) => [
              String(i + 1),
              f.title,
              SEV_ES[f.severity]!,
              LEVEL_ES[f.remediation?.impact ?? 'medium']!,
              LEVEL_ES[f.remediation?.effort ?? 'medium']!,
            ]),
          ),
        ]
      : []),

    h1('2. Mapa de datos'),
    p('El diagrama interactivo de fuentes y relaciones está disponible en la herramienta y en la versión HTML de este informe. Resumen de relaciones:'),
    ...(rels.length > 0
      ? [
          table(
            ['Desde', 'Hacia', 'Por', 'Estado', 'Confianza'],
            rels.map((r) => [
              sourceName(report, r.leftSourceId),
              sourceName(report, r.rightSourceId),
              `${r.leftColumns.join('+')} → ${r.rightColumns.join('+')}`,
              `${CLASS_ES[r.classification] ?? r.classification}${r.normalizations.length > 0 ? ' (unificando escritura)' : ''}`,
              CONF_ES[r.confidence]!,
            ]),
          ),
        ]
      : [p('No se detectaron relaciones entre las fuentes.')]),

    h1('3. Inventario de fuentes'),
    table(
      ['Fuente', 'Procedencia', 'Filas', 'Columnas'],
      report.sources.map((s) => [
        s.businessName,
        s.origin.kind === 'file' ? `${s.origin.fileName}${s.origin.sheet ? ` · ${s.origin.sheet}` : ''}` : 'base de datos',
        fmtInt(s.rowCount),
        String(s.columns.length),
      ]),
    ),

    h1('4. Diagnóstico'),
    ...prioritized.flatMap((f, i) => [
      h2(`4.${i + 1} [${SEV_ES[f.severity]}] ${f.title}`),
      p(f.consequence),
      ...(f.remediation ? [p(`Acción sugerida: ${f.remediation.suggestion}`, { italics: true })] : []),
    ]),

    h1('5. Plan de remediación'),
    ...(withRemediation.length > 0
      ? [
          table(
            ['Nº', 'Acción', 'Impacto', 'Esfuerzo'],
            withRemediation.map((f, i) => [String(i + 1), f.remediation!.suggestion, LEVEL_ES[f.remediation!.impact]!, LEVEL_ES[f.remediation!.effort]!]),
          ),
        ]
      : [p('Sin acciones pendientes.')]),

    h1('Anexo A. Evidencia de los hallazgos'),
    p('Cada consulta puede ejecutarse sobre los archivos originales con cualquier herramienta compatible con SQL.', { italics: true }),
    ...prioritized.flatMap((f, i) => [
      h2(`A.${i + 1} ${f.title}`),
      ...f.evidence.flatMap((ev) => [p(ev.label, { italics: true }), mono(ev.sql), mono(`Resultado: ${JSON.stringify(ev.result).slice(0, 400)}`)]),
    ]),

    h1('Anexo B. Método y trazabilidad'),
    p(
      `Diagnóstico producido por ${PRODUCT.name} (motor ${report.meta.engineVersion}, contrato ${report.schemaVersion}). Cálculos deterministas: el mismo conjunto de archivos produce el mismo resultado (semilla ${report.meta.seed}). ${report.meta.llmUsed ? 'Los textos explicativos usaron apoyo de un modelo de lenguaje; ninguna cifra proviene de él.' : 'Ninguna cifra ni texto de este informe proviene de un modelo de lenguaje.'}`,
    ),
  ];

  const doc = new Document({
    creator: PRODUCT.name,
    title: `Diagnóstico de datos — ${report.meta.projectName}`,
    styles: {
      default: {
        document: { run: { font: 'Georgia', size: 21 } },
        heading1: { run: { font: 'Georgia', size: 30, bold: true, color: '1C1A17' } },
        heading2: { run: { font: 'Georgia', size: 24, bold: true, color: '1C1A17' } },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
