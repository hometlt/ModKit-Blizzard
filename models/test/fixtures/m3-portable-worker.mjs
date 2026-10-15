import { createCodec } from '../../src/m3/codec.js'
import { createCodec as createM3aCodec } from '../../src/m3/codec-m3a.js'
import { createProvider as createWriter, snapshotM3SemanticEdit } from '../../src/m3/writer.js'
import { exportM3FromUvm } from '../../dist/m3/uvm/converter.js'
import { createProvider as createRenderer } from '@modkit/scene/render/headless'
import { encodeRgbaPng } from '@modkit/scene/output/png'
import { readUvmContainer } from '@modkit/uv/model/container'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { createModelSceneSampler } from '@modkit/scene/model'
import { revisionId } from '@modkit/sdk'

const budget = Object.freeze({
  maxInputBytes: 134217728n,
  maxScalarBytes: 134217728,
  maxDepth: 128,
  maxNodes: 1000000,
  maxDiagnostics: 1000,
})
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const containerBudget = {
  ...budget,
  maxInputBytes: Number(budget.maxInputBytes),
  maxJsonBytes: budget.maxScalarBytes,
}
const fixtures = new Map()
let sourceLeases = 0

function required(value) {
  if (value === undefined || value === null) throw new Error('portable fixture value is absent')
  return value
}
function json(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString()
      if (ArrayBuffer.isView(item) && !(item instanceof DataView)) return Array.from(item)
      return item
    }),
  )
}
async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
function isolation() {
  return {
    process: typeof globalThis.process,
    require: typeof globalThis.require,
    Buffer: typeof globalThis.Buffer,
    document: typeof globalThis.document,
    dedicatedWorker: globalThis instanceof DedicatedWorkerGlobalScope,
    secureContext: isSecureContext,
    webCrypto: typeof crypto.subtle.digest,
  }
}

function broker() {
  const report = { requests: [], acquired: 0, released: 0, frames: [] }
  return {
    report,
    port: {
      async resolve(request) {
        request.signal?.throwIfAborted()
        if (
          request.contract !== 'common.render/scene-3d' ||
          request.major !== 1 ||
          request.facet?.rendererId !== 'modkit.headless' ||
          request.facet?.outputKind !== 'rgba8'
        )
          throw new TypeError('unexpected portable fixture capability request')
        report.requests.push(
          json({ contract: request.contract, major: request.major, facet: request.facet }),
        )
        const lease = createRenderer(request)
        report.acquired++
        let live = true
        return {
          value: {
            ...lease.value,
            async render(input) {
              if (!live) throw new Error('renderer lease was released')
              const frame = await lease.value.render(input)
              report.frames.push({
                statistics: frame.statistics,
                rgba: frame.rgba,
                width: frame.width,
                height: frame.height,
              })
              return frame
            },
          },
          async release() {
            if (!live) return
            live = false
            report.released++
            await lease.release()
          },
        }
      },
      async resolveUnknown() {
        throw new TypeError('unknown capability is unavailable in portable fixture')
      },
    },
  }
}

async function opened(bytes, kind = 'm3') {
  const hash = await sha256(bytes)
  const revision = revisionId(`content-hash.sha256:${hash}`)
  const source = { id: `fixture:${kind}:${hash}`, uri: `memory://portable/model.${kind}` }
  const binding = {
    bindingId: 'content',
    role: 'content',
    ownership: 'owned',
    sourceKind: 'candidate',
    source,
    revision,
  }
  const input = {
    originKind: 'single',
    primaryBindingId: 'content',
    bindings: [binding],
    revisions: {
      topology: 'single',
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: `portable:${hash}`,
    },
    bindingsFor: () => [],
    async openBinding(id, signal) {
      signal?.throwIfAborted()
      if (id !== 'content') throw new Error('unknown portable input binding')
      let live = true
      sourceLeases++
      return {
        value: {
          kind: 'bytes',
          ref: source,
          revision,
          size: BigInt(bytes.length),
          async read(offset, length, readSignal) {
            readSignal?.throwIfAborted()
            if (!live) throw new Error('portable source lease was released')
            return bytes.slice(Number(offset), Number(offset) + length)
          },
          async *stream(range, readSignal) {
            readSignal?.throwIfAborted()
            if (!live) throw new Error('portable source lease was released')
            const start = Number(range?.offset ?? 0n)
            yield bytes.slice(
              start,
              range?.length === undefined ? undefined : start + Number(range.length),
            )
          },
        },
        async release() {
          if (live) {
            live = false
            sourceLeases--
          }
        },
      }
    },
  }
  const services = broker()
  const codec = (kind === 'm3a' ? createM3aCodec : createCodec)({
    contracts: services.port,
    budgets: budget,
    diagnostics: { report: () => undefined },
  })
  const session = await codec.open(input, 'full', budget)
  try {
    const descriptor = await session.descriptor()
    return { session, descriptor, services, input, hash, revision, source }
  } catch (error) {
    await session.dispose()
    throw error
  }
}

