#!/usr/bin/env node
/**
 * Produces the self-contained Blizzard runtime artifact from built extension roots and their
 * declared production dependencies. Root selection comes from modkit.repository.json, the single
 * repository inventory. Keeps native Node exports alongside portable codec variants,
 * materializes dependencies and licenses, excludes developer inputs, and publishes atomically.
 * Package files selections govern payloads; a package without a files list also ships its compiled
 * dist tree. CLI activation follows the physical script identity through repository links.
 * ESM scripts may be minified; CommonJS code retains its published bytes and export topology.
 * Package scope and file suffix determine this policy, including nested package boundaries.
 * Rewriting CommonJS identifiers breaks native ESM named imports.
 * A package named in `tracedPackages` ships only the files its importers reach: the root's other
 * files name it by specifier, its `exports` map resolves them, and its own static relative imports
 * close the set (three: the camera, renderer and post-processing modules, not its sources, fonts and
 * every example). Its published exports and legacy entrypoints retain only shipped targets.
 * An unresolvable specifier fails the bundle rather than dropping a file.
 * This producer does not compile sources, validate gameplay or sign a release.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = join(repositoryRoot, 'artifacts', 'blizzard-portable.bundle.json')
const extensionRoots = Object.freeze(
  JSON.parse(readFileSync(join(repositoryRoot, 'modkit.repository.json'), 'utf8')).extensions
    .map(({ id, path }) => Object.freeze({ id, directory: path })),
)
const sharedPayloads = Object.freeze(['licenses', 'subjects'])
/** ESM packages whose payload is the import closure their importers reach (see the header). */
const tracedPackages = Object.freeze(['three'])
const SCRIPT = /\.(?:m?js|cjs)$/u
/** `from 'x'`, `import 'x'`, `import('x')`, `require('x')`, `export … from 'x'` with a literal. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)["']([^"'\n]+)["']/gu
const KEPT_PACKAGE_FILES = /^(?:package\.json|LICENSE(?:\.[a-z]+)?|README(?:\.md)?)$/iu
const productionGroups = Object.freeze(['dependencies', 'optionalDependencies', 'peerDependencies'])
const ignoredExternalEntries = new Set([
  'node_modules',
  '.git',
  'test',
  'tests',
  '__tests__',
  'benchmark',
  'benchmarks',
  'coverage',
])

function fail(message) {
  throw new Error(`portable bundle: ${message}`)
}

function portablePath(value) {
  return value.split(sep).join('/')
}

function relativePath(root, path) {
  const value = relative(root, path)
  if (value === '' || value.startsWith(`..${sep}`) || value === '..' || isAbsolute(value)) {
    fail(`path escapes package root: ${path}`)
  }
  return portablePath(value)
}

function regularFile(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`expected regular file: ${path}`)
}

function regularDirectory(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`expected regular directory: ${path}`)
}

function readManifest(path) {
  regularFile(path)
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(
      `invalid package manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`invalid manifest: ${path}`)
  if (
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    typeof value.version !== 'string'
  ) {
    fail(`manifest needs name and version: ${path}`)
  }
  return value
}

function packageDirectory(name, fromDirectory) {
  const require = createRequire(join(fromDirectory, 'package.json'))
  try {
    return packageDirectoryFromEntry(require.resolve(`${name}/package.json`))
  } catch (firstError) {
    try {
      return packageDirectoryFromEntry(require.resolve(name))
    } catch {
      for (let current = resolve(fromDirectory); ; current = dirname(current)) {
        const candidate = join(current, 'node_modules', ...name.split('/'))
        if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
        const parent = dirname(current)
        if (parent === current) break
      }
      fail(`cannot resolve ${name} from ${fromDirectory}: ${firstError.message}`)
    }
  }
}

function packageDirectoryFromEntry(entry) {
  for (let current = dirname(entry); ; current = dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return realpathSync(current)
    const parent = dirname(current)
    if (parent === current) fail(`package.json not found for resolved entry ${entry}`)
  }
}

function productionDependencies(manifest) {
  const names = new Set()
  for (const group of productionGroups) {
    for (const name of Object.keys(manifest[group] ?? {})) names.add(name)
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

function sourceIsWorkspace(path) {
  const candidate = resolve(path)
  const location = relative(repositoryRoot, candidate)
  if (
    location !== '' &&
    (location.startsWith(`..${sep}`) || location === '..' || isAbsolute(location))
  ) {
    return false
  }
  // pnpm keeps physical third-party packages under repositoryRoot/node_modules. Those packages
  // must be copied as published runtime trees, not trimmed with the authored-workspace whitelist.
  return !location.split(sep).includes('node_modules')
}

async function dependencyClosure(rootDirectory) {
  const packages = new Map()
  async function visit(name, fromDirectory) {
    const directory = packageDirectory(name, fromDirectory)
    const manifest = readManifest(join(directory, 'package.json'))
    if (manifest.name !== name) fail(`resolved ${name} as ${manifest.name}`)
    const prior = packages.get(name)
    if (prior !== undefined) {
      if (prior.directory !== directory || prior.manifest.version !== manifest.version) {
        fail(`dependency conflict for ${name}: ${prior.directory} vs ${directory}`)
      }
      return
    }
    const descriptor = Object.freeze({
      directory,
      manifest,
      workspace: sourceIsWorkspace(directory),
    })
    packages.set(name, descriptor)
    for (const child of productionDependencies(manifest)) await visit(child, directory)
  }
  const rootManifest = readManifest(join(rootDirectory, 'package.json'))
  for (const dependency of productionDependencies(rootManifest))
    await visit(dependency, rootDirectory)
  return packages
}

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map(key => [key, sortedJson(value[key])]),
  )
}

function portableManifest(manifest, closure) {
  const output = { ...manifest }
  delete output.devDependencies
  delete output.scripts
  if (typeof output.license === 'string' && /\.{2}[\\/]licenses[\\/]/u.test(output.license)) {
    // The portable artifact places the repository license payload beside every extension root.
    // Preserve the declared license while removing a checkout-relative pointer.
    output.license = 'SEE LICENSE IN licenses/README.md'
  }
  for (const group of productionGroups) {
    if (output[group] === undefined) continue
    output[group] = Object.fromEntries(
      Object.keys(output[group])
        .sort((left, right) => left.localeCompare(right))
        .map(name => {
          const dependency = closure.get(name)
          if (dependency === undefined) fail(`missing materialized dependency ${name}`)
          return [name, dependency.manifest.version]
        }),
    )
  }
  return Buffer.from(`${JSON.stringify(sortedJson(output))}\n`, 'utf8')
}

function addBytes(files, target, bytes, replace = false) {
  if (
    target === '' ||
    target.startsWith('/') ||
    target.includes('\\') ||
    target.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    fail(`invalid output path ${target}`)
  }
  const prior = files.get(target)
  if (prior !== undefined && !prior.equals(bytes) && !replace)
    fail(`conflicting output file ${target}`)
  files.set(target, bytes)
}

/** Preserve CommonJS bytes; minify only an explicit ESM suffix or an ESM package's .js file. */
function addFile(files, target, source, esmPackage = true) {
  regularFile(source)
  const bytes = readFileSync(source)
  addBytes(
    files,
    target,
    source.endsWith('.mjs') || (esmPackage && source.endsWith('.js'))
      ? Buffer.from(
          transformSync(bytes.toString('utf8'), {
            loader: 'js',
            minify: true,
            keepNames: true,
            legalComments: 'eof',
          }).code,
        )
      : bytes,
  )
}

