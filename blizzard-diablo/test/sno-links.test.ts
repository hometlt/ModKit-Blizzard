import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { snoLinks } = (await import(pathToFileURL(join(import.meta.dirname, '..', 'dist', 'diablo3-sno', 'sno-links.js')).href)) as typeof import('../dist/diablo3-sno/sno-links.js')

it('links a file to each SNO it names, with the hardpoints an effect spawns at', async () => {
  const text = (value: string) => ({ kind: 'text' as const, type: 'DT_CHARARRAY', value })
  const hardpoint = (name: string) => ({ kind: 'structure' as const, type: 'HardpointLink', members: [{ offset: 0, label: 'DT_CHARARRAY@0x0', value: text(name) }] })
  const event = {
    kind: 'structure' as const,
    type: 'TriggerEvent',
    members: [
      { offset: 0x2c, label: 'SNOName@0x2c', value: { kind: 'structure' as const, type: 'SNOName', members: [{ offset: 4, label: 'DT_SNONAME_HANDLE@0x4', value: { kind: 'sno' as const, group: 27, id: 500 } }] } },
      { offset: 0x44, label: 'DT_FIXEDARRAY<HardpointLink>@0x44', value: { kind: 'array' as const, type: 'DT_FIXEDARRAY', element: 'HardpointLink', length: 2, items: [hardpoint('Bip01 R Hand'), hardpoint('- None -')] } },
    ],
  }
  const root = {
    kind: 'structure' as const,
    type: 'EffectGroup',
    members: [
      { offset: 0x20, label: 'DT_VARIABLEARRAY<EffectItem>@0x20', value: { kind: 'array' as const, type: 'DT_VARIABLEARRAY', element: 'EffectItem', length: 1, items: [{ kind: 'structure' as const, type: 'EffectItem', members: [{ offset: 0x44, label: 'MsgTriggeredEvent@0x44', value: { kind: 'structure' as const, type: 'MsgTriggeredEvent', members: [{ offset: 4, label: 'TriggerEvent@0x4', value: event }] } }] }] } },
      { offset: 0x34, label: 'DT_SNO@0x34', name: 'snoPower', value: { kind: 'sno' as const, group: 29, id: 7 } },
      { offset: 0x38, label: 'DT_SNO@0x38', value: { kind: 'sno' as const, group: 29, id: -1 } },
    ],
  }
  const graph = snoLinks(root, { group: 'EffectGroup', snoId: 1 }, { 27: '.prt', 29: '.pow' }, 'test')
  expect((await graph.edges({ limit: 10 })).items).toEqual([
    { from: 'sno:EffectGroup:1', to: 'sno:.prt:500', role: 'EffectItem[0] · at Bip01 R Hand' },
    { from: 'sno:EffectGroup:1', to: 'sno:.pow:7', role: 'snoPower' },
  ])
  expect((await graph.summary()).types.map(type => type.id)).toEqual(['EffectGroup', 'pow', 'prt'])
})
