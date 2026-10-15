/**
 * `blizzard/wow-m2` on the installed game: each corpus model is read from the WoW content source as
 * `filedataid/<id>` and opened the way VS Code opens a file of a content source — `openSubject` with
 * the host's content-source companion resolver — so its skin and `.anim` files arrive through the
 * host, not through this test. Then `model.export-uvm` and the UVM reader.
 *
 * Runs only with `MODKIT_TEST_INSTALLED_CORPUS=1`; the installation comes from discovery or
 * `MODKIT_WOW_ROOT`, the listfile/key cache from `MODKIT_INDEX_CACHE_DIRECTORY` (optional: models
 * are addressed by FileDataID, which needs no names). Encrypted files are counted, not failed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildInventory,
  createContentAssetOrigin,
  createContentSourceInputResolver,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
} from '@modkit/host'
import { createNodeInstallationProbes, loadExtensionDirectory } from '@modkit/host/node'
import { revisionId, type ArtifactByteSource, type AssetInput, type Codec, type LogicalResourcePort, type ModelSceneSource, type ResourceBudget } from '@modkit/sdk'
import { readUvmContainer } from '@modkit/uv/model/container'

const extension = join(import.meta.dirname, '..')
const { createContentSources } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'content-sources.js')).href)) as typeof import('../src/game/content-sources.js')
const { discoverWowInstallations } = (await import(pathToFileURL(join(extension, 'dist', 'game', 'installation.js')).href)) as typeof import('../src/game/installation.js')

/** Corpus by FileDataID (stable game ids): creatures, a boss, a pet, a mount, a character. */
const CORPUS: readonly (readonly [number, string])[] = (process.env['MODKIT_WOW_M2_ONLY'] === undefined ? (x: readonly (readonly [number, string])[]) => x : (x: readonly (readonly [number, string])[]) => x.filter(([id]) => String(id) === process.env['MODKIT_WOW_M2_ONLY']))([
  [123288, 'creature/cow/cow.m2'],
  [126487, 'creature/wolf/wolf.m2'],
  [125024, 'creature/murloc/murloc.m2'],
  [124691, 'creature/kobold/kobold.m2'],
  [123040, 'creature/bear/bear.m2'],
  [122877, 'creature/airelemental/airelemental.m2'],
  [1968538, 'creature/aqir/aqir.m2'],
  [1338861, 'creature/batpet/batpet.m2'],
  [2395765, 'creature/crabmount/crabmount.m2'],
  [1599045, 'creature/aggramar/aggramar.m2'],
  [234497, 'creature/alexstrasza/alexstrasza.m2'],
  [1361769, 'creature/dragonwhelpnightmare/dragonwhelpnightmare.m2'],
  [1011653, 'character/human/male/humanmale_hd.m2'],
])

const budget: ResourceBudget = { maxInputBytes: 268_435_456n, maxDepth: 64, maxNodes: 1_000_000, maxScalarBytes: 268_435_456, maxDiagnostics: 1000 }
const target = { environment: 'node' as const }

async function installation(): Promise<string> {
  const configured = process.env['MODKIT_WOW_ROOT']
  if (configured !== undefined) return configured
  const found = (await discoverWowInstallations({ gameId: 'blizzard/world-of-warcraft', maxCandidates: 8 }, createNodeInstallationProbes())).installations[0]
  if (found === undefined) throw new Error('no World of Warcraft installation discovered (set MODKIT_WOW_ROOT)')
  return found.installPath
}

