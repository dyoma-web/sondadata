'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalysisJob, AnalysisReport } from '@sondadata/schema';

const WORKER = process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://localhost:8787';

/** Etiquetas en lenguaje llano para los tipos semánticos. */
const TYPE_LABELS: Record<string, string> = {
  identifier: 'Identificador',
  date: 'Fecha',
  datetime: 'Fecha y hora',
  currency: 'Valor en dinero',
  percentage: 'Porcentaje',
  geo_admin: 'Municipio / territorio',
  geo_lat: 'Latitud',
  geo_lon: 'Longitud',
  geo_country: 'País',
  geo_city: 'Ciudad',
  email: 'Correo electrónico',
  phone: 'Teléfono',
  person_document: 'Documento de identidad',
  person_name: 'Nombre de persona',
  address: 'Dirección',
  category: 'Categoría',
  free_text: 'Texto libre',
  boolean_coded: 'Sí / No',
  number: 'Número',
  integer: 'Número entero',
  unknown: 'Sin determinar',
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtInt(n: number): string {
  return n.toLocaleString('es-CO');
}

type Phase = 'idle' | 'submitting' | 'analyzing' | 'done' | 'failed';

export default function ConectarPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDbForm, setShowDbForm] = useState(false);
  const [db, setDb] = useState({
    engine: 'postgresql' as 'postgresql' | 'mysql',
    host: 'localhost',
    port: 5432,
    database: '',
    user: '',
    password: '',
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...Array.from(list).filter((f) => !names.has(f.name))];
    });
  }, []);

  // Polling del job mientras corre el análisis
  useEffect(() => {
    if (phase !== 'analyzing' || !job) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`${WORKER}/jobs/${job.id}`);
        if (!res.ok) return;
        const j: AnalysisJob = await res.json();
        setJob(j);
        if (j.status === 'done') {
          const r = await fetch(`${WORKER}/jobs/${job.id}/report`);
          setReport(await r.json());
          localStorage.setItem('sondadata:lastJob', job.id);
          setPhase('done');
        } else if (j.status === 'failed') {
          setError(j.error ?? 'El análisis falló.');
          setPhase('failed');
        }
      } catch {
        /* siguiente tick */
      }
    }, 1200);
    return () => clearInterval(t);
  }, [phase, job?.id]);

  async function startUploadJob() {
    setPhase('submitting');
    setError(null);
    try {
      const form = new FormData();
      form.set('projectName', 'Mi proyecto');
      for (const f of files) form.append('files', f, f.name);
      const res = await fetch(`${WORKER}/jobs`, { method: 'POST', body: form });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Error ${res.status}`);
      setJob(await res.json());
      setPhase('analyzing');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }

  async function startDbJob() {
    setPhase('submitting');
    setError(null);
    try {
      const res = await fetch(`${WORKER}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectName: `Base ${db.database}`,
          connection: { ...db, schemaName: null, sampleRows: 200000 },
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Error ${res.status}`);
      setJob(await res.json());
      setPhase('analyzing');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }

  async function startDemoJob() {
    setPhase('submitting');
    setError(null);
    try {
      const res = await fetch(`${WORKER}/jobs/demo`, { method: 'POST' });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      setJob(await res.json());
      setPhase('analyzing');
    } catch (e) {
      setError(
        e instanceof Error && e.message.includes('fetch')
          ? 'No se pudo contactar el servicio de análisis. ¿Está corriendo el worker? (pnpm worker)'
          : String(e),
      );
      setPhase('idle');
    }
  }

  function reset() {
    setFiles([]);
    setJob(null);
    setReport(null);
    setError(null);
    setPhase('idle');
  }

  // ─── Vista: análisis en curso ────────────────────────────────────────
  if (phase === 'analyzing' || phase === 'submitting') {
    return (
      <main className="wrap">
        <h1>
          <span className="spinner" />
          Estamos leyendo tus datos
        </h1>
        <p className="sub">Puedes quedarte mirando o irte: el resultado queda guardado al terminar.</p>
        <ul className="progress-list">
          {(job?.events ?? []).map((e, i) => (
            <li key={i}>
              <span className="when">{new Date(e.at).toLocaleTimeString('es-CO')}</span>
              {e.message}
            </li>
          ))}
          {phase === 'submitting' && <li>Enviando archivos…</li>}
        </ul>
      </main>
    );
  }

  // ─── Vista: resultados ───────────────────────────────────────────────
  if (phase === 'done' && report) {
    const totalRows = report.sources.reduce((s, x) => s + x.rowCount, 0);
    const personalCols = report.sources.flatMap((s) => s.columns.filter((c) => c.isPersonalData));
    return (
      <main className="wrap">
        <h1>Ya entendimos tus datos</h1>
        <p className="sub">
          {report.sources.length} fuentes · {fmtInt(totalRows)} filas · {report.relationships.length} relaciones
          detectadas.
          {personalCols.length > 0 &&
            ` Detectamos datos personales en ${personalCols.length} columnas: se muestran ocultos y nunca salen en el informe.`}
        </p>
        <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
          <a href={`/mapa?job=${job?.id}`}>
            <button className="primary">Ver el mapa de tus datos →</button>
          </a>
          <a href={`${WORKER}/jobs/${job?.id}/report.html`} target="_blank" rel="noreferrer">
            <button>Ver el informe</button>
          </a>
          <a href={`${WORKER}/jobs/${job?.id}/report.docx`}>
            <button>Descargar Word</button>
          </a>
          <button onClick={reset}>← Analizar otros archivos</button>
        </div>

        {report.sources.map((s) => (
          <section className="source-card" key={s.id}>
            <header>
              <h2>{s.businessName}</h2>
              <span className="meta mono">
                {s.technicalName}
                {s.origin.kind === 'file' && s.origin.sheet ? ` · hoja «${s.origin.sheet}»` : ''} · {fmtInt(s.rowCount)}{' '}
                filas · {s.columns.length} columnas
              </span>
            </header>

            {s.origin.kind === 'file' && s.origin.interpretation && (
              <div className="notice">
                Esta hoja no empezaba donde suelen empezar las tablas: el encabezado se encontró en la fila{' '}
                {s.origin.interpretation.headerRow} y se descartaron {s.origin.interpretation.discardedRows.length}{' '}
                filas de título, vacías o de totales. Revisa que la lectura sea correcta.
              </div>
            )}
            {s.ingestWarnings.map((w, i) => (
              <div className="notice" key={i}>
                {w}
              </div>
            ))}

            {s.columns.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Columna</th>
                    <th>Qué contiene</th>
                    <th>Vacíos</th>
                    <th>Distintos</th>
                    <th>Ejemplo</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {s.columns.map((c) => {
                    const empty = c.nullCount + c.emptyLikeCount;
                    const emptyPct = c.rowCount > 0 ? (empty / c.rowCount) * 100 : 0;
                    return (
                      <tr key={c.name}>
                        <td className="mono">{c.name}</td>
                        <td>{TYPE_LABELS[c.semanticType] ?? c.semanticType}</td>
                        <td>{emptyPct === 0 ? '—' : `${emptyPct.toFixed(emptyPct < 1 ? 1 : 0)}%`}</td>
                        <td>{fmtInt(c.distinctCount)}</td>
                        <td className="mono">{c.topValues[0]?.value ?? '—'}</td>
                        <td>
                          {c.isPersonalData && <span className="badge personal">datos personales</span>}{' '}
                          {c.risks.length > 0 && (
                            <span className="badge warn" title={c.risks.join(' · ')}>
                              revisar
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </main>
    );
  }

  // ─── Vista: estado inicial (P1·a del wireframe) ──────────────────────
  return (
    <main className="wrap">
      <h1>Empecemos por tus archivos</h1>
      <p className="sub">
        Sube todo lo que tengas, aunque esté desordenado. Nosotros leemos, interpretamos y te mostramos el mapa real de
        tus datos. No hace falta que decidas nada todavía.
      </p>

      {error && <div className="notice red">{error}</div>}

      <div
        className={`dropzone${dragOver ? ' over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <div className="big">Arrastra aquí tus archivos</div>
        <div className="hint">Puedes soltar varios a la vez · .xlsx · .csv · .json · .parquet · hasta 2 GB</div>
        <div style={{ marginTop: '1rem' }}>
          <button type="button">Seleccionar archivos</button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.tsv,.xlsx,.json,.jsonl,.parquet"
          style={{ display: 'none' }}
          onChange={(e) => addFiles(e.target.files)}
        />
      </div>

      <div className="row">
        <div className="card">
          <h3>Conectar una base de datos</h3>
          <p>PostgreSQL o MySQL, en modo de solo lectura. Nunca modificamos tus datos.</p>
          {showDbForm ? (
            <form
              className="db-form"
              onSubmit={(e) => {
                e.preventDefault();
                startDbJob();
              }}
            >
              <select value={db.engine} onChange={(e) => setDb({ ...db, engine: e.target.value as 'postgresql' | 'mysql' })}>
                <option value="postgresql">PostgreSQL</option>
                <option value="mysql">MySQL</option>
              </select>
              <input placeholder="Servidor (host)" value={db.host} onChange={(e) => setDb({ ...db, host: e.target.value })} required />
              <input
                placeholder="Puerto"
                type="number"
                value={db.port}
                onChange={(e) => setDb({ ...db, port: Number(e.target.value) })}
                required
              />
              <input placeholder="Base de datos" value={db.database} onChange={(e) => setDb({ ...db, database: e.target.value })} required />
              <input placeholder="Usuario" value={db.user} onChange={(e) => setDb({ ...db, user: e.target.value })} required />
              <input
                placeholder="Contraseña"
                type="password"
                value={db.password}
                onChange={(e) => setDb({ ...db, password: e.target.value })}
              />
              <div className="actions">
                <button className="primary" type="submit">
                  Conectar y analizar
                </button>
                <button type="button" onClick={() => setShowDbForm(false)}>
                  Cancelar
                </button>
              </div>
            </form>
          ) : (
            <button className="link" onClick={() => setShowDbForm(true)}>
              Configurar conexión →
            </button>
          )}
        </div>
        <div className="card">
          <h3>¿Primera vez?</h3>
          <p>
            Prueba con un conjunto de ejemplo: 6 archivos de un programa social con los problemas típicos de una hoja de
            cálculo real.{' '}
            <button className="link" onClick={startDemoJob}>
              Usar datos de ejemplo →
            </button>
          </p>
        </div>
      </div>

      {files.length > 0 && (
        <section className="source-card">
          <header>
            <h2>Archivos cargados · {files.length}</h2>
          </header>
          <table>
            <thead>
              <tr>
                <th>Archivo</th>
                <th>Tamaño</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.name}>
                  <td className="mono">{f.name}</td>
                  <td>{fmtBytes(f.size)}</td>
                  <td>
                    <button className="link" onClick={() => setFiles((prev) => prev.filter((x) => x.name !== f.name))}>
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.8rem' }}>
            <button onClick={() => inputRef.current?.click()}>Añadir más</button>
            <button className="primary" onClick={startUploadJob}>
              Analizar mis datos
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