async function invoke(session, handler, input = {}) {
  const result = await session.operations().invoke(handler, input)
  if (result.state !== 'ok')
    throw new Error(`portable operation ${handler}: ${JSON.stringify(result)}`)
  return result.output
}
async function facet(session, contract, read) {
  const lease = await session.dataSource(contract, 1)
  try {
    return await read(lease.value)
  } finally {
    await lease.release()
  }
}
async function scene(session) {
  return facet(session, 'common.view/model-scene-source', async value => {
    const info = await value.info()
    const nodes = await value.nodes({ limit: 10000 })
    const meshes = await value.meshes({ limit: 10000 })
    if (nodes.nextCursor !== undefined || meshes.nextCursor !== undefined)
      throw new Error('portable scene is truncated')
    const primitives = []
    for (const mesh of meshes.items) {
      for (const id of mesh.primitiveIds)
        primitives.push(
          await required(value.primitive).call(value, id, { maxBytes: budget.maxScalarBytes }),
        )
    }
    return { info, nodes: nodes.items, meshes: meshes.items, primitives }
  })
}
async function page(session, contract, method) {
  return facet(session, contract, async value => {
    const result = await value[method]({ limit: 10000 })
    if (result.nextCursor !== undefined) throw new Error(`portable ${contract} is truncated`)
    return result.items
  })
}

function nativeTreeFact(value) {
  return {
    kind: value.kind,
    label: value.label,
    value: value.value,
    semanticPath: value.semanticPath,
    editable: value.editable,
  }
}

async function nativeTree(session) {
  return facet(session, 'common.view/tree-data-source', async tree => {
    const root = await tree.root()
    const roots = (await tree.children(root, { limit: 10 })).items
    const branches = []
    for (const item of roots) branches.push(nativeTreeFact(await tree.facts(item)))
    const rawRef = roots[2]
    if (rawRef === undefined) throw new Error('M3 native tree has no raw byte branch')
    const row = required((await tree.children(rawRef, { limit: 1 })).items[0])
    return {
      root: nativeTreeFact(await tree.facts(root)),
      branches,
      row: nativeTreeFact(await tree.facts(row)),
    }
  })
}

function model(textured) {
  const track = (a, b) => ({
    lineType: 1,
    globalSeqId: null,
    keys: [
      { frame: 0, vector: a },
      { frame: 1, vector: b },
    ],
  })
  return {
    format: 'gltf',
    meshes: [
      {
        name: 'PortableTriangle',
        materialIndex: 0,
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
        uvs: [0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2],
        boneIndices: Array(12).fill(0),
        boneWeights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      },
    ],
    skeleton: {
      bones: [{ index: 0, name: 'PortableRoot', parentIndex: -1, inverseBindMatrix: identity }],
    },
    materials: [
      {
        name: 'PortableHull',
        layers: textured ? [{ label: 'diffuse', path: 'Assets/PortableHull.dds' }] : [],
        standard: {
          layers: textured
            ? {
                diffuse: {
                  slot: 'diffuse',
                  texturePath: 'Assets/PortableHull.dds',
                  uvSource: 0,
                  channels: 1,
                  op: 0,
                  teamColorMode: 0,
                  invert: false,
                  clampResult: false,
                  wrapX: true,
                  wrapY: true,
                },
              }
            : {},
          blendMode: 0,
          priority: 0,
          specularity: 16,
          specMult: 1,
          emisMult: 1,
          specMode: 0,
          alphaTestThreshold: 0,
          twoSided: true,
          unshaded: true,
          doubleLambert: false,
          clampOutput: false,
          usesVertexColor: false,
          usesVertexAlpha: false,
        },
      },
    ],
    animations: [
      {
        name: 'PortableWalk',
        durationSeconds: 1,
        looping: true,
        nodeTracks: [
          {
            boneIndex: 0,
            translation: track([0, 0, 0], [1, 0, 0]),
            rotation: track([0, 0, 0, 1], [0, 0, 0.7071068, 0.7071068]),
            scale: track([1, 1, 1], [2, 2, 2]),
          },
        ],
      },
    ],
    bounds: null,
    effects: { particles: [], ribbons: [] },
    metadata: { coordinateSystem: 'Y_UP', m3ModelFlags: 0x80d53 },
  }
}
async function author(bytes, textured) {
  const f = await opened(bytes)
  try {
    const output = await invoke(f.session, 'model-write', {
      schemaVersion: 1,
      model: model(textured),
      options: { fileName: 'Portable.m3' },
    })
    if (output.kind !== 'bytes') throw new Error('model.write produced no bytes')
    return output.value
  } finally {
    await f.session.dispose()
  }
}

