import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TRUSTED_IN_PROCESS_EXECUTION_BACKEND,
  buildInventory,
  createBundledServiceDefinitionRegistry,
  createExecutionBackendRegistry,
  createHostContributionContractRegistry,
  registerServiceDefinitionsOrThrow,
} from '@modkit/host'
import { openRuntimeSession } from '@modkit/host/runtime'
import { loadExtensionDirectory } from '@modkit/host/node'
import { proves, runRuntimeSessionV2Conformance } from '@modkit/testkit'
import type {
  ArtifactByteSource,
  ArtifactSource,
  InputSearchScope,
  Lease,
  ResourceSessionPort,
} from '@modkit/sdk'
import { revisionId } from '@modkit/sdk'
import type { RuntimeSessionV2 } from '@modkit/sdk/runtime'
import type {
  CompanionOrigin,
  CompanionOriginEntry,
} from './support/input-resolution.js'
import { createResourceSession } from './support/resource-session.js'

const repoRoot = join(import.meta.dirname, '..', '..')
const extensionRoot = join(repoRoot, 'starcraft2')
const fixtureRoot = join(import.meta.dirname, 'fixtures')
const runtimeId = 'blizzard.starcraft2.galaxy-pure-bounded-v1'
const activationBudget = {
  maxInputBytes: 1_000_000n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 1_000_000,
  maxDiagnostics: 100,
}
const sessionBudget = { maxWallTimeMs: 100, maxTicks: 1_000, maxMemoryBytes: 1_000_000 }

interface OriginHarness {
  readonly origin: CompanionOrigin
  readonly opened: () => number
  readonly released: () => number
  readonly outstanding: () => number
}

function memoryOrigin(
  files: Readonly<Record<string, string>>,
  failLogicalId?: string,
  omitSizes = false,
): OriginHarness {
  const contents = new Map(
    Object.entries(files).map(([logicalId, text]) => [logicalId, new TextEncoder().encode(text)]),
  )
  let opened = 0
  let released = 0
  const origin: CompanionOrigin = Object.freeze({
    primaryLogicalId: 'MapScript.galaxy',
    caseSensitivity: 'sensitive',
    scopes: Object.freeze(['current-mount'] as const),
    async *enumerate(
      scope: InputSearchScope,
      options: { readonly prefix: string },
    ): AsyncIterable<CompanionOriginEntry> {
      if (scope !== 'current-mount') return
      for (const [logicalId, bytes] of contents) {
        if (logicalId.startsWith(options.prefix)) {
          yield { logicalId, ...(omitSizes ? {} : { size: BigInt(bytes.byteLength) }) }
        }
      }
    },
    async open(logicalId: string): Promise<Lease<ArtifactSource>> {
      const bytes = contents.get(logicalId)
      if (bytes === undefined) throw new Error(`missing fixture ${logicalId}`)
      opened += 1
      let live = true
      const source: ArtifactByteSource = Object.freeze({
        kind: 'bytes',
        ref: { id: `memory://sc2-runtime/${logicalId}`, uri: `memory://sc2-runtime/${logicalId}` },
        revision: revisionId(`content-hash.sha256:${logicalId}`),
        ...(omitSizes ? {} : { size: BigInt(bytes.byteLength) }),
        async read(offset: bigint, length: number) {
          return bytes.slice(Number(offset), Number(offset) + length)
        },
        async *stream() {
          if (logicalId === failLogicalId) throw new Error('fixture stream failed')
          yield bytes
        },
      })
      return Object.freeze({
        value: source,
        async release() {
          if (!live) return
          live = false
          released += 1
        },
      })
    },
  })
  return {
    origin,
    opened: () => opened,
    released: () => released,
    outstanding: () => opened - released,
  }
}

async function services() {
  const extension = await loadExtensionDirectory(extensionRoot)
  const inventory = await buildInventory(
    [{ ...extension, execution: { origin: 'bundled', allowTrustedInProcess: true } }],
    createHostContributionContractRegistry(),
  )
  const serviceDefinitions = createBundledServiceDefinitionRegistry()
  await registerServiceDefinitionsOrThrow(inventory, serviceDefinitions)
  return {
    inventory,
    target: {
      environment: 'node' as const,
      operatingSystem: 'windows' as const,
      architecture: 'x64' as const,
    },
    executionBackends: createExecutionBackendRegistry([TRUSTED_IN_PROCESS_EXECUTION_BACKEND]),
    serviceDefinitions,
  }
}

