import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { executeJoin } from '../src/index.js';
import { sanitizeDbError } from '../src/stages/ingest-db.js';

const dir = mkdtempSync(join(tmpdir(), 'sondadata-f6-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('F6 · endurecimiento', () => {
  it('neutraliza la inyección de fórmulas en los CSV exportados', async () => {
    // celdas maliciosas típicas de un ataque de fórmula
    writeFileSync(
      join(dir, 'malicioso.csv'),
      'id,nota,monto\n1,"=cmd|/c calc",100\n2,"+SUM(A1:A9)",-50\n3,"@algo",20\n4,"texto normal",30\n5,"-5",40\n',
      'utf8',
    );
    writeFileSync(join(dir, 'cat.csv'), 'id,nombre\n1,Uno\n2,Dos\n3,Tres\n4,Cuatro\n5,Cinco\n', 'utf8');

    const out = join(dir, 'salida.csv');
    // ids deterministas: src_<base>_<hash>; los calculamos igual que la ingesta
    const { createHash } = await import('node:crypto');
    const tid = (f: string) => `src_${f.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_')}_${createHash('sha1').update(f).digest('hex').slice(0, 6)}`;

    await executeJoin({
      jobId: 'f6',
      inputDir: dir,
      leftSourceId: tid('malicioso.csv'),
      rightSourceId: tid('cat.csv'),
      leftColumn: 'id',
      rightColumn: 'id',
      chain: 'exact',
      outputPath: out,
    });
    const csv = readFileSync(out, 'utf8');
    // las fórmulas quedan prefijadas con apóstrofo
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'+SUM");
    expect(csv).toContain("'@algo");
    // el texto normal y los números negativos NO se tocan
    expect(csv).toContain('texto normal');
    expect(csv).toContain('-50');
    expect(csv).not.toContain("'-5");
  });

  it('los errores de conexión nunca exponen credenciales', () => {
    const conn = {
      engine: 'postgresql' as const,
      host: 'db.interna.example',
      port: 5432,
      database: 'prod',
      user: 'usuario_ro',
      password: 'SuperSecreta123',
      schemaName: null,
      sampleRows: 1000,
    };
    const raw = `connection to server at "db.interna.example" failed: password authentication failed for user "usuario_ro" (password: SuperSecreta123)`;
    const clean = sanitizeDbError(raw, conn);
    expect(clean).not.toContain('SuperSecreta123');
    expect(clean).not.toContain('usuario_ro');
    expect(clean).not.toContain('db.interna.example');
  });
});
