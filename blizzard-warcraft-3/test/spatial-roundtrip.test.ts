import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readUvmContainer, writeUvmContainer } from '@modkit/uv/model/container'
import { exportWar3FromUvm } from '../dist/war3-mdx/native-encoder.js'
import { parse } from '../dist/lib/war3-model/mdx/parse.js'

const extension = join(import.meta.dirname, '..')
const codec = (await import(
  pathToFileURL(join(extension, 'src', 'war3-mdx', 'codec.js')).href
)) as { createCodec: (context: unknown) => unknown }

const budget = {
  maxInputBytes: 10n ** 9n,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxScalarBytes: 64 * 1024 * 1024,
  maxDiagnostics: 200,
}
const containerBudget = {
  maxInputBytes: 10 ** 9,
  maxJsonBytes: 2 * 10 ** 8,
  maxDepth: 128,
  maxNodes: 1_000_000,
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
  const uri = 'memory://model.mdx'
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

/** A real Warcraft III model with one attachment point and one collision volume. */
const SAMPLE = join(
  extension,
  '../../references/mdx-m3-viewer/clients/example/resources/SmileyGW_004.mdx',
)

const chunks = (mdx: Uint8Array, tag: string): number =>
  Buffer.from(mdx).toString('latin1').split(tag).length - 1

/** Export to UVM, then strip our own residual: the path any foreign document arrives on. */
async function sourceFreeUvm(bytes: Uint8Array): Promise<Uint8Array> {
  const session = await (
    codec.createCodec(context) as {
      open: (
        value: unknown,
        mode: string,
        budget: unknown,
      ) => Promise<{
        operations: () => {
          invoke: (
            id: string,
            value: unknown,
          ) => Promise<{ state: string; output: { value: Uint8Array } }>
        }
        dispose: () => Promise<void>
      }>
    }
  ).open(input(bytes), 'inspect', budget)
  const exported = await session
    .operations()
    .invoke('model-export-uvm', { schemaVersion: 1, metersPerSourceUnit: 1 })
  await session.dispose()
  expect(exported.state).toBe('ok')
  const container = readUvmContainer(exported.output.value, containerBudget)
  const document = { ...container.document }
  delete document['extras']
  return writeUvmContainer({ ...container, document }, containerBudget)
}

const describeSample = existsSync(SAMPLE) ? describe : describe.skip

describeSample('attachments and collision volumes through the common document', () => {
  it('keeps them when the writer has no residual to read', async () => {
    const original = new Uint8Array(readFileSync(SAMPLE))
    expect(chunks(original, 'ATCH')).toBe(1)
    expect(chunks(original, 'CLID')).toBe(1)

    const uvm = await sourceFreeUvm(original)
    // The common document is where they have to survive: nothing of ours is left in it.
    const document = readUvmContainer(uvm, containerBudget).document as {
      extensionsUsed?: string[]
      extras?: unknown
    }
    expect(document.extras).toBeUndefined()
    expect(document.extensionsUsed).toContain('UV_game_socket')
    expect(document.extensionsUsed).toContain('UV_game_collision')

    const written = exportWar3FromUvm(uvm, containerBudget)
    expect(chunks(written, 'ATCH')).toBe(1)
    expect(chunks(written, 'CLID')).toBe(1)
  })

  it('writes an absent global sequence or texture animation as none, not as id 0', async () => {
    // The writer leaves these ids out; the MDX generator used to write `undefined` as 0, which put
    // every track on a global sequence the model does not declare, so each clip read back carried
    // the keys of the whole timeline.
    const written = exportWar3FromUvm(
      await sourceFreeUvm(new Uint8Array(readFileSync(SAMPLE))),
      containerBudget,
    )
    const model = parse(
      written.buffer.slice(
        written.byteOffset,
        written.byteOffset + written.byteLength,
      ) as ArrayBuffer,
    )
    expect(model.GlobalSequences).toEqual([])
    const tracks = [...model.Bones, ...model.Helpers, ...model.Attachments].flatMap(node =>
      [node.Translation, node.Rotation, node.Scaling].filter(track => track !== undefined),
    )
    expect(tracks.length).toBeGreaterThan(0)
    for (const track of tracks) expect(track.GlobalSeqId).toBeNull()
    for (const layer of model.Materials.flatMap(material => material.Layers))
      expect(layer.TVertexAnimId).toBeNull()
  })
})

/** Two sequences; a particle emitter with stepped visibility, linear rate and a Bezier length. */
const EMITTER_SAMPLE = join(
  extension,
  '../../references/ReterasModelStudio/matrixeater/res/stock/particles/WeaponMagicFlatEmitter.mdx',
)

type Track = {
  LineType: number
  GlobalSeqId: number | null
  Keys: { Frame: number; Vector: ArrayLike<number> }[]
}
type Emitter = { EmissionRate?: number | Track; Length?: number | Track; Visibility?: Track }

/** Each key as [frame relative to its sequence start, value], sequence by sequence. */
function perSequence(model: { Sequences: { Interval: ArrayLike<number> }[] }, track: Track) {
  return model.Sequences.map(({ Interval: [start = 0, end = start] }) =>
    track.Keys.filter(key => key.Frame >= start && key.Frame <= end).map(key => [
      key.Frame - start,
      Math.fround(key.Vector[0] ?? NaN),
    ]),
  )
}

;(existsSync(EMITTER_SAMPLE) ? describe : describe.skip)(
  'emitters through the common document',
  () => {
    const read = (bytes: Uint8Array) =>
      parse(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      ) as unknown as {
        Sequences: { Interval: ArrayLike<number> }[]
        ParticleEmitters2: Emitter[]
      }

    it('keeps static values and moves every sequence-local key into its sequence slot', async () => {
      const original = new Uint8Array(readFileSync(EMITTER_SAMPLE))
      const uvm = await sourceFreeUvm(original)
      const effects = (
        readUvmContainer(uvm, containerBudget).document as {
          extensions: {
            UV_game_effects: { trackTimeUnit: string; particles: Record<string, unknown>[] }
          }
        }
      ).extensions.UV_game_effects
      // The common vocabulary sits where the extension declares it, not in a private object.
      for (const particle of effects.particles) expect(particle).not.toHaveProperty('native')

      const source = read(original)
      const check = (written: Uint8Array) => {
        const target = read(written)
        expect(target.ParticleEmitters2).toHaveLength(source.ParticleEmitters2.length)
        for (const [index, emitter] of source.ParticleEmitters2.entries()) {
          const converted = target.ParticleEmitters2[index]!
          for (const field of ['EmissionRate', 'Length', 'Visibility'] as const) {
            const track = emitter[field]
            if (track === undefined || typeof track === 'number') {
              expect(converted[field]).toEqual(track)
              continue
            }
            const carried = converted[field] as Track
            expect(carried.LineType).toBe(track.LineType)
            expect(carried.GlobalSeqId).toBeNull()
            expect(perSequence(target, carried)).toEqual(perSequence(source, track))
          }
        }
      }
      check(exportWar3FromUvm(uvm, containerBudget))

      // The same tracks stated in seconds, as StarCraft II states them, land on the same frames.
      const container = readUvmContainer(uvm, containerBudget)
      const document = structuredClone(container.document) as typeof container.document & {
        extensions: {
          UV_game_effects: { trackTimeUnit: string; particles: Record<string, unknown>[] }
        }
      }
      const inSeconds = document.extensions.UV_game_effects
      inSeconds.trackTimeUnit = 'seconds'
      for (const particle of inSeconds.particles)
        for (const sequences of Object.values(
          (particle['sequenceAnimation'] ?? {}) as Record<
            string,
            { track: { keys: { frame: number }[] } }[]
          >,
        ))
          for (const { track } of sequences) for (const key of track.keys) key.frame /= 1000
      check(
        exportWar3FromUvm(
          writeUvmContainer({ ...container, document }, containerBudget),
          containerBudget,
        ),
      )
    })
  },
)
