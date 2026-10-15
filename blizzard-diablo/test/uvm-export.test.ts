import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const extension = join(import.meta.dirname, '..')
const codec = (await import(
  pathToFileURL(join(extension, 'src', 'diablo3-app', 'codec.js')).href
)) as { createCodec: (context: unknown) => unknown }

const budget = {
  maxInputBytes: 10n ** 9n,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxScalarBytes: 64 * 1024 * 1024,
  maxDiagnostics: 200,
}

const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('no service is needed')
    },
    async resolveUnknown() {
      throw new Error('no service is needed')
    },
  },
}

function input(bytes: Uint8Array) {
  const uri = 'memory://model.app'
  const revision = 'content-hash.sha256:model'
  const value = {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision,
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  return {
    originKind: 'single',
    bindings: [
      {
        sourceKind: 'candidate',
        bindingId: 'content',
        role: 'content',
        ownership: 'owned',
        source: value.ref,
        revision,
      },
    ],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single',
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: uri,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value, async release() {} }
    },
  }
}

interface Session {
  operations: () => {
    invoke: (
      id: string,
      payload: unknown,
    ) => Promise<{ state: string; output: { kind: string; value: Uint8Array } }>
  }
  dispose: () => Promise<void>
}

const appBytes = new Uint8Array(
  readFileSync(join(extension, '..', 'test', 'behavior', 'fixtures', 'minimal.diablo3.app')),
)

async function open(bytes = appBytes): Promise<Session> {
  return (
    codec.createCodec(context) as {
      open: (input: unknown, mode: string, budget: unknown) => Promise<Session>
    }
  ).open(input(bytes), 'inspect', budget)
}

/**
 * The minimal appearance with one bone, two hardpoints and one collision capsule appended, laid out
 * as the game writes them (offsets stored 16 bytes short; PR records as Y, X, Z[, W]). The bone's
 * bind pose and the weapon hardpoint are both model-space, 17 units apart along z after scaling.
 */
function withAttachments(): Uint8Array {
  const boneAt = appBytes.length
  const hardpointsAt = boneAt + 312
  const capsuleAt = hardpointsAt + 2 * 96
  const shapesAt = capsuleAt + 104
  const polytopeAt = shapesAt + 2 * 80
  const bytes = new Uint8Array(polytopeAt + 96 + 4 * 12)
  bytes.set(appBytes)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at)
  // a PR record: identity rotation (W at +12), translation stored (y, x, z) at +16
  const pr = (at: number, x: number, z: number) => {
    view.setFloat32(at + 12, 1, true)
    view.setFloat32(at + 20, x, true)
    view.setFloat32(at + 24, z, true)
  }
  view.setUint32(0x24, 1, true)
  view.setUint32(0x28, boneAt - 16, true)
  text(boneAt, 'Bip01')
  view.setInt32(boneAt + 0x40, -1, true)
  pr(boneAt + 0x6c, 1, 2)
  view.setFloat32(boneAt + 0x6c + 28, 1, true)
  pr(boneAt + 0xac, 1, 2)
  view.setFloat32(boneAt + 0xac + 28, 1, true)
  // pose B (PRS3) one unit above pose A, and its inverse PRS4: the skinning bind
  pr(boneAt + 0xcc, 1, 3)
  view.setFloat32(boneAt + 0xcc + 28, 1, true)
  pr(boneAt + 0xec, -1, -3)
  view.setFloat32(boneAt + 0xec + 28, 1, true)
  // two bone collision shapes: a capsule from the origin one unit up, and a tetrahedron cook
  view.setUint32(boneAt + 268, 2, true)
  view.setUint32(boneAt + 272, shapesAt - 16, true)
  view.setInt32(shapesAt + 4, 1, true)
  view.setInt32(shapesAt + 8, 1, true)
  view.setFloat32(shapesAt + 16, 1, true)
  view.setFloat32(shapesAt + 60 + 8, 1, true)
  view.setFloat32(shapesAt + 72, 0.5, true)
  view.setInt32(shapesAt + 80 + 4, 2, true)
  view.setUint32(shapesAt + 80 + 28, polytopeAt - 16, true)
  view.setUint32(shapesAt + 80 + 32, 96, true)
  view.setUint32(polytopeAt + 44, 4, true)
  view.setUint32(polytopeAt + 48, 4, true)
  view.setUint32(polytopeAt + 52, 12, true)
  view.setFloat32(polytopeAt + 56, 0.1, true)
  view.setUint32(polytopeAt + 64, polytopeAt + 96 - 16, true)
  view.setUint32(polytopeAt + 68, 48, true)
  ;[[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((vertex, index) =>
    vertex.forEach((value, axis) => view.setFloat32(polytopeAt + 96 + index * 12 + axis * 4, value, true)),
  )
  view.setUint32(0x100, 2, true)
  view.setUint32(0x104, hardpointsAt - 16, true)
  text(hardpointsAt, 'HP_rightWeapon')
  view.setInt32(hardpointsAt + 0x40, 0, true)
  pr(hardpointsAt + 0x44, 1, 3)
  text(hardpointsAt + 96, 'Default')
  view.setInt32(hardpointsAt + 96 + 0x40, -1, true)
  pr(hardpointsAt + 96 + 0x44, 0, 0)
  view.setUint32(0xe8, 1, true)
  view.setUint32(0xec, capsuleAt - 16, true)
  view.setFloat32(capsuleAt, 0.5, true)
  view.setFloat32(capsuleAt + 4, 1, true)
  text(capsuleAt + 8, 'CS_collision_Pelvis')
  view.setInt32(capsuleAt + 0x48, 0, true)
  pr(capsuleAt + 0x4c, 1, 2)
  return bytes
}

function uvmDocument(bytes: Uint8Array): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  const jsonLength = view.getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Record<
    string,
    unknown
  >
}

