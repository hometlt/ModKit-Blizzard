import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  artifactNamespaceSourceFromVfsMount,
  buildInventory,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  createWorkspaceNamespaceCandidateDiscovery,
  openNestedSubject,
  openSubject,
  type Inventory,
} from '@modkit/host'
import { createNodeInstallationProbes, loadExtensionDirectory } from '@modkit/host/node'
import type {
  Lease,
  ModelAnimationClip,
  ModelAnimationSource,
  ModelResourceRefsSource,
  ModelSceneSource,
  ModelSkeletonSource,
  NamespaceEntrySource,
  ResourceBudget,
  RevisionId,
} from '@modkit/sdk'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { discoverM3AnimationSidecars } from '../src/m3/sidecar-projection.node.js'
import { discoverStarcraft2Installations } from '../../starcraft2/modules/game/providers/installation/provider.js'
import { decodeM3Animations } from '../src/m3/animation.node.js'
import { DOMParser } from '@xmldom/xmldom'
import { installM3PlatformAdapters } from '../dist/m3/native/platform.js'
import { decodeM3Geometry } from '../src/m3/geometry.node.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { createProvider, snapshotM3SemanticEdit } from '../src/m3/writer.js'
import { findBlizzardExtensionRoot, findModkitCoreWorkspace } from './workspace-root.js'
import {
  drainM3aSession,
  m3aSessionEvidence,
  verifyRetailM3aUvmSession,
  verifyRetailStandaloneM3aUvm,
} from './m3a-uvm-session.js'

function expectCompleteZeratulChannels(clip: ModelAnimationClip | undefined) {
  expect(clip).toBeDefined()
  expect(clip?.channels.filter(channel => ['translation', 'rotation', 'scale'].includes(channel.kind)))
    .toHaveLength(402)
  expect(clip?.channels.filter(channel => channel.kind === 'visibility' && channel.target.startsWith('bone/')))
    .toHaveLength(126)
}

const repoRoot = findModkitCoreWorkspace(import.meta.dirname)
installM3PlatformAdapters({ DOMParser: DOMParser as unknown as typeof globalThis.DOMParser })

const extensionRoot = findBlizzardExtensionRoot(import.meta.dirname)
const { createWorkspaceNamespaceCompanionOrigin } = await import(
  pathToFileURL(join(repoRoot, 'packages', 'host', 'src', 'namespace-origin.js')).href
)
const { createResourceSession } = await import(
  pathToFileURL(join(repoRoot, 'packages', 'host', 'src', 'resource-session.js')).href
)
let sc2Root: string | undefined

async function installedSc2Root(): Promise<string | undefined> {
  const configured = process.env.MODKITX_SC2_ROOT?.trim()
  const result = await discoverStarcraft2Installations({
    gameId: 'blizzard/starcraft-2',
    ...(configured === undefined || configured.length === 0
      ? {}
      : { configuredPaths: [configured] }),
    maxCandidates: 128,
  }, createNodeInstallationProbes())
  return result.installations[0]?.normalizedPath
}
const discoveredSc2Root = await installedSc2Root()
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'm3a-corpus-audit', classes: ['read-source'] } as const
const budget: ResourceBudget = {
  maxInputBytes: 268_435_456n,
  maxDepth: 128,
  // The joint native graph includes both the base model and the M3A section repetitions.
  // Exercise the codec's declared one-million-node ceiling, including aggregate preflight.
  maxNodes: 1_000_000,
  maxScalarBytes: 134_217_728,
  maxDiagnostics: 100,
}

const ROOT_PREFIX = 'campaigns/liberty.sc2campaign/base.sc2assets'
const DISCOVERY_PREFIX = 'assets/storymodecharacters/protoss'
const BASE_DIRECTORY = `${ROOT_PREFIX}/assets/storymodecharacters/protoss/sm_zeratul/`
const BASE_PATH = `${BASE_DIRECTORY}sm_zeratul.m3`
const SIDECAR_DIRECTORY = `${ROOT_PREFIX}/assets/storymodecharacters/protoss/sm_zeratul_dialogue03/`
const SIDECAR_PATH = `${SIDECAR_DIRECTORY}sm_zeratul_dialogue03.m3a`
const SIDECAR_LOGICAL_ID =
  'assets/storymodecharacters/protoss/sm_zeratul_dialogue03/sm_zeratul_dialogue03.m3a'
