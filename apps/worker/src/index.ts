import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { DbConnection, PRODUCT, type AnalysisJob } from '@sondadata/schema';
import { decryptJson, encryptJson, ephemeralKey } from './crypto.js';
import { executeBridge, executeJoin, renderReportDocx, renderReportHtml } from '@sondadata/engine';
import { generateFixtures } from '@sondadata/fixtures';
import { FileJobStore } from './store.js';
import { JobRunner } from './runner.js';

const dataDir = process.env.SONDADATA_DATA_DIR ?? join(import.meta.dirname, '..', 'data');
const store = new FileJobStore(dataDir);
const runner = new JobRunner(store);

const app = new Hono();
app.use('*', cors({ origin: (o) => o ?? '*' }));

const CreateJob = z.object({
  projectName: z.string().min(1),
  /** MVP local: carpeta del disco con los archivos a analizar. */
  inputDir: z.string().min(1).optional(),
  /** O una conexión viva de solo lectura. */
  connection: DbConnection.optional(),
});

/** Los jobs nunca exponen credenciales, ni siquiera cifradas. */
function redactJob(job: AnalysisJob): Omit<AnalysisJob, 'connectionEncrypted'> & { hasConnection: boolean } {
  const { connectionEncrypted, ...rest } = job;
  return { ...rest, hasConnection: connectionEncrypted !== null };
}

const ALLOWED_EXT = new Set(['.csv', '.tsv', '.xlsx', '.json', '.jsonl', '.parquet']);
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB (wireframe)

function newJob(projectName: string, inputDir: string, connectionEncrypted: string | null = null): AnalysisJob {
  return {
    id: randomUUID().slice(0, 8),
    projectName,
    status: 'queued',
    inputDir,
    connectionEncrypted,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    events: [],
    artifactPath: null,
  };
}

app.get('/health', (c) => c.json({ ok: true, product: PRODUCT.name, engine: PRODUCT.engineVersion }));

/** Crear job desde archivos subidos (multipart) o desde una carpeta local (JSON). */
app.post('/jobs', async (c) => {
  const contentType = c.req.header('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const projectName = String(form.get('projectName') ?? 'Mi proyecto');
    type UploadedFile = { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };
    const files = form
      .getAll('files')
      .filter((f) => typeof f !== 'string') as unknown as UploadedFile[];
    if (files.length === 0) return c.json({ error: 'No llegó ningún archivo' }, 400);

    const uploadDir = join(dataDir, 'uploads', randomUUID().slice(0, 8));
    mkdirSync(uploadDir, { recursive: true });
    for (const file of files) {
      const ext = extname(file.name).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) return c.json({ error: `Formato no soportado: ${file.name}` }, 400);
      if (file.size > MAX_FILE_BYTES) return c.json({ error: `Archivo demasiado grande: ${file.name}` }, 400);
      // nombre saneado por el servidor: nunca rutas del cliente
      const safeName = basename(file.name).replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]/g, '_');
      writeFileSync(join(uploadDir, safeName), Buffer.from(await file.arrayBuffer()));
    }
    const job = newJob(projectName, uploadDir);
    store.create(job);
    return c.json(job, 201);
  }

  const body = CreateJob.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'projectName y (inputDir o connection) son obligatorios' }, 400);

  if (body.data.connection) {
    const job = newJob(body.data.projectName, '', encryptJson(body.data.connection));
    store.create(job);
    return c.json(redactJob(job), 201);
  }
  if (!body.data.inputDir) return c.json({ error: 'Falta inputDir o connection' }, 400);
  if (!existsSync(body.data.inputDir)) return c.json({ error: 'La carpeta indicada no existe' }, 400);
  const job = newJob(body.data.projectName, body.data.inputDir);
  store.create(job);
  return c.json(redactJob(job), 201);
});

/** Job de demostración: genera el dataset de ejemplo y lo encola. */
app.post('/jobs/demo', async (c) => {
  const demoDir = join(dataDir, 'uploads', `demo-${randomUUID().slice(0, 8)}`);
  await generateFixtures(demoDir, { writeManifest: false });
  const job = newJob('Programa de Inversión Social (ejemplo)', demoDir);
  store.create(job);
  return c.json(job, 201);
});

app.get('/jobs', (c) => c.json(store.list().map(redactJob)));

