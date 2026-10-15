import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
  registerServiceDefinitionsOrThrow,
  type Inventory,
} from '@modkit/host'
import { createFilesystemInputResolver, loadExtensionDirectory, openFileArtifactSource } from '@modkit/host/node'
import type { JsonObject, JsonValue, ResourceBudget } from '@modkit/sdk'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { encodeM3UvmBytes, writeM3UvmRequest } from '../src/m3/uvm/write-operation.js'
import { createProvider as createNativeEncoder } from '../src/m3/native-encoder.js'
import { decodeM3Animations } from '../src/m3/animation.node.js'
import { buildAnimationM3 } from './fixtures/animation.js'
import { findModkitCoreWorkspace } from './workspace-root.js'

const budget: ResourceBudget = {
  maxInputBytes: 268_435_456n,
  maxScalarBytes: 268_435_456,
  maxNodes: 1_000_000,
  maxDepth: 128,
  maxDiagnostics: 1000,
}
const containerBudget = {
  maxInputBytes: Number(budget.maxInputBytes),
  maxJsonBytes: budget.maxScalarBytes,
  maxNodes: budget.maxNodes,
  maxDepth: budget.maxDepth,
}
const backends = createExecutionBackendRegistry([{
  profile: 'trusted-in-process',
  supports: (_target, variant) => variant.executionProfile === 'trusted-in-process',
  async activate(context) {
    return {
      module: (await import(context.entrypoint.href)) as Record<string, unknown>,
      release: async () => undefined,
    }
  },
}])
let inventory: Inventory

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('expected object')
  return value as JsonObject
}

function request(bytes: Uint8Array) {
  return { schemaVersion: 1, uvmBytesHex: Buffer.from(bytes).toString('hex') }
}

function magic(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.subarray(0, 4))
}

async function fixture(format: 'm3' | 'm3a'): Promise<Uint8Array> {
  if (format === 'm3')
    return Uint8Array.from(await readFile(new URL('./fixtures/m3/model.m3', import.meta.url)))
  const base64 = await readFile(
    new URL('./fixtures/m3/cybros-cover.m3a.b64', import.meta.url),
    'utf8',
  )
  return Uint8Array.from(Buffer.from(base64.trim(), 'base64'))
}

