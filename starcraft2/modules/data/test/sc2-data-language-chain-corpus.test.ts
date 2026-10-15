/**
 * Plan 1.23 on the installed game: a mod's GameData checked against its whole chain, the way the LSP
 * checks it. The host projects the mod's closure (Core → Liberty → Swarm → Void from CASC) into the
 * language snapshot; with all of it in, the names the chain declares resolve and only names nobody
 * declares are reported. It took three fixes: the walk stopped inside Core (core d3a1cc18), no layer
 * carried a fingerprint (b6b2ea2e) and `local:casc` listed files of locales not installed (391f4efe);
 * each left the snapshot incomplete, and an incomplete snapshot reports no unresolved name at all.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildInventory, createHostContributionContractRegistry, resolveContentLanguageSources } from '@modkit/host'
import { languageProviderRoutes } from '@modkit/host/language'
import { loadExtensionDirectory } from '@modkit/host/node'
import type { LanguageProvider } from '@modkit/sdk'
import { Sc2DesktopContentSources } from '../../game/battlenet/content-sources/local-content-sources.js'

const installation = process.env['MODKITX_SC2_ROOT'] ?? 'C:/Apps/StarCraft II'
const extension = new URL('../../../', import.meta.url)

// `GuassRifle` is how Liberty's WeaponData spells the Marine's weapon.
const UNITS = `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
  <CUnit id="ProbeKnown" parent="Marine">
    <WeaponArray Link="GuassRifle"/>
    <Race value="Zerg"/>
    <Footprint value="Footprint3x3"/>
  </CUnit>
  <CUnit id="ProbeUnknown" parent="NoSuchParentXyz">
    <WeaponArray Link="NoSuchWeaponXyz"/>
  </CUnit>
</Catalog>
`

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] === '0' || !existsSync(join(installation, '.build.info')))(
  'SC2 Data language over the installed chain', () => {
    it('resolves what Void declares and reports only names nobody declares', { timeout: 300_000 }, async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'sc2-data-chain-'))
      const sources = new Sc2DesktopContentSources({
        installationDirectory: installation,
        documentsDirectory: scratch,
        battleNetCacheDirectory: scratch,
        sc2MapsCacheDirectory: scratch,
      })
      try {
        const mod = join(scratch, 'Probe.SC2Mod')
        await mkdir(join(mod, 'Base.SC2Data', 'GameData'), { recursive: true })
        await writeFile(join(mod, 'DocumentInfo'),
          '<?xml version="1.0" encoding="utf-8"?>\n<DocInfo><Dependencies><Value>bnet:Void (Mod)/0.0/999,file:Mods/Void.SC2Mod</Value></Dependencies></DocInfo>\n')
        const path = join(mod, 'Base.SC2Data', 'GameData', 'UnitData.xml')
        await writeFile(path, UNITS)
        const document = { uri: pathToFileURL(path).href, languageId: 'sc2-data', version: 1, text: UNITS }

        const loaded = await loadExtensionDirectory(fileURLToPath(extension))
        const inventory = await buildInventory(
          [{ ...loaded, execution: { origin: 'bundled', allowTrustedInProcess: true } }],
          createHostContributionContractRegistry(),
        )
        const resolved = await resolveContentLanguageSources({
          contentSources: sources,
          routes: languageProviderRoutes(inventory),
          limits: { maxDocumentBytes: 16 << 20, maxWorkspaceBytes: 64 << 20, maxEntries: 65_536 },
          subjects: [{ descriptor: { subjectUri: pathToFileURL(mod).href } }],
        })
        expect(resolved.dependenciesComplete).toBe(true)
        const snapshot = await resolved.sources[0]!.snapshot({
          document,
          workspaceDocuments: [document],
          workspaceDocumentOrigins: [],
          workspaceLanguageIds: ['sc2-data'],
          maxDocuments: 1023,
          signal: new AbortController().signal,
        })
        // Every layer's GameData is in, not only Core's.
        expect(snapshot.isComplete).toBe(true)
        expect(snapshot.documents.some(item => /void\.sc2mod\/base\.sc2data\/gamedata\/unitdata\.xml$/iu.test(item.uri))).toBe(true)

        const { createProvider } = (await import(
          new URL('modules/data/providers/language/runtime.js', extension).href
        )) as { createProvider(selection: { contract: string; major: number }): { value: LanguageProvider } }
        const provider = createProvider({ contract: 'common.language/document-analysis', major: 1 }).value
        const result = await provider.diagnostics!({
          document,
          workspaceDocuments: [document, ...snapshot.documents],
          workspaceIncomplete: !snapshot.isComplete,
          ...(snapshot.workspaceContext === undefined ? {} : { workspaceContext: snapshot.workspaceContext }),
          maxResults: 200,
          maxDocuments: 1024,
        } as never)
        const messages = result.diagnostics.map(item => item.message)
        expect(messages.filter(message => /\b(Marine|GuassRifle|Zerg|Footprint3x3)\b/u.test(message))).toEqual([])
        expect(messages.some(message => message.includes('NoSuchParentXyz'))).toBe(true)
        expect(messages.some(message => message.includes('NoSuchWeaponXyz'))).toBe(true)
      } finally {
        await sources.dispose()
        await rm(scratch, { recursive: true, force: true })
      }
    })
  })
