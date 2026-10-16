import { describe, expect, it } from 'vitest'
import { commandIconsJson, planCommandIcons, readCommandIcon, type DataEntity, type IconExportContext } from '../../shared/export/command-icons.js'

/** Three buttons: one with an icon a layer holds, one whose icon no layer holds, one with no icon. */
const BUTTONS: DataEntity[] = [
  { entityId: 'MoveHoldPosition', fields: { Icon: 'Assets\\Textures\\btn-command-holdposition.dds' } },
  { entityId: 'Lost', fields: { Icon: 'Assets\\Textures\\btn-gone.dds' } },
  { entityId: 'Blank', fields: {} },
]

const context: IconExportContext = {
  async query(request) {
    const refs = (request as { refs: { namespace: string; entityId: string }[] }).refs
    return { entities: BUTTONS.filter(row => refs.some(ref => ref.namespace === 'Button' && ref.entityId === row.entityId)) }
  },
  async locate(path) {
    return path === 'Assets/Textures/btn-command-holdposition.dds' ? { layerId: 'base', path: 'base.sc2assets/assets/textures/btn-command-holdposition.dds' } : undefined
  },
  async read(layerId, path, maxBytes) {
    expect([layerId, maxBytes > 0]).toEqual(['base', true])
    return new TextEncoder().encode(path)
  },
}

describe('command card icons', () => {
  it('resolves Button.Icon through the context and reports what has none', async () => {
    const plan = await planCommandIcons(context, ['MoveHoldPosition', 'Lost', 'Blank', 'Nowhere', 'MoveHoldPosition'])
    expect(plan.icons).toEqual([{ button: 'MoveHoldPosition', icon: 'Assets\\Textures\\btn-command-holdposition.dds',
      layerId: 'base', path: 'base.sc2assets/assets/textures/btn-command-holdposition.dds' }])
    expect(plan.missing.map(item => item.button)).toEqual(['Lost', 'Blank', 'Nowhere'])
    expect(new TextDecoder().decode(await readCommandIcon(context, plan.icons[0]!))).toContain('holdposition')
    expect(commandIconsJson(plan)).toEqual({ moveholdposition: { button: 'MoveHoldPosition', icon: 'Assets\\Textures\\btn-command-holdposition.dds' } })
  })
})