const UNRELATED_BASE_PATH =
  'campaigns/liberty.sc2campaign/base.sc2assets/assets/campaign/terran/artifact1/artifact1.m3'
const SIDECAR_BYTES = 1_382_592
const SIDECAR_SHA256 = '3549347c81c70f63c72d84ea441b21e6405c6b748001c33f84b8e04c6dba16ad'
const SIDECAR_ANIMATION_HASH = 840_957_610
const EXPECTED_TEXTURES = Object.freeze([
  'Assets/Textures/sm_zt_eye_Diff.dds',
  'Assets/Textures/sm_zt_eye_emis.dds',
  'Assets/Textures/sm_zt_eye_Norm.dds',
  'Assets/Textures/sm_zt_head_Diff.dds',
  'Assets/Textures/sm_zt_head_spec.dds',
  'Assets/Textures/sm_zt_head_Norm.dds',
  'Assets/Textures/sm_zt_aocc.dds',
  'Assets/Textures/sm_zt_others_Diff.dds',
  'Assets/Textures/sm_zt_others_spec.dds',
  'Assets/Textures/sm_zt_others_emis.dds',
  'Assets/Textures/Reflection_MarSaraBar.dds',
  'Assets/Textures/sm_zt_others_Norm.dds',
  'Assets/Textures/sm_zt_env.dds',
  'Assets/Textures/SM_ZT_body_Diff.dds',
  'Assets/Textures/sm_zt_body_spec.dds',
  'Assets/Textures/sm_zt_body_Norm.dds',
])

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

let inventoryValue: Inventory | undefined
let cascResult: Awaited<ReturnType<typeof openSubject>> | undefined
let namespaceLease: Lease<unknown> | undefined
let namespaceValue: NamespaceEntrySource | undefined
let cascRevision: RevisionId | undefined

function inventory(): Inventory {
  if (inventoryValue === undefined) throw new TypeError('M3A corpus inventory is not open')
  return inventoryValue
}

function casc() {
  if (cascResult?.state !== 'opened') throw new TypeError('M3A corpus CASC session is not open')
  return cascResult
}

function namespace(): NamespaceEntrySource {
  if (namespaceValue === undefined) throw new TypeError('M3A corpus namespace is not open')
  return namespaceValue
}

async function extract(entryId: string, signal?: AbortSignal): Promise<Uint8Array> {
  const payload = await casc()
    .session.operations()
    .invoke('extract-entry', { entryId }, signal === undefined ? {} : { signal })
  if (payload.state !== 'ok' || payload.output.kind !== 'bytes') {
    throw new Error(`CASC extraction failed for ${entryId}`)
  }
  return payload.output.value
}

async function directoryEntries(prefix: string): Promise<readonly string[]> {
  const entries: string[] = []
  let cursor: string | undefined
  for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
    const page = await namespace().list(prefix, { cursor, limit: 64 })
    entries.push(...page.items.map(item => item.id))
    cursor = page.nextCursor
    if (cursor === undefined) return Object.freeze(entries)
  }
  throw new RangeError(`retail M3 directory «${prefix}» exceeded four pages`)
}

function resourceSession(primaryLogicalId: string) {
  if (cascRevision === undefined) throw new TypeError('M3A corpus revision is absent')
  return createResourceSession({
    origin: createWorkspaceNamespaceCompanionOrigin({
      namespace: namespace(),
      primaryLogicalId,
      containerRevision: cascRevision,
      logicalRoots: [
        {
          rootId: 'retail:liberty.sc2campaign',
          pathPrefix: ROOT_PREFIX,
        },
      ],
      pageLimit: 64,
      maxPages: 4,
      extract,
    }),
    revision: cascRevision,
    limits: { maxEntries: 256 },
  })
}

