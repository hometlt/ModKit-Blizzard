import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CANCELLED_CODE } from '@modkit/core'
import { createModelSocketSource } from '@modkit/codec-kit'
import {
  revisionId,
  type ArtifactByteSource,
  type LogicalResourceRequirement,
  type ResourceBudget,
  type ResourceProvenanceRecord,
  type ResourceResolution,
  type ResourceSessionPort,
} from '@modkit/sdk'
import { describe, expect, it } from 'vitest'
import { decodeM3Attachments } from '../src/m3/attachments.node.js'
import {
  discoverM3AnimationSidecars,
  resolveM3AnimationSidecars,
} from '../src/m3/sidecar-projection.node.js'
import { findModkitCoreWorkspace } from './workspace-root.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { serializeM3SectionGraph } from '../dist/m3/native/structural.js'

const repoRoot = findModkitCoreWorkspace(import.meta.dirname)
const fixturePath = join(
  repoRoot,
  'packages',
  'testkit',
  'test',
  'fixtures',
  'm3',
  'cybros-cover.m3a.b64',
)
const distinctBasePath = join(
  repoRoot,
  'packages',
  'testkit',
  'test',
  'fixtures',
  'models',
  'triangle.m3',
)
const budget: ResourceBudget = {
  maxInputBytes: 1_000_000n,
  maxDepth: 64,
  maxNodes: 10_000,
  maxScalarBytes: 1_000_000,
  maxDiagnostics: 100,
}

/** A native-writer fixture isolates the hash gate from typed animation identity. */
async function explicitPair(unbound = false) {
  const original = await readFile(new URL('./fixtures/m3/corpus/portrait.m3', import.meta.url))
  const xml = await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8')
  const write = async (hash: number, changeTargets: boolean) => {
    const sections = await M3SectionList.load(Uint8Array.from(original).buffer, xml)
    sections.model['m3a_hash'] = hash
    ;(sections.model['m3a_hashes'] as any).entries = 0
    if (changeTargets) {
      const bones = sections.getSectionByReference(sections.model['bones'] as any)!.content as any[]
      for (const bone of bones) for (const field of ['location', 'rotation', 'scale'])
        bone[field].header.id = 0xffffffff
    }
    return serializeM3SectionGraph(sections)
  }
  return { baseBytes: await write(111, unbound), sidecar: await write(222, false) }
}

describe('explicit native animId admission with different hashes', () => {
  const explicitBudget = { ...budget, maxInputBytes: 16_777_216n, maxScalarBytes: 16_777_216, maxNodes: 500_000 }
  async function project(explicit: boolean, unbound = false, animationNames?: string[]) {
    const { baseBytes, sidecar } = await explicitPair(unbound)
    return resolveM3AnimationSidecars({ baseBytes,
      candidates: [{ logicalId: 'authored/portrait.m3a' }],
      resources: resourceSession({ 'authored/portrait.m3a': sidecar }).port,
      budget: explicitBudget, includeSources: true, bindingContext: { explicit }, animationNames })
  }
  it('admits an authored companion only after typed channels bind to the base', async () => {
    const result = await project(true)
    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]?.hashes).toEqual([222])
    expect(result.accepted[0]?.boundClips.some(c => c.channels.some(ch => ch.kind === 'translation'))).toBe(true)
  })
  it('keeps mismatched hashes refused without explicit authoring authority', async () => {
    const result = await project(false)
    expect(result.accepted).toEqual([])
    expect(result.diagnostics.some(d => d.code === 'x3.m3/m3a-sidecar-hash-mismatch')).toBe(true)
  })
  it('refuses a different-hash companion with no typed base targets', async () => {
    const result = await project(true, true)
    expect(result.accepted).toEqual([])
    expect(result.diagnostics.some(d => d.code === 'x3.m3/m3a-animid-binding-refused')).toBe(true)
  })
  it('verifies an unused subset without publishing unrequested poses', async () => {
    const result = await project(true, false, ['__not_an_authored_sequence__'])
    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]?.boundClips).toEqual([])
    expect(result.clips).toEqual([])
  })
  it('does not admit an unrelated companion through an empty subset', async () => {
    expect((await project(true, true, ['__not_an_authored_sequence__'])).accepted).toEqual([])
  })
})

async function fixture(): Promise<Uint8Array> {
  return Buffer.from(await readFile(fixturePath, 'utf8'), 'base64')
}

async function baseFixture(): Promise<Uint8Array> {
  return readFile(distinctBasePath)
}

