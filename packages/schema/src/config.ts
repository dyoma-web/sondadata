/**
 * Configuración de producto. El nombre es un parámetro único aquí:
 * el resto del código debe importar PRODUCT y nunca escribir el nombre en duro.
 */
export const PRODUCT = {
  /** Nombre comercial visible en UI e informes. */
  name: 'SondaData',
  /** Identificador técnico (paquetes, rutas, artefactos). */
  slug: 'sondadata',
  /** Versión del contrato AnalysisReport que produce este código. */
  schemaVersion: '1.0.0',
  /** Versión del motor de análisis; se registra en cada artefacto. */
  engineVersion: '0.1.0',
  /** Idioma por defecto de la UI y los informes. */
  defaultLocale: 'es',
} as const;
