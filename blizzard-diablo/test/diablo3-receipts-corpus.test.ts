/**
 * Feature-ledger receipts for the Diablo III codecs on the installed game, one per MK2 operation in
 * the K1 format the core ledger validates (`scripts/migration/lib/port-state.mjs`). Each operation
 * runs through the MK3 route that replaced it on a fixed sample of the installed CASC found by
 * discovery, and a case is `identical` only when an oracle outside that route agrees:
 *
 * - `model.read` → nested APP subject, `model.export-uvm`; the UVM, read back by the shared UVM
 *   readers, carries exactly the vertices the appearance's own inspection counted;
 * - `model.render` → that UVM reopened by the core UVM codec, `model.render`; the PNG, decoded by
 *   codec-kit, has the requested size and pixels other than the clear colour;
 * - `image.inspect` → nested TEX subject, `view.inspect`; its width, height and SNO id equal the
 *   header fields at their fixed offsets in the entry bytes;
 * - `image.read` → mip 0 of the TEX subject's `common.view/raster-image-source` (MK3 publishes
 *   pixels as a data source, not an operation); the region has the header's width and height and
 *   exactly width × height RGBA pixels, and an uncompressed texture equals its entry bytes pixel
 *   for pixel, read from past the 16-byte rectangle at the mip-0 offset. Block-compressed
 *   textures are checked for size only.
 *
 * The receipts under `test/receipts` are pinned by the core feature ledger, so this suite
 * regenerates them and requires the committed files to match; `MODKIT_WRITE_D3_RECEIPTS=1`
 * writes them. The sample is fixed names plus an even spread of the sorted listing. The TEX
 * receipts are `.v2`: v1 (pinned, left as it was) predates the rectangle before uncompressed
 * pixels and sampled no uncompressed texture; v2 adds one of each uncompressed format. The APP
 * model.read receipt is `.v3`: v1 (pinned) predates the animations an appearance's actor links,
 * v2 (pinned) predates the meshes of other looks the export keeps hidden (30.09) — it counted the
 * vertices a sampler draws, which no longer includes them; v3 counts every primitive of the UVM,
 * drawn or hidden. The render is `.v2`: v1 (pinned) drew every look and no render pass at once.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  linkedExtensionInputs,
  linkedInProcessBackend,
  openNestedSubject,
  openSubject,
  registerServiceDefinitionsOrThrow,
  type OpenedSubject,
} from '@modkit/host'
import { createFilesystemInputResolver, loadExtensionDirectory, openFileArtifactSource } from '@modkit/host/node'
import { decodePngSamples } from '@modkit/codec-kit/raster'
import { decodeBcSurface, type BcFormat } from '@modkit/codec-kit/texture/bc'
import { sceneModule } from '@modkit/scene/module'
import { createModelSceneSampler } from '@modkit/scene/model'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { readUvmContainer } from '@modkit/uv/model/container'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'
import { camera } from '../../models/test/uvm-conversion-render.js'

const extension = join(import.meta.dirname, '..')
const receipts = join(import.meta.dirname, 'receipts')
const write = process.env['MODKIT_WRITE_D3_RECEIPTS'] === '1'
const suite = 'modkit-extensions-blizzard/blizzard-diablo/test/diablo3-receipts-corpus.test.ts'
const { discoverDiablo3Installations } = (await import(
  pathToFileURL(join(extension, 'dist', 'game', 'installation.js')).href
)) as typeof import('../dist/game/installation.js')

const namedAppearances = ['appearance/a2dun_zolt_tesla_tower.app', 'appearance/barbarian_male.app', 'appearance/breakable_painting_c.app']
/** Installed uncompressed textures: A8R8G8B8, A4R4G4B4 ×2, L8 ×2, A8. */
const namedTextures = [
  'textures/2dui_bnet_loadingscreen_logo_enus_x1_3.tex', 'textures/2dinventoryrunes.tex', 'textures/2dinventorysockets.tex',
  'textures/2duihelp.tex', 'textures/woodfence.tex', 'textures/x1_crusader_trebuchet_grenadecross.tex',
]
/** RGBA of one pixel of an uncompressed TEX format, as D3D stores it (little-endian). */
function rawPixel(format: number, bytes: Uint8Array, view: DataView, at: number, pixel: number): readonly number[] | undefined {
  if (format === 0) return [bytes[at + pixel * 4 + 2]!, bytes[at + pixel * 4 + 1]!, bytes[at + pixel * 4]!, bytes[at + pixel * 4 + 3]!]
  if (format === 4) {
    const value = view.getUint16(at + pixel * 2, true)
    return [((value >> 8) & 15) * 17, ((value >> 4) & 15) * 17, (value & 15) * 17, ((value >> 12) & 15) * 17]
  }
  if (format === 7) return [bytes[at + pixel]!, bytes[at + pixel]!, bytes[at + pixel]!, 255]
  if (format === 23) return [255, 255, 255, bytes[at + pixel]!]
  return undefined
}
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'diablo3-receipts-corpus', classes: ['read-source'] } as const
const budget = { maxInputBytes: 268_435_456n, maxDepth: 128, maxNodes: 2_000_000, maxScalarBytes: 268_435_456, maxDiagnostics: 1000 }
const containerBudget = { maxInputBytes: budget.maxScalarBytes, maxJsonBytes: budget.maxScalarBytes, maxNodes: budget.maxNodes, maxDepth: budget.maxDepth }
const viewport = 256

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
/** JSON with sorted keys, so a digest does not depend on property order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : typeof item === 'bigint' ? String(item) : item,
  )

function spread<T>(items: readonly T[], count: number): readonly T[] {
  if (items.length <= count) return items
  const step = items.length / count
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * step)]!)
}

interface Case {
  readonly id: string
  readonly verdict: 'identical' | 'different'
  readonly resultDigest: string
  readonly mk3Operation: string
}

interface Claim {
  readonly codec: 'diablo3-app' | 'diablo3-tex'
  /** An operation row names its MK2 operation; the source feature audit row has none. */
  readonly legacyOperation?: string
  readonly operation: string
  /** The published operation that replaced the MK2 one, or the data source that did. */
  readonly target:
    | { readonly targetOperation: string; readonly handlerId: string }
    | { readonly targetDataSource: { readonly contract: string; readonly major: number } }
  readonly contribution: string
  readonly oracle: string
  readonly modules: readonly string[]
  readonly samples: ({ name: string; sha256: string } | { name: string; fixture: string; sha256LF: string })[]
  readonly cases: Case[]
}

