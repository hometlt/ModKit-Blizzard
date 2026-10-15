/**
 * vs-test.SC2Mod T2G spec.
 *
 * Fixture: testdata/vs-test.SC2Mod/Base.SC2Data
 * Library D970AA02 (TestLib): one action function with a local player loop.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { readTriggerLibraries } from '@modkit/blizzard-starcraft2/triggers/document/index.js'
import { convertTriggerLibraryToGalaxyFull } from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/trigger-to-galaxy.js'
import type { TriggerLibraryJson } from '@modkit/blizzard-starcraft2/triggers/document/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../..')

const triggerXmlPath = resolve(repoRoot, 'testdata/vs-test.SC2Mod/Base.SC2Data/Triggers')
const triggerStringsPath = resolve(
  repoRoot,
  'testdata/vs-test.SC2Mod/Base.SC2Data/enUS.SC2Data/LocalizedData/TriggerStrings.txt',
)
const nativeXmlPath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/base.sc2data/TriggerLibs/NativeLib.TriggerLib',
)
const nativeStringsPath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/enus.sc2data/LocalizedData/TriggerStrings.txt',
)
const referenceGalaxyPath = resolve(
  repoRoot,
  'testdata/vs-test.SC2Mod/Base.SC2Data/LibD970AA02.galaxy',
)
const hasFixture = [
  triggerXmlPath,
  triggerStringsPath,
  nativeXmlPath,
  nativeStringsPath,
  referenceGalaxyPath,
].every(existsSync)
const describeFixture = hasFixture
  ? describe
  : (name: string, _fn: () => void) =>
      describe.skip(name, () => {
        it('fixture unavailable', () => undefined)
      })

let code: string
let header: string

beforeAll(async () => {
  if (!hasFixture) return
  const triggerXml = readFileSync(triggerXmlPath, 'utf8')
  const triggerStrings = readFileSync(triggerStringsPath, 'utf8')
  const nativeXml = readFileSync(nativeXmlPath, 'utf8')
  const nativeStrings = readFileSync(nativeStringsPath, 'utf8')

  const stringsMap = new Map([
    ['Ntve', nativeStrings],
    ['D970AA02', triggerStrings],
  ])

  const results = await readTriggerLibraries([nativeXml, triggerXml], stringsMap)
  const lib = results.get('D970AA02')!.library
  const ntveLib = results.get('Ntve')!.library
  const allLibraries = new Map<string, TriggerLibraryJson>([
    ['Ntve', ntveLib],
    ['D970AA02', lib],
  ])

  const output = convertTriggerLibraryToGalaxyFull(lib, ntveLib, allLibraries)
  code = output.script
  header = output.header
}, 15_000)

describeFixture('vs-test.SC2Mod (D970AA02) to Galaxy header', () => {
  it('includes TriggerLibs/natives', () => {
    expect(header).toContain('include "TriggerLibs/natives"')
  })

  it('declares InitVariables forward declaration', () => {
    expect(header).toContain('void libD970AA02_InitVariables();')
  })

  it('declares action function', () => {
    expect(header).toContain('void libD970AA02_gf_TestTrigger();')
  })
})

describeFixture('vs-test.SC2Mod (D970AA02) to Galaxy script', () => {
  it('includes TriggerLibs/NativeLib', () => {
    expect(code).toContain('include "TriggerLibs/NativeLib"')
  })

  it('includes LibD970AA02_h', () => {
    expect(code).toContain('include "LibD970AA02_h"')
  })

  it('calls the full native-library initializer', () => {
    expect(code).toContain('libNtve_InitLib()')
  })

  describe('TestTrigger action function', () => {
    it('has correct signature', () => {
      expect(code).toContain('void libD970AA02_gf_TestTrigger()')
    })

    it('declares local variables', () => {
      expect(code).toContain('int lv_player;')
      expect(code).toContain('playergroup autoA0000011_g;')
      expect(code).toContain('int autoA0000010_val;')
    })

    it('emits player loop and date check', () => {
      expect(code).toContain('PlayerGroupNextPlayer(autoA0000011_g, lv_player)')
      expect(code).toContain('GetDateTimeMonth(CurrentDateTimeGet())')
      expect(code).toContain('autoA0000010_val == 10')
    })

    it('emits debug output action', () => {
      expect(code).toContain(
        'TriggerDebugOutput(1, StringExternal("Param/Value/lib_D970AA02_F3290E9A"), true)',
      )
    })
  })

  describe('InitTriggers', () => {
    it('does not create triggers for function-only fixture', () => {
      expect(code).not.toContain('TriggerCreate(')
      expect(code).not.toContain('TriggerAddEventMapInit(')
    })
  })

  describe('reference match', () => {
    it('matches SC2 Editor reference output after normalization', () => {
      const reference = readFileSync(referenceGalaxyPath, 'utf8')

      const normalize = (text: string) =>
        text
          .replace(/\r\n/g, '\n')
          .replace(/\/\/[^\n]*/g, '')
          .replace(/auto[0-9A-F]+_/g, 'autoID_')
          .replace(/[ \t]+/g, ' ')
          .replace(/ ?\( ?/g, '(')
          .replace(/ ?\) ?/g, ')')
          .replace(/^\s*\{\s*$/gm, '{')
          .replace(/\)\s*\n\s*\{/g, '){')
          .replace(/\) \{/g, '){')
          .replace(/^\s*\n/gm, '')
          .replace(/^\s+/gm, '')
          .replace(/\s+$/gm, '')
          .trim()

      expect(normalize(code)).toBe(normalize(reference))
    })
  })
})
