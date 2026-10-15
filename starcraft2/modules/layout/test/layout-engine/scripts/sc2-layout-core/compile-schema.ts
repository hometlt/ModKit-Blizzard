// Serializes the SC2Layout XML schema (sc2layout/) into a single JSON artifact
// consumed as an ESM module via the `@modkitx/layout-lang/bundled-schema` exports
// subpath. Gitignored build output. Run via tsx (see the package "build" script).
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { readSchemaDataDir } from '../../../../shared/layout-engine/sc2-layout-core/schema/registry-node.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaDir = path.join(pkgRoot, 'sc2layout');
const outFile = path.join(pkgRoot, 'generated', 'sc2layout-schema-data.json');

if (process.argv.includes('--skip-if-exists') && fs.existsSync(outFile)) {
    process.exit(0);
}

const sData = await readSchemaDataDir(schemaDir, { includeLocalization: true });
await fsp.mkdir(path.dirname(outFile), { recursive: true });
await fsp.writeFile(outFile, JSON.stringify(sData), 'utf8');
console.log(`[layout-lang] wrote ${outFile} (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`);
