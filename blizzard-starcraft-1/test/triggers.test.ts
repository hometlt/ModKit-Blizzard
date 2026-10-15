import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { InspectionTreeNode } from '@modkit/codec-kit'
import { authoredScenario, concat, section } from './sc1-fixtures.js'

const extension = join(import.meta.dirname, '..')
const { readTriggers } = (await import(pathToFileURL(join(extension, 'dist', 'chk', 'triggers.js')).href)) as typeof import('../dist/chk/triggers.js')
const { readScenario } = (await import(pathToFileURL(join(extension, 'dist', 'chk', 'scenario.js')).href)) as typeof import('../dist/chk/scenario.js')
const { scenarioTree } = (await import(pathToFileURL(join(extension, 'dist', 'chk', 'view.js')).href)) as typeof import('../dist/chk/view.js')

/**
 * One trigger for all players. Conditions: Always; Player 2 commands at least 10 of unit 0 (the
 * Marine — a real unit, not an empty field); Player 2 commands at most 0 Men (unit group 230).
 * Actions: Display Text Message of string 3 («Home»); a disabled Wait.
 */
function trig(): Uint8Array {
  const bytes = new Uint8Array(2400)
  const data = new DataView(bytes.buffer)
  bytes[15] = 22 // Always
  data.setUint32(20 + 4, 1, true)
  data.setUint32(20 + 8, 10, true)
  bytes[20 + 15] = 2 // Command
  data.setUint32(40 + 4, 1, true)
  data.setUint16(40 + 12, 230, true)
  bytes[40 + 14] = 1 // at most
  bytes[40 + 15] = 2
  const action = 320
  data.setUint32(action + 4, 3, true)
  bytes[action + 26] = 9 // Display Text Message
  data.setUint32(action + 32 + 12, 500, true)
  bytes[action + 32 + 26] = 4 // Wait
  bytes[action + 32 + 28] = 2 // disabled
  bytes[320 + 2048 + 4 + 17] = 1 // All Players
  return bytes
}

const children = (node: InspectionTreeNode) => (typeof node.children === 'function' ? node.children() : (node.children ?? []))

describe('StarCraft triggers', () => {
  it('reads the used slots of a trigger and who runs it', () => {
    const [trigger] = readTriggers(trig())
    expect(trigger!.players).toEqual([17])
    expect(trigger!.conditions.map(condition => condition.type)).toEqual([22, 2, 2])
    expect(trigger!.actions.map(action => [action.type, action.string, action.time, action.disabled])).toEqual([[9, 3, 0, false], [4, 0, 500, true]])
  })

  it('shows triggers in the scenario tree in the words of the editor', () => {
    const scenario = readScenario(concat(authoredScenario(), section('TRIG', trig())))
    const triggers = children(scenarioTree(scenario, 100)).find(node => node.label === 'Triggers')!
    expect(triggers.preview).toBe('1')
    const [trigger] = children(triggers)
    expect([trigger!.label, trigger!.preview]).toEqual(['Trigger 1', 'All Players; 3 conditions, 2 actions'])
    expect(children(trigger!).map(node => [node.kind, node.label, node.preview])).toEqual([
      ['condition', 'Always', ''],
      ['condition', 'Command', 'Player 2; at least 10; Unit 0'],
      ['condition', 'Command', 'Player 2; at most 0; Men'],
      ['action', 'Display Text Message', '«Home»'],
      ['action', 'Wait', '(disabled) 500 ms'],
    ])
  })
})
