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
  openNestedSubject,
  openSubject,
} from '@modkit/host'
import { createNodeInstallationProbes, loadExtensionDirectory } from '@modkit/host/node'
import {
  revisionId,
  type ArtifactByteSource,
  type ModelAnimationSource,
  type ModelSceneSource,
  type ResourceBudget,
} from '@modkit/sdk'
import { proves } from '@modkit/testkit'
import { VirtualFileSystem } from '@modkit/vfs'
import { createFileVfsProvider } from '@modkit/vfs/providers/file'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'
import { installM3PlatformAdapters } from '../dist/m3/native/platform.js'
import { decodeM3Animations } from '../src/m3/animation.node.js'
import { buildAnimationM3 } from './fixtures/animation.js'
import { createModelAnimationSampler } from '@modkit/codec-kit/model/animation'
import { findBlizzardExtensionRoot, findModkitCoreWorkspace } from './workspace-root.js'

installM3PlatformAdapters({ DOMParser })

const repoRoot = findModkitCoreWorkspace(import.meta.dirname)
const extensionRoot = findBlizzardExtensionRoot(import.meta.dirname)

async function installedSc2Root(): Promise<string | undefined> {
  const configured = process.env['MODKITX_SC2_ROOT']?.trim()
  const { discoverStarcraft2Installations } = (await import(
    pathToFileURL(
      join(
        extensionRoot,
        'starcraft2',
        'modules',
        'game',
        'providers',
        'installation',
        'provider.js',
      ),
    ).href
  )) as {
    readonly discoverStarcraft2Installations: (request: {
      readonly gameId: string
      readonly configuredPaths?: readonly string[]
      readonly maxCandidates: number
    }, probes?: unknown) => Promise<{
      readonly installations: readonly { readonly normalizedPath: string }[]
    }>
  }
  const result = await discoverStarcraft2Installations({
    gameId: 'blizzard/starcraft-2',
    ...(configured === undefined || configured.length === 0
      ? {}
      : { configuredPaths: [configured] }),
    maxCandidates: 128,
  }, createNodeInstallationProbes())
  return result.installations[0]?.normalizedPath
}

const logicalId =
  'campaigns/liberty.sc2campaign/base.sc2assets/assets/campaign/terran/artifact1/artifact1.m3'
const target = { environment: 'node', operatingSystem: 'windows', architecture: 'x64' } as const
const grant = { id: 'm3-animation-preflight', classes: ['read-source'] } as const
const TEST_PATH = 'extensions/blizzard/models/test/m3-animation.test.ts'
const MODEL_BYTES = 60_128
const MODEL_SHA256 = 'fb7680019ca7ec88aeb37591a7477c2555dd674d57f0c7486736ccb11919a436'
const PARITY_FIXTURE = join(
  repoRoot,
  'packages',
  'testkit',
  'test',
  'fixtures',
  'models',
  'triangle.m3',
)
const PARITY_FIXTURE_SHA256 = 'd34480c1b726c37bfeea9dd75fc71a13ca7e47d6ff15b2d66487c6a4b3369de7'
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

async function inventory() {
  const inputs = await Promise.all(
    [['casc'], ['models']].map(async parts => ({
      ...(await loadExtensionDirectory(join(extensionRoot, ...parts))),
      execution: { origin: 'bundled' as const, allowTrustedInProcess: true },
    })),
  )
  return buildInventory(inputs, createHostContributionContractRegistry())
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
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
  return new TextDecoder('utf-8', { fatal: true }).decode(
    zero < 0 ? bytes : bytes.subarray(0, zero),
  )
}

function proveAnimation(note: string): void {
  proves({ contributionId: 'blizzard/m3', operation: 'inspect', test: TEST_PATH, note })
}

function changeRepetitions(
  bytes: Uint8Array,
  sectionIndex: number,
  repetitions: number,
): Uint8Array {
  const changed = bytes.slice()
  const view = new DataView(changed.buffer)
  const indexOffset = view.getUint32(4, true)
  view.setUint32(indexOffset + sectionIndex * 16 + 8, repetitions, true)
  return changed
}

