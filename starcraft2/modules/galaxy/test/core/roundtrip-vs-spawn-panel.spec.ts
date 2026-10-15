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
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  readTriggerLibraries,
  convertGalaxyToTriggerLibrary,
  parseGalaxySource,
  type FunctionCallJson,
  type TriggerLibraryJson,
  type TriggerJson,
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
const dpanPath = resolve(repoRoot, 'testdata/vs-spawn-panel.SC2Mod/Triggers')
const dpanStringsPath = resolve(
  repoRoot,
  'testdata/vs-spawn-panel.SC2Mod/enUS.SC2Data/LocalizedData/TriggerStrings.txt',
)
const hasFixture = [nativePath, nativeStringsPath, dpanPath, dpanStringsPath].every(existsSync)
const describeWithFixture = hasFixture ? describe : describe.skip
const nativeXml = existsSync(nativePath) ? readFileSync(nativePath, 'utf8') : ''
const nativeStrings = existsSync(nativeStringsPath) ? readFileSync(nativeStringsPath, 'utf8') : ''
const dpanXml = existsSync(dpanPath) ? readFileSync(dpanPath, 'utf8') : ''
const dpanStrings = existsSync(dpanStringsPath) ? readFileSync(dpanStringsPath, 'utf8') : ''

function resolveElement<T>(
  lib: TriggerLibraryJson,
  ref: any,
  libraries: Record<string, TriggerLibraryJson> = {},
): T | undefined {
  if (!ref) return undefined
  const targetLib = ref.library === lib.id ? lib : (libraries[ref.library] ?? lib)
  const typed = (targetLib.elementsByType as any)?.[ref.type]?.[ref.id]
  if (typed) return typed as T
  return (targetLib.elements[ref.id] ?? targetLib.elements[`${ref.type}:${ref.id}`]) as
    T | undefined
}

function functionName(
  lib: TriggerLibraryJson,
  fc: FunctionCallJson | undefined,
  libraries: Record<string, TriggerLibraryJson> = {},
): string {
  const fd = resolveElement<any>(lib, fc?.functionDef, libraries)
  return fd?.name ?? fc?.functionDef?.id ?? 'unknown'
}

function allTriggers(lib: TriggerLibraryJson): TriggerJson[] {
  const typed = Object.values(lib.elementsByType?.Trigger ?? {}) as TriggerJson[]
  if (typed.length > 0) return typed
  return Object.values(lib.elements).filter((el): el is TriggerJson => el.type === 'Trigger')
}

function collectLogicalLeaves(
  lib: TriggerLibraryJson,
  fc: FunctionCallJson | undefined,
  libraries: Record<string, TriggerLibraryJson> = {},
): Array<{ name: string; leafCount: number; missingLeafRoleCount: number }> {
  if (!fc) return []

  const out: Array<{ name: string; leafCount: number; missingLeafRoleCount: number }> = []
  const name = functionName(lib, fc, libraries)
  const subCalls = (fc.subFunctions ?? [])
    .map(ref => resolveElement<FunctionCallJson>(lib, ref, libraries))
    .filter((sub): sub is FunctionCallJson => sub !== undefined)

  if (name === 'Or' || name === 'And') {
    out.push({
      name,
      leafCount: subCalls.length,
      missingLeafRoleCount: subCalls.filter(sub => !sub.subFunctionType?.id).length,
    })
  }

  for (const sub of subCalls) out.push(...collectLogicalLeaves(lib, sub, libraries))
  return out
}

