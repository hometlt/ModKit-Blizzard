/** Native static KMTE header preservation/refusal, not a playback/default or native Editor oracle. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ascii, viewAt } from '@modkit/codec-kit/binary'
import type { JsonObject } from '@modkit/sdk'
import { TRUSTED_IN_PROCESS_EXECUTION_BACKEND, buildInventory, createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry, createHostContributionContractRegistry, createHostServiceResolver,
  registerServiceDefinitionsOrThrow, serviceDefinitionSurfaces } from '@modkit/host'
import { createNodeWorkerBackend, loadExtensionDirectory } from '@modkit/host/node'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { attachUvmFormatResidual, readUvmFormatResidual } from '@modkit/uv/model/format-residual'
import { layeredModelBytes } from './war3-layered-model.js'
import { extension, inspect, open } from './war3-harness.js'
const { parseWar3Mdx, parseWar3Mdl, generateWar3Mdx, generateWar3Mdl } = await import(
  pathToFileURL(join(extension, 'dist/war3-mdx/render-model.js')).href,
) as typeof import('../dist/war3-mdx/render-model.js')
const { exportWar3FromUvm } = await import(pathToFileURL(join(extension, 'dist/war3-mdx/native-encoder.js')).href) as typeof import('../dist/war3-mdx/native-encoder.js')
const budget = { maxInputBytes: 16_777_216, maxJsonBytes: 4_194_304, maxDepth: 64, maxNodes: 100_000 }

/** Patch a known fixture header independently of the field the writer under test might ignore. */
async function fixture(version: number, fallback: number) {
  const model = parseWar3Mdx(await layeredModelBytes(0))
  model.Version = version
  model.Geosets = [model.Geosets[0]!]
  model.GeosetAnims = []
  const layer = model.Materials[0]!.Layers[1]!
  model.Materials = [{ ...model.Materials[0]!, Layers: [layer] }]
  Object.assign(layer, { ShaderTypeId: 1, Shading: 0, ORMTextureID: 1, EmissiveTextureID: 2,
    EmissiveGain: { LineType: 1, Keys: [0, 500, 1000].map((Frame, index) => ({ Frame, Vector: Float32Array.of(index === 1 ? 2 : 0) })) } })
  const bytes = generateWar3Mdx(model)
  // Fixed layout of this existing two-sequence synthetic fixture; not a general chunk scanner.
  expect(ascii(bytes.subarray(668, 672))).toBe('MTLS')
  const lays = 676 + 12 + (version < 1100 ? 80 : 0)
  expect(ascii(bytes.subarray(lays, lays + 4))).toBe('LAYS')
  expect(viewAt(bytes, lays + 4, 4, 'fixture layer count').getUint32(0, true)).toBe(1)
  const header = lays + 8 + 28
  expect(viewAt(bytes, header, 4, 'fixture original gain').getFloat32(0, true)).toBe(1)
  viewAt(bytes, header, 4, 'fixture authored gain').setFloat32(0, fallback, true)
  return { bytes, header }
}

/** Read only the independently fixed fixture field after the complete native parser reopened it. */
function gainHeader(bytes: Uint8Array, offset: number) {
  expect(ascii(bytes.subarray(668, 672))).toBe('MTLS')
  return viewAt(bytes, offset, 4, 'written static gain header').getFloat32(0, true)
}

