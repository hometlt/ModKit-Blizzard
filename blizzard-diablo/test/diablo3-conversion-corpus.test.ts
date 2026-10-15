import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  artifactNamespaceSourceFromVfsMount,
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openNestedSubject,
  openSubject,
  registerServiceDefinitionsOrThrow,
} from '@modkit/host'
import { createFilesystemInputResolver, loadExtensionDirectory, openFileArtifactSource } from '@modkit/host/node'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'

/**
 * Evidence route for the model conversion matrix on the installed game: a Diablo III appearance
 * from CASC exports UVM, the core UVM codec reopens it, and `model.export-native` reaches each
 * target's native encoder through the host capability — no encoder is imported here. Every output
 * is then reopened by the target's own codec.
 *
 * MODKIT_D3_CONVERT — comma-separated appearance basenames (default: a skinned level piece with
 * 37 joints, a static prop, and the hero barbarian_male.app with the 90 clips its actor links).
 */
const extension = join(import.meta.dirname, '..')
const blizzard = join(extension, '..')
const workspace = join(blizzard, '..')
const { discoverDiablo3Installations } = (await import(
  pathToFileURL(join(extension, 'dist', 'game', 'installation.js')).href
)) as typeof import('../dist/game/installation.js')

const basenames = (
  process.env['MODKIT_D3_CONVERT'] ??
  'a2dun_zolt_tesla_tower.app,breakable_painting_c.app,barbarian_male.app'
).split(',')
// PIE has no skeletal skinning; its encoder bakes a skinned model to bind-pose levels only when
// asked, and reports that loss as a diagnostic.
const targets = [
  { formatId: 'm3', file: 'out.m3', options: undefined },
  { formatId: 'war3-mdx', file: 'out.mdx', options: undefined },
  { formatId: 'warzone-pie', file: 'out.pie', options: { bakeSkin: true } },
] as const
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'diablo3-conversion-corpus', classes: ['read-source'] } as const
const budget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  maxNodes: 2_000_000,
  maxScalarBytes: 268_435_456,
  maxDiagnostics: 1000,
}

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1')(
  'installed Diablo III appearances through the conversion matrix',
  () => {
    it('reach M3, MDX and PIE through the host native-encoder route', async () => {
      const installation = (
        await discoverDiablo3Installations({ gameId: 'blizzard/diablo-3', maxCandidates: 16 })
      ).installations[0]
      if (installation === undefined)
        throw new Error('no Diablo III installation discovered (set MODKIT_DIABLO3_ROOT)')

      const roots = [
        join(blizzard, 'casc'),
        extension,
        join(blizzard, 'models'),
        join(blizzard, 'blizzard-warcraft-3'),
        join(workspace, 'modkit-extensions-warzone'),
        join(workspace, 'modkit-core', 'extensions', 'models'),
      ]
      const inventory = await buildInventory(
        await Promise.all(
          roots.map(async root => ({
            ...(await loadExtensionDirectory(root)),
            execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
          })),
        ),
        createHostContributionContractRegistry(),
      )
      const serviceDefinitions = createBundledServiceDefinitionRegistry()
      await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
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
      const common = { inventory, executionBackends, serviceDefinitions, target, grant, budget, intent: 'full' as const }
      const openFile = async (path: string, directory: string) => {
        const opened = await openSubject({
          ...common,
          source: await openFileArtifactSource(path),
          path,
          resolveInput: createFilesystemInputResolver({ primaryPath: path, roots: [directory], inventory }),
        })
        if (opened.state !== 'opened')
          throw new Error(`${path} did not open: ${opened.reason} ${JSON.stringify(opened.diagnostics ?? []).slice(0, 600)}`)
        return opened
      }

      const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
      const mount = await vfs.openMount(pathToFileURL(installation.normalizedPath).href)
      const casc = await openSubject({
        ...common,
        source: artifactNamespaceSourceFromVfsMount(mount),
        path: installation.normalizedPath,
      })
      if (casc.state !== 'opened') throw new Error(`CASC did not open: ${casc.state}`)
      const directory = await mkdtemp(join(tmpdir(), 'modkit-d3-convert-'))
      const matrix: Record<string, Record<string, number>> = {}
      try {
        const namespace = await casc.session.dataSource('common.view/namespace-entry-source', 1)
        const found = await namespace.value
          .search?.({ kind: 'basename-any', caseSensitive: false, basenames }, { limit: basenames.length })
          .finally(() => namespace.release())
        expect(found?.items.map(item => item.name.toLowerCase()).sort()).toEqual([...basenames].sort())

        for (const entry of found?.items ?? []) {
          const app = (await openNestedSubject({ ...common, parent: casc.session, entryId: entry.id })).result
          if (app.state !== 'opened') throw new Error(`${entry.path} did not open`)
          const exported = await app.session
            .operations()
            .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
          await app.session.dispose()
          if (exported.state !== 'ok' || exported.output.kind !== 'bytes')
            throw new Error(`${entry.path} model-export-uvm: ${JSON.stringify(exported).slice(0, 300)}`)

          const uvmPath = join(directory, 'input.uvm.glb')
          await writeFile(uvmPath, exported.output.value)
          const uvm = await openFile(uvmPath, directory)
          matrix[entry.name] = {}
          try {
            expect(uvm.selected.contributionId).toBe('modkit/model-uvm')
            const operation = (await uvm.session.descriptor()).operations.find(
              item => item.id === 'model.export-native',
            )
            if (operation?.state !== 'available') throw new Error('model.export-native unavailable')
            for (const { formatId, file, options } of targets) {
              const result = await uvm.session
                .operations()
                .invoke(operation.handlerId, { schemaVersion: 1, formatId, ...(options === undefined ? {} : { options }) })
              if (result.state !== 'ok' || result.output.kind !== 'bytes')
                throw new Error(`${entry.name} -> ${formatId}: ${JSON.stringify(result).slice(0, 300)}`)
              const outPath = join(directory, file)
              await writeFile(outPath, result.output.value)
              const readBack = await openFile(outPath, directory)
              try {
                expect(readBack.descriptor.identity.formatId).toBe(formatId)
              } finally {
                await readBack.session.dispose()
              }
              matrix[entry.name]![formatId] = result.output.value.byteLength
            }
          } finally {
            await uvm.session.dispose()
          }
        }
      } finally {
        await casc.session.dispose()
        await rm(directory, { recursive: true, force: true })
        console.log('Diablo III conversion matrix (bytes):', JSON.stringify(matrix))
      }
    })
  },
)