function candidateDiscovery(
  logicalPrefix = DISCOVERY_PREFIX,
  limitOverrides: Partial<{
    readonly pageItems: number
    readonly maxPages: number
    readonly maxEntries: number
    readonly maxCandidates: number
    readonly maxBytes: bigint
  }> = {},
) {
  if (cascRevision === undefined) throw new TypeError('M3A corpus revision is absent')
  return createWorkspaceNamespaceCandidateDiscovery({
    namespace: namespace(),
    containerRevision: cascRevision,
    logicalRoots: [
      {
        rootId: 'retail:liberty.sc2campaign',
        pathPrefix: ROOT_PREFIX,
      },
    ],
    searches: [{ rootId: 'retail:liberty.sc2campaign', logicalPrefix }],
    extension: '.m3a',
    limits: {
      pageItems: 64,
      maxPages: 8,
      maxEntries: 512,
      maxCandidates: 16,
      maxBytes: 67_108_864n,
      ...limitOverrides,
    },
  })
}

function writerTarget(name: string) {
  const uri = `file:///C:/bounded/${name}`
  return Object.freeze({
    targetId: 'content',
    subjectUri: uri,
    ownerSource: Object.freeze({ id: uri, uri }),
    semanticPath: Object.freeze([]),
    expectedRevision: Object.freeze({ sourceRevision: 'provider-token:retail-m3-writer-corpus' }),
  })
}

function corpusWriter() {
  return createProvider(
    { contract: 'common.edit/writer', major: 1, offerId: 'm3-native-source' },
    {
      budgets: budget,
      providerIdentity: {
        providerId: 'blizzard/m3-preserving-writer',
        providerVersion: '1.0.0',
        artifactDigest: 'test:retail-m3-writer',
      },
    },
  ).value
}

function planBytes(plan: {
  readonly edits: readonly {
    readonly operation: string
    readonly payload: { readonly kind: string; readonly bytes?: Uint8Array }
  }[]
}) {
  const edit = plan.edits[0]
  if (
    edit?.operation !== 'replace' ||
    edit.payload.kind !== 'inline' ||
    edit.payload.bytes === undefined
  ) {
    throw new TypeError('retail M3 writer returned no inline replacement')
  }
  return edit.payload.bytes
}

