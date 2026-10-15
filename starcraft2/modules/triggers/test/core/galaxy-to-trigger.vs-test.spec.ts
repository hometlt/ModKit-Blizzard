/**
 * Integration tests for galaxy-to-trigger using real vs-test.SC2Mod fixture.
 *
 * Converts LibD970AA02.galaxy (TestLib) back to Trigger XML structure and
 * verifies the function-only fixture shape.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { readTriggerLibraries } from '@modkit/blizzard-starcraft2/triggers/document/index.js'
import type { FunctionCallJson, FunctionDefJson, VariableJson } from '@modkit/blizzard-starcraft2/triggers/document/index.js'
import { parseGalaxySource, convertGalaxyToTriggerLibrary } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/galaxy-to-trigger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../..')

const galaxyPath = resolve(repoRoot, 'testdata/vs-test.SC2Mod/Base.SC2Data/LibD970AA02.galaxy')
const headerPath = resolve(repoRoot, 'testdata/vs-test.SC2Mod/Base.SC2Data/LibD970AA02_h.galaxy')
const nativePath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/base.sc2data/TriggerLibs/NativeLib.TriggerLib',
)
const nativeStringsPath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/enus.sc2data/LocalizedData/TriggerStrings.txt',
)
const hasFixture = [galaxyPath, headerPath, nativePath, nativeStringsPath].every(existsSync)
const describeWithFixture = hasFixture ? describe : describe.skip

describeWithFixture('Galaxy to Trigger (vs-test.SC2Mod / LibD970AA02)', () => {
  let convertedLibrary: any

  beforeAll(async () => {
    const nativeXml = readFileSync(nativePath, 'utf8')
    const nativeStrings = readFileSync(nativeStringsPath, 'utf8')
    const galaxyCode = readFileSync(galaxyPath, 'utf8')
    const headerCode = readFileSync(headerPath, 'utf8')
    const nativeResults = await readTriggerLibraries(
      [nativeXml],
      new Map([['Ntve', nativeStrings]]),
    )
    const nativeLibrary = nativeResults.get('Ntve')!.library

    const galaxySource = parseGalaxySource(galaxyCode, 'LibD970AA02.galaxy')
    const headerSource = parseGalaxySource(headerCode, 'LibD970AA02_h.galaxy')
    convertedLibrary = convertGalaxyToTriggerLibrary(galaxySource, headerSource, {
      libraryId: 'D970AA02',
      libraryName: 'TestLib',
      nativeLibrary,
    })
  }, 15_000)

  it('has correct library ID', () => {
    expect(convertedLibrary.id).toBe('D970AA02')
  })

  it('has no duplicate element IDs', () => {
    const ids = Object.keys(convertedLibrary.elements)
    const set = new Set(ids)
    expect(ids.length).toBe(set.size)
  })

  describe('TestTrigger function', () => {
    let fn: FunctionDefJson | undefined

    beforeAll(() => {
      fn = Object.values(convertedLibrary.elements).find(
        (e: any) => e.type === 'FunctionDef' && e.name === 'TestTrigger',
      ) as FunctionDefJson | undefined
    })

    it('exists as an action function', () => {
      expect(fn).toBeDefined()
      expect((fn as any)?.isFuncAction).toBe(true)
      expect(fn?.returnType?.type).toBe('void')
    })

    it('contains the local player variable', () => {
      const ref = (fn as any)?.localVariables?.[0]
      const variable = convertedLibrary.elements[ref?.id] as VariableJson | undefined
      expect(variable?.name).toBe('player')
      expect(variable?.variableType?.type).toBe('int')
    })

    it('contains one top-level ForEachPlayer action', () => {
      expect(fn?.actions?.length).toBe(1)
      const actionId = fn?.actions?.[0]?.id
      const action = actionId
        ? (convertedLibrary.elements[actionId] as FunctionCallJson | undefined)
        : undefined
      expect(action?.functionDef?.library).toBe('Ntve')
      expect(action?.functionDef?.id).toBe('B525B112')
    })
  })

  describe('converted action graph', () => {
    it('contains PlayerGroupAll', () => {
      const call = Object.values(convertedLibrary.elements).find(
        (e: any) =>
          e.type === 'FunctionCall' &&
          e.functionDef?.library === 'Ntve' &&
          e.functionDef?.id === '00000192',
      ) as FunctionCallJson | undefined
      expect(call).toBeDefined()
    })

    it('contains CurrentDateTimeGet and GetDateTimeMonth', () => {
      const currentDate = Object.values(convertedLibrary.elements).find(
        (e: any) =>
          e.type === 'FunctionCall' &&
          e.functionDef?.library === 'Ntve' &&
          e.functionDef?.id === 'FFF0634E',
      ) as FunctionCallJson | undefined
      const month = Object.values(convertedLibrary.elements).find(
        (e: any) =>
          e.type === 'FunctionCall' &&
          e.functionDef?.library === 'Ntve' &&
          e.functionDef?.id === '32EB26E3',
      ) as FunctionCallJson | undefined
      expect(currentDate).toBeDefined()
      expect(month).toBeDefined()
    })

    it('contains IfThen and TriggerDebugOutput', () => {
      const ifThen = Object.values(convertedLibrary.elements).find(
        (e: any) =>
          e.type === 'FunctionCall' &&
          e.functionDef?.library === 'Ntve' &&
          e.functionDef?.id === '00000118',
      ) as FunctionCallJson | undefined
      const debug = Object.values(convertedLibrary.elements).find(
        (e: any) =>
          e.type === 'FunctionCall' &&
          e.functionDef?.library === 'Ntve' &&
          e.functionDef?.id === '91C49196',
      ) as FunctionCallJson | undefined
      expect(ifThen).toBeDefined()
      expect(debug).toBeDefined()
    })
  })
})
