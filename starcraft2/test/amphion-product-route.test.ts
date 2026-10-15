import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { build } from '../../../modkit-core/node_modules/esbuild/lib/main.js'
import { chromium } from '../../../modkit-core/node_modules/playwright-core/index.mjs'
import { describe, expect, it } from 'vitest'
import {
  buildInventory,
  coordinateMapPreviewAssetSession,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  createSubjectServices,
  openSubject,
  registerServiceDefinitionsOrThrow,
  resolveMapPreviewPreparation,
} from '@modkit/host'
import { loadExtensionDirectory, openPathArtifactSource } from '@modkit/host/node'
import type { AssetSession, ResourceBudget } from '@modkit/sdk'
import {
  inspectCandidateWorld,
  type CandidateWorldViewerModel,
} from '../../../modkit-core/packages/ui/src/world/index.js'
import { createNodeMapPreviewResourcePlanResolver } from '../../../modkit-core/packages/host/src/node/map-preview-resource-resolver.js'
import { createContentSourceMapPreviewResourcePlanResolver } from '../../../modkit-core/packages/host/src/node/content-source-map-preview-resolver.js'
import { Sc2DesktopContentSources } from '../dist/modules/game/battlenet/content-sources/local-content-sources.js'

const repoRoot = join(import.meta.dirname, '..', '..')
const coreRoot = join(repoRoot, '..', 'modkit-core')
const sc2Root = process.env.MODKITX_SC2_ROOT ?? 'F:/GAMES/Blizzard/StarCraft II'
const amphionRoot = process.env.MODKIT_AMPHION_MAP ?? `${sc2Root}/Maps/Amphion.SC2Map`
const receiptPath = process.env.MODKIT_AMPHION_RECEIPT ?? join(repoRoot, '..', 'artifacts', 'sc2-amphion-product-route.json')
const screenshotPath = process.env.MODKIT_AMPHION_SCREENSHOT ?? join(
  repoRoot,
  '..',
  'artifacts',
  'sc2-amphion-product-route-webgl-compact-layer-ids-full-96.png',
)
/**
 * `MODKIT_CATALOG_DUMP=<file.json>`: write the resolved catalog entities the map analysis receives
 * (every entity it asked for, with only the behaviours of placed units) as a snapshot for
 * `reports/tools/sc2-cliffs/cliff-diagnostics.ts lattice-map --catalog=<file.json>`.
 */
const catalogDumpPath = process.env.MODKIT_CATALOG_DUMP

type ProviderModule = Record<string, unknown> & {
  createProvider?: (selection: unknown) => { value: Record<string, unknown>; release: () => Promise<void> }
}

