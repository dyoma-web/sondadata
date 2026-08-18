import type { Confidence, SemanticType } from '@sondadata/schema';

/**
 * Inferencia del tipo semántico de una columna: nombre + tipo físico +
 * validación sobre valores. Lógica pura y determinista, sin LLM.
 */

export interface SemanticInput {
  name: string;
  physicalType: string;
  topValues: { value: string; count: number }[];
  distinctCount: number;
  rowCount: number;
  avgLength: number | null;
  uniquenessRatio: number;
}

export interface SemanticResult {
  semanticType: SemanticType;
  confidence: Confidence;
  isPersonalData: boolean;
  risks: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+]?[\d\s().-]{7,17}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const ID_PATTERN_RE = /^[A-Z]{1,4}-?\d{2,}$/;
const BOOL_SET = new Set(['si', 'sí', 'no', 's', 'n', 'true', 'false', '0', '1', 'x']);

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_');
}

/** Proporción de top-values que cumplen un predicado (ponderada por frecuencia). */
function share(values: SemanticInput['topValues'], pred: (v: string) => boolean): number {
  const total = values.reduce((s, v) => s + v.count, 0);
  if (total === 0) return 0;
  return values.filter((v) => pred(v.value)).reduce((s, v) => s + v.count, 0) / total;
}

