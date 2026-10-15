import { beforeAll, describe, expect, it } from 'vitest'
import { readTriggerLibrary, readTriggerLibraries } from '@modkit/blizzard-starcraft2/triggers/document/reader.js'
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../..')
const root = resolve(repoRoot, 'testdata/vs-test.SC2Mod')
const triggerPath = resolve(root, 'Triggers')
const triggerStringsPath = resolve(root, 'enUS.SC2Data/LocalizedData/TriggerStrings.txt')
const nativePath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/base.sc2data/TriggerLibs/NativeLib.TriggerLib',
)
const nativeStringsPath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/enus.sc2data/LocalizedData/TriggerStrings.txt',
)
const hasVsFixture = existsSync(triggerPath) && existsSync(triggerStringsPath)
const hasNativeFixture = existsSync(nativePath) && existsSync(nativeStringsPath)
const triggerXml = hasVsFixture ? readFileSync(triggerPath, 'utf8') : ''
const triggerStrings = hasVsFixture ? readFileSync(triggerStringsPath, 'utf8') : ''
const describeWithVsFixture = hasVsFixture ? describe : describe.skip
const describeWithNative = hasVsFixture && hasNativeFixture ? describe : describe.skip

let libResult: Awaited<ReturnType<typeof readTriggerLibrary>>

if (hasVsFixture) {
  beforeAll(async () => {
    libResult = await readTriggerLibrary(triggerXml, triggerStrings)
  })
}

describeWithVsFixture('vs-test.SC2Mod', () => {
  it('loads the current library', () => {
    expect(libResult.library.id).toBe('D970AA02')
    expect(libResult.library.name).toBe('TestLib')
  })

  it('has one root FunctionDef item', () => {
    expect(libResult.library.items).toHaveLength(1)
    expect(libResult.library.items[0]?.type).toBe('FunctionDef')
    expect(libResult.library.items[0]?.id).toBe('A9A17E63')
  })

  it('exposes the root FunctionDef name from TriggerStrings', () => {
    const func = libResult.library.elementsByType.FunctionDef['A9A17E63']
    expect(func?.type).toBe('FunctionDef')
    expect(func?.name).toBe('TestTrigger')
  })

  it('parses the current variable set', () => {
    const variables = Object.values(libResult.library.elementsByType.Variable)
    expect(variables).toHaveLength(1)
    expect(variables[0]?.id).toBe('0BBDCAF9')
    expect(variables[0]?.name).toBe('Player')
  })

  it('does not expose Trigger elements for this fixture', () => {
    expect(Object.keys(libResult.library.elementsByType.Trigger)).toHaveLength(0)
  })

  it('parses FunctionCall elements with native references', () => {
    const calls = Object.values(libResult.library.elementsByType.FunctionCall)
    expect(calls).toHaveLength(7)
    expect(calls[0]?.functionDef?.library).toBe('Ntve')
    expect(calls[0]?.functionDef?.type).toBe('FunctionDef')
  })

  it('parses Param variable references', () => {
    const param = libResult.library.elementsByType.Param['36B53047']
    expect(param?.type).toBe('Param')
    expect(param?.variable?.id).toBe('0BBDCAF9')
    expect(param?.variable?.library).toBe('D970AA02')
  })

  it('parses subFunctions and subFunctionType metadata', () => {
    const loopCall = libResult.library.elementsByType.FunctionCall['6BF59D4B']
    expect(loopCall?.type).toBe('FunctionCall')
    expect(loopCall?.subFunctions).toHaveLength(1)
    expect(loopCall?.subFunctionType?.library).toBe('Ntve')
    expect(loopCall?.subFunctionType?.id).toBe('DF50D5F0')
  })

  it('preserves alternate subFunctionType ids on nested calls', () => {
    const nestedCall = libResult.library.elementsByType.FunctionCall['FDC44510']
    const actionCall = libResult.library.elementsByType.FunctionCall['F752AE58']
    expect(nestedCall?.subFunctionType?.id).toBe('AD43BC93')
    expect(actionCall?.subFunctionType?.id).toBe('363CE97C')
  })
})

describeWithNative('vs-test.SC2Mod with merged NativeLib', () => {
  it('resolves Ntve FunctionDef names after merging libraries', async () => {
    const nativeXml = readFileSync(nativePath, 'utf8')
    const nativeStrings = readFileSync(nativeStringsPath, 'utf8')

    const stringsMap = new Map<string, string>()
    stringsMap.set('Ntve', nativeStrings)
    stringsMap.set('D970AA02', triggerStrings)

    const results = await readTriggerLibraries([nativeXml, triggerXml], stringsMap)
    const ntve = results.get('Ntve')!.library

    const triggerDebugOutput = ntve.elementsByType.FunctionDef['00000118']
    expect(triggerDebugOutput?.name).toBe('TriggerDebugOutput')

    const setVariable = ntve.elementsByType.FunctionDef['00000136']
    expect(setVariable?.name).toBe('SetVariable')
    expect(setVariable?.isFuncAction).toBe(true)

    const ifThenElse = ntve.elementsByType.FunctionDef['00000137']
    expect(ifThenElse?.name).toBe('IfThenElse')
    expect(ifThenElse?.isSubFunction).toBe(true)

    const comparison = ntve.elementsByType.FunctionDef['C439C375']
    expect(comparison?.name).toBe('Comparison')
    expect(comparison?.flags).toContain('Operator')
  })
})
