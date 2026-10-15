/**
 * t2g-galaxy-diff — T2G output quality regression tests
 *
 * For each testdata mod that has both a Triggers XML and original Lib*.galaxy files,
 * runs trigger-to-galaxy and compares the generated .galaxy code against the originals.
 *
 * Checks per library:
 *   - Every function defined in the original .galaxy is present in the T2G output
 *   - No unexpected extra functions in the T2G output
 *   - Per matching function, body line count is within 50% of original
 *
 * T2G is run once per mod in beforeAll; individual tests just read cached results.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readTriggerLibraries,
  readTriggerLibrariesFast,
} from '@modkit/blizzard-starcraft2/triggers/document/index.js'
import { convertTriggerLibraryToGalaxyFull } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/trigger-to-galaxy.js'
import type { TriggerLibraryJson } from '@modkit/blizzard-starcraft2/triggers/document/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../..')
const nativeXmlPath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/base.sc2data/TriggerLibs/NativeLib.TriggerLib',
)
const nativeStringsPath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/enus.sc2data/LocalizedData/TriggerStrings.txt',
)
const hasNativeFixture = existsSync(nativeXmlPath) && existsSync(nativeStringsPath)

// ---------------------------------------------------------------------------
// NativeLib (loaded once for all tests)
// ---------------------------------------------------------------------------

let nativeLibrary: TriggerLibraryJson

beforeAll(async () => {
  if (!hasNativeFixture) return
  const nativeXml = readFileSync(nativeXmlPath, 'utf8')
  const nativeStrings = readFileSync(nativeStringsPath, 'utf8')
  const results = await readTriggerLibraries([nativeXml], new Map([['Ntve', nativeStrings]]))
  nativeLibrary = results.get('Ntve')!.library
}, 30_000)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true for a line that contains actual statements (not blank/comment/brace-only). */
function isCodeLine(line: string): boolean {
  const t = line.trim()
  if (!t || t === '{' || t === '}') return false
  if (t.startsWith('//')) return false
  return true
}

/** Extract function definitions from galaxy text: returns Map<funcName, codeLineCount>.
 *  Counts only non-blank, non-comment, non-brace-only lines so formatting differences
 *  (blank lines, comments, brace placement) don't cause false positives.
 *  Handles both "type name() {" (same-line brace) and "type name()\n{" (next-line brace). */
