import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import {
  buildInventory,
  createHostContributionContractRegistry,
  createExecutionBackendRegistry,
  openSubject,
  createSubjectEditing,
  createEvidenceRegistry,
  codecFidelityEvidenceRecords,
  exposeSubjectRpc,
  connectSubjectRpc,
  subjectOpenSnapshot,
  linkedExtensionInputs,
  linkedInProcessBackend,
  createBundledServiceDefinitionRegistry,
  registerServiceDefinitionsOrThrow,
  createHostServiceResolver,
  type OpenedSubject,
} from '@modkit/host'
import type { MessagePortLike } from '@modkit/host/execution'
import {
  loadExtensionDirectory,
  createFilesystemInputResolver,
  createFileEditingBackend,
  openFileArtifactSource,
} from '@modkit/host/node'
import type { JsonObject, JsonValue, PermissionGrant } from '@modkit/sdk'
import { readUvmContainer } from '@modkit/uv/model/container'
import { sceneModule } from '@modkit/scene/module'
import { renderUvm } from '@modkit/scene/uvm/render'
import { encodeRgbaPng } from '@modkit/scene/output/png'
import { readUvmModel } from '@modkit/scene/uvm/model'
import { createModelSceneSampler } from '@modkit/scene/model'
import { camera } from './uvm-conversion-render.js'

const scratch = mkdtempSync(join(tmpdir(), 'm3-uvm-host-edit-'))
afterAll(() => {
  if (
    !resolve(scratch).startsWith(resolve(tmpdir()) + sep) ||
    !basename(scratch).startsWith('m3-uvm-host-edit-')
  )
    throw new Error('unexpected test directory')
  rmSync(scratch, { recursive: true, force: true })
})
const source = readFileSync(new URL('./fixtures/m3/corpus/Harbinger.m3', import.meta.url))
const WRITE: PermissionGrant = { id: 'm3-uvm-write', classes: ['read-source', 'write-source'] }
const READ: PermissionGrant = { id: 'm3-uvm-read', classes: ['read-source'] }
const budget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxScalarBytes: 268_435_456,
  maxDiagnostics: 1000,
}
const linked = linkedExtensionInputs([sceneModule])
const backends = createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)])
const inventoryPromise = (async () =>
  buildInventory(
    [
      ...linked.inputs,
      {
        ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
        execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
      },
    ],
    createHostContributionContractRegistry(),
  ))()
