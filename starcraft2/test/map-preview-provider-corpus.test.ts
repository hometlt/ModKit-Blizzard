import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../../../modkit-core/node_modules/esbuild/lib/main.js'
import { chromium } from '../../../modkit-core/node_modules/playwright-core/index.mjs'
import { describe, expect, it } from 'vitest'
import {
  TRUSTED_IN_PROCESS_EXECUTION_BACKEND,
  artifactNamespaceSourceFromVfsMount,
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  coordinateMapPreviewAssetSession,
  openSubject,
  registerServiceDefinitionsOrThrow,
  resolveGameInstallationDiscovery,
  resolveMapPreviewPreparation,
} from '@modkit/host'
import { loadExtensionDirectory } from '@modkit/host/node'
import type { AssetSession, ResourceBudget } from '@modkit/sdk'
import type { MapPreviewPreparationRequest } from '@modkit/sdk/maps'
import { inspectCandidateWorld } from '@modkit/ui/world'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'

const repoRoot = join(import.meta.dirname, '..', '..')
const coreRoot = join(repoRoot, '..', 'modkit-core')
const evidenceDirectory = join(repoRoot, '..', 'artifacts')
const evidencePath = join(evidenceDirectory, 'sc2-tarcade-casc-textured-webgl.png')
const evidenceReceiptPath = join(evidenceDirectory, 'sc2-tarcade-casc-textured-webgl.json')
const sc2Override = process.env.MODKITX_SC2_ROOT?.trim()
const productMaxSubjectEntries = 4_096
const productMaxSubjectPages = 64
const pinnedMapRoot = 'campaigns/liberty.sc2campaign/base.sc2maps/maps/campaign/tarcade.sc2map'
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((value): value is string => value !== undefined)

const budget: ResourceBudget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  maxNodes: 1_048_576,
  maxScalarBytes: 134_217_728,
  maxDiagnostics: 100,
}

const previewLimits = {
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
} as const

const catalogEnrichment = {
  locales: ['enUS'],
  limits: {
    maxRequirements: 512,
    maxDocumentBytes: 16_777_216,
    maxTextBytes: 268_435_456,
    maxEntities: 100_000,
    maxDepth: 128,
    maxPageSize: 1_000,
  },
} as const

