/* eslint-disable no-console -- diagnostic output is intentional in this test harness. */
/**
 * roundtrip-diff — Multi-mod roundtrip quality regression tests
 *
 * For each testdata mod/map with .galaxy files:
 *   Galaxy → Triggers (bridge-triggers logic, 2-pass)
 *
 * Checks per library after conversion:
 *   - 0 duplicate element IDs
 *   - 0 __InitVariablesRaw FunctionDef elements
 *   - 0 Unknown function references (functionDef.id === callee name, not a hex ID)
 *   - Trigger count matches source Triggers XML
 *   - Variable count matches source Triggers XML (within 10% tolerance)
 *
 * Lives in packages/galaxy (not packages/triggers) so the dependency graph
 * stays one-directional: galaxy already depends on triggers in production
 * (T2G conversion), and this spec exercises the full G2T -> T2G roundtrip.
 * Keeping it here avoids a triggers -> galaxy test-only import that would
 * otherwise create an import cycle flagged by
 * `scripts/verify-dependency-boundaries.ts` rule 3.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join, basename, extname } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readTriggerLibrariesFast,
  parseGalaxySource,
  convertGalaxyToTriggerLibrary,
  resetGalaxyToTriggerIdCounter,
  validateLibraryStructure,
  formatFindings,
  type TriggerLibraryJson,
  type ElementJson,
  type ElementRefJson,
  type FunctionDefJson,
  type FunctionCallJson,
  type VariableJson,
  type TriggerJson,
  type ParamJson,
} from '@modkit/blizzard-starcraft2/triggers/document/index.js'
import { convertTriggerLibraryToGalaxyFull } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/trigger-to-galaxy.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../..')

function readEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined
}

function logMemory(label: string): void {
  if (!readEnv('MX_MEM_LOG')) return
  const mu = process.memoryUsage()
  const mb = (n: number) => Math.round(n / 1024 / 1024)
  console.log(`[mem] ${label}: heap=${mb(mu.heapUsed)}MB rss=${mb(mu.rss)}MB`)
}

// ---------------------------------------------------------------------------
// NativeLib (loaded once for all tests)
// ---------------------------------------------------------------------------

const nativePath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/base.sc2data/TriggerLibs/NativeLib.TriggerLib',
)
const nativeStringsPath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/enus.sc2data/LocalizedData/TriggerStrings.txt',
)
const hasNativeFixture = existsSync(nativePath) && existsSync(nativeStringsPath)
const nativeXml = hasNativeFixture ? readFileSync(nativePath, 'utf8') : ''
const nativeStrings = hasNativeFixture ? readFileSync(nativeStringsPath, 'utf8') : ''

// ---------------------------------------------------------------------------
// Helpers (mirrors bridge-triggers.ts logic)
// ---------------------------------------------------------------------------

interface GalaxyUnit {
  id: string
  scriptPath: string
  headerPath: string
}

function sortGalaxyUnitsByDependencies(units: GalaxyUnit[]): GalaxyUnit[] {
  if (units.length <= 1) return units
  const byId = new Map(units.map(u => [u.id.toUpperCase(), u]))
  const deps = new Map<string, Set<string>>()
  const indegree = new Map<string, number>()

  for (const u of units) {
    const id = u.id.toUpperCase()
    deps.set(id, new Set())
    indegree.set(id, 0)
  }

  for (const u of units) {
    const id = u.id.toUpperCase()
    let code = ''
    try {
      code = readFileSync(u.scriptPath, 'utf8')
    } catch {
      continue
    }
    for (const match of code.matchAll(/include\s+"Lib([A-Za-z0-9]+)_h"/g)) {
      const dep = String(match[1] ?? '').toUpperCase()
      if (!dep || dep === id || !byId.has(dep) || deps.get(id)!.has(dep)) continue
      deps.get(id)!.add(dep)
      indegree.set(id, (indegree.get(id) ?? 0) + 1)
    }
  }

  const originalOrder = units.map(u => u.id.toUpperCase())
  const queue = originalOrder.filter(id => (indegree.get(id) ?? 0) === 0)
  const out: string[] = []

  while (queue.length > 0) {
    const id = queue.shift()!
    out.push(id)
    for (const [node, nodeDeps] of deps) {
      if (!nodeDeps.has(id)) continue
      nodeDeps.delete(id)
      indegree.set(node, (indegree.get(node) ?? 0) - 1)
      if ((indegree.get(node) ?? 0) === 0) queue.push(node)
    }
  }

  if (out.length !== units.length) return units
  return out.map(id => byId.get(id)!).filter(Boolean)
}

function findGalaxyFiles(dir: string): GalaxyUnit[] {
  if (!existsSync(dir)) return []
  const units: GalaxyUnit[] = []
  for (const name of readdirSync(dir)) {
    const m = name.match(/^Lib([A-Za-z0-9]+)\.galaxy$/)
    if (!m) continue
    const id = m[1]
    units.push({ id, scriptPath: join(dir, name), headerPath: join(dir, `Lib${id}_h.galaxy`) })
  }
  return units
}

function findGalaxyDir(modPath: string): string {
  for (const sub of [modPath, join(modPath, 'Base.SC2Data'), join(modPath, 'base.sc2data')]) {
    const units = findGalaxyFiles(sub)
    if (units.length > 0) return sub
  }
  return modPath // MapScript case
}

type CrossLibVars = Map<string, { id: string; library: string }>
type CrossLibFuncDefs = Map<string, { id: string; library: string; parameters?: ElementRefJson[] }>
type ExternalFuncTypes = Map<string, string[]>

function collectCrossLibGlobals(lib: TriggerLibraryJson, libId: string, out: CrossLibVars) {
  const localVarIds = new Set<string>()
  for (const el of Object.values(lib.elements)) {
    if (el.type === 'Trigger')
      for (const r of (el as TriggerJson).localVariables) localVarIds.add(r.id)
    if (el.type === 'FunctionDef')
      for (const r of (el as FunctionDefJson).localVariables ?? []) localVarIds.add(r.id)
  }
  for (const el of Object.values(lib.elements)) {
    if (el.type !== 'Variable' || localVarIds.has(el.id) || !el.name) continue
    const n = el.name
    out.set(`lib${libId}_gv_${n.charAt(0).toLowerCase() + n.slice(1)}`, {
      id: el.id,
      library: libId,
    })
  }
}

function collectExternalFuncParamTypes(
  lib: TriggerLibraryJson,
  libId: string,
  out: ExternalFuncTypes,
) {
  for (const el of Object.values(lib.elements)) {
    if (el.type !== 'FunctionDef') continue
    const fd = el as FunctionDefJson
    if (!fd.name || fd.name.startsWith('__')) continue
    const key = `lib${libId}_gf_${fd.name}`
    const types: string[] = []
    for (const pRef of fd.parameters ?? []) {
      const pd = lib.elements[pRef.id] as any
      types.push(pd?.paramType?.type ?? 'int')
    }
    out.set(key, types)
  }
}

function collectCrossLibFunctionDefs(
  lib: TriggerLibraryJson,
  libId: string,
  out: CrossLibFuncDefs,
) {
  for (const el of Object.values(lib.elements)) {
    if (el.type !== 'FunctionDef') continue
    const fd = el as FunctionDefJson
    if (!fd.name || fd.name.startsWith('__')) continue
    const sanitized = fd.name.replace(/[^a-zA-Z0-9_]/g, '').replace(/^[^a-zA-Z_]+/, '')
    const galaxyName = `lib${libId}_gf_${sanitized || fd.id}`
    if (!out.has(galaxyName)) {
      out.set(galaxyName, {
        id: fd.id,
        library: libId,
        parameters: (fd.parameters ?? []).map(ref => ({ ...ref })),
      })
    }
  }
}

async function convertModGalaxyToLibraries(
  modPath: string,
  nativeLibrary: TriggerLibraryJson,
): Promise<TriggerLibraryJson[]> {
  const galaxyDir = findGalaxyDir(modPath)
  let units = findGalaxyFiles(galaxyDir)

  // MapScript fallback
  if (units.length === 0) {
    const ms = join(modPath, 'MapScript.galaxy')
    if (existsSync(ms)) {
      const stem =
        basename(modPath)
          .replace(/\.sc2map$/i, '')
          .replace(/[^A-Za-z0-9]/g, '')
          .slice(0, 8)
          .toUpperCase() || 'MAP'
      units = [{ id: stem, scriptPath: ms, headerPath: ms.replace(/\.galaxy$/i, '_h.galaxy') }]
    }
  }

  if (units.length === 0) return []
  units = sortGalaxyUnitsByDependencies(units)

  const allCrossLibVars: CrossLibVars = new Map()
  const externalFuncParamTypes: ExternalFuncTypes = new Map()
  const discoveredCrossLibFuncDefs: CrossLibFuncDefs = new Map()

  // Pass 1: collect cross-lib info
  resetGalaxyToTriggerIdCounter()
  logMemory(`pass1:start ${basename(modPath)}`)
  for (const u of units) {
    if (!existsSync(u.scriptPath)) continue
    const script = readFileSync(u.scriptPath, 'utf8')
    const header = existsSync(u.headerPath) ? readFileSync(u.headerPath, 'utf8') : ''
    const nameMatch = script.match(/^\/\/ LibraryName: (.+)$/m)
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(script, basename(u.scriptPath)),
      parseGalaxySource(header, basename(u.headerPath)),
      {
        libraryId: u.id,
        libraryName: nameMatch?.[1]?.trim(),
        nativeLibrary,
        crossLibVars: new Map(),
      },
    )
    collectCrossLibGlobals(lib, u.id, allCrossLibVars)
    collectExternalFuncParamTypes(lib, u.id, externalFuncParamTypes)
    collectCrossLibFunctionDefs(lib, u.id, discoveredCrossLibFuncDefs)
    logMemory(`pass1:Lib${u.id} elements=${Object.keys(lib.elements).length}`)
  }

  // Pass 2: real conversion
  const convertedCrossLibVars: CrossLibVars = new Map()
  const allCrossLibFuncDefs: CrossLibFuncDefs = new Map()
  const libraries: TriggerLibraryJson[] = []
  resetGalaxyToTriggerIdCounter()
  logMemory(`pass2:start ${basename(modPath)}`)
  for (const u of units) {
    if (!existsSync(u.scriptPath)) continue
    const script = readFileSync(u.scriptPath, 'utf8')
    const header = existsSync(u.headerPath) ? readFileSync(u.headerPath, 'utf8') : ''
    const nameMatch = script.match(/^\/\/ LibraryName: (.+)$/m)
    const lib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(script, basename(u.scriptPath)),
      parseGalaxySource(header, basename(u.headerPath)),
      {
        libraryId: u.id,
        libraryName: nameMatch?.[1]?.trim(),
        nativeLibrary,
        crossLibVars: new Map(
          [...allCrossLibVars, ...convertedCrossLibVars].filter(
            ([, r]) => r.library.toUpperCase() !== u.id.toUpperCase(),
          ),
        ),
        externalFuncParamTypes,
        crossLibFuncDefs: new Map(
          [...discoveredCrossLibFuncDefs, ...allCrossLibFuncDefs].filter(
            ([, r]) => r.library.toUpperCase() !== u.id.toUpperCase(),
          ),
        ),
      },
    )
    libraries.push(lib)
    collectCrossLibGlobals(lib, u.id, convertedCrossLibVars)
    collectCrossLibFunctionDefs(lib, u.id, allCrossLibFuncDefs)
    logMemory(`pass2:Lib${u.id} elements=${Object.keys(lib.elements).length}`)
  }
  // Cross-library Variable/FunctionDef IDs are now content-derived (deterministic
  // across passes), so no post-hoc remap is needed.
  return libraries
}

// ---------------------------------------------------------------------------
// Diagnostic helpers
// ---------------------------------------------------------------------------

function duplicateIds(lib: TriggerLibraryJson): string[] {
  const seen = new Map<string, number>()
  for (const [key, el] of Object.entries(lib.elements)) {
    const eid = (el as any).id as string
    if (key !== eid) seen.set(eid, (seen.get(eid) ?? 0) + 1)
  }
  return [...seen.keys()]
}

function initVarsRawCount(lib: TriggerLibraryJson): number {
  return Object.values(lib.elements).filter(
    e => e.type === 'FunctionDef' && (e as FunctionDefJson).name === '__InitVariablesRaw',
  ).length
}

/**
 * FunctionCall elements whose functionDef.id looks like a function name (not a hex ID).
 * sameLibOnly=true: only include refs where functionDef.library matches libId (same-library unknowns).
 */
