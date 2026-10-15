import { readFile, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { expect, it } from 'vitest'
import {
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
} from '@modkit/host'
import {
  loadExtensionDirectory,
  openFileArtifactSource,
  createFilesystemInputResolver,
} from '@modkit/host/node'
import type {
  JsonObject,
  ModelMaterialSource,
  ModelSceneSource,
  ModelSkeletonSource,
} from '@modkit/sdk'
import type { SceneRendererMaterial } from '@modkit/sdk/renderer'
import { drainModelProjection } from '@modkit/testkit'
import { readUvmContainer } from '@modkit/uv/model/container'
import { createModelSceneSampler } from '@modkit/scene/model'
import { createRenderMaterialSampler } from '@modkit/scene/materials'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { renderHeadless } from '@modkit/scene/render/headless'
import { encodeRgbaPng } from '@modkit/scene/output/png'
import { exportM3FromUvm } from '../dist/m3/uvm/converter.js'
import { camera } from './uvm-conversion-render.js'

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('missing fixture object')
  return value as JsonObject
}
const budget = {
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxScalarBytes: 268_435_456,
  maxInputBytes: 536_870_912n,
  maxDiagnostics: 100,
}
const containerBudget = {
  ...budget,
  maxInputBytes: Number(budget.maxInputBytes),
  maxJsonBytes: budget.maxScalarBytes,
}
const jsonBudget = { maxDepth: 128, maxNodes: 1_000_000, maxBytes: budget.maxScalarBytes }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Synthetic native variant, never a retail-corpus claim: the existing native writer changes
 * only LAYR UV source selection to world planar before the ordinary M3 codec is opened. */
async function worldFixture() {
  interface Sections {
    getSectionsByTag(tag: string): readonly { content: unknown[] }[]
  }
  const { M3SectionList } = (await import(
    new URL('../dist/m3/native/binary/sections.js', import.meta.url).href
  )) as {
    M3SectionList: { load(bytes: ArrayBuffer, xml: string): Promise<Sections> }
  }
  const { installM3PlatformAdapters } = (await import(
    new URL('../dist/m3/native/platform.js', import.meta.url).href
  )) as {
    installM3PlatformAdapters(value: { DOMParser: typeof DOMParser }): void
  }
  const { serializeM3SectionGraph } = (await import(
    new URL('../dist/m3/native/structural.js', import.meta.url).href
  )) as {
    serializeM3SectionGraph(sections: Sections): Uint8Array
  }
  installM3PlatformAdapters({ DOMParser })
  const bytes = await readFile(
    new URL('./fixtures/m3/corpus/Harbinger.m3', import.meta.url),
  )
  const xml = await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8')
  const sections = await M3SectionList.load(Uint8Array.from(bytes).buffer, xml)
  let layers = 0
  for (const section of sections.getSectionsByTag('LAYR'))
    for (const entry of section.content) {
      Object.assign(object(entry), { uv_source: 17 })
      layers++
    }
  expect(layers).toBeGreaterThan(0)
  return { bytes: serializeM3SectionGraph(sections), layers }
}

async function layerUvSources(bytes: Uint8Array): Promise<number[]> {
  interface Sections {
    getSectionsByTag(tag: string): readonly { content: unknown[] }[]
  }
  const { M3SectionList } = (await import(
    new URL('../dist/m3/native/binary/sections.js', import.meta.url).href
  )) as {
    M3SectionList: { load(bytes: ArrayBuffer, xml: string): Promise<Sections> }
  }
  const xml = await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8')
  const sections = await M3SectionList.load(Uint8Array.from(bytes).buffer, xml)
  return sections
    .getSectionsByTag('LAYR')
    .flatMap(section => section.content.map(entry => Number(object(entry)['uv_source'])))
}