function materialStandard(container) {
  return required(required(container.document.materials)[0]).extensions.UV_game_material.params
    .renderModel.standard
}
async function convert(session) {
  const output = await invoke(session, 'model-export-uvm', {
    schemaVersion: 1,
    metersPerSourceUnit: 1,
  })
  if (output.kind !== 'bytes') throw new Error('model.export-uvm produced no bytes')
  return { bytes: output.value, container: readUvmContainer(output.value, containerBudget) }
}
function viewFor(container) {
  const projected = readUvmModel(container.document, container.binary, budget)
  const sampled = createModelSceneSampler({
    ...projected.scene,
    skeleton: projected.rig.bindings,
  }).sample(0)
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity]
  for (const primitive of sampled.primitives) {
    const matrix = primitive.transform ?? identity
    for (let i = 0; i < primitive.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value =
          matrix[axis] * primitive.positions[i] +
          matrix[axis + 4] * primitive.positions[i + 1] +
          matrix[axis + 8] * primitive.positions[i + 2] +
          matrix[axis + 12]
        min[axis] = Math.min(min[axis], value)
        max[axis] = Math.max(max[axis], value)
      }
    }
  }
  if (!min.every(Number.isFinite)) throw new Error('portable render requires actual geometry')
  // Authored triangle is XY in UVM. Fit its real converted positions, not a canned empty frame.
  const scale = 1.8 / Math.max(max[0] - min[0], max[1] - min[1], 0.001)
  return [
    scale,
    0,
    0,
    0,
    0,
    scale,
    0,
    0,
    0,
    0,
    0,
    0,
    (-(min[0] + max[0]) * scale) / 2,
    (-(min[1] + max[1]) * scale) / 2,
    0,
    1,
  ]
}

