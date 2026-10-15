import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(repository, 'blizzard-common-formats/tools/s2protocol/source-data')
const target = resolve(repository, 'blizzard-common-formats/modules/s2protocol/protocols/data')
const provenancePath = resolve(repository, 'blizzard-common-formats/modules/s2protocol/PROVENANCE.json')
const buildsPath = resolve(repository, 'blizzard-common-formats/modules/s2protocol/protocols/builds.js')
const check = process.argv.includes('--check')
const digest = text => createHash('sha256').update(text).digest('hex')

const names = (await readdir(source)).filter(name => /^protocol\d+\.ts$/u.test(name)).sort((a, b) => Number(a.slice(8, -3)) - Number(b.slice(8, -3)))
if (names.length === 0) throw new Error('No pinned s2protocol table inputs found')
await mkdir(target, { recursive: true })
const files = {}
const builds = []
for (const name of names) {
  builds.push(Number(name.slice(8, -3)))
  const input = await readFile(join(source, name), 'utf8')
  const match = /^export default ([\s\S]+?)\s*$/u.exec(input)
  if (match === null) throw new Error(`Invalid generated table input: ${name}`)
  const value = JSON.parse(match[1].replace(/\s+as const;?$/u, ''))
  const output = `export default ${JSON.stringify(value)}\n`
  const outputName = name.replace(/\.ts$/u, '.js')
  files[outputName] = digest(output)
  if (check) {
    const actual = await readFile(join(target, outputName), 'utf8')
    if (actual !== output) throw new Error(`Generated s2protocol table is stale: ${outputName}`)
  } else {
    await writeFile(join(target, outputName), output)
  }
}
const buildsOutput = `export const AVAILABLE_BUILDS = Object.freeze(${JSON.stringify(builds)})\n`
files['../builds.js'] = digest(buildsOutput)
if (check) {
  if (await readFile(buildsPath, 'utf8') !== buildsOutput) throw new Error('Generated s2protocol build index is stale')
} else {
  await writeFile(buildsPath, buildsOutput)
}

const provenance = {
  schemaVersion: 1,
  upstream: {
    repository: 'https://github.com/Blizzard/s2protocol',
    commit: 'fbb98e80aee825d6deeabd7b48b51cbecebde062',
    license: 'MIT',
  },
  directUpstreamImports: {
    path: 's2protocol/versions',
    normalization: 'Python literal tuples become arrays; choice label None becomes null',
    files: {
      'protocol97364.py': '88cb44f33f36e5df4349e6e0b71318e40e2978b4435d022d65eb4d573bd0089e',
      'protocol97425.py': '88cb44f33f36e5df4349e6e0b71318e40e2978b4435d022d65eb4d573bd0089e',
      'protocol97563.py': '88cb44f33f36e5df4349e6e0b71318e40e2978b4435d022d65eb4d573bd0089e',
    },
  },
  importedOracle: {
    repository: 'https://github.com/sc2-arcade-watcher/modkit.git',
    commit: '1a14ba4eddd0ae88de273348ebd44cfb98a0581d',
    path: 'extensions/blizzard/starcraft-2/codecs/sc2-replay/src/core/protocols/data',
  },
  generatorInput: {
    path: 'blizzard-common-formats/tools/s2protocol/source-data',
    format: 'TypeScript default exports containing JSON-compatible protocol tables',
  },
  generator: 'scripts/generate-s2protocol-tables.mjs',
  files,
}
const serialized = `${JSON.stringify(provenance, null, 2)}\n`
if (check) {
  const actual = await readFile(provenancePath, 'utf8')
  if (actual !== serialized) throw new Error('s2protocol provenance or hashes are stale')
} else {
  await writeFile(provenancePath, serialized)
}
console.log(`${check ? 'verified' : 'generated'} ${names.length} s2protocol tables`)
