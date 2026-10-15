import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSubjectEditing, nestedSubjectServices, openNestedSubject } from '@modkit/host'
import { createFileEditingBackend, createModkit, openPathArtifactSource } from '@modkit/host/node'
import { describe, expect, it } from 'vitest'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const budget = Object.freeze({
  maxInputBytes: 4_000_000n,
  maxDepth: 32,
  maxNodes: 100_000,
  maxScalarBytes: 1_000_000,
  maxDiagnostics: 100,
})

describe('SC2 campaign native host authoring', () => {
  it('commits a CampaignData field and supports stale refusal, undo, and redo', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sc2-campaign-host-'))
    const campaignPath = join(scratch, 'Story.SC2Campaign')
    const campaignDataPath = join(campaignPath, 'Base.SC2Data', 'GameData', 'CampaignData.xml')
    mkdirSync(join(campaignPath, 'Base.SC2Maps'), { recursive: true })
    mkdirSync(join(campaignPath, 'Base.SC2Data', 'GameData'), { recursive: true })
    writeFileSync(join(campaignPath, 'ComponentList.SC2Components'), '<Components/>')
    const original = encoder.encode([
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Catalog>',
      '  <!-- preserve this unknown authored content -->',
      '  <CCampaign id="Story">',
      '    <CampaignData><LaunchMap value="Maps/Story.SC2Map"/></CampaignData>',
      '  </CCampaign>',
      '</Catalog>',
      '',
    ].join('\n'))
    writeFileSync(campaignDataPath, original)
    // The checked-in VFS package predates bigint mtime tokens; an integral fixture timestamp keeps
    // this downstream test deterministic while the core package carries the precision fix.
    utimesSync(campaignPath, 1_700_000_000, 1_700_000_000)

    const host = await createModkit({
      extensions: [resolve(import.meta.dirname, '../../..')],
      roots: [scratch],
    })
    const backend = createFileEditingBackend({ roots: [scratch] })
    const grant = {
      id: 'sc2-campaign-authoring-host',
      classes: ['read-source', 'write-source'],
    } as const
    const sessions: { dispose(): Promise<void> }[] = []
    try {
      const open = async () => {
        const opened = await host.services.open({
          source: await openPathArtifactSource(campaignPath),
          path: campaignPath,
          intent: 'full',
          grant,
          budget,
        })
        if (opened.state !== 'opened') {
          throw new Error(`Loose SC2 campaign did not open: ${JSON.stringify(opened)}`)
        }
        expect(opened.selected.contributionId).toBe('blizzard/sc2-campaign-directory')
        sessions.push(opened.session)
        return opened
      }

      const openCampaignData = async () => {
        const parent = await open()
        const nested = await openNestedSubject({
          parent: parent.session,
          entryId: 'Base.SC2Data/GameData/CampaignData.xml',
          ...nestedSubjectServices(host.services),
          grant,
          budget,
          intent: 'full',
        })
        if (nested.result.state !== 'opened') {
          throw new Error(`Nested CampaignData.xml did not open: ${JSON.stringify(nested.result)}`)
        }
        expect(nested.result.selected.contributionId).toBe('blizzard/sc2-campaign-data')
        sessions.push(nested.result.session)
        return nested.result
      }

      const opened = await openCampaignData()
      const invoked = await opened.session.operations().invoke('edit-campaign-data', {
        campaignId: 'Story',
        field: 'progressAchievement',
        value: 'StoryComplete',
      })
      expect(invoked.state).toBe('ok')
      if (invoked.state !== 'ok') throw new Error('CampaignData edit did not run')

      const editing = createSubjectEditing({
        opened,
        grant,
        backendFor: () => backend,
        evidenceFor: () => ({
          roundTrip: 'byte-identical',
          preservesUnknownData: true,
          evidenceId: 'sc2-campaign-authoring-host-v1',
          corpusId: 'sc2-campaign-authoring-host',
          corpusDigest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
          conformanceProfile: 'modkit/codec-contribution-v1',
          writer: {
            providerId: 'blizzard/sc2-campaign-data',
            providerVersion: '1.0.0',
            artifactDigest: host.services.inventory.extensions[0]?.contributions.find(
              item => item.manifest?.id === 'blizzard/sc2-campaign-data',
            )?.record?.artifactDigest,
            formatId: 'sc2-campaign-data',
            representationId: 'source',
          },
          optionsFingerprint: 'campaign-data-scalar-v1',
          inputClass: 'synthetic-loose-campaign',
          provenAt: '2026-09-13T00:00:00Z',
        }) as never,
      })
      const plan = editing.planFromOperation(invoked.output)
      expect(plan.targets[0]?.ownerSource.uri).toContain('CampaignData.xml')
      const prepared = await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })
      if (prepared.state !== 'ready') {
        throw new Error(`CampaignData plan did not prepare: ${JSON.stringify(prepared)}`)
      }
      const committed = await editing.coordinator.commit(prepared.prepared, {
        grant: editing.grantSnapshot,
      })
      expect(committed.state).toBe('committed')
      if (committed.state !== 'committed') throw new Error('CampaignData plan did not commit')

      const written = readFileSync(campaignDataPath, 'utf8')
      expect(written).toContain('ProgressAchievement="StoryComplete"')
      expect(written).toContain('<!-- preserve this unknown authored content -->')

      expect((await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })).state)
        .toBe('conflict')
      expect((await editing.coordinator.undo(committed.receipt.transactionId, {
        grant: editing.grantSnapshot,
      })).state).toBe('committed')
      expect(new Uint8Array(readFileSync(campaignDataPath))).toEqual(original)
      expect((await editing.coordinator.redo(committed.receipt.transactionId, {
        grant: editing.grantSnapshot,
      })).state).toBe('committed')
      expect(decoder.decode(readFileSync(campaignDataPath))).toContain(
        'ProgressAchievement="StoryComplete"',
      )
    } finally {
      for (const session of sessions) await session.dispose()
      await backend.dispose()
      await host.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 120_000)
})
