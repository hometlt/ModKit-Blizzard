import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const extension = join(import.meta.dirname, '..')
const codec = (await import(pathToFileURL(join(extension, 'src', 'm3', 'codec.js')).href)) as {
  createCodec: (context: unknown) => unknown
}

const budget = {
  maxInputBytes: 10n ** 9n,
  maxDepth: 128,
  maxNodes: 4_000_000,
  maxScalarBytes: 2 * 10 ** 8,
  maxDiagnostics: 500,
}

const context = {
  budgets: budget,
  diagnostics: { report: () => undefined },
  contracts: {
    async resolve() {
      throw new Error('no service is needed')
    },
    async resolveUnknown() {
      throw new Error('no service is needed')
    },
  },
}

function input(bytes: Uint8Array) {
  const uri = 'memory://model.m3'
  const revision = 'content-hash.sha256:model'
  const value = {
    kind: 'bytes',
    ref: { id: uri, uri },
    revision,
    size: BigInt(bytes.byteLength),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  return {
    originKind: 'single',
    bindings: [
      {
        sourceKind: 'candidate',
        bindingId: 'content',
        role: 'content',
        ownership: 'owned',
        source: value.ref,
        revision,
      },
    ],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single',
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: uri,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value, async release() {} }
    },
  }
}

interface Session {
  dataSource: (
    contract: string,
    major: number,
  ) => Promise<{ value: never; release: () => Promise<void> }>
  dispose: () => Promise<void>
}

/**
 * Real StarCraft II models from the installed game.
 *
 * The pylon death model is the one in this corpus that declares lights and rigid bodies at once;
 * the portrait declares cameras. A synthetic M3 would only prove the projection against itself.
 */
const installed = 'C:/Apps/StarCraft II/Maps/all-races-coop-maps/21-LosingMemories.SC2Map/Assets'
const PYLON = `${installed}/Buildings/Protoss/NerazimPylonDeath/NerazimPylonDeath.m3`
const PORTRAIT = `${installed}/Portraits/Protoss/KrythkalPortrait/KrythkalPortrait.m3`

async function open(path: string): Promise<Session> {
  return (
    codec.createCodec(context) as {
      open: (input: unknown, mode: string, budget: unknown) => Promise<Session>
    }
  ).open(input(new Uint8Array(readFileSync(path))), 'inspect', budget)
}

async function facet<T>(session: Session, contract: string, method: string) {
  const lease = await session.dataSource(`common.view/${contract}`, 1)
  const source = lease.value as never as Record<string, (...args: never[]) => Promise<unknown>>
  const info = (await source['info']!()) as Record<string, unknown>
  const page = (await source[method]!({ limit: 128 } as never)) as { items: readonly T[] }
  await lease.release()
  return { info, items: page.items }
}

const describeInstalled = existsSync(PYLON) ? describe : describe.skip

describeInstalled('M3 runtime facets', () => {
  it('publishes lights with their colour and the node they hang on', async () => {
    const session = await open(PYLON)
    const { info, items } = await facet<{
      id: string
      kind: string
      name?: string
      nodeId?: string
      color?: readonly number[]
      intensity?: number
      properties?: readonly { key: string; value: unknown }[]
    }>(session, 'model-light-source', 'lights')
    expect(info['lights']).toBeGreaterThan(0)
    const light = items[0]!
    // The kind is the model's own word, not a number a consumer would have to decode.
    expect(light.kind).toMatch(/^[a-z-]+$/u)
    expect(light.nodeId).toMatch(/^bone\/\d+$/u)
    expect(light.color).toHaveLength(3)
    // Colour and intensity are typed because every light model in this family states them; the
    // rest — decay, hotspot, falloff — stays in the model's own words.
    expect((light.properties ?? []).length).toBeGreaterThan(0)
    expect((light.properties ?? []).map(one => one.key)).not.toContain('color')
    await session.dispose()
  })

  it('publishes simulation bodies and the shapes that belong to them', async () => {
    const session = await open(PYLON)
    const { info, items } = await facet<{ id: string; kind: string; shape?: string }>(
      session,
      'model-physics-source',
      'bodies',
    )
    expect(info['bodies']).toBeGreaterThan(0)
    const kinds = new Set(items.map(item => item.kind))
    expect(kinds).toContain('rigid-body')
    // A shape's id names the body it belongs to, so the two can be joined without a second facet.
    const shape = items.find(item => item.kind === 'shape')
    if (shape !== undefined) {
      const owner = shape.id.slice(0, shape.id.indexOf('-shape-'))
      expect(items.some(item => item.id === owner && item.kind === 'rigid-body')).toBe(true)
    }
    await session.dispose()
  })

  it('publishes cameras with a field of view a consumer can act on', async () => {
    const session = await open(PORTRAIT)
    const { info, items } = await facet<{
      id: string
      name?: string
      nodeId?: string
      fieldOfViewRadians?: number
    }>(session, 'model-camera-source', 'cameras')
    expect(info['cameras']).toBeGreaterThan(0)
    const camera = items[0]!
    expect(camera.name).toBeTypeOf('string')
    expect(camera.nodeId).toMatch(/^bone\/\d+$/u)
    // Radians, so a viewer never has to guess which unit the format wrote.
    expect(camera.fieldOfViewRadians).toBeGreaterThan(0)
    expect(camera.fieldOfViewRadians).toBeLessThan(Math.PI)
    await session.dispose()
  })

  it('publishes the behaviours an engine drives on its own', async () => {
    const session = await open(PORTRAIT)
    const { info, items } = await facet<{
      id: string
      kind: string
      nodeId?: string
      nodeIds?: readonly string[]
    }>(session, 'model-node-behaviour-source', 'behaviours')
    expect(info['behaviours']).toBeGreaterThan(0)
    for (const behaviour of items) {
      expect(['turret', 'ik', 'billboard']).toContain(behaviour.kind)
      expect(behaviour.id.startsWith(behaviour.kind)).toBe(true)
      // Whatever it drives is addressable in the scene's own node space.
      for (const nodeId of behaviour.nodeIds ?? []) expect(nodeId).toMatch(/^bone\/\d+$/u)
    }
    await session.dispose()
  })
})