/**
 * Algorithmic E1 base only, deliberately not claimed as an independent production pair.
 *
 * The genuine M3A bytes came from the legacy Modkit fixture
 * `extensions/blizzard/starcraft-2/codecs/m3/test/fixtures/cybros-cover.m3a.b64`; decoded SHA-256
 * is `07a632fb165b98e60b0e6803451e92c7d94ec527cae8252ca6ed2a3a0661b9e5`. The legacy corpus did
 * not record its original CASC logical path or a matching base M3. Changing one byte in its
 * embedded authoring path makes the base byte-distinct while retaining the hash/skeleton facts
 * needed to exercise the service algorithm. This is provider-foundation evidence, not E3/E4.
 */
function algorithmicBase(sidecar: Uint8Array): Uint8Array {
  const base = Uint8Array.from(sidecar)
  const marker = Buffer.from(base).indexOf('FrogKey')
  if (marker < 0) throw new TypeError('pinned M3A authoring-path marker is absent')
  base[marker] = 'f'.charCodeAt(0)
  return base
}

function resourceSession(
  entries: Readonly<Record<string, Uint8Array>>,
  options: { readonly revision?: string } = {},
): { readonly port: ResourceSessionPort; readonly releases: () => number } {
  const records: ResourceProvenanceRecord[] = []
  let released = 0
  const sessionRevision = revisionId('provider-token:m3a-session')
  const entryRevision = revisionId(options.revision ?? 'provider-token:m3a-fixture')
  const port: ResourceSessionPort = {
    sessionId: 'm3a-test',
    revision: sessionRevision,
    state: () => 'live',
    async resolve(requirement: LogicalResourceRequirement): Promise<ResourceResolution> {
      const bytes = entries[requirement.logicalId]
      if (bytes === undefined) {
        const provenance = Object.freeze({
          requirementId: requirement.id,
          logicalId: requirement.logicalId,
          role: requirement.role,
          state: 'unresolved' as const,
          reason: 'not-found' as const,
          cached: false,
          scopes: Object.freeze([...requirement.scopes]),
        })
        records.push(provenance)
        return {
          state: 'unresolved',
          reason: 'not-found',
          diagnostic: {
            id: 'x3.host/resource-not-found',
            code: 'x3.host/resource-not-found',
            severity: 'information',
            category: 'dependency',
            message: 'missing test resource',
          },
          provenance,
        }
      }
      const provenance = Object.freeze({
        requirementId: requirement.id,
        logicalId: requirement.logicalId,
        role: requirement.role,
        state: 'resolved' as const,
        revision: entryRevision,
        bytes: BigInt(bytes.byteLength),
        cached: false,
        scopes: Object.freeze([...requirement.scopes]),
      })
      records.push(provenance)
      let done = false
      const value: ArtifactByteSource = {
        kind: 'bytes',
        ref: { id: requirement.id, uri: `memory://m3a/${requirement.id}` },
        revision: entryRevision,
        size: BigInt(bytes.byteLength),
        read: async (offset, length) => bytes.slice(Number(offset), Number(offset) + length),
        async *stream() {
          yield bytes
        },
      }
      return {
        state: 'resolved',
        revision: entryRevision,
        provenance,
        lease: {
          value,
          async release() {
            if (done) return
            done = true
            released += 1
          },
        },
      }
    },
    provenance: () => Object.freeze([...records]),
    dispose: async () => undefined,
  }
  return { port, releases: () => released }
}

function completedDiscovery(
  logicalId: string,
  expectedRevision: ReturnType<typeof revisionId>,
  size: bigint,
) {
  const receipt = Object.freeze({
    complete: true,
    pages: 1,
    entries: 1,
    candidates: 1,
    bytes: size,
    searches: Object.freeze([Object.freeze({ rootId: 'test-root', logicalPrefix: 'animations' })]),
  })
  return Object.freeze({
    async discover() {
      return Object.freeze({
        state: 'complete',
        candidates: Object.freeze([
          Object.freeze({ logicalId, expectedRevision, size, rootId: 'test-root' }),
        ]),
        receipt,
      })
    },
  })
}