function resourceSession(harness: OriginHarness): ResourceSessionPort {
  return createResourceSession({
    origin: harness.origin,
    revision: revisionId('provider-token:sc2-runtime-bounded'),
    sessionId: `sc2-runtime-resources-${Math.random()}`,
  })
}

async function openSc2(
  resources: ResourceSessionPort,
  sessionId: string,
  inputs = [
    {
      id: 'map-script',
      kind: 'source' as const,
      logicalId: 'MapScript.galaxy',
      scopes: ['current-mount'] as const,
      maxBytes: 64 * 1024,
    },
    {
      id: 'triggers',
      kind: 'trigger' as const,
      logicalId: 'Triggers',
      scopes: ['current-mount'] as const,
      maxBytes: 64 * 1024,
    },
  ],
  budget = sessionBudget,
) {
  return openRuntimeSession({
    services: await services(),
    runtimeId,
    sessionId,
    budget,
    grant: { id: `sc2-runtime-${sessionId}`, classes: [] },
    activationBudget,
    providerInvocation: { resources, inputs },
  })
}

const galaxy = await readFile(join(fixtureRoot, 'bounded.galaxy'), 'utf8')
const triggers =
  '<TriggerData><Library Id="Native"><Element Id="A" Type="Function" /></Library></TriggerData>'