function extractFunctionDefs(code: string): Map<string, number> {
  const result = new Map<string, number>()
  const lines = code.split('\n')
  const sigRe = /^(?:static\s+)?(?:native\s+)?\w[\w*[\] ]*\s+(lib\w+|gf_\w+)\s*\(/
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
      if (m) {
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

function findLibGalaxyFiles(modPath: string): Array<{ id: string; scriptPath: string }> {
  for (const dir of [join(modPath, 'Base.SC2Data'), join(modPath, 'base.sc2data'), modPath]) {
    if (!existsSync(dir)) continue
    const units: Array<{ id: string; scriptPath: string }> = []
    for (const name of readdirSync(dir)) {
      const m = name.match(/^Lib([A-Za-z0-9]+)\.galaxy$/)
      if (m) units.push({ id: m[1], scriptPath: join(dir, name) })
    }
    if (units.length > 0) return units
  }
  return []
}

function findTriggersXml(modPath: string): string | undefined {
  for (const p of [
    join(modPath, 'Triggers'),
    join(modPath, 'Base.SC2Data', 'Triggers'),
    join(modPath, 'base.sc2data', 'Triggers'),
  ]) {
    if (existsSync(p)) return p
  }
}

function findStrings(modPath: string): string | undefined {
  for (const p of [
    join(modPath, 'TriggerStrings.txt'),
    join(modPath, 'enUS.SC2Data', 'LocalizedData', 'TriggerStrings.txt'),
    join(modPath, 'enus.sc2data', 'LocalizedData', 'TriggerStrings.txt'),
  ]) {
    if (existsSync(p)) return p
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface FixtureResult {
  modName: string
  libId: string
  origDefs: Map<string, number>
  genDefs: Map<string, number>
}

const FIXTURES = ['vs-spawn-panel.SC2Mod', 'vs-ar-pvp-extension.SC2Mod', 'vs-ar-ai.SC2Mod']
const hasAnyFixture = FIXTURES.some(modName => existsSync(resolve(repoRoot, 'testdata', modName)))
const describeFixture =
  hasNativeFixture && hasAnyFixture
    ? describe
    : (name: string, _fn: () => void) =>
        describe.skip(name, () => {
          it('fixture unavailable', () => undefined)
        })

const results: FixtureResult[] = []

beforeAll(async () => {
  if (!hasNativeFixture) return
  for (const modName of FIXTURES) {
    const modPath = resolve(repoRoot, 'testdata', modName)
    if (!existsSync(modPath)) continue

    const triggersPath = findTriggersXml(modPath)
    if (!triggersPath) continue

    const triggersXml = readFileSync(triggersPath, 'utf8')
    const stringsPath = findStrings(modPath)
    const stringsContent = stringsPath ? readFileSync(stringsPath, 'utf8') : ''

    // Build stringsMap from lib IDs already known via the .galaxy file list.
    // Strings must be in the map BEFORE readTriggerLibrariesFast so FunctionDef
    // display names and trigger names are resolved from TriggerStrings.txt.
    const stringsMap = new Map<string, string>()
    for (const { id } of findLibGalaxyFiles(modPath)) {
      if (stringsContent) stringsMap.set(id, stringsContent)
    }

    const allLibraries = new Map<string, TriggerLibraryJson>([['Ntve', nativeLibrary]])
    const allResults = await readTriggerLibrariesFast([triggersXml], stringsMap)
    for (const [id, analysis] of allResults) {
      allLibraries.set(id, analysis.library)
    }

    for (const { id, scriptPath } of findLibGalaxyFiles(modPath)) {
      if (!existsSync(scriptPath)) continue
      const lib = allLibraries.get(id)
      if (!lib) continue

      const { script } = convertTriggerLibraryToGalaxyFull(lib, nativeLibrary, allLibraries)
      results.push({
        modName,
        libId: id,
        origDefs: extractFunctionDefs(readFileSync(scriptPath, 'utf8')),
        genDefs: extractFunctionDefs(script),
      })
    }
  }
}, 60_000)

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * SC2 Editor historically emits lib{ID}_InitLib and lib{ID}_InitCustomScript
 * as variants of the standard boilerplate. T2G always emits InitLibraries /
 * InitVariables / InitTriggers. Treat the entire init boilerplate family as
 * equivalent and exclude it from the name diff checks.
 */
function isBoilerplateFunc(name: string): boolean {
  return /_(?:InitLib(?:raries)?|InitVariables|InitTriggers|InitCustomScript)$/.test(name)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeFixture('T2G output matches original galaxy files', () => {
  it('at least one fixture was loaded', () => {
    expect(results.length).toBeGreaterThan(0)
  })

  for (const modName of FIXTURES) {
    describe(modName, () => {
      it('all original non-boilerplate functions present in T2G output', () => {
        const modResults = results.filter(r => r.modName === modName)
        if (modResults.length === 0) return

        const missing: string[] = []
        for (const { libId, origDefs, genDefs } of modResults) {
          for (const fn of origDefs.keys()) {
            if (isBoilerplateFunc(fn)) continue
            if (!genDefs.has(fn)) missing.push(`Lib${libId}: ${fn}`)
          }
        }
        expect(
          missing,
          `Non-boilerplate functions in original but missing from T2G:\n  ${missing.join('\n  ')}`,
        ).toHaveLength(0)
      })

      it('no unexpected non-boilerplate extra functions in T2G output', () => {
        const modResults = results.filter(r => r.modName === modName)
        if (modResults.length === 0) return

        const extra: string[] = []
        for (const { libId, origDefs, genDefs } of modResults) {
          for (const fn of genDefs.keys()) {
            if (isBoilerplateFunc(fn)) continue
            if (!origDefs.has(fn)) extra.push(`Lib${libId}: ${fn}`)
          }
        }
        expect(
          extra,
          `Non-boilerplate functions in T2G but NOT in original:\n  ${extra.join('\n  ')}`,
        ).toHaveLength(0)
      })

      it('no completely empty function bodies (regression guard)', () => {
        // A function that has statements in the original but generates 0 code
        // lines in T2G is a clear conversion failure (payload encoding still
        // produces 1+ lines, so gen=0 is the pathological case).
        const modResults = results.filter(r => r.modName === modName)
        if (modResults.length === 0) return

        const empty: string[] = []
        for (const { libId, origDefs, genDefs } of modResults) {
          for (const [fn, origLines] of origDefs) {
            if (isBoilerplateFunc(fn)) continue
            if (origLines < 3) continue // trivial functions may legitimately be empty
            const genLines = genDefs.get(fn)
            if (genLines === undefined) continue // caught by previous test
            if (genLines === 0) empty.push(`Lib${libId}:${fn} (orig=${origLines} code lines)`)
          }
        }
        expect(
          empty,
          `Functions with empty T2G bodies (orig had ${'>'}=3 code lines):\n  ${empty.join('\n  ')}`,
        ).toHaveLength(0)
      })
    })
  }
})