function captureSemanticAnalysis(module: Record<string, unknown>): Record<string, unknown> {
  const original = module as ProviderModule
  if (typeof original.createProvider !== 'function') return module
  const createProvider = original.createProvider
  return {
    ...module,
    createProvider(selection: unknown) {
      const provider = createProvider(selection)
      const analyze = provider.value['analyze']
      if (typeof analyze !== 'function') return provider
      return {
        ...provider,
        value: {
          ...provider.value,
          async analyze(request: { catalog?: { definitions?: Record<string, unknown>[]; entities?: Record<string, unknown>[] }; documents: { path: string; bytes: Uint8Array }[] }) {
            const result = await (analyze as (value: unknown) => Promise<unknown>)(request)
            const catalog = request.catalog
            if (catalog !== undefined && catalogDumpPath !== undefined) {
              const objects = request.documents.find(document => /(^|\/)objects$/iu.test(document.path))
              const text = objects === undefined ? '' : new TextDecoder().decode(objects.bytes)
              const placed = new Set([...text.matchAll(/(?:UnitType|Type)="([^"]+)"/gu)].map(match => match[1]))
              const entities = catalog.definitions ?? catalog.entities ?? []
              const behaviors = new Set(
                entities
                  .filter(entity => entity['namespace'] === 'Unit' && placed.has(String(entity['entityId'])))
                  .flatMap(entity => JSON.stringify((entity['fields'] as Record<string, unknown>)?.['BehaviorArray'] ?? []).match(/"Link":"[^"]+"/gu) ?? [])
                  .map(link => link.slice(8, -1)),
              )
              // The analysis asks only for what the map names (a few hundred entities): all of it,
              // so a model, water or terrain question is answered from the dump.
              const wanted = entities.filter(
                entity =>
                  String(entity['namespace']) !== 'Behavior' ||
                  behaviors.has(String(entity['entityId'])),
              )
              writeFileSync(
                catalogDumpPath,
                JSON.stringify({
                  keys: Object.keys(catalog),
                  total: entities.length,
                  entities: wanted,
                  lighting: (result as { lighting?: unknown } | undefined)?.lighting,
                }),
              )
            }
            return result
          },
        },
      }
    },
  }
}

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((value): value is string => value !== undefined)
const requestedMaxModels = Number.parseInt(
  process.env.MODKIT_AMPHION_MAX_MODELS ??
    (process.env.MODKIT_AMPHION_DIAGNOSTIC_ONE_MODEL === '1' ? '1' : '128'),
  10,
)
const maxModels =
  Number.isSafeInteger(requestedMaxModels) && requestedMaxModels > 0 ? requestedMaxModels : 128
const skipWebGl = process.env.MODKIT_AMPHION_SKIP_WEBGL === '1'
/**
 * Terrain and cliffs only: skips opening every doodad and unit model, which is most of the run.
 * Use it when the thing under test is the terrain or the cliff pieces.
 */
const cliffsOnly = process.env.MODKIT_AMPHION_CLIFFS_ONLY === '1'
const requestedViewportWidth = Number.parseInt(
  process.env.MODKIT_AMPHION_VIEWPORT_WIDTH ?? '1280',
  10,
)
const requestedViewportHeight = Number.parseInt(
  process.env.MODKIT_AMPHION_VIEWPORT_HEIGHT ?? '900',
  10,
)
const viewportWidth =
  Number.isSafeInteger(requestedViewportWidth) && requestedViewportWidth > 0
    ? requestedViewportWidth
    : 1280
const viewportHeight =
  Number.isSafeInteger(requestedViewportHeight) && requestedViewportHeight > 0
    ? requestedViewportHeight
    : 900
const requestedCameraZoom = Number(process.env.MODKIT_AMPHION_CAMERA_ZOOM ?? '1.65')
const cameraZoom =
  Number.isFinite(requestedCameraZoom) && requestedCameraZoom >= 0.125 && requestedCameraZoom <= 16
    ? requestedCameraZoom
    : 1.65
const cameraTarget = [
  Number(process.env.MODKIT_AMPHION_CAMERA_TARGET_X ?? '0'),
  Number(process.env.MODKIT_AMPHION_CAMERA_TARGET_Y ?? '0'),
  Number(process.env.MODKIT_AMPHION_CAMERA_TARGET_Z ?? '0'),
].map(value => (Number.isFinite(value) ? value : 0))
const budget: ResourceBudget = {
  maxInputBytes: 536_870_912n,
  maxDepth: 128,
  maxNodes: 2_000_000,
  maxScalarBytes: 536_870_912,
  maxDiagnostics: 2_000,
}

interface BrowserBinaryPayload {
  readonly chunks: Uint8Array[]
  readonly views: WeakMap<ArrayBufferView, Readonly<{ offset: number; byteLength: number }>>
  byteLength: number
}

function encodeBrowserValue(value: unknown, binary: BrowserBinaryPayload): unknown {
  if (value === undefined) return undefined
  if (typeof value === 'bigint') return { $bigint: value.toString() }
  if (ArrayBuffer.isView(value)) {
    const previous = binary.views.get(value)
    if (previous !== undefined) {
      return {
        $typed: value.constructor.name,
        offset: previous.offset,
        byteLength: previous.byteLength,
      }
    }
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    // 8-byte alignment lets the browser reader view typed arrays in place instead of copying them.
    const padding = (8 - (binary.byteLength % 8)) % 8
    if (padding > 0) {
      binary.chunks.push(new Uint8Array(padding))
      binary.byteLength += padding
    }
    const offset = binary.byteLength
    binary.chunks.push(bytes)
    binary.byteLength += bytes.byteLength
    binary.views.set(value, { offset, byteLength: bytes.byteLength })
    return {
      $typed: value.constructor.name,
      offset,
      byteLength: bytes.byteLength,
    }
  }
  if (value instanceof Map) {
    return {
      $map: [...value].map(([key, item]) => [
        encodeBrowserValue(key, binary),
        encodeBrowserValue(item, binary),
      ]),
    }
  }
  if (Array.isArray(value)) return value.map(item => encodeBrowserValue(item, binary))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, encodeBrowserValue(item, binary)] as const)
        .filter(([, item]) => item !== undefined),
    )
  }
  return value
}