/** The bytes of a content-source file as the artifact source VS Code builds for it. */
function memorySource(uri: string, bytes: Uint8Array): ArtifactByteSource {
  return {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision: revisionId(`content-hash.sha256:${createHash('sha256').update(bytes).digest('hex')}`),
    size: BigInt(bytes.byteLength),
    async read(offset, length) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
}

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1')('installed World of Warcraft M2', () => {
  it('opens the corpus with skins and animations from the content source and exports UVM', { timeout: 900_000 }, async () => {
    const indexCacheDirectory = process.env['MODKIT_INDEX_CACHE_DIRECTORY']
    const sources = await createContentSources(
      { installationDirectory: await installation() },
      indexCacheDirectory === undefined ? {} : { indexCacheDirectory },
    )
    const inventory = await buildInventory(
      await Promise.all(
        [extension, join(extension, '..', 'blizzard-common-formats')].map(async root => ({
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
          return { module: (await import(context.entrypoint.href)) as Record<string, unknown>, release: async () => undefined }
        },
      },
    ])
    const report: Record<string, unknown>[] = []
    const encrypted: string[] = []
    try {
      for (const [fileId, name] of CORPUS) {
        const path = `filedataid/${String(fileId)}`
        let bytes: Uint8Array
        try {
          bytes = await sources.read('local:wow', path, 64 << 20)
        } catch (error) {
          if (/key|encrypt|salsa/iu.test(String(error))) {
            encrypted.push(name)
            continue
          }
          throw error
        }
        const uri = `content-source://local%3Awow/${path}`
        const diagnostics: string[] = []
        const target_ = { sourceId: 'local:wow', path }
        const opened = await openSubject({
          inventory,
          executionBackends,
          target,
          grant: { id: `wow-m2-corpus:${randomUUID()}`, classes: ['read-source'] },
          budget,
          intent: 'full',
          source: memorySource(uri, bytes),
          path: uri,
          resolveInput: createContentSourceInputResolver({
            contentSources: sources,
            target: target_,
            inventory,
            assetOrigins: [createContentAssetOrigin({ contentSources: sources, target: target_, onDiagnostic: item => diagnostics.push(item.message) })],
            onDiagnostic: item => diagnostics.push(item.message),
          }),
        })
        if (opened.state !== 'opened') throw new Error(`${name} did not open: ${JSON.stringify(opened).slice(0, 400)}`)
        try {
          expect(opened.selected.contributionId).toBe('blizzard/wow-m2')
          const summary = (await opened.session.operations().invoke('inspect', null)) as { state: string; output: { value: Record<string, unknown> } }
          const scene = await opened.session.dataSource('common.view/model-scene-source', 1)
          const info = await (scene.value as ModelSceneSource).info().finally(() => scene.release())
          const exported = info.geometryAccess === 'decoded' ? await opened.session.operations().invoke('model-export-uvm', { schemaVersion: 1 }) : undefined
          if (exported !== undefined && (exported.state !== 'ok' || exported.output.kind !== 'bytes')) throw new Error(`${name} export: ${JSON.stringify(exported).slice(0, 400)}`)
          const document = (exported?.state === 'ok' && exported.output.kind === 'bytes'
            ? readUvmContainer(exported.output.value as Uint8Array, {
                maxInputBytes: 268_435_456,
                maxJsonBytes: 268_435_456,
                maxDepth: 64,
                // UVM's declared JSON node ceiling is distinct from M2's native record budget.
                maxNodes: 10_000_000,
              }).document
            : {}) as { meshes?: unknown[]; animations?: unknown[]; skins?: unknown[] }
          report.push({
            name,
            ...summary.output.value,
            geometry: info.geometryAccess,
            primitives: info.primitives,
            uvmMeshes: document.meshes?.length ?? 0,
            uvmAnimations: document.animations?.length ?? 0,
            warnings: opened.diagnostics.map(item => `${item.code}: ${item.message.slice(0, 160)}`),
            companionDiagnostics: diagnostics.slice(0, 3),
          })
        } finally {
          await opened.session.dispose()
        }
      }
    } finally {
      await sources.dispose()
    }
    console.log(JSON.stringify({ route: 'host', encrypted, report }, null, 1))
    // Parser metadata alone is insufficient: this admission specifically exercises public Host
    // companions. Pending Core exact lookup/vendor delivery must fail here instead of looking green.
    expect(report.length + encrypted.length).toBe(CORPUS.length)
    for (const row of report) {
      expect(row['geometry'], String(row['name'])).toBe('decoded')
      expect(Number(row['primitives']), String(row['name'])).toBeGreaterThan(0)
      expect(Number(row['uvmMeshes']), String(row['name'])).toBeGreaterThan(0)
      if (Number(row['animFilesNamed']) > 0)
        expect(Number(row['animFilesRead']), `${String(row['name'])}: reachable ANIM`).toBe(Number(row['animFilesNamed']))
      if (row['name'] === 'character/human/male/humanmale_hd.m2') {
        expect(Number(row['bones'])).toBeGreaterThan(0)
        expect(Number(row['skeletonFilesRead'])).toBeGreaterThan(0)
      }
    }
  })

  it('decodes the corpus with its companions read from the content source', { timeout: 900_000 }, async () => {
    const indexCacheDirectory = process.env['MODKIT_INDEX_CACHE_DIRECTORY']
    const sources = await createContentSources(
      { installationDirectory: await installation() },
      indexCacheDirectory === undefined ? {} : { indexCacheDirectory },
    )
    const codec = ((await import(pathToFileURL(join(extension, 'dist', 'm2', 'codec.js')).href)) as { createCodec(context: unknown): Codec }).createCodec({
      budgets: budget,
      diagnostics: { report: () => undefined },
      contracts: { async resolve() { throw new Error('none') }, async resolveUnknown() { throw new Error('none') } },
      logicalResources: contentSourcePort(sources),
    })
    const report: Record<string, unknown>[] = []
    const encrypted: string[] = []
    try {
      for (const [fileId, name] of CORPUS) {
        const path = `filedataid/${String(fileId)}`
        let bytes: Uint8Array
        try {
          bytes = await sources.read('local:wow', path, 64 << 20)
        } catch (error) {
          if (/key|encrypt|salsa/iu.test(String(error))) {
            encrypted.push(name)
            continue
          }
          throw error
        }
        const session = await codec.open(singleInput(memorySource(`content-source://local%3Awow/${path}`, bytes)), 'full', budget)
        try {
          const inspected = await session.operations().invoke('inspect', null)
          if (inspected.state !== 'ok' || inspected.output.kind !== 'json') throw new Error(`${name}: inspect failed`)
          const scene = await session.dataSource('common.view/model-scene-source', 1)
          const info = await (scene.value as ModelSceneSource).info().finally(() => scene.release())
          const exported = await session.operations().invoke('model-export-uvm', { schemaVersion: 1 })
          if (exported.state !== 'ok' || exported.output.kind !== 'bytes') throw new Error(`${name} export: ${JSON.stringify(exported).slice(0, 400)}`)
          const document = readUvmContainer(exported.output.value as Uint8Array, {
            maxInputBytes: 268_435_456,
            maxJsonBytes: 268_435_456,
            maxDepth: 64,
            maxNodes: 10_000_000,
          }).document as { meshes?: unknown[]; animations?: unknown[]; skins?: unknown[]; images?: unknown[] }
          report.push({
            name,
            ...(inspected.output.value as Record<string, unknown>),
            geometry: info.geometryAccess,
            primitives: info.primitives,
            uvmMeshes: document.meshes?.length ?? 0,
            uvmSkins: document.skins?.length ?? 0,
            uvmAnimations: document.animations?.length ?? 0,
            uvmImages: document.images?.length ?? 0,
            uvmBytes: (exported.output.value as Uint8Array).byteLength,
          })
        } finally {
          await session.dispose()
        }
      }
    } finally {
      await sources.dispose()
    }
    console.log(JSON.stringify({ route: 'content-source-port', encrypted, report }, null, 1))
    expect(report.length + encrypted.length).toBe(CORPUS.length)
    for (const row of report) {
      expect(row['geometry'], String(row['name'])).toBe('decoded')
      expect(row['uvmMeshes'], String(row['name'])).toBeGreaterThan(0)
      if (Number(row['bones']) > 0) expect(row['uvmSkins'], String(row['name'])).toBe(1)
      expect(row['uvmAnimations'], String(row['name'])).toBe(row['sequences'])
    }
  })
})