async function openMemory(bytes: Uint8Array) {
  const uri = 'memory://m3-animation/fixture.m3'
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

describe('M3 SEQS/STC decoding', () => {
  it('publishes the driven channel without duplicating the skeleton rest pose', async () => {
    const decoded = await decodeM3Animations(await buildAnimationM3(), budget)
    expect(decoded).toMatchObject({
      declaredSequences: 1,
      fatal: false,
      supportedChannels: 1,
      unsupportedChannels: 0,
      rejectedTargets: 0,
    })
    expect(decoded.clips).toEqual([
      {
        id: 'm3-sequence-0',
        name: 'Walk',
        kind: 'animation',
        provenance: 'direct',
        frames: 2,
        hierarchyId: 'm3/bone-table',
        nativeTimeBounds: { startMilliseconds: 100, endMilliseconds: 220 },
        durationSeconds: 0.12,
        looping: true,
        // SEQS ms_blend and the one STC's priority (plan П16).
        blendInSeconds: expect.any(Number),
        priority: 0,
        boundsSphere: { center: [0, 0, 0], radius: 0 },
        channels: [
          {
            target: 'bone/0',
            kind: 'translation',
            firstFrame: 0,
            lastFrame: 1,
            interpolation: 'linear',
            samples: [
              { frame: 0, timeSeconds: 0, timeMilliseconds: 100, value: [0, 1, 2] },
              { frame: 1, timeSeconds: 0.12, timeMilliseconds: 220, value: [1, 2, 3] },
            ],
          },
        ],
      },
    ])
    expect(decoded.clips[0]).not.toHaveProperty('frameRate')
    expect(decoded.timelineContainers).toEqual([
      { index: 0, name: 'Walk_full', channels: 1, unsupportedChannels: 0, frames: 2 },
    ])
    proveAnimation('SEQS bounds and an STS-validated STC id publish one explicit BONE channel')
  })

  it('preserves unwrapped SDFG uint32 keys as source-free residual animation', async () => {
    const decoded = await decodeM3Animations(
      await buildAnimationM3({ residualFlagValues: [0, 0xffff_ffff] }),
      budget,
    )
    expect(decoded).toMatchObject({
      fatal: false,
      supportedChannels: 1,
      unsupportedChannels: 0,
      unsupportedChannelReasons: {},
      unsupportedChannelDataKinds: {},
    })
    expect(decoded.residualAnimationTracks).toContainEqual(
      expect.objectContaining({
        sequenceIndex: 0,
        stcOrder: 0,
        animId: 0x1020_3041,
        sdField: 'sdfg',
        frames: [100, 220],
        values: [0, 0xffff_ffff],
      }),
    )
    proveAnimation('FLAG sections decode as bounded uint32 SDFG residual keys')
  })

  it('publishes the animation source with decoded keyframes', async () => {
    const opened = await openMemory(await buildAnimationM3())
    expect(opened.state).toBe('opened')
    if (opened.state !== 'opened') return
    try {
      const descriptor = await opened.session.descriptor()
      expect(descriptor.dataSources).toContainEqual(
        expect.objectContaining({ contract: 'common.view/model-animation-source', major: 1 }),
      )
      const lease = await opened.session.dataSource('common.view/model-animation-source', 1)
      try {
        const source = lease.value as ModelAnimationSource
        expect(await source.info()).toEqual({ clips: 1, channelled: 1, companionBound: 0 })
        const first = await source.clips({ limit: 1 })
        expect(first.items).toHaveLength(1)
        expect(first.nextCursor).toBeUndefined()
        expect(first.items[0]?.channels[0]).toMatchObject({
          target: 'bone/0',
          kind: 'translation',
          samples: [
            { frame: 0, timeMilliseconds: 100, value: [0, 1, 2] },
            { frame: 1, timeMilliseconds: 220, value: [1, 2, 3] },
          ],
        })
      } finally {
        await lease.release()
      }
      const receipt = descriptor.metadata.find(group => group.id === 'uv-projection-receipt')
        ?.entries[0]?.value as
        | { readonly planes: readonly { readonly planeId: string; readonly state: string }[] }
        | undefined
      expect(receipt?.planes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ planeId: 'animation', state: 'normalized' }),
          expect.objectContaining({ planeId: 'animation-bone-targets', state: 'normalized' }),
          expect.objectContaining({ planeId: 'animation-native-time-bounds', state: 'preserved' }),
          expect.objectContaining({ planeId: 'animation-sd-keyframes', state: 'preserved' }),
        ]),
      )
      proveAnimation('the host publishes paged clips with finite SD timestamps and vector values')
    } finally {
      await opened.session.dispose()
    }
  })

  it.each([
    ['SEQS', 2, 'x3.m3/animation-seqs-truncated'],
    ['STC_', 4, 'x3.m3/animation-stc-truncated'],
  ] as const)('names a truncated %s table before schema parsing', async (_tag, section, code) => {
    const bytes = changeRepetitions(await buildAnimationM3(), section, 2)
    const decoded = await decodeM3Animations(bytes, budget)
    expect(decoded).toMatchObject({ fatal: true, clips: [] })
    expect(decoded.issues).toContainEqual(expect.objectContaining({ code }))
    if (_tag === 'SEQS') {
      const opened = await openMemory(bytes)
      expect(opened.state).toBe('opened')
      if (opened.state === 'opened') {
        try {
          const descriptor = await opened.session.descriptor()
          const counters = Object.fromEntries(
            descriptor.metadata
              .filter(group => ['m3-container', 'm3-animation', 'm3-materials'].includes(group.id))
              .flatMap(group => group.entries.map(entry => [entry.key, entry.value])),
          )
          expect(counters.counterState).toBe('unavailable')
          expect(counters).not.toHaveProperty('counterSemantics')
        } finally {
          await opened.session.dispose()
        }
      }
    }
    proveAnimation(
      `${_tag} truncation is a coded refusal before the schema parser allocates records`,
    )
  })

  it('drops invalid SEQS bounds instead of inventing a duration', async () => {
    const bytes = await buildAnimationM3({ start: 500, end: 100 })
    const decoded = await decodeM3Animations(bytes, budget)
    expect(decoded).toMatchObject({ fatal: false, clips: [], invalidBounds: 1 })
    expect(decoded.issues).toContainEqual(
      expect.objectContaining({ code: 'x3.m3/animation-bounds-refused' }),
    )
    const opened = await openMemory(bytes)
    expect(opened.state).toBe('opened')
    if (opened.state === 'opened') {
      try {
        expect((await opened.session.descriptor()).dataSources).not.toContainEqual(
          expect.objectContaining({ contract: 'common.view/model-animation-source' }),
        )
      } finally {
        await opened.session.dispose()
      }
    }
    proveAnimation('an end-before-start SEQS range is refused rather than normalized or clamped')
  })

  it('does not invent a channel when STS cannot resolve the bone reference', async () => {
    const decoded = await decodeM3Animations(
      await buildAnimationM3({ stcAnimId: 0x1020_3040, boneAnimId: 0x1020_3041 }),
      budget,
    )
    expect(decoded.clips[0]).toMatchObject({ kind: 'animation', frames: 0 })
    expect(decoded).toMatchObject({ supportedChannels: 0, unsupportedChannels: 0, rejectedTargets: 0 })
    expect(createModelAnimationSampler(decoded.clips[0]).sample(10)).toEqual([])
    expect(decoded.issues).not.toContainEqual(
      expect.objectContaining({ code: 'x3.m3/animation-channels-partial' }),
    )
    proveAnimation(
      'unresolved animation ids stay out of the animation facet; the skeleton owns the rest pose',
    )
  })

  it('allows two explicit bone references to share the same animation id, as MK2 does', async () => {
    const decoded = await decodeM3Animations(await buildAnimationM3({ sharedTarget: true }), budget)
    expect(decoded).toMatchObject({
      supportedChannels: 2,
      unsupportedChannels: 0,
      rejectedTargets: 0,
    })
    const values = createModelAnimationSampler(decoded.clips[0])
      .sample(0.06)
      .filter(channel => channel.kind === 'translation')
    expect(values).toEqual([
      { target: 'bone/0', kind: 'translation', value: [0.5, 1.5, 2.5] },
      { target: 'bone/1', kind: 'translation', value: [0.5, 1.5, 2.5] },
    ])
    proveAnimation(
      'shared ids drive both explicitly referencing bones without any target-name inference',
    )
  })

  it('uses STG order and per-STC STS membership instead of priority or a merged membership set', async () => {
    const secondStcValues = [
      [20, 30, 40],
      [40, 50, 60],
    ] as const
    const first = await decodeM3Animations(await buildAnimationM3({ secondStcValues }), budget)
    const fallback = await decodeM3Animations(
      await buildAnimationM3({ secondStcValues, firstStsEmpty: true }),
      budget,
    )
    expect(createModelAnimationSampler(first.clips[0]).sample(0.06)[0].value).toEqual([
      0.5, 1.5, 2.5,
    ])
    expect(createModelAnimationSampler(fallback.clips[0]).sample(0.06)[0].value).toEqual([
      30, 40, 50,
    ])
  })

  it('samples window boundaries and concurrent clocks without discarding outside-window source keys', async () => {
    const windowed = await decodeM3Animations(
      await buildAnimationM3({
        frameTicks: [0, 300],
        keyValues: [
          [0, 0, 0],
          [3, 6, 9],
        ],
      }),
      budget,
    )
    expect(windowed.fatal).toBe(false)
    const sampler = createModelAnimationSampler(windowed.clips[0])
    expect(sampler.sample(0)[0].value).toEqual([1, 2, 3])
    expect(sampler.sample(0.12)[0].value[0]).toBeCloseTo(2.2, 12)
    const concurrent = await decodeM3Animations(
      await buildAnimationM3({
        concurrent: true,
        wrapMs: 1000,
        frameTicks: [0, 1000],
        keyValues: [
          [0, 0, 0],
          [10, 20, 30],
        ],
      }),
      budget,
    )
    expect(concurrent.clips[0].channels[0]).toMatchObject({ concurrent: true, wrapSeconds: 1 })
    expect(createModelAnimationSampler(concurrent.clips[0]).sample(2.5)[0].value).toEqual([
      5, 10, 15,
    ])
  })

  it('publishes no animation facet when MODL declares no SEQS records', async () => {
    const bytes = await buildAnimationM3({ emptySequences: true })
    expect(await decodeM3Animations(bytes, budget)).toMatchObject({
      declaredSequences: 0,
      clips: [],
      fatal: false,
    })
    const opened = await openMemory(bytes)
    expect(opened.state).toBe('opened')
    if (opened.state !== 'opened') return
    try {
      const descriptor = await opened.session.descriptor()
      expect(descriptor.dataSources).not.toContainEqual(
        expect.objectContaining({ contract: 'common.view/model-animation-source' }),
      )
      const receipt = descriptor.metadata.find(group => group.id === 'uv-projection-receipt')
        ?.entries[0]?.value as
        | { readonly planes: readonly { readonly planeId: string; readonly state: string }[] }
        | undefined
      expect(receipt?.planes).toContainEqual(
        expect.objectContaining({ planeId: 'animation', state: 'lost' }),
      )
      proveAnimation(
        'an empty MODL.sequences reference publishes neither an empty facet nor a clip',
      )
    } finally {
      await opened.session.dispose()
    }
  })

  it('fails closed on maxNodes and maxScalarBytes before animation publication', async () => {
    const bytes = await buildAnimationM3()
    const nodes = await decodeM3Animations(bytes, { ...budget, maxNodes: 1 })
    const scalar = await decodeM3Animations(bytes, { ...budget, maxScalarBytes: 1 })
    for (const decoded of [nodes, scalar]) {
      expect(decoded).toMatchObject({ fatal: true, clips: [] })
      expect(decoded.issues).toContainEqual(
        expect.objectContaining({ code: 'x3.m3/animation-budget-exceeded' }),
      )
    }
    proveAnimation('animation tables are bounded by maxNodes and maxScalarBytes before parsing')
  })

  it('honours cancellation before parsing', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      decodeM3Animations(await buildAnimationM3(), budget, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    proveAnimation('an already-cancelled animation decode performs no schema work')
  })

  it('separates the pinned declared sequence from executable motion and scene resources', async () => {
    const bytes = new Uint8Array(await readFile(PARITY_FIXTURE))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(PARITY_FIXTURE_SHA256)
    expect(await decodeM3Animations(bytes, budget)).toMatchObject({
      declaredSequences: 1,
      clips: [expect.objectContaining({ kind: 'animation', frames: 0, durationSeconds: 1 })],
      supportedChannels: 0,
      fatal: false,
    })
    const opened = await openMemory(bytes)
    expect(opened.state).toBe('opened')
    if (opened.state !== 'opened') return
    try {
      const descriptor = await opened.session.descriptor()
      const counters = Object.fromEntries(
        descriptor.metadata
          .filter(group => ['m3-container', 'm3-animation', 'm3-materials'].includes(group.id))
          .flatMap(group => group.entries.map(entry => [entry.key, entry.value])),
      )
      expect(counters).toMatchObject({
        counterState: 'complete',
        counterSemantics: 'm3-declared-executable-v1',
        declaredSequences: 1,
        executableClips: 0,
        layerRecords: 18,
        logicalResources: 0,
        meshPartitions: 1,
        meshes: 1,
      })
      const sceneLease = await opened.session.dataSource('common.view/model-scene-source', 1)
      try {
        expect(await (sceneLease.value as ModelSceneSource).info()).toMatchObject({
          animations: 0,
          textures: 0,
          meshes: 1,
        })
      } finally {
        await sceneLease.release()
      }
    } finally {
      await opened.session.dispose()
    }
  })
})