describe('Diablo III appearance reaches the shared conversion seam', () => {
  it('exports a UVM document carrying the geometry it decoded', async () => {
    const session = await open()
    const result = await session
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
    expect(result.state).toBe('ok')
    expect(result.output.kind).toBe('bytes')
    const document = uvmDocument(result.output.value)
    expect((document['meshes'] as unknown[]).length).toBe(1)
    expect((document['materials'] as unknown[]).length).toBe(1)
    // The document states its own origin; a consumer never has to guess which game it came from.
    expect(JSON.stringify(document)).toContain('diablo3-app')
    await session.dispose()
  })

  it('publishes hardpoints as socket nodes on their bones and capsules as collision volumes', async () => {
    const session = await open(withAttachments())
    const result = await session
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
    await session.dispose()
    expect(result.state).toBe('ok')
    type Node = {
      name?: string
      children?: number[]
      matrix?: number[]
      translation?: number[]
      extensions?: Record<string, Record<string, unknown>>
    }
    const nodes = uvmDocument(result.output.value)['nodes'] as Node[]
    const named = (name: string) => nodes.findIndex(node => node.name === name)
    const offset = (node: Node) => node.translation ?? node.matrix?.slice(12, 15) ?? [0, 0, 0]
    const weapon = nodes[named('HP_rightWeapon')]!
    expect(weapon.extensions?.['UV_game_socket']).toMatchObject({ role: 'hardpoint', sourceName: 'HP_rightWeapon' })
    // on its bone, 17 units above the bone's bind pose: model-space minus the bone's bind
    expect(nodes[named('Bip01')]!.children).toContain(named('HP_rightWeapon'))
    expect(offset(weapon).map(value => Math.round(value * 1000) / 1000)).toEqual([0, 0, 17])
    expect(nodes[named('Default')]!.extensions?.['UV_game_socket']).toMatchObject({ role: 'attach' })
    const capsules = nodes.flatMap(node => {
      const collision = node.extensions?.['UV_game_collision'] as { shapes?: unknown[] } | undefined
      return collision?.shapes ?? []
    })
    expect(capsules).toEqual([
      expect.objectContaining({ kind: 'capsule', radius: 8.5, height: 17, axis: 'z' }),
      expect.objectContaining({ kind: 'capsule', radius: 8.5, height: 17, axis: 'z' }),
      expect.objectContaining({ kind: 'convex-hull' }),
    ])
  })

  it('skins with the inverse of pose B (PRS4) while hardpoints stay on pose A', async () => {
    const { parseDiablo3Appearance } = (await import(
      pathToFileURL(join(extension, 'dist', 'diablo3-app', 'appearance.js')).href
    )) as { parseDiablo3Appearance: (bytes: Uint8Array, name: string) => any }
    const model = parseDiablo3Appearance(withAttachments(), 'fixture')
    const inverse = Array.from(model.skeleton.bones[0].inverseBindMatrix as Float32Array)
    expect(inverse.slice(12, 15).map(value => Math.round(value * 1000) / 1000 + 0)).toEqual([-17, 0, -51])
    const [capsule, hull] = model.metadata.boneShapes
    expect(capsule).toMatchObject({ boneIndex: 0, kind: 1, lod: 1, density: 1, radius: 8.5 })
    expect(capsule.b.map((value: number) => value + 0)).toEqual([0, 0, 17])
    // stored (y, x, z): the second vertex (1, 0, 0) is -y, the third +x
    expect(hull.points.map((value: number) => value + 0)).toEqual([0, 0, 0, 0, -17, 0, 17, 0, 0, 0, 0, 17])
  })

  it('hands that document to the Warcraft III encoder, which neither codec knows about', async () => {
    const session = await open()
    const result = await session
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
    await session.dispose()
    const encoder = (await import(
      pathToFileURL(
        join(extension, '..', 'blizzard-warcraft-3', 'dist', 'war3-mdx', 'native-encoder.js'),
      ).href
    )) as { exportWar3FromUvm: (bytes: Uint8Array, budget: unknown, options: unknown) => Uint8Array }
    const mdx = encoder.exportWar3FromUvm(
      result.output.value,
      { maxInputBytes: 10 ** 9, maxJsonBytes: 2 * 10 ** 8, maxDepth: 128, maxNodes: 1_000_000 },
      {},
    )
    expect(new TextDecoder('latin1').decode(mdx.subarray(0, 4))).toBe('MDLX')
    expect(mdx.byteLength).toBeGreaterThan(256)
  })
})

