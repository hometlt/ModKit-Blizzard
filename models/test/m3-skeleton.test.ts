import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import {
  artifactNamespaceSourceFromVfsMount,
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  openSubject,
} from '@modkit/host'
import { createNodeInstallationProbes, loadExtensionDirectory } from '@modkit/host/node'
import {
  revisionId,
  type ArtifactByteSource,
  type ModelSkeletonSource,
  type ModelSceneSource,
  type ResourceBudget,
} from '@modkit/sdk'
import { proves } from '@modkit/testkit'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'
import { decodeM3Skeleton } from '../src/m3/skeleton.node.js'
import { loadM3StructuresXml } from '../dist/m3/native/binary/parser.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { installM3PlatformAdapters } from '../dist/m3/native/platform.js'
import { discoverStarcraft2Installations } from '../../starcraft2/modules/game/providers/installation/provider.js'
import { findBlizzardExtensionRoot, findModkitCoreWorkspace } from './workspace-root.js'

installM3PlatformAdapters({ DOMParser })

const repoRoot = findModkitCoreWorkspace(import.meta.dirname)
const extensionRoot = findBlizzardExtensionRoot(import.meta.dirname)

async function installedSc2Root(): Promise<string | undefined> {
  const configured = process.env['MODKITX_SC2_ROOT']?.trim()
  const result = await discoverStarcraft2Installations({
    gameId: 'blizzard/starcraft-2',
    ...(configured === undefined || configured.length === 0
      ? {}
      : { configuredPaths: [configured] }),
    maxCandidates: 128,
  }, createNodeInstallationProbes())
  return result.installations[0]?.normalizedPath
}
const MODEL_PATH =
  'campaigns/liberty.sc2campaign/base.sc2assets/assets/campaign/terran/artifact1/artifact1.m3'
const MODEL_BYTES = 60_128
const MODEL_SHA256 = 'fb7680019ca7ec88aeb37591a7477c2555dd674d57f0c7486736ccb11919a436'
const MODEL_BONES = 12
const MODEL_ROOTS = 12
const TEST_PATH = 'extensions/blizzard/models/test/m3-skeleton.test.ts'

const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'm3-skeleton-preflight', classes: ['read-source'] } as const
const budget: ResourceBudget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  maxNodes: 750_000,
  maxScalarBytes: 134_217_728,
  maxDiagnostics: 100,
}

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

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

let xmlText: string | undefined

async function structuresText(): Promise<string> {
  xmlText ??= await readFile(
    join(extensionRoot, 'models', 'src', 'm3', 'native', 'structures.xml'),
    'utf8',
  )
  return xmlText
}

interface SyntheticBone {
  readonly name: string
  readonly parent?: number
  readonly flags?: number
  readonly nameSection?: number
}

function writeTag(bytes: Uint8Array, offset: number, tag: string): void {
  for (let index = 0; index < 4; index += 1) bytes[offset + index] = tag.charCodeAt(3 - index)
}

