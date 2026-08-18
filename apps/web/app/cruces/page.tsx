'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { AnalysisReport, BridgeProposal, JoinPrediction } from '@sondadata/schema';
import { findIndirectRoutes } from '@sondadata/engine/routes';

const WORKER = process.env.NEXT_PUBLIC_WORKER_URL ?? '/api/worker';

function fmtInt(n: number): string {
  return n.toLocaleString('es-CO');
}

function StatTile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'red' }) {
  return (
    <div className={`stat-tile${tone === 'red' ? ' red' : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value mono">{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

function BridgeCard({ bridge, jobId }: { bridge: BridgeProposal; jobId: string }) {
  const [dialog, setDialog] = useState(false);
  const [rowMeaning, setRowMeaning] = useState(bridge.description);
  const [repeats, setRepeats] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ rows: number; downloadUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${WORKER}/jobs/${jobId}/bridges/${bridge.id}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rowMeaning, repeatsOverTime: repeats }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setResult(data);
      setDialog(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card bridge-card">
      <h3>{bridge.title}</h3>
      <span className="badge info">{bridge.kind === 'embedded_list' ? 'Lista dentro de una celda' : 'Relación de varios a varios'}</span>
      <p>{bridge.description}</p>
      {bridge.resultMetrics && (
        <p className="fine">
          Resultaría en {fmtInt(bridge.resultMetrics.rows)} filas
          {bridge.resultMetrics.maxDegreeLeft > 1 && ` · hasta ${bridge.resultMetrics.maxDegreeLeft} valores por registro`}.
        </p>
      )}
      {error && <div className="notice red">{error}</div>}
      {result ? (
        <p>
          <span className="badge ok">Generada · {fmtInt(result.rows)} filas</span>{' '}
          <a href={`${WORKER}${result.downloadUrl}`}>Descargar CSV</a>
        </p>
      ) : dialog ? (
        <div className="bridge-dialog">
          <h4>Antes de generarla, confirma qué significa</h4>
          <label>
            ¿Qué representa cada fila de la nueva tabla?
            <textarea value={rowMeaning} onChange={(e) => setRowMeaning(e.target.value)} rows={2} />
          </label>
          <label>
            ¿Puede repetirse en el tiempo? (p. ej., el mismo par vuelve a ocurrir en otro trimestre)
            <span className="radio-row">
              <label>
                <input type="radio" checked={!repeats} onChange={() => setRepeats(false)} /> No, ocurre una sola vez
              </label>
              <label>
                <input type="radio" checked={repeats} onChange={() => setRepeats(true)} /> Sí, con una fecha
              </label>
            </span>
          </label>
          <details>
            <summary>Ver detalle técnico</summary>
            <pre className="mono sql">{bridge.ddl}</pre>
            <pre className="mono sql">{bridge.populateSql}</pre>
          </details>
          <div className="actions">
            <button className="primary" disabled={busy || rowMeaning.trim() === ''} onClick={generate}>
              Generar tabla
            </button>
            <button onClick={() => setDialog(false)}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button className="primary" onClick={() => setDialog(true)}>
            Revisar y generar
          </button>
        </div>
      )}
    </div>
  );
}

function CrucesInner() {
  const params = useSearchParams();
  const [jobId, setJobId] = useState<string | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [leftId, setLeftId] = useState<string>('');
  const [rightId, setRightId] = useState<string>('');
  const [execBusy, setExecBusy] = useState(false);
  const [execResult, setExecResult] = useState<{ rows: number; downloadUrl: string } | null>(null);
  const [execError, setExecError] = useState<string | null>(null);

  useEffect(() => {
    const id = params.get('job') ?? localStorage.getItem('sondadata:lastJob');
    setJobId(id);
    if (!id) {
      setLoading(false);
      return;
    }
    fetch(`${WORKER}/jobs/${id}/report`)
      .then((r) => (r.ok ? r.json() : null))
      .then((r: AnalysisReport | null) => {
        setReport(r);
        const first = r?.joinPredictions[0];
        if (first) {
          setLeftId(first.leftSourceId);
          setRightId(first.rightSourceId);
        }
      })
      .finally(() => setLoading(false));
  }, [params]);

  const prediction: JoinPrediction | null = useMemo(() => {
    if (!report || !leftId || !rightId) return null;
    return (
      report.joinPredictions.find(
        (p) =>
          (p.leftSourceId === leftId && p.rightSourceId === rightId) ||
          (p.leftSourceId === rightId && p.rightSourceId === leftId),
      ) ?? null
    );
  }, [report, leftId, rightId]);

  const route = useMemo(() => {
    if (!report || prediction || !leftId || !rightId || leftId === rightId) return null;
    return (
      findIndirectRoutes(report.relationships, 3).find(
        (r) =>
          (r.fromSourceId === leftId && r.toSourceId === rightId) ||
          (r.fromSourceId === rightId && r.toSourceId === leftId),
      ) ?? null
    );
  }, [report, prediction, leftId, rightId]);

  useEffect(() => {
    setExecResult(null);
    setExecError(null);
  }, [prediction?.id]);

  async function executeJoinNow() {
    if (!prediction || !jobId) return;
    setExecBusy(true);
    setExecError(null);
    try {
      const res = await fetch(`${WORKER}/jobs/${jobId}/joins/${prediction.id}/execute`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setExecResult(data);
    } catch (e) {
      setExecError(e instanceof Error ? e.message : String(e));
    } finally {
      setExecBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="wrap">
        <h1>
          <span className="spinner" /> Cargando…
        </h1>
      </main>
    );
  }
  if (!jobId || !report) {
    return (
      <main className="wrap">
        <h1>Todavía no hay un análisis</h1>
        <p className="sub">
          Los cruces se calculan a partir de tu primer análisis. <Link href="/">Empieza subiendo tus archivos →</Link>
        </p>
      </main>
    );
  }

  const src = (id: string) => report.sources.find((s) => s.id === id);
  const orientedLeft = prediction ? src(prediction.leftSourceId) : src(leftId);
  const orientedRight = prediction ? src(prediction.rightSourceId) : src(rightId);
  const fanOut = prediction?.fanOut.risk ?? false;

  return (
    <main className="wrap wide">
      <h1>Cruzar</h1>
      <div className="join-selector">
        <select value={leftId} onChange={(e) => setLeftId(e.target.value)}>
          <option value="">— elige una tabla —</option>
          {report.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.businessName}
            </option>
          ))}
        </select>
        <span>con</span>
        <select value={rightId} onChange={(e) => setRightId(e.target.value)}>
          <option value="">— elige una tabla —</option>
          {report.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.businessName}
            </option>
          ))}
        </select>
        {prediction && (
          <span className="meta mono">
            uniendo por «{prediction.keys[0]!.left}» ↔ «{prediction.keys[0]!.right}»
            {prediction.normalizations.length > 0 && ' · escritura unificada'}
          </span>
        )}
      </div>

      {!prediction && leftId && rightId && leftId !== rightId && (
        <div className="notice">
          No encontramos una llave directa para cruzar estas dos tablas.
          {route && (
            <>
              {' '}
              <strong>Sugerencia:</strong> puedes cruzarlas pasando por{' '}
              {route.via.map((v) => src(v)?.businessName).join(' y ')}. Ese camino usa relaciones ya verificadas.
            </>
          )}
        </div>
      )}

      {prediction && fanOut && (
        <section className="fanout-warning">
          <h2>⚠ {prediction.fanOut.plainWarning}</h2>
          <p>
            Muchos registros comparten el mismo valor a ambos lados, así que cada fila se repetiría una vez por cada
            pareja. Los importes quedarían multiplicados y cualquier suma sobre este resultado estaría equivocada.
          </p>
          <div className="stat-row">
            <StatTile label="Filas de partida" value={fmtInt(orientedLeft?.rowCount ?? 0)} />
            <StatTile label="Filas resultantes" value={fmtInt(prediction.expectedRows.inner.value)} tone="red" />
            <StatTile label="Multiplicación" value={`×${prediction.fanOut.multiplier}`} tone="red" />
            {prediction.fanOut.worstKey && (
              <StatTile
                label="Peor caso"
                value={prediction.fanOut.worstKey.value}
                note={`${prediction.fanOut.worstKey.leftCount} × ${prediction.fanOut.worstKey.rightCount}`}
              />
            )}
          </div>
        </section>
      )}

      {prediction && !fanOut && (
        <section>
          <h2>Qué obtendrías si ejecutas este cruce</h2>
          <p className="meta">Calculado con los histogramas de frecuencia de la llave · aún no se ejecuta nada.</p>
          <div className="stat-row">
            <StatTile label="Filas resultantes (coincidencias)" value={fmtInt(prediction.expectedRows.inner.value)} />
            <StatTile
              label="Conservando todo el lado izquierdo"
              value={fmtInt(prediction.expectedRows.left.value)}
              note={`${orientedLeft?.businessName}`}
            />
            <StatTile
              label="Coincidencia"
              value={`${Math.round(prediction.matchRate.leftInRight * 100)}%`}
              note={`de ${orientedLeft?.businessName}`}
            />
          </div>
          <div className="row">
            {(prediction.unmatchedLeft > 0 || prediction.unmatchedRight > 0) && (
              <div className="card">
                <h3>Qué se queda fuera</h3>
                <p>
                  {prediction.unmatchedLeft > 0 && (
                    <>
                      Se pierden <strong>{fmtInt(prediction.unmatchedLeft)} registros</strong> de{' '}
                      {orientedLeft?.businessName} sin correspondencia.{' '}
                    </>
                  )}
                  {prediction.unmatchedRight > 0 && (
                    <>
                      Quedan sin usar <strong>{fmtInt(prediction.unmatchedRight)} registros</strong> de{' '}
                      {orientedRight?.businessName}.
                    </>
                  )}
                </p>
              </div>
            )}
            {prediction.mostlyNullColumnsAfterJoin.length > 0 && (
              <div className="card">
                <h3>Columnas que quedarían casi vacías</h3>
                <p className="mono">{prediction.mostlyNullColumnsAfterJoin.join(' · ')}</p>
              </div>
            )}
          </div>
        </section>
      )}

      {prediction && prediction.indicators.length > 0 && (
        <section>
          <h2>Lo que este cruce te permite medir</h2>
          <p className="meta">
            {prediction.indicators.length} indicadores viables con los datos que ya tienes. La cobertura indica sobre
            qué parte de tus registros se puede calcular.
          </p>
          <div className="indicator-grid">
            {prediction.indicators.map((ind) => (
              <div className="card" key={ind.id}>
                <h3>{ind.title}</h3>
                <p>{ind.description}</p>
                <div className="signal">
                  <span className="signal-label">Cobertura de datos</span>
                  <span className="signal-track">
                    <span className="signal-fill" style={{ width: `${Math.round(ind.coverage * 100)}%` }} />
                  </span>
                  <span className="signal-value mono">{Math.round(ind.coverage * 100)}%</span>
                </div>
                <details>
                  <summary>Ver detalle técnico</summary>
                  <pre className="mono sql">{ind.sql}</pre>
                </details>
              </div>
            ))}
          </div>
        </section>
      )}

      {prediction && (
        <section className="execute-box">
          <h2>Ejecutar el cruce</h2>
          <p className="meta">
            Genera la tabla combinada de {fmtInt(prediction.expectedRows.left.value)} filas y la deja descargable. Tus
            archivos originales no se modifican.
          </p>
          {execError && <div className="notice red">{execError}</div>}
          {execResult ? (
            <p>
              <span className="badge ok">Ejecutado · {fmtInt(execResult.rows)} filas</span>{' '}
              <a href={`${WORKER}${execResult.downloadUrl}`}>Descargar CSV</a>
            </p>
          ) : (
            <button className={fanOut ? '' : 'primary'} disabled={execBusy} onClick={executeJoinNow}>
              {execBusy ? 'Ejecutando…' : fanOut ? 'Ejecutar de todas formas' : 'Ejecutar ahora'}
            </button>
          )}
        </section>
      )}

      {report.bridgeProposals.length > 0 && (
        <section>
          <h2>Tablas puente propuestas</h2>
          <p className="meta">
            Detectamos sitios donde una fila guarda varias cosas a la vez. Podemos separarlas en una tabla auxiliar para
            que puedas contar y cruzar sin duplicar. No generamos nada hasta que lo confirmes.
          </p>
          <div className="row">
            {report.bridgeProposals.map((b) => (
              <BridgeCard bridge={b} jobId={jobId} key={b.id} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

export default function CrucesPage() {
  return (
    <Suspense fallback={null}>
      <CrucesInner />
    </Suspense>
  );
}
