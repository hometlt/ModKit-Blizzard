/**
 * Parity plan 5.7 on the installed game: a unit card opened from a mod's GameData XML shows what
 * the whole chain gives the unit. The mod depends on Liberty and changes only Marine's speed; the
 * host places the document in its mod context (`subjectCatalog`), and the card asks that context
 * for Marine and for what Marine references, so life and the Gauss Rifle's range come from Liberty.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import {
  TRUSTED_IN_PROCESS_EXECUTION_BACKEND,
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import { revisionId, type ArtifactByteSource } from '@modkit/sdk'
import { Sc2DesktopContentSources } from '../../game/battlenet/content-sources/local-content-sources.js'
import { entitySubjectId } from '../codecs/sc2data/src/entity-facts.js'

const installation = process.env['MODKITX_SC2_ROOT'] ?? 'C:/Apps/StarCraft II'
const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')

it.skipIf(!existsSync(join(installation, '.build.info')))(
  'a card from a mod file carries the values of the whole chain',
  { timeout: 600_000 },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'sc2-chain-card-'))
    const mod = join(scratch, 'Probe.SC2Mod')
    const unitData = join(mod, 'Base.SC2Data', 'GameData', 'UnitData.xml')
    await mkdir(join(mod, 'Base.SC2Data', 'GameData'), { recursive: true })
    await writeFile(join(mod, 'DocumentInfo'), '<?xml version="1.0" encoding="utf-8"?>\n<DocInfo>\n    <Dependencies>\n        <Value>bnet:Liberty (Mod)/0.0/999,file:Mods/Liberty.SC2Mod</Value>\n    </Dependencies>\n</DocInfo>\n')
    await writeFile(unitData, '<?xml version="1.0" encoding="utf-8"?>\n<Catalog>\n    <CUnit id="Marine">\n        <Speed value="3"/>\n    </CUnit>\n</Catalog>\n')
    const sources = new Sc2DesktopContentSources({
      installationDirectory: installation,
      documentsDirectory: scratch,
      battleNetCacheDirectory: scratch,
      sc2MapsCacheDirectory: scratch,
    })
    try {
      const inventory = await buildInventory(
        [{ ...(await loadExtensionDirectory(join(repoRoot, 'starcraft2'))), execution: { origin: 'bundled', allowTrustedInProcess: true } }],
        createHostContributionContractRegistry(),
      )
      const bytes = new Uint8Array(await readFile(unitData))
      const uri = pathToFileURL(unitData).href
      const source: ArtifactByteSource = {
        kind: 'bytes',
        ref: { id: uri, uri },
        revision: revisionId('provider-token:chain-card'),
        size: BigInt(bytes.byteLength),
        read: async (offset, length) => bytes.slice(Number(offset), Number(offset) + length),
        async *stream() {
          yield bytes
        },
      }
      const opened = await openSubject({
        inventory,
        source,
        path: 'UnitData.xml',
        intent: 'full',
        target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
        grant: { id: 'chain-card', classes: ['read-source'] },
        executionBackends: createExecutionBackendRegistry([TRUSTED_IN_PROCESS_EXECUTION_BACKEND]),
        budget: { maxInputBytes: 16_777_216n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 16_777_216, maxDiagnostics: 100 },
        subjectCatalog: { contentSources: async () => sources as never },
      })
      if (opened.state !== 'opened') throw new Error(`open failed: ${JSON.stringify(opened).slice(0, 600)}`)
      try {
        const selector = await opened.session.dataSource('common.view/subject-selector-source', 1)
        const card = (await (selector.value as any).openFacts(entitySubjectId('Unit', 'Marine'))).value
        const stats = (await card.facts('stats', { limit: 20 })).items as { id: string; value: unknown }[]
        // Life from Liberty, speed from the mod.
        expect(stats.find(item => item.id === 'life')?.value).toBe(45)
        expect(stats.find(item => item.id === 'speed')?.value).toBe(3)
        const weapons = (await card.facts('weapons', { limit: 10 })).items as { value: { range?: number } }[]
        expect(weapons[0]?.value.range).toBe(5)
        await selector.release()
      } finally {
        await opened.session.dispose()
      }
    } finally {
      await sources.dispose()
      await rm(scratch, { recursive: true, force: true })
    }
  },
)