describe('Diablo III appearance and the animation link of its actor', () => {
  it('opens with a warning when the linked animation set is broken', async () => {
    const MAGIC = 0xdeadbeef
    // actor v282 whose AnimSet SNO (0x78) is 5; an AnimSet v24 whose tag map claims 1000 entries in 4 bytes
    const actor = new Uint8Array(0x100)
    const actorView = new DataView(actor.buffer)
    actorView.setUint32(0, MAGIC, true)
    actorView.setUint32(4, 282, true)
    actorView.setUint32(0x68, 0x80, true)
    actorView.setUint32(0x6c, 4, true)
    actorView.setInt32(0x78, 5, true)
    const animSet = new Uint8Array(0x60)
    const setView = new DataView(animSet.buffer)
    setView.setUint32(0, MAGIC, true)
    setView.setUint32(4, 24, true)
    setView.setUint32(0x20, 0x30, true)
    setView.setUint32(0x24, 4, true)
    setView.setUint32(0x40, 1000, true)
    const files: Record<string, Uint8Array> = { 'Actor/minimal.acr': actor, 'AnimSet/5.ans': animSet }
    const logicalResources = {
      identity: async () => ({ primaryLogicalId: 'appearance/minimal.app' }),
      readBatch: async (request: { items: { requirement: { logicalId: string } }[] }) => ({
        state: 'complete',
        bytes: 0n,
        items: request.items.map(item => {
          const bytes = files[item.requirement.logicalId]
          return bytes === undefined
            ? { state: 'unresolved', reason: 'not-found', message: 'absent' }
            : { state: 'read', bytes, revision: 'content-hash.sha256:x', provenance: {} }
        }),
      }),
    }
    const session = (await (
      codec.createCodec({ ...context, logicalResources }) as {
        open: (input: unknown, mode: string, budget: unknown) => Promise<Session & { descriptor: () => Promise<{ diagnostics?: { code: string }[] }> }>
      }
    ).open(input(appBytes), 'inspect', budget))
    const descriptor = await session.descriptor()
    expect(descriptor.diagnostics?.map(item => item.code)).toContain('blizzard.diablo3-app/animation-link-invalid')
    const exported = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
    expect(exported.state).toBe('ok')
    await session.dispose()
  })
})

const scene = (await import(
  pathToFileURL(join(extension, 'dist', 'diablo3-app', 'scene.js')).href
)) as typeof import('../dist/diablo3-app/scene.js')

describe('Diablo III material draws the textures its pass samples', () => {
  const pass = (stages: readonly number[]) => ({
    shader: 'edge_alpha_additive_unlit_hw_skin',
    effect: 'Legacy.fx',
    pixelEntry: 'ps_legacy',
    cull: 2,
    depthWrite: false,
    alphaTest: true,
    alphaFunc: 5,
    alphaRef: 0,
    blend: true,
    blendSource: 5,
    blendDestination: 2,
    stages,
  })
  const model = (stages: readonly number[]) =>
    ({
      meshes: [],
      materials: [
        {
          name: 'A_normal_mat',
          layers: [
            { label: 'diffuse', path: 'Textures/1.tex', metadata: { slot: 1 } },
            { label: 'emissive', path: 'Textures/6.tex', metadata: { slot: 6 } },
          ],
          metadata: { renderPass: pass(stages) },
        },
      ],
    }) as unknown as Parameters<typeof scene.diablo3Materials>[0]
  const standardLayers = (stages: readonly number[]) => {
    const [material] = scene.diablo3Materials(model(stages)) as unknown as {
      shader: { parameters: { renderModel: { standard: { layers: Record<string, unknown> } } } }
    }[]
    return Object.keys(material!.shader.parameters.renderModel.standard.layers)
  }

  it('leaves out a glow the pass never samples', () => {
    // x1_ghost_a: its additive Legacy pass (stages 1, 0) lists a glow; binding it turned the ghost white
    expect(standardLayers([1, 0])).toEqual(['diffuse'])
  })

  it('binds the glow when a stage samples type 6', () => {
    expect(standardLayers([1, 6])).toEqual(['diffuse', 'emissive1'])
  })
})