const audit = { targetOperation: 'source-feature-audit', handlerId: 'source-feature-audit' } as const
const mk2Root = (codec: string) => `references/modkitmk2/extensions/blizzard/diablo/codecs/${codec}`
const auditOracle = (codec: string) =>
  `every export of the MK2 source (${mk2Root(codec)} at 1a14ba4eddd0ae88de273348ebd44cfb98a0581d) and its manifest, ` +
  'run on the installed game (and synthetic blocks where the game has no oracle) against the MK3 module that carries it'
const compare = (id: string, mk3Operation: string, observed: unknown, expected: unknown): Case => ({
  id,
  verdict: canonical(observed) === canonical(expected) ? 'identical' : 'different',
  resultDigest: sha256(canonical(observed)),
  mk3Operation,
})

const app = 'modkit-extensions-blizzard/blizzard-diablo/contributions/codec-diablo3-app.json'
const tex = 'modkit-extensions-blizzard/blizzard-diablo/contributions/codec-diablo3-tex.json'
const claims: Record<string, Claim> = {
  'diablo3-app.model.read.v3': {
    codec: 'diablo3-app', legacyOperation: 'model.read', operation: 'model.export-uvm',
    target: { targetOperation: 'model.export-uvm', handlerId: 'model-export-uvm' }, contribution: app,
    oracle:
      'the exported UVM, read back by the shared UVM readers, carries in its primitives (drawn, or kept hidden as another look) exactly the vertices the appearance inspection counted, ' +
      'and one animation with channels for every clip the inspection counted (the actor → AnimSet → Anim link)',
    modules: ['@modkit/uv/model/container', '@modkit/scene/uvm/model', '@modkit/scene/model'], samples: [], cases: [],
  },
  'diablo3-app.model.render.v2': {
    codec: 'diablo3-app', legacyOperation: 'model.render', operation: 'model.render',
    target: { targetOperation: 'model.render', handlerId: 'render-uvm-scene' },
    contribution: 'modkit-core/extensions/models/contributions/codec-uvm.json',
    oracle: `the PNG, decoded by codec-kit, is ${viewport}x${viewport} and has pixels other than the clear colour`,
    modules: ['@modkit/codec-kit/raster'], samples: [], cases: [],
  },
  'diablo3-tex.image.inspect.v2': {
    codec: 'diablo3-tex', legacyOperation: 'image.inspect', operation: 'view.inspect',
    target: { targetOperation: 'view.inspect', handlerId: 'inspect' }, contribution: tex,
    oracle: 'width, height and SNO id equal the TEX v47 header fields at offsets 0x24, 0x28 and 0x10 of the entry bytes',
    modules: ['blizzard-diablo/test/diablo3-receipts-corpus.test.ts (fixed-offset header read, no codec)'], samples: [], cases: [],
  },
  'diablo3-tex.image.read.v2': {
    codec: 'diablo3-tex', legacyOperation: 'image.read', operation: 'raster-image-source.readRegion',
    target: { targetDataSource: { contract: 'common.view/raster-image-source', major: 1 } }, contribution: tex,
    oracle:
      'mip 0 has the header width and height (0x24, 0x28) and exactly width x height RGBA pixels; an uncompressed texture ' +
      '(A8R8G8B8, A4R4G4B4, L8, A8) equals its entry bytes pixel for pixel, read 16 bytes past the mip-0 table offset ' +
      '(the rectangle every installed TEX carries there); block-compressed textures are checked for size only',
    modules: ['blizzard-diablo/test/diablo3-receipts-corpus.test.ts (fixed-offset header and raw-pixel read, no codec)'], samples: [], cases: [],
  },
  'diablo3-tex.image.read.atlas': {
    codec: 'diablo3-tex', legacyOperation: 'image.read', operation: 'raster-image-source.readRegion',
    target: { targetDataSource: { contract: 'common.view/raster-image-source', major: 1 } }, contribution: tex,
    oracle:
      'each atlasRegions rectangle equals the frame-table (or mip-0) rectangle of four floats rounded and clamped as MK2 cropFrame did, ' +
      'and readRegion of it equals the same rectangle cut from the full mip-0 image',
    modules: ['blizzard-diablo/test/diablo3-receipts-corpus.test.ts (frame-table read and crop of the full image, no codec)'],
    samples: [], cases: [],
  },
  'diablo3-app.audit': {
    codec: 'diablo3-app', operation: 'source-feature-audit', target: audit, contribution: app, oracle: auditOracle('diablo3-app'),
    modules: ['cross-file SNO links of the installed game (actor -> appearance, animation set -> animations)', 'MK2 codec.manifest.json'],
    samples: [], cases: [],
  },
  'diablo3-tex.audit': {
    codec: 'diablo3-tex', operation: 'source-feature-audit', target: audit, contribution: tex, oracle: auditOracle('diablo3-tex'),
    modules: ['TEX header and raw pixels of the installed game', '@modkit/codec-kit/texture/bc decodeBcSurface', 'MK2 codec.manifest.json'],
    samples: [], cases: [],
  },
}