const definitionsPromise = inventoryPromise.then(async inventory => {
  const definitions = createBundledServiceDefinitionRegistry()
  await registerServiceDefinitionsOrThrow(inventory, definitions)
  return definitions
})
function renderRequestFor(bytes: Uint8Array) {
  const { document, binary } = readUvmContainer(bytes)
  const { scene, rig } = readUvmModel(document, binary, budget)
  const sample = createModelSceneSampler(
    { ...scene, skeleton: rig.bindings },
    { maxBytes: budget.maxScalarBytes },
  ).sample(0)
  return {
    schemaVersion: 1,
    viewport: { width: 256, height: 256 },
    camera: { viewProjection: Array.from(camera(sample.primitives)) },
    clearColor: [0.025, 0.025, 0.04, 1],
    rendererId: 'modkit.headless',
    collisions: false,
  }
}
let sequence = 0
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('object absent')
  return value as JsonObject
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError('value absent')
  return value
}
async function fixture(grant = WRITE) {
  const directory = join(scratch, String(sequence++))
  mkdirSync(directory)
  const path = join(directory, 'Harbinger.m3')
  writeFileSync(path, source)
  // One named synthetic dependency tests bundle revision checks, not DDS pixel decoding.
  const logicalPath = required(source.toString('latin1').match(/[A-Za-z0-9_./\\-]+\.dds/gu)?.[0])
  const companionPath = resolve(directory, logicalPath)
  if (!companionPath.startsWith(resolve(directory) + sep))
    throw new Error('texture fixture path escaped')
  mkdirSync(dirname(companionPath), { recursive: true })
  writeFileSync(companionPath, 'synthetic texture dependency')
  const inventory = await inventoryPromise
  const reopen = async (permission = grant): Promise<OpenedSubject> => {
    const result = await openSubject({
      inventory,
      source: await openFileArtifactSource(path),
      path,
      intent: 'full',
      target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
      grant: permission,
      executionBackends: backends,
      budget,
      serviceDefinitions: await definitionsPromise,
      resolveInput: createFilesystemInputResolver({
        primaryPath: path,
        roots: [directory],
        inventory,
      }),
    })
    if (result.state !== 'opened') throw new Error(`M3 open failed: ${result.reason}`)
    return result
  }
  const opened = await reopen()
  const descriptor = await opened.session.descriptor()
  expect(descriptor.origin.kind).toBe('bundle')
  if (descriptor.origin.kind !== 'bundle') throw new Error('not a bundle')
  expect(descriptor.origin.bindings).toHaveLength(2)
  const backend = createFileEditingBackend({ roots: [directory] })
  const records = codecFidelityEvidenceRecords(inventory, {
    codecId: 'blizzard/m3',
    formatId: 'm3',
  })
  const registry = createEvidenceRegistry(records)
  const editing = createSubjectEditing({
    opened,
    grant,
    backendFor: () => backend,
    evidenceFor: plan => registry.evidenceFor(plan),
  })
  return { opened, backend, editing, path, companionPath, reopen }
}
async function editRequest(opened: OpenedSubject): Promise<JsonObject> {
  const result = await opened.session
    .operations()
    .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 2 })
  if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error('no UVM export')
  return requestFromUvm(result.output.value)
}
function requestFromUvm(bytes: Uint8Array): JsonObject {
  const container = readUvmContainer(bytes)
  const nodes = container.document['nodes'] as JsonObject[]
  const node = nodes.findIndex(value => object(value['extensions'] ?? {})['UV_game_collision'] !== undefined)
  if (node < 0) throw new TypeError('attachment collision node absent')
  return {
    schemaVersion: 1,
    metersPerSourceUnit: 2,
    json: [
      {
        op: 'replace',
        path: `/nodes/${node}/extensions/UV_game_collision/shapes/0/radius`,
        value: 3,
      },
    ],
  }
}
function rpcPort(port: MessagePort): MessagePortLike {
  return {
    postMessage: (message, transfer) =>
      port.postMessage(message, transfer === undefined ? [] : [...transfer]),
    on: (event, listener) => port.on(event, listener),
    off: (event, listener) => port.off(event, listener),
    start: () => port.start(),
    close: () => port.close(),
  }
}
async function planFor(f: Awaited<ReturnType<typeof fixture>>, request: JsonValue) {
  const result = await f.opened.session.operations().invoke('edit-m3-scene', request)
  if (result.state !== 'ok' || result.output.kind !== 'edit-plan')
    throw new Error(`no edit plan: ${JSON.stringify(result)}`)
  return f.editing.planFromOperation(result.output)
}
it('commits a UVM material parameter through model.edit and host history', async () => {
  const f = await fixture()
  try {
    const plan = await planFor(f, {
      schemaVersion: 1,
      metersPerSourceUnit: 2,
      json: [
        {
          op: 'replace',
          path: '/materials/0/extensions/UV_game_material/params/renderModel/standard/specularity',
          value: 16,
        },
      ],
    })
    expect(plan.edits).toHaveLength(1)
    expect(readFileSync(f.path)).toEqual(source)
    const prepared = await f.editing.coordinator.prepare(plan, { grant: f.editing.grantSnapshot })
    if (prepared.state !== 'ready')
      throw new Error(
        `material edit not ready: ${JSON.stringify(prepared, (_, value) =>
          typeof value === 'bigint' ? String(value) : value,
        )}`,
      )
    const committed = await f.editing.coordinator.commit(prepared.prepared, {
      grant: f.editing.grantSnapshot,
    })
    if (committed.state !== 'committed') throw new Error('material edit not committed')
    const after = readFileSync(f.path)
    expect(after).not.toEqual(source)
    const reopened = await f.reopen()
    try {
      const output = await reopened.session.operations().invoke('model-export-uvm', {
        schemaVersion: 1,
        metersPerSourceUnit: 2,
      })
      if (output.state !== 'ok' || output.output.kind !== 'bytes')
        throw new Error('material reopen failed')
      const materials = readUvmContainer(output.output.value).document['materials'] as JsonObject[]
      const extension = object(object(required(materials[0])['extensions'])['UV_game_material'])
      const standard = object(object(object(extension['params'])['renderModel'])['standard'])
      expect(standard['specularity']).toBe(16)
    } finally {
      await reopened.session.dispose()
    }
    const options = { grant: f.editing.grantSnapshot }
    expect((await f.editing.coordinator.undo(committed.receipt.transactionId, options)).state).toBe(
      'committed',
    )
    expect(readFileSync(f.path)).toEqual(source)
    expect((await f.editing.coordinator.redo(committed.receipt.transactionId, options)).state).toBe(
      'committed',
    )
    expect(readFileSync(f.path)).toEqual(after)
  } finally {
    await f.opened.session.dispose()
    await f.backend.dispose()
  }
})
it('opens M3 as a bundle, edits UVM in memory, commits only M3, reopens and supports host undo/redo', async () => {
  const f = await fixture()
  try {
    const request = await editRequest(f.opened)
    const plan = await planFor(f, request)
    expect(plan.targets).toHaveLength(2)
    expect(plan.edits).toHaveLength(1)
    expect(readFileSync(f.path)).toEqual(source)
    const prepared = await f.editing.coordinator.prepare(plan, { grant: f.editing.grantSnapshot })
    expect(
      prepared.state,
      JSON.stringify(prepared, (_, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    ).toBe('ready')
    if (prepared.state !== 'ready') throw new Error('not ready')
    const committed = await f.editing.coordinator.commit(prepared.prepared, {
      grant: f.editing.grantSnapshot,
    })
    if (committed.state !== 'committed') throw new Error('not committed')
    expect(committed.receipt.commitGuarantee).toBe('atomic')
    const after = readFileSync(f.path)
    expect(after).not.toEqual(source)
    expect(readFileSync(f.companionPath, 'utf8')).toBe('synthetic texture dependency')
    const reopened = await f.reopen()
    try {
      const result = await reopened.session
        .operations()
        .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 2 })
      if (result.state !== 'ok' || result.output.kind !== 'bytes')
        throw new Error('reopen export failed')
      const document = readUvmContainer(result.output.value).document
      const nodes = document['nodes'] as JsonObject[]
      const shape = nodes.flatMap(node => {
        const collision = object(node['extensions'] ?? {})['UV_game_collision']
        return collision === undefined ? [] : (object(collision)['shapes'] as JsonObject[])
      })[0]
      expect(required(shape)['radius']).toBe(3)
    } finally {
      await reopened.session.dispose()
    }
    expect(
      (
        await f.editing.coordinator.undo(committed.receipt.transactionId, {
          grant: f.editing.grantSnapshot,
        })
      ).state,
    ).toBe('committed')
    expect(readFileSync(f.path)).toEqual(source)
    expect(
      (
        await f.editing.coordinator.redo(committed.receipt.transactionId, {
          grant: f.editing.grantSnapshot,
        })
      ).state,
    ).toBe('committed')
    expect(readFileSync(f.path)).toEqual(after)
    const evidence = process.env['MODKIT_M3_UVM_EDIT_EVIDENCE_DIR']
    if (evidence !== undefined) {
      mkdirSync(evidence, { recursive: true })
      writeFileSync(join(evidence, 'Harbinger.edited.m3'), after, { flag: 'wx' })
      writeFileSync(
        join(evidence, 'host-roundtrip.json'),
        JSON.stringify(
          {
            sourceSha256: createHash('sha256').update(source).digest('hex'),
            resultSha256: createHash('sha256').update(after).digest('hex'),
            targetCount: 2,
            writes: 1,
            nativeRadius: 3,
            sourceFreeCanonicalRewrite: true,
            reopened: true,
            undoRedo: true,
            guarantee: committed.receipt.commitGuarantee,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      )
    }
  } finally {
    await f.opened.session.dispose()
    await f.backend.dispose()
  }
})
it('carries M3 scene edits and guarded commit through the ordinary capability RPC', async () => {
  const f = await fixture()
  const channel = new MessageChannel()
  const served = exposeSubjectRpc({
    port: rpcPort(channel.port1),
    session: 'm3-scene-edit-rpc',
    open: async path => {
      if (path !== f.path) throw new TypeError('foreign test path')
      return {
        snapshot: subjectOpenSnapshot({
          result: f.opened,
          sessionId: () => 'm3-opened',
          diagnostics: [],
        }),
        session: f.opened.session,
      }
    },
    editing: id => (id === 'm3-opened' ? f.editing : undefined),
  })
  const client = await connectSubjectRpc({
    port: rpcPort(channel.port2),
    session: 'm3-scene-edit-rpc',
  })
  try {
    const opened = await client.open(f.path)
    if (opened.state !== 'opened') throw new Error('RPC open failed')
    const operations = await opened.session.operations()
    const converted = await operations.invoke('model-export-uvm', {
      schemaVersion: 1,
      metersPerSourceUnit: 2,
    })
    if (converted.state !== 'ok' || converted.output.kind !== 'bytes')
      throw new Error('RPC UVM export failed')
    const renderRequest = renderRequestFor(converted.output.value)
    const rendered = await operations.invoke('render-m3-scene', {
      ...renderRequest,
      metersPerSourceUnit: 2,
    })
    if (rendered.state !== 'ok' || rendered.output.kind !== 'bytes')
      throw new Error('RPC render failed')
    expect([...rendered.output.value.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(rendered.diagnostics.map(item => item.code)).toContain(
      'common.scene/material-texture-unresolved',
    )
    const result = await operations.invoke('edit-m3-scene', requestFromUvm(converted.output.value))
    if (result.state !== 'ok' || result.output.kind !== 'edit-plan')
      throw new Error(`RPC edit failed: ${JSON.stringify(result)}`)
    const arm = await client.edit(opened.snapshot.sessionId)
    try {
      const state = await arm.state()
      expect(state.targets).toHaveLength(2)
      expect(state.writableTargetIds).toEqual([required(result.output.plan.edits[0]).targetId])
      expect(state).not.toHaveProperty('grant')
      const prepared = await arm.prepare(result.output.plan)
      if (prepared.state !== 'ready') throw new Error('RPC prepare failed')
      expect(prepared).not.toHaveProperty('prepared')
      expect((await arm.commit(prepared.preparedId)).state).toBe('committed')
      await expect(arm.commit(prepared.preparedId)).rejects.toThrow('unknown prepared commit')
      expect(readFileSync(f.path)).not.toEqual(source)
      expect(readFileSync(f.companionPath, 'utf8')).toBe('synthetic texture dependency')
    } finally {
      await arm.dispose()
      await opened.session.dispose()
    }
  } finally {
    await client.close('test finished')
    await served.close('test finished')
    channel.port1.close()
    channel.port2.close()
    await f.opened.session.dispose()
    await f.backend.dispose()
  }
})
it.each(['prepare', 'commit'] as const)(
  'refuses stale companion input at %s without writing M3',
  async phase => {
    const f = await fixture()
    try {
      const plan = await planFor(f, await editRequest(f.opened))
      if (phase === 'prepare') {
        writeFileSync(f.companionPath, 'changed texture')
        expect(
          (await f.editing.coordinator.prepare(plan, { grant: f.editing.grantSnapshot })).state,
        ).toBe('conflict')
      } else {
        const prepared = await f.editing.coordinator.prepare(plan, {
          grant: f.editing.grantSnapshot,
        })
        if (prepared.state !== 'ready') throw new Error('not ready')
        writeFileSync(f.companionPath, 'changed texture')
        expect(
          await f.editing.coordinator.commit(prepared.prepared, { grant: f.editing.grantSnapshot }),
        ).toMatchObject({ state: 'not-applied', reason: 'stale-revision' })
      }
      expect(readFileSync(f.path)).toEqual(source)
    } finally {
      await f.opened.session.dispose()
      await f.backend.dispose()
    }
  },
)
it('preserves read-only open and refuses mutating operations without write-source', async () => {
  const f = await fixture(READ)
  try {
    const denied = await f.opened.session
      .operations()
      .invoke('edit-m3-scene', { schemaVersion: 1, metersPerSourceUnit: 2, json: [] })
    expect(denied.state).toBe('rejected')
    expect(JSON.stringify(denied)).toContain('permission')
    expect(readFileSync(f.path)).toEqual(source)
  } finally {
    await f.opened.session.dispose()
    await f.backend.dispose()
  }
})

it('renders the opened M3 through UVM and the standard provider without writing its source', async () => {
  const f = await fixture(READ)
  const services = createHostServiceResolver({
    inventory: await inventoryPromise,
    definitions: await definitionsPromise,
    executionBackends: backends,
    target: { environment: 'node', operatingSystem: 'windows', architecture: 'x64' },
    grant: READ,
    budgets: budget,
  })
  try {
    const converted = await f.opened.session
      .operations()
      .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 2 })
    if (converted.state !== 'ok' || converted.output.kind !== 'bytes')
      throw new Error('no converted UVM')
    const renderRequest = renderRequestFor(converted.output.value)
    const expected = await renderUvm(converted.output.value, renderRequest, {
      contracts: services.port,
      budget,
    })
    expect(expected.statistics.fragments).toBeGreaterThan(0)
    const result = await f.opened.session
      .operations()
      .invoke('render-m3-scene', { ...renderRequest, metersPerSourceUnit: 2 })
    if (result.state !== 'ok' || result.output.kind !== 'bytes') throw new Error('no M3 render')
    expect(result.output.value).toEqual(await encodeRgbaPng(expected))
    expect(result.diagnostics.map(item => item.code)).toContain(
      'common.scene/material-texture-unresolved',
    )
    const overlay = await f.opened.session.operations().invoke('render-m3-scene', {
      ...renderRequest,
      collisions: true,
      metersPerSourceUnit: 2,
    })
    if (overlay.state !== 'ok' || overlay.output.kind !== 'bytes')
      throw new Error('no M3 collision render')
    expect(overlay.output.value).not.toEqual(result.output.value)
    expect(readFileSync(f.path)).toEqual(source)
    expect(readFileSync(f.companionPath, 'utf8')).toBe('synthetic texture dependency')
    const evidence = process.env['MODKIT_M3_UVM_RENDER_EVIDENCE_DIR']
    if (evidence !== undefined) {
      mkdirSync(evidence, { recursive: true })
      writeFileSync(join(evidence, 'Harbinger.operation.png'), result.output.value, { flag: 'wx' })
      writeFileSync(join(evidence, 'Harbinger.collisions.png'), overlay.output.value, {
        flag: 'wx',
      })
      writeFileSync(
        join(evidence, 'Harbinger.operation.json'),
        JSON.stringify(
          {
            request: { ...renderRequest, metersPerSourceUnit: 2 },
            overlayRequest: { ...renderRequest, collisions: true, metersPerSourceUnit: 2 },
            statistics: expected.statistics,
            diagnostics: result.diagnostics,
            rgbaSha256: createHash('sha256').update(expected.rgba).digest('hex'),
            pngSha256: createHash('sha256').update(result.output.value).digest('hex'),
            sourceUnchanged: true,
            uvmRoutePngEqual: true,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      )
    }
  } finally {
    await services.release()
    await f.opened.session.dispose()
    await f.backend.dispose()
  }
})
it('refuses malformed, unsupported and cancelled scene edits before publishing a write plan', async () => {
  const f = await fixture()
  try {
    for (const request of [
      { schemaVersion: 1, json: [] },
      { schemaVersion: 1, metersPerSourceUnit: 2, json: [], source: 'foreign' },
      {
        schemaVersion: 1,
        metersPerSourceUnit: 2,
        json: [{ op: 'add', path: '/extras/unmapped', value: true }],
      },
    ])
      await expect(f.opened.session.operations().invoke('edit-m3-scene', request)).rejects.toThrow()
    await expect(
      f.opened.session
        .operations()
        .invoke(
          'edit-m3-scene',
          { schemaVersion: 1, metersPerSourceUnit: 2, json: [] },
          { signal: AbortSignal.abort() },
        ),
    ).resolves.toMatchObject({ state: 'rejected', reason: 'cancelled' })
    expect(readFileSync(f.path)).toEqual(source)
  } finally {
    await f.opened.session.dispose()
    await f.backend.dispose()
  }
})