async function execute(request) {
  if (request.action === 'setup') {
    for (const [name, bytes] of Object.entries(request.fixtures))
      fixtures.set(name, Uint8Array.from(bytes))
    fixtures.set('authored', await author(required(fixtures.get('triangle')), true))
    fixtures.set('neutral', await author(required(fixtures.get('triangle')), false))
    return { isolation: isolation(), sourceLeases }
  }
  const kind = request.fixture === 'm3a' ? 'm3a' : 'm3'
  const bytes = required(fixtures.get(request.fixture ?? 'authored'))
  const f = await opened(bytes, kind)
  try {
    if (request.action === 'inspect') {
      const result = {
        descriptor: f.descriptor,
        scene: await scene(f.session),
        nativeTree: await nativeTree(f.session),
      }
      result.skeleton = await page(f.session, 'common.view/model-skeleton-source', 'bindings')
      result.animations = await page(f.session, 'common.view/model-animation-source', 'clips')
      if (kind === 'm3') {
        result.materials = await page(f.session, 'common.view/model-material-source', 'materials')
        result.textures = await page(
          f.session,
          'common.view/model-resource-refs-source',
          'references',
        )
      }
      return result
    }
    if (request.action === 'native-edit') {
      const needle = new TextEncoder().encode(kind === 'm3a' ? 'Stand' : 'PortableHull')
      let found = -1
      outer: for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
        for (let index = 0; index < needle.length; index += 1)
          if (bytes[offset + index] !== needle[index]) continue outer
        found = offset
        break
      }
      if (found < 0) found = bytes.length - 1
      const rowOffset = Math.floor(found / 16) * 16
      const row = bytes.slice(rowOffset, Math.min(bytes.length, rowOffset + 16))
      const changed = row.slice()
      changed[found - rowOffset] ^= 1
      const value = [...changed].map(item => item.toString(16).padStart(2, '0')).join(' ')
      const output = await invoke(f.session, 'edit-m3-native-field', {
        groupId: 'tree',
        key: String(rowOffset),
        path: ['raw', String(rowOffset)],
        value,
      })
      if (output.kind !== 'edit-plan') throw new Error('native M3 edit produced no plan')
      const replacement = required(output.plan.edits[0]).payload.bytes
      const reopened = await opened(replacement, kind)
      try {
        return {
          descriptor: f.descriptor,
          before: row,
          after: replacement.slice(rowOffset, rowOffset + row.length),
          tree: await nativeTree(reopened.session),
        }
      } finally {
        await reopened.session.dispose()
      }
    }
    if (request.action === 'operation')
      return {
        descriptor: f.descriptor,
        result: await invoke(f.session, request.handler),
        source: bytes,
      }
    if (request.action === 'write') {
      const authored = await author(bytes, true)
      const again = await author(bytes, true)
      const reopened = await opened(authored)
      try {
        return { bytes: authored, repeat: again, scene: await scene(reopened.session) }
      } finally {
        await reopened.session.dispose()
      }
    }
    if (request.action === 'convert') {
      const converted = await convert(f.session)
      return {
        descriptor: f.descriptor,
        bytes: converted.bytes,
        document: converted.container.document,
        native: await exportM3FromUvm(converted.container, containerBudget),
        source: bytes,
      }
    }
    if (request.action === 'unsupported-edit') {
      try {
        await invoke(f.session, 'edit-m3-scene', {
          schemaVersion: 1,
          metersPerSourceUnit: 1,
          json: [
            {
              op: 'replace',
              path: '/materials/0/extensions/UV_game_material/params/renderModel/standard/specularity',
              value: 23,
            },
          ],
        })
      } catch (error) {
        return { descriptor: f.descriptor, refusal: { name: error.name, message: error.message } }
      }
      throw new Error('absent M3A material edit unexpectedly succeeded')
    }
    if (request.action === 'edit') {
      const output = await invoke(f.session, 'edit-m3-scene', {
        schemaVersion: 1,
        metersPerSourceUnit: 1,
        json: [
          {
            op: 'replace',
            path: '/materials/0/extensions/UV_game_material/params/renderModel/standard/specularity',
            value: 23,
          },
        ],
      })
      if (output.kind !== 'edit-plan') throw new Error('model.edit produced no plan')
      const replacement = required(output.plan.edits[0]).payload.bytes
      const reopened = await opened(replacement)
      try {
        return {
          descriptor: f.descriptor,
          plan: output.plan,
          before: bytes,
          after: replacement,
          standard: materialStandard((await convert(reopened.session)).container),
          sourceRevision: f.revision,
        }
      } finally {
        await reopened.session.dispose()
      }
    }
    if (request.action === 'render') {
      const converted = await convert(f.session)
      const output = await invoke(f.session, 'render-m3-scene', {
        schemaVersion: 1,
        metersPerSourceUnit: 1,
        viewport: { width: 64, height: 64 },
        camera: { viewProjection: viewFor(converted.container) },
        rendererId: 'modkit.headless',
        clearColor: [0, 0, 0, 0],
      })
      if (output.kind !== 'bytes') throw new Error('model.render produced no PNG')
      const frame = required(f.services.report.frames[0])
      return { result: output, broker: f.services.report, expectedPng: await encodeRgbaPng(frame) }
    }
    if (request.action === 'writer-provider') {
      const target = {
        targetId: 'content',
        subjectUri: f.source.uri,
        ownerSource: f.source,
        semanticPath: [],
        expectedRevision: { sourceRevision: f.revision },
      }
      const change = await snapshotM3SemanticEdit({ sourceBytes: bytes, target, edits: [], budget })
      const lease = createWriter(
        { contract: 'common.edit/writer', major: 1, offerId: 'm3-native-source' },
        {
          budgets: budget,
          providerIdentity: {
            providerId: 'blizzard/m3-preserving-writer',
            providerVersion: '1.0.0',
            artifactDigest: 'test:portable-writer',
          },
        },
      )
      try {
        const validation = await lease.value.validate(change)
        const plan = await lease.value.plan(change)
        const invalid = await lease.value.validate({
          ...change,
          semanticIntent: {
            ...change.semanticIntent,
            sourceContentDigest: `sha256:${'0'.repeat(64)}`,
          },
        })
        return { validation, plan, invalid, source: bytes, sourceRevision: f.revision }
      } finally {
        await lease.release()
      }
    }
    throw new TypeError(`unknown portable fixture action ${request.action}`)
  } finally {
    await f.session.dispose()
    if (sourceLeases !== 0) throw new Error('portable codec leaked a source lease')
  }
}

export async function run(request) {
  const before = new Map(
    await Promise.all([...fixtures].map(async ([name, bytes]) => [name, await sha256(bytes)])),
  )
  const result = await execute(request)
  for (const [name, hash] of before)
    if ((await sha256(required(fixtures.get(name)))) !== hash)
      throw new Error(`portable codec mutated fixture ${name}`)
  return json({ ...result, isolation: isolation(), sourceLeases })
}
