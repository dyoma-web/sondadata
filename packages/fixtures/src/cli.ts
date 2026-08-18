import { join } from 'node:path';
import { generateFixtures } from './index.js';

const outDir = process.argv[2] ?? join(import.meta.dirname, '..', 'data');
const manifest = await generateFixtures(outDir);
console.log(`Fixtures generados en ${outDir}:`);
for (const f of manifest.files) console.log(`  - ${f}`);
console.log(`Defectos plantados: ${manifest.plantedDefects.length} (ver expected.json)`);
