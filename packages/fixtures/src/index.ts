import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

/**
 * Generador de fixtures — dataset sintético de gestión de proyectos de
 * cooperación (spec §8). Determinista: misma semilla ⇒ mismos archivos.
 *
 * Este fixture es a la vez la suite de pruebas y la demo comercial.
 * Los 10 defectos plantados están documentados en expected.json.
 */

/** PRNG determinista (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MUNICIPIOS_CANONICOS = ['Santa Rosa', 'La Esperanza', 'San Miguel'];
/** Defecto #3: el mismo municipio escrito de 5 formas distintas. */
const VARIANTES: Record<string, string[]> = {
  'Santa Rosa': ['Santa Rosa', 'Sta. Rosa', 'SANTA ROSA', 'santa rosa (Cauca)', 'Sta Rosa'],
  'La Esperanza': ['La Esperanza', 'LA ESPERANZA', 'La Esperanza (Nariño)', 'la esperanza', 'La  Esperanza'],
  'San Miguel': ['San Miguel', 'SAN MIGUEL', 'S. Miguel', 'san miguel', 'San Miguel (Putumayo)'],
};
const SECTORES = ['salud', 'educación', 'agua', 'gobernanza', 'medio ambiente'];
const NOMBRES = ['Juan', 'María', 'Carlos', 'Luisa', 'Pedro', 'Ana', 'Diego', 'Carmen', 'Andrés', 'Rosa'];
const APELLIDOS = ['García', 'Rodríguez', 'Martínez', 'López', 'Hernández', 'Pérez', 'Muñoz', 'Torres'];
const ENTIDADES = [
  { id: 'E-01', nombre: 'Fundación Horizonte Verde', nit: '900123456-1' },
  { id: 'E-02', nombre: 'Corporación Tierra Viva', nit: '900654321-7' },
  { id: 'E-03', nombre: 'Asociación Manos Unidas', nit: '811222333-4' },
];

export interface FixtureManifest {
  seed: number;
  files: string[];
  plantedDefects: { id: string; description: string; expected: unknown }[];
}

export interface GenerateOptions {
  seed?: number;
  /** Si es false, el manifest expected.json NO se escribe en la carpeta de datos (demos). */
  writeManifest?: boolean;
}