function amphionRenderSource(inspected: CandidateWorldViewerModel) {
  const items = inspected.layers
    .flatMap(layer => layer.page.items)
    .flatMap(item => {
      if (item.facet === 'resources' || item.facet === 'layers') return []
      if (item.facet !== 'objects') return [item]
      if (cliffsOnly && item.derivedFrom !== 'cliffs') return []
      const { catalog: _catalog, ...renderItem } = item
      return [renderItem]
    })
  const models = new Map(
    [...(inspected.models ?? [])].flatMap(([id, model]) =>
      model.state === 'converted'
        ? [
            [
              id,
              {
                ...model,
                // Live effects (geyser smoke) are simulated from the UVM itself; other models drop
                // the bytes to keep the payload small.
                uvmBytes:
                  model.uvmBytes !== undefined &&
                  Buffer.from(model.uvmBytes.buffer, model.uvmBytes.byteOffset, model.uvmBytes.byteLength).includes('UV_game_effects')
                    ? model.uvmBytes
                    : undefined,
                diagnostics: [],
              },
            ] as const,
          ]
        : [],
    ),
  )
  return {
    items,
    models,
    terrainMaterials: inspected.layers.flatMap(layer => layer.layer.materials ?? []),
    // Same renderer input as packages/ui/src/world: without rasters every cell falls back to
    // constant per-cell splat weights.
    terrainWeightRasters: inspected.layers.flatMap(layer => layer.layer.weightRasters ?? []),
    terrainTextures: inspected.terrainTextures,
    waterMaterials: inspected.layers.flatMap(layer => layer.layer.waterMaterials ?? []),
  }
}

/** Saves the exact browser payload so `modkit-core/scripts/render-world-payload.mjs` can re-render without CASC. */
function writeWorldPayload(inspected: CandidateWorldViewerModel, directory: string) {
  const binary: BrowserBinaryPayload = { chunks: [], views: new WeakMap(), byteLength: 0 }
  const json = JSON.stringify(encodeBrowserValue(amphionRenderSource(inspected), binary))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'world.json'), json)
  const file = openSync(join(directory, 'world.bin'), 'w')
  try {
    for (const chunk of binary.chunks) writeSync(file, chunk)
  } finally {
    closeSync(file)
  }
  writeFileSync(
    join(directory, 'meta.json'),
    `${JSON.stringify({ fixture: amphionRoot, snapshotId: inspected.snapshotId, binaryBytes: binary.byteLength }, null, 2)}\n`,
  )
}

function uniqueViewBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (ArrayBuffer.isView(value)) {
    if (seen.has(value)) return 0
    seen.add(value)
    return value.byteLength
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return 0
  seen.add(value)
  if (value instanceof Map)
    return [...value].reduce(
      (sum, [key, item]) => sum + uniqueViewBytes(key, seen) + uniqueViewBytes(item, seen),
      0,
    )
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + uniqueViewBytes(item, seen), 0)
  return Object.values(value).reduce((sum, item) => sum + uniqueViewBytes(item, seen), 0)
}

function encodedPayloadSize(value: unknown) {
  const binary: BrowserBinaryPayload = { chunks: [], views: new WeakMap(), byteLength: 0 }
  const json = JSON.stringify(encodeBrowserValue(value, binary))
  return Object.freeze({
    jsonBytes: Buffer.byteLength(json),
    binaryBytes: binary.byteLength,
    totalBytes: Buffer.byteLength(json) + binary.byteLength,
  })
}

function amphionPayloadBreakdown(inspected: CandidateWorldViewerModel) {
  const source = amphionRenderSource(inspected)
  const modelValues = [...source.models.values()]
  const modelGeometryBytes = uniqueViewBytes(modelValues.map(model => model.primitives ?? []))
  const modelTextureBytes = uniqueViewBytes(modelValues.map(model => model.textures ?? []))
  const modelTotalBytes = uniqueViewBytes(modelValues)
  const terrainTextureBytes = uniqueViewBytes(source.terrainTextures)
  const itemBytes = uniqueViewBytes(source.items)
  const terrainMaterialBytes = uniqueViewBytes(source.terrainMaterials)
  const waterMaterialBytes = uniqueViewBytes(source.waterMaterials)
  const categories = {
    items: source.items,
    ...Object.fromEntries(
      [...new Set(source.items.map(item => item.facet))].map(facet => [
        `items:${facet}`,
        source.items.filter(item => item.facet === facet),
      ]),
    ),
    modelPrimitives: modelValues.map(model => model.primitives ?? []),
    modelTextures: modelValues.map(model => model.textures ?? []),
    modelMetadata: modelValues.map(model => ({ ...model, primitives: [], textures: [] })),
    terrainTextures: source.terrainTextures,
    terrainMaterials: source.terrainMaterials,
    waterMaterials: source.waterMaterials,
  }
  return Object.freeze({
    totalBytes: uniqueViewBytes(source),
    modelTotalBytes,
    modelGeometryBytes,
    modelTextureBytes,
    modelOtherBytes: modelTotalBytes - modelGeometryBytes - modelTextureBytes,
    terrainTextureBytes,
    itemBytes,
    terrainMaterialBytes,
    waterMaterialBytes,
    ...(skipWebGl
      ? {
          encoded: encodedPayloadSize(source),
          encodedCategories: Object.freeze(
            Object.fromEntries(
              Object.entries(categories).map(([name, value]) => [name, encodedPayloadSize(value)]),
            ),
          ),
        }
      : {}),
  })
}

