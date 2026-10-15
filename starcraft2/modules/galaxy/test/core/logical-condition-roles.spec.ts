/**
 * Roundtrip integration test between @modkitx/triggers and @modkitx/galaxy.
 *
 * Lives in packages/galaxy (not packages/triggers) so the dependency graph
 * stays one-directional: galaxy already depends on triggers in production
 * (T2G conversion), and this spec exercises the full T2G -> G2T roundtrip.
 * Keeping it here avoids a triggers -> galaxy test-only import that would
 * otherwise create an import cycle flagged by
 * `scripts/verify-dependency-boundaries.ts` rule 3.
 */
import { readFileSync, existsSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import {
  readTriggerLibraries,
  convertGalaxyToTriggerLibrary,
  parseGalaxySource,
  type ElementRefJson,
  type FunctionCallJson,
  type TriggerJson,
  type TriggerLibraryJson,
} from '@modkit/blizzard-starcraft2/triggers/document/index.js'
import { convertTriggerLibraryToGalaxyFull } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/trigger-to-galaxy.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../..')

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
const describeWithNative = hasNativeFixture ? describe : describe.skip

const fixtures = [
  'testdata/vs-spawn-panel.SC2Mod',
  'testdata/vs-ar-pvp-extension.SC2Mod',
  'testdata/ta-starlight.SC2Mod',
  'testdata/vs-ar-ai.SC2Mod',
  'testdata/ta-tester-simple.SC2Map',
  'testdata/vs-test-map.SC2Map',
  'testdata/ta-traynor.SC2Map',
  'testdata/ta-uedfl.SC2Map',
]

function findTriggers(dir: string): string | undefined {
  for (const p of [
    join(dir, 'Triggers'),
    join(dir, 'Base.SC2Data', 'Triggers'),
    join(dir, 'base.sc2data', 'Triggers'),
  ]) {
    if (existsSync(p)) return p
  }
}

function findStrings(dir: string): string | undefined {
  for (const p of [
    join(dir, 'TriggerStrings.txt'),
    join(dir, 'enUS.SC2Data', 'LocalizedData', 'TriggerStrings.txt'),
    join(dir, 'enus.sc2data', 'LocalizedData', 'TriggerStrings.txt'),
    join(dir, 'LocalizedData', 'TriggerStrings.txt'),
  ]) {
    if (existsSync(p)) return p
  }
}

function inferSyntheticLibraryId(containerRoot: string): string {
  const base = basename(containerRoot).replace(/\.(sc2mod|sc2map)$/i, '')
  const cleaned = base.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const id = cleaned.length > 0 ? cleaned.slice(0, 8) : 'ROOTMAP'
  return /^[A-Za-z]/.test(id) ? id : `L${id}`.slice(0, 8)
}

function wrapRootOnlyTriggerData(xmlContent: string, libraryId: string): string {
  if (/<Library\s+Id="/.test(xmlContent) || /<Standard\s+Id="/.test(xmlContent)) return xmlContent
  const openTag = '<TriggerData>'
  const closeTag = '</TriggerData>'
  const openIdx = xmlContent.indexOf(openTag)
  const closeIdx = xmlContent.lastIndexOf(closeTag)
  if (openIdx < 0 || closeIdx < 0 || closeIdx <= openIdx) return xmlContent
  const before = xmlContent.slice(0, openIdx + openTag.length)
  const inside = xmlContent.slice(openIdx + openTag.length, closeIdx)
  const after = xmlContent.slice(closeIdx)
  return `${before}\n<Library Id="${libraryId}">${inside}\n</Library>${after}`
}

function allTriggers(lib: TriggerLibraryJson): TriggerJson[] {
  const typed = Object.values(lib.elementsByType?.Trigger ?? {}) as TriggerJson[]
  if (typed.length > 0) return typed
  return Object.values(lib.elements).filter((el): el is TriggerJson => el.type === 'Trigger')
}

function resolveElement<T>(
  lib: TriggerLibraryJson,
  ref: ElementRefJson | undefined,
  libraries: Map<string, TriggerLibraryJson>,
): T | undefined {
  if (!ref) return undefined
  const target = ref.library === lib.id ? lib : (libraries.get(ref.library ?? '') ?? lib)
  const typed = (target.elementsByType as any)?.[ref.type ?? '']?.[ref.id]
  if (typed) return typed as T
  return (target.elements[ref.id] ?? target.elements[`${ref.type}:${ref.id}`]) as T | undefined
}

function functionName(
  lib: TriggerLibraryJson,
  fc: FunctionCallJson | undefined,
  libraries: Map<string, TriggerLibraryJson>,
): string {
  const fd = resolveElement<any>(lib, fc?.functionDef, libraries)
  return fd?.name ?? fc?.functionDef?.id ?? 'unknown'
}

function collectLogicalRoleProblems(
  lib: TriggerLibraryJson,
  fc: FunctionCallJson | undefined,
  libraries: Map<string, TriggerLibraryJson>,
  path: string,
  out: string[],
) {
  if (!fc) return
  const name = functionName(lib, fc, libraries)
  const subCalls = (fc.subFunctions ?? [])
    .map(ref => resolveElement<FunctionCallJson>(lib, ref, libraries))
    .filter((sub): sub is FunctionCallJson => sub !== undefined)

  if (name === 'Or' || name === 'And') {
    if (subCalls.length === 0) {
      out.push(`${path}/${name}: empty logical wrapper`)
    }
    for (const [index, sub] of subCalls.entries()) {
      if (!sub.subFunctionType?.id) {
        out.push(`${path}/${name}[${index}]: missing leaf condition role`)
      }
    }
  }

  for (const [index, sub] of subCalls.entries()) {
    collectLogicalRoleProblems(lib, sub, libraries, `${path}/${name}[${index}]`, out)
  }
}

async function roundtripLibraries(fixtureRelPath: string) {
  const fixturePath = resolve(repoRoot, fixtureRelPath)
  const triggersPath = findTriggers(fixturePath)
  if (!triggersPath) throw new Error(`No Triggers file found for ${fixtureRelPath}`)

  const xmlRaw = readFileSync(triggersPath, 'utf8')
  const xml = wrapRootOnlyTriggerData(xmlRaw, inferSyntheticLibraryId(fixturePath))
  const stringsMap = new Map<string, string>([['Ntve', nativeStrings]])
  const stringsPath = findStrings(fixturePath)
  if (stringsPath) {
    const strings = readFileSync(stringsPath, 'utf8')
    const ids = [...xml.matchAll(/<Library\s+Id="([^"]+)"/g)].map(m => m[1])
    for (const id of ids) stringsMap.set(id, strings)
  }

  const loaded = await readTriggerLibraries([nativeXml, xml], stringsMap)
  const nativeLib = loaded.get('Ntve')!.library
  const allOriginalLibs = new Map([...loaded.entries()].map(([key, value]) => [key, value.library]))
  const roundtripped = new Map<string, TriggerLibraryJson>()

  for (const [id, result] of loaded) {
    if (id === 'Ntve') continue
    const origLib = result.library
    const galaxy = convertTriggerLibraryToGalaxyFull(origLib, nativeLib, allOriginalLibs)
    const rtLib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(galaxy.script, `Lib${id}.galaxy`),
      parseGalaxySource(galaxy.header, `Lib${id}_h.galaxy`),
      { libraryId: id, nativeLibrary: nativeLib },
    )
    roundtripped.set(id, rtLib)
  }

  return { nativeLib, roundtripped }
}

describeWithNative('logical condition role regressions', () => {
  for (const fixtureRelPath of fixtures) {
    const hasFixture = !!findTriggers(resolve(repoRoot, fixtureRelPath))
    it.skipIf(!hasFixture)(
      `keeps logical condition leaves materialized for ${fixtureRelPath}`,
      async () => {
        const { nativeLib, roundtripped } = await roundtripLibraries(fixtureRelPath)
        const problems: string[] = []

        for (const [libraryId, lib] of roundtripped) {
          const libraries = new Map<string, TriggerLibraryJson>([
            ['Ntve', nativeLib],
            [libraryId, lib],
          ])

          for (const trigger of allTriggers(lib)) {
            const roots = [...(trigger.conditions ?? []), ...(trigger.actions ?? [])]
              .map(ref => resolveElement<FunctionCallJson>(lib, ref, libraries))
              .filter((fc): fc is FunctionCallJson => fc !== undefined)

            for (const [index, root] of roots.entries()) {
              collectLogicalRoleProblems(
                lib,
                root,
                libraries,
                `${libraryId}:${trigger.name ?? trigger.id}/root[${index}]`,
                problems,
              )
            }
          }
        }

        expect(problems).toEqual([])
      },
    )
  }
})
