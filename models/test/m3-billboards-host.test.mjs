import { decodeM3Skeleton } from '../src/m3/runtime/skeleton.js'
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildInventory,
  createHostContributionContractRegistry,
  createExecutionBackendRegistry,
  linkedExtensionInputs,
  linkedInProcessBackend,
  openSubject,
  createBundledServiceDefinitionRegistry,
  registerServiceDefinitionsOrThrow,
  createHostServiceResolver,
} from '@modkit/host'
import {
  loadExtensionDirectory,
  openFileArtifactSource,
  createFilesystemInputResolver,
} from '@modkit/host/node'
import { sceneModule } from '@modkit/scene/module'
import { renderUvm } from '@modkit/scene/uvm/render'
import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { readUvmAnimationClips } from '@modkit/uv/model/animation-clips'
import { createM3BillboardFixture } from './fixtures/m3-billboards.fixture.mjs'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { serializeM3SectionGraph } from '../dist/m3/native/structural.js'
import { schemaText } from '../src/m3/runtime/schema.js'
const budget = {
    maxInputBytes: 64000000n,
    maxScalarBytes: 64000000,
    maxNodes: 1000000,
    maxDepth: 128,
    maxDiagnostics: 1000,
  },
  grant = { id: 'effect-shading-host', classes: ['read-source'] },
  target = {
    environment: 'node',
    operatingSystem: 'windows',
    architecture: 'x64',
  }