function unknownFuncRefs(lib: TriggerLibraryJson, sameLibOnly = false): string[] {
  const unknowns: string[] = []
  for (const el of Object.values(lib.elements)) {
    if (el.type !== 'FunctionCall') continue
    const fc = el as FunctionCallJson
    if (!fc.functionDef?.id) continue
    const id = fc.functionDef.id
    const refLib = fc.functionDef.library ?? ''
    if (sameLibOnly && refLib !== lib.id && refLib !== 'Ntve') continue
    if (!sameLibOnly && refLib && refLib !== lib.id && refLib !== 'Ntve') continue
    // Hex IDs look like 8 hex chars; function names contain letters/underscores
    if (!/^[0-9A-Fa-f]{8}$/.test(id) && !/^lib[A-Za-z0-9]+_/.test(id)) {
      unknowns.push(`${refLib}::${id}`)
    }
  }
  return [...new Set(unknowns)]
}

function refLabel(ref: ElementRefJson): string {
  return `${ref.library ?? '<local>'}:${ref.type ?? '*'}:${ref.id}`
}

type ElementLookup = Map<string, Map<string, ElementJson>>

function buildElementLookup(allLibraries: Map<string, TriggerLibraryJson>): ElementLookup {
  const lookup: ElementLookup = new Map()
  for (const [libId, lib] of allLibraries) {
    const byKey = new Map<string, ElementJson>()
    for (const el of Object.values(lib.elements)) {
      byKey.set(`${el.type}:${el.id}`, el)
      if (!byKey.has(`*:${el.id}`)) byKey.set(`*:${el.id}`, el)
    }
    lookup.set(libId, byKey)
  }
  return lookup
}