function targetPath(root, name) {
  const path = [root, name]
    .filter(part => part !== '')
    .flatMap(part => part.replaceAll('\\', '/').split('/'))
    .filter(part => part !== '')
  if (path.length === 0 || path.some(part => part === '.' || part === '..')) {
    fail(`invalid output path ${root}/${name}`)
  }
  return path.join('/')
}

/** Walk a selected tree using Node's nearest package scope for CommonJS/ESM preservation. */
function addTree(files, sourceRoot, targetRoot, filter = () => true, esmPackage = true) {
  regularDirectory(sourceRoot)
  const entries = readdirSync(sourceRoot, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  if (entries.some(entry => entry.name === 'package.json' && entry.isFile())) {
    const packagePath = join(sourceRoot, 'package.json')
    regularFile(packagePath)
    esmPackage = JSON.parse(readFileSync(packagePath, 'utf8')).type === 'module'
  }
  for (const entry of entries) {
    // Portable roots execute compiled JavaScript, like the VSIX production closure.
    // Source, declarations, maps and test trees are development inputs, not runtime payloads.
    if (
      (targetRoot === 'dist' && entry.isDirectory() && entry.name === 'dist') ||
      (entry.isDirectory() && ignoredExternalEntries.has(entry.name)) ||
      (entry.isFile() &&
        (/\.(?:ts|mts|cts)$/u.test(entry.name) ||
          entry.name.endsWith('.map') ||
          entry.name.endsWith('.tsbuildinfo')))
    )
      continue
    if (!filter(entry.name)) continue
    const source = join(sourceRoot, entry.name)
    const target = targetPath(targetRoot, entry.name)
    if (entry.isSymbolicLink()) fail(`symbolic links are not portable: ${source}`)
    if (entry.isDirectory()) addTree(files, source, target, filter, esmPackage)
    else if (entry.isFile()) addFile(files, target, source, esmPackage)
    else fail(`unsupported filesystem entry: ${source}`)
  }
}

/** Include the manifest-selected authored subtree beneath its canonical runtime path. */
function addSelection(files, sourceRoot, targetRoot, selection, esmPackage = true) {
  const source = join(sourceRoot, selection)
  if (!existsSync(source)) return
  const target = targetPath(targetRoot, selection)
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) fail(`symbolic links are not portable: ${source}`)
  if (stat.isDirectory()) addTree(files, source, target, undefined, esmPackage)
  else if (stat.isFile()) addFile(files, target, source, esmPackage)
  else fail(`unsupported filesystem entry: ${source}`)
}

