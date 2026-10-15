import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resolveContentSources } from '@modkit/host/node'

const installation = process.env.MODKITX_SC2_ROOT

it.skipIf(installation === undefined)('exposes stock DocumentInfo and resolves mods and campaigns through public Host sources', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'modkit-sc2-document-info-'))
  const configPath = join(scratch, 'sources.json')
  await writeFile(configPath, JSON.stringify({
    module: fileURLToPath(new URL('../../starcraft2/dist/modules/game/battlenet/content-sources/local-content-sources.js', import.meta.url)),
    extension: 'blizzard/starcraft2',
    options: { installationDirectory: installation, wizardDirectories: [] },
  }))
  const sources = await resolveContentSources({ extensionRoots: [], configPath, storage: scratch })
  if (sources === undefined) throw new Error('SC2 content source was not loaded')
  try {
    const context = await sources.openModContext?.({ schemaVersion: 1, target: {
      sourceId: 'local:casc', path: 'Mods/Void.SC2Mod/Base.SC2Data/GameData/AbilData.xml',
    } })
    if (context === undefined) throw new Error('Void context was not loaded')
    try {
      expect(context.unresolved).toEqual([])
      expect(context.layers.map(layer => [layer.sourcePath.toLowerCase(), layer.provenance])).toEqual([
        ['mods/core.sc2mod', 'declared'], ['mods/liberty.sc2mod', 'declared'],
        ['mods/swarm.sc2mod', 'declared'], ['mods/void.sc2mod', 'opened'],
      ])
      expect((await sources.list('local:casc', 'Mods/Void.SC2Mod')).some(file => file.name === 'DocumentInfo')).toBe(true)
      const bytes = await sources.read('local:casc', 'Mods/Void.SC2Mod/DocumentInfo', 4096)
      expect(new TextDecoder().decode(bytes)).toContain('<Value>file:Mods/Swarm.SC2Mod</Value>')
      const location = await context.locate('DocumentInfo')
      expect(location).toEqual({ layerId: context.layers.at(-1)!.id, path: 'DocumentInfo' })
      expect(await context.read(location!.layerId, location!.path, 4096)).toEqual(bytes)
      const answer = await context.query?.({ kind: 'data.entities', refs: [{ namespace: 'Unit', entityId: 'Marine' }] })
      expect(answer).toMatchObject({ entities: [{ entityId: 'Marine', fields: { LifeMax: 45 } }] })
    } finally { await context.dispose() }
    const campaign = await sources.openModContext?.({ schemaVersion: 1, target: {
      sourceId: 'local:casc', path: 'Campaigns/VoidStory.SC2Campaign',
    } })
    if (campaign === undefined) throw new Error('VoidStory context was not loaded')
    try {
      expect(campaign.unresolved).toEqual([])
      expect(campaign.layers.some(layer => layer.sourcePath.toLowerCase() === 'mods/void.sc2mod')).toBe(true)
      expect(await campaign.locate('DocumentInfo')).toBeDefined()
    } finally { await campaign.dispose() }
  } finally { await sources.dispose(); await rm(scratch, { recursive: true, force: true }) }
}, 180_000)