async function convert(native: Uint8Array, format: 'm3' | 'm3a'): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), 'm3-uvm-write-'))
  try {
    const path = join(directory, `source.${format}`)
    await writeFile(path, native)
    const opened = await openSubject({
      inventory,
      source: await openFileArtifactSource(path),
      path,
      intent: 'full',
      executionBackends: backends,
      target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: { id: 'm3-uvm-write', classes: ['read-source'] },
      budget,
      resolveInput: createFilesystemInputResolver({ primaryPath: path, roots: [directory], inventory }),
    })
    if (opened.state !== 'opened') throw new Error(`${format} fixture failed to open: ${opened.reason}`)
    try {
      const result = await opened.session.operations().invoke('model-export-uvm', {
        schemaVersion: 1,
        metersPerSourceUnit: 1,
      })
      if (result.state !== 'ok' || result.output.kind !== 'bytes')
        throw new Error(`${format} UVM export returned no bytes`)
      return Uint8Array.from(result.output.value)
    } finally {
      await opened.session.dispose()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function residual(bytes: Uint8Array): JsonObject {
  const document = readUvmContainer(bytes, containerBudget).document
  expect(object(document['extensions'])['UV_source_blob']).toBeUndefined()
  const value = object(object(document['extras'])['BlizzardM3'])
  expect(value['schemaVersion']).toBe(1)
  expect(value['source']).toBeUndefined()
  return value
}

beforeAll(async () => {
  inventory = await buildInventory([{
    ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
    execution: { origin: 'bundled', allowTrustedInProcess: true },
  }], createHostContributionContractRegistry())
})

describe.sequential('source-free UVM native write', () => {
  for (const format of ['m3', 'm3a'] as const) {
    test(`fresh ${format.toUpperCase()} output is deterministic and reopens`, async () => {
      const uvm = await convert(await fixture(format), format)
      expect(residual(uvm)['format']).toBe(format)
      const direct = await encodeM3UvmBytes(uvm, budget, undefined, format)
      const written = await writeM3UvmRequest(request(uvm), budget, undefined, format)
      expect(written.value).toEqual(direct)
      expect(await encodeM3UvmBytes(uvm, budget, undefined, format)).toEqual(direct)
      expect(magic(direct)).toBe('43DM')
      expect(residual(await convert(direct, format))['format']).toBe(format)
    }, 60_000)

    test(`native encoder capability writes ${format.toUpperCase()} from UVM`, async () => {
      const uvm = await convert(await fixture(format), format)
      const expected = await encodeM3UvmBytes(uvm, budget, undefined, format)
      const lease = createNativeEncoder({
        contract: 'common.model/native-encoder',
        major: 1,
        offerId: `${format}-from-uvm`,
        contractSelectionKey: `format=${format}`,
      }, { budgets: budget })
      try {
        const encoded = await lease.value.encode({ uvm })
        expect(encoded).toMatchObject({ formatId: format, extension: format })
        expect(encoded.bytes).toEqual(expected)
      } finally {
        await lease.release()
      }
    }, 60_000)
  }

  test('round-trips SDFG uint32 animation keys through source-free UVM', async () => {
    const source = await buildAnimationM3({
      frameTicks: [100, 160, 220],
      residualFlagValues: [0, 3, 0xffff_ffff],
    })
    const before = await decodeM3Animations(source, budget)
    const uvm = await convert(source, 'm3')
    const encoded = await encodeM3UvmBytes(uvm, budget, undefined, 'm3')
    const after = await decodeM3Animations(encoded, budget)
    expect(before.unsupportedChannels).toBe(0)
    expect(after.unsupportedChannels).toBe(0)
    expect(after.residualAnimationTracks).toEqual(before.residualAnimationTracks)
  }, 90_000)
})

test('opened UVM resolves the installed M3A encoder through the host capability', async () => {
  const coreRoot = findModkitCoreWorkspace(import.meta.dirname)
  const routedInventory = await buildInventory([
    {
      ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
      execution: { origin: 'bundled', allowTrustedInProcess: true },
    },
    {
      ...(await loadExtensionDirectory(join(coreRoot, 'extensions/models'))),
      execution: { origin: 'bundled', allowTrustedInProcess: true },
    },
  ], createHostContributionContractRegistry())
  const definitions = createBundledServiceDefinitionRegistry()
  await registerServiceDefinitionsOrThrow(routedInventory, definitions)
  const uvm = await convert(await fixture('m3a'), 'm3a')
  const directory = await mkdtemp(join(tmpdir(), 'm3-native-encoder-'))
  try {
    const path = join(directory, 'input.uvm.glb')
    await writeFile(path, uvm)
    const opened = await openSubject({
      inventory: routedInventory,
      source: await openFileArtifactSource(path),
      path,
      intent: 'full',
      executionBackends: backends,
      serviceDefinitions: definitions,
      target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: { id: 'm3-native-encoder', classes: ['read-source'] },
      budget,
      resolveInput: createFilesystemInputResolver({ primaryPath: path, roots: [directory], inventory: routedInventory }),
    })
    if (opened.state !== 'opened') throw new Error(`UVM route failed to open: ${opened.reason}`)
    try {
      expect(opened.selected.contributionId).toBe('modkit/model-uvm')
      const operation = (await opened.session.descriptor()).operations
        .find(item => item.id === 'model.export-native')
      expect(operation?.state).toBe('available')
      if (operation?.state !== 'available') throw new Error('model.export-native unavailable')
      const result = await opened.session.operations().invoke(operation.handlerId, {
        schemaVersion: 1,
        formatId: 'm3a',
      })
      if (result.state !== 'ok' || result.output.kind !== 'bytes')
        throw new Error('native encoder returned no bytes')
      expect(result.output.value).toEqual(await encodeM3UvmBytes(uvm, budget, undefined, 'm3a'))
      expect(magic(result.output.value)).toBe('43DM')
    } finally {
      await opened.session.dispose()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 90_000)

test('target selection permits M3A-to-M3 conversion and refuses meshes in M3A', async () => {
  const sceneUvm = await convert(await fixture('m3'), 'm3')
  await expect(encodeM3UvmBytes(sceneUvm, budget, undefined, 'm3a')).rejects.toThrow(
    /animation bundle cannot contain render meshes/u,
  )
  const animationUvm = await convert(await fixture('m3a'), 'm3a')
  const native = await encodeM3UvmBytes(animationUvm, budget, undefined, 'm3')
  expect(magic(native)).toBe('43DM')
  expect(residual(await convert(native, 'm3'))['format']).toBe('m3')
}, 90_000)

test('write validates schema, residual namespace, input shape, budgets, and cancellation', async () => {
  const uvm = await convert(await fixture('m3'), 'm3')
  const container = readUvmContainer(uvm, containerBudget)
  const envelope = object(object(container.document['extras'])['BlizzardM3'])
  for (const replacement of [
    { ...envelope, schemaVersion: 999 },
    { ...envelope, format: 'mdx' },
  ]) {
    const changed = writeUvmContainer({
      ...container,
      document: {
        ...container.document,
        extras: { ...object(container.document['extras']), BlizzardM3: replacement },
      },
    }, containerBudget)
    await expect(writeM3UvmRequest(request(changed), budget)).rejects.toThrow()
  }
  for (const input of [
    null,
    [],
    { schemaVersion: 999, uvmBytesHex: '00' },
    { schemaVersion: 1, uvmBytesHex: '' },
    { schemaVersion: 1, uvmBytesHex: '0' },
    { schemaVersion: 1, uvmBytesHex: 'zz' },
    { schemaVersion: 1, uvmBytesHex: '00', model: {} },
  ] satisfies JsonValue[])
    await expect(writeM3UvmRequest(input, budget)).rejects.toThrow()
  await expect(
    writeM3UvmRequest(request(uvm), { ...budget, maxInputBytes: BigInt(uvm.length - 1) }),
  ).rejects.toThrow(/byte budget/u)
  await expect(writeM3UvmRequest(request(uvm), budget, AbortSignal.abort())).rejects.toThrow(/abort/i)
})
