# Guía del evaluador — SondaData en 10 minutos

Esta guía permite evaluar el producto completo en una sesión corta, sin
conocimientos de bases de datos.

## Qué es

SondaData es una herramienta de **diagnóstico de datos de una sola pasada**:
el usuario sube sus fuentes desordenadas (Excel, CSV, JSON, o una base de
datos heredada) y en menos de 10 minutos obtiene:

1. El **modelo real** de sus datos: qué tablas tiene y cómo se relacionan,
   incluidas relaciones que nadie declaró.
2. Un **diagnóstico de calidad** expresado en consecuencias de negocio
   ("312 pagos apuntan a un contrato que no existe"), nunca en jerga técnica.
3. Un **mapa de cruces posibles** con predicción previa: qué obtendría, qué
   se pierde y cuándo un cruce "explota" — antes de ejecutarlo.
4. Las **tablas auxiliares generadas** que resuelven los problemas detectados.
5. Un **informe formal exportable** (PDF/Word) apto para comité directivo,
   con anexo técnico que respalda cada afirmación con su consulta SQL.

**Principio rector:** el motor calcula, todo es verificable. Ninguna cifra
proviene de una IA generativa; toda afirmación de la interfaz es clicable
hasta llegar a su evidencia.

## Cómo probarlo

### Opción A — Sin instalar nada (recomendada)

Pulse el botón **«Open in GitHub Codespaces»** del README (o entre a
[codespaces.new/dyoma-web/sondadata](https://codespaces.new/dyoma-web/sondadata?quickstart=1)).
Con cualquier cuenta gratuita de GitHub se crea un entorno en la nube que
instala y arranca SondaData solo; en unos 2 minutos aparece la vista previa de
la aplicación. Si la vista previa no se abre sola, use la pestaña **Ports** y
haga clic en el puerto **3000**.

Sus archivos se procesan dentro de ese entorno personal y desechable: no pasan
por ningún servidor de terceros.

### Opción B — En su computador

Requisitos: Node 22+ y pnpm (`npm i -g pnpm`).

```bash
git clone https://github.com/dyoma-web/sondadata
cd sondadata
pnpm install
pnpm dev        # levanta la aplicación
```

Abrir **http://localhost:3000** y seguir este recorrido:

1. **Pantalla 1 · Conectar** — pulsar **«Usar datos de ejemplo →»**. Se genera
   un conjunto realista de un programa social con 10 defectos típicos
   plantados (llaves con formatos distintos, municipios escritos de 5 formas,
   registros huérfanos, un Excel con encabezado en la fila 4, datos
   personales…). Observar el progreso narrado en lenguaje llano.
2. **Resultados** — revisar los perfiles: el aviso del "Excel humano", las
   columnas con datos personales enmascaradas, el aviso de fechas mezcladas.
3. **Pantalla 2 · Mapa** — el grafo de fuentes. Hacer clic en una relación
   punteada: el panel muestra POR QUÉ el sistema cree que existe (señales,
   penalizaciones, SQL). Confirmarla o rechazarla. Nótese la relación
   encontrada pese a que una tabla usa la llave «P-0001» y la otra el
   entero «1».
4. **Pantalla 3 · Cruces** — seleccionar Pagos × Proyectos: la predicción
   muestra los 312 registros que quedarían fuera. Seleccionar
   Actividades × Pagos (por fecha): la advertencia de explosión (×17).
   Revisar el catálogo de indicadores con su SQL. Ejecutar un cruce y
   descargar el CSV. Generar una tabla puente tras confirmar su significado.
5. **Informe** — «Ver el informe» abre el documento formal; Ctrl+P lo imprime
   en A4. «Descargar Word» entrega el .docx.

También se puede arrastrar **archivos propios** (xlsx/csv/json) en la
Pantalla 1, o conectar una base PostgreSQL/MySQL en modo solo lectura.

## Qué mirar como evaluador

- **Confianza**: cada hallazgo tiene evidencia SQL visible. ¿Se sostiene?
- **Lenguaje**: la interfaz y el informe no usan jerga de bases de datos.
- **Prudencia**: lo dudoso se presenta como "relación posible", nunca como
  hecho. Un falso positivo visible destruye la credibilidad; el motor pasa
  una "prueba de oro" (reconstruir las llaves de un esquema estándar TPC-H
  con cero falsos positivos de alta confianza) en cada cambio de código (CI).
- **El informe**: ¿lo llevaría usted a un comité?

## Estado y hoja de ruta

MVP completo (6 fases, 63 pruebas automatizadas). Pendiente para versión
comercial: despliegue en la nube con cuentas de usuario, narración opcional
con IA (el sistema funciona íntegramente sin ella), y verticales de demo
adicionales (datos electorales/públicos con diccionario DIVIPOLA).

Documentación de arquitectura y despliegue: [`README.md`](../README.md).
