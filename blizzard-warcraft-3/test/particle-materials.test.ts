/** PRE2 material priority, replacement texture and lighting reach the existing common material. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { TRUSTED_IN_PROCESS_EXECUTION_BACKEND, buildInventory, createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry, createHostContributionContractRegistry, createHostServiceResolver,
  registerServiceDefinitionsOrThrow, serviceDefinitionSurfaces } from '@modkit/host'
import { createNodeWorkerBackend, loadExtensionDirectory } from '@modkit/host/node'
import { exportWar3FromUvm } from '../dist/war3-mdx/native-encoder.js'
import { extension, open } from './war3-harness.js'

const { parseWar3Mdx, parseWar3Mdl, generateWar3Mdx } = await import(
  pathToFileURL(join(extension, 'dist/war3-mdx/render-model.js')).href,
) as typeof import('../dist/war3-mdx/render-model.js')
const stock = join(extension, '../../references/ReterasModelStudio/matrixeater/res/stock/particles/FireSmallBurn.mdx')
const containerBudget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }

/** Invoke the codec's public UVM operation, then remove the format-specific root residual. */
async function commonParticleFixture() {
  const bytes = new Uint8Array(await readFile(stock))
  const name = parseWar3Mdx(bytes).ParticleEmitters2[0]!.Name
  const session = await open(bytes)
  try {
    const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1 })
    if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error('model.export-uvm failed')
    const parsed = readUvmContainer(result.output.value as Uint8Array, containerBudget)
    const container = { ...parsed, document: { ...structuredClone(parsed.document) } }
    delete container.document['extras']
    const materials = container.document['materials'] as { name: string; extensions: { UV_game_material: { params: { renderModel: Record<string, unknown> } } } }[]
    const render = materials.find(material => material.name === name)!.extensions.UV_game_material.params.renderModel
    return { container, render }
  } finally { await session.dispose() }
}