/** A logical-resource port answering `filedataid/<id>` from the content source, as the host will. */
function contentSourcePort(sources: { read(sourceId: string, path: string, maxBytes: number): Promise<Uint8Array> }): LogicalResourcePort {
  return {
    async readBatch(request) {
      const items = await Promise.all(
        request.items.map(async item => {
          try {
            const bytes = await sources.read('local:wow', item.requirement.logicalId, 64 << 20)
            return { state: 'read' as const, bytes, revision: revisionId('content-hash.sha256:wow-companion'), provenance: {} as never }
          } catch (error) {
            return { state: 'unresolved' as const, reason: 'not-found' as const, message: String(error) }
          }
        }),
      )
      return { state: 'complete', bytes: 0n, items } as never
    },
    async discover() { throw new Error('unused') },
    async resolve() { throw new Error('unused') },
    async provenance() { return [] },
  }
}

function singleInput(value: ArtifactByteSource): AssetInput {
  const binding = { sourceKind: 'candidate' as const, bindingId: 'content', role: 'content', ownership: 'owned' as const, source: value.ref, revision: value.revision }
  return {
    originKind: 'single',
    bindings: [binding],
    primaryBindingId: 'content',
    revisions: { topology: 'single', revision: value.revision, bindings: [{ bindingId: 'content', revision: value.revision }], compositionFingerprint: value.ref.id },
    bindingsFor: () => [],
    async openBinding() { return { value, async release() { return undefined } } },
  } as unknown as AssetInput
}