it('preserves native world-projected material placement through M3 import axes and units', async () => {
  const fixture = await worldFixture()
  const scratch = await mkdtemp(join(tmpdir(), 'modkit-m3-world-material-'))
  const path = join(scratch, 'world.m3')
  await writeFile(path, fixture.bytes)
  const backends = createExecutionBackendRegistry([
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
  try {
    const inventory = await buildInventory(
      [
        {
          ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
          execution: { origin: 'bundled', allowTrustedInProcess: true },
        },
      ],
      createHostContributionContractRegistry(),
    )
    const opened = await openSubject({
      inventory,
      source: await openFileArtifactSource(path),
      path,
      intent: 'full',
      target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: { id: 'world-material-read', classes: ['read-source'] },
      budget,
      executionBackends: backends,
      resolveInput: createFilesystemInputResolver({
        primaryPath: path,
        roots: [scratch],
        inventory,
      }),
    })
    if (opened.state !== 'opened')
      throw new Error(`native world fixture did not open: ${JSON.stringify(opened.diagnostics)}`)
    try {
      const output = await opened.session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 2 })
      if (output.state !== 'ok' || output.output.kind !== 'bytes')
        throw new Error('no converted UVM')
      const container = readUvmContainer(output.output.value, containerBudget)
      const freshM3 = await exportM3FromUvm(container, containerBudget)
      expect(Buffer.from(freshM3.subarray(0, 4)).toString()).toBe('43DM')
      const freshUvSources = await layerUvSources(freshM3)
      expect(freshUvSources.filter(value => value === 17).length).toBeGreaterThan(0)
      expect(freshUvSources.every(value => value === 0 || value === 17)).toBe(true)
      const sceneLease = await opened.session.dataSource('common.view/model-scene-source', 1)
      const skeletonLease = await opened.session.dataSource('common.view/model-skeleton-source', 1)
      const materialLease = await opened.session.dataSource('common.view/model-material-source', 1)
      let native
      try {
        native = await drainModelProjection(sceneLease.value as ModelSceneSource, {
          maxBytes: budget.maxScalarBytes,
          skeletonSource: skeletonLease.value as ModelSkeletonSource,
          materialSource: materialLease.value as ModelMaterialSource,
        })
      } finally {
        await materialLease.release()
        await skeletonLease.release()
        await sceneLease.release()
      }
      const before = createModelSceneSampler(
        {
          ...native,
          nodes: native.nodes ?? [],
          meshes: native.meshes ?? [],
          primitives: native.primitives ?? [],
        },
        { maxBytes: budget.maxScalarBytes },
      ).sample(0)
      const model = readUvmModel(container.document, container.binary, budget)
      const after = createModelSceneSampler(
        { ...model.scene, skeleton: model.rig.bindings },
        { maxBytes: budget.maxScalarBytes },
      ).sample(0)
      const materials = (native.materials ?? []).map(material => {
        if (material.shader === undefined) throw new Error('native shader absent')
        return { id: material.id, baseColor: [1, 0, 1, 1] as const, shader: material.shader }
      })
      const converted = (container.document['materials'] as JsonObject[]).map((value, i) => {
        const game = object(object(value['extensions'])['UV_game_material'])
        const params = object(game['params'])
        expect(object(params['renderModel'])['worldToMaterial']).toEqual([
          0.5, 0, 0, 0, 0, 0, 0.5, 0, 0, -0.5, 0, 0, 0, 0, 0, 1,
        ])
        return {
          id: `material-${i}`,
          baseColor: [1, 0, 1, 1] as const,
          shader: { id: String(game['shader']), parameters: params },
        }
      })
      const paths = [
        ...new Set(
          materials.flatMap(
            material =>
              createRenderMaterialSampler(material.shader.parameters, jsonBudget).resources,
          ),
        ),
      ]
      expect(paths.length).toBeGreaterThan(0)
      const rgba = new Uint8Array(8 * 8 * 4)
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) rgba.set([64 + x * 20, 64 + y * 20, 128, 192], (y * 8 + x) * 4)
      const textures = paths.map(id => ({
        id,
        width: 8,
        height: 8,
        rgba,
        filter: 'nearest' as const,
      }))
      const bind = (values: readonly SceneRendererMaterial[]) =>
        values.map(material => ({
          ...material,
          textureBindings: paths.map(id => ({ resourceId: id, textureId: id })),
        }))
      const view = camera(before.primitives)
      // Independent multiplication V * inverse(T), T:(x,y,z)->(2x,2z,-2y).
      const rebasedView = new Float32Array(16)
      for (let row = 0; row < 4; row++) {
        rebasedView[row] = (view[row] ?? 0) * 0.5
        rebasedView[4 + row] = (view[8 + row] ?? 0) * 0.5
        rebasedView[8 + row] = -(view[4 + row] ?? 0) * 0.5
        rebasedView[12 + row] = view[12 + row] ?? 0
      }
      const inverse = Float32Array.of(0.5, 0, 0, 0, 0, 0, 0.5, 0, 0, -0.5, 0, 0, 0, 0, 0, 1)
      const common = {
        outputKind: 'rgba8' as const,
        viewport: { width: 96, height: 96 },
        clearColor: [0.1, 0.2, 0.3, 1] as const,
      }
      const reference = await renderHeadless({
        ...common,
        camera: { viewProjection: view },
        scene: {
          primitives: before.primitives,
          materials: bind(materials),
          textures,
          light: { direction: [0, 0, 1] },
        },
      })
      const render = (values: readonly SceneRendererMaterial[]) =>
        renderHeadless({
          ...common,
          camera: { viewProjection: rebasedView, viewMatrix: inverse },
          scene: {
            primitives: after.primitives,
            materials: bind(values),
            textures,
            light: { direction: [0, 1, 0] },
          },
        })
      const actual = await render(converted)
      expect(actual.diagnostics).toEqual([])
      expect(actual.statistics.fragments).toBeGreaterThan(100)
      expect(actual.rgba).toEqual(reference.rgba)
      const misplaced = await render(
        converted.map(material => {
          const params = material.shader.parameters,
            renderModel = { ...object(params['renderModel']) }
          delete renderModel['worldToMaterial']
          return {
            ...material,
            shader: { ...material.shader, parameters: { ...params, renderModel } },
          }
        }),
      )
      expect(hash(misplaced.rgba)).not.toBe(hash(reference.rgba))
      const evidence = process.env['MODKIT_M3_UVM_WORLD_EVIDENCE_DIR']
      if (evidence !== undefined) {
        await mkdir(evidence, { recursive: true })
        for (const [name, bytes] of [
          ['source.m3', fixture.bytes],
          ['converted.uvm.glb', output.output.value],
          ['frame.png', await encodeRgbaPng(actual)],
          ['without-frame.png', await encodeRgbaPng(misplaced)],
        ] as const)
          await writeFile(join(evidence, name), bytes, { flag: 'wx' })
        await writeFile(
          join(evidence, 'proof.json'),
          JSON.stringify(
            {
              scope:
                'Synthetic Harbinger LAYR world-planar variant and supplied spatial texels; installed M3 conversion, CPU scene parity, not retail DDS/native GPU equivalence',
              layers: fixture.layers,
              resources: paths,
              sourceSha256: hash(fixture.bytes),
              rgbaSha256: hash(actual.rgba),
              referenceSha256: hash(reference.rgba),
              withoutFrameSha256: hash(misplaced.rgba),
              statistics: actual.statistics,
            },
            null,
            2,
          ),
          { flag: 'wx' },
        )
      }
    } finally {
      await opened.session.dispose()
    }
  } finally {
    if (!resolve(scratch).startsWith(resolve(tmpdir()) + sep))
      throw new Error('unexpected temporary directory')
    await rm(scratch, { recursive: true, force: true })
  }
})
