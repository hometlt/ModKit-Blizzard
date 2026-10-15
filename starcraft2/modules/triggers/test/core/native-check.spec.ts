/* eslint-disable no-console -- diagnostic output is intentional in this test harness. */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { readTriggerLibrary, readTriggerLibraries } from '@modkit/blizzard-starcraft2/triggers/document/reader.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../..')
const nativePath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/base.sc2data/TriggerLibs/NativeLib.TriggerLib',
)
const dpanPath = resolve(repoRoot, 'testdata/vs-spawn-panel.SC2Mod/Triggers')
const nativeXml = existsSync(nativePath) ? readFileSync(nativePath, 'utf8') : ''
const dpanXml = existsSync(dpanPath) ? readFileSync(dpanPath, 'utf8') : ''
const describeWithNative = existsSync(nativePath) ? describe : describe.skip
const itWithDpan = existsSync(dpanPath) ? it : it.skip

describeWithNative('NativeLib', () => {
  it('parses NativeLib.TriggerLib', async () => {
    const result = await readTriggerLibrary(nativeXml)
    console.log('Library ID:', result.library.id)
    console.log('Element count:', Object.keys(result.library.elements).length)

    const types = new Map()
    for (const el of Object.values(result.library.elements)) {
      types.set(el.type, (types.get(el.type) ?? 0) + 1)
    }
    console.log('Types:', Object.fromEntries(types))

    expect(result.library.id).toBe('Ntve')
    expect(Object.keys(result.library.elements).length).toBeGreaterThan(1000)
  }, 30000)

  itWithDpan('loads multiple libraries with cross-library resolution', async () => {
    const results = await readTriggerLibraries([nativeXml, dpanXml])

    expect(results.has('Ntve')).toBe(true)
    expect(results.has('DPAN')).toBe(true)

    const ntve = results.get('Ntve')!
    const dpan = results.get('DPAN')!

    console.log('Ntve elements:', Object.keys(ntve.library.elements).length)
    console.log('DPAN elements:', Object.keys(dpan.library.elements).length)

    // Проверим, что DPAN может ссылаться на Ntve элементы
    // Найдём FunctionCall в DPAN, который ссылается на Ntve FunctionDef
    const dpanFuncCalls = Object.values(dpan.library.elementsByType.FunctionCall)
    const crossLibCall = dpanFuncCalls.find(fc => {
      const funcDef = fc.functionDef
      return funcDef && funcDef.library === 'Ntve'
    })

    if (crossLibCall) {
      console.log(
        'Cross-lib call found:',
        crossLibCall.id,
        '→ funcDef:',
        crossLibCall.functionDef?.id,
      )
      // Проверим, что Ntve элемент доступен
      const ntveFuncDef = ntve.library.elementsByType.FunctionDef[crossLibCall.functionDef!.id]
      expect(ntveFuncDef).toBeDefined()
      expect(ntveFuncDef.type).toBe('FunctionDef')
    }
  })
})