describe('M3 ATT_/ATVL and M3A projection', () => {
  it('pins stable attachment identity and exact native source names', async () => {
    const bytes = await fixture()
    const attachment = await decodeM3Attachments(bytes, budget)
    expect(attachment.fatal).toBe(false)
    expect(attachment.sockets).toEqual([
      {
        id: 'm3-attachment-0',
        nodeId: 'bone/1',
        role: 'attach',
        sourceName: 'Ref_Hardpoint',
      },
    ])
    expect(attachment.animationHashes).toEqual([3_747_707_700])
  })

  it('does not overwrite or coalesce multiple attachment identities sharing one bone', async () => {
    const decoded = await decodeM3Attachments(await fixture(), budget)
    const first = decoded.sockets[0]
    if (first === undefined) throw new TypeError('pinned M3A has no attachment')
    const source = createModelSocketSource({
      sockets: [first, { ...first, id: 'm3-attachment-1', sourceName: 'Ref_Hardpoint_Second' }],
    })
    expect((await source.sockets({ limit: 8 })).items).toEqual([
      expect.objectContaining({ id: 'm3-attachment-0', nodeId: 'bone/1' }),
      expect.objectContaining({ id: 'm3-attachment-1', nodeId: 'bone/1' }),
    ])
  })

  it('exercises algorithmic E1 binding only through ResourceSessionPort', async () => {
    const bytes = await fixture()
    const baseBytes = algorithmicBase(bytes)
    expect(baseBytes).not.toEqual(bytes)
    const resources = resourceSession({ 'animations/cybros-cover.m3a': bytes })
    const result = await resolveM3AnimationSidecars({
      baseBytes,
      candidates: [{ logicalId: 'animations/cybros-cover.m3a' }],
      resources: resources.port,
      budget,
    })
    expect(result.accepted, JSON.stringify(result.diagnostics)).toEqual([
      expect.objectContaining({
        logicalId: 'animations/cybros-cover.m3a',
        hashes: [3_747_707_700],
        clips: 1,
      }),
    ])
    expect(result.clips).toEqual([
      expect.objectContaining({
        id: 'm3a-0-sequence-0',
        name: 'Cover',
        kind: 'rest-pose',
        provenance: 'companion',
      }),
    ])
    expect(result.references).toEqual([
      expect.objectContaining({
        id: 'animations/cybros-cover.m3a',
        role: 'sidecar',
        provenance: 'companion',
      }),
    ])
    expect(resources.releases()).toBe(1)

    // A genuinely distinct shipped M3 fixture is not the matching Cybros base and must not be
    // presented as one: explicit hash compatibility fails closed.
    const distinct = await resolveM3AnimationSidecars({
      baseBytes: await baseFixture(),
      candidates: [{ logicalId: 'animations/cybros-cover.m3a' }],
      resources: resourceSession({ 'animations/cybros-cover.m3a': bytes }).port,
      budget,
    })
    expect(distinct.accepted).toEqual([])
    expect(distinct.diagnostics.map(item => item.code)).toContain('x3.m3/m3a-sidecar-hash-mismatch')
  })

  it('admits fully discovered candidates through revision and compatibility gates', async () => {
    const bytes = await fixture()
    const baseBytes = algorithmicBase(bytes)
    const actualRevision = revisionId('provider-token:m3a-fixture')
    const resources = resourceSession({ 'animations/cybros-cover.m3a': bytes })
    const result = await discoverM3AnimationSidecars({
      baseBytes,
      candidateDiscovery: completedDiscovery(
        'animations/cybros-cover.m3a',
        actualRevision,
        BigInt(bytes.byteLength),
      ),
      resources: resources.port,
      budget,
    })

    expect(result.accepted).toEqual([
      expect.objectContaining({ logicalId: 'animations/cybros-cover.m3a', clips: 1 }),
    ])
    expect(result.discovery).toMatchObject({ complete: true, candidates: 1 })
    expect(resources.releases()).toBe(1)

    const staleResources = resourceSession(
      { 'animations/cybros-cover.m3a': bytes },
      { revision: 'provider-token:actual' },
    )
    const stale = await discoverM3AnimationSidecars({
      baseBytes,
      candidateDiscovery: completedDiscovery(
        'animations/cybros-cover.m3a',
        revisionId('provider-token:expected'),
        BigInt(bytes.byteLength),
      ),
      resources: staleResources.port,
      budget,
    })
    expect(stale.accepted).toEqual([])
    expect(stale.diagnostics.map(item => item.code)).toContain('x3.m3/m3a-sidecar-stale')
    expect(staleResources.releases()).toBe(1)
  })

  it('does not open resources after refused or empty discovery', async () => {
    const bytes = await fixture()
    const baseBytes = algorithmicBase(bytes)
    const resources = resourceSession({ 'animations/cybros-cover.m3a': bytes })
    const refused = await discoverM3AnimationSidecars({
      baseBytes,
      candidateDiscovery: {
        async discover() {
          return {
            state: 'refused',
            reason: 'budget-exceeded',
            message: 'bounded discovery stopped',
            candidates: [],
            receipt: {
              complete: false,
              pages: 1,
              entries: 2,
              candidates: 0,
              bytes: 0n,
              searches: [],
            },
          }
        },
      },
      resources: resources.port,
      budget,
    })
    expect(refused.accepted).toEqual([])
    expect(refused.diagnostics.map(item => item.code)).toEqual([
      'x3.m3/m3a-discovery-budget-exceeded',
    ])
    expect(resources.port.provenance()).toEqual([])

    const empty = await discoverM3AnimationSidecars({
      baseBytes,
      candidateDiscovery: {
        async discover() {
          return {
            state: 'complete',
            candidates: [],
            receipt: {
              complete: true,
              pages: 1,
              entries: 0,
              candidates: 0,
              bytes: 0n,
              searches: [],
            },
          }
        },
      },
      resources: resources.port,
      budget,
    })
    expect(empty.accepted).toEqual([])
    expect(empty.diagnostics.map(item => item.code)).toEqual(['x3.m3/m3a-discovery-empty'])
    expect(resources.port.provenance()).toEqual([])
    expect(resources.releases()).toBe(0)

    const inconsistent = await discoverM3AnimationSidecars({
      baseBytes,
      candidateDiscovery: {
        async discover() {
          return {
            state: 'complete',
            candidates: [
              {
                logicalId: 'animations/cybros-cover.m3a',
                expectedRevision: revisionId('provider-token:m3a-fixture'),
                size: BigInt(bytes.byteLength),
                rootId: 'test-root',
              },
            ],
            receipt: {
              complete: false,
              pages: 1,
              entries: 1,
              candidates: 0,
              bytes: 0n,
              searches: [],
            },
          }
        },
      },
      resources: resources.port,
      budget,
    })
    expect(inconsistent.accepted).toEqual([])
    expect(inconsistent.diagnostics.map(item => item.code)).toEqual([
      'x3.m3/m3a-discovery-namespace-invalid',
    ])
    expect(resources.port.provenance()).toEqual([])
  })

  it('names missing, wrong-hash and stale sidecars without attaching them', async () => {
    const bytes = await fixture()
    const baseBytes = algorithmicBase(bytes)
    const hash = Buffer.from([0x34, 0x7b, 0x61, 0xdf])
    const wrong = Uint8Array.from(bytes)
    const hashOffset = Buffer.from(wrong).indexOf(hash)
    expect(hashOffset).toBeGreaterThanOrEqual(0)
    wrong[hashOffset] ^= 1

    const wrongResources = resourceSession({ 'animations/wrong.m3a': wrong })
    const wrongResult = await resolveM3AnimationSidecars({
      baseBytes,
      candidates: [{ logicalId: 'animations/wrong.m3a' }],
      resources: wrongResources.port,
      budget,
    })
    expect(wrongResult.accepted).toEqual([])
    expect(wrongResult.diagnostics.map(item => item.code)).toContain(
      'x3.m3/m3a-sidecar-hash-mismatch',
    )

    const staleResources = resourceSession(
      { 'animations/stale.m3a': bytes },
      { revision: 'provider-token:actual' },
    )
    const stale = await resolveM3AnimationSidecars({
      baseBytes,
      candidates: [
        {
          logicalId: 'animations/stale.m3a',
          expectedRevision: revisionId('provider-token:expected'),
        },
      ],
      resources: staleResources.port,
      budget,
    })
    expect(stale.accepted).toEqual([])
    expect(stale.diagnostics.map(item => item.code)).toContain('x3.m3/m3a-sidecar-stale')

    const missingResources = resourceSession({})
    const missing = await resolveM3AnimationSidecars({
      baseBytes,
      candidates: [{ logicalId: 'animations/missing.m3a' }],
      resources: missingResources.port,
      budget,
    })
    expect(missing.accepted).toEqual([])
    expect(missing.diagnostics.map(item => item.code)).toContain('x3.m3/m3a-sidecar-unavailable')
  })

  it('fails closed on cancellation and names byte-budget exhaustion', async () => {
    const bytes = await fixture()
    const baseBytes = algorithmicBase(bytes)
    const cancelled = new AbortController()
    cancelled.abort()
    const resources = resourceSession({ 'animations/cybros-cover.m3a': bytes })
    await expect(
      resolveM3AnimationSidecars({
        baseBytes,
        candidates: [{ logicalId: 'animations/cybros-cover.m3a' }],
        resources: resources.port,
        budget,
        signal: cancelled.signal,
      }),
    ).rejects.toMatchObject({ code: CANCELLED_CODE })

    const bounded = await resolveM3AnimationSidecars({
      baseBytes,
      candidates: [{ logicalId: 'animations/cybros-cover.m3a' }],
      resources: resources.port,
      budget: { ...budget, maxInputBytes: 16n },
    })
    expect(bounded.accepted).toEqual([])
    expect(bounded.diagnostics.map(item => item.code)).toContain(
      'x3.m3/m3a-sidecar-budget-exceeded',
    )
    expect(resources.releases()).toBe(1)
  })
})