describe.skipIf(process.env['MODKIT_TEST_INSTALLED_CORPUS'] !== '1')('Diablo III ledger receipts', () => {
  it('runs every MK2 operation through its MK3 route on the installed game', async () => {
    const discovery = await discoverDiablo3Installations({ gameId: 'blizzard/diablo-3', maxCandidates: 16 })
    const installation = discovery.installations[0]
    if (installation === undefined) throw new Error('no Diablo III installation discovered (set MODKIT_DIABLO3_ROOT)')

    const linked = linkedExtensionInputs([sceneModule])
    const inventory = await buildInventory(
      [
        ...linked.inputs,
        ...(await Promise.all(
          [join(extension, '..', 'casc'), extension, join(extension, '..', '..', 'modkit-core', 'extensions', 'models')].map(
            async root => ({ ...(await loadExtensionDirectory(root)), execution: { origin: 'bundled' as const, allowTrustedInProcess: true } }),
          ),
        )),
      ],
      createHostContributionContractRegistry(),
    )
    const serviceDefinitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
    const executionBackends = createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)])
    const common = { inventory, executionBackends, serviceDefinitions, target, grant, budget, intent: 'full' as const }

    const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
    const mount = await vfs.openMount(pathToFileURL(installation.normalizedPath).href)
    const casc = await openSubject({ ...common, source: artifactNamespaceSourceFromVfsMount(mount), path: installation.normalizedPath })
    if (casc.state !== 'opened') throw new Error(`CASC did not open: ${casc.state}`)
    const directory = await mkdtemp(join(tmpdir(), 'modkit-d3-receipts-'))
    let listed = { appearances: 0, textures: 0 }

    const listFiles = async (prefix: string, suffix: string) => {
      const source = await casc.session.dataSource('common.view/namespace-entry-source', 1)
      const paths: string[] = []
      try {
        let cursor: string | undefined
        do {
          const page = await source.value.list(prefix, { limit: 256, ...(cursor === undefined ? {} : { cursor }) })
          for (const item of page.items) if (item.kind === 'file' && item.path.endsWith(suffix)) paths.push(item.path)
          cursor = page.nextCursor
        } while (cursor !== undefined)
      } finally {
        await source.release()
      }
      return paths.sort()
    }
    const extract = async (entryId: string) => {
      const extracted = await casc.session.operations().invoke('extract-entry', { entryId })
      if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') throw new Error(`${entryId} did not extract`)
      return extracted.output.value
    }
    const nested = async (entryId: string, contributionId: string): Promise<OpenedSubject> => {
      const opened = (await openNestedSubject({ ...common, parent: casc.session, entryId })).result
      if (opened.state !== 'opened') throw new Error(`${entryId} did not open: ${JSON.stringify(opened).slice(0, 300)}`)
      expect(opened.selected.contributionId).toBe(contributionId)
      return opened
    }
    const record = (key: string, entryId: string, input: Uint8Array, agrees: boolean, result: Uint8Array | string) => {
      const claim = claims[key]!
      claim.samples.push({ name: entryId, sha256: sha256(input) })
      claim.cases.push({
        id: `real:${entryId}:${claim.operation}`,
        verdict: agrees ? 'identical' : 'different',
        resultDigest: sha256(result),
        mk3Operation: claim.operation,
      })
    }

    try {
      const appearanceList = await listFiles('Appearance', '.app')
      const textureList = await listFiles('Textures', '.tex')
      listed = { appearances: appearanceList.length, textures: textureList.length }

      for (const entryId of [...new Set([...namedAppearances, ...spread(appearanceList, 8)])]) {
        const input = await extract(entryId)
        const subject = await nested(entryId, 'blizzard/diablo3-app')
        let uvmBytes: Uint8Array
        let counted: number
        let clips: number
        try {
          const inspected = await subject.session.operations().invoke('inspect', null)
          if (inspected.state !== 'ok' || inspected.output.kind !== 'json') throw new Error(`${entryId} inspect failed`)
          counted = Number((inspected.output.value as { vertices?: unknown }).vertices)
          clips = Number((inspected.output.value as { animations?: unknown }).animations)
          const exported = await subject.session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
          if (exported.state !== 'ok' || exported.output.kind !== 'bytes') throw new Error(`${entryId} model-export-uvm failed`)
          uvmBytes = exported.output.value
        } finally {
          await subject.session.dispose()
        }
        const { document, binary } = readUvmContainer(uvmBytes, containerBudget)
        const { scene, rig } = readUvmModel(document, binary, budget)
        const primitives = createModelSceneSampler({ ...scene, skeleton: rig.bindings }, { maxBytes: budget.maxScalarBytes }).sample(0).primitives
        // every vertex reaches the UVM, drawn or kept hidden (another look's mesh the sampler skips)
        const gltf = document as { meshes?: { primitives: { attributes: { POSITION?: number } }[] }[]; accessors?: { count: number }[] }
        const vertices = (gltf.meshes ?? []).flatMap(mesh => mesh.primitives).reduce((sum, primitive) => sum + (gltf.accessors?.[primitive.attributes.POSITION ?? -1]?.count ?? 0), 0)
        const animations = (document as { animations?: { channels: unknown[] }[] }).animations ?? []
        const animated = animations.length === clips && animations.every(animation => animation.channels.length > 0)
        record('diablo3-app.model.read.v3', entryId, input, vertices > 0 && vertices === counted && animated, uvmBytes)

        const uvmPath = join(directory, 'model.uvm.glb')
        await writeFile(uvmPath, uvmBytes)
        const uvm = await openSubject({
          ...common, source: await openFileArtifactSource(uvmPath), path: uvmPath,
          resolveInput: createFilesystemInputResolver({ primaryPath: uvmPath, roots: [directory], inventory }),
        })
        if (uvm.state !== 'opened') throw new Error(`${entryId} UVM did not reopen: ${uvm.reason}`)
        try {
          // The shared isometric camera, with its depth row negated as the renderers expect.
          const viewProjection = Array.from(camera(primitives), (value, index) => (index % 4 === 2 ? -value : value))
          const rendered = await uvm.session.operations().invoke('render-uvm-scene', {
            schemaVersion: 1, viewport: { width: viewport, height: viewport }, camera: { viewProjection }, rendererId: 'modkit.headless',
          })
          if (rendered.state !== 'ok' || rendered.output.kind !== 'bytes') throw new Error(`${entryId} render failed: ${JSON.stringify(rendered).slice(0, 300)}`)
          const png = await decodePngSamples(rendered.output.value)
          const clear = png.samples.subarray(0, png.channels)
          let drawn = 0
          for (let offset = 0; offset < png.samples.length; offset += png.channels)
            if (clear.some((value, channel) => png.samples[offset + channel] !== value)) drawn += 1
          record('diablo3-app.model.render.v2', entryId, input, png.width === viewport && png.height === viewport && drawn > 0, rendered.output.value)
        } finally {
          await uvm.session.dispose()
        }
      }

      for (const entryId of [...new Set([...namedTextures, ...spread(textureList, 64)])]) {
        const input = await extract(entryId)
        const header = new DataView(input.buffer, input.byteOffset, input.byteLength)
        const subject = await nested(entryId, 'blizzard/diablo3-tex')
        try {
          const inspected = await subject.session.operations().invoke('inspect', null)
          if (inspected.state !== 'ok' || inspected.output.kind !== 'json') throw new Error(`${entryId} inspect failed`)
          const summary = inspected.output.value as { width?: number; height?: number; snoId?: number }
          const agrees =
            header.getUint32(0, true) === 0xdeadbeef &&
            header.getUint32(4, true) === 47 &&
            summary.snoId === header.getInt32(0x10, true) &&
            summary.width === header.getUint32(0x24, true) &&
            summary.height === header.getUint32(0x28, true)
          record('diablo3-tex.image.inspect.v2', entryId, input, agrees, canonical(summary))

          const raster = await subject.session.dataSource('common.view/raster-image-source', 1)
          try {
            const width = header.getUint32(0x24, true)
            const height = header.getUint32(0x28, true)
            const region = await raster.value.readRegion?.({
              x: 0, y: 0, width, height, frame: 0, mipLevel: 0, layer: 0, face: 0, slice: 0,
              pixelFormat: 'rgba8', maxBytes: budget.maxScalarBytes,
            })
            let pixelsAgree = region !== undefined && region.width === width && region.height === height &&
              region.rowStride === width * 4 && region.pixels.length === width * height * 4
            const format = header.getUint32(0x20, true)
            // Uncompressed pixels follow the 16-byte rectangle at the mip-0 table offset.
            const at = header.getUint32(0x38, true) + 16
            if (pixelsAgree && rawPixel(format, input, header, at, 0) !== undefined)
              for (let pixel = 0; pixel < width * height && pixelsAgree; pixel += 1)
                pixelsAgree = rawPixel(format, input, header, at, pixel)!.every(
                  (value, channel) => region!.pixels[pixel * 4 + channel] === value,
                )
            record('diablo3-tex.image.read.v2', entryId, input, pixelsAgree, region?.pixels ?? new Uint8Array())
          } finally {
            await raster.release()
          }
        } finally {
          await subject.session.dispose()
        }
      }

      // Atlas frames: MK2 cropped them by the frame table; MK3 names them in info() and crops with readRegion.
      for (const entryId of ['textures/bluelightning_strokes.tex', 'textures/raidenbolt.tex', 'textures/raidenstream.tex']) {
        const input = await extract(entryId)
        const header = new DataView(input.buffer, input.byteOffset, input.byteLength)
        const width = header.getUint32(0x24, true)
        const height = header.getUint32(0x28, true)
        const frames = header.getUint32(0x218, true)
        const tableOffset = header.getUint32(0x21c, true)
        const clamp = (value: number, limit: number) => Math.max(0, Math.min(limit, Math.round(value * limit)))
        const rectangle = (offset: number, name: string) => {
          const [left, top, right, bottom] = [0, 4, 8, 12].map(delta => header.getFloat32(offset + delta, true))
          const x = clamp(left!, width), y = clamp(top!, height)
          return { x, y, width: Math.max(0, clamp(right!, width) - x), height: Math.max(0, clamp(bottom!, height) - y), name }
        }
        const expected = [
          ...Array.from({ length: frames }, (_, frame) => rectangle(tableOffset + frame * 80, `frame ${frame}`)),
          rectangle(header.getUint32(0x38, true), 'mip-0 rectangle'),
        ].filter(item => item.width > 0 && item.height > 0)
        const subject = await nested(entryId, 'blizzard/diablo3-tex')
        const raster = await subject.session.dataSource('common.view/raster-image-source', 1)
        try {
          const info = (await raster.value.info()) as { atlasRegions?: typeof expected }
          const regionOf = (x: number, y: number, w: number, h: number) => raster.value.readRegion!({
            x, y, width: w, height: h, frame: 0, mipLevel: 0, layer: 0, face: 0, slice: 0, pixelFormat: 'rgba8', maxBytes: budget.maxScalarBytes,
          })
          const full = await regionOf(0, 0, width, height)
          const claim = claims['diablo3-tex.image.read.atlas']!
          claim.samples.push({ name: entryId, sha256: sha256(input) })
          expect(info.atlasRegions?.length).toBe(expected.length)
          for (const [index, region] of expected.entries()) {
            const published = info.atlasRegions?.[index]
            const cropped = await regionOf(region.x, region.y, region.width, region.height)
            const cut = new Uint8Array(region.width * region.height * 4)
            for (let row = 0; row < region.height; row += 1) {
              const start = ((region.y + row) * width + region.x) * 4
              cut.set(full.pixels.subarray(start, start + region.width * 4), row * region.width * 4)
            }
            claim.cases.push({
              id: `real:${entryId}:${region.name}:${claim.operation}`,
              verdict: canonical(published) === canonical(region) && canonical([...cropped.pixels]) === canonical([...cut]) ? 'identical' : 'different',
              resultDigest: sha256(cropped.pixels),
              mk3Operation: claim.operation,
            })
          }
        } finally {
          await raster.release()
          await subject.session.dispose()
        }
      }

      // Source feature audit: each MK2 export against the MK3 module that carries it.
      const port = (await import(pathToFileURL(join(extension, 'dist', 'diablo3-app', 'appearance.js')).href)) as typeof import('../dist/diablo3-app/appearance.js')
      /** An installed entry by its CASC path, or by `<Group>/<sno>.<ext>` for a SNO the file names. */
      const entryOf = async (path: string) => {
        const source = await casc.session.dataSource('common.view/namespace-entry-source', 1)
        try {
          const page = await source.value.list(path, { limit: 1 })
          const item = page.items.find(candidate => candidate.kind === 'file')
          if (item === undefined) throw new Error(`${path} is not in the installation`)
          return { id: item.id, bytes: await extract(item.id) }
        } finally {
          await source.release()
        }
      }
      const inspectOf = async (entryId: string, contributionId: string) => {
        const subject = await nested(entryId, contributionId)
        try {
          const inspected = await subject.session.operations().invoke('inspect', null)
          if (inspected.state !== 'ok' || inspected.output.kind !== 'json') throw new Error(`${entryId} inspect failed`)
          const companions = contributionId === 'blizzard/diablo3-app'
            ? await subject.session.operations().invoke('diablo3-companion-patterns', null)
            : undefined
          return {
            summary: inspected.output.value as Record<string, unknown>,
            companions: companions?.state === 'ok' && companions.output.kind === 'json' ? companions.output.value : undefined,
          }
        } finally {
          await subject.session.dispose()
        }
      }
      const auditSamples = async (key: string, files: readonly string[], inputs: readonly { id: string; bytes: Uint8Array }[]) => {
        const claim = claims[key]!
        for (const file of files) {
          const fixture = `${mk2Root(claim.codec)}/${file}`
          const text = (await readFile(join(extension, '..', '..', fixture), 'utf8')).replaceAll('\r\n', '\n')
          claim.samples.push({ name: `mk2 ${file}`, fixture, sha256LF: sha256(text) })
        }
        for (const input of inputs) claim.samples.push({ name: input.id, sha256: sha256(input.bytes) })
      }
      const mk2Manifest = async (codec: string) =>
        JSON.parse(await readFile(join(extension, '..', '..', mk2Root(codec), 'codec.manifest.json'), 'utf8')) as {
          match: { extensions: string[] }; operations: string[]
        }
      const mk3Manifest = async (file: string) =>
        JSON.parse(await readFile(join(extension, 'contributions', file), 'utf8')) as {
          spec: { match: { extensions: string[] }; operations: { id: string }[]; publishesDataSources: { contract: string }[] }
        }

      {
        // Chains the game links by SNO id, each checked against the file at its other end: the first
        // actor (sorted listing, even spread) naming an appearance, and the first naming an animation
        // set, whose animation names the model it animates.
        const actors = spread(await listFiles('Actor', '.acr'), 256)
        const firstActor = async (field: 'appearanceSnoId' | 'animSetSnoId') => {
          for (const entryId of actors) {
            const bytes = await extract(entryId)
            if (!port.isDiablo3Actor(bytes)) continue
            const links = port.parseDiablo3ActorLinks(bytes)
            if (links[field] > 0) return { id: entryId, bytes, links }
          }
          throw new Error(`no installed actor names a ${field}`)
        }
        const actor = await firstActor('appearanceSnoId')
        const animActor = await firstActor('animSetSnoId')
        // Opened through the host under its real name; the actor's appearance is read by its SNO path.
        const appearance = await entryOf('appearance/breakable_painting_c.app')
        const linkedAppearance = await entryOf(`Appearance/${actor.links.appearanceSnoId}.app`)
        const texture = await entryOf('textures/woodfence.tex')
        const animSet = await entryOf(`AnimSet/${animActor.links.animSetSnoId}.ans`)
        const set = port.parseDiablo3AnimSet(animSet.bytes)
        const animationEntries = await Promise.all(set.animations.slice(0, 3).map(entry => entryOf(`Anim/${entry.animationSnoId}.ani`)))
        const animation = port.parseDiablo3Animation(animationEntries[0]!.bytes, animationEntries[0]!.id)
        const animated = await entryOf(`Appearance/${animation.modelSnoRef}.app`)
        const model = port.parseDiablo3Appearance(appearance.bytes, appearance.id)
        const animatedModel = port.parseDiablo3Appearance(animated.bytes, animated.id)
        const opened = await inspectOf(appearance.id, 'blizzard/diablo3-app')
        const nodes = (model.metadata?.['war3Nodes'] ?? []) as { name?: string }[]
        const boneNames = new Set(((animatedModel.metadata?.['war3Nodes'] ?? []) as { name?: string }[]).map(node => String(node.name ?? '').toLowerCase()))
        const attached = port.attachDiablo3Animations(animatedModel, [{ bytes: animationEntries[0]!.bytes, hint: animationEntries[0]!.id }])
        const mk2 = await mk2Manifest('diablo3-app')
        const mk3 = await mk3Manifest('codec-diablo3-app.json')
        await auditSamples('diablo3-app.audit', ['codec.manifest.json', 'src/detect.ts', 'src/index.ts'], [appearance, actor, linkedAppearance, animActor, animSet, ...animationEntries, animated])
        claims['diablo3-app.audit']!.cases.push(
          compare('mk2-source:src/detect.ts#detectHeader', 'src/diablo3-app/codec.ts detect (host routing)',
            [port.isDiablo3Appearance(appearance.bytes), port.isDiablo3Appearance(actor.bytes), port.isDiablo3Appearance(texture.bytes)],
            [true, false, false]),
          compare('mk2-source:src/index.ts#isDiablo3Appearance+parseDiablo3Appearance', 'src/diablo3-app/appearance.ts via view.inspect',
            [opened.summary['submeshes'], opened.summary['vertices'], opened.summary['bones']],
            [model.meshes.length, model.meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0), nodes.length]),
          compare('mk2-source:src/index.ts#isDiablo3Actor+parseDiablo3ActorLinks', 'src/diablo3-app/appearance.ts (host companion route)',
            [port.isDiablo3Actor(actor.bytes), actor.links.appearanceSnoId],
            [true, port.parseDiablo3Appearance(linkedAppearance.bytes, linkedAppearance.id).metadata?.['snoId']]),
          compare('mk2-source:src/index.ts#isDiablo3AnimSet+parseDiablo3AnimSet', 'src/diablo3-app/appearance.ts (host companion route)',
            [port.isDiablo3AnimSet(animSet.bytes), set.snoId === animActor.links.animSetSnoId, set.animations.length > 0, animationEntries.length],
            [true, true, true, Math.min(3, set.animations.length)]),
          compare('mk2-source:src/index.ts#isDiablo3Animation+parseDiablo3Animation', 'src/diablo3-app/appearance.ts (host companion route)',
            [port.isDiablo3Animation(animationEntries[0]!.bytes), animation.clips.length > 0,
              animation.clips[0]!.bones.every(bone => boneNames.has(bone.name.toLowerCase()))],
            [true, true, true]),
          compare('mk2-source:src/index.ts#attachDiablo3Animations', 'src/diablo3-app/codec.ts attachDiablo3Animations (host companion route)',
            attached.animations.length > animatedModel.animations.length, true),
          // The operation derives the patterns from the source URI; the part inside the storage is the
          // same the MK2 function derives from the entry path.
          compare('mk2-source:src/index.ts#diablo3AniSidecarPatterns', 'model.companions',
            ((opened.companions as { animations?: string[] } | undefined)?.animations ?? []).map(pattern => pattern.slice(pattern.lastIndexOf('!/') + 2)),
            port.diablo3AniSidecarPatterns(appearance.id)),
          compare('mk2-source:src/index.ts#diablo3AppearanceModelCodec', 'codec contribution blizzard/diablo3-app',
            [port.diablo3AppearanceModelCodec.id, (await nested(appearance.id, 'blizzard/diablo3-app').then(async subject => {
              const id = subject.selected.contributionId
              await subject.session.dispose()
              return id
            }))],
            [port.diablo3AppearanceModelCodec.id, 'blizzard/diablo3-app']),
          compare('mk2-manifest:match.extensions', 'spec.match.extensions',
            mk3.spec.match.extensions.map(item => `.${item}`).sort(), [...mk2.match.extensions].sort()),
          compare('mk2-manifest:operations', 'model.export-uvm (model.read); model.render of the core UVM codec (model.render)',
            [[...mk2.operations].sort(), mk3.spec.operations.some(operation => operation.id === 'model.export-uvm')],
            [['model.read', 'model.render'], true]),
        )
      }

      {
        const cube = await entryOf('textures/bronze_irradiance.tex')
        const raw = await entryOf('textures/woodfence.tex')
        const atlas = await entryOf('textures/raidenbolt.tex')
        const appearance = await entryOf('appearance/breakable_painting_c.app')
        const header = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const read = async (entryId: string, face: number, width: number, height: number) => {
          const subject = await nested(entryId, 'blizzard/diablo3-tex')
          const raster = await subject.session.dataSource('common.view/raster-image-source', 1)
          try {
            const info = await raster.value.info()
            const region = await raster.value.readRegion?.({
              x: 0, y: 0, width, height, frame: 0, mipLevel: 0, layer: 0, face, slice: 0, pixelFormat: 'rgba8', maxBytes: budget.maxScalarBytes,
            })
            return { info, pixels: region?.pixels }
          } finally {
            await raster.release()
            await subject.session.dispose()
          }
        }
        const cubeFace5 = await read(cube.id, 5, 32, 32)
        const rawRead = await read(raw.id, 0, 254, 63)
        const rawAt = header(raw.bytes).getUint32(0x38, true) + 16
        const rawAgrees = rawRead.pixels !== undefined &&
          Array.from({ length: 254 * 63 }, (_, pixel) => rawRead.pixels![pixel * 4] === raw.bytes[rawAt + pixel]).every(Boolean)
        const atlasSummary = (await inspectOf(atlas.id, 'blizzard/diablo3-tex')).summary
        // Two different blocks per format, stored component-planar as the game stores them.
        const planar = (blocks: readonly Uint8Array[], parts: readonly number[]) => {
          const out: number[] = []
          let start = 0
          for (const length of parts) {
            for (const block of blocks) out.push(...block.subarray(start, start + length))
            start += length
          }
          return Uint8Array.from(out)
        }
        const blockCases: [number, BcFormat, number[]][] = [[9, 'DXT1', [4, 4]], [11, 'DXT3', [8, 4, 4]], [12, 'DXT5', [2, 6, 4, 4]], [43, 'BC5', [2, 6, 4, 4]]]
        const texCodec = (await import(pathToFileURL(join(extension, 'src', 'diablo3-tex', 'codec.js')).href)) as {
          createCodec: (context: unknown) => { open: (input: unknown, mode: string, budget: unknown) => Promise<{
            dataSource: (contract: string, major: number) => Promise<{ value: { readRegion: (request: unknown) => Promise<{ pixels: Uint8Array }> }; release: () => Promise<void> }>
            dispose: () => Promise<void>
          }> }
        }
        const unshuffled: boolean[] = []
        for (const [id, format, parts] of blockCases) {
          const blockBytes = parts.reduce((sum, part) => sum + part, 0)
          const blocks = [0, 1].map(block => Uint8Array.from({ length: blockBytes }, (_, index) => (index * 37 + block * 101 + 11) & 0xff))
          const synthetic = new Uint8Array(0x270 + 16 + blockBytes * 2)
          const view = new DataView(synthetic.buffer)
          ;[[0, 0xdeadbeef], [4, 47], [0x20, id], [0x24, 8], [0x28, 4], [0x2c, 1], [0x38, 0x270], [0x3c, blockBytes * 2]]
            .forEach(([offset, value]) => view.setUint32(offset!, value!, true))
          synthetic.set(planar(blocks, parts), 0x270 + 16)
          const uri = `memory://audit-${id}.tex`
          const value = { kind: 'bytes', ref: { id: uri, uri }, revision: `content-hash.sha256:audit-${id}`, size: BigInt(synthetic.byteLength),
            read: async (offset: bigint, length: number) => synthetic.slice(Number(offset), Number(offset) + length), async *stream() { yield synthetic } }
          const binding = { sourceKind: 'candidate', bindingId: 'content', role: 'content', ownership: 'owned', source: value.ref, revision: value.revision }
          const session = await texCodec.createCodec({ budgets: budget, diagnostics: { report: () => undefined },
            contracts: { resolve: async () => undefined, resolveUnknown: async () => undefined } }).open({
            originKind: 'single', bindings: [binding], primaryBindingId: 'content',
            revisions: { topology: 'single', revision: value.revision, bindings: [{ bindingId: 'content', revision: value.revision }], compositionFingerprint: uri },
            bindingsFor: () => [], openBinding: async () => ({ value, release: async () => undefined }),
          }, 'inspect', budget)
          const source = await session.dataSource('common.view/raster-image-source', 1)
          const region = await source.value.readRegion({ x: 0, y: 0, width: 8, height: 4, pixelFormat: 'rgba8', maxBytes: 128 })
          await source.release()
          await session.dispose()
          const interleaved = new Uint8Array(blockBytes * 2)
          interleaved.set(blocks[0]!, 0)
          interleaved.set(blocks[1]!, blockBytes)
          // pixel format 9 is opaque BC1 (MK3 deviation, 30.09: MK2 decoded its fourth three-colour index as
          // a hole; D3ModelViewer and the installed hair and water maps say opaque) — the planes unshuffle alike
          const expected = decodeBcSurface(interleaved, 0, 8, 4, format)
          if (id === 9) for (let alpha = 3; alpha < expected.length; alpha += 4) expected[alpha] = 255
          unshuffled.push(canonical([...region.pixels]) === canonical([...expected]))
        }
        const mk2 = await mk2Manifest('diablo3-tex')
        const mk3 = await mk3Manifest('codec-diablo3-tex.json')
        await auditSamples('diablo3-tex.audit', ['codec.manifest.json', 'src/index.ts'], [cube, raw, atlas, appearance])
        claims['diablo3-tex.audit']!.cases.push(
          compare('mk2-source:src/index.ts#isDiablo3Tex', 'src/diablo3-tex/codec.ts detect (host routing)',
            [(await nested(raw.id, 'blizzard/diablo3-tex').then(async subject => {
              const id = subject.selected.contributionId
              await subject.session.dispose()
              return id
            })), header(appearance.bytes).getUint32(4, true) === 47],
            ['blizzard/diablo3-tex', false]),
          compare('mk2-source:src/index.ts#unshuffleDiablo3Blocks', 'src/diablo3-tex/codec.ts unshuffle + @modkit/codec-kit/texture/bc',
            unshuffled, [true, true, true, true]),
          compare('mk2-source:src/index.ts#decodeDiablo3Tex', 'common.view/raster-image-source readRegion (mip, face)',
            [cubeFace5.info.faces, cubeFace5.pixels?.length, rawAgrees], [6, 32 * 32 * 4, true]),
          // MK2 cropped an atlas frame by the frame table; MK3's raster contract has one size for every
          // frame, and Diablo III atlas frames differ in size, so the crop is not carried.
          compare('mk2-source:src/index.ts#decodeDiablo3Tex frameIndex (cropFrame)', 'not carried (atlas frame cropping)',
            { state: 'not-carried', atlasFrames: atlasSummary['frames'] }, { state: 'not-carried', atlasFrames: 5 }),
          compare('mk2-source:src/index.ts#describeDiablo3Tex', 'view.inspect summary',
            [atlasSummary['width'], atlasSummary['height'], atlasSummary['snoId'], atlasSummary['pixelFormat']],
            [header(atlas.bytes).getUint32(0x24, true), header(atlas.bytes).getUint32(0x28, true), header(atlas.bytes).getInt32(0x10, true), 'BC1 / DXT1']),
          compare('mk2-source:src/index.ts#describeFrames', 'view.inspect summary frames',
            atlasSummary['frames'], header(atlas.bytes).getUint32(0x218, true)),
          compare('mk2-manifest:match.extensions', 'spec.match.extensions',
            mk3.spec.match.extensions.map(item => `.${item}`).sort(), [...mk2.match.extensions].sort()),
          compare('mk2-manifest:operations', 'view.inspect (image.inspect); common.view/raster-image-source (image.read)',
            [[...mk2.operations].sort(), mk3.spec.operations.some(operation => operation.id === 'view.inspect'),
              mk3.spec.publishesDataSources.some(source => source.contract === 'common.view/raster-image-source')],
            [['image.inspect', 'image.read'], true, true]),
        )
      }
    } finally {
      await casc.session.dispose()
      await rm(directory, { recursive: true, force: true })
    }

    for (const [name, claim] of Object.entries(claims)) {
      const passed = claim.cases.filter(item => item.verdict === 'identical').length
      const failed = claim.cases.length - passed
      const receipt = {
        schemaVersion: 1,
        codec: claim.codec,
        corpusKind: claim.legacyOperation === undefined ? 'mixed' : 'real',
        verdict: failed === 0 ? 'pass' : 'fail',
        tests: { passed, failed, skipped: 0 },
        inputs: {
          operation: claim.operation,
          oracle: claim.oracle,
          suite,
          corpus: {
            game: 'blizzard/diablo-3',
            version: installation.version ?? 'unknown',
            discovery: 'common.game/installation-discovery (blizzard/diablo3-installation)',
            container: 'blizzard/casc',
            listed,
          },
          samples: claim.samples,
        },
        oracleVerification: { verified: failed === 0, modules: claim.modules, operation: claim.operation },
        cases: claim.cases,
        proofs: [
          {
            ...(claim.legacyOperation === undefined
              ? { requirement: `legacy/codec-manifest/modkit/${claim.codec}/audit`, kind: 'audit' }
              : {
                  requirement: `legacy/codec-manifest/modkit/${claim.codec}/operation/${claim.legacyOperation}`,
                  kind: 'operation',
                  legacyOperation: claim.legacyOperation,
                }),
            adapterOperation: claim.operation,
            ...claim.target,
            contribution: claim.contribution,
            executed: true,
            caseIds: claim.cases.filter(item => item.verdict === 'identical').map(item => item.id),
          },
        ],
      }
      expect(receipt.tests.failed, name).toBe(0)
      const file = join(receipts, `${name}.json`)
      if (write) {
        await mkdir(receipts, { recursive: true })
        await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`)
      }
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(receipt)
    }
  }, 1_800_000)
})
