'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ReactFlow, Background, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { AnalysisReport, Finding, Relationship, TableSource } from '@sondadata/schema';

const WORKER = process.env.NEXT_PUBLIC_WORKER_URL ?? '/api/worker';

const SIGNAL_LABELS: Record<string, string> = {
  typeCompatibility: 'Compatibilidad de tipos',
  lexicalSimilarity: 'Parecido de los nombres',
  valueInclusionLeftInRight: 'Valores encontrados en el otro archivo',
  valueInclusionRightInLeft: 'Parte del catálogo que se usa',
  parentUniqueness: 'Unicidad del lado referenciado',
  cardinalityConsistency: 'Consistencia de la forma de la relación',
};

const CONF_ES = { high: 'alta', medium: 'media', low: 'baja' } as const;

function fmtInt(n: number): string {
  return n.toLocaleString('es-CO');
}

function SignalBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="signal">
      <span className="signal-label">{label}</span>
      <span className="signal-track">
        <span className="signal-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="signal-value mono">{Math.round(value * 100)}%</span>
    </div>
  );
}

function EdgePanel({
  rel,
  sources,
  jobId,
  onDecision,
  onClose,
}: {
  rel: Relationship;
  sources: TableSource[];
  jobId: string;
  onDecision: (rel: Relationship) => void;
  onClose: () => void;
}) {
  const left = sources.find((s) => s.id === rel.leftSourceId);
  const right = sources.find((s) => s.id === rel.rightSourceId);
  const [busy, setBusy] = useState(false);

  async function decide(decision: 'confirmed' | 'rejected' | 'pending') {
    setBusy(true);
    try {
      const res = await fetch(`${WORKER}/jobs/${jobId}/relationships/${rel.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (res.ok) onDecision(await res.json());
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="panel">
      <header>
        <h2>Evidencia de la relación</h2>
        <button className="link" onClick={onClose}>
          Cerrar
        </button>
      </header>
      <p className="rel-title">
        <strong>{left?.businessName}</strong> se conecta con <strong>{right?.businessName}</strong>
      </p>
      <p className="mono meta">
        {left?.businessName} · {rel.leftColumns.join(' + ')} → {right?.businessName} · {rel.rightColumns.join(' + ')}
      </p>
      <p>
        <span className={`badge ${rel.confidence === 'high' ? 'ok' : rel.confidence === 'medium' ? 'warn' : 'info'}`}>
          Relación posible · confianza {CONF_ES[rel.confidence]}
        </span>{' '}
        <span className="badge info">{rel.cardinality}</span>
        {rel.normalizations.length > 0 && (
          <span className="badge warn" title="La coincidencia se logró normalizando los valores; conviene unificar la escritura en el origen.">
            escritura unificada
          </span>
        )}
        {rel.userDecision !== 'pending' && (
          <span className={`badge ${rel.userDecision === 'confirmed' ? 'ok' : 'personal'}`}>
            {rel.userDecision === 'confirmed' ? 'Confirmada por ti' : 'Rechazada por ti'}
          </span>
        )}
      </p>
      <p className="explain">{rel.explanation}</p>

      <h3>En qué nos basamos</h3>
      {Object.entries(rel.signals)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => (
          <SignalBar key={k} label={SIGNAL_LABELS[k] ?? k} value={v as number} />
        ))}

      {rel.penalties.length > 0 && (
        <>
          <h3>Lo que resta confianza</h3>
          <ul className="penalties">
            {rel.penalties.map((p, i) => (
              <li key={i}>
                <span className="mono delta">−{Math.abs(Math.round(p.delta * 100))}</span> {p.plainText}
              </li>
            ))}
          </ul>
        </>
      )}

      {rel.limitations.length > 0 && <p className="fine">{rel.limitations.join(' ')}</p>}

      <details>
        <summary>Ver detalle técnico</summary>
        {rel.evidence.map((e, i) => (
          <div key={i}>
            <p className="fine">{e.label}</p>
            <pre className="mono sql">{e.sql}</pre>
            <p className="fine mono">Resultado: {JSON.stringify(e.result)}</p>
          </div>
        ))}
      </details>

      <div className="actions">
        <button className="primary" disabled={busy || rel.userDecision === 'confirmed'} onClick={() => decide('confirmed')}>
          Confirmar
        </button>
        <button disabled={busy || rel.userDecision === 'rejected'} onClick={() => decide('rejected')}>
          Rechazar
        </button>
        {rel.userDecision !== 'pending' && (
          <button className="link" disabled={busy} onClick={() => decide('pending')}>
            Deshacer
          </button>
        )}
      </div>
    </aside>
  );
}

function NodePanel({ source, findings, onClose }: { source: TableSource; findings: Finding[]; onClose: () => void }) {
  const own = findings.filter((f) => f.sourceIds.includes(source.id));
  const personales = source.columns.filter((c) => c.isPersonalData);
  return (
    <aside className="panel">
      <header>
        <h2>{source.businessName}</h2>
        <button className="link" onClick={onClose}>
          Cerrar
        </button>
      </header>
      <p className="mono meta">
        {source.technicalName} · {fmtInt(source.rowCount)} filas · {source.columns.length} columnas
      </p>
      {personales.length > 0 && (
        <div className="notice red">
          Detectamos datos personales en {personales.length} columnas. Se muestran ocultos y nunca salen en el informe.
        </div>
      )}
      {own.length > 0 && (
        <>
          <h3>Hallazgos de esta fuente</h3>
          {own.map((f) => (
            <div className="finding" key={f.id}>
              <span className={`badge ${f.severity === 'critical' ? 'personal' : f.severity === 'warning' ? 'warn' : 'info'}`}>
                {f.severity === 'critical' ? 'crítico' : f.severity === 'warning' ? 'atención' : 'informativo'}
              </span>
              <p>{f.title}</p>
              <details>
                <summary>Ver la evidencia</summary>
                {f.evidence.map((e, i) => (
                  <pre className="mono sql" key={i}>
                    {e.sql}
                  </pre>
                ))}
              </details>
            </div>
          ))}
        </>
      )}
      <h3>Columnas</h3>
      <table>
        <thead>
          <tr>
            <th>Columna</th>
            <th>Vacíos</th>
            <th>Distintos</th>
          </tr>
        </thead>
        <tbody>
          {source.columns.map((c) => (
            <tr key={c.name}>
              <td className="mono">
                {c.name} {c.isPersonalData && <span className="badge personal">personal</span>}
              </td>
              <td>{c.rowCount > 0 ? `${(((c.nullCount + c.emptyLikeCount) / c.rowCount) * 100).toFixed(0)}%` : '—'}</td>
              <td>{fmtInt(c.distinctCount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  );
}

function MapaInner() {
  const params = useSearchParams();
  const [jobId, setJobId] = useState<string | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fromUrl = params.get('job');
    const id = fromUrl ?? localStorage.getItem('sondadata:lastJob');
    setJobId(id);
    if (!id) {
      setLoading(false);
      return;
    }
    fetch(`${WORKER}/jobs/${id}/report`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setReport)
      .finally(() => setLoading(false));
  }, [params]);

  const visibleRels = useMemo(
    () => (report?.relationships ?? []).filter((r) => r.userDecision !== 'rejected' && r.confidence !== 'low'),
    [report],
  );

  const nodes: Node[] = useMemo(() => {
    if (!report) return [];
    const n = report.sources.length;
    const cx = 460;
    const cy = 300;
    return report.sources.map((s, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      const critical = report.findings.filter((f) => f.sourceIds[0] === s.id && f.severity === 'critical').length;
      const personal = s.columns.some((c) => c.isPersonalData);
      return {
        id: s.id,
        position: { x: cx + 380 * Math.cos(angle), y: cy + 220 * Math.sin(angle) },
        data: {
          label: (
            <div className="map-node">
              <strong>{s.businessName}</strong>
              <span className="meta">{fmtInt(s.rowCount)} filas</span>
              {critical > 0 && <span className="badge personal">{critical} crítico</span>}
              {personal && <span className="badge warn">datos personales</span>}
            </div>
          ),
        },
        style: {
          border: `2px solid ${critical > 0 ? 'var(--red)' : 'var(--ink-2)'}`,
          borderRadius: 10,
          background: 'var(--paper)',
          padding: 6,
          width: 190,
        },
      };
    });
  }, [report]);

  const edges: Edge[] = useMemo(
    () =>
      visibleRels.map((r) => ({
        id: r.id,
        source: r.leftSourceId,
        target: r.rightSourceId,
        label: `confianza ${CONF_ES[r.confidence]}`,
        animated: false,
        style: {
          strokeDasharray: r.userDecision === 'confirmed' ? undefined : '6 4',
          stroke:
            r.userDecision === 'confirmed'
              ? 'var(--green)'
              : r.confidence === 'high'
                ? 'var(--ink-2)'
                : 'var(--amber)',
          strokeWidth: 2,
        },
        labelStyle: { fontSize: 10, fill: 'var(--ink-3)' },
      })),
    [visibleRels],
  );

  if (loading) {
    return (
      <main className="wrap">
        <h1>
          <span className="spinner" /> Cargando el mapa…
        </h1>
      </main>
    );
  }
  if (!jobId || !report) {
    return (
      <main className="wrap">
        <h1>Todavía no hay un análisis</h1>
        <p className="sub">
          El mapa se construye a partir de tu primer análisis. <Link href="/">Empieza subiendo tus archivos →</Link>
        </p>
      </main>
    );
  }

  const selectedRel = selected?.kind === 'edge' ? report.relationships.find((r) => r.id === selected.id) : null;
  const selectedSource = selected?.kind === 'node' ? report.sources.find((s) => s.id === selected.id) : null;
  const criticals = report.findings.filter((f) => f.severity === 'critical');

  return (
    <main className="map-layout">
      <div className="map-canvas">
        <div className="map-header">
          <span>
            {report.sources.length} fuentes · {visibleRels.length} relaciones ·{' '}
            <a href={`${WORKER}/jobs/${jobId}/report.html`} target="_blank" rel="noreferrer">
              Ver informe
            </a>
          </span>
          <span className="meta">
            Línea punteada: relación deducida por el sistema, pendiente de tu confirmación. Haz clic para ver la
            evidencia.
          </span>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={(_, node) => setSelected({ kind: 'node', id: node.id })}
          onEdgeClick={(_, edge) => setSelected({ kind: 'edge', id: edge.id })}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--line)" />
        </ReactFlow>
      </div>

      {selectedRel && (
        <EdgePanel
          rel={selectedRel}
          sources={report.sources}
          jobId={jobId}
          onClose={() => setSelected(null)}
          onDecision={(updated) =>
            setReport((prev) =>
              prev
                ? { ...prev, relationships: prev.relationships.map((r) => (r.id === updated.id ? updated : r)) }
                : prev,
            )
          }
        />
      )}
      {selectedSource && (
        <NodePanel source={selectedSource} findings={report.findings} onClose={() => setSelected(null)} />
      )}
      {!selected && (
        <aside className="panel">
          <header>
            <h2>Hallazgos</h2>
            <span className="meta">{report.findings.length} en total</span>
          </header>
          {report.findings.length === 0 && (
            <p className="fine">
              Aún no hay hallazgos registrados. El diagnóstico de calidad completo llega en la fase 4: aquí aparecerán
              los problemas priorizados con su evidencia.
            </p>
          )}
          {criticals.map((f) => (
            <div className="finding" key={f.id}>
              <span className="badge personal">crítico</span>
              <p>{f.title}</p>
            </div>
          ))}
          <p className="fine">Haz clic en una tabla o en una relación para ver su detalle y su evidencia.</p>
        </aside>
      )}
    </main>
  );
}

export default function MapaPage() {
  return (
    <Suspense fallback={null}>
      <MapaInner />
    </Suspense>
  );
}