app.get('/jobs/:id', (c) => {
  const job = store.get(c.req.param('id'));
  return job ? c.json(redactJob(job)) : c.json({ error: 'Job no encontrado' }, 404);
});

/** Borrado verificable: elimina job, artefacto, archivos subidos y exports. */
app.delete('/jobs/:id', (c) => {
  const jobId = c.req.param('id');
  const job = store.get(jobId);
  if (!job) return c.json({ error: 'Job no encontrado' }, 404);
  const removed: string[] = [];
  // solo se purgan carpetas que este worker creó (uploads/), nunca rutas arbitrarias
  if (job.inputDir && job.inputDir.startsWith(join(dataDir, 'uploads'))) {
    rmSync(job.inputDir, { recursive: true, force: true });
    removed.push('archivos subidos');
  }
  for (const suffix of ['jobs/' + jobId + '.json', 'artifacts/' + jobId + '.json']) {
    const p = join(dataDir, suffix);
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed.push(suffix.split('/')[0]!);
    }
  }
  const exportsDir = join(dataDir, 'exports');
  if (existsSync(exportsDir)) {
    for (const f of readdirSync(exportsDir).filter((f) => f.startsWith(jobId + '-'))) {
      rmSync(join(exportsDir, f), { force: true });
    }
    removed.push('exports');
  }
  return c.json({ deleted: true, removed });
});

app.get('/jobs/:id/report', (c) => {
  const report = store.readArtifact(c.req.param('id'));
  return report ? c.json(report) : c.json({ error: 'El informe aún no está listo' }, 404);
});

/** Informe formal en HTML autocontenido (imprimible a PDF desde el navegador). */
app.get('/jobs/:id/report.html', (c) => {
  const report = store.readArtifact(c.req.param('id'));
  if (!report) return c.json({ error: 'El informe aún no está listo' }, 404);
  return c.html(renderReportHtml(report));
});

/** Informe en Word. */
app.get('/jobs/:id/report.docx', async (c) => {
  const report = store.readArtifact(c.req.param('id'));
  if (!report) return c.json({ error: 'El informe aún no está listo' }, 404);
  const buffer = await renderReportDocx(report);
  const safeName = report.meta.projectName.replace(/[^\w\-áéíóúñ ]/gi, '').slice(0, 60);
  return c.body(new Uint8Array(buffer), 200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'content-disposition': `attachment; filename="Diagnostico - ${safeName}.docx"`,
  });
});

