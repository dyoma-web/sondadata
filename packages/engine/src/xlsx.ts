import ExcelJS from 'exceljs';

/**
 * Lectura de XLSX con detección de "Excel humano": encabezados que no están en
 * la fila 1, filas de título (a menudo con celdas fusionadas), filas de total
 * al final y filas vacías. El resultado es una tabla limpia más la
 * interpretación aplicada, que el usuario puede revisar y corregir en la UI.
 */

export interface SheetInterpretation {
  sheetName: string;
  headerRow: number;
  headers: string[];
  /** Filas 1-based del archivo original que se descartaron (títulos, vacías, totales). */
  discardedRows: number[];
  dataRows: string[][];
  warnings: string[];
}

type CellValue = string | number | boolean | Date | null;

function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    // fórmulas, richText, hipervínculos…
    if ('result' in v && v.result !== undefined && v.result !== null) return String(v.result);
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('hyperlink' in v) return String((v as { text?: string }).text ?? '');
    return '';
  }
  return String(v);
}

function rowValues(ws: ExcelJS.Worksheet, rowNumber: number): string[] {
  const row = ws.getRow(rowNumber);
  const out: string[] = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    out.push(cellToString(row.getCell(c).value).trim());
  }
  return out;
}

function nonEmptyCount(values: string[]): number {
  return values.filter((v) => v !== '').length;
}

/**
 * Heurística de encabezado: primera fila (dentro de las 15 primeras) cuyo número
 * de celdas no vacías es al menos 3 y como mínimo el 60% del máximo observado,
 * con todas sus celdas no vacías de tipo texto y seguida de al menos una fila
 * con datos. Las filas de título suelen tener 1–2 celdas (o fusionadas).
 */
export function interpretWorksheet(ws: ExcelJS.Worksheet): SheetInterpretation | null {
  const maxScan = Math.min(ws.rowCount, 15);
  const counts: number[] = [];
  for (let r = 1; r <= maxScan; r++) counts.push(nonEmptyCount(rowValues(ws, r)));
  const maxCount = Math.max(0, ...counts);
  if (maxCount < 2) return null; // hoja sin tabla

  let headerRow = 1;
  for (let r = 1; r <= maxScan; r++) {
    const values = rowValues(ws, r);
    const filled = values.filter((v) => v !== '');
    const looksLikeHeader =
      filled.length >= Math.max(2, Math.ceil(maxCount * 0.6)) &&
      filled.every((v) => isNaN(Number(v))) &&
      r < ws.rowCount &&
      nonEmptyCount(rowValues(ws, r + 1)) >= Math.ceil(filled.length * 0.5);
    if (looksLikeHeader) {
      headerRow = r;
      break;
    }
  }

  const headersRaw = rowValues(ws, headerRow);
  // ancho de la tabla = última columna con encabezado no vacío
  const width = headersRaw.reduce((w, v, i) => (v !== '' ? i + 1 : w), 0);
  const headers = headersRaw.slice(0, width).map((h, i) => (h === '' ? `columna_${i + 1}` : h));

  const discardedRows: number[] = [];
  const warnings: string[] = [];
  for (let r = 1; r < headerRow; r++) discardedRows.push(r);
  if (headerRow > 1) {
    warnings.push(`El encabezado no está en la fila 1: se encontró en la fila ${headerRow}.`);
  }

  const dataRows: string[][] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const values = rowValues(ws, r).slice(0, width);
    const filled = nonEmptyCount(values);
    if (filled === 0) {
      discardedRows.push(r);
      continue;
    }
    // fila de totales: primera celda "TOTAL"/"TOTALES" o fila final con huecos y solo números
    const first = (values[0] ?? '').toLowerCase();
    if (/^total(es)?\b/.test(first)) {
      discardedRows.push(r);
      warnings.push(`La fila ${r} parece una fila de totales y se excluyó de los datos.`);
      continue;
    }
    dataRows.push(values);
  }

  const merged = Object.keys((ws as unknown as { _merges?: Record<string, unknown> })._merges ?? {}).length;
  if (merged > 0) warnings.push(`La hoja tiene ${merged} celdas combinadas; se leyó su valor principal.`);

  return { sheetName: ws.name, headerRow, headers, discardedRows, dataRows, warnings };
}

export async function readWorkbook(path: string): Promise<SheetInterpretation[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const out: SheetInterpretation[] = [];
  for (const ws of wb.worksheets) {
    const interp = interpretWorksheet(ws);
    if (interp && interp.dataRows.length > 0) out.push(interp);
  }
  return out;
}

/** Serializa una interpretación a CSV (staging) para cargarla en DuckDB. */
export function toCsv(interp: SheetInterpretation): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [interp.headers.map(esc).join(',')];
  for (const row of interp.dataRows) lines.push(row.map(esc).join(','));
  return lines.join('\n');
}