test.each([0x100010, 0x100040])(
  'actual BONE flags %# project only the pinned billboard1 constraint while retaining unknown bits',
  async flags => {
    const directory = await mkdtemp(join(tmpdir(), 'modkit-m3-billboards-'))
    try {
      const generated = await createM3BillboardFixture(flags),
        nativeSections = await M3SectionList.load(Uint8Array.from(generated).buffer, schemaText()),
        nativeBone = nativeSections.getSectionByReference(nativeSections.model.bones).content[0]
      nativeBone.location.header.id = 0x10203040
      nativeBone.location.header.interpolation = 0
      nativeBone.location.header.flags = 0x11
      nativeBone.rotation.header.id = 0x50607080
      nativeBone.rotation.header.interpolation = 1
      nativeBone.rotation.header.flags = 0x22
      nativeBone.scale.header.id = 0x90a0b0c0
      nativeBone.scale.header.interpolation = 0
      nativeBone.scale.header.flags = 0x33
      nativeBone.batching.header.id = 0xd0e0f001
      nativeBone.batching.header.interpolation = 1
      nativeBone.batching.header.flags = 0x44
      const bytes = serializeM3SectionGraph(nativeSections),
        primaryPath = join(directory, 'Billboards.m3')
      const sourceHeaders = (await M3SectionList.load(Uint8Array.from(bytes).buffer, schemaText()))
        .getSectionByReference(nativeSections.model.bones).content[0]
      assert.deepEqual(
        ['location', 'rotation', 'scale', 'batching'].map(field => sourceHeaders[field].header.interpolation),
        [0, 1, 0, 1],
      )
      const before = bytes.slice(),
        skeleton = await decodeM3Skeleton(bytes, budget)
      assert.equal(skeleton.bindings[0].nativeFlags, flags)
      assert(
        skeleton.bindings[0].flagNames.includes((flags & 0x10) !== 0 ? 'billboard1' : 'billboard2'),
      )
      await writeFile(primaryPath, bytes, { flag: 'wx' })
      const source = await openFileArtifactSource(primaryPath),
        linked = linkedExtensionInputs([sceneModule]),
        backends = createExecutionBackendRegistry([linkedInProcessBackend(linked.modules)]),
        inventory = await buildInventory(
          [
            ...linked.inputs,
            {
              ...(await loadExtensionDirectory(join(import.meta.dirname, '..'))),
              execution: { origin: 'bundled', allowTrustedInProcess: true },
            },
          ],
          createHostContributionContractRegistry(),
        ),
        definitions = createBundledServiceDefinitionRegistry()
      await registerServiceDefinitionsOrThrow(inventory, definitions)
      const opened = await openSubject({
        inventory,
        source,
        path: primaryPath,
        intent: 'full',
        target,
        grant,
        budget,
        executionBackends: backends,
        serviceDefinitions: definitions,
        resolveInput: createFilesystemInputResolver({
          primaryPath,
          roots: [directory],
          inventory,
        }),
      })
      if (opened.state !== 'opened') throw new Error(`M3 collision open refused: ${opened.reason}`)
      try {
        const converted = await opened.session.operations().invoke('model-export-uvm', {
          schemaVersion: 1,
          metersPerSourceUnit: 1,
        })
        assert.equal(converted.state, 'ok')
        assert.equal(converted.output.kind, 'bytes')
        const container = readUvmContainer(converted.output.value),
          nodes = container.document.nodes
        const marked = nodes.flatMap((node, index) =>
          node.extensions?.UV_node_billboard === undefined
            ? []
            : [{ node, index, value: node.extensions.UV_node_billboard }],
        )
        assert.equal(marked.length, (flags & 0x10) !== 0 ? 1 : 0)
        if (marked.length) {
          const s = Math.sin(Math.PI / 4),
            c = Math.cos(Math.PI / 4)
          assert.deepEqual(marked[0].value, {
            schemaVersion: 1,
            mode: 'inverse-camera',
            basisRotations: [
              [0, 0, s, c],
              [0, -s, 0, c],
            ],
          })
          assert(container.document.extensionsUsed.includes('UV_node_billboard'))
          assert(container.document.skins.some(skin => skin.joints.includes(marked[0].index)))
          const sourceFree = await opened.session.operations().invoke('model-export-uvm', {
            schemaVersion: 1,
            metersPerSourceUnit: 1,
          })
          assert.equal(sourceFree.state, 'ok')
          assert.equal(sourceFree.output.kind, 'bytes')
          const portable = readUvmContainer(sourceFree.output.value)
          assert(!portable.document.extensionsUsed.includes('UV_source_blob'))
          const boneHeaders = portable.document.extras.BlizzardM3.residual.animationReferenceIds
            .filter(binding => binding.tag === 'BONE' && binding.recordIndex === 0)
          assert.deepEqual(
            ['location', 'rotation', 'scale', 'batching'].map(field => {
              const binding = boneHeaders.find(value => value.field === field)
              return { id: binding.animId, interpolation: binding.interpolation, flags: binding.flags }
            }),
            [
              { id: 0x10203040, interpolation: 0, flags: 0x11 },
              { id: 0x50607080, interpolation: 1, flags: 0x22 },
              { id: 0x90a0b0c0, interpolation: 0, flags: 0x33 },
              { id: 0xd0e0f001, interpolation: 1, flags: 0x44 },
            ],
          )
          const written = await opened.session.operations().invoke('model-write', {
            schemaVersion: 1,
            uvmBytesHex: Buffer.from(writeUvmContainer(portable)).toString('hex'),
          })
          assert.equal(written.state, 'ok')
          assert.equal(written.output.kind, 'bytes')
          assert.equal((await decodeM3Skeleton(written.output.value, budget)).bindings[0].nativeFlags, flags)
          const restored = await M3SectionList.load(
            Uint8Array.from(written.output.value).buffer,
            schemaText(),
          ), restoredBone = restored.getSectionByReference(restored.model.bones).content[0]
          assert.deepEqual(
            ['location', 'rotation', 'scale', 'batching'].map(field => ({
              id: restoredBone[field].header.id,
              interpolation: restoredBone[field].header.interpolation,
              flags: restoredBone[field].header.flags,
            })),
            [
              { id: 0x10203040, interpolation: 0, flags: 0x11 },
              { id: 0x50607080, interpolation: 1, flags: 0x22 },
              { id: 0x90a0b0c0, interpolation: 0, flags: 0x33 },
              { id: 0xd0e0f001, interpolation: 1, flags: 0x44 },
            ],
          )
        }
        assert.deepEqual(bytes, before)
        assert.equal((await decodeM3Skeleton(bytes, budget)).bindings[0].nativeFlags, flags)
      } finally {
        await opened.session.dispose()
      }
    } finally {
      const cleanup = resolve(directory)
      if (
        dirname(cleanup) !== resolve(tmpdir()) ||
        !basename(cleanup).startsWith('modkit-m3-billboards-')
      )
        throw new Error('unexpected collision fixture cleanup path')
      await rm(cleanup, { recursive: true, force: true })
    }
  },
  30_000,
)