function resolveElementRef(
  ref: ElementRefJson | undefined,
  localLib: TriggerLibraryJson,
  allLibraries: Map<string, TriggerLibraryJson>,
  lookup: ElementLookup,
): ElementJson | undefined {
  if (!ref?.id) return undefined
  const targetLib = allLibraries.get(ref.library ?? localLib.id)
  if (!targetLib) return undefined
  const byKey = lookup.get(targetLib.id)
  if (ref.type) return byKey?.get(`${ref.type}:${ref.id}`)
  return byKey?.get(`*:${ref.id}`)
}

function isAllowedExternalRef(
  ref: ElementRefJson,
  localLib: TriggerLibraryJson,
  allLibraries: Map<string, TriggerLibraryJson>,
): boolean {
  const refLib = ref.library ?? localLib.id
  return refLib !== localLib.id && refLib !== 'Ntve' && !allLibraries.has(refLib)
}

function collectElementRefs(el: ElementJson): Array<{ field: string; ref: ElementRefJson }> {
  const refs: Array<{ field: string; ref: ElementRefJson }> = []
  const add = (field: string, ref?: ElementRefJson) => {
    if (ref?.id) refs.push({ field, ref })
  }
  const addMany = (field: string, values?: ElementRefJson[]) => {
    for (const ref of values ?? []) add(field, ref)
  }
  const addArrayRef = (field: string, value?: ElementRefJson | ElementRefJson[]) => {
    if (Array.isArray(value)) addMany(field, value)
    else add(field, value)
  }
  const addType = (field: string, value?: { typeElement?: ElementRefJson }) =>
    add(`${field}.typeElement`, value?.typeElement)

  switch (el.type) {
    case 'Category':
      addMany('items', el.items)
      break
    case 'Trigger':
      addMany('events', el.events)
      addMany('conditions', el.conditions)
      addMany('actions', el.actions)
      addMany('localVariables', el.localVariables)
      break
    case 'FunctionDef':
      addMany('parameters', el.parameters)
      addMany('actions', el.actions)
      addMany('localVariables', el.localVariables)
      addType('returnType', el.returnType)
      break
    case 'FunctionCall':
      add('functionDef', el.functionDef)
      addMany('parameters', el.parameters)
      addMany('subFunctions', el.subFunctions)
      break
    case 'Variable':
      addType('variableType', el.variableType)
      add('initialValue', el.initialValue)
      for (const size of el.arraySizes ?? []) add('arraySizes.variable', size.variable)
      break
    case 'Param':
      add('parameterDef', el.parameterDef)
      add('functionCall', el.functionCall)
      add('preset', el.preset)
      add('valueElement', el.valueElement)
      addArrayRef('array', el.array)
      add('variable', el.variable)
      add('structMember', el.structMember)
      add('paramRef', el.paramRef)
      break
    case 'ParamDef':
      addType('paramType', el.paramType)
      add('default', el.default)
      break
    case 'Preset':
      addMany('values', el.values)
      break
    case 'Structure':
      addMany('variables', el.variables)
      break
  }
  return refs
}

