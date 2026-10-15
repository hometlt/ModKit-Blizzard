import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sc2Style from '../starcraft2/modules/style/codecs/style/src/define.ts'
import * as sc2Cutscene from '../starcraft2/modules/cutscene/codecs/cutscene/src/define.ts'
import * as sc2Wizard from '../starcraft2/modules/wizard/codecs/wizard/src/define.ts'
import * as blp from '../blizzard-common-formats/codecs/blp/src/define.ts'
import * as mpq from '../mpq/codecs/container-mpq/src/define.ts'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const definitions = [
  ['starcraft2/modules/style/codecs/style/codec.json', sc2Style],
  ['starcraft2/modules/cutscene/codecs/cutscene/codec.json', sc2Cutscene],
  ['starcraft2/modules/wizard/codecs/wizard/codec.json', sc2Wizard],
  ['blizzard-common-formats/codecs/blp/codec.json', blp],
  ['mpq/codecs/container-mpq/codec.json', mpq],
]
for (const [path, authored] of definitions) {
  const outputPath = resolve(root, path)
  const manifest = {
    schemaVersion: 1, contract: { id: 'modkit/codec-contribution', major: 1 }, id: authored.codec.id,
    displayName: authored.displayName, status: authored.status,
    runtimeVariants: authored.codec.runtimeVariants, limitations: authored.limitations,
    spec: { ...authored.codec.contribution, ...(authored.specExtensions ?? {}) },
  }
  const output = `${JSON.stringify(manifest, null, 2)}\n`
  if (process.argv.includes('--check')) {
    const current = await readFile(outputPath, 'utf8').catch(() => '')
    if (current !== output) { console.error(`${outputPath}: generated contribution is stale`); process.exitCode = 1 }
  } else {
    await writeFile(outputPath, output)
  }
}
