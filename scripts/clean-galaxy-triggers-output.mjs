import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = resolve(repositoryRoot, 'starcraft2', 'dist')
const generatedPathsWithoutSources = [
  'lib/mk2/codecs/galaxy',
  'lib/mk2/codecs/sc2-triggers',
  'src/lib/mk2/codecs/galaxy',
  'src/lib/mk2/codecs/sc2-triggers',
  'modules/galaxy/codecs/galaxy/legacy',
  'modules/triggers/codecs/triggers/legacy',
  'modules/galaxy/language/legacy-host',
  'modules/galaxy/language/legacy-entry.js',
  'modules/galaxy/language/legacy-entry.js.map',
  'modules/galaxy/language/legacy-entry.d.ts',
  'modules/galaxy/language/legacy-entry.d.ts.map',
]

await Promise.all(
  generatedPathsWithoutSources.map(path => rm(resolve(distRoot, path), { recursive: true, force: true })),
)