async function renderAmphionEvidence(inspected: CandidateWorldViewerModel) {
  const startedAt = Date.now()
  const executablePath = chromeCandidates.find(candidate => existsSync(candidate))
  if (executablePath === undefined) throw new Error('Chrome or Edge is required for Amphion proof')
  const source = amphionRenderSource(inspected)
  const binary: BrowserBinaryPayload = {
    chunks: [],
    views: new WeakMap(),
    byteLength: 0,
  }
  const payload = JSON.stringify(encodeBrowserValue(source, binary))
  const payloadEncodedAt = Date.now()
  const bundled = await build({
    stdin: {
      contents: `
        import { createWorldWebGlRenderer } from './packages/scene/src/world/webgl.ts';
        const constructors = {
          Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
          Int32Array, Uint32Array, Float32Array, Float64Array, DataView,
        };
        const binary = await fetch('/world.bin').then(response => response.arrayBuffer());
        const typedViews = new Map();
        const revive = value => {
          if (Array.isArray(value)) return value.map(revive);
          if (value === null || typeof value !== 'object') return value;
          if ('$bigint' in value) return BigInt(value.$bigint);
          if ('$typed' in value) {
            const Constructor = constructors[value.$typed];
            if (Constructor === undefined) throw new Error('unsupported typed array ' + value.$typed);
            const key = value.$typed + ':' + value.offset + ':' + value.byteLength;
            const previous = typedViews.get(key);
            if (previous !== undefined) return previous;
            const bytes = binary.slice(value.offset, value.offset + value.byteLength);
            const revived = Constructor === DataView ? new DataView(bytes) : new Constructor(bytes);
            typedViews.set(key, revived);
            return revived;
          }
          if ('$map' in value) return new Map(value.$map.map(([key, item]) => [revive(key), revive(item)]));
          return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
        };
        const payload = revive(await fetch('/world.json').then(response => response.json()));
        const canvas = document.querySelector('canvas');
        const renderer = createWorldWebGlRenderer(canvas);
        if (renderer === undefined) throw new Error('WebGL2 is unavailable');
        const gl = canvas.getContext('webgl2');
        let stats;
        for (let frame = 0; frame < 2; frame += 1) {
          stats = renderer.draw({
            ...payload,
            camera: {
              azimuth: Math.PI / 4,
              elevation: 0.52,
              zoom: ${String(cameraZoom)},
              target: [${cameraTarget.map(value => String(value)).join(', ')}],
            },
            shadows: true,
            shadowMapSize: 2048,
            timeSeconds: 0,
          });
        }
        gl.finish();
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let changedPixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset] !== 9 || pixels[offset + 1] !== 14 || pixels[offset + 2] !== 19)
            changedPixels += 1;
        }
        globalThis.amphionEvidence = {
          stats,
          changedPixels,
          version: gl.getParameter(gl.VERSION),
        };
      `,
      resolveDir: coreRoot,
      loader: 'ts',
    },
    absWorkingDir: coreRoot,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2023',
    write: false,
    logLevel: 'silent',
  })
  const bundleBuiltAt = Date.now()
  const application = bundled.outputFiles[0]?.contents
  if (application === undefined) throw new Error('Amphion WebGL browser bundle was not emitted')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#091019}canvas{display:block;width:${String(viewportWidth)}px;height:${String(viewportHeight)}px}</style></head><body><canvas width="${String(viewportWidth)}" height="${String(viewportHeight)}"></canvas><script type="module" src="/app.js"></script></body></html>`
  const server = createServer((request, response) => {
    if (request.url === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(application)
    } else if (request.url === '/world.json') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(payload)
    } else if (request.url === '/world.bin') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(binary.byteLength),
      })
      for (const chunk of binary.chunks) {
        response.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      }
      response.end()
    } else {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
    }
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('browser server failed')
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--enable-webgl',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
      ],
    })
    const page = await browser.newPage({
      viewport: { width: viewportWidth, height: viewportHeight },
    })
    await page.goto(`http://127.0.0.1:${String(address.port)}`)
    await page.waitForFunction(() => 'amphionEvidence' in globalThis, undefined, {
      timeout: 600_000,
    })
    const evidence = await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            amphionEvidence: {
              stats: Record<string, number>
              changedPixels: number
              version: string
            }
          }
        ).amphionEvidence,
    )
    const evidenceReadyAt = Date.now()
    mkdirSync(join(repoRoot, '..', 'artifacts'), { recursive: true })
    await page.screenshot({ path: screenshotPath })
    return {
      ...evidence,
      payloadBytes: Buffer.byteLength(payload) + binary.byteLength,
      screenshotSha256: createHash('sha256').update(readFileSync(screenshotPath)).digest('hex'),
      timings: {
        payloadEncodingMilliseconds: payloadEncodedAt - startedAt,
        browserBundleMilliseconds: bundleBuiltAt - payloadEncodedAt,
        browserRenderMilliseconds: evidenceReadyAt - bundleBuiltAt,
        totalMilliseconds: evidenceReadyAt - startedAt,
      },
    }
  } finally {
    if (browser !== undefined) await browser.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('Amphion browser binary transport', () => {
  it('reuses one binary range for repeated typed-array views', () => {
    const binary: BrowserBinaryPayload = {
      chunks: [],
      views: new WeakMap(),
      byteLength: 0,
    }
    const pixels = Uint8Array.of(1, 2, 3, 4)
    const first = encodeBrowserValue(pixels, binary)
    const second = encodeBrowserValue(pixels, binary)
    expect(second).toEqual(first)
    expect(binary.chunks).toHaveLength(1)
    expect(binary.byteLength).toBe(4)
  })
})

describe.skipIf(
  (process.env.MODKIT_TEST_INSTALLED_CORPUS !== '1' && process.env.MODKIT_AMPHION_RUN !== '1') ||
    !existsSync(amphionRoot),
)(
  'installed Amphion product route',
  () => {
    it('opens the packed map with installed dependencies and resolves render resources', async () => {
      const modelResourceProfiles: unknown[] = []
      const inputs = await Promise.all(
        [
          join(repoRoot, 'starcraft2'),
          join(repoRoot, 'mpq'),
          join(repoRoot, 'casc'),
          join(repoRoot, 'models'),
          join(coreRoot, 'extensions', 'images'),
          join(coreRoot, 'extensions', 'models'),
        ].map(directory => loadExtensionDirectory(directory)),
      )
      const stableInputs = inputs.map((input, index) =>
        index === 0
          ? {
              ...input,
              artifact: {
                ...input.artifact,
                verifyArtifactDigest: expected => expected === input.artifact.artifactDigest,
              },
            }
          : input,
      )
      const inventory = await buildInventory(
        stableInputs.map(input => ({
          ...input,
          execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
        })),
        createHostContributionContractRegistry(),
      )
      const uvmContribution = inventory.extensions
        .flatMap(extension => extension.contributions)
        .find(contribution => contribution.manifest?.id === 'modkit/model-uvm')
      expect(uvmContribution, JSON.stringify(inventory.diagnostics)).toBeDefined()
      expect(uvmContribution?.activationEligible, JSON.stringify(uvmContribution)).toBe(true)
      const ddsContribution = inventory.extensions.flatMap(extension => extension.contributions).find(contribution => contribution.manifest?.id === 'modkit/dds')
      expect(ddsContribution?.activationEligible, JSON.stringify(ddsContribution?.diagnostics)).toBe(true)
      // This installed-corpus test owns its source imports. The repository may contain unrelated
      // concurrent Galaxy/Triggers edits, so a whole-extension digest cannot remain stable while
      // the map runtime itself is unchanged; packed distribution remains a separate release gate.
      // The same entrypoint URL is the same module; under vitest every dynamic import() still goes
      // through the module runner (resolve + transform RPC), which cost ~1.3 s per model because
      // each codec open activates its extension again.
      const importedModules = new Map<string, Promise<Record<string, unknown>>>()
      const executionBackends = createExecutionBackendRegistry([
        {
          profile: 'trusted-in-process',
          supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
          async activate(context) {
            let module = importedModules.get(context.entrypoint.href)
            if (module === undefined) {
              module = import(context.entrypoint.href) as Promise<Record<string, unknown>>
              importedModules.set(context.entrypoint.href, module)
            }
            const loaded = await module
            return {
              module:
                catalogDumpPath !== undefined && /providers[\\/]semantic[\\/]runtime\.js$/u.test(context.entrypoint.pathname)
                  ? captureSemanticAnalysis(loaded)
                  : loaded,
              release: async () => undefined,
            }
          },
        },
      ])
      const serviceDefinitions = createBundledServiceDefinitionRegistry()
      await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
      const target = {
        environment: 'node' as const,
        operatingSystem: 'windows' as const,
        architecture: 'x64' as const,
      }
      const services = createSubjectServices({
        inventory,
        target,
        executionBackends,
        serviceDefinitions,
      })
      const installationResolver = createNodeMapPreviewResourcePlanResolver({
        subjects: services,
        configuredPaths: { 'blizzard/starcraft-2': [sc2Root] },
      })
      // `MODKIT_AMPHION_CONTENT_SOURCES=1`: the product path — the map names its dependencies and
      // the desktop content sources (installation folder, then CASC) mount every layer.
      const contentSources = process.env.MODKIT_AMPHION_CONTENT_SOURCES === '1'
        ? new Sc2DesktopContentSources({ installationDirectory: sc2Root, wizardDirectories: [] })
        : undefined
      const resourcePlanResolver = contentSources === undefined
        ? installationResolver
        : createContentSourceMapPreviewResourcePlanResolver({
            contentSources: async () => contentSources as never,
            fallback: installationResolver,
          })
      let original: AssetSession | undefined
      let openedPreview: AssetSession | undefined
      let preparation: Awaited<ReturnType<typeof resolveMapPreviewPreparation>> | undefined
      try {
        const opened = await openSubject({
          inventory,
          // a path source opens a packed map or a map folder
          source: await openPathArtifactSource(amphionRoot),
          path: amphionRoot,
          intent: 'full',
          target,
          grant: { id: 'amphion-product-open', classes: ['read-source'] },
          executionBackends,
          budget,
          serviceDefinitions,
        })
        expect(opened.state, JSON.stringify(opened)).toBe('opened')
        if (opened.state !== 'opened') throw new Error(JSON.stringify(opened))
        original = opened.session
        // a packed map, or a map folder when the fixture points at one
        expect(
          ['sc2-map', 'sc2-map-directory'],
          JSON.stringify({ descriptor: opened.descriptor, diagnostics: opened.diagnostics }),
        ).toContain(opened.descriptor.identity.formatId)
        preparation = await resolveMapPreviewPreparation({
          services,
          subjectFormatId: opened.descriptor.identity.formatId,
          grant: { id: 'amphion-product-preparation', classes: [] },
          budgets: budget,
        })
        expect(preparation.state, JSON.stringify(preparation)).toBe('resolved')
        if (preparation.state !== 'resolved') throw new Error(JSON.stringify(preparation))
        const coordinated = await coordinateMapPreviewAssetSession({
          onModelResourceProfile: profile => {
            if (modelResourceProfiles.length < 4096) modelResourceProfiles.push(profile)
          },
          services,
          grant: {
            id: 'amphion-product-coordinate',
            classes: ['read-source', 'filesystem-read', 'process-launch'],
          },
          budgets: budget,
          original,
          preparation: preparation.preparation,
          resourcePlanResolver,
          maxCandidates: 8,
          maxSubjectEntries: 8_192,
          maxSubjectPages: 16,
          maxRoots: 32,
          maxDepth: 16,
          limits: {
            maxDocuments: 16,
            maxDocumentBytes: 33_554_432,
            maxTotalBytes: 67_108_864,
            maxObjects: 100_000,
            maxRegions: 10_000,
            maxTerrainCells: 100_000,
            maxTerrainSamples: 100_000,
            maxDepth: 64,
            maxRequirements: 16,
            maxPageSize: 4_096,
            maxDiagnostics: 100,
          },
          catalogEnrichment: {
            locales: (process.env.MODKIT_AMPHION_LOCALES ?? 'enUS').split(','),
            limits: {
              // Full catalog planning needs more than 512 on Amphion once the stock chain is
              // mounted; under the budget the planner falls back to a priority list and cliff set
              // meshes never resolve, so no cliff piece is published at all.
              maxRequirements: Number(process.env.MODKIT_AMPHION_CATALOG_REQUIREMENTS ?? '512'),
              maxDocumentBytes: 16_777_216,
              maxTextBytes: 268_435_456,
              maxEntities: 100_000,
              maxDepth: 128,
              maxPageSize: 1_000,
            },
          },
        })
        expect(
          coordinated.state,
          coordinated.diagnostics.map(item => `${item.code}: ${item.message}`).join('\n'),
        ).toBe('opened')
        if (coordinated.state !== 'opened') throw new Error(JSON.stringify(coordinated))
        openedPreview = coordinated.session
        const world = await coordinated.session.dataSource('common.view/world-scene-source', 1)
        try {
          const inspected = await inspectCandidateWorld(world.value, {
            maxLayers: 32,
            maxItemsPerLayer: 100_000,
            maxPageItems: 4_096,
            maxModels,
            maxModelBytes: 1_610_612_736,
            maxConcurrentModelAcquisitions: 8,
            ...(cliffsOnly
              ? { modelResourceFilter: (resourceId: string) => resourceId.startsWith('cliff-model:') }
              : {}),
          })
          const items = inspected.layers.flatMap(layer => layer.page.items)
          const objects = items.filter(item => item.facet === 'objects')
          const resources = items.filter(item => item.facet === 'resources')
          const strategicResourcePattern = /mineral|vespene|geyser/iu
          const strategicResourceSamples = resources
            .filter(item => strategicResourcePattern.test(JSON.stringify(item)))
            .map(item =>
              item.facet === 'resources'
                ? {
                    id: item.id,
                    namespace: item.namespace,
                    entityId: item.entityId,
                    modelResource: item.modelResource,
                    objectCount: item.objectIds.length,
                  }
                : undefined,
            )
          const strategicObjectSamples = objects
            .filter(item => strategicResourcePattern.test(JSON.stringify(item)))
            .map(item =>
              item.facet === 'objects'
                ? {
                    objectId: item.objectId,
                    typeId: item.typeId,
                    position: item.position,
                    uvwPosition: item.uvwPosition,
                    variation: item.variation,
                    resourceId: item.resourceId,
                    modelResource: item.modelResource,
                  }
                : undefined,
            )
          const resolvedObjects = objects.filter(item =>
            item.facet === 'objects'
              ? item.resourceId !== undefined || (item.resourceIds?.length ?? 0) > 0
              : false,
          )
          const objectsWithoutConvertedModel = objects.flatMap(item => {
            if (item.facet !== 'objects') return []
            const resourceIds = [
              ...new Set([
                ...(item.resourceId === undefined ? [] : [item.resourceId]),
                ...(item.resourceIds ?? []),
              ]),
            ]
            const components =
              item.modelComponents ??
              resourceIds.map((resourceId, index) => ({
                id: `implicit-${String(index)}`,
                resourceId,
              }))
            if (
              components.some(
                component => inspected.models?.get(component.resourceId)?.state === 'converted',
              )
            ) {
              return []
            }
            return [
              {
                objectId: item.objectId,
                kind: item.kind,
                type: item.type,
                resourceId: item.resourceId,
                resourceIds,
                componentResourceIds: components.map(component => component.resourceId),
              },
            ]
          })
          const missingObjectModelResources = Object.entries(
            objectsWithoutConvertedModel
              .flatMap(item =>
                item.componentResourceIds.length > 0
                  ? item.componentResourceIds
                  : item.resourceIds.length > 0
                    ? item.resourceIds
                    : ['<none>'],
              )
              .reduce((counts, resourceId) => {
                counts[resourceId] = (counts[resourceId] ?? 0) + 1
                return counts
              }, {} as Record<string, number>),
          )
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .map(([resourceId, instances]) => ({ resourceId, instances }))
          const modelStates = Object.fromEntries(
            [...(inspected.models?.values() ?? [])]
              .map(model => model.state)
              .sort()
              .reduce((states, state) => {
                states.set(state, (states.get(state) ?? 0) + 1)
                return states
              }, new Map<string, number>()),
          )
          const modelDiagnosticCodes = Object.fromEntries(
            [...(inspected.models?.values() ?? [])]
              .flatMap(model => model.diagnostics.map(item => item.code))
              .sort()
              .reduce((codes, code) => {
                codes.set(code, (codes.get(code) ?? 0) + 1)
                return codes
              }, new Map<string, number>()),
          )
          const modelFailures = [...(inspected.models ?? [])]
            .filter(([, model]) => model.state === 'unresolved')
            .sort(([, left], [, right]) => {
              const leftBudget = left.diagnostics.some(
                item => item.code === 'x3.ui/world-model-budget-exhausted',
              )
              const rightBudget = right.diagnostics.some(
                item => item.code === 'x3.ui/world-model-budget-exhausted',
              )
              return Number(leftBudget) - Number(rightBudget)
            })
            .slice(0, 16)
            .map(([resourceId, model]) => ({ resourceId, diagnostics: model.diagnostics }))
          const convertedModelResourceIds = [...(inspected.models ?? [])]
            .filter(([, model]) => model.state === 'converted')
            .map(([resourceId]) => resourceId)
            .sort()
          const strategicModelStates = strategicResourceSamples.map(resource => {
            const resourceId = resource?.id ?? ''
            const model = inspected.models?.get(resourceId)
            return {
              resourceId,
              state: model?.state ?? 'absent',
              diagnostics: model?.diagnostics ?? [],
            }
          })
          const modelSamples = [...(inspected.models ?? [])]
            .filter(([, model]) => model.state === 'converted')
            .slice(0, 16)
            .map(([resourceId, model]) => ({
              resourceId,
              primitives: model.primitives.length,
              textures: (model.textures ?? []).map(texture => ({
                id: texture.id,
                width: texture.width,
                height: texture.height,
                channelLayout: texture.channelLayout,
                compression: texture.compression,
              })),
              materials: (model.materials ?? []).map(material => ({
                id: material.id,
                alphaMode: material.alphaMode,
                blendMode: material.blendMode,
                shaderId: material.shader?.id,
                layers: material.layers?.map(layer => ({
                  slot: layer.slot,
                  resourceId: layer.resourceId,
                  uvSource: layer.uvSource,
                })),
              })),
            }))
          if (process.env.MODKIT_WORLD_PAYLOAD_OUT !== undefined)
            writeWorldPayload(inspected, process.env.MODKIT_WORLD_PAYLOAD_OUT)
          const webgl =
            (modelStates.converted ?? 0) > 0 && !skipWebGl
              ? await renderAmphionEvidence(inspected)
              : undefined
          const payloadBreakdown = amphionPayloadBreakdown(inspected)
          const sourceKeys = [...(inspected.models?.values() ?? [])].flatMap(model =>
            model.state === 'converted' ? [model.sourceKey] : [],
          )
          const receipt = {
            schemaVersion: 2,
            generatedAt: new Date().toISOString(),
            configuration: {
              maxModels,
              maxModelBytes: 1_610_612_736,
              maxConcurrentModelAcquisitions: 8,
              modelRequestKey: inspected.modelRequestKey,
              cliffsOnly,
              skipWebGl,
              payloadOutput: process.env.MODKIT_WORLD_PAYLOAD_OUT,
            },
            sourceReuse: {
              successfulResults: sourceKeys.length,
              uniqueSourceKeys: new Set(sourceKeys).size,
              repeatedSuccessfulResults: sourceKeys.length - new Set(sourceKeys).size,
            },
            modelResourceProfiles,
            fixture: amphionRoot,
            snapshotId: inspected.snapshotId,
            facets: Object.fromEntries(
              inspected.layers.map(layer => [layer.layer.kind, layer.page.items.length]),
            ),
            // Why a facet came back empty: the page state and its reason, which the counts hide.
            layerStates: inspected.layers.map(layer => ({
              kind: layer.layer.kind,
              state: layer.page.state,
              items: layer.page.items.length,
              ...(layer.page.reason === undefined ? {} : { reason: layer.page.reason }),
            })),
            objects: objects.length,
            objectsWithLogicalResources: resolvedObjects.length,
            objectsWithoutConvertedModel: objectsWithoutConvertedModel.length,
            missingObjectModelResources,
            missingObjectModelSamples: objectsWithoutConvertedModel.slice(0, 32),
            models: inspected.models?.size ?? 0,
            modelStates,
            modelDiagnosticCodes,
            modelFailures,
            convertedModelResourceIds,
            strategicModelStates,
            modelSamples,
            terrainTextures: inspected.terrainTextures?.size ?? 0,
            terrainWeightRasters: inspected.layers.flatMap(layer =>
              (layer.layer.weightRasters ?? []).map(raster => ({
                resourceId: raster.resourceId,
                width: raster.width,
                height: raster.height,
                materialIds: raster.materialIds,
                textureLoaded: inspected.terrainTextures?.has(raster.resourceId) ?? false,
              })),
            ),
            payloadBreakdown,
            terrainTextureDiagnostics: inspected.terrainTextureDiagnostics ?? [],
            strategicResourceSamples,
            strategicObjectSamples,
            loadPerformance: inspected.loadPerformance,
            resourceSamples: resources.slice(0, 24),
            objectSamples: objects.slice(0, 12).map(item =>
              item.facet === 'objects'
                ? {
                    objectId: item.objectId,
                    kind: item.kind,
                    type: item.type,
                    variation: item.variation,
                    catalog: item.catalog,
                    resourceId: item.resourceId,
                    resourceIds: item.resourceIds,
                    modelComponents: item.modelComponents,
                  }
                : undefined,
            ),
            diagnostics: coordinated.diagnostics,
            ...(webgl === undefined ? {} : { webgl }),
          }
          mkdirSync(dirname(receiptPath), { recursive: true })
          writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
          console.info(
            `[amphion-product] ${JSON.stringify({ facets: receipt.facets, objectsWithLogicalResources: receipt.objectsWithLogicalResources, modelStates, terrainTextures: receipt.terrainTextures, webgl })}`,
          )
          if (cliffsOnly) {
            expect(receipt.facets.terrain).toBeGreaterThan(0)
            expect(receipt.facets.cliffs).toBeGreaterThan(0)
            return
          }
          expect(receipt.facets.terrain).toBeGreaterThan(0)
          expect(receipt.facets.lighting).toBe(1)
          expect(receipt.objects).toBeGreaterThan(0)
          expect(receipt.objectsWithLogicalResources).toBeGreaterThan(0)
          expect(receipt.modelStates.converted ?? 0, JSON.stringify(modelFailures)).toBeGreaterThan(
            0,
          )
          expect(receipt.terrainTextures).toBeGreaterThan(0)
          if (webgl === undefined && !skipWebGl)
            throw new Error('Amphion WebGL capture requires converted models')
          if (webgl !== undefined) {
            expect(webgl.version).toContain('WebGL 2.0')
            expect(webgl.changedPixels).toBeGreaterThan(25_000)
            expect(webgl.stats.modelTriangles).toBeGreaterThan(0)
          }
        } finally {
          await world.release()
        }
      } finally {
        if (openedPreview !== undefined) await openedPreview.dispose()
        else if (original !== undefined) await original.dispose()
        if (preparation?.state === 'resolved') await preparation.release()
        await contentSources?.dispose()
      }
    }, 780_000)
  },
)