function unresolvedRefs(
  lib: TriggerLibraryJson,
  allLibraries: Map<string, TriggerLibraryJson>,
  lookup: ElementLookup,
): string[] {
  const missing: string[] = []
  const seen = new Set<string>()
  const check = (owner: string, field: string, ref: ElementRefJson) => {
    if (resolveElementRef(ref, lib, allLibraries, lookup)) return
    if (isAllowedExternalRef(ref, lib, allLibraries)) return
    const label = `${owner}.${field} -> ${refLabel(ref)}`
    if (!seen.has(label)) {
      missing.push(label)
      seen.add(label)
    }
  }
  for (const item of lib.items) {
    check(`Library:${lib.id}`, 'items', { ...item, library: item.library ?? lib.id })
  }
  for (const el of Object.values(lib.elements)) {
    for (const { field, ref } of collectElementRefs(el)) {
      check(`${el.type}:${el.id}`, field, ref)
    }
  }
  return missing
}

/** Returns true for a line that contains actual statements (not blank/comment/brace-only). */
function isCodeLine(line: string): boolean {
  const t = line.trim()
  if (!t || t === '{' || t === '}') return false
  if (t.startsWith('//')) return false
  return true
}

function extractFunctionDefs(code: string): Map<string, number> {
  const result = new Map<string, number>()
  const lines = code.split('\n')
  const sigRe = /^(?:static\s+)?(?:native\s+)?[\w\s*[\]]+\s+(lib\w+|gf_\w+)\s*\(/
  let pendingSig = ''
  let inFunc = false
  let depth = 0
  let funcName = ''
  let codeLines = 0

  for (const line of lines) {
    if (!inFunc) {
      if (pendingSig) {
        if (line.trim() === '{') {
          funcName = pendingSig
          pendingSig = ''
          inFunc = true
          depth = 1
          codeLines = 0
          continue
        }
        pendingSig = ''
      }
      const m = sigRe.exec(line)
      if (!m) continue
      if (line.includes('{')) {
        funcName = m[1]
        inFunc = true
        depth = 0
        codeLines = 0
        for (const ch of line) {
          if (ch === '{') depth++
          else if (ch === '}') depth--
        }
        if (depth <= 0) {
          result.set(funcName, codeLines)
          inFunc = false
        }
      } else if (!line.includes(';')) {
        pendingSig = m[1]
      }
    } else {
      if (isCodeLine(line)) codeLines++
      for (const ch of line) {
        if (ch === '{') depth++
        else if (ch === '}') depth--
      }
      if (depth <= 0) {
        result.set(funcName, codeLines)
        inFunc = false
      }
    }
  }
  return result
}

function isBoilerplateFunc(name: string): boolean {
  return /_(?:InitLib(?:raries)?|InitVariables|InitTriggers|InitCustomScript)$/.test(name)
}

function sourceFunctionDefsForLibrary(modPath: string, libId: string): Map<string, number> {
  const galaxyDir = findGalaxyDir(modPath)
  const scriptPath = join(galaxyDir, `Lib${libId}.galaxy`)
  if (existsSync(scriptPath)) return extractFunctionDefs(readFileSync(scriptPath, 'utf8'))
  const mapScriptPath = join(modPath, 'MapScript.galaxy')
  if (existsSync(mapScriptPath)) return extractFunctionDefs(readFileSync(mapScriptPath, 'utf8'))
  return new Map()
}

function shouldRunScriptRoundTripFixture(libs: TriggerLibraryJson[]): boolean {
  const totalElements = libs.reduce((sum, lib) => sum + Object.keys(lib.elements).length, 0)
  return totalElements <= 12000
}

function originalFunctionBelongsToLibrary(fnName: string, libId: string): boolean {
  if (fnName.startsWith('gf_')) return true
  return fnName.startsWith(`lib${libId}_gf_`)
}

function countByType(lib: TriggerLibraryJson, type: string): number {
  return Object.values(lib.elements).filter(e => e.type === type).length
}

// ---------------------------------------------------------------------------
// Source library helpers (count from original Triggers XML)
// ---------------------------------------------------------------------------

function loadSourceTriggerCounts(modPath: string): Map<string, number> {
  const triggersPath = [
    join(modPath, 'Triggers'),
    join(modPath, 'Base.SC2Data', 'Triggers'),
    join(modPath, 'base.sc2data', 'Triggers'),
  ].find(p => existsSync(p))
  if (!triggersPath) return new Map()

  const xml = readFileSync(triggersPath, 'utf8')
  const counts = new Map<string, number>()
  let currentLibrary: string | undefined
  const re = /<Library\s+Id="([^"]+)"|<Element\s+Type="Trigger"\s+Id="[^"]+"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    if (match[1]) {
      currentLibrary = match[1]
      if (!counts.has(currentLibrary)) counts.set(currentLibrary, 0)
    } else if (currentLibrary) {
      counts.set(currentLibrary, (counts.get(currentLibrary) ?? 0) + 1)
    }
  }
  return counts
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function discoverGalaxyFixtures(): string[] {
  const testdataRoot = resolve(repoRoot, 'testdata')
  if (!existsSync(testdataRoot)) return []
  return readdirSync(testdataRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => {
      const modPath = join(testdataRoot, name)
      const galaxyDir = findGalaxyDir(modPath)
      if (findGalaxyFiles(galaxyDir).length > 0) return true
      return existsSync(join(modPath, 'MapScript.galaxy'))
    })
    .sort((a, b) => a.localeCompare(b))
}