/** Ejecutar un cruce ya predicho: materializa y deja el CSV descargable. */
app.post('/jobs/:id/joins/:joinId/execute', async (c) => {
  const jobId = c.req.param('id');
  const joinId = c.req.param('joinId');
  const job = store.get(jobId);
  const report = store.readArtifact(jobId);
  if (!job || !report) return c.json({ error: 'Job o informe no encontrado' }, 404);
  const pred = report.joinPredictions.find((p) => p.id === joinId);
  if (!pred) return c.json({ error: 'Cruce no encontrado' }, 404);
  if (!job.connectionEncrypted && !existsSync(job.inputDir))
    return c.json({ error: 'Los archivos del análisis ya no están disponibles' }, 410);

  const outDir = join(dataDir, 'exports');
  mkdirSync(outDir, { recursive: true });
  const outputPath = join(outDir, `${jobId}-${joinId}.csv`);
  try {
    const result = await executeJoin({
      jobId,
      inputDir: job.inputDir,
      connection: job.connectionEncrypted ? decryptJson(job.connectionEncrypted) : null,
      leftSourceId: pred.leftSourceId,
      rightSourceId: pred.rightSourceId,
      leftColumn: pred.keys[0]!.left,
      rightColumn: pred.keys[0]!.right,
      chain: (pred.normalizations[0] as 'basic' | 'digits' | undefined) ?? 'exact',
      outputPath,
    });
    return c.json({ rows: result.rows, downloadUrl: `/jobs/${jobId}/joins/${joinId}/download` });
  } catch (err) {
    return c.json({ error: `No se pudo ejecutar el cruce: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
});

app.get('/jobs/:id/joins/:joinId/download', (c) => {
  const path = join(dataDir, 'exports', `${c.req.param('id')}-${c.req.param('joinId')}.csv`);
  if (!existsSync(path)) return c.json({ error: 'Aún no se ha ejecutado este cruce' }, 404);
  const body = readFileSync(path);
  return c.body(body, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="cruce-${c.req.param('joinId')}.csv"`,
  });
});

const BridgeMeaning = z.object({
  rowMeaning: z.string().min(1),
  repeatsOverTime: z.boolean(),
});

/** Confirmar el significado de una tabla puente y generarla (CSV descargable). */
app.post('/jobs/:id/bridges/:bridgeId/execute', async (c) => {
  const jobId = c.req.param('id');
  const bridgeId = c.req.param('bridgeId');
  const job = store.get(jobId);
  const report = store.readArtifact(jobId);
  if (!job || !report) return c.json({ error: 'Job o informe no encontrado' }, 404);
  const bridge = report.bridgeProposals.find((b) => b.id === bridgeId);
  if (!bridge) return c.json({ error: 'Propuesta no encontrada' }, 404);
  const body = BridgeMeaning.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'Confirma qué representa cada fila antes de generar' }, 400);
  if (!job.connectionEncrypted && !existsSync(job.inputDir))
    return c.json({ error: 'Los archivos del análisis ya no están disponibles' }, 410);

  const outDir = join(dataDir, 'exports');
  mkdirSync(outDir, { recursive: true });
  const outputPath = join(outDir, `${jobId}-${bridgeId}.csv`);
  try {
    const result = await executeBridge({
      jobId,
      inputDir: job.inputDir,
      connection: job.connectionEncrypted ? decryptJson(job.connectionEncrypted) : null,
      populateSql: bridge.populateSql,
      outputPath,
    });
    bridge.meaning = { rowMeaning: body.data.rowMeaning, repeatsOverTime: body.data.repeatsOverTime, confirmedByUser: true };
    store.saveArtifact(jobId, report);
    return c.json({ rows: result.rows, downloadUrl: `/jobs/${jobId}/bridges/${bridgeId}/download` });
  } catch (err) {
    return c.json({ error: `No se pudo generar la tabla: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
});

app.get('/jobs/:id/bridges/:bridgeId/download', (c) => {
  const path = join(dataDir, 'exports', `${c.req.param('id')}-${c.req.param('bridgeId')}.csv`);
  if (!existsSync(path)) return c.json({ error: 'Aún no se ha generado esta tabla' }, 404);
  const body = readFileSync(path);
  return c.body(body, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="tabla-${c.req.param('bridgeId')}.csv"`,
  });
});

const RelationshipDecision = z.object({
  decision: z.enum(['pending', 'confirmed', 'rejected']),
  comment: z.string().nullable().optional(),
});

/** Decisión del usuario sobre una relación inferida (Pantalla 2). */
app.patch('/jobs/:id/relationships/:relId', async (c) => {
  const jobId = c.req.param('id');
  const relId = c.req.param('relId');
  const body = RelationshipDecision.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'decision debe ser pending|confirmed|rejected' }, 400);

  const report = store.readArtifact(jobId);
  if (!report) return c.json({ error: 'Informe no encontrado' }, 404);
  const rel = report.relationships.find((r) => r.id === relId);
  if (!rel) return c.json({ error: 'Relación no encontrada' }, 404);

  rel.userDecision = body.data.decision;
  if (body.data.comment !== undefined) rel.userComment = body.data.comment;
  store.saveArtifact(jobId, report);
  return c.json(rel);
});

// Página mínima de estado para la demo F0 (la web real llega en F1 con Next.js).
app.get('/', (c) =>
  c.html(`<!doctype html><meta charset="utf-8"><title>${PRODUCT.name} · worker</title>
<style>body{font-family:system-ui;background:#eceae5;color:#1c1a17;max-width:720px;margin:3rem auto;padding:0 1rem}
code{background:#e2ded6;padding:2px 6px;border-radius:4px}</style>
<h1>${PRODUCT.name} — worker en marcha</h1>
<p>API: <code>POST /jobs</code> · <code>GET /jobs</code> · <code>GET /jobs/:id</code> · <code>GET /jobs/:id/report</code></p>
<p>La interfaz de usuario llega en la Fase 1.</p>`),
);

const port = Number(process.env.PORT ?? 8787);
runner.start();
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[${PRODUCT.name}] worker escuchando en http://localhost:${info.port} · datos en ${dataDir}`);
  if (ephemeralKey) {
    console.warn(
      `[${PRODUCT.name}] SONDADATA_SECRET_KEY no está configurada: las conexiones a bases de datos usan una clave efímera y no sobrevivirán un reinicio.`,
    );
  }
});