export function inferSemantic(input: SemanticInput): SemanticResult {
  const name = normalizeName(input.name);
  const physical = input.physicalType.toUpperCase();
  const risks: string[] = [];
  const values = input.topValues.filter((v) => v.value.trim() !== '');
  const isNumericPhysical = /INT|DECIMAL|DOUBLE|FLOAT|BIGINT|HUGEINT/.test(physical);
  const isDatePhysical = /DATE|TIMESTAMP/.test(physical);

  const result = (
    semanticType: SemanticType,
    confidence: Confidence,
    isPersonalData = false,
  ): SemanticResult => ({ semanticType, confidence, isPersonalData, risks });

  // ── Fechas ───────────────────────────────────────────────────────────
  if (isDatePhysical) return result(physical.includes('TIMESTAMP') ? 'datetime' : 'date', 'high');
  const isoShare = share(values, (v) => ISO_DATE_RE.test(v));
  const slashShare = share(values, (v) => SLASH_DATE_RE.test(v));
  if (isoShare + slashShare > 0.8 && values.length > 0) {
    if (isoShare > 0 && slashShare > 0) {
      risks.push('La columna mezcla varios formatos de fecha en los mismos datos.');
    }
    if (slashShare > 0) {
      let ddmm = false;
      let mmdd = false;
      let ambiguous = false;
      for (const v of values) {
        const m = SLASH_DATE_RE.exec(v.value);
        if (!m) continue;
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (a > 12) ddmm = true;
        else if (b > 12) mmdd = true;
        else ambiguous = true;
      }
      if (ddmm && mmdd) risks.push('Hay fechas que solo pueden ser día/mes y otras que solo pueden ser mes/día: el formato es inconsistente.');
      else if (ambiguous && !ddmm && !mmdd)
        risks.push('No es posible saber si las fechas son día/mes o mes/día; hay que confirmarlo con quien produjo el archivo.');
    }
    return result('date', isoShare + slashShare > 0.95 ? 'high' : 'medium');
  }

  // ── Nombre de columna con significado fuerte ─────────────────────────
  if (/(^|_)(correo|email|mail)($|_)/.test(name)) {
    const ok = share(values, (v) => EMAIL_RE.test(v));
    return result('email', ok > 0.5 ? 'high' : 'low', true);
  }
  if (/(^|_)(telefono|celular|movil|phone)($|_)/.test(name)) {
    const ok = share(values, (v) => PHONE_RE.test(v));
    return result('phone', ok > 0.5 ? 'high' : 'low', true);
  }
  if (/(^|_)(documento|cedula|dni)($|_)/.test(name)) return result('person_document', 'high', true);
  if (/(^|_)direccion($|_)/.test(name)) return result('address', 'medium', true);
  if (/nombre_completo|nombres_apellidos/.test(name)) return result('person_name', 'high', true);
  if (/(^|_)(municipio|mpio|muni|ciudad|departamento|dpto|depto|vereda|localidad)($|_)|municipio|departamento/.test(name))
    return result('geo_admin', 'high');
  if (/(^|_)(lat|latitud)($|_)/.test(name)) return result('geo_lat', 'medium', true);
  if (/(^|_)(lon|lng|longitud)($|_)/.test(name)) return result('geo_lon', 'medium', true);
  if (/(^|_)nit($|_)/.test(name)) return result('identifier', 'high');
  if (/(^|_)(presupuesto|valor|monto|precio|importe)/.test(name) && isNumericPhysical) return result('currency', 'high');
  if (/porcentaje|(^|_)pct($|_)/.test(name) && isNumericPhysical) return result('percentage', 'medium');
  if (/(^|_)(anio|ano|mes|trimestre|semestre)($|_)/.test(name)) return result('category', 'high');

  // ── Identificadores ──────────────────────────────────────────────────
  const idName = /(^id$)|(^id_)|(_id$)|(^codigo)|(^cod_)|(_key$)/.test(name);
  const idPattern = share(values, (v) => ID_PATTERN_RE.test(v));
  if (idName || (idPattern > 0.9 && input.uniquenessRatio > 0.5)) {
    return result('identifier', idName && input.uniquenessRatio > 0.9 ? 'high' : 'medium');
  }

  // ── Booleano codificado ──────────────────────────────────────────────
  if (
    input.distinctCount >= 1 &&
    input.distinctCount <= 3 &&
    values.length > 0 &&
    values.every((v) => BOOL_SET.has(v.value.trim().toLowerCase()))
  ) {
    return result('boolean_coded', 'high');
  }

  // ── Numéricos ────────────────────────────────────────────────────────
  if (isNumericPhysical) {
    if (input.distinctCount <= 12 && input.rowCount > 50) return result('category', 'medium');
    return result(/INT/.test(physical) ? 'integer' : 'number', 'high');
  }

  // ── Nombre de persona por contenido (columnas "nombre" sueltas) ──────
  // Nunca si el nombre de columna o los valores sugieren una organización.
  const ORG_NAME = /(entidad|empresa|organizacion|institucion|proveedor|proyecto|programa|producto)/;
  const ORG_VALUE = /fundaci|corporaci|asociaci|cooperativa|s\.?a\.?s|ltda|e\.?s\.?e|alcald|gobernaci|ministerio|universidad/i;
  if (/(^|_)nombre(s)?($|_)/.test(name) && !ORG_NAME.test(name)) {
    const orgLike = share(values, (v) => ORG_VALUE.test(v));
    // "Nombre Apellido Apellido" con inicial mayúscula en cada token
    const persons = share(values, (v) => /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+( [A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,3}$/.test(v));
    if (orgLike < 0.2 && persons > 0.7 && input.uniquenessRatio > 0.3) return result('person_name', 'medium', true);
  }

  // ── Categoría vs texto libre ─────────────────────────────────────────
  const ratio = input.rowCount > 0 ? input.distinctCount / input.rowCount : 0;
  if (ratio < 0.1 && input.distinctCount <= 50) return result('category', 'medium');
  if ((input.avgLength ?? 0) > 40) return result('free_text', 'medium');
  if (ratio > 0.5 && (input.avgLength ?? 0) > 15) return result('free_text', 'low');
  return result('unknown', 'low');
}

/** Enmascara un valor de una columna personal: primera letra + puntos. */
export function maskValue(v: string): string {
  const trimmed = v.trim();
  if (trimmed.length <= 1) return '•••';
  return `${trimmed[0]}•••${trimmed.length > 8 ? trimmed[trimmed.length - 1] : ''}`;
}
