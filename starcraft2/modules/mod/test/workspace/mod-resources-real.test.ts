import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Sc2DesktopContentSources } from '../../../game/battlenet/content-sources/local-content-sources.js'

const installation = process.env['MODKITX_SC2_ROOT'] ?? 'C:/Apps/StarCraft II'

describe.skipIf(process.env['MODKIT_TEST_TIER'] !== 'real' || !existsSync(join(installation, '.build.info')))(
  'installed SC2 effective Resources', () => {
    it('resolves Liberty through CASC with Core strings, Galaxy, styles and categories', { timeout: 300_000 }, async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'sc2-resources-'))
      const sources = new Sc2DesktopContentSources({
        installationDirectory: installation,
        documentsDirectory: scratch,
        battleNetCacheDirectory: scratch,
        sc2MapsCacheDirectory: scratch,
      })
      try {
        const context = await sources.openModContext({ schemaVersion: 1, target: {
          sourceId: 'local:casc', path: 'Mods/Liberty.SC2Mod',
        } })
        const started = Date.now()
        const root = await context.query({ kind: 'resources.tree', action: 'root' }) as { id: string; hasChildren: boolean }
        const categories = await context.query({ kind: 'resources.tree', action: 'children', node: root,
          page: { limit: 100 } }) as { items: { id: string; hasChildren: boolean }[] }
        const facts = await Promise.all(categories.items.map(node => context.query({
          kind: 'resources.tree', action: 'facts', node,
        }) as Promise<{ label: string; value?: number }>))
        console.log(`Liberty effective resources ${Date.now() - started} ms: ${facts.map(item => `${item.label}=${item.value}`).join(', ')}`)
        for (const name of ['GameData', 'Strings', 'Galaxy', 'Layouts', 'Asset aliases', 'EditorCategories', 'FontStyles']) {
          expect(facts.find(item => item.label === name)?.value, name).toBeGreaterThan(0)
        }
        const localeNodes = await context.query({ kind: 'resources.tree', action: 'children',
          node: { id: 'category/strings', hasChildren: true }, page: { limit: 100 },
        }) as { items: { id: string }[] }
        const coreLayer = context.layers.find(layer => /core\.sc2mod$/iu.test(layer.sourcePath))!
        const core = await sources.openModContext({ schemaVersion: 1, target: {
          sourceId: coreLayer.sourceId, path: coreLayer.sourcePath,
        } })
        try {
          const coreLocales = await core.query({ kind: 'resources.tree', action: 'children',
            node: { id: 'category/strings', hasChildren: true }, page: { limit: 100 },
          }) as { items: { id: string }[] }
          console.log(`Core/Liberty locales ${coreLocales.items.length}/${localeNodes.items.length}`)
          expect(localeNodes.items.map(item => item.id)).toEqual(expect.arrayContaining(
            coreLocales.items.map(item => item.id),
          ))
        } finally {
          await core.dispose()
        }
        const galaxy = categories.items[facts.findIndex(item => item.label === 'Galaxy')]!
        const galaxyStarted = Date.now()
        const symbolGroups = await context.query({ kind: 'resources.tree', action: 'children', node: galaxy,
          page: { limit: 100 } }) as { items: { id: string; hasChildren: boolean }[] }
        console.log(`Galaxy symbols indexed ${Date.now() - galaxyStarted} ms`)
        expect(symbolGroups.items.length).toBeGreaterThan(0)
        const layout = categories.items[facts.findIndex(item => item.label === 'Layouts')]!
        const layoutFiles = await context.query({ kind: 'resources.tree', action: 'children', node: layout,
          page: { limit: 1000 } }) as { items: { id: string; hasChildren: boolean }[] }
        const firstLayout = layoutFiles.items[0]!
        const sections = await context.query({ kind: 'resources.tree', action: 'children', node: firstLayout,
          page: { limit: 100 } }) as { items: { id: string; hasChildren: boolean }[] }
        const framesSection = sections.items.find(item => item.id.endsWith('/frames'))
        if (framesSection !== undefined) {
          const frames = await context.query({ kind: 'resources.tree', action: 'children', node: framesSection,
            page: { limit: 100 } }) as { items: { id: string; hasChildren: boolean }[] }
          const frame = frames.items.find(item => item.hasChildren)
          if (frame !== undefined) {
            const layoutStarted = Date.now()
            await context.query({ kind: 'resources.tree', action: 'children', node: frame,
              page: { limit: 100 } })
            console.log(`Layout template properties resolved ${Date.now() - layoutStarted} ms`)
          }
        }
        const data = categories.items[facts.findIndex(item => item.label === 'GameData')]!
        const namespaces = await context.query({ kind: 'resources.tree', action: 'children', node: data,
          page: { limit: 100 } }) as { items: { id: string; hasChildren: boolean }[] }
        const unit = namespaces.items.find(item => item.id === 'namespace/Unit')!
        const entities = await context.query({ kind: 'resources.tree', action: 'children', node: unit,
          page: { limit: 1000 } }) as { items: { id: string; hasChildren: boolean }[] }
        expect(entities.items.length).toBeGreaterThan(100)
        const marine = entities.items.find(item => item.id === 'entity/Unit/Marine')
        expect(marine).toBeDefined()
        expect(await context.query({ kind: 'resources.tree', action: 'facts', node: marine })).toMatchObject({
          kind: 'Unit', label: 'Marine',
          subjectId: expect.stringMatching(/liberty\.sc2mod.*unitdata\.xml/iu),
        })
        const fields = await context.query({ kind: 'resources.tree', action: 'children', node: marine,
          page: { limit: 1000 } }) as { items: { id: string; hasChildren: boolean }[] }
        const life = fields.items.find(item => item.id === 'field/Unit/Marine/LifeMax')
        expect(life).toBeDefined()
        expect(await context.query({ kind: 'resources.tree', action: 'facts', node: life })).toMatchObject({
          kind: 'data-field', label: 'LifeMax', preview: '45',
        })
        const searchStarted = Date.now()
        const missing = await context.query({ kind: 'resources.tree', action: 'search',
          node: root, pattern: '__modkit_missing_resource_20260925__',
        }) as { items: unknown[] }
        console.log(`Full resource search ${Date.now() - searchStarted} ms`)
        expect(missing.items).toEqual([])
        const marineSearch = await context.query({ kind: 'resources.tree', action: 'search',
          node: root, pattern: 'Marine',
        }) as { items: { id: string }[] }
        expect(marineSearch.items.length).toBeGreaterThan(0)
        const styles = categories.items[facts.findIndex(item => item.label === 'FontStyles')]!
        const styleSections = await context.query({ kind: 'resources.tree', action: 'children', node: styles,
          page: { limit: 10 } }) as { items: { id: string; hasChildren: boolean }[] }
        const styleNames = await context.query({ kind: 'resources.tree', action: 'children',
          node: styleSections.items.find(item => item.id === 'style-section/styles')!, page: { limit: 1 },
        }) as { items: { id: string; hasChildren: boolean }[] }
        expect(await context.query({ kind: 'resources.tree', action: 'facts', node: styleNames.items[0] }))
          .toMatchObject({ subjectId: expect.stringMatching(/core\.sc2mod.*fontstyles\.sc2style/iu) })
        await context.dispose()
      } finally {
        await sources.dispose()
        await rm(scratch, { recursive: true, force: true })
      }
    })
  },
)
