import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * Cifrado de credenciales en reposo: AES-256-GCM con clave maestra en variable
 * de entorno (SONDADATA_SECRET_KEY, 32 bytes en hex o cualquier passphrase que
 * se deriva por SHA-256). Nunca se guarda en claro, nunca se registra en logs.
 *
 * Sin clave configurada se genera una efímera por proceso: útil en desarrollo,
 * pero los jobs con conexión no sobreviven un reinicio (se advierte al arrancar).
 */

let cachedKey: Buffer | null = null;
export let ephemeralKey = false;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.SONDADATA_SECRET_KEY;
  if (env && /^[0-9a-fA-F]{64}$/.test(env)) {
    cachedKey = Buffer.from(env, 'hex');
  } else if (env && env.length >= 16) {
    cachedKey = createHash('sha256').update(env).digest();
  } else {
    cachedKey = randomBytes(32);
    ephemeralKey = true;
  }
  return cachedKey;
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptJson<T>(payload: string): T {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as T;
}