async function buildSkeletonM3(
  bones: readonly SyntheticBone[],
  options: { readonly truncateBoneBytes?: number } = {},
): Promise<Uint8Array> {
  const structures = await loadM3StructuresXml(await structuresText())
  const headerDesc = structures['MD34'].getVersion(11, 34, structures)
  const modelDesc = structures['MODL'].getVersion(20, 34, structures)
  const boneDesc = structures['BONE'].getVersion(1, 34, structures)
  const names = bones.map(bone => new TextEncoder().encode(`${bone.name}\0`))
  const headerOffset = 0
  const modelOffset = headerDesc.size
  const boneOffset = modelOffset + modelDesc.size
  const fullBoneBytes = boneDesc.size * bones.length
  const storedBoneBytes = Math.max(0, fullBoneBytes - (options.truncateBoneBytes ?? 0))
  const nameOffsets = []
  let cursor = boneOffset + storedBoneBytes
  for (const name of names) {
    nameOffsets.push(cursor)
    cursor += name.byteLength
  }
  const indexOffset = cursor
  const indexCount = 3 + names.length
  const bytes = new Uint8Array(indexOffset + indexCount * 16)

  const header = headerDesc.instance()
  header.tag = 0x4d443334
  header.index_offset = indexOffset
  header.index_size = indexCount
  header.model.entries = 1
  header.model.index = 1
  header.model.flags = 0
  header.toBuffer(bytes.buffer, headerOffset)

  const model = modelDesc.instance()
  model.bones.entries = bones.length
  model.bones.index = 2
  model.bones.flags = 0
  model.toBuffer(bytes.buffer, modelOffset)

  const boneBuffer = new ArrayBuffer(fullBoneBytes)
  for (const [index, input] of bones.entries()) {
    const bone = boneDesc.instance()
    bone.id = index
    bone.name.entries = names[index].byteLength
    bone.name.index = input.nameSection ?? 3 + index
    bone.name.flags = 0
    bone.flags = input.flags ?? 0
    bone.parent = input.parent ?? -1
    Object.assign(bone.location.default, { x: index + 1, y: 2, z: 3 })
    Object.assign(bone.rotation.default, { x: 0, y: 0, z: 0, w: 1 })
    Object.assign(bone.scale.default, { x: 1, y: 1, z: 1 })
    bone.toBuffer(boneBuffer, index * boneDesc.size)
  }
  bytes.set(new Uint8Array(boneBuffer).subarray(0, storedBoneBytes), boneOffset)
  for (const [index, name] of names.entries()) bytes.set(name, nameOffsets[index])

  const sections = [
    { tag: 'MD34', offset: headerOffset, repetitions: 1, version: 11 },
    { tag: 'MODL', offset: modelOffset, repetitions: 1, version: 20 },
    { tag: 'BONE', offset: boneOffset, repetitions: bones.length, version: 1 },
    ...names.map((name, index) => ({
      tag: 'CHAR',
      offset: nameOffsets[index],
      repetitions: name.byteLength,
      version: 0,
    })),
  ]
  const view = new DataView(bytes.buffer)
  for (const [index, section] of sections.entries()) {
    const offset = indexOffset + index * 16
    writeTag(bytes, offset, section.tag)
    view.setUint32(offset + 4, section.offset, true)
    view.setUint32(offset + 8, section.repetitions, true)
    view.setUint32(offset + 12, section.version, true)
  }
  return bytes
}

function proveSkeleton(note: string): void {
  proves({
    contributionId: 'blizzard/m3',
    operation: 'inspect',
    test: TEST_PATH,
    note,
  })
}

function referencedString(sections: M3SectionList, reference: unknown): string | null {
  if (reference === null || typeof reference !== 'object') return null
  const value = reference as { readonly entries?: unknown; readonly index?: unknown }
  if (!Number.isInteger(value.entries) || Number(value.entries) <= 0) return null
  if (!Number.isInteger(value.index) || Number(value.index) < 0) return null
  const section = sections.getSectionByReference(value)
  if (section?.desc.history.name !== 'CHAR') return null
  const content = section.content
  if (!Array.isArray(content) || content.length < Number(value.entries)) return null
  const bytes = Uint8Array.from(content.slice(0, Number(value.entries)), item => Number(item))
  const zero = bytes.indexOf(0)
  const bounded = zero < 0 ? bytes : bytes.subarray(0, zero)
  return new TextDecoder('utf-8', { fatal: true }).decode(bounded)
}

async function inventory() {
  const inputs = await Promise.all(
    [['casc'], ['models']].map(async parts => ({
      ...(await loadExtensionDirectory(join(extensionRoot, ...parts))),
      execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
    })),
  )
  return buildInventory(inputs, createHostContributionContractRegistry())
}

async function openMemory(bytes: Uint8Array) {
  const uri = 'memory://m3-skeleton/fixture.m3'
  const source: ArtifactByteSource = Object.freeze({
    kind: 'bytes' as const,
    ref: { id: uri, uri },
    revision: revisionId(`content-hash.sha256:${createHash('sha256').update(bytes).digest('hex')}`),
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  })
  return openSubject({
    inventory: await inventory(),
    source,
    path: 'fixture.m3',
    intent: 'full',
    target,
    grant,
    budget,
    executionBackends,
  })
}

