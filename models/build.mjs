import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'

const root = fileURLToPath(new URL('.', import.meta.url))
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const compile = (config, extra = []) =>
  execFileSync(process.execPath, [tsc, '-p', config, ...extra], { cwd: root, stdio: 'inherit' })
const typecheckOnly = process.argv.includes('--typecheck')

// The M3 format library compiles once, under its relaxed profile, to dist/m3/native. Every
// runtime module and test imports that one copy; authored MK3 code consumes its declarations with
// every strict base flag intact.
compile('tsconfig.native.json')
await mkdir(new URL('dist/m3/', import.meta.url), { recursive: true })
// Both runtime variants consume the exact frozen schema as data; decoding never fetches it or
// reads the filesystem. Regeneration is deterministic and leaves the pinned XML untouched.
const structuresXml = await readFile(
  new URL('src/m3/native/structures.xml', import.meta.url),
  'utf8',
)
const structuresSha256 = createHash('sha256').update(structuresXml).digest('hex')
await writeFile(
  new URL('dist/m3/structures.generated.js', import.meta.url),
  `// Generated from src/m3/native/structures.xml; regenerate with models/build.mjs.\n` +
    `export const M3_STRUCTURES_XML = ${JSON.stringify(structuresXml)}\n` +
    `export const M3_STRUCTURES_SHA256 = '${structuresSha256}'\n`,
)
await writeFile(
  new URL('dist/m3/structures.generated.d.ts', import.meta.url),
  'export declare const M3_STRUCTURES_XML: string\nexport declare const M3_STRUCTURES_SHA256: string\n',
)
compile('tsconfig.m3.json', typecheckOnly ? ['--noEmit'] : [])

if (!typecheckOnly) {
  // A browser host loads verified ESM, not npm/CJS. Package the same adapter and shared scene
  // modules with local ESM chunks so portable activation needs no ambient dependency map.
  const portable = await build({
    absWorkingDir: root,
    entryPoints: [
      'src/m3/codec.js',
      'src/m3/codec-m3a.js',
      'src/m3/writer.js',
      'src/m3/native-encoder.js',
    ],
    outdir: 'dist/browser',
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    alias: {
      crypto: './src/m3/runtime/browser-node-crypto.js',
      'node:crypto': './src/m3/runtime/browser-node-crypto.js',
    },
    metafile: true,
    write: false,
  })
  for (const output of Object.values(portable.metafile.outputs))
    if (output.imports.some(dependency => dependency.external))
      throw new Error('portable M3 output retains an external import')
  const metadataPath = new URL('dist/browser/bundle-metafile.json', import.meta.url)
  const previous = await readFile(metadataPath, 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return { outputs: {} }
    throw error
  })
  for (const output of portable.outputFiles) {
    await mkdir(dirname(output.path), { recursive: true })
    await writeFile(output.path, output.contents)
  }
  // Remove only obsolete generated outputs named by our preceding build, never source files.
  const ownedRoot = resolve(root, 'dist/browser') + sep
  for (const output of Object.keys(previous.outputs)) {
    if (Object.hasOwn(portable.metafile.outputs, output)) continue
    const obsolete = resolve(root, output)
    if (!obsolete.startsWith(ownedRoot) || !obsolete.endsWith('.js'))
      throw new Error(`unexpected portable build output: ${output}`)
    await unlink(obsolete).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  await writeFile(metadataPath, JSON.stringify(portable.metafile, null, 2) + '\n')
}