describe.skipIf(discoveredSc2Root === undefined)('installed StarCraft II M3A corpus', () => {
  beforeAll(async () => {
    sc2Root = discoveredSc2Root
    if (sc2Root === undefined) throw new TypeError('installed StarCraft II corpus was not selected')
    const inputs = await Promise.all(
      [['casc'], ['models']].map(async parts => ({
        ...(await loadExtensionDirectory(join(extensionRoot, ...parts))),
        execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
      })),
    )
    inventoryValue = await buildInventory(inputs, createHostContributionContractRegistry())
    const vfs = new VirtualFileSystem().registerProvider(createFileVfsProvider())
    const mount = await vfs.openMount(pathToFileURL(sc2Root).href)
    cascResult = await openSubject({
      inventory: inventoryValue,
      source: artifactNamespaceSourceFromVfsMount(mount),
      path: sc2Root,
      intent: 'full',
      target,
      grant,
      budget,
      executionBackends,
    })
    if (cascResult.state !== 'opened') {
      throw new Error(
        `CASC did not open: ${cascResult.reason} ${JSON.stringify({ candidates: cascResult.candidates, diagnostics: cascResult.diagnostics })}`,
      )
    }
    namespaceLease = await cascResult.session.dataSource('common.view/namespace-entry-source', 1)
    namespaceValue = namespaceLease.value as NamespaceEntrySource
    cascRevision = (await cascResult.session.descriptor()).revision
  }, 300_000)

  afterAll(async () => {
    try {
      await namespaceLease?.release()
    } finally {
      if (cascResult?.state === 'opened') await cascResult.session.dispose()
    }
  })

  it('discovers and pairs a pinned retail Zeratul M3A through product namespace routes', async () => {
    expect(await directoryEntries(BASE_DIRECTORY)).toContain(BASE_PATH)
    expect(await directoryEntries(SIDECAR_DIRECTORY)).toContain(SIDECAR_PATH)

    const [baseBytes, sidecarBytes] = await Promise.all([extract(BASE_PATH), extract(SIDECAR_PATH)])
    expect(sidecarBytes).toHaveLength(SIDECAR_BYTES)
    expect(createHash('sha256').update(sidecarBytes).digest('hex')).toBe(SIDECAR_SHA256)

    const resources = resourceSession(BASE_PATH)
    try {
      const pairing = await discoverM3AnimationSidecars({
        baseBytes,
        candidateDiscovery: candidateDiscovery(),
        resources,
        budget,
      })
      expect(pairing.discovery).toMatchObject({
        complete: true,
        candidates: 2,
        searches: [{ rootId: 'retail:liberty.sc2campaign', logicalPrefix: DISCOVERY_PREFIX }],
      })
      expect(pairing.discovery.bytes).toBeGreaterThan(BigInt(SIDECAR_BYTES))
      expect(pairing.accepted).toEqual([
        expect.objectContaining({
          logicalId: SIDECAR_LOGICAL_ID,
          bytes: SIDECAR_BYTES,
          hashes: [SIDECAR_ANIMATION_HASH],
          clips: 1,
        }),
      ])
      expect(pairing.references).toEqual([
        {
          id: SIDECAR_LOGICAL_ID,
          role: 'sidecar',
          provenance: 'companion',
          bytes: SIDECAR_BYTES,
        },
      ])
      expect(pairing.clips).toHaveLength(1)
      expect(pairing.clips[0]).toMatchObject({
        id: 'm3a-0-sequence-0',
        name: 'Dialogue 03',
        kind: 'animation',
        provenance: 'companion',
        hierarchyId: 'm3/bone-table',
      })
      expect(pairing.clips[0]?.unsupportedChannels ?? 0).toBe(0)
      expectCompleteZeratulChannels(pairing.clips[0])
      expect(pairing.clips[0]?.channels.every(channel => channel.target.startsWith('bone/'))).toBe(
        true,
      )
      expect(
        pairing.clips[0]?.channels.every(
          channel =>
            channel.samples !== undefined &&
            channel.samples.length > 0 &&
            channel.samples.every(sample => sample.value.every(Number.isFinite)),
        ),
      ).toBe(true)
      expect(pairing.diagnostics.map(item => item.code)).toContain(
        'x3.m3/m3a-sidecar-skeleton-mismatch',
      )
      expect(pairing.provenance).toEqual([
        expect.objectContaining({
          logicalId: SIDECAR_LOGICAL_ID,
          state: 'resolved',
          bytes: BigInt(SIDECAR_BYTES),
        }),
        expect.objectContaining({
          logicalId:
            'assets/storymodecharacters/protoss/sm_zeratul_requiredanims/sm_zeratul_requiredanims.m3a',
          state: 'resolved',
        }),
      ])
    } finally {
      await resources.dispose()
    }
    expect(resources.state()).toBe('disposed')
  })

  it('opens retail M3 with discovered M3A and exports a source-free UVM scene', async () => {
    const [baseBytes, sidecarBytes] = await Promise.all([extract(BASE_PATH), extract(SIDECAR_PATH)])
    const nativeRecordCounts = [baseBytes, sidecarBytes].map(bytes => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const offset = view.getUint32(4, true),
        count = view.getUint32(8, true)
      let records = count
      for (let index = 0; index < count; index++)
        records += view.getUint32(offset + index * 16 + 8, true)
      return records
    })
    const aggregateNativeRecords = nativeRecordCounts.reduce((sum, count) => sum + count, 0)
    expect(aggregateNativeRecords).toBeGreaterThan(750_000)
    expect(aggregateNativeRecords).toBeLessThanOrEqual(budget.maxNodes)
    console.info(
      '[sc2-live] M3/M3A aggregate native records',
      nativeRecordCounts,
      aggregateNativeRecords,
    )
    expect(sidecarBytes).toHaveLength(SIDECAR_BYTES)
    expect(createHash('sha256').update(sidecarBytes).digest('hex')).toBe(SIDECAR_SHA256)
    const nested = await openNestedSubject({
      parent: casc().session,
      entryId: BASE_PATH,
      inventory: inventory(),
      executionBackends,
      target,
      grant,
      budget,
      logicalRoots: [{ rootId: 'retail:liberty.sc2campaign', pathPrefix: ROOT_PREFIX }],
      resourceDiscovery: [
        {
          role: 'sidecar',
          extension: '.m3a',
          searches: [{ rootId: 'retail:liberty.sc2campaign', logicalPrefix: DISCOVERY_PREFIX }],
          limits: {
            pageItems: 64,
            maxPages: 8,
            maxEntries: 512,
            maxCandidates: 64,
            maxBytes: 67_108_864n,
          },
        },
      ],
    })
    if (nested.result.state !== 'opened')
      throw new Error(`${BASE_PATH}: ${JSON.stringify(nested.result.diagnostics)}`)
    try {
      expect(nested.result.selected.contributionId).toBe('blizzard/m3')
      const native = await drainM3aSession(nested.result.session, budget)
      const clips = native.animations ?? []
      const companions = clips.filter(clip => clip.provenance === 'companion')
      const clipId = `m3a:${encodeURIComponent(SIDECAR_LOGICAL_ID)}:m3-sequence-0`
      expect(companions).toHaveLength(1)
      expect(companions[0]).toMatchObject({
        id: clipId,
        name: 'Dialogue 03',
        kind: 'animation',
        provenance: 'companion',
        hierarchyId: 'm3/bone-table',
        nativeTimeBounds: { startMilliseconds: 0, endMilliseconds: 107_266 },
      })
      expect(companions[0]?.unsupportedChannels ?? 0).toBe(0)
      expectCompleteZeratulChannels(companions[0])
      expect(clips.filter(clip => clip.provenance === 'direct')).toEqual(
        (await decodeM3Animations(baseBytes, budget)).clips,
      )
      const record = nested.result.resources
        ?.provenance()
        .find(item => item.logicalId === SIDECAR_LOGICAL_ID)
      expect(record).toMatchObject({
        logicalId: SIDECAR_LOGICAL_ID,
        state: 'resolved',
        bytes: BigInt(SIDECAR_BYTES),
      })
      if (record?.state !== 'resolved' || record.revision === undefined)
        throw new Error('ordinary M3 session did not retain resolved sidecar revision')
      const resourceLease = await nested.result.session.dataSource(
        'common.view/model-resource-refs-source',
        1,
      )
      try {
        const references = await (resourceLease.value as ModelResourceRefsSource).references({
          limit: 64,
        })
        expect(references.items).toContainEqual({
          id: SIDECAR_LOGICAL_ID,
          role: 'sidecar',
          provenance: 'companion',
          bytes: SIDECAR_BYTES,
        })
      } finally {
        await resourceLease.release()
      }
      await verifyRetailM3aUvmSession({
        session: nested.result.session,
        native,
        baseBytes,
        sidecar: {
          logicalId: SIDECAR_LOGICAL_ID,
          revision: record.revision,
          bytes: sidecarBytes,
          clipId,
        },
        budget,
      })
      // Read the immutable archive route again; no export may mutate either physical source.
      expect(await extract(BASE_PATH)).toEqual(baseBytes)
      expect(await extract(SIDECAR_PATH)).toEqual(sidecarBytes)
    } catch (error) {
      await m3aSessionEvidence(
        'retail-refusal.json',
        JSON.stringify(
          {
            base: BASE_PATH,
            sidecar: SIDECAR_PATH,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : String(error),
          },
          null,
          2,
        ),
      )
      throw error
    } finally {
      await nested.result.session.dispose()
    }
  })

  it('opens the retail M3A directly without fabricating companion-bound facts', async () => {
    const sourceBytes = await extract(SIDECAR_PATH)
    const nested = await openNestedSubject({
      parent: casc().session,
      entryId: SIDECAR_PATH,
      inventory: inventory(),
      executionBackends,
      target,
      grant,
      budget,
      // A discoverable real sibling exists. Standalone mode must leave it and textures unread.
      logicalRoots: [{ rootId: 'retail:liberty.sc2campaign', pathPrefix: ROOT_PREFIX }],
      resourceDiscovery: [
        {
          role: 'sidecar',
          extension: '.m3a',
          searches: [{ rootId: 'retail:liberty.sc2campaign', logicalPrefix: DISCOVERY_PREFIX }],
          limits: {
            pageItems: 64,
            maxPages: 8,
            maxEntries: 512,
            maxCandidates: 64,
            maxBytes: 67_108_864n,
          },
        },
      ],
    })
    if (nested.result.state !== 'opened') {
      throw new Error(`${SIDECAR_PATH}: ${JSON.stringify(nested.result.diagnostics)}`)
    }
    try {
      expect(nested.result.selected.contributionId).toBe('blizzard/m3a')
      const sceneLease = await nested.result.session.dataSource('common.view/model-scene-source', 1)
      try {
        const info = await (sceneLease.value as ModelSceneSource).info()
        expect(info).toMatchObject({
          meshes: 0,
          primitives: 0,
          materials: 0,
          textures: 0,
          geometryAccess: 'decoded',
        })
        expect(info.bounds).toBeUndefined()
      } finally {
        await sceneLease.release()
      }
      const animationLease = await nested.result.session.dataSource(
        'common.view/model-animation-source',
        1,
      )
      try {
        const resourceLease = await nested.result.session.dataSource(
          'common.view/model-resource-refs-source',
          1,
        )
        try {
          const skeletonLease = await nested.result.session.dataSource(
            'common.view/model-skeleton-source',
            1,
          )
          try {
            const animations = animationLease.value as ModelAnimationSource
            const resources = resourceLease.value as ModelResourceRefsSource
            const skeleton = skeletonLease.value as ModelSkeletonSource
            expect(await animations.info()).toEqual({ clips: 1, channelled: 1, companionBound: 0 })
            const clips = (await animations.clips({ limit: 8 })).items
            expect(clips).toHaveLength(1)
            expect(clips[0]).toMatchObject({
              id: 'm3-sequence-0',
              name: 'Dialogue 03',
              provenance: 'direct',
            })
            expect(clips[0]?.unsupportedChannels ?? 0).toBe(0)
            expectCompleteZeratulChannels(clips[0])
            expect(clips[0]?.nativeTimeBounds).toEqual({
              startMilliseconds: 0,
              endMilliseconds: 107_266,
            })
            expect(
              clips[0]?.channels.reduce(
                (total, channel) => total + (channel.samples?.length ?? 0),
                0,
              ),
            ).toBeGreaterThan(402)

            expect(await resources.info()).toEqual({
              references: EXPECTED_TEXTURES.length,
              bound: 0,
              truncated: false,
            })
            const references = (await resources.references({ limit: 32 })).items
            expect(references.map(item => item.id)).toEqual(EXPECTED_TEXTURES)
            expect(references.every(item => item.provenance === 'reference-only')).toBe(true)
            expect(await skeleton.info()).toEqual({
              bindings: 134,
              named: 134,
              companionBound: 0,
              hierarchies: 1,
            })
            const bindings = (await skeleton.bindings({ limit: 256 })).items
            expect(bindings).toHaveLength(134)
            expect(bindings.every(binding => binding.restMatrix?.length === 16)).toBe(true)
          } finally {
            await skeletonLease.release()
          }
        } finally {
          await resourceLease.release()
        }
      } finally {
        await animationLease.release()
      }
      await verifyRetailStandaloneM3aUvm({ session: nested.result.session, sourceBytes, budget })
      expect(nested.result.resources?.provenance()).toEqual([])
      expect(await extract(SIDECAR_PATH)).toEqual(sourceBytes)
    } finally {
      await nested.result.session.dispose()
    }
  })

  it('rejects discovered retail M3As against an unrelated shipped base', async () => {
    const resources = resourceSession(UNRELATED_BASE_PATH)
    try {
      const pairing = await discoverM3AnimationSidecars({
        baseBytes: await extract(UNRELATED_BASE_PATH),
        candidateDiscovery: candidateDiscovery(),
        resources,
        budget,
      })
      expect(pairing.accepted).toEqual([])
      expect(pairing.clips).toEqual([])
      expect(pairing.references).toEqual([])
      expect(pairing.diagnostics.map(item => item.code)).toContain(
        'x3.m3/m3a-sidecar-hash-mismatch',
      )
      expect(pairing.provenance).toEqual([
        expect.objectContaining({ logicalId: SIDECAR_LOGICAL_ID, state: 'resolved' }),
        expect.objectContaining({
          logicalId:
            'assets/storymodecharacters/protoss/sm_zeratul_requiredanims/sm_zeratul_requiredanims.m3a',
          state: 'resolved',
        }),
      ])
    } finally {
      await resources.dispose()
    }
    expect(resources.state()).toBe('disposed')
  })

  it('round-trips and semantically edits pinned retail M3 and M3A bytes', async () => {
    const [baseBytes, sidecarBytes] = await Promise.all([extract(BASE_PATH), extract(SIDECAR_PATH)])
    const writer = corpusWriter()
    for (const [name, bytes] of [
      ['sm_zeratul.m3', baseBytes],
      ['sm_zeratul_dialogue03.m3a', sidecarBytes],
    ] as const) {
      const change = await snapshotM3SemanticEdit({
        sourceBytes: bytes,
        target: writerTarget(name),
        edits: [],
        budget,
      })
      expect(planBytes(await writer.plan(change))).toEqual(bytes)
    }

    const beforeGeometry = await decodeM3Geometry(baseBytes, budget)
    const scaled = await snapshotM3SemanticEdit({
      sourceBytes: baseBytes,
      target: writerTarget('sm_zeratul.m3'),
      edits: [{ kind: 'scale-model-v1', factor: 2 }],
      budget,
    })
    const scaledBytes = planBytes(await writer.plan(scaled))
    const afterGeometry = await decodeM3Geometry(scaledBytes, budget)
    expect(afterGeometry.primitives).toHaveLength(beforeGeometry.primitives.length)
    const beforePosition = beforeGeometry.primitives[0]?.positions.find(value => value !== 0)
    const afterPosition = afterGeometry.primitives[0]?.positions.find(value => value !== 0)
    expect(afterPosition).toBeCloseTo((beforePosition ?? 0) * 2)

    const xml = await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8')
    const beforeSections = await M3SectionList.load(Uint8Array.from(sidecarBytes).buffer, xml)
    const renamed = await snapshotM3SemanticEdit({
      sourceBytes: sidecarBytes,
      target: writerTarget('sm_zeratul_dialogue03.m3a'),
      edits: [{ kind: 'rename-sequence-v1', index: 0, name: 'Dialogue GA' }],
      budget,
    })
    const renamedBytes = planBytes(await writer.plan(renamed))
    const afterSections = await M3SectionList.load(Uint8Array.from(renamedBytes).buffer, xml)
    expect(
      afterSections.slice(0, beforeSections.length).map(item => item.desc.history.name),
    ).toEqual(beforeSections.map(item => item.desc.history.name))
    expect((await decodeM3Animations(renamedBytes, budget)).clips[0]).toMatchObject({
      name: 'Dialogue GA',
    })
  }, 60_000)

  it('fails closed for missing and over-budget explicit discovery roots', async () => {
    const baseBytes = await extract(BASE_PATH)
    const missingResources = resourceSession(BASE_PATH)
    try {
      const missing = await discoverM3AnimationSidecars({
        baseBytes,
        candidateDiscovery: candidateDiscovery('assets/storymodecharacters/not-a-real-root'),
        resources: missingResources,
        budget,
      })
      expect(missing.accepted).toEqual([])
      expect(missing.diagnostics.map(item => item.code)).toEqual(['x3.m3/m3a-discovery-empty'])
      expect(missing.provenance).toEqual([])
    } finally {
      await missingResources.dispose()
    }

    const boundedResources = resourceSession(BASE_PATH)
    try {
      const bounded = await discoverM3AnimationSidecars({
        baseBytes,
        candidateDiscovery: candidateDiscovery(DISCOVERY_PREFIX, { maxEntries: 1 }),
        resources: boundedResources,
        budget,
      })
      expect(bounded.accepted).toEqual([])
      expect(bounded.diagnostics.map(item => item.code)).toEqual([
        'x3.m3/m3a-discovery-budget-exceeded',
      ])
      expect(bounded.discovery).toMatchObject({ complete: false, candidates: 0, bytes: 0n })
      expect(bounded.provenance).toEqual([])
    } finally {
      await boundedResources.dispose()
    }
  })
})