describe('M3 BONE decoding', () => {
  it('resolves names through exact CHAR references and validates parents and named flags', async () => {
    const bytes = await buildSkeletonM3([
      { name: 'Root', flags: 0x2001 },
      { name: 'Turret', parent: 0, flags: 0x0806 },
    ])
    const decoded = await decodeM3Skeleton(bytes, budget)
    expect(decoded).toMatchObject({
      roots: 1,
      rejectedNames: 0,
      rejectedParentLinks: 0,
      unknownFlagRecords: 0,
      hierarchyComplete: true,
      fatal: false,
    })
    expect(decoded.bones).toEqual([
      expect.objectContaining({
        index: 0,
        name: 'Root',
        parentIndex: -1,
        flagNames: ['inheritTranslation', 'real'],
      }),
      expect.objectContaining({
        index: 1,
        name: 'Turret',
        parentIndex: 0,
        flagNames: ['inheritScale', 'inheritRotation', 'skinned'],
      }),
    ])
    expect(decoded.bindings).toEqual([
      {
        partId: 'bone/0',
        nodeId: 'bone/0',
        localPose: { translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        boneIndex: 0,
        boneName: 'Root',
        provenance: 'direct',
        hierarchyId: 'm3/bone-table',
        parentBoneIndex: null,
        nativeFlags: 0x2001,
        flagNames: ['inheritTranslation', 'real'],
      },
      {
        partId: 'bone/1',
        nodeId: 'bone/1',
        localPose: { translation: [2, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        boneIndex: 1,
        boneName: 'Turret',
        provenance: 'direct',
        hierarchyId: 'm3/bone-table',
        parentBoneIndex: 0,
        nativeFlags: 0x0806,
        flagNames: ['inheritScale', 'inheritRotation', 'skinned'],
      },
    ])
    proveSkeleton('BONE names, parents, and named flag bits are decoded without heuristic strings')
  })

  it('joins authored bone poses to scene nodes through the ordinary host', async () => {
    const opened = await openMemory(await buildSkeletonM3([{ name: 'Root' }, { name: 'Child', parent: 0 }]))
    expect(opened.state).toBe('opened')
    if (opened.state !== 'opened') throw new Error('host refused synthetic skeleton')
    try {
      const skeletonLease = await opened.session.dataSource('common.view/model-skeleton-source', 1)
      const sceneLease = await opened.session.dataSource('common.view/model-scene-source', 1)
      try {
        const bindings = (await (skeletonLease.value as ModelSkeletonSource).bindings({ limit: 10 })).items
        const nodes = (await (sceneLease.value as ModelSceneSource).nodes({ limit: 100 })).items
        expect(bindings).toHaveLength(2)
        for (const binding of bindings) {
          const node = nodes.find(node => node.id === binding.nodeId)
          expect(node?.transform.slice(12, 15)).toEqual(binding.localPose?.translation)
          expect(binding.inverseBindMatrix).toBeUndefined()
        }
        expect(nodes.find(node => node.id === 'bone/0')?.childIds).toEqual(['bone/1'])
      } finally { await sceneLease.release(); await skeletonLease.release() }
    } finally { await opened.session.dispose() }
  })

  it('reports a truncated BONE table and keeps the subject inspectable', async () => {
    const bytes = await buildSkeletonM3([{ name: 'Root' }], { truncateBoneBytes: 1 })
    const decoded = await decodeM3Skeleton(bytes, budget)
    expect(decoded.fatal).toBe(true)
    expect(decoded.issues).toContainEqual(
      expect.objectContaining({ code: 'x3.m3/skeleton-truncated', severity: 'warning' }),
    )
    const opened = await openMemory(bytes)
    expect(opened.state).toBe('opened')
    expect(opened.descriptor.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'x3.m3/skeleton-truncated' }),
    )
    if (opened.state === 'opened') await opened.session.dispose()
    proveSkeleton('a truncated BONE table becomes a coded diagnostic, not an uncaught parser error')
  })

  it('rejects out-of-range and cyclic parent links without discarding named bindings', async () => {
    const outOfRange = await decodeM3Skeleton(
      await buildSkeletonM3([{ name: 'Root', parent: 7 }]),
      budget,
    )
    expect(outOfRange.rejectedParentLinks).toBe(1)
    expect(outOfRange.bindings[0]).toMatchObject({ boneName: 'Root', provenance: 'direct' })
    expect(outOfRange.bindings[0]).not.toHaveProperty('hierarchyId')

    const cycle = await decodeM3Skeleton(
      await buildSkeletonM3([
        { name: 'A', parent: 1 },
        { name: 'B', parent: 0 },
      ]),
      budget,
    )
    expect(cycle.rejectedParentLinks).toBe(2)
    expect(cycle.issues).toContainEqual(
      expect.objectContaining({ code: 'x3.m3/skeleton-parent-refused' }),
    )
    proveSkeleton('invalid parent links are named refusals and never become hierarchy claims')
  })

  it('publishes an absent name when BONE.name does not address CHAR', async () => {
    const decoded = await decodeM3Skeleton(
      await buildSkeletonM3([{ name: 'Ignored', nameSection: 99 }]),
      budget,
    )
    expect(decoded.rejectedNames).toBe(1)
    expect(decoded.bindings[0]).toMatchObject({ boneName: null, provenance: 'absent' })
    expect(decoded.issues).toContainEqual(
      expect.objectContaining({ code: 'x3.m3/skeleton-name-refused' }),
    )
    proveSkeleton('an invalid CHAR reference produces null/absent rather than a guessed bone name')
  })

  it('refuses BONE allocation before schema parsing when maxNodes is exhausted', async () => {
    const decoded = await decodeM3Skeleton(await buildSkeletonM3([{ name: 'Root' }]), {
      ...budget,
      maxNodes: 0,
    })
    expect(decoded).toMatchObject({ fatal: true, bindings: [] })
    expect(decoded.issues).toContainEqual(
      expect.objectContaining({ code: 'x3.m3/skeleton-budget-exceeded' }),
    )
    proveSkeleton('the BONE count is bounded from the section index before records are allocated')
  })

  it('names maxScalarBytes when the BONE table cannot fit its decode budget', async () => {
    const decoded = await decodeM3Skeleton(await buildSkeletonM3([{ name: 'Root' }]), {
      ...budget,
      maxScalarBytes: 5,
    })
    expect(decoded).toMatchObject({ fatal: true, bindings: [] })
    expect(decoded.issues).toContainEqual(
      expect.objectContaining({
        code: 'x3.m3/skeleton-budget-exceeded',
        message: expect.stringMatching(/maxScalarBytes/u),
      }),
    )
    proveSkeleton('the BONE byte cost is named and bounded before schema-backed decoding')
  })
})

describe.skipIf(process.env.MODKIT_TEST_INSTALLED_CORPUS === '0')(
  'M3 skeleton corpus preflight',
  () => {
  it('pins a named BONE table reached through the host/CASC route', async ({ skip }) => {
    const sc2Root = await installedSc2Root()
    if (sc2Root === undefined) {
      skip()
      return
    }
    const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
    const mount = await vfs.openMount(pathToFileURL(sc2Root).href)
    const casc = await openSubject({
      inventory: await inventory(),
      source: artifactNamespaceSourceFromVfsMount(mount),
      path: sc2Root,
      intent: 'full',
      target,
      grant,
      budget,
      executionBackends,
    })
    if (casc.state !== 'opened') {
      throw new Error(
        `CASC did not open: ${JSON.stringify({
          state: casc.state,
          reason: casc.reason,
          candidates: casc.candidates,
          diagnostics: casc.diagnostics,
        }).slice(0, 4000)}`,
      )
    }
    try {
      const extracted = await casc.session
        .operations()
        .invoke('extract-entry', { entryId: MODEL_PATH })
      if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') {
        throw new Error(`CASC extraction failed for ${MODEL_PATH}`)
      }
      const bytes = extracted.output.value
      const xml = await readFile(
        join(extensionRoot, 'models', 'src', 'm3', 'native', 'structures.xml'),
        'utf8',
      )
      const sections = await M3SectionList.load(arrayBufferOf(bytes), xml)
      const boneSection = sections.getSectionByReference(sections.model?.bones)
      const bones = boneSection?.content ?? []
      const names = bones.map(bone => referencedString(sections, bone.name))
      const rejectedParents = bones.filter((bone, index) => {
        const parent = Number(bone.parent ?? -1)
        return parent < -1 || parent >= bones.length || parent === index
      }).length
      const roots = bones.filter(bone => Number(bone.parent ?? -1) === -1).length
      const digest = createHash('sha256').update(bytes).digest('hex')
      const decodedSkeleton = await decodeM3Skeleton(bytes, budget)

      expect(MODEL_PATH).not.toMatch(/^(?:[A-Za-z]:|[\\/]|[a-z][a-z0-9+.-]*:)/u)
      expect(bytes.byteLength).toBe(MODEL_BYTES)
      expect(digest).toBe(MODEL_SHA256)
      expect(boneSection?.desc.history.name).toBe('BONE')
      expect(bones.length).toBe(MODEL_BONES)
      expect(names.filter((name): name is string => name !== null && name.length > 0).length).toBe(
        bones.length,
      )
      expect(roots).toBe(MODEL_ROOTS)
      expect(rejectedParents).toBe(0)
      expect(decodedSkeleton).toMatchObject({
        roots: MODEL_ROOTS,
        rejectedNames: 0,
        rejectedParentLinks: 0,
        unknownFlagRecords: 0,
        hierarchyComplete: true,
        fatal: false,
      })
      expect(decodedSkeleton.bindings).toHaveLength(MODEL_BONES)

      const { openNestedSubject } = (await import(
        pathToFileURL(join(repoRoot, 'packages', 'host', 'src', 'nested-subject.js')).href
      )) as typeof import('../../../../packages/host/src/nested-subject.js')
      const nested = await openNestedSubject({
        parent: casc.session,
        entryId: MODEL_PATH,
        inventory: await inventory(),
        executionBackends,
        target,
        grant,
        budget,
      })
      if (nested.result.state !== 'opened') {
        throw new Error(JSON.stringify(nested.result.diagnostics).slice(0, 1200))
      }
      try {
        expect(nested.result.selected.contributionId).toBe('blizzard/m3')
        const descriptor = await nested.result.session.descriptor()
        expect(descriptor.dataSources).toContainEqual(
          expect.objectContaining({
            contract: 'common.view/model-skeleton-source',
            major: 1,
          }),
        )
        const lease = await nested.result.session.dataSource('common.view/model-skeleton-source', 1)
        try {
          const source = lease.value as ModelSkeletonSource
          expect(await source.info()).toEqual({
            bindings: MODEL_BONES,
            named: MODEL_BONES,
            companionBound: 0,
            hierarchies: 1,
          })
          const paged = []
          let cursor: string | undefined
          do {
            const page = await source.bindings({
              limit: 1,
              ...(cursor === undefined ? {} : { cursor }),
            })
            paged.push(...page.items)
            cursor = page.nextCursor
          } while (cursor !== undefined)
          expect(paged).toHaveLength(MODEL_BONES)
          expect(paged.every(item => item.provenance === 'direct' && item.boneName !== null)).toBe(
            true,
          )
          expect(paged.every(item => item.restMatrix?.length === 16)).toBe(true)
          expect(paged.every(item => item.parentBoneIndex === null)).toBe(true)

          const receipt = descriptor.metadata.find(group => group.id === 'uv-projection-receipt')
            ?.entries[0]?.value as
            { readonly planes: readonly { planeId: string; state: string }[] } | undefined
          expect(receipt?.planes).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                planeId: 'skeleton-bindings',
                state: 'preserved',
              }),
              expect.objectContaining({ planeId: 'skeleton-hierarchy', state: 'preserved' }),
              expect.objectContaining({ planeId: 'skeleton-flags', state: 'preserved' }),
              expect.objectContaining({ planeId: 'skeleton-rest-pose', state: 'preserved' }),
            ]),
          )
          expect(receipt?.planes).not.toContainEqual(
            expect.objectContaining({ planeId: 'skeleton', state: 'preserved' }),
          )
          expect(JSON.stringify(receipt)).not.toMatch(/(?:[A-Za-z]:[\\/]|file:\/\/|\\\\)/u)
        } finally {
          await lease.release()
        }
      } finally {
        await nested.result.session.dispose()
      }
      console.info(
        `[sc2-live] ${MODEL_PATH}: bytes=${bytes.byteLength}, sha256=${digest}, ` +
          `bones=${bones.length}, named=${names.filter(Boolean).length}, roots=${roots}, ` +
          `rejectedParents=${rejectedParents}, unknownFlagRecords=${decodedSkeleton.unknownFlagRecords}`,
      )
      proveSkeleton(
        'the live CASC sample publishes 12 named BONE bindings with parents, flags and exact IREF matrices',
      )
    } finally {
      await casc.session.dispose()
    }
  }, 300_000)
  },
)
