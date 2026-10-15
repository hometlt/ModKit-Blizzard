import { describe, it, expect } from 'vitest'
/* eslint-disable no-console -- diagnostic output is intentional in this test harness. */
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { parseTriggerStrings, applyTriggerStrings } from '@modkit/blizzard-starcraft2/triggers/document/trigger-strings.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../../..')
const triggerStringsPath = resolve(
  repoRoot,
  'assets/sc2-data-triggers/mods/core.sc2mod/enus.sc2data/LocalizedData/TriggerStrings.txt',
)
const triggerStrings = existsSync(triggerStringsPath)
  ? readFileSync(triggerStringsPath, 'utf8')
  : ''
const describeWithStrings = existsSync(triggerStringsPath) ? describe : describe.skip

describeWithStrings('parseTriggerStrings', () => {
  it('parses core TriggerStrings', () => {
    const names = parseTriggerStrings(triggerStrings)
    console.log('Parsed names:', names.size)

    // 11EB5EB1 = display name "Created Unit" (FunctionDef for EventUnitCreatedUnit)
    expect(names.get('Ntve_11EB5EB1')).toBe('Created Unit')
    // 2999701E = "Any Player" (PresetValue)
    expect(names.get('Ntve_2999701E')).toBe('Any Player')

    expect(names.size).toBeGreaterThan(10000)
  })

  it('applies names to elements', () => {
    const names = parseTriggerStrings(triggerStrings)
    const elements: Record<string, { name?: string; type: string }> = {
      '11EB5EB1': { type: 'FunctionDef', name: undefined },
      '2999701E': { type: 'PresetValue', name: undefined },
    }

    applyTriggerStrings('Ntve', elements, names)

    expect(elements['11EB5EB1'].name).toBe('Created Unit')
    expect(elements['2999701E'].name).toBe('Any Player')
  })
})
