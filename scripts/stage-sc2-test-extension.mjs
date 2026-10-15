/** Freeze only the SC2 extension for host/VSIX acceptance during concurrent source edits. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const source = join(repository, 'starcraft2')
const ignored = new Set(['node_modules', '.git', 'artifacts'])
const maxFiles = 20_000
const maxBytes = 2 * 1024 ** 3

function inventory() {
  const files = []
  let bytes = 0
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (ignored.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        if (!entry.isFile()) throw new Error(`Snapshot refuses a non-regular artifact file: ${path}`)
        const info = statSync(path, { bigint: true })
        bytes += Number(info.size)
        files.push({ path: relative(source, path).replaceAll('\\', '/'), size: Number(info.size), modified: String(info.mtimeNs) })
        if (files.length > maxFiles || bytes > maxBytes) throw new RangeError('SC2 snapshot exceeds its 20,000-file / 2 GiB limit')
      }
    }
  }
  walk(source)
  return { files, bytes }
}

const before = inventory()
const artifactParent = join(repository, 'artifacts', 'sc2-acceptance')
mkdirSync(artifactParent, { recursive: true })
const run = mkdtempSync(join(artifactParent, 'run-'))
const extensionRoot = join(run, 'starcraft2')
const hash = createHash('sha256')
const fileDigests = {}
for (const file of before.files) {
  const contents = readFileSync(join(source, file.path))
  const output = join(extensionRoot, file.path)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, contents)
  const path = Buffer.from(file.path)
  hash.update(String(path.byteLength)).update(Buffer.from([0])).update(path).update(Buffer.from([0]))
  hash.update(String(contents.byteLength)).update(Buffer.from([0])).update(contents)
  fileDigests[file.path] = `sha256:${createHash('sha256').update(contents).digest('hex')}`
}
const after = inventory()
if (JSON.stringify(before) !== JSON.stringify(after)) {
  throw new Error(`SC2 sources changed while copying; incomplete snapshot at ${run}. Run the command again.`)
}
// Dependencies remain external to the artifact, just as in a normal installed workspace.
symlinkSync(join(source, 'node_modules'), join(extensionRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
const receipt = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  source,
  extensionRoot,
  files: before.files.length,
  bytes: before.bytes,
  artifactDigest: `sha256:${hash.digest('hex')}`,
  dependencyRoot: join(source, 'node_modules'),
  fileDigests,
}
writeFileSync(join(run, 'snapshot.json'), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify({ ...receipt, fileDigests: undefined, receipt: join(run, 'snapshot.json') }, null, 2))