describe('Warcraft III ParticleEmitter2 materials', () => {
  it.each(['trusted-node', 'worker-portable'] as const)('exports static PRE2 through the Host %s encoder', async variant => {
    const { container, render } = await commonParticleFixture()
    Object.assign(render['standard'] as object, { priority: -9, unshaded: false })
    Object.assign(render['metadata'] as object, { replaceableId: 2, sortPrimsFarZ: 1 })
    const inventory = await buildInventory([{ ...(await loadExtensionDirectory(extension)),
      execution: { origin: 'bundled', allowTrustedInProcess: variant === 'trusted-node' },
    }], createHostContributionContractRegistry())
    const definitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, definitions)
    const resolver = createHostServiceResolver({
      inventory, definitions,
      target: { environment: variant === 'trusted-node' ? 'node' : 'node-worker', operatingSystem: 'windows', architecture: 'x64' },
      executionBackends: createExecutionBackendRegistry([variant === 'trusted-node' ? TRUSTED_IN_PROCESS_EXECUTION_BACKEND :
        createNodeWorkerBackend({ foreignSurfaces: () => serviceDefinitionSurfaces(definitions) })]),
      grant: { id: 'wc3-pre2-native-encoder', classes: [] },
      budgets: { maxInputBytes: BigInt(containerBudget.maxInputBytes), maxScalarBytes: containerBudget.maxJsonBytes,
        maxDepth: containerBudget.maxDepth, maxNodes: containerBudget.maxNodes, maxDiagnostics: 100 },
    })
    try {
      const lease = await resolver.port.resolve({ contract: 'common.model/native-encoder', major: 1, facet: { formatId: 'war3-mdx' } })
      try {
        for (const encoding of ['mdx', 'mdl'] as const) {
          const result = await lease.value.encode({ uvm: writeUvmContainer(container, containerBudget), options: { encoding } })
          expect(result).toMatchObject({ formatId: 'war3-mdx', extension: encoding })
          const emitter = (encoding === 'mdx' ? parseWar3Mdx(result.bytes) : parseWar3Mdl(new TextDecoder().decode(result.bytes))).ParticleEmitters2[0]!
          expect(emitter.PriorityPlane).toBe(-9)
          expect(emitter.ReplaceableId).toBe(2)
          expect(emitter.Flags & 0x8000).toBe(0)
          expect(emitter.Flags & 0x10000).toBe(0x10000)
        }
        expect(resolver.activationFacts).toContainEqual(expect.objectContaining({ providerId: 'blizzard/war3-mdx-native-encoder',
          runtimeVariant: variant, executionProfile: variant === 'trusted-node' ? 'trusted-in-process' : 'worker-brokered' }))
      } finally { await lease.release() }
    } finally { await resolver.release() }
  })

  it.each([false, true].flatMap(unshaded => [false, true].flatMap(sort => [0, 1, 2].flatMap(replaceableId => [false, true].map(behaviour => ({ unshaded, sort, replaceableId, behaviour }))))))
  ('retains PRE2 priority, Unshaded=$unshaded, SortPrimsFarZ=$sort, ReplaceableId=$replaceableId and behaviour=$behaviour without format residual', async ({ unshaded, sort, replaceableId, behaviour }) => {
    const model = parseWar3Mdx(new Uint8Array(await readFile(stock)))
    const emitter = model.ParticleEmitters2[0]!
    emitter.PriorityPlane = -3
    emitter.ReplaceableId = replaceableId
    emitter.Flags = (emitter.Flags & ~(0x8000 | 0x10000)) | (unshaded ? 0x8000 : 0) | (sort ? 0x10000 : 0)
    emitter.Flags = (emitter.Flags & ~(0x20000 | 0x40000 | 0x80000 | 0x100000)) | (behaviour ? 0x20000 | 0x40000 | 0x80000 | 0x100000 : 0)
    emitter.Squirt = behaviour
    emitter.FrameFlags = behaviour ? 3 : 1
    const session = await open(generateWar3Mdx(model))
    try {
        const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1 })
        if (result.state !== 'ok' || result.output.kind !== 'bytes')
          throw new Error(`model.export-uvm failed: ${JSON.stringify(result)}`)
        const container = readUvmContainer(result.output.value as Uint8Array, containerBudget)
        const { document } = container
        const materials = document['materials'] as { name?: string; extensions?: { UV_game_material?: { params: { renderModel: unknown } } } }[]
        const found = materials.find(material => material.name === emitter.Name)!
        expect(found).toBeDefined()
        const render = found.extensions!.UV_game_material!.params.renderModel as {
          standard: { priority: number; unshaded: boolean; layers: Record<string, { texturePath: string; teamColorMode: number }> }
          metadata: { replaceableId: number }
        }
        expect(render.standard).toMatchObject({ priority: -3, unshaded })
        if (replaceableId === 1) expect(render.standard.layers['diffuse']?.texturePath).toBe('ReplaceableTextures\\TeamColor\\TeamColor00.blp')
        if (replaceableId === 2) expect(render.standard.layers['diffuse']?.texturePath).toBe('ReplaceableTextures\\TeamGlow\\TeamGlow00.blp')
        expect(render.standard.layers['emissive1']?.teamColorMode ?? 0).toBe(replaceableId === 0 ? 0 : 1)
        expect(render.metadata.replaceableId).toBe(replaceableId)
        expect(render.metadata).toMatchObject({ sortPrimsFarZ: sort ? 1 : 0 })
        expect(render.metadata).toMatchObject({ unfogged: behaviour ? 1 : 0 })
        const common = { ...document }
        delete common['extras']
        for (const encoding of ['mdx', 'mdl'] as const) {
          const written = exportWar3FromUvm(writeUvmContainer({ ...container, document: common }, containerBudget), containerBudget, { encoding })
          const back = (encoding === 'mdx' ? parseWar3Mdx(written) : parseWar3Mdl(new TextDecoder().decode(written))).ParticleEmitters2[0]!
          expect(back.PriorityPlane).toBe(-3)
          expect(back.ReplaceableId).toBe(replaceableId)
          expect((back.Flags & 0x8000) !== 0).toBe(unshaded)
          expect((back.Flags & 0x10000) !== 0).toBe(sort)
          expect((back.Flags & 0x20000) !== 0).toBe(behaviour)
          expect((back.Flags & 0x40000) !== 0).toBe(behaviour)
          expect((back.Flags & 0x80000) !== 0).toBe(behaviour)
          expect((back.Flags & 0x100000) !== 0).toBe(behaviour)
          expect(Boolean(back.Squirt)).toBe(behaviour)
          expect(back.FrameFlags).toBe(behaviour ? 3 : 1)
        }
    } finally { await session.dispose() }
  })
  it.each([
    { field: 'priority', value: 0.5, message: /priority.*int32/ },
    { field: 'priority', value: 0x80000000, message: /priority.*int32/ },
    { field: 'replaceableId', value: -1, message: /ReplaceableId.*int32/ },
    { field: 'replaceableId', value: 0x80000000, message: /ReplaceableId.*int32/ },
    { field: 'replaceableId', value: '1', message: /ReplaceableId.*int32/ },
    { field: 'replaceableId', value: null, message: /ReplaceableId.*int32/ },
    { field: 'sortPrimsFarZ', value: true, message: /SortPrimsFarZ.*0 or 1/ },
    { field: 'sortPrimsFarZ', value: 2, message: /SortPrimsFarZ.*0 or 1/ },
    { field: 'sortPrimsFarZ', value: null, message: /SortPrimsFarZ.*0 or 1/ },
    { field: 'unfogged', value: true, message: /Unfogged.*0 or 1/ },
    { field: 'unfogged', value: 2, message: /Unfogged.*0 or 1/ },
    { field: 'unfogged', value: null, message: /Unfogged.*0 or 1/ },
  ])('refuses unrepresentable $field=$value rather than coercing it', async ({ field, value, message }) => {
    const { container, render } = await commonParticleFixture()
    const target = render[field === 'priority' ? 'standard' : 'metadata'] as Record<string, unknown>
    target[field] = value
    expect(() => exportWar3FromUvm(writeUvmContainer(container, containerBudget), containerBudget)).toThrow(message)
  })

  it('does not interpret another game metadata as native WC3 flags', async () => {
    const { container, render } = await commonParticleFixture()
    render['metadata'] = { source: 'another-game', emitter: 'particles', replaceableId: 'invalid WC3 value', sortPrimsFarZ: true, unfogged: true }
    const standard = render['standard'] as Record<string, unknown>
    standard['priority'] = -7
    standard['unshaded'] = true
    const result = exportWar3FromUvm(writeUvmContainer(container, containerBudget), containerBudget)
    const emitter = parseWar3Mdx(result).ParticleEmitters2[0]!
    expect(emitter.PriorityPlane).toBe(-7)
    expect(emitter.ReplaceableId).toBe(0)
    expect(emitter.Flags & 0x10000).toBe(0)
    expect(emitter.Flags & 0x40000).toBe(0)
    expect(emitter.Flags & 0x8000).toBe(0x8000)
  })

  it('refuses multiple standard passes instead of selecting the first', async () => {
    const { container, render } = await commonParticleFixture()
    const standard = render['standard']
    delete render['standard']
    render['composite'] = { priority: 0, passes: [
      { material: standard, alphaFactor: { value: 1 } },
      { material: structuredClone(standard), alphaFactor: { value: 1 } },
    ] }
    expect(() => exportWar3FromUvm(writeUvmContainer(container, containerBudget), containerBudget)).toThrow(/one standard pass/)
  })

  it('refuses a non-surface presentation rather than writing an ordinary sprite', async () => {
    const { container, render } = await commonParticleFixture()
    render['presentation'] = 'screen-distortion'
    expect(() => exportWar3FromUvm(writeUvmContainer(container, containerBudget), containerBudget)).toThrow(/static and surface-presented/)
  })

  it('refuses valid material animation instead of baking its first sample', async () => {
    const { container, render } = await commonParticleFixture()
    const standard = render['standard'] as { layers: Record<string, Record<string, unknown>> }
    standard.layers['diffuse']!['brightness'] = {
      value: 1,
      track: { lineType: 1, globalSeqId: null, keys: [
        { frame: 0, vector: [1] }, { frame: 1, vector: [0.5] },
      ] },
    }
    expect(() => exportWar3FromUvm(writeUvmContainer(container, containerBudget), containerBudget)).toThrow(/static and surface-presented/)
  })
})
