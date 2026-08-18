import { describe, expect, it } from 'vitest';
import { decryptJson, encryptJson } from '../src/crypto.js';

describe('F6 · cifrado de credenciales', () => {
  it('cifra y descifra ida y vuelta', () => {
    const conn = { engine: 'mysql', host: 'localhost', port: 3306, user: 'ro', password: 's3cr3t!' };
    const payload = encryptJson(conn);
    expect(payload).not.toContain('s3cr3t');
    expect(payload).not.toContain('localhost');
    expect(decryptJson(payload)).toEqual(conn);
  });

  it('dos cifrados del mismo valor no son iguales (IV aleatorio)', () => {
    const a = encryptJson({ x: 1 });
    const b = encryptJson({ x: 1 });
    expect(a).not.toEqual(b);
  });

  it('un payload manipulado no descifra', () => {
    const payload = encryptJson({ x: 1 });
    const tampered = Buffer.from(payload, 'base64');
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => decryptJson(tampered.toString('base64'))).toThrow();
  });
});