export async function generateFixtures(outDir: string, opts: GenerateOptions = {}): Promise<FixtureManifest> {
  const seed = opts.seed ?? 20260810;
  const writeManifest = opts.writeManifest ?? true;
  mkdirSync(outDir, { recursive: true });
  const rand = rng(seed);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');

  // ── proyectos.csv — llave estilo P-0001 ──────────────────────────────
  const nProyectos = 60;
  const proyectos: string[] = ['id_proyecto,nombre,municipio,fecha_inicio,presupuesto,anio'];
  for (let i = 1; i <= nProyectos; i++) {
    const muni = pick(MUNICIPIOS_CANONICOS);
    const presupuesto = Math.round(50 + rand() * 950) * 1_000_000;
    // caso negativo: columna "anio" de baja cardinalidad presente en varias tablas
    const anio = 2023 + Math.floor(rand() * 2);
    proyectos.push(
      `P-${pad(i, 4)},Proyecto ${i},"${pick(VARIANTES[muni]!)}",2024-${pad(1 + Math.floor(rand() * 9), 2)}-15,${presupuesto},${anio}`,
    );
  }
  writeFileSync(join(outDir, 'proyectos.csv'), proyectos.join('\n'), 'utf8');

  // ── entidades.csv — catálogo de ejecutoras ───────────────────────────
  const entidades: string[] = ['id_entidad,nombre_entidad,nit,municipio_sede,codigo'];
  ENTIDADES.forEach((e, idx) => {
    // caso negativo: "codigo" numérico que se solapa con otros códigos por casualidad
    entidades.push(`${e.id},"${e.nombre}",${e.nit},"${MUNICIPIOS_CANONICOS[idx % 3]}",${19000 + idx * 700}`);
  });
  writeFileSync(join(outDir, 'entidades.csv'), entidades.join('\n'), 'utf8');

  // ── actividades.csv ──────────────────────────────────────────────────
  // #4 proyecto como entero · #2 sectores lista embebida · #5 entidad copiada
  // (dependencia transitiva) · #10a observaciones_2 vacía 99%
  const nActividades = 400;
  const actividades: string[] = [
    'id_actividad,proyecto,descripcion,municipio_nombre,sectores,fecha,entidad_nombre,entidad_nit,observaciones_2',
  ];
  const fechasActividad: string[] = [];
  for (let i = 1; i <= nActividades; i++) {
    const proyecto = 1 + Math.floor(rand() * nProyectos);
    const muni = pick(MUNICIPIOS_CANONICOS);
    const nSect = 1 + Math.floor(rand() * 3);
    const sect = [...new Set(Array.from({ length: nSect }, () => pick(SECTORES)))].join(', ');
    // #8 fan-out: fechas concentradas en ~90 días para que se repitan mucho
    const fecha = `2024-0${1 + Math.floor(rand() * 3)}-${pad(1 + Math.floor(rand() * 28), 2)}`;
    fechasActividad.push(fecha);
    const ent = pick(ENTIDADES);
    const obs = rand() < 0.01 ? 'Revisar soportes' : '';
    actividades.push(
      `A-${pad(i, 4)},${proyecto},Actividad ${i},"${pick(VARIANTES[muni]!)}","${sect}",${fecha},"${ent.nombre}",${ent.nit},${obs}`,
    );
  }
  writeFileSync(join(outDir, 'actividades.csv'), actividades.join('\n'), 'utf8');

  // ── pagos.csv ────────────────────────────────────────────────────────
  // #6 exactamente 312 huérfanos · #7 fechas en 3 formatos (uno ambiguo)
  // #8 fan-out por fecha · #10b valor_total ≠ cantidad×valor_unitario en 14 filas
  const nPagos = 3000;
  const pagos: string[] = ['id_pago,proyecto,fecha_pago,cantidad,valor_unitario,valor_total,concepto'];
  const orphanRows = new Set<number>();
  while (orphanRows.size < 312) orphanRows.add(1 + Math.floor(rand() * nPagos));
  const mirrorBroken = new Set<number>();
  while (mirrorBroken.size < 14) {
    const i = 1 + Math.floor(rand() * nPagos);
    if (!orphanRows.has(i)) mirrorBroken.add(i);
  }
  for (let i = 1; i <= nPagos; i++) {
    // huérfano: apunta a un proyecto fuera de rango (no existe)
    const proyecto = orphanRows.has(i) ? 900 + Math.floor(rand() * 90) : 1 + Math.floor(rand() * nProyectos);
    const y = 2024;
    const m = 1 + Math.floor(rand() * 3);
    const d = 1 + Math.floor(rand() * 28);
    // #7: tres formatos en la misma columna; el slash con d,m ≤ 12 es ambiguo
    const fmt = rand();
    const fecha =
      fmt < 0.5
        ? `${y}-${pad(m, 2)}-${pad(d, 2)}`
        : fmt < 0.8
          ? `${pad(d, 2)}/${pad(m, 2)}/${y}`
          : `${pad(Math.min(d, 12), 2)}/${pad(m, 2)}/${y}`;
    const cantidad = 1 + Math.floor(rand() * 40);
    const valorUnitario = Math.round(10 + rand() * 490) * 1000;
    const valorTotal = mirrorBroken.has(i)
      ? cantidad * valorUnitario + Math.round(1 + rand() * 9) * 1000
      : cantidad * valorUnitario;
    pagos.push(`G-${pad(i, 5)},${proyecto},${fecha},${cantidad},${valorUnitario},${valorTotal},Concepto ${1 + Math.floor(rand() * 12)}`);
  }
  writeFileSync(join(outDir, 'pagos.csv'), pagos.join('\n'), 'utf8');

  // ── beneficiarios.csv ────────────────────────────────────────────────
  // #1 relación N:M proyectos↔beneficiarios resuelta por duplicación de filas
  // + datos personales (nombre, documento, teléfono, correo)
  const nPersonas = 800;
  const personas = Array.from({ length: nPersonas }, (_, k) => {
    const nombre = `${pick(NOMBRES)} ${pick(APELLIDOS)} ${pick(APELLIDOS)}`;
    const documento = String(10000000 + Math.floor(rand() * 89999999));
    const telefono = `3${pad(Math.floor(rand() * 100), 2)} ${pad(Math.floor(rand() * 1000), 3)} ${pad(Math.floor(rand() * 10000), 4)}`;
    const correo = `benef${k + 1}@ejemplo.org`;
    return { nombre, documento, telefono, correo };
  });
  const beneficiarios: string[] = ['documento,nombre_completo,telefono,correo,id_proyecto,municipio'];
  let filasBenef = 0;
  for (const p of personas) {
    // cada persona participa en 1–4 proyectos → misma persona repetida en varias filas
    const nProy = 1 + Math.floor(rand() * 4);
    const proys = new Set<number>();
    while (proys.size < nProy) proys.add(1 + Math.floor(rand() * nProyectos));
    for (const pr of proys) {
      const muni = pick(MUNICIPIOS_CANONICOS);
      beneficiarios.push(`${p.documento},"${p.nombre}",${p.telefono},${p.correo},P-${pad(pr, 4)},"${pick(VARIANTES[muni]!)}"`);
      filasBenef++;
    }
  }
  writeFileSync(join(outDir, 'beneficiarios.csv'), beneficiarios.join('\n'), 'utf8');

  // ── municipios.csv — catálogo limpio (lado canónico del cruce difuso) ─
  const municipios: string[] = ['codigo_dane,nombre_mpio,departamento'];
  municipios.push('19693,Santa Rosa,Cauca');
  municipios.push('52399,La Esperanza,Nariño');
  municipios.push('86569,San Miguel,Putumayo');
  writeFileSync(join(outDir, 'municipios.csv'), municipios.join('\n'), 'utf8');

  // ── ejecucion_2024.xlsx — #9 Excel humano ────────────────────────────
  // Título fusionado en filas 1–2, encabezado real en la fila 4, totales al final.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ejecución');
  ws.mergeCells('A1:E1');
  ws.getCell('A1').value = 'PROGRAMA DE INVERSIÓN SOCIAL — CONSOLIDADO DE EJECUCIÓN 2024';
  ws.getCell('A2').value = 'Corte: diciembre 2024';
  // fila 3 vacía
  ws.getRow(4).values = ['trimestre', 'municipio', 'proyectos_activos', 'valor_programado', 'valor_ejecutado'];
  let totalProg = 0;
  let totalEjec = 0;
  let xlsxRows = 0;
  for (let t = 1; t <= 4; t++) {
    for (const muni of MUNICIPIOS_CANONICOS) {
      const activos = 3 + Math.floor(rand() * 12);
      const prog = Math.round(100 + rand() * 900) * 1_000_000;
      const ejec = Math.round(prog * (0.55 + rand() * 0.45));
      totalProg += prog;
      totalEjec += ejec;
      ws.addRow([`T${t}`, pick(VARIANTES[muni]!), activos, prog, ejec]);
      xlsxRows++;
    }
  }
  ws.addRow(['TOTAL', '', '', totalProg, totalEjec]);
  await wb.xlsx.writeFile(join(outDir, 'ejecucion_2024.xlsx'));

  const manifest: FixtureManifest = {
    seed,
    files: [
      'proyectos.csv',
      'entidades.csv',
      'actividades.csv',
      'pagos.csv',
      'beneficiarios.csv',
      'municipios.csv',
      'ejecucion_2024.xlsx',
    ],
    plantedDefects: [
      {
        id: 'n_m_by_duplication',
        description: 'N:M proyectos↔beneficiarios resuelta duplicando filas de personas',
        expected: { table: 'beneficiarios', rows: filasBenef, distinctPersons: nPersonas },
      },
      {
        id: 'embedded_list',
        description: 'actividades.sectores guarda varios valores separados por coma',
        expected: { column: 'sectores', separator: ', ', distinctValues: SECTORES.length },
      },
      {
        id: 'municipio_variants',
        description: 'Cada municipio real está escrito de 5 formas distintas',
        expected: { canonicalCount: 3, variantsPerMunicipio: 5 },
      },
      {
        id: 'key_format_mismatch',
        description: 'proyectos.id_proyecto es "P-0001" pero actividades.proyecto y pagos.proyecto son enteros',
        expected: { relationship: ['actividades.proyecto', 'proyectos.id_proyecto'] },
      },
      {
        id: 'transitive_dependency',
        description: 'Nombre y NIT de la entidad ejecutora copiados en cada actividad',
        expected: { columns: ['entidad_nombre', 'entidad_nit'], entityCount: ENTIDADES.length },
      },
      {
        id: 'orphan_records',
        description: '312 pagos apuntan a un proyecto que no existe',
        expected: { table: 'pagos', orphans: 312 },
      },
      {
        id: 'mixed_date_formats',
        description: 'pagos.fecha_pago mezcla ISO, DD/MM/YYYY y un formato ambiguo',
        expected: { column: 'fecha_pago', formats: 3, ambiguous: true },
      },
      {
        id: 'fanout_by_date',
        description: 'pagos y actividades unibles por fecha → explosión combinatoria',
        expected: { keys: ['pagos.fecha_pago', 'actividades.fecha'] },
      },
      {
        id: 'human_excel',
        description: 'ejecucion_2024.xlsx: título fusionado, encabezado en fila 4, fila TOTAL al final',
        expected: { headerRow: 4, dataRows: xlsxRows, totalsRow: true },
      },
      {
        id: 'ghost_and_mirror',
        description: 'actividades.observaciones_2 vacía ~99% y pagos.valor_total no cuadra en 14 filas',
        expected: { ghostColumn: 'observaciones_2', mirrorBrokenRows: 14 },
      },
    ],
  };
  if (writeManifest) {
    writeFileSync(join(outDir, 'expected.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }
  return manifest;
}