function parsePositiveIntEnv(name: string): number | undefined {
  const raw = readEnv(name)
  if (!raw) return undefined
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`)
  }
  return value
}

function selectFixtures(fixtures: string[]): string[] {
  const includeList = readEnv('MX_FIXTURE_LIST')
  let selected = fixtures

  if (includeList) {
    const wanted = new Set(
      includeList
        .split(',')
        .map(name => name.trim())
        .filter(Boolean),
    )
    selected = fixtures.filter(name => wanted.has(name))
  }

  const batchSize = parsePositiveIntEnv('MX_FIXTURE_BATCH_SIZE')
  const batchIndex = parsePositiveIntEnv('MX_FIXTURE_BATCH_INDEX')
  if ((batchSize === undefined) !== (batchIndex === undefined)) {
    throw new Error('MX_FIXTURE_BATCH_SIZE and MX_FIXTURE_BATCH_INDEX must be set together')
  }
  if (batchSize === undefined || batchIndex === undefined) return selected

  const start = (batchIndex - 1) * batchSize
  if (start >= selected.length) return []
  return selected.slice(start, start + batchSize)
}

const ALL_FIXTURES = discoverGalaxyFixtures()
const SELECTED_FIXTURES = selectFixtures(ALL_FIXTURES)
const describeWithFixtures =
  hasNativeFixture && SELECTED_FIXTURES.length > 0 ? describe : describe.skip

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWithFixtures(
  `roundtrip diff regressions (${SELECTED_FIXTURES.length}/${ALL_FIXTURES.length} fixtures)`,
  () => {
    let nativeLibrary: TriggerLibraryJson

    if (!hasNativeFixture || SELECTED_FIXTURES.length === 0) {
      it.skip('fixture corpus is not available in this checkout', () => {})
    }

    async function getNativeLib() {
      if (nativeLibrary) return nativeLibrary
      const results = await readTriggerLibrariesFast(
        [nativeXml],
        new Map([['Ntve', nativeStrings]]),
      )
      nativeLibrary = results.get('Ntve')!.library
      return nativeLibrary
    }

    // --- Tests that run on ALL fixtures ---

    for (const modName of SELECTED_FIXTURES) {
      const modPath = resolve(repoRoot, 'testdata', modName)
      if (!existsSync(modPath)) continue

      it(`${modName} — generated trigger output is internally consistent`, async () => {
        const ntve = await getNativeLib()
        logMemory(`${modName}:native-loaded`)
        const libs = await convertModGalaxyToLibraries(modPath, ntve)
        logMemory(`${modName}:converted libs=${libs.length}`)
        expect(libs.length, 'expected at least 1 library').toBeGreaterThan(0)

        const allDups: string[] = []
        for (const lib of libs) allDups.push(...duplicateIds(lib).map(id => `${lib.id}:${id}`))
        expect(allDups, `duplicate IDs: ${allDups.slice(0, 5).join(', ')}`).toHaveLength(0)

        for (const lib of libs) {
          const count = initVarsRawCount(lib)
          if (count > 0) {
            const hasArrayVars = Object.values(lib.elements).some(
              e => e.type === 'Variable' && (e as VariableJson).isArray,
            )
            expect(
              hasArrayVars,
              `lib ${lib.id} has __InitVariablesRaw but no array variables`,
            ).toBe(true)
          }
        }

        const allLibraries = new Map<string, TriggerLibraryJson>([['Ntve', ntve]])
        for (const lib of libs) allLibraries.set(lib.id, lib)
        const elementLookup = buildElementLookup(allLibraries)

        const unresolved: string[] = []
        for (const lib of libs) {
          unresolved.push(
            ...unresolvedRefs(lib, allLibraries, elementLookup).map(
              ref => `${modName}:Lib${lib.id}:${ref}`,
            ),
          )
        }
        logMemory(`${modName}:unresolved-check`)
        expect(
          unresolved,
          `unresolved generated refs:\n  ${unresolved.slice(0, 25).join('\n  ')}`,
        ).toHaveLength(0)

        const allUnknown: string[] = []
        for (const lib of libs) {
          const unknowns = unknownFuncRefs(lib, false)
          allUnknown.push(...unknowns.map(id => `${lib.id}:${id}`))
        }
        expect(allUnknown, `unknown func refs: ${allUnknown.slice(0, 12).join(', ')}`).toHaveLength(
          0,
        )

        // Layer-0 structural validation: the generated libraries must survive the
        // SC2 editor's load-time cleanup unchanged (no orphans, dup IDs, name-leaked
        // refs, arity overflows, leaked placeholders or synthetic __InitVariablesRaw).
        // External (non-fixture, non-Ntve) library refs are allowed — they resolve at
        // editor load time against the real dependency mods, exactly as unresolvedRefs
        // tolerates them above.
        const generatedIds = new Set(libs.map(l => l.id))
        const externalRefLibs = new Set<string>()
        for (const lib of libs) {
          for (const el of Object.values(lib.elements)) {
            for (const { ref } of collectElementRefs(el)) {
              const rl = ref.library
              if (rl && rl !== 'Ntve' && !generatedIds.has(rl)) externalRefLibs.add(rl)
            }
          }
        }
        const structureFindings = validateLibraryStructure(libs, {
          dependencyLibraries: [ntve],
          allowExternalLibraryIds: externalRefLibs,
        })
        logMemory(`${modName}:structure-check`)
        expect(
          structureFindings,
          `structure findings:\n${formatFindings(structureFindings)}`,
        ).toHaveLength(0)

        const missing: string[] = []
        const empty: string[] = []
        if (shouldRunScriptRoundTripFixture(libs)) {
          for (const lib of libs) {
            const originalDefs = sourceFunctionDefsForLibrary(modPath, lib.id)
            if (originalDefs.size === 0) continue
            const { script } = convertTriggerLibraryToGalaxyFull(lib, ntve, allLibraries)
            expect(
              script,
              `Lib${lib.id}: raw script placeholder leaked into generated Galaxy`,
            ).not.toContain('__mx_raw_script')
            const generatedDefs = extractFunctionDefs(script)
            for (const [fn, originalLines] of originalDefs) {
              if (isBoilerplateFunc(fn)) continue
              if (!originalFunctionBelongsToLibrary(fn, lib.id)) continue
              const generatedLines = generatedDefs.get(fn)
              if (generatedLines === undefined) {
                missing.push(`Lib${lib.id}:${fn}`)
                continue
              }
              if (originalLines >= 3 && generatedLines === 0) {
                empty.push(`Lib${lib.id}:${fn} (orig=${originalLines})`)
              }
            }
          }
        }
        expect(
          missing,
          `missing original functions after G2T->T2G:\n  ${missing.slice(0, 25).join('\n  ')}`,
        ).toHaveLength(0)
        expect(
          empty,
          `empty generated function bodies after G2T->T2G:\n  ${empty.slice(0, 25).join('\n  ')}`,
        ).toHaveLength(0)

        const srcTriggerCounts = loadSourceTriggerCounts(modPath)
        logMemory(`${modName}:source-counts`)
        if (srcTriggerCounts.size === 0) return
        const fixtureElementCount = libs.reduce(
          (sum, candidate) => sum + Object.keys(candidate.elements).length,
          0,
        )
        for (const lib of libs) {
          const srcCount = srcTriggerCounts.get(lib.id)
          if (srcCount === undefined) continue
          const rtCount = countByType(lib, 'Trigger')
          if (fixtureElementCount <= 12000) {
            expect(rtCount, `lib ${lib.id}: ${rtCount} triggers vs source ${srcCount}`).toBe(
              srcCount,
            )
          } else {
            const minExpected = Math.floor(srcCount * 0.5)
            expect(
              rtCount,
              `lib ${lib.id}: ${rtCount} triggers vs source ${srcCount} (min ${minExpected})`,
            ).toBeGreaterThanOrEqual(minExpected)
          }
        }
      })
    }
  },
)
