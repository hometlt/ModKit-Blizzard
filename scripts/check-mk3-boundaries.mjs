import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { contributionInventory } from './check-module-map.mjs'

const baselinePath = 'architecture/mk3-legacy-imports.json'
const excludedDirectories = new Set(['test', 'tests', '__tests__', 'scripts', 'dist', 'node_modules', 'artifacts'])
const slash = path => path.replaceAll('\\', '/')
const key = entry => JSON.stringify([entry.file, entry.specifier, entry.kind])

export function isProductionSource(path) {
  return /\.[cm]?[jt]sx?$/.test(path)
    && !/\.(?:test|spec|config)\.[cm]?[jt]sx?$/.test(path)
    && !slash(path).split('/').some(segment => excludedDirectories.has(segment))
}

async function sources(directory) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return (await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return excludedDirectories.has(entry.name) ? [] : sources(path)
    return entry.isFile() && isProductionSource(path) ? [path] : []
  }))).flat().sort()
}

function staticString(node, checker, seen = new Set()) {
  if (!node || seen.has(node)) return undefined
  seen.add(node)
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return staticString(node.expression, checker, seen)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left, checker, new Set(seen))
    const right = staticString(node.right, checker, new Set(seen))
    return left === undefined || right === undefined ? undefined : left + right
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text
    for (const span of node.templateSpans) {
      const value = staticString(span.expression, checker, new Set(seen))
      if (value === undefined) return undefined
      result += value + span.literal.text
    }
    return result
  }
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration
    if (declaration && ts.isVariableDeclaration(declaration)
      && ts.isVariableDeclarationList(declaration.parent)
      && declaration.parent.flags & ts.NodeFlags.Const) {
      return staticString(declaration.initializer, checker, seen)
    }
  }
  return undefined
}

export function legacyTarget(file, specifier) {
  const target = specifier.startsWith('.') ? posix.join(posix.dirname(file), slash(specifier)) : posix.normalize(slash(specifier))
  return /(?:^|\/)src\/lib\/mk2(?:\/|$)/.test(target)
    || /^@modkit\/codec-kit\/legacy(?:\/|$)/.test(target)
}

export async function legacyImportInventory(repositoryRoot) {
  const repository = JSON.parse(await readFile(join(repositoryRoot, 'modkit.repository.json'), 'utf8'))
  const paths = (await Promise.all(repository.extensions.flatMap(extension => ['modules', 'shared']
    .map(directory => sources(join(repositoryRoot, extension.path, directory)))))).flat()
  const program = ts.createProgram(paths, { allowJs: true, noResolve: true, noLib: true, noEmit: true })
  const checker = program.getTypeChecker()
  const records = new Map()
  const dynamicImports = []
  const errors = []
  for (const path of paths) {
    const source = program.getSourceFile(path)
    const file = slash(relative(repositoryRoot, path))
    for (const diagnostic of program.getSyntacticDiagnostics(source)) errors.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
    function record(node, kind) {
      const specifier = staticString(node, checker)
      if (specifier === undefined) {
        dynamicImports.push({ file, kind, expression: node.getText(source), sha256: createHash('sha256').update(source.text.replaceAll('\r\n', '\n')).digest('hex') })
        return
      }
      if (!legacyTarget(file, specifier)) return
      const entry = { file, specifier, kind, count: 1 }
      const previous = records.get(key(entry))
      if (previous) previous.count += 1
      else records.set(key(entry), entry)
    }
    function visit(node) {
      if (ts.isImportDeclaration(node)) record(node.moduleSpecifier, node.importClause?.isTypeOnly ? 'import-type' : 'import')
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier) record(node.moduleSpecifier, node.isTypeOnly ? 'export-type' : 'export')
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) record(node.moduleReference.expression, 'import-equals')
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) record(node.argument.literal, 'type-query')
      else if (ts.isCallExpression(node)) {
        const callee = node.expression
        const kind = callee.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import'
          : ts.isIdentifier(callee) && callee.text === 'require' ? 'require'
            : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
              && callee.expression.text === 'require' && callee.name.text === 'resolve' ? 'require-resolve' : undefined
        if (kind && node.arguments[0]) record(node.arguments[0], kind)
      }
      ts.forEachChild(node, visit)
      // Type imports in JavaScript JSDoc are real dependencies; ordinary comments are not.
      for (const doc of node.jsDoc ?? []) ts.forEachChild(doc, visit)
    }
    visit(source)
  }
  return { imports: [...records.values()].sort((a, b) => key(a).localeCompare(key(b))), dynamicImports, errors, scannedFiles: paths.length }
}

export function checkDynamicImports(imports, reviewed = []) {
  const errors = []
  const identity = entry => JSON.stringify([entry.file, entry.kind, entry.expression, entry.sha256])
  const remaining = [...reviewed]
  for (const entry of imports) {
    const index = remaining.findIndex(previous => identity(previous) === identity(entry) && previous.owner?.trim() && previous.reason?.trim())
    if (index < 0) errors.push(`${entry.file}: cannot statically resolve ${entry.kind}: ${entry.expression}; requires exact source-hash review`)
    else remaining.splice(index, 1)
  }
  for (const entry of remaining) errors.push(`${entry.file}: stale or invalid computed-import review; remove or review the changed source`)
  return errors
}