describe('Block 15G bounded SC2 runtime provider', () => {
  it('resolves through common.runtime, executes the named pure subset and refuses native/tool paths', async () => {
    const harness = memoryOrigin({ 'MapScript.galaxy': galaxy, Triggers: triggers })
    const resources = resourceSession(harness)
    const resolution = await openSc2(resources, 'bounded-execution')
    expect(resolution.state).toBe('resolved')
    if (resolution.state !== 'resolved') return
    try {
      expect(harness.opened()).toBe(2)
      expect(harness.released()).toBe(2)
      expect(harness.outstanding()).toBe(0)
      expect(resources.state()).toBe('live')
      await expect(
        resolution.session.execute({
          entrypoint: 'NestedAnswer',
          resources: { wallTimeMs: 1, ticks: 2, memoryBytes: 0 },
        }),
      ).resolves.toMatchObject({ state: 'completed', value: 42 })
      await expect(
        resolution.session.execute({
          entrypoint: 'NativeMain',
          resources: { wallTimeMs: 1, ticks: 1, memoryBytes: 0 },
        }),
      ).resolves.toMatchObject({ state: 'refused', reason: 'native-unavailable' })
      await expect(
        resolution.session.execute({
          entrypoint: 'launch',
          resources: { wallTimeMs: 1, ticks: 1, memoryBytes: 0 },
        }),
      ).resolves.toMatchObject({ state: 'refused', reason: 'entrypoint-unavailable' })
      expect(harness.outstanding()).toBe(0)
      const events = []
      for await (const event of (resolution.session as RuntimeSessionV2).events())
        events.push(event)
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'sc2.source.loaded',
            data: expect.objectContaining({ nativeAuthority: true, portableUvArtifact: false }),
          }),
          expect.objectContaining({
            kind: 'sc2.trigger.loaded',
            data: expect.objectContaining({ lowering: 'unavailable' }),
          }),
        ]),
      )
      proves({
        capabilityId: 'format/sc2-runtime/open-inspect',
        operation: 'inspect',
        note: 'service-resolved bounded Galaxy execution plus explicit native/launch refusal and native source/trigger facets',
      })
    } finally {
      await resolution.release()
      await resources.dispose()
    }
  })

  it('passes the frozen v2 deterministic step/snapshot/restore/hash conformance suite', async () => {
    const harness = memoryOrigin({ 'MapScript.galaxy': galaxy, Triggers: triggers })
    const resources = resourceSession(harness)
    const resolutions: { readonly release: () => Promise<void> }[] = []
    try {
      const report = await runRuntimeSessionV2Conformance({
        openSession: async () => {
          const resolution = await openSc2(resources, `conformance-${resolutions.length}`)
          if (resolution.state !== 'resolved') {
            throw new Error(resolution.diagnostics.map(item => item.message).join('; '))
          }
          resolutions.push(resolution)
          return resolution.session as RuntimeSessionV2
        },
        foreignSnapshot: {
          identity: {
            contentDigest: `sha256:${'0'.repeat(64)}`,
            schemaId: 'modkit.test/foreign',
            schemaVersion: 1,
          },
          bytes: new TextEncoder().encode('{}'),
        },
      })
      expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([])
      expect(report.checks).toBeGreaterThanOrEqual(18)
      expect(harness.outstanding()).toBe(0)
    } finally {
      for (const resolution of resolutions.reverse()) await resolution.release()
      await resources.dispose()
    }
  }, 60_000)

  it('releases the ResourceSession lease when source loading fails', async () => {
    const harness = memoryOrigin({ 'MapScript.galaxy': galaxy }, 'MapScript.galaxy')
    const resources = resourceSession(harness)
    try {
      const resolution = await openSc2(resources, 'failed-create', [
        {
          id: 'map-script',
          kind: 'source',
          logicalId: 'MapScript.galaxy',
          scopes: ['current-mount'],
          maxBytes: 64 * 1024,
        },
      ])
      expect(resolution.state).toBe('unresolved')
      expect(harness.opened()).toBe(1)
      expect(harness.released()).toBe(1)
      expect(harness.outstanding()).toBe(0)
    } finally {
      await resources.dispose()
    }
  })

  it('does not execute declarations hidden in comments, strings or nested bodies and refuses lossy literals', async () => {
    const hostile = `
// int Commented() { return 7; }
/* bool AlsoCommented() { return true; } */
string Quoted() { return "int StringHidden() { return 9; }"; }
void Outer() { int Nested() { return 3; } }
fixed Approximate() { return 1.5; }
int Overflow() { return 2147483648; }
int Underflow() { return -2147483649; }
bool WrongType() { return 1; }
int EmptyInt() { }
int WrongCallType() { return TextValue(); }
string TextValue() { return "x"; }
int Minimum() { return -2147483648; }
`
    const harness = memoryOrigin({ 'MapScript.galaxy': hostile })
    const resources = resourceSession(harness)
    const resolution = await openSc2(resources, 'hostile-source', [
      {
        id: 'hostile-source',
        kind: 'source',
        logicalId: 'MapScript.galaxy',
        scopes: ['current-mount'],
        maxBytes: 64 * 1024,
      },
    ])
    expect(resolution.state).toBe('resolved')
    if (resolution.state !== 'resolved') return
    const execute = (entrypoint: string) =>
      resolution.session.execute({
        entrypoint,
        resources: { wallTimeMs: 1, ticks: 0, memoryBytes: 0 },
      })
    try {
      await expect(execute('Quoted')).resolves.toMatchObject({
        state: 'completed',
        value: 'int StringHidden() { return 9; }',
      })
      await expect(execute('Minimum')).resolves.toMatchObject({
        state: 'completed',
        value: -2_147_483_648,
      })
      for (const hidden of ['Commented', 'AlsoCommented', 'StringHidden', 'Nested']) {
        await expect(execute(hidden)).resolves.toMatchObject({
          state: 'refused',
          reason: 'entrypoint-unavailable',
        })
      }
      for (const lossy of [
        'Outer',
        'Approximate',
        'Overflow',
        'Underflow',
        'WrongType',
        'EmptyInt',
        'WrongCallType',
      ]) {
        await expect(execute(lossy)).resolves.toMatchObject({
          state: 'refused',
          reason: 'unsupported-runtime-subset',
        })
      }
    } finally {
      await resolution.release()
      await resources.dispose()
    }
  })

  it('rejects duplicate inputs before opening and releases a cumulative streaming overrun', async () => {
    const duplicateHarness = memoryOrigin({ 'MapScript.galaxy': galaxy })
    const duplicateResources = resourceSession(duplicateHarness)
    try {
      const resolution = await openSc2(duplicateResources, 'duplicate-input', [
        {
          id: 'same',
          kind: 'source',
          logicalId: 'MapScript.galaxy',
          scopes: ['current-mount'],
          maxBytes: 64 * 1024,
        },
        {
          id: 'same',
          kind: 'trigger',
          logicalId: 'MapScript.galaxy',
          scopes: ['current-mount'],
          maxBytes: 64 * 1024,
        },
      ])
      expect(resolution.state).toBe('unresolved')
      expect(duplicateHarness.opened()).toBe(0)
    } finally {
      await duplicateResources.dispose()
    }

    const largeGalaxy = `${galaxy}\n// ${'x'.repeat(700)}`
    const overrunHarness = memoryOrigin({ 'MapScript.galaxy': largeGalaxy }, undefined, true)
    const overrunResources = resourceSession(overrunHarness)
    try {
      const resolution = await openSc2(
        overrunResources,
        'stream-overrun',
        [
          {
            id: 'large-source',
            kind: 'source',
            logicalId: 'MapScript.galaxy',
            scopes: ['current-mount'],
            maxBytes: 64 * 1024,
          },
        ],
        { maxWallTimeMs: 10, maxTicks: 10, maxMemoryBytes: 512 },
      )
      expect(resolution.state).toBe('unresolved')
      expect(overrunHarness.opened()).toBe(1)
      expect(overrunHarness.released()).toBe(1)
      expect(overrunHarness.outstanding()).toBe(0)
    } finally {
      await overrunResources.dispose()
    }
  })

  it('charges retained events and refuses hostile snapshots without mutating state', async () => {
    const harness = memoryOrigin({ 'MapScript.galaxy': galaxy, Triggers: triggers })
    const resources = resourceSession(harness)
    const resolution = await openSc2(resources, 'bounded-restore')
    expect(resolution.state).toBe('resolved')
    if (resolution.state !== 'resolved') return
    const session = resolution.session as RuntimeSessionV2
    try {
      await expect(
        session.execute({
          entrypoint: 'NestedAnswer',
          resources: { wallTimeMs: 1, ticks: 2, memoryBytes: 3 },
        }),
      ).resolves.toMatchObject({ state: 'completed', value: 42 })
      const before = await session.stateHash()
      await expect(session.step(4_096)).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'budget-exceeded',
      })
      expect(await session.stateHash()).toEqual(before)

      const captured = await session.snapshot()
      if (captured.outcome !== 'captured') throw new Error('bounded snapshot was not captured')
      const parsed = JSON.parse(new TextDecoder().decode(captured.snapshot.bytes)) as Record<
        string,
        unknown
      >
      const forgedBytes = new TextEncoder().encode(JSON.stringify({ ...parsed, attacker: true }))
      const forgedDigest = `sha256:${createHash('sha256').update(forgedBytes).digest('hex')}`
      await expect(
        session.restore({
          identity: { ...captured.snapshot.identity, contentDigest: forgedDigest },
          bytes: forgedBytes,
        }),
      ).resolves.toMatchObject({ outcome: 'refused', reason: 'schema-mismatch' })
      expect(await session.stateHash()).toEqual(before)

      const fabricated = structuredClone(parsed) as {
        calls: { value: unknown }[]
      } & Record<string, unknown>
      const fabricatedCall = fabricated.calls[0]
      if (fabricatedCall === undefined) throw new Error('captured runtime call is missing')
      fabricatedCall.value = 99
      const fabricatedBytes = new TextEncoder().encode(JSON.stringify(fabricated))
      await expect(
        session.restore({
          identity: {
            ...captured.snapshot.identity,
            contentDigest: `sha256:${createHash('sha256').update(fabricatedBytes).digest('hex')}`,
          },
          bytes: fabricatedBytes,
        }),
      ).resolves.toMatchObject({ outcome: 'refused', reason: 'schema-mismatch' })
      expect(await session.stateHash()).toEqual(before)

      const oversized = new Uint8Array(sessionBudget.maxMemoryBytes + 1)
      await expect(
        session.restore({
          identity: {
            ...captured.snapshot.identity,
            contentDigest: `sha256:${createHash('sha256').update(oversized).digest('hex')}`,
          },
          bytes: oversized,
        }),
      ).resolves.toMatchObject({ outcome: 'refused', reason: 'budget-exceeded' })
      expect(await session.stateHash()).toEqual(before)
    } finally {
      await resolution.release()
      await resources.dispose()
    }
  })
})