/** Materialize a declared closure with its package scope and native runtime module exports. */
function addPackage(files, descriptor, targetRoot, closure, rootPackage = false) {
  const manifest = descriptor.manifest
  const esmPackage = manifest.type === 'module'
  if (descriptor.workspace || rootPackage) {
    const selected = Array.isArray(manifest.files)
      ? ['package.json', ...manifest.files]
      : ['package.json', 'assets', 'contributions', 'data', 'dist', 'src', 'README.md']
    for (const value of [...new Set(selected)].sort((left, right) => left.localeCompare(right))) {
      addSelection(files, descriptor.directory, targetRoot, value, esmPackage)
    }
  } else {
    addTree(
      files,
      descriptor.directory,
      targetRoot,
      name => !ignoredExternalEntries.has(name),
      esmPackage,
    )
  }
  addBytes(files, targetPath(targetRoot, 'package.json'), portableManifest(manifest, closure), true)
}

/** The `exports` target of one subpath of a package (`.`, `./webgpu`, `./addons/x.js`). */
function exportTargets(manifest, subpath) {
  const exports = manifest.exports
  const targets = value =>
    typeof value === 'string'
      ? [value]
      : value !== null && typeof value === 'object'
        ? Object.values(value).flatMap(targets)
        : []
  if (exports === undefined) return subpath === '.' ? [manifest.module ?? manifest.main ?? 'index.js'] : [subpath]
  if (typeof exports === 'string' || Array.isArray(exports)) return subpath === '.' ? targets(exports) : []
  if (exports[subpath] !== undefined) return targets(exports[subpath])
  for (const [pattern, value] of Object.entries(exports)) {
    const star = pattern.indexOf('*')
    if (star < 0) continue
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
    const middle = subpath.slice(prefix.length, subpath.length - suffix.length)
    return targets(value).map(target => target.replaceAll('*', middle))
  }
  return []
}

/** Prune traced-package entrypoints after tracing; keep conditions, blockers and reachable wildcard targets. */
function tracedManifest(files, prefix) {
  const path = `${prefix}package.json`
  const manifest = JSON.parse(files.get(path).toString('utf8'))
  const shippedFiles = [...files.keys()].filter(file => file.startsWith(prefix))
  const shipped = target => {
    if (!target.startsWith('./')) fail(`non-local traced export: ${target}`)
    const expression = `${prefix}${target.slice(2)}`.split('*')
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*')
    const matcher = new RegExp(`^${expression}$`, 'u')
    return shippedFiles.some(file => matcher.test(file))
  }
  // Null explicitly blocks a subpath; it is not a missing target or a fallback to package internals.
  const prune = value => {
    if (value === null) return null
    if (typeof value === 'string') return shipped(value) ? value : undefined
    if (Array.isArray(value)) {
      const kept = value.map(prune).filter(target => target !== undefined)
      return kept.length === 0 ? undefined : kept
    }
    if (value !== undefined && typeof value === 'object') {
      const kept = Object.entries(value).map(([key, target]) => [key, prune(target)])
        .filter(([, target]) => target !== undefined)
      return kept.length === 0 ? undefined : Object.fromEntries(kept)
    }
    return undefined
  }
  if (manifest.exports !== undefined) manifest.exports = prune(manifest.exports) ?? {}
  for (const key of ['main', 'module', 'types', 'typings']) {
    const target = manifest[key]
    if (typeof target === 'string' && !shipped(`./${target.replace(/^\.\//u, '')}`)) delete manifest[key]
  }
  files.set(path, Buffer.from(`${JSON.stringify(sortedJson(manifest))}\n`, 'utf8'))
}

