/**
 * Similitud léxica entre nombres de columna: normalización + Jaro-Winkler +
 * solape de tokens con diccionario de sinónimos ES/EN. Pura y determinista.
 */

const SYNONYMS: Record<string, string> = {
  date: 'fecha',
  day: 'dia',
  year: 'anio',
  ano: 'anio',
  month: 'mes',
  name: 'nombre',
  city: 'ciudad',
  town: 'municipio',
  state: 'departamento',
  beneficiary: 'beneficiario',
  participante: 'beneficiario',
  amount: 'valor',
  monto: 'valor',
  importe: 'valor',
  project: 'proyecto',
  activity: 'actividad',
  payment: 'pago',
  key: 'id',
  codigo: 'id',
  cod: 'id',
  code: 'id',
};

/** Normaliza un nombre: minúsculas, sin acentos, snake/camel unificados, sin prefijos de tabla. */
export function normalizeIdentifier(name: string): string[] {
  const flat = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // camelCase → snake
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  const tokens = flat.split('_').filter((t) => t.length > 0);
  // aplica sinónimos y descarta tokens vacíos de significado
  return tokens.map((t) => SYNONYMS[t] ?? t).filter((t) => !['de', 'del', 'la', 'el'].includes(t));
}

/** Jaro-Winkler clásico sobre dos cadenas ya normalizadas. */
export function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1: boolean[] = new Array(s1.length).fill(false);
  const m2: boolean[] = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(s2.length - 1, i + matchWindow);
    for (let j = lo; j <= hi; j++) {
      if (!m2[j] && s1[i] === s2[j]) {
        m1[i] = true;
        m2[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;
  // bonus Winkler por prefijo común (máx 4)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Similitud de nombres de columna combinando tokens y Jaro-Winkler. */
export function nameSimilarity(a: string, b: string): number {
  const ta = normalizeIdentifier(a);
  const tb = normalizeIdentifier(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const ja = new Set(ta);
  const jb = new Set(tb);
  const inter = [...ja].filter((t) => jb.has(t)).length;
  const tokenSim = inter / Math.max(ja.size, jb.size);
  const jw = jaroWinkler(ta.join(''), tb.join(''));
  return Math.max(tokenSim, jw);
}
