/**
 * Normalización de valores para el cruce difuso (§3.4). Es la parte que más
 * rendimiento aporta: «Bogotá D.C.», «BOGOTA DC» y «bogota d.c» deben unirse,
 * y «P-0001» debe poder encontrarse con el entero «1».
 *
 * Cada cadena se expresa como SQL de DuckDB para que el cálculo sea
 * determinista y trazable en la evidencia.
 */

export type NormalizationChain = 'exact' | 'basic' | 'digits';

/** Descripción en lenguaje llano de cada normalización (para la UI). */
export const CHAIN_LABELS: Record<NormalizationChain, string> = {
  exact: 'comparación exacta',
  basic: 'sin mayúsculas, acentos, puntuación ni espacios repetidos',
  digits: 'comparando solo los números (sin prefijos ni ceros a la izquierda)',
};

/** Expresión SQL que normaliza `expr` según la cadena. */
export function normalizeSql(expr: string, chain: NormalizationChain): string {
  switch (chain) {
    case 'exact':
      return `${expr}::VARCHAR`;
    case 'basic':
      return `NULLIF(trim(regexp_replace(regexp_replace(lower(strip_accents(${expr}::VARCHAR)), '[^a-z0-9]+', ' ', 'g'), ' +', ' ', 'g')), '')`;
    case 'digits':
      return `NULLIF(ltrim(regexp_replace(${expr}::VARCHAR, '[^0-9]', '', 'g'), '0'), '')`;
  }
}
