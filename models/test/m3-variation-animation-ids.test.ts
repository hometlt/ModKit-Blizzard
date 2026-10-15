import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { encodeM3JsonModel } from '../src/m3/writer.js'
import { M3SectionList } from '../dist/m3/native/binary/sections.js'

const budget = { maxInputBytes: 16777216n, maxScalarBytes: 16777216,
  maxNodes: 100000, maxDepth: 96, maxDiagnostics: 100 }

it('keeps variation reference IDs independent across emitter kinds and indices', async () => {
  const emitters = [
    { tag: 'PAR_', recordIndex: 0, amplitude: 0.25, frequency: 1.5 },
    { tag: 'RIB_', recordIndex: 0, amplitude: 0.5, frequency: 2.5 },
    { tag: 'RIB_', recordIndex: 1, amplitude: 0.75, frequency: 3.5 },
  ]
  const bindings = emitters.flatMap((emitter, emitterIndex) =>
    ['amplitude', 'frequency'].map((parameter, parameterIndex) => ({
      tag: emitter.tag, sectionOrdinal: 0, recordIndex: emitter.recordIndex,
      field: `yaw_var_${parameter}`, animId: 100 + emitterIndex * 2 + parameterIndex,
      interpolation: parameterIndex, flags: 6 + emitterIndex,
    })))
  const effect = (emitter: typeof emitters[number]) => ({
    boneIndex: 0, materialIndex: 0,
    yawVariation: { shape: 'sine', amplitude: emitter.amplitude, frequency: emitter.frequency },
  })
  const source = { format: 'm3', meshes: [],
    skeleton: { bones: [{ index: 0, name: 'Root', parentIndex: -1 }] },
    materials: [{ name: 'Effect', layers: [] }], animations: [], bounds: null,
    effects: { particles: emitters.filter(value => value.tag === 'PAR_').map(effect),
      ribbons: emitters.filter(value => value.tag === 'RIB_').map(effect) },
    metadata: { m3AnimationReferenceIds: bindings } }
  const encoded = await encodeM3JsonModel(source, {}, budget)
  const xml = await readFile(new URL('../src/m3/native/structures.xml', import.meta.url), 'utf8')
  const sections = await M3SectionList.load(encoded.bytes.slice().buffer, xml)
  for (const binding of bindings) {
    const section = sections.find(value => value.desc.history.name === binding.tag)!
    const reference = (section.content[binding.recordIndex] as Record<string, unknown>)[binding.field]
    const emitter = emitters.find(value => value.tag === binding.tag && value.recordIndex === binding.recordIndex)!
    expect(reference).toMatchObject({ header: { id: binding.animId,
      interpolation: binding.interpolation, flags: binding.flags },
      default: binding.field.endsWith('amplitude') ? emitter.amplitude : emitter.frequency })
  }
})