describe.skipIf(process.env.MODKIT_TEST_INSTALLED_CORPUS === '0')(
  'M3 animation corpus stop/go',
  () => {
    it('measures the pinned M3 through the host/CASC route', async ({ skip }) => {
      const sc2Root = await installedSc2Root()
      if (sc2Root === undefined) {
        skip()
        return
      }
      const mount = await new VirtualFileSystem()
        .registerProvider(createFileVfsProvider())
        .openMount(pathToFileURL(sc2Root).href)
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
      if (casc.state !== 'opened') throw new Error(`CASC did not open: ${casc.state}`)
      try {
        const extracted = await casc.session
          .operations()
          .invoke('extract-entry', { entryId: logicalId })
        if (extracted.state !== 'ok' || extracted.output.kind !== 'bytes') {
          throw new Error(`CASC extraction failed for ${logicalId}`)
        }
        const bytes = extracted.output.value
        const xml = await readFile(
          join(extensionRoot, 'models', 'src', 'm3', 'native', 'structures.xml'),
          'utf8',
        )
        const sections = await M3SectionList.load(bufferOf(bytes), xml)
        const sequenceSection = sections.getSectionByReference(sections.model?.sequences)
        const stcSection = sections.getSectionByReference(
          sections.model?.sequence_transformation_collections,
        )
        const stsSection = sections.getSectionByReference(sections.model?.sts)
        const sequences = (sequenceSection?.content ?? []).map(sequence => ({
          name: referencedString(sections, sequence.name),
          start: Number(sequence.anim_ms_start),
          end: Number(sequence.anim_ms_end),
          flags: Number(sequence.flags),
          frequency: Number(sequence.frequency),
        }))
        const stcs = (stcSection?.content ?? []).map(stc => ({
          name: referencedString(sections, stc.name),
          refCount: Number(stc.ref_count),
          animIds: Number(stc.anim_ids?.entries ?? 0),
          animRefs: Number(stc.anim_refs?.entries ?? 0),
          trackContainers: [
            'sdev',
            'sd2v',
            'sd3v',
            'sd4q',
            'sdcc',
            'sdr3',
            'sdu8',
            'sds6',
            'sdu6',
            'sds3',
            'sdu3',
            'sdfg',
            'sdmb',
          ].reduce((sum, key) => sum + Number(stc[key]?.entries ?? 0), 0),
        }))
        const sdFields = [
          'sdev',
          'sd2v',
          'sd3v',
          'sd4q',
          'sdcc',
          'sdr3',
          'sdu8',
          'sds6',
          'sdu6',
          'sds3',
          'sdu3',
          'sdfg',
          'sdmb',
        ] as const
        const sdFrameCounts = (stcSection?.content ?? []).flatMap(stc =>
          sdFields.flatMap(field =>
            (sections.getSectionByReference(stc[field])?.content ?? []).map(sd => ({
              field,
              frames:
                sections.getSectionByReference(sd.frames)?.content.map(value => Number(value)) ??
                [],
            })),
          ),
        )
        const distinctSdFrames = new Set(sdFrameCounts.flatMap(track => track.frames)).size
        const digest = createHash('sha256').update(bytes).digest('hex')
        const decoded = await decodeM3Animations(bytes, budget)
        expect(logicalId).not.toMatch(/^(?:[A-Za-z]:|[\\/]|[a-z][a-z0-9+.-]*:)/u)
        expect(bytes.byteLength).toBe(MODEL_BYTES)
        expect(digest).toBe(MODEL_SHA256)
        expect(sequenceSection?.desc.history.name).toBe('SEQS')
        expect(stcSection?.desc.history.name).toBe('STC_')
        expect(sequences).toEqual([
          { name: 'Stand', start: 0, end: 4000, flags: 0, frequency: 100 },
        ])
        expect(stcs).toEqual([
          {
            name: 'Stand_full',
            refCount: 0,
            animIds: 6,
            animRefs: 6,
            trackContainers: 6,
          },
        ])
        expect(decoded.clips).toHaveLength(1)
        expect(decoded.clips[0]).toMatchObject({
          name: 'Stand',
          kind: 'animation',
          frames: 0,
          channels: [],
        })
        // Static tracks remain native reconstruction residuals; they do not become artificial
        // common animation keys merely to imitate the MK2 render-model shape.
        expect(decoded.residualAnimationTracks.length).toBeGreaterThan(0)
        expect(decoded.clips[0]).not.toHaveProperty('frameRate')
        expect(distinctSdFrames).toBe(110)
        expect(decoded.timelineContainers[0]?.frames).toBe(distinctSdFrames)
        expect(decoded).toMatchObject({
          supportedChannels: 0,
          unsupportedChannels: 0,
          rejectedTargets: 0,
          invalidBounds: 0,
          fatal: false,
        })
        const nested = await openNestedSubject({
          parent: casc.session,
          entryId: logicalId,
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
          const lease = await nested.result.session.dataSource(
            'common.view/model-animation-source',
            1,
          )
          try {
            const source = lease.value as ModelAnimationSource
            expect(await source.info()).toEqual({ clips: 1, channelled: 0, companionBound: 0 })
            const page = await source.clips({ limit: 1 })
            // The host catalog adds the exact combined sequence index used for M3A binding.
            expect(page.items).toEqual([
              expect.objectContaining({
                id: decoded.clips[0]?.id,
                name: 'Stand',
                kind: 'animation',
                channels: [],
                sequenceIndex: 0,
              }),
            ])
            expect(page.nextCursor).toBeUndefined()
          } finally {
            await lease.release()
          }
          const receipt = descriptor.metadata.find(group => group.id === 'uv-projection-receipt')
            ?.entries[0]?.value as
            | { readonly planes: readonly { readonly planeId: string; readonly state: string }[] }
            | undefined
          expect(receipt?.planes).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ planeId: 'animation', state: 'normalized' }),
              expect.objectContaining({ planeId: 'animation-bone-targets', state: 'lost' }),
              expect.objectContaining({
                planeId: 'animation-native-time-bounds',
                state: 'preserved',
              }),
              expect.objectContaining({ planeId: 'animation-sd-keyframes', state: 'lost' }),
            ]),
          )
          expect(JSON.stringify(receipt)).not.toMatch(/(?:[A-Za-z]:[\\/]|file:\/\/|\\\\)/u)
        } finally {
          await nested.result.session.dispose()
        }
        console.info(
          `[sc2-live] ${logicalId}: bytes=${bytes.byteLength}, sha256=${digest}, ` +
            `sequence=Stand, bounds=0..4000ms, stc=Stand_full, refs=6, ` +
            `nativeSampleFrames=${distinctSdFrames}, initialPoseChannels=36, unsupportedChannels=6, ` +
            `sts=${stsSection?.content.length ?? 0}`,
        )
        proveAnimation(
          'the pinned CASC sample retains Stand and its full initial bone pose; six non-BONE STC channels remain explicit unsupported data',
        )
      } finally {
        await casc.session.dispose()
      }
    }, 300_000)
  },
)
