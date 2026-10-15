import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  artifactNamespaceSourceFromVfsMount,
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openNestedSubject,
  openSubject,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import type { ModelResourceRef, ModelResourceRefsSource } from '@modkit/sdk'
import { resolveModelViewerTextures } from '@modkit/ui/model'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'

/**
 * Evidence route for textured Diablo III models, the one the VS Code model viewer takes: an
 * appearance opened inside the installed CASC publishes its texture references, and the subject's
 * own raster port resolves each `Textures/<sno>.tex` in the same storage and decodes it through
 * the TEX codec. Nothing here names a codec or builds a path. The same open attaches the
 * animations the game links to the appearance (actor → AnimSet → Anim), read through the
 * subject's logical resources; the hero's clips must reach the exported UVM, each with channels.
 *
 * MODKIT_D3_TEXTURED — comma-separated appearance basenames.
 */
const extension = join(import.meta.dirname, '..')
const { discoverDiablo3Installations } = (await import(
  pathToFileURL(join(extension, 'dist', 'game', 'installation.js')).href
)) as typeof import('../dist/game/installation.js')

const basenames = (
  process.env['MODKIT_D3_TEXTURED'] ??
  'barbarian_male.app,a2dun_zolt_tesla_tower.app,breakable_painting_c.app'
).split(',')
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'diablo3-textured-model-corpus', classes: ['read-source'] } as const
const budget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  maxNodes: 2_000_000,
  maxScalarBytes: 268_435_456,
  maxDiagnostics: 1000,
}

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1')(
  'installed Diablo III appearances with their textures',
  () => {
    it('resolves every material texture through the subject raster port', async () => {
      const installation = (
        await discoverDiablo3Installations({ gameId: 'blizzard/diablo-3', maxCandidates: 16 })
      ).installations[0]
      if (installation === undefined)
        throw new Error('no Diablo III installation discovered (set MODKIT_DIABLO3_ROOT)')
      const inventory = await buildInventory(
        await Promise.all(
          [join(extension, '..', 'casc'), extension].map(async root => ({
            ...(await loadExtensionDirectory(root)),
            execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
          })),
        ),
        createHostContributionContractRegistry(),
      )
      const executionBackends = createExecutionBackendRegistry([
        {
          profile: 'trusted-in-process',
          supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
          async activate(context) {
            return {
              module: (await import(context.entrypoint.href)) as Record<string, unknown>,
              release: async () => undefined,
            }
          },
        },
      ])
      const common = { inventory, executionBackends, target, grant, budget, intent: 'full' as const }
      const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
      const mount = await vfs.openMount(pathToFileURL(installation.normalizedPath).href)
      const casc = await openSubject({
        ...common,
        source: artifactNamespaceSourceFromVfsMount(mount),
        path: installation.normalizedPath,
      })
      if (casc.state !== 'opened') throw new Error(`CASC did not open: ${casc.state}`)
      const receipt: Record<string, { references: number; textures: string[]; clips: number }> = {}
      try {
        const namespace = await casc.session.dataSource('common.view/namespace-entry-source', 1)
        const found = await namespace.value
          .search?.({ kind: 'basename-any', caseSensitive: false, basenames }, { limit: basenames.length })
          .finally(() => namespace.release())
        expect(found?.items.length).toBe(basenames.length)
        for (const entry of found?.items ?? []) {
          const app = (
            await openNestedSubject({
              ...common,
              parent: casc.session,
              entryId: entry.id,
              logicalRoots: [{ rootId: 'installation', pathPrefix: '' }],
            })
          ).result
          if (app.state !== 'opened') throw new Error(`${entry.path} did not open: ${JSON.stringify(app).slice(-1500)}`)
          try {
            const refs = await app.session.dataSource('common.view/model-resource-refs-source', 1)
            const source = refs.value as ModelResourceRefsSource
            const references: ModelResourceRef[] = []
            try {
              let cursor: string | undefined
              do {
                const page = await source.references({ limit: 256, ...(cursor === undefined ? {} : { cursor }) })
                references.push(...page.items)
                cursor = page.nextCursor
              } while (cursor !== undefined)
            } finally {
              await refs.release()
            }
            if (app.rasterResources === undefined) throw new Error(`${entry.path} has no raster port`)
            const textures = await resolveModelViewerTextures(app.rasterResources, references)
            const animation = await app.session
              .dataSource('common.view/model-animation-source', 1)
              .catch(() => undefined)
            const clips = animation === undefined ? undefined : await animation.value.info().finally(() => animation.release())
            receipt[entry.name] = {
              references: references.length,
              textures: [...textures.entries()].map(([id, texture]) => `${id} ${texture.width}x${texture.height}`),
              clips: clips?.clips ?? 0,
            }
            if (entry.name === 'barbarian_male.app') {
              expect(clips?.clips).toBeGreaterThan(0)
              // the viewer plays the exported UVM, whose rig drops any channel glTF cannot sample
              const exported = await app.session
                .operations()
                .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
              if (exported.state !== 'ok' || exported.output.kind !== 'bytes') throw new Error('model-export-uvm failed')
              const bytes = exported.output.value
              const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true)
              const document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as {
                animations?: { channels: unknown[] }[]
              }
              expect(document.animations?.length).toBe(clips?.clips)
              expect(document.animations?.every(item => item.channels.length > 0)).toBe(true)
            }
            expect(references.length).toBeGreaterThan(0)
            expect(textures.size).toBe(new Set(references.map(reference => reference.id)).size)
          } finally {
            await app.session.dispose()
          }
        }
      } finally {
        await casc.session.dispose()
        console.log('Diablo III textured models:', JSON.stringify(receipt))
      }
    })
  },
)
