# SondaData

Herramienta de **diagnóstico de datos de una sola pasada**: el usuario sube sus
fuentes desordenadas (Excel, CSV, JSON, una base heredada) y en menos de 10
minutos obtiene el modelo real de sus datos, un diagnóstico de calidad en
lenguaje de negocio, un mapa de cruces posibles con predicción previa, y un
informe exportable para comité.

> **¿Evaluando el producto?** → [Guía del evaluador: SondaData en 10 minutos](docs/EVALUACION.md)

> **Principio rector:** DuckDB decide, el LLM narra. Toda afirmación de la UI
> está respaldada por una consulta SQL trazable (`evidence`). Sin evidencia,
> no se muestra.

Guía completa para probar la herramienta: [docs/EVALUACION.md](docs/EVALUACION.md).

## Estructura

```
├─ apps/
│  ├─ worker/     # Hono + ciclo de jobs; ejecuta el pipeline sobre DuckDB efímero
│  └─ web/        # (F1) Next.js — las 3 pantallas del wireframe
├─ packages/
│  ├─ schema/     # Contrato AnalysisReport (Zod) + config de producto. TODO gira alrededor de esto.
│  ├─ engine/     # Motor de análisis. TS puro + DuckDB. Sin dependencias de framework.
│  └─ fixtures/   # Generador determinista del dataset sucio de prueba/demo
```

## Desarrollo

```bash
pnpm install
pnpm test              # tests de todos los paquetes
pnpm typecheck
pnpm fixtures          # genera el dataset de demo en packages/fixtures/data
pnpm worker            # levanta el worker en http://localhost:8787
pnpm --filter @sondadata/web dev   # levanta la web en http://localhost:3000
```

Con worker y web levantados: abrir la web, pulsar «Usar datos de ejemplo →» y
ver el flujo completo: progreso por etapas → perfiles por columna con tipos
semánticos, datos personales enmascarados y avisos de interpretación del XLSX.

Demo del ciclo de análisis (mientras no existe la web):

```bash
curl -X POST http://localhost:8787/jobs -H "content-type: application/json" \
  -d '{"projectName":"Demo","inputDir":"C:/wamp_3/www/sondadata/packages/fixtures/data"}'
curl http://localhost:8787/jobs           # estado y eventos
curl http://localhost:8787/jobs/<id>/report   # artefacto AnalysisReport
```

## Estado por fases

| Fase | Contenido | Estado |
|---|---|---|
| **F0 · Cimientos** | Monorepo, contrato `AnalysisReport`, DuckDB efímero, ciclo de jobs, fixtures iniciales | ✅ Hecha |
| **F1 · Ingesta y perfilado** | XLSX + «Excel humano», perfilado por columna, tipos semánticos, datos personales enmascarados, Pantalla 1 (Next.js) | ✅ Hecha |
| **F2 · Llaves y modelo E-R** | PK/FK inferidas con scoring desglosado + **prueba de oro superada** (TPC-H 9/9, 0 falsos positivos altos), Pantalla 2 (Mapa) | ✅ Hecha |
| **F3 · Cruces difusos y puentes** | Normalización de valores (básica + dígitos), cobertura por filas, rutas indirectas, tablas puente con métricas ejecutadas | ✅ Hecha |
| **F4 · Diagnóstico + simulador** | Hallazgos como consecuencias de negocio, estimador por frecuencias con fan-out, catálogo de indicadores, Pantalla 3 (Cruces) con ejecución y descarga | ✅ Hecha |
| **F5 · Informe** | HTML autocontenido imprimible (A4, SVG del mapa, anexo técnico) + export Word — **hito monetizable alcanzado** | ✅ Hecha |
| **F6 · Conexiones vivas + endurecimiento** | Postgres/MySQL solo lectura con muestreo, credenciales AES-256-GCM, anti-inyección de fórmulas CSV, purga verificable, CI + Dockerfile | ✅ Hecha |

**El MVP está completo.** Verificación en vivo: análisis de la base `mysql` de un
servidor MySQL real (38 tablas, solo lectura, sin copiar tablas completas) con
pipeline completo e informe.

Decisiones locales vs. producción: los jobs y artefactos se guardan en disco
(`FileJobStore`) detrás de una interfaz pensada para cambiarse por Supabase
(Postgres + Storage) al salir a producción, sin tocar motor ni worker.

## Despliegue a producción

1. **Secretos**: copiar `.env.example`; generar `SONDADATA_SECRET_KEY`
   (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   Sin esa clave, las conexiones a BD usan una clave efímera por proceso.
2. **Worker** (Railway / Fly.io / contenedor): `apps/worker/Dockerfile`.
   Requiere un volumen persistente montado en `SONDADATA_DATA_DIR`.
   Vercel NO sirve para el worker (límite de tiempo y sin disco).
3. **Web** (Vercel): proyecto `apps/web`, variable `NEXT_PUBLIC_WORKER_URL`
   apuntando a la URL pública del worker.
4. **CI**: `.github/workflows/ci.yml` corre typecheck + la suite completa
   (incluida la prueba de oro TPC-H) en cada push.
5. Pendiente para multiusuario (v2): driver Supabase del `JobStore`, auth por
   correo y enlaces de informe con expiración; la capa LLM opcional (Anthropic)
   para pulir la narración — el sistema es completamente funcional sin ella.

## Seguridad (resumen)

- Conexiones a BD **siempre** `READ_ONLY` (a nivel de ATTACH de DuckDB); primero
  metadatos, luego muestra acotada (`sampleRows`, por defecto 200.000).
- Credenciales cifradas AES-256-GCM en reposo; jamás se devuelven por la API
  (ni cifradas) ni aparecen en logs; los errores de conexión se sanitizan.
- Datos personales enmascarados desde el worker; nunca salen en artefactos ni informes.
- CSV exportados neutralizan inyección de fórmulas (`=`, `+`, `@`, `-texto`).
- `DELETE /jobs/:id` purga job, artefacto, archivos subidos y exports (borrado verificable).
- Sesión DuckDB efímera por job, destruida con su directorio al terminar o fallar.