describeWithFixture('vs-spawn-panel roundtrip regressions', () => {
  it('preserves nested Or condition leaves in ToggleVisibility', async () => {
    const stringsMap = new Map<string, string>([
      ['Ntve', nativeStrings],
      ['DPAN', dpanStrings],
    ])

    const loaded = await readTriggerLibraries([nativeXml, dpanXml], stringsMap)
    const nativeLib = loaded.get('Ntve')!.library
    const dpanLib = loaded.get('DPAN')!.library
    const libs = { Ntve: nativeLib, DPAN: dpanLib }

    const galaxy = convertTriggerLibraryToGalaxyFull(
      dpanLib,
      nativeLib,
      new Map([
        ['Ntve', nativeLib],
        ['DPAN', dpanLib],
      ]),
    )

    const rtLib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(galaxy.script, 'LibDPAN.galaxy'),
      parseGalaxySource(galaxy.header, 'LibDPAN_h.galaxy'),
      { libraryId: 'DPAN', nativeLibrary: nativeLib },
    )

    const trigger = allTriggers(rtLib).find(
      (t: any) => (t as TriggerJson).name === 'ToggleVisibility',
    ) as TriggerJson | undefined
    expect(trigger).toBeDefined()

    const actions = (trigger!.actions ?? [])
      .map(ref => resolveElement<FunctionCallJson>(rtLib, ref, libs))
      .filter((fc): fc is FunctionCallJson => fc !== undefined)
    expect(actions.length).toBeGreaterThan(0)

    const outerIf = actions.find(fc => functionName(rtLib, fc, libs) === 'IfThenElse')
    expect(outerIf).toBeDefined()

    const outerSubs = (outerIf!.subFunctions ?? [])
      .map(ref => resolveElement<FunctionCallJson>(rtLib, ref, libs))
      .filter((fc): fc is FunctionCallJson => fc !== undefined)
    const nestedIf = outerSubs.find(fc => functionName(rtLib, fc, libs) === 'IfThenElse')
    expect(nestedIf).toBeDefined()

    const nestedSubs = (nestedIf!.subFunctions ?? [])
      .map(ref => resolveElement<FunctionCallJson>(rtLib, ref, libs))
      .filter((fc): fc is FunctionCallJson => fc !== undefined)
    const orCall = nestedSubs.find(fc => functionName(rtLib, fc, libs) === 'Or')
    expect(orCall).toBeDefined()

    const orLeaves = (orCall!.subFunctions ?? [])
      .map(ref => resolveElement<FunctionCallJson>(rtLib, ref, libs))
      .filter((fc): fc is FunctionCallJson => fc !== undefined)

    expect(orLeaves).toHaveLength(2)
    expect(orLeaves.every(fc => fc.subFunctionType?.id)).toBe(true)
  })

  it('keeps logical wrapper leaf roles across the whole library', async () => {
    const stringsMap = new Map<string, string>([
      ['Ntve', nativeStrings],
      ['DPAN', dpanStrings],
    ])

    const loaded = await readTriggerLibraries([nativeXml, dpanXml], stringsMap)
    const nativeLib = loaded.get('Ntve')!.library
    const dpanLib = loaded.get('DPAN')!.library
    const libs = { Ntve: nativeLib, DPAN: dpanLib }

    const galaxy = convertTriggerLibraryToGalaxyFull(
      dpanLib,
      nativeLib,
      new Map([
        ['Ntve', nativeLib],
        ['DPAN', dpanLib],
      ]),
    )

    const rtLib = convertGalaxyToTriggerLibrary(
      parseGalaxySource(galaxy.script, 'LibDPAN.galaxy'),
      parseGalaxySource(galaxy.header, 'LibDPAN_h.galaxy'),
      { libraryId: 'DPAN', nativeLibrary: nativeLib },
    )

    const originalLogical = allTriggers(dpanLib).flatMap(trigger =>
      ((trigger as TriggerJson).actions ?? [])
        .map(ref => resolveElement<FunctionCallJson>(dpanLib, ref, libs))
        .filter((fc): fc is FunctionCallJson => fc !== undefined)
        .flatMap(fc => collectLogicalLeaves(dpanLib, fc, libs)),
    )

    const roundtripLogical = allTriggers(rtLib).flatMap(trigger =>
      ((trigger as TriggerJson).actions ?? [])
        .map(ref => resolveElement<FunctionCallJson>(rtLib, ref, libs))
        .filter((fc): fc is FunctionCallJson => fc !== undefined)
        .flatMap(fc => collectLogicalLeaves(rtLib, fc, libs)),
    )

    expect(roundtripLogical.length).toBe(originalLogical.length)
    expect(roundtripLogical.every(node => node.leafCount > 0)).toBe(true)
    expect(roundtripLogical.every(node => node.missingLeafRoleCount === 0)).toBe(true)
  })
})