async function renderRetailMapEvidence(
  inspected: Awaited<ReturnType<typeof inspectCandidateWorld>>,
): Promise<void> {
  const executablePath = chromeCandidates.find(candidate => existsSync(candidate))
  if (executablePath === undefined) throw new Error('Chrome or Edge is required for SC2 WebGL2 proof')
  const items = inspected.layers
    .flatMap(layer => layer.page.items)
    .flatMap(item => {
      if (item.facet === 'terrain') {
        return [{
          facet: item.facet,
          x: item.x,
          y: item.y,
          heightBase: item.heightBase,
          heightAdjustment: item.heightAdjustment,
          mask: item.mask,
          ...(item.uvwPosition === undefined ? {} : { uvwPosition: item.uvwPosition }),
        }]
      }
      if (item.facet === 'terrain-materials') {
        return [{
          facet: item.facet,
          x: item.x,
          y: item.y,
          textureIndex: item.textureIndex,
          ...(item.textureName === undefined ? {} : { textureName: item.textureName }),
          ...(item.uvTransform === undefined ? {} : { uvTransform: item.uvTransform }),
        }]
      }
      return []
    })
  const terrainMaterials = inspected.layers.flatMap(layer => layer.layer.materials ?? [])
  const textureEntries = terrainMaterials
    .flatMap(material =>
      material.baseColorResourceId === undefined
        ? []
        : [[material.baseColorResourceId, inspected.terrainTextures.get(material.baseColorResourceId)] as const],
    )
    .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined)
  if (textureEntries.length === 0) {
    throw new Error(
      `SC2 retail map resolved no terrain base texture: ${JSON.stringify({
        availableTextureIds: [...inspected.terrainTextures.keys()],
        materials: terrainMaterials.map(material => ({
          label: material.label,
          resourceId: material.baseColorResourceId,
          logicalId: material.baseColorResource?.logicalId,
        })),
        diagnostics: inspected.terrainTextureDiagnostics,
      })}`,
    )
  }
  const browserTextures = textureEntries.map(([id, texture]) => {
    const width = Math.min(texture.width, 256)
    const height = Math.min(texture.height, 256)
    const rgba = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(texture.height - 1, Math.floor((y * texture.height) / height))
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(texture.width - 1, Math.floor((x * texture.width) / width))
        const sourceOffset = (sourceY * texture.width + sourceX) * 4
        rgba.set(texture.rgba.subarray(sourceOffset, sourceOffset + 4), (y * width + x) * 4)
      }
    }
    return {
      id,
      width,
      height,
      sourceWidth: texture.width,
      sourceHeight: texture.height,
      sourceRgbaDigest: `sha256:${createHash('sha256').update(texture.rgba).digest('hex')}`,
      rgba: Buffer.from(rgba).toString('base64'),
    }
  })
  const payload = JSON.stringify({
    items,
    terrainMaterials,
    textures: browserTextures,
  })
  const bundled = await build({
    stdin: {
      contents: `
        import { createWorldWebGlRenderer } from './packages/scene/src/world/webgl.ts';
        const payload = await fetch('/world.json').then(response => response.json());
        const canvas = document.querySelector('canvas');
        const textures = new Map(payload.textures.map(texture => [texture.id, {
          id: texture.id,
          width: texture.width,
          height: texture.height,
          rgba: Uint8Array.from(atob(texture.rgba), value => value.charCodeAt(0)),
        }]));
        const renderer = createWorldWebGlRenderer(canvas);
        if (renderer === undefined) throw new Error('WebGL2 is unavailable');
        const gl = canvas.getContext('webgl2');
        const stats = renderer.draw({
          items: payload.items,
          terrainMaterials: payload.terrainMaterials,
          terrainTextures: textures,
          shadows: true,
          shadowMapSize: 1024,
        });
        gl.finish();
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let changedPixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset] !== 9 || pixels[offset + 1] !== 14 || pixels[offset + 2] !== 19)
            changedPixels += 1;
        }
        globalThis.sc2RetailMapEvidence = {
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
  const application = bundled.outputFiles[0]?.contents
  if (application === undefined) throw new Error('SC2 retail WebGL browser bundle was not emitted')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#091019}canvas{display:block;width:960px;height:720px}</style></head><body><canvas></canvas><script type="module" src="/app.js"></script></body></html>`
  const server = createServer((request, response) => {
    if (request.url === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(application)
    } else if (request.url === '/world.json') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(payload)
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
      args: ['--no-sandbox', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.waitForFunction(() => 'sc2RetailMapEvidence' in globalThis, undefined, {
      timeout: 120_000,
    })
    const evidence = await page.evaluate(
      () =>
        (globalThis as unknown as {
          sc2RetailMapEvidence: {
            stats: Record<string, number>
            changedPixels: number
            version: string
          }
        }).sc2RetailMapEvidence,
    )
    expect(evidence.version).toContain('WebGL 2.0')
    expect(evidence.stats.terrainTriangles).toBe(256 * 256 * 2)
    expect(evidence.stats.terrainTexturedTriangles).toBeGreaterThan(100_000)
    expect(evidence.changedPixels).toBeGreaterThan(25_000)
    mkdirSync(evidenceDirectory, { recursive: true })
    await page.screenshot({ path: evidencePath })
    writeFileSync(
      evidenceReceiptPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          fixture: pinnedMapRoot,
          backend: evidence.version,
          terrainTextures: browserTextures.map(({ rgba: _rgba, ...texture }) => texture),
          world: evidence.stats,
          changedPixels: evidence.changedPixels,
          load: inspected.loadPerformance,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    if (browser !== undefined) await browser.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe.skipIf(process.platform !== 'win32')(
  'installed StarCraft II CASC map preview preparation',
  () => {
    it('uses auto-discovery and the product 4096-entry root listing without pretending it is complete', async ({
      skip,
    }) => {
      const inputs = await Promise.all([
        ...['starcraft2', 'casc'].map(directory =>
          loadExtensionDirectory(join(repoRoot, directory)),
        ),
        loadExtensionDirectory(join(coreRoot, 'extensions', 'images')),
      ])
      const inventory = await buildInventory(
        inputs.map(input => ({
          ...input,
          execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
        })),
        createHostContributionContractRegistry(),
      )
      const executionBackends = createExecutionBackendRegistry([
        TRUSTED_IN_PROCESS_EXECUTION_BACKEND,
      ])
      const serviceDefinitions = createBundledServiceDefinitionRegistry()
      await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
      const target = {
        environment: 'node' as const,
        operatingSystem: 'windows' as const,
        architecture: 'x64' as const,
      }
      const services = { inventory, target, executionBackends, serviceDefinitions }
      const discoveryResolution = await resolveGameInstallationDiscovery({
        services,
        gameId: 'blizzard/starcraft-2',
        grant: {
          id: 'sc2-map-preview-corpus-discovery',
          classes: ['filesystem-read', 'process-launch'],
        },
        budgets: budget,
      })
      if (discoveryResolution.state !== 'resolved') {
        throw new Error(
          `SC2 discovery service did not resolve: ${discoveryResolution.diagnostics.map(item => item.message).join('; ')}`,
        )
      }

      const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
      let casc: Awaited<ReturnType<typeof openSubject>> | undefined
      let previewResolution: Awaited<ReturnType<typeof resolveMapPreviewPreparation>> | undefined
      let openedPreview: AssetSession | undefined
      try {
        const discovered = await discoveryResolution.discovery.discover({
          gameId: 'blizzard/starcraft-2',
          ...(sc2Override === undefined ? {} : { configuredPaths: [sc2Override] }),
          maxCandidates: 16,
        })
        const normalizedOverride = sc2Override
          ?.replace(/\\/gu, '/')
          .replace(/\/+$/gu, '')
          .toLowerCase()
        const installation =
          normalizedOverride === undefined
            ? discovered.installations[0]
            : discovered.installations.find(
                candidate => candidate.normalizedPath.toLowerCase() === normalizedOverride,
              )
        if (installation === undefined) {
          if (sc2Override !== undefined) {
            throw new Error(
              `MODKITX_SC2_ROOT did not resolve to a valid SC2 installation: ${sc2Override}`,
            )
          }
          skip()
          return
        }
        const buildInfoPath = join(installation.installPath, '.build.info')
        if (!existsSync(buildInfoPath)) {
          throw new Error(`discovered SC2 installation has no .build.info: ${buildInfoPath}`)
        }

        const installationUri = pathToFileURL(installation.installPath).href
        const mount = await vfs.openMount(installationUri)
        casc = await openSubject({
          inventory,
          source: artifactNamespaceSourceFromVfsMount(mount),
          path: 'StarCraft II',
          intent: 'full',
          target,
          grant: { id: 'sc2-map-preview-corpus-casc', classes: ['read-source'] },
          executionBackends,
          budget,
          serviceDefinitions,
        })
        if (casc.state !== 'opened') {
          throw new Error(
            `CASC open failed: ${casc.reason} ${JSON.stringify({ candidates: casc.candidates, diagnostics: casc.diagnostics })}`,
          )
        }
        const cascSession = casc.session
        expect(casc.descriptor).toMatchObject({ identity: { formatId: 'casc' } })

        previewResolution = await resolveMapPreviewPreparation({
          services,
          subjectFormatId: 'casc',
          grant: { id: 'sc2-map-preview-corpus-provider', classes: [] },
          budgets: budget,
        })
        if (previewResolution.state !== 'resolved') {
          throw new Error(
            `SC2 map-preview preparation did not resolve: ${previewResolution.diagnostics.map(item => item.message).join('; ')}`,
          )
        }

        const preparationRequests: MapPreviewPreparationRequest[] = []
        const preparation = Object.freeze({
          ...previewResolution.preparation,
          async prepare(request: MapPreviewPreparationRequest) {
            preparationRequests.push(request)
            return previewResolution?.state === 'resolved'
              ? previewResolution.preparation.prepare(request)
              : Promise.reject(new Error('preparation lease was released early'))
          },
        })
        const coordinate = (selectionId?: string) =>
          coordinateMapPreviewAssetSession({
            services,
            grant: { id: 'sc2-map-preview-corpus-coordinate', classes: ['read-source'] },
            budgets: budget,
            original: cascSession,
            preparation,
            ...(selectionId === undefined ? {} : { selectionId }),
            maxCandidates: 64,
            maxSubjectEntries: productMaxSubjectEntries,
            maxSubjectPages: productMaxSubjectPages,
            maxRoots: 32,
            maxDepth: 16,
            limits: previewLimits,
            catalogEnrichment,
          })

        const selection = await coordinate()
        expect(
          selection.state,
          selection.diagnostics.map(item => `${item.code}: ${item.message}`).join('\n'),
        ).toBe('selection-required')
        if (selection.state !== 'selection-required') {
          throw new Error('installed CASC did not produce explicit map selection')
        }
        expect(preparationRequests).toHaveLength(2)
        const rootFacts = preparationRequests[0].subject.namespace
        expect(rootFacts).toMatchObject({ state: 'truncated' })
        expect(rootFacts.entries).toHaveLength(productMaxSubjectEntries)
        const rootListingPinnedMarkers = new Set(
          rootFacts.entries
            .filter(entry => entry.path.startsWith(`${pinnedMapRoot}/`))
            .map(entry => entry.path.slice(pinnedMapRoot.length + 1).toLowerCase()),
        )
        expect(rootListingPinnedMarkers).toEqual(new Set())
        const markerFacts = preparationRequests[1].subject.namespaceSearches?.[0]
        expect(markerFacts).toMatchObject({
          searchId: 'sc2-map-marker-documents',
          state: expect.stringMatching(/^(?:complete|truncated)$/u),
        })
        if (markerFacts === undefined) throw new Error('coordinator did not return marker facts')
        expect(markerFacts.entries.length).toBeGreaterThan(0)
        expect(markerFacts.entries.length).toBeLessThanOrEqual(productMaxSubjectEntries)
        const pinned = selection.candidates.find(
          candidate => candidate.sourcePath === pinnedMapRoot,
        )
        if (pinned === undefined) {
          throw new Error(
            `bounded installed selection omitted ${pinnedMapRoot}; offered ${selection.candidates.length} candidate(s)`,
          )
        }

        const opened = await coordinate(pinned.candidateId)
        expect(
          opened.state,
          opened.diagnostics.map(item => `${item.code}: ${item.message}`).join('\n'),
        ).toBe('opened')
        if (opened.state !== 'opened') throw new Error('selected installed map did not open')
        openedPreview = opened.session
        expect(opened.snapshot).toMatchObject({
          gameId: 'blizzard/starcraft-2',
          mapId: pinnedMapRoot,
        })
        expect(preparationRequests.length).toBeGreaterThanOrEqual(4)
        expect(
          preparationRequests.some(request => request.selectionId === pinned.candidateId),
        ).toBe(true)

        const world = await opened.session.dataSource('common.view/world-scene-source', 1)
        try {
          const inspected = await inspectCandidateWorld(world.value, {
            maxLayers: 32,
            maxItemsPerLayer: 100_000,
            maxPageItems: 4_096,
          })
          expect(inspected.terrainTextures.size).toBeGreaterThan(0)
          expect(
            inspected.layers.flatMap(layer => layer.layer.materials ?? []).some(
              material => material.baseColorResourceId !== undefined,
            ),
          ).toBe(true)
          await renderRetailMapEvidence(inspected)
        } finally {
          await world.release()
        }

        console.info(
          `[sc2-map-preview] root entries=${rootFacts.entries.length}/${rootFacts.state}; indexed markers=${markerFacts.entries.length}/${markerFacts.state}; candidates=${selection.candidates.length}; selected=${pinned.candidateId}; materials=${String(opened.snapshot.terrainMaterials?.materials?.length ?? 0)}; world=${opened.state}`,
        )
      } finally {
        if (openedPreview !== undefined) await openedPreview.dispose()
        else if (casc?.state === 'opened') await casc.session.dispose()
        await vfs.dispose()
        if (previewResolution?.state === 'resolved') await previewResolution.release()
        await discoveryResolution.release()
      }
    }, 120_000)
  },
)