describe('KMTE authored static header', () => {
  it.each(['trusted-node', 'worker-portable'] as const)('preserves zero and refuses lossy MDL through the Host %s encoder', async variant => {
    const { bytes, header } = await fixture(1100, 0)
    const session = await open(bytes)
    try {
      const exported = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (exported.state !== 'ok' || exported.output.kind !== 'bytes') throw new Error(JSON.stringify(exported))
      const inventory = await buildInventory([{ ...(await loadExtensionDirectory(extension)),
        execution: { origin: 'bundled', allowTrustedInProcess: variant === 'trusted-node' },
      }], createHostContributionContractRegistry())
      const definitions = createBundledServiceDefinitionRegistry()
      await registerServiceDefinitionsOrThrow(inventory, definitions)
      const resolver = createHostServiceResolver({ inventory, definitions,
        target: { environment: variant === 'trusted-node' ? 'node' : 'node-worker', operatingSystem: 'windows', architecture: 'x64' },
        executionBackends: createExecutionBackendRegistry([variant === 'trusted-node' ? TRUSTED_IN_PROCESS_EXECUTION_BACKEND :
          createNodeWorkerBackend({ foreignSurfaces: () => serviceDefinitionSurfaces(definitions) })]),
        grant: { id: 'wc3-kmte-fallback', classes: [] },
        budgets: { maxInputBytes: BigInt(budget.maxInputBytes), maxScalarBytes: budget.maxJsonBytes,
          maxDepth: budget.maxDepth, maxNodes: budget.maxNodes, maxDiagnostics: 100 },
      })
      try {
        const lease = await resolver.port.resolve({ contract: 'common.model/native-encoder', major: 1, facet: { formatId: 'war3-mdx' } })
        try {
          const uvm = exported.output.value as Uint8Array
          const written = await lease.value.encode({ uvm, options: { encoding: 'mdx' } })
          expect(gainHeader(written.bytes, header)).toBe(0)
          await expect(lease.value.encode({ uvm, options: { encoding: 'mdl' } }))
            .rejects.toThrow('MDL cannot preserve a non-default static EmissiveGain header')
          expect(resolver.activationFacts).toContainEqual(expect.objectContaining({ providerId: 'blizzard/war3-mdx-native-encoder',
            runtimeVariant: variant, executionProfile: variant === 'trusted-node' ? 'trusted-in-process' : 'worker-brokered' }))
        } finally { await lease.release() }
      } finally { await resolver.release() }
    } finally { await session.dispose() }
  })

  it.each([900, 1000, 1100].flatMap(version => [0, 1, 0.25, 2].map(fallback => ({ version, fallback }))))(
    'preserves header $fallback separately from KMTE in version $version', async ({ version, fallback }) => {
      const { bytes, header } = await fixture(version, fallback)
      const before = bytes.slice()
      const model = parseWar3Mdx(bytes)
      const layer = model.Materials[0]!.Layers[0]!
      expect(layer.EmissiveGainFallback).toBe(fallback)
      expect(typeof layer.EmissiveGain).toBe('object')
      const direct = generateWar3Mdx(model)
      expect(gainHeader(direct, header)).toBe(fallback)
      expect(parseWar3Mdx(direct).Materials[0]!.Layers[0]!.EmissiveGain).toEqual(layer.EmissiveGain)
      const session = await open(bytes)
      try {
        const written = await session.operations().invoke('model-write', { schemaVersion: 1, encoding: 'mdx' })
        if (written.state !== 'ok' || written.output.kind !== 'bytes') throw new Error(JSON.stringify(written))
        expect(gainHeader(written.output.value as Uint8Array, header)).toBe(fallback)
        const uvm = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
        if (uvm.state !== 'ok' || uvm.output.kind !== 'bytes') throw new Error(JSON.stringify(uvm))
        const uvmBytes = uvm.output.value as Uint8Array
        const back = exportWar3FromUvm(uvmBytes, budget)
        expect(gainHeader(back, header)).toBe(fallback)
        expect(parseWar3Mdx(back).Materials[0]!.Layers[0]!.EmissiveGain).toEqual(layer.EmissiveGain)
        if (fallback !== 1) {
          expect(() => generateWar3Mdl(model)).toThrow('MDL cannot preserve a non-default static EmissiveGain header')
          await expect(session.operations().invoke('model-write', { schemaVersion: 1, encoding: 'mdl' }))
            .rejects.toThrow('MDL cannot preserve a non-default static EmissiveGain header')
          expect(() => exportWar3FromUvm(uvmBytes, budget, { encoding: 'mdl' }))
            .toThrow('MDL cannot preserve a non-default static EmissiveGain header')
        } else {
          const mdl = parseWar3Mdl(generateWar3Mdl(model))
          expect(gainHeader(generateWar3Mdx(mdl), header)).toBe(1)
        }
        expect(await inspect(session)).toMatchObject({ encoding: 'mdx', geosets: 1 })
        expect(bytes).toEqual(before)
      } finally { await session.dispose() }
    },
  )

  it.each([null, '0', {}, NaN, Infinity, -Infinity, -0, 0.1, 1e40])('refuses invalid or unrepresentable carrier %j', async fallback => {
    const { bytes } = await fixture(1100, 1)
    const model = parseWar3Mdx(bytes)
    Object.assign(model.Materials[0]!.Layers[0]!, { EmissiveGainFallback: fallback })
    expect(() => generateWar3Mdx(model)).toThrow('EmissiveGainFallback must be a finite exact float32')
    expect(() => generateWar3Mdl(model)).toThrow('EmissiveGainFallback must be a finite exact float32')
  })

  it.each([null, '0', {}, 0.1, 1e40])('refuses a malformed residual fallback %j in the native encoder', async fallback => {
    const { bytes } = await fixture(1100, 1)
    const session = await open(bytes)
    try {
      const result = await session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error(JSON.stringify(result))
      const container = readUvmContainer(result.output.value as Uint8Array, budget)
      const envelope = readUvmFormatResidual(container, 'BlizzardMDX')
      const residual = structuredClone(envelope.residual)
      const materials = residual['materials'] as { Layers: Record<string, unknown>[] }[]
      materials[0]!.Layers[0]!['EmissiveGainFallback'] = fallback
      const extras = { ...(container.document['extras'] as JsonObject) }
      delete extras['BlizzardMDX']
      const document = { ...container.document, extras }
      const malformed = writeUvmContainer(attachUvmFormatResidual({ ...container, document },
        { ...envelope, namespace: 'BlizzardMDX', residual }, budget), budget)
      for (const encoding of ['mdx', 'mdl'] as const)
        expect(() => exportWar3FromUvm(malformed, budget, { encoding }))
          .toThrow('EmissiveGainFallback must be a finite exact float32')
    } finally { await session.dispose() }
  })

  it.each([NaN, Infinity, -Infinity, -0])('keeps unsupported native header %j inspectable but refuses write/UVM normalization', async fallback => {
    const { bytes } = await fixture(1100, fallback)
    const before = bytes.slice()
    const session = await open(bytes)
    try {
      expect(await inspect(session)).toMatchObject({ encoding: 'mdx', geosets: 1 })
      for (const encoding of ['mdx', 'mdl']) await expect(session.operations().invoke('model-write', { schemaVersion: 1, encoding }))
        .rejects.toThrow('EmissiveGainFallback must be a finite exact float32')
      await expect(session.operations().invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 }))
        .rejects.toThrow('EmissiveGainFallback must be a finite exact float32')
      expect(bytes).toEqual(before)
    } finally { await session.dispose() }
  })

  it.each(['before', 'after'])('retains static/track MDL records in existing parser acceptance (%s), without emitting unqualified syntax', async order => {
    const { bytes, header } = await fixture(1100, 1)
    const text = generateWar3Mdl(parseWar3Mdx(bytes))
    const block = /EmissiveGain 3 \{[\s\S]*?\n\t\t\t\}/u.exec(text)?.[0]
    expect(block).toBeDefined()
    const both = text.replace(block!, order === 'before' ? `static EmissiveGain 0,\n\t\t\t${block}` : `${block}\n\t\t\tstatic EmissiveGain 0,`)
    const parsed = parseWar3Mdl(both)
    expect(parsed.Materials[0]!.Layers[0]!.EmissiveGainFallback).toBe(0)
    expect(typeof parsed.Materials[0]!.Layers[0]!.EmissiveGain).toBe('object')
    expect(gainHeader(generateWar3Mdx(parsed), header)).toBe(0)
    expect(() => generateWar3Mdl(parsed)).toThrow('MDL cannot preserve a non-default static EmissiveGain header')
  })

  it('does not turn a static MDL numeric gain into the stricter animated fallback profile', async () => {
    const { bytes } = await fixture(1100, 1)
    const model = parseWar3Mdx(bytes)
    const layer = model.Materials[0]!.Layers[0]!
    layer.EmissiveGain = 0.1
    delete layer.EmissiveGainFallback
    const parsed = parseWar3Mdl(generateWar3Mdl(model))
    expect(typeof parsed.Materials[0]!.Layers[0]!.EmissiveGain).toBe('number')
    expect(parsed.Materials[0]!.Layers[0]!.EmissiveGainFallback).toBeUndefined()
    expect(() => generateWar3Mdx(parsed)).not.toThrow()
  })

  it('retains only the documented compatibility default for legacy tracks without a carrier', async () => {
    const { bytes, header } = await fixture(1100, 0)
    const model = parseWar3Mdx(bytes)
    delete model.Materials[0]!.Layers[0]!.EmissiveGainFallback
    expect(gainHeader(generateWar3Mdx(model), header)).toBe(1)
  })

  it('refuses a fallback carrier on a native version without its header', async () => {
    const { bytes } = await fixture(900, 0)
    const model = parseWar3Mdx(bytes)
    model.Version = 800
    expect(() => generateWar3Mdx(model)).toThrow('EmissiveGainFallback requires native version900')
    expect(() => generateWar3Mdl(model)).toThrow('EmissiveGainFallback requires native version900')
  })
})