export function checkLegacyBaseline(imports, baseline) {
  const errors = []
  if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.imports)) return [`${baselinePath}: expected schemaVersion 1 and exact imports array`]
  const expected = new Map()
  for (const entry of baseline.imports) {
    if (typeof entry.file !== 'string' || entry.file !== posix.normalize(entry.file) || entry.file.includes('\\')
      || entry.file.startsWith('/') || entry.file.split('/').includes('..') || /[*?]/.test(entry.file)
      || typeof entry.specifier !== 'string' || !legacyTarget(entry.file, entry.specifier)
      || !['import', 'import-type', 'export', 'export-type', 'import-equals', 'type-query', 'dynamic-import', 'require', 'require-resolve'].includes(entry.kind)
      || !Number.isInteger(entry.count) || entry.count < 1
      || typeof entry.owner !== 'string' || !entry.owner.trim()
      || typeof entry.replacement !== 'string' || !entry.replacement.trim()) {
      errors.push(`${baselinePath}: invalid exact baseline entry ${JSON.stringify(entry)}`)
      continue
    }
    if (expected.has(key(entry))) errors.push(`${baselinePath}: duplicate entry ${key(entry)}`)
    expected.set(key(entry), entry)
  }
  for (const entry of imports) {
    const previous = expected.get(key(entry))
    if (!previous) errors.push(`${entry.file}: new legacy ${entry.kind} ${entry.specifier}; use the MK3 owner`)
    else if (previous.count !== entry.count) errors.push(`${entry.file}: legacy ${entry.kind} ${entry.specifier} count ${previous.count} -> ${entry.count}; ${entry.count < previous.count ? 'shrink the reviewed baseline' : 'new legacy imports are forbidden'}`)
    expected.delete(key(entry))
  }
  for (const entry of expected.values()) errors.push(`${entry.file}: removed legacy ${entry.kind} ${entry.specifier}; remove its stale baseline entry`)
  return errors
}

export async function completionReport(repositoryRoot, inventory) {
  const { contributions, errors } = await contributionInventory(repositoryRoot)
  if (errors.length) throw new Error(errors.join('\n'))
  const manifests = await Promise.all(contributions.map(async entry => ({ ...entry, manifest: JSON.parse(await readFile(join(repositoryRoot, entry.sourceManifest), 'utf8')) })))
  const counts = {}
  for (const { manifest } of manifests) counts[manifest.status ?? 'unspecified'] = (counts[manifest.status ?? 'unspecified'] ?? 0) + 1
  const lines = ['# MK3 completion evidence', '', `Scanned ${inventory.scannedFiles} production files in registered extension modules/ and shared/.`,
    `Remaining direct legacy dependencies: ${inventory.imports.length} exact file/specifier/kind records, ${inventory.imports.reduce((sum, entry) => sum + entry.count, 0)} occurrences.`,
    'This baseline prevents growth; it does not prove zero legacy, transitive dependency closure, package cleanliness, or functional acceptance.',
    'Scope excludes test/tests/__tests__, scripts, dist, artifacts, node_modules, and *.test/spec/config sources. It does not resolve tsconfig aliases or package exports.', '',
    `Computed imports requiring an exact source-hash review: ${inventory.dynamicImports.length}.`, '',
    ...inventory.dynamicImports.map(entry => `- ${entry.file}: ${entry.expression}`), '',
    '## Legacy imports', '', '| File | Kind | Specifier | Count |', '| --- | --- | --- | ---: |',
    ...inventory.imports.map(entry => `| ${entry.file} | ${entry.kind} | ${entry.specifier} | ${entry.count} |`), '',
    '## Registered codec/provider capability status', '', JSON.stringify(counts), '',
    'Status and limitations below are author declarations, not independent acceptance results.', '']
  for (const { id, sourceManifest, manifest } of manifests.filter(entry => entry.manifest.status !== 'supported')) {
    lines.push(`### ${id} — ${manifest.status ?? 'unspecified'}`, '', `Source: ${sourceManifest}`, '')
    const limitations = manifest.limitations ?? []
    lines.push(...(limitations.length ? limitations.map(item => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`) : ['- No explicit limitations declared; owner review required.']), '')
  }
  return lines.join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
  const inventory = await legacyImportInventory(root)
  const baseline = JSON.parse(await readFile(join(root, baselinePath), 'utf8'))
  const errors = [...inventory.errors, ...checkLegacyBaseline(inventory.imports, baseline), ...checkDynamicImports(inventory.dynamicImports, baseline.reviewedDynamicImports)]
  if (process.argv.includes('--report')) console.log(await completionReport(root, inventory))
  for (const error of errors) console.error(error)
  if (errors.length) process.exitCode = 1
  else if (!process.argv.includes('--report')) console.log(`MK3 boundary ratchet: valid; ${inventory.imports.length} legacy records remain across ${inventory.scannedFiles} production files (migration incomplete)`)
}
