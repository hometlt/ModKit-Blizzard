import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  revisionId,
  type ModelAnimationSource,
  type ModelCameraSource,
  type ModelLightSource,
  type ModelResourceRefsSource,
  type ModelSceneSource,
  type TreeDataSource,
} from '@modkit/sdk'
import {
  authoredModelBytes,
  budget,
  extension,
  fixturePath,
  inspect,
  open,
} from './war3-harness.js'

describe('ported Warcraft III model codec', () => {
  it('decodes an MDLX container into model facets', async () => {
    const session = await open(new Uint8Array(await readFile(fixturePath)))
    expect(await inspect(session)).toMatchObject({
      format: 'war3-mdx',
      encoding: 'mdx',
      version: 800,
      name: 'FixtureModel',
      geosets: 0,
      materials: 0,
      bones: 0,
      sequences: 0,
      chunks: 2,
    })
    const lease = await session.dataSource('common.view/tree-data-source', 1)
    const tree = lease.value as TreeDataSource
    const children = await tree.children(await tree.root(), { limit: 10 })
    expect(children.items).toHaveLength(2)
    expect(await Promise.all(children.items.map(item => tree.facts(item)))).toMatchObject([
      { kind: 'chunk', label: 'VERS' },
      { kind: 'chunk', label: 'MODL' },
    ])
    await lease.release()
    await session.dispose()
  })

  it('publishes decoded geometry, materials, bones and sequences', async () => {
    const session = await open((await authoredModelBytes()).mdx)
    expect(await inspect(session)).toMatchObject({
      encoding: 'mdx',
      geosets: 1,
      materials: 1,
      bones: 1,
      sequences: 1,
      textures: 1,
      // The authored fixture carries no emitter; emitter decoding is covered by the real-model
      // corpus, which needs an installed Warcraft III and is not available in this repository.
      particleEmitters: 0,
    })
    const sceneLease = await session.dataSource('common.view/model-scene-source', 1)
    const scene = sceneLease.value as ModelSceneSource
    const info = await scene.info()
    expect(info).toMatchObject({ meshes: 1, primitives: 1, geometryAccess: 'decoded' })
    const meshes = await scene.meshes({ limit: 10 })
    const primitive = await scene.primitive(meshes.items[0]!.primitiveIds[0]!, {
      maxBytes: 1_000_000,
    })
    expect(primitive?.positions).toHaveLength(9)
    expect(primitive?.indices).toHaveLength(3)
    expect(primitive?.materialId).toBe('war3-material-0')
    await sceneLease.release()

    const refsLease = await session.dataSource('common.view/model-resource-refs-source', 1)
    const refs = refsLease.value as ModelResourceRefsSource
    const references = await refs.references({ limit: 10 })
    expect(references.items).toMatchObject([
      { id: 'Textures\\Fixture.blp', role: 'texture', provenance: 'reference-only' },
    ])
    await refsLease.release()

    const clipLease = await session.dataSource('common.view/model-animation-source', 1)
    const animation = clipLease.value as ModelAnimationSource
    const clips = await animation.clips({ limit: 10 })
    expect(clips.items[0]).toMatchObject({
      name: 'Stand',
      kind: 'animation',
      provenance: 'direct',
      nativeTimeBounds: { startMilliseconds: 0, endMilliseconds: 1000 },
    })
    await clipLease.release()
    await session.dispose()
  })

  it('publishes the cameras and lights the model declares', async () => {
    const { parseWar3Mdx, generateWar3Mdx } = (await import(
      pathToFileURL(join(extension, 'dist', 'war3-mdx', 'render-model.js')).href
    )) as {
      parseWar3Mdx(bytes: Uint8Array): Record<string, unknown[]>
      generateWar3Mdx(model: unknown): Uint8Array
    }
    const model = parseWar3Mdx((await authoredModelBytes()).mdx)
    model['Cameras']!.push({
      Name: 'Portrait',
      Position: Float32Array.of(100, 0, 80),
      FieldOfView: 0.75,
      NearClip: 16,
      FarClip: 5000,
      TargetPosition: Float32Array.of(0, 0, 60),
    })
    // A light is a node of the hierarchy (flag 0x200), right after the fixture's one bone.
    const light = {
      Name: 'Omni',
      ObjectId: 1,
      Parent: null,
      PivotPoint: Float32Array.of(0, 0, 50),
      Flags: 0x200,
      LightType: 0,
      AttenuationStart: 80,
      AttenuationEnd: 200,
      Color: Float32Array.of(1, 0.5, 0.25),
      Intensity: 2,
      AmbColor: Float32Array.of(1, 1, 1),
      AmbIntensity: 0,
    }
    model['Lights']!.push(light)
    model['Nodes']!.push(light)
    model['PivotPoints']!.push(light.PivotPoint)
    const session = await open(generateWar3Mdx(model))

    const cameraLease = await session.dataSource('common.view/model-camera-source', 1)
    const cameras = await (cameraLease.value as unknown as ModelCameraSource).cameras({ limit: 4 })
    expect(cameras.items).toHaveLength(1)
    expect(cameras.items[0]).toMatchObject({
      id: 'camera-0',
      name: 'Portrait',
      nearClip: 16,
      farClip: 5000,
    })
    expect(cameras.items[0]!.fieldOfViewRadians).toBeCloseTo(0.75, 6)
    expect(cameras.items[0]!.properties).toContainEqual({ key: 'Position[0]', value: 100 })
    await cameraLease.release()

    const lightLease = await session.dataSource('common.view/model-light-source', 1)
    const lights = await (lightLease.value as unknown as ModelLightSource).lights({ limit: 4 })
    expect(lights.items).toMatchObject([
      {
        id: 'light-0',
        kind: 'omnidirectional',
        name: 'Omni',
        nodeId: 'war3-node-1',
        color: [1, 0.5, 0.25],
        intensity: 2,
      },
    ])
    expect(lights.items[0]!.properties).toContainEqual({ key: 'AttenuationEnd', value: 200 })
    await lightLease.release()
    await session.dispose()
  })

  it('reads the same model back from its MDL serialisation', async () => {
    // The vendored writer emits both encodings from one model, so the text path is exercised
    // against real geometry instead of a hand-written declaration stub.
    const session = await open((await authoredModelBytes()).mdl)
    expect(await inspect(session)).toMatchObject({
      format: 'war3-mdx',
      encoding: 'mdl',
      geosets: 1,
      materials: 1,
      bones: 1,
      sequences: 1,
      textures: 1,
    })
    await session.dispose()
  })

  it('exports UVM whose facets match the ones it publishes', async () => {
    const session = await open((await authoredModelBytes()).mdx)
    const result = await session
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
    if (result.state !== 'ok' || result.output.kind !== 'bytes')
      throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
    const bytes = result.output.value as Uint8Array
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('glTF')
    const jsonLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true)
    const document = JSON.parse(
      new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)),
    ) as Record<string, unknown>

    // The projection handed to the materializer is the same facet set the codec publishes, so the
    // UVM document has to agree with the inspection summary rather than merely parse.
    expect((document['meshes'] as unknown[]).length).toBe(1)
    expect((document['materials'] as unknown[]).length).toBe(1)
    expect((document['animations'] as unknown[]).length).toBe(1)
    expect((document['nodes'] as unknown[]).length).toBeGreaterThan(1)
    const extras = document['extras'] as Record<string, Record<string, unknown>>
    expect(extras['BlizzardMDX']).toMatchObject({ format: 'war3-mdx' })
    // No native bytes are smuggled into the residual.
    expect(JSON.stringify(document)).not.toContain('UV_source_blob')
    await session.dispose()
  })

  it('exports at the Warcraft III unit when the request states none, and refuses a bad one', async () => {
    // Owner decision 2026-09-23 (blizzard 7b0227c0): a Warcraft III world unit is 0.35 m unless the
    // caller states otherwise. The migrated suite asserted the refusal that decision replaced.
    const session = await open((await authoredModelBytes()).mdx)
    const operations = session.operations()
    const defaulted = await operations.invoke('model-export-uvm', { schemaVersion: 1 })
    if (defaulted.state !== 'ok' || defaulted.output.kind !== 'bytes')
      throw new Error('model.export-uvm without a unit scale failed')
    const bytes = defaulted.output.value as Uint8Array
    const jsonLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true)
    const document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as {
      extensions: { UV_units: { metersPerSourceUnit: number } }
    }
    expect(document.extensions.UV_units.metersPerSourceUnit).toBe(0.35)
    for (const request of [
      { schemaVersion: 1, metersPerSourceUnit: 0 },
      { schemaVersion: 1, metersPerSourceUnit: -1 },
      { schemaVersion: 2, metersPerSourceUnit: 1 },
      { schemaVersion: 1, metersPerSourceUnit: 1, scale: 2 },
    ]) {
      await expect(
        operations.invoke('model-export-uvm', request),
        JSON.stringify(request),
      ).rejects.toThrow()
    }
    await session.dispose()
  })

  it('writes the model back as MDX and as MDL, verified by reopening', async () => {
    const session = await open((await authoredModelBytes()).mdx)
    const operations = session.operations()
    const mdx = await operations.invoke('model-write', { schemaVersion: 1 })
    if (mdx.state !== 'ok' || mdx.output.kind !== 'bytes') throw new Error('model.write failed')
    const written = mdx.output.value as Uint8Array
    expect(new TextDecoder().decode(written.subarray(0, 4))).toBe('MDLX')

    const mdl = await operations.invoke('model-write', { schemaVersion: 1, encoding: 'mdl' })
    if (mdl.state !== 'ok' || mdl.output.kind !== 'bytes') throw new Error('MDL write failed')
    expect(new TextDecoder().decode((mdl.output.value as Uint8Array).subarray(0, 7))).toMatch(
      /Version/u,
    )

    // The written model is a model: reopening it through the codec yields the same facets.
    const reopened = await open(written)
    expect(await inspect(reopened)).toMatchObject({
      encoding: 'mdx',
      geosets: 1,
      materials: 1,
      bones: 1,
      sequences: 1,
      textures: 1,
    })
    await reopened.dispose()
    await session.dispose()
  })

  it('writes Warcraft III bytes back from UVM through the native encoder', async () => {
    const session = await open((await authoredModelBytes()).mdx)
    const exported = await session
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
    if (exported.state !== 'ok' || exported.output.kind !== 'bytes')
      throw new Error('model.export-uvm failed')
    await session.dispose()

    const { createProvider } = (await import(
      pathToFileURL(join(extension, 'dist', 'war3-mdx', 'encoder-provider.js')).href
    )) as typeof import('../dist/war3-mdx/encoder-provider.js')
    const provider = createProvider(
      {
        contract: 'common.model/native-encoder',
        major: 1,
        offerId: 'war3-mdx-from-uvm',
        contractSelectionKey: 'format=war3-mdx',
      },
      { budgets: budget },
    )
    const encoded = await provider.value.encode({ uvm: exported.output.value as Uint8Array })
    expect(encoded.formatId).toBe('war3-mdx')
    expect(new TextDecoder().decode(encoded.bytes.subarray(0, 4))).toBe('MDLX')
    await provider.release()

    // UVM -> MDX is a model this codec reads back with the same facets it exported.
    const roundTripped = await open(encoded.bytes)
    expect(await inspect(roundTripped)).toMatchObject({
      encoding: 'mdx',
      geosets: 1,
      materials: 1,
      bones: 1,
      sequences: 1,
    })
    await roundTripped.dispose()
  })

  it('converts a UVM document from another game, with no Warcraft III residual', async () => {
    const { exportWar3FromUvm } = (await import(
      pathToFileURL(join(extension, 'dist', 'war3-mdx', 'native-encoder.js')).href
    )) as typeof import('../dist/war3-mdx/native-encoder.js')
    const { materializeUvmCore } = (await import(
      pathToFileURL(
        join(extension, 'node_modules', '@modkit', 'uv', 'dist', 'model', 'materializer.js'),
      ).href
    )) as typeof import('@modkit/uv/model/materializer')

    // A plain UVM document: no BlizzardMDX residual, the shape any other game's exporter produces.
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const foreign = materializeUvmCore(
      {
        info: {
          scenes: 1,
          nodes: 1,
          meshes: 1,
          primitives: 1,
          materials: 1,
          textures: 0,
          animations: 0,
          geometryAccess: 'decoded',
        },
        nodes: [
          {
            id: 'root',
            name: 'Root',
            childIds: [],
            meshIds: ['mesh-0'],
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
        ],
        meshes: [{ id: 'mesh-0', name: 'Mesh', primitiveIds: ['mesh-0-primitive'] }],
        primitives: [
          {
            id: 'mesh-0-primitive',
            topology: 'triangles',
            positions,
            indices: Uint32Array.from([0, 1, 2]),
            materialId: 'material-0',
          },
        ],
        materials: [{ id: 'material-0', name: 'Foreign', alphaMode: 'opaque' }],
      },
      {
        scope: { scopeId: 'model-interchange-v1', version: '1.0.0' },
        profile: 'UVM/core@1.0',
        subjectRevision: revisionId('content-hash.sha256:foreign'),
        options: { assetId: 'memory://foreign', sourceFormat: 'test' },
      },
    )

    const containerBudget = {
      maxInputBytes: Number(budget.maxInputBytes),
      maxJsonBytes: budget.maxScalarBytes,
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
    }
    const converted = exportWar3FromUvm(foreign.bytes, containerBudget)
    expect(new TextDecoder().decode(converted.subarray(0, 4))).toBe('MDLX')

    // The converted model is a Warcraft III model this codec reads back.
    const session = await open(converted)
    expect(await inspect(session)).toMatchObject({
      format: 'war3-mdx',
      encoding: 'mdx',
      geosets: 1,
      materials: 1,
      sequences: 1,
    })
    await session.dispose()
  })

  it('refuses to write a UVM document it cannot read', async () => {
    const { exportWar3FromUvm } = (await import(
      pathToFileURL(join(extension, 'dist', 'war3-mdx', 'native-encoder.js')).href
    )) as typeof import('../dist/war3-mdx/native-encoder.js')
    const containerBudget = {
      maxInputBytes: Number(budget.maxInputBytes),
      maxJsonBytes: budget.maxScalarBytes,
      maxDepth: budget.maxDepth,
      maxNodes: budget.maxNodes,
    }
    const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}')
    const glb = new Uint8Array(20 + json.length)
    const view = new DataView(glb.buffer)
    glb.set(new TextEncoder().encode('glTF'), 0)
    view.setUint32(4, 2, true)
    view.setUint32(8, glb.length, true)
    view.setUint32(12, json.length, true)
    glb.set(new TextEncoder().encode('JSON'), 16)
    glb.set(json, 20)
    expect(() => exportWar3FromUvm(glb, containerBudget)).toThrow()
  })

  it('refuses malformed models by naming the format instead of leaking a parser error', async () => {
    const bytes = new Uint8Array(await readFile(fixturePath))
    const noVersion = bytes.slice(0, 4)
    await expect(open(noVersion)).rejects.toThrow(/VERS/u)

    const outOfBounds = bytes.slice()
    new DataView(outOfBounds.buffer).setUint32(20, 0xffffffff, true)
    await expect(open(outOfBounds)).rejects.toThrow(/out of bounds/u)
    await expect(open(bytes, { ...budget, maxNodes: 1 })).rejects.toThrow(/maxNodes/u)

    // MDLX with a valid VERS but a truncated payload: the parser fails, the codec names the format.
    const truncated = new Uint8Array([
      ...bytes.slice(0, 12),
      ...new Uint8Array([0x20, 0x03, 0, 0]),
      ...new Uint8Array([0x4d, 0x4f, 0x44, 0x4c, 0x04, 0, 0, 0, 0, 0, 0, 0]),
    ])
    await expect(open(truncated)).rejects.toThrow(/MDX model could not be decoded|out of bounds/u)
  })
})