/** Keep only traced packages' reachable files and publish metadata consistent with that payload. */
export function traceDependencies(files, closure) {
  for (const name of tracedPackages) {
    const descriptor = closure.get(name)
    if (descriptor === undefined) continue
    const prefix = `node_modules/${name}/`
    const own = path => path.startsWith(prefix)
    const reached = new Set()
    const pending = []
    const reach = (path, from) => {
      if (!files.has(path)) fail(`${from} imports ${path}, which ${name} does not ship`)
      if (reached.has(path)) return
      reached.add(path)
      pending.push(path)
    }
    const fromPackage = (specifier, from) => {
      if (specifier !== name && !specifier.startsWith(`${name}/`)) return
      const subpath = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`
      const targets = exportTargets(descriptor.manifest, subpath)
      if (targets.length === 0) fail(`${from} imports ${specifier}, which ${name} does not export`)
      for (const target of targets) reach(`${prefix}${target.replace(/^\.\//u, '')}`, from)
    }
    for (const [path, bytes] of files) {
      if (own(path) || !SCRIPT.test(path)) continue
      for (const match of bytes.toString('utf8').matchAll(SPECIFIER)) fromPackage(match[1], path)
    }
    while (pending.length > 0) {
      const path = pending.pop()
      if (!SCRIPT.test(path)) continue
      for (const match of files.get(path).toString('utf8').matchAll(SPECIFIER)) {
        const specifier = match[1]
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          reach(portablePath(join(dirname(path), specifier)), path)
        } else fromPackage(specifier, path)
      }
    }
    for (const path of [...files.keys()]) {
      if (own(path) && !reached.has(path) && !KEPT_PACKAGE_FILES.test(path.slice(prefix.length)))
        files.delete(path)
    }
    tracedManifest(files, prefix)
  }
}

function extensionEntry(id, directory) {
  const rootDirectory = join(repositoryRoot, directory)
  regularDirectory(rootDirectory)
  const manifest = readManifest(join(rootDirectory, 'package.json'))
  if (`${manifest.modkit?.publisher}/${manifest.modkit?.id}` !== id) {
    fail(`${directory} does not declare ${id}`)
  }
  return { id, rootDirectory, manifest }
}

export async function portableBundleBytes() {
  const entries = []
  for (const definition of extensionRoots) {
    const entry = extensionEntry(definition.id, definition.directory)
    const closure = await dependencyClosure(entry.rootDirectory)
    const files = new Map()
    addPackage(
      files,
      { directory: entry.rootDirectory, manifest: entry.manifest, workspace: true },
      '',
      closure,
      true,
    )
    for (const payload of sharedPayloads) addSelection(files, repositoryRoot, '', payload)
    for (const [name, descriptor] of [...closure.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      addPackage(files, descriptor, `node_modules/${name}`, closure)
    }
    traceDependencies(files, closure)
    entries.push(
      Object.freeze({
        id: entry.id,
        files: Object.fromEntries(
          [...files.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([path, bytes]) => [path, bytes.toString('base64')]),
        ),
      }),
    )
  }
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, extensions: entries })}\n`, 'utf8')
}

async function main() {
  const index = process.argv.indexOf('--out')
  const out = index < 0 ? outputPath : resolve(process.argv[index + 1] ?? '')
  if (index >= 0 && process.argv[index + 1] === undefined) fail('--out requires a path')
  if (existsSync(out)) fail(`refusing to overwrite existing artifact: ${out}`)
  const bytes = await portableBundleBytes()
  await mkdir(dirname(out), { recursive: true })
  if (existsSync(out)) fail(`refusing to overwrite existing artifact: ${out}`)
  const stage = join(dirname(out), `.${basename(out)}.stage-${randomUUID()}`)
  try {
    await writeFile(stage, bytes, { flag: 'wx' })
    if (existsSync(out)) fail(`refusing to overwrite existing artifact: ${out}`)
    await rename(stage, out)
  } finally {
    await rm(stage, { force: true })
  }
  process.stdout.write(
    `portable bundle: ${out}\nsha256:${createHash('sha256').update(bytes).digest('hex')} ${bytes.byteLength} bytes ${extensionRoots.length} roots\n`,
  )
}

// Acceptance worktrees may be reached through a junction; compare the same physical entrypoint.
if (
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main()
}
