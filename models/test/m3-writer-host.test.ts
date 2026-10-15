import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createEvidenceRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  createHostServiceResolver,
  createSubjectEditing,
  createSubjectServices,
  registerServiceDefinitionsOrThrow,
  serviceProviderFidelityEvidenceRecord,
} from '@modkit/host'
import {
  createFileEditingBackend,
  createFilesystemInputResolver,
  loadExtensionDirectory,
  openFileArtifactSource,
} from '@modkit/host/node'
import { revisionId, type ArtifactByteSource, type ModelMaterialRef, type ModelMaterialSource, type ModelSceneSource, type PermissionGrant, type Writer } from '@modkit/sdk'
import { drainModelProjection, loadUvTools } from '@modkit/testkit'
import { afterAll, describe, expect, it } from 'vitest'

import { decodeM3Geometry } from '../src/m3/geometry.node.js'
import { snapshotM3SemanticEdit } from '../src/m3/writer.js'
import { findModkitCoreWorkspace } from './workspace-root.js'
import { materialBatchFixture } from './fixtures/material-batches.js'

const extensionRoot = join(import.meta.dirname, '..')
const workspaceRoot = findModkitCoreWorkspace(import.meta.dirname)
const fixturePath = join(
  workspaceRoot,
  'packages',
  'testkit',
  'test',
  'fixtures',
  'models',
  'triangle.m3',
)
const scratch = mkdtempSync(join(tmpdir(), 'x3-m3-writer-host-'))
const sourcePath = join(scratch, 'triangle-editable.m3')
const READ_WRITE: PermissionGrant = {
  id: 'm3-writer-host-read-write',
  classes: ['read-source', 'write-source'],
}
const budget = {
  maxInputBytes: 16_777_216n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 16_777_216,
  maxDiagnostics: 100,
}
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const executionBackends = createExecutionBackendRegistry([
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

const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

let cachedServices: Promise<ReturnType<typeof createSubjectServices>> | undefined
const services = () =>
  (cachedServices ??= (async () => {
    const extension = {
      ...(await loadExtensionDirectory(extensionRoot)),
      execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
    }
    const commonModels = {
      ...(await loadExtensionDirectory(join(workspaceRoot, 'extensions', 'models'))),
      execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
    }
    const inventory = await buildInventory([extension, commonModels], createHostContributionContractRegistry())
    const serviceDefinitions = createBundledServiceDefinitionRegistry()
    await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
    return createSubjectServices({
      inventory,
      target,
      executionBackends,
      serviceDefinitions,
    })
  })())

const jsonTriangle = () => ({
  format: 'gltf',
  meshes: [
    {
      name: 'AuthoredTriangle',
      materialIndex: 0,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
      boneIndices: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      boneWeights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    },
  ],
  skeleton: {
    bones: [
      {
        index: 0,
        name: 'Root',
        parentIndex: -1,
        inverseBindMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
    ],
  },
  materials: [
    {
      name: 'Hull',
      layers: [],
      standard: {
        layers: {},
        blendMode: 0,
        priority: 0,
        specularity: 16,
        specMult: 1,
        emisMult: 1,
        specMode: 0,
        alphaTestThreshold: 0,
        twoSided: false,
        unshaded: false,
        doubleLambert: false,
        clampOutput: false,
        usesVertexColor: false,
        usesVertexAlpha: false,
      },
    },
  ],
  animations: [],
  bounds: null,
  effects: { particles: [], ribbons: [] },
  metadata: { coordinateSystem: 'Y_UP', m3ModelFlags: 0x80d53 },
})

afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('M3 writer through the ordinary host/editor workflow', () => {
  it.each(['model.m3', 'corpus/portrait.m3', 'corpus/Harbinger.m3', 'corpus/analysisterminal.m3', 'corpus/aiur_cliffrocks_00.m3', 'multiple-batches.m3', 'empty-division-batches.m3', 'composite-batches.m3'])(
    'preserves material capabilities from %s through common UVM export and ordinary host reopen', async file => {
      const svc = await services()
      const synthetic = file.endsWith('-batches.m3')
      const path = synthetic ? join(scratch, file) : join(import.meta.dirname, 'fixtures', 'm3', file)
      if (synthetic) writeFileSync(path, await materialBatchFixture({
        emptyFirstDivision: file === 'empty-division-batches.m3',
        ...(file === 'composite-batches.m3' ? { compositeAlphas: [0.25, 0.75] } : {}),
      }))
      const opened = await svc.open({
        source: await openFileArtifactSource(path), path, intent: 'full', grant: READ_WRITE, budget,
        resolveInput: createFilesystemInputResolver({ primaryPath: path, roots: [import.meta.dirname, scratch], inventory: svc.inventory }),
      })
      if (opened.state !== 'opened') throw new Error(`M3 host open failed: ${opened.reason}`)
      try {
        const sceneLease = await opened.session.dataSource('common.view/model-scene-source', 1)
        const materialLease = await opened.session.dataSource('common.view/model-material-source', 1)
        try {
          const projection = await drainModelProjection(sceneLease.value as ModelSceneSource, {
            materialSource: materialLease.value as ModelMaterialSource, maxBytes: budget.maxScalarBytes,
          })
          expect(projection.materials!.length).toBeGreaterThan(0)
          expect(projection.materials!.every(material => material.shader !== undefined)).toBe(true)
          if (synthetic) expect(projection.primitives?.map(primitive => primitive.materialId)).toEqual(['material-1', 'material-0', 'material-1'])
          const module = await import(pathToFileURL(join(workspaceRoot, 'packages/uv/dist/model/provider.js')).href)
          const materializer = await module.createProvider({ offerId: 'uvm-core-materializer-v1' })
          const request = { scope: { scopeId: 'model-interchange-v1', version: '1.0.0' }, profile: 'UVM/core@1.0',
            subjectRevision: opened.descriptor.revision,
            options: { assetId: `fixture/${file}`, sourceFormat: 'm3' } }
          const output = await materializer.value.materialize(projection, request).finally(() => materializer.release())
          const uv = await loadUvTools(workspaceRoot)
          uv.uvmCore.assertUvmCore(output.document)
          const bytes = output.bytes as Uint8Array
          const uri = `memory://m3-material-export/${file}.uvm.glb`
          const source: ArtifactByteSource = {
            kind: 'bytes', ref: { id: uri, uri }, revision: revisionId(`content-hash.${digest(bytes)}`), size: BigInt(bytes.byteLength),
            async read(offset, length) { return bytes.slice(Number(offset), Number(offset) + length) },
            async *stream() { yield bytes },
          }
          const reopened = await svc.open({ source, path: 'exported.uvm.glb', intent: 'full', grant: READ_WRITE, budget })
          if (reopened.state !== 'opened') throw new Error(`UVM host reopen failed: ${reopened.reason}`)
          try {
            expect(reopened.selected.contributionId).toBe('modkit/model-uvm')
            const lease = await reopened.session.dataSource('common.view/model-material-source', 1)
            try {
              const page = await (lease.value as ModelMaterialSource).materials({ limit: 1000 })
              expect(page.nextCursor).toBeUndefined()
              // Contract coverage describes the newly written UVM extensions, separately from material data.
              const data = (material: ModelMaterialRef) => { const { contracts: _contracts, ...rest } = material; return rest }
              expect(JSON.parse(JSON.stringify(page.items.map(data)))).toEqual(JSON.parse(JSON.stringify(projection.materials!.map(data))))
            } finally { await lease.release() }
            const restoredSceneLease = await reopened.session.dataSource('common.view/model-scene-source', 1)
            try {
              const scene = restoredSceneLease.value as ModelSceneSource
              for (const primitive of projection.primitives ?? []) {
                expect((await scene.primitive!(primitive.id, { maxBytes: budget.maxScalarBytes })).materialId).toBe(primitive.materialId)
              }
            } finally { await restoredSceneLease.release() }
          } finally { await reopened.session.dispose() }
        } finally { await materialLease.release(); await sceneLease.release() }
      } finally { await opened.session.dispose() }
    }, 30_000,
  )

  it('exposes authored vertex buffers through the installed model scene contract', async () => {
    const path = join(import.meta.dirname, 'fixtures/m3/model.m3')
    const expected = await decodeM3Geometry(new Uint8Array(readFileSync(path)), budget)
    const svc = await services()
    const opened = await svc.open({
      source: await openFileArtifactSource(path), path, intent: 'full', grant: READ_WRITE, budget,
      resolveInput: createFilesystemInputResolver({ primaryPath: path, roots: [import.meta.dirname], inventory: svc.inventory }),
    })
    if (opened.state !== 'opened') throw new Error(`M3 host open failed: ${opened.reason}`)
    try {
      const lease = await opened.session.dataSource('common.view/model-scene-source', 1)
      try {
        const scene = lease.value as ModelSceneSource
        const meshes = await scene.meshes({ limit: 100 })
        const ids = meshes.items.flatMap(mesh => mesh.primitiveIds)
        expect(ids).toHaveLength(expected.primitives.length)
        for (const id of ids) {
          const primitive = await scene.primitive!(id, { maxBytes: budget.maxScalarBytes })
          const reference = expected.primitives.find(candidate => candidate.id === id)!
          expect(primitive.textureCoordinateSets).toEqual(reference.textureCoordinateSets)
          expect(primitive.tangents).toEqual(reference.tangents)
          expect(primitive.colors).toEqual(reference.colors)
          expect(primitive.boneIndices).toEqual(reference.boneIndices)
          expect(primitive.boneWeights).toEqual(reference.boneWeights)
          if (primitive.boneIndices !== undefined) expect(primitive.hierarchyId).toBe('m3/bone-table')
        }
      } finally { await lease.release() }
    } finally { await opened.session.dispose() }
  })

  it('publishes bounded JSON model authoring through the ordinary codec session', async () => {
    const svc = await services()
    const opened = await svc.open({
      source: await openFileArtifactSource(fixturePath),
      path: fixturePath,
      intent: 'full',
      grant: READ_WRITE,
      budget,
    })
    if (opened.state !== 'opened') throw new Error(`M3 host open failed: ${opened.reason}`)
    try {
      expect(await opened.session.descriptor()).toMatchObject({
        operations: expect.arrayContaining([
          expect.objectContaining({ id: 'model.write', state: 'available' }),
        ]),
      })
      const authored = await opened.session.operations().invoke('model-write', {
        schemaVersion: 1,
        model: jsonTriangle(),
        options: { fileName: 'AuthoredTriangle.m3' },
      })
      expect(authored.state).toBe('ok')
      if (authored.state !== 'ok' || authored.output.kind !== 'bytes') {
        throw new Error('model.write did not produce an M3 byte stream')
      }
      const geometry = await decodeM3Geometry(authored.output.value, budget)
      const primitive = geometry.primitives[0]
      if (primitive === undefined) throw new Error('authored M3 has no primitive')
      expect([...primitive.indices]).toEqual([0, 1, 2])
      expect([...primitive.positions].map(Math.abs)).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 1])

      const overflowing = jsonTriangle()
      const mesh = overflowing.meshes[0]
      if (mesh === undefined) throw new Error('JSON authoring fixture has no mesh')
      mesh.positions[3] = Number.MAX_VALUE
      await expect(
        opened.session.operations().invoke('model-write', {
          schemaVersion: 1,
          model: overflowing,
        }),
      ).rejects.toThrow(/outside the Float32 range/u)
    } finally {
      await opened.session.dispose()
    }
  })

  it('opens, proposes, deterministically plans, atomically commits, reopens and undoes', async () => {
    copyFileSync(fixturePath, sourcePath)
    const source = new Uint8Array(readFileSync(sourcePath))
    expect(digest(source)).toBe(
      'sha256:d34480c1b726c37bfeea9dd75fc71a13ca7e47d6ff15b2d66487c6a4b3369de7',
    )
    const beforeGeometry = await decodeM3Geometry(source, budget)
    const svc = await services()
    const opened = await svc.open({
      source: await openFileArtifactSource(sourcePath),
      path: sourcePath,
      intent: 'full',
      grant: READ_WRITE,
      budget,
    })
    if (opened.state !== 'opened') {
      throw new Error(
        `M3 host open failed: ${opened.reason} ${JSON.stringify({ candidates: opened.candidates, diagnostics: opened.diagnostics })}`,
      )
    }
    expect(opened.selected.contributionId).toBe('blizzard/m3')
    if (svc.serviceDefinitions === undefined) throw new Error('M3 writer definitions are missing')
    const port = createHostServiceResolver({
      inventory: svc.inventory,
      target: svc.target,
      executionBackends: svc.executionBackends,
      definitions: svc.serviceDefinitions,
      grant: READ_WRITE,
      budgets: budget,
    })
    const writerLease = await port.port.resolve({
      contract: 'common.edit/writer',
      major: 1,
      facet: {
        formatId: 'm3',
        representationId: 'source',
        mutationMode: 'mutate',
        minimumRoundTrip: 'semantic',
      },
    })
    const writer = writerLease.value as Writer
    expect(writer.identity.providerId).toBe('blizzard/m3-preserving-writer')
    const evidence = serviceProviderFidelityEvidenceRecord(svc.inventory, {
      writer,
      offerId: 'm3-native-source',
      acceptedOrigins: ['bundled'],
    })
    if (evidence === undefined) throw new Error('M3 writer evidence did not materialize')
    expect(evidence.corpusDigest).toBe(
      'sha256:c26fc84599e4d055bd1c7c81ea67b3f2bd7c5d854757f632152778ac4446cf53',
    )
    const backend = createFileEditingBackend({ roots: [scratch] })
    try {
      const editing = createSubjectEditing({
        opened,
        grant: READ_WRITE,
        backendFor: () => backend,
        evidenceFor: plan => createEvidenceRegistry([evidence]).evidenceFor(plan),
        expectedWriter: writer.identity,
        expectedEvidenceContext: {
          optionsFingerprint: 'options:m3-native-preserving-semantic-edits-v1',
          inputClass: 'm3-m3a-complete-native-section-graphs',
        },
        writer,
      })
      if (editing.session === undefined) throw new Error('M3 writer edit session is unavailable')
      const target = editing.targets[0]
      if (target === undefined) throw new Error('M3 writer target is unavailable')

      const noOp = await snapshotM3SemanticEdit({ sourceBytes: source, target, edits: [], budget })
      const noOpPlan = await writer.plan(noOp)
      expect(noOpPlan.edits[0]).toMatchObject({ operation: 'replace', targetId: target.targetId })
      if (
        noOpPlan.edits[0]?.operation !== 'replace' ||
        noOpPlan.edits[0].payload.kind !== 'inline'
      ) {
        throw new Error('M3 no-op writer returned no inline replacement')
      }
      expect(noOpPlan.edits[0].payload.bytes).toEqual(source)

      const change = await snapshotM3SemanticEdit({
        sourceBytes: source,
        target,
        edits: [{ kind: 'scale-model-v1', factor: 2 }],
        budget,
      })
      expect(await editing.session.propose(change)).toEqual({ valid: true, diagnostics: [] })
      const [plan, duplicate] = await Promise.all([
        editing.session.plan(change),
        editing.session.plan(change),
      ])
      expect(plan.edits).toEqual(duplicate.edits)
      const prepared = await editing.coordinator.prepare(plan, { grant: editing.grantSnapshot })
      expect(prepared.state).toBe('ready')
      if (prepared.state !== 'ready') return
      const committed = await editing.coordinator.commit(prepared.prepared, {
        grant: editing.grantSnapshot,
      })
      expect(committed.state).toBe('committed')
      if (committed.state !== 'committed') return
      expect(committed.receipt).toMatchObject({
        mutationMode: 'mutate',
        commitGuarantee: 'atomic',
        fidelity: {
          evidenceId: 'm3-m3a-preserving-writer-v1',
          corpusDigest: 'sha256:c26fc84599e4d055bd1c7c81ea67b3f2bd7c5d854757f632152778ac4446cf53',
        },
      })

      const reopened = await svc.open({
        source: await openFileArtifactSource(sourcePath),
        path: sourcePath,
        intent: 'full',
        grant: READ_WRITE,
        budget,
      })
      if (reopened.state !== 'opened')
        throw new Error(`saved M3 did not reopen: ${reopened.reason}`)
      try {
        expect(reopened.selected.contributionId).toBe('blizzard/m3')
        const afterGeometry = await decodeM3Geometry(
          new Uint8Array(readFileSync(sourcePath)),
          budget,
        )
        expect(afterGeometry.primitives).toHaveLength(beforeGeometry.primitives.length)
        const beforePrimitive = beforeGeometry.primitives[0]
        const afterPrimitive = afterGeometry.primitives[0]
        if (beforePrimitive === undefined || afterPrimitive === undefined) {
          throw new TypeError('host M3 round trip has no primitive')
        }
        expect([...afterPrimitive.positions].map(value => Math.abs(value))).toEqual(
          [...beforePrimitive.positions].map(value => Math.abs(value * 2)),
        )
      } finally {
        await reopened.session.dispose()
      }

      expect(
        await editing.coordinator.undo(committed.receipt.transactionId, {
          grant: editing.grantSnapshot,
        }),
      ).toMatchObject({ state: 'committed' })
      expect(digest(new Uint8Array(readFileSync(sourcePath)))).toBe(digest(source))
    } finally {
      await opened.session.dispose()
      await backend.dispose()
      await writerLease.release()
      await port.release()
    }
  }, 60_000)
})
