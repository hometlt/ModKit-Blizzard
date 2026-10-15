import { readFile } from 'node:fs/promises'
import { DOMParser } from '@xmldom/xmldom'
import { loadM3StructuresXml } from '../../dist/m3/native/binary/parser.js'
import { installM3PlatformAdapters } from '../../dist/m3/native/platform.js'
installM3PlatformAdapters({ DOMParser: DOMParser as unknown as typeof globalThis.DOMParser })

function writeTag(bytes: Uint8Array, offset: number, tag: string): void {
  for (let index = 0; index < 4; index += 1) bytes[offset + index] = tag.charCodeAt(3 - index)
}

function recordsBytes(
  desc: { readonly size: number; instance(): Record<string, unknown> },
  records: readonly Record<string, unknown>[],
): Uint8Array {
  const buffer = new ArrayBuffer(desc.size * records.length)
  for (const [index, record] of records.entries()) {
    Object.assign(desc.instance(), record).toBuffer(buffer, index * desc.size)
  }
  return new Uint8Array(buffer)
}

function numberRecords(
  desc: { readonly size: number; instance(): Record<string, unknown> },
  values: readonly number[],
): Uint8Array {
  const buffer = new ArrayBuffer(desc.size * values.length)
  for (const [index, value] of values.entries()) {
    const record = desc.instance()
    record.value = value
    record.toBuffer(buffer, index * desc.size)
  }
  return new Uint8Array(buffer)
}

interface SyntheticAnimationOptions {
  readonly structuresXml?: string
  readonly start?: number
  readonly end?: number
  readonly stcAnimId?: number
  readonly boneAnimId?: number
  readonly sharedTarget?: boolean
  readonly emptySequences?: boolean
  readonly frameTicks?: readonly number[]
  readonly keyValues?: readonly (readonly [number, number, number])[]
  readonly interpolation?: 0 | 1
  readonly concurrent?: boolean
  readonly wrapMs?: number
  readonly secondStcValues?: readonly (readonly [number, number, number])[]
  readonly firstStsEmpty?: boolean
  readonly residualFlagValues?: readonly number[]
}

export async function buildAnimationM3(
  options: SyntheticAnimationOptions = {},
): Promise<Uint8Array> {
  const structures = await loadM3StructuresXml(
    options.structuresXml ??
      (await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8')),
  )
  const desc = (tag: string, version: number) => structures[tag].getVersion(version, 34, structures)
  const headerDesc = desc('MD34', 11)
  const modelDesc = desc('MODL', 20)
  const sequenceDesc = desc('SEQS', 2)
  const stcDesc = desc('STC_', 4)
  const stgDesc = desc('STG_', 0)
  const stsDesc = desc('STS_', 0)
  const boneDesc = desc('BONE', 1)
  const boneRestDesc = desc('IREF', 0)
  const sd3vDesc = desc('SD3V', 0)
  const sdfgDesc = desc('SDFG', 0)
  const flagDesc = desc('FLAG', 0)
  const u32Desc = desc('U32_', 0)
  const i32Desc = desc('I32_', 0)
  const vec3Desc = desc('VEC3', 0)

  const sequenceName = new TextEncoder().encode('Walk\0')
  const stcName = new TextEncoder().encode('Walk_full\0')
  const stgName = new TextEncoder().encode('Walk\0')
  const boneName = new TextEncoder().encode('Root\0')
  const stcAnimId = options.stcAnimId ?? 0x1020_3040
  const residualFlagAnimId = stcAnimId + 1
  const boneAnimId = options.boneAnimId ?? stcAnimId
  const start = options.start ?? 100
  const end = options.end ?? 220
  const frameTicks = options.frameTicks ?? [start, end]
  const keyValues = options.keyValues ?? frameTicks.map((_, index) => [index, index + 1, index + 2])
  const boneCount = options.sharedTarget === true ? 2 : 1
  const declared = options.emptySequences === true ? 0 : 1

  const model = modelDesc.instance()
  Object.assign(model.sequences, { entries: declared, index: 2, flags: 0 })
  Object.assign(model.sequence_transformation_collections, {
    entries: declared,
    index: 4,
    flags: 0,
  })
  Object.assign(model.sequence_transformation_groups, { entries: declared, index: 9, flags: 0 })
  Object.assign(model.sts, { entries: declared, index: 12, flags: 0 })
  Object.assign(model.bones, { entries: boneCount, index: 14, flags: 0 })
  Object.assign(model.bone_rests, { entries: boneCount, index: 18, flags: 0 })

  const sequence = sequenceDesc.instance()
  sequence.id = 0
  sequence.index = 0
  Object.assign(sequence.name, { entries: sequenceName.byteLength, index: 3, flags: 0 })
  sequence.anim_ms_start = start
  sequence.anim_ms_end = end
  sequence.flags = 0
  sequence.frequency = 100

  const stc = stcDesc.instance()
  Object.assign(stc.name, { entries: stcName.byteLength, index: 5, flags: 0 })
  stc.sts_index = 0
  stc.sts_index_fb = 0
  Object.assign(stc.anim_ids, { entries: 1, index: 6, flags: 0 })
  Object.assign(stc.anim_refs, { entries: 1, index: 7, flags: 0 })
  stc.ref_count = 1
  Object.assign(stc.sd3v, { entries: 1, index: 8, flags: 0 })

  const stg = stgDesc.instance()
  Object.assign(stg.name, { entries: stgName.byteLength, index: 10, flags: 0 })
  Object.assign(stg.stc_indices, { entries: 1, index: 11, flags: 0 })

  const sts = stsDesc.instance()
  Object.assign(sts.anim_ids, { entries: 1, index: 13, flags: 0 })

  const bone = boneDesc.instance()
  bone.id = 0
  Object.assign(bone.name, { entries: boneName.byteLength, index: 15, flags: 0 })
  bone.parent = -1
  bone.location.header.id = boneAnimId
  bone.location.header.interpolation = options.interpolation ?? 1
  bone.location.header.flags = 6
  bone.rotation.header.id = 0x5060_7080
  bone.scale.header.id = 0x90a0_b0c0
  Object.assign(bone.location.default, { x: 10, y: 20, z: 30 })
  Object.assign(bone.rotation.default, { x: 0, y: 0, z: 0, w: 1 })
  Object.assign(bone.scale.default, { x: 1, y: 1, z: 1 })
  const bones = [bone]
  if (options.sharedTarget === true) {
    const duplicate = boneDesc.instance()
    duplicate.id = 1
    Object.assign(duplicate.name, { entries: boneName.byteLength, index: 15, flags: 0 })
    duplicate.parent = -1
    duplicate.location.header.id = boneAnimId
    duplicate.location.header.interpolation = 1
    duplicate.location.header.flags = 6
    duplicate.rotation.header.id = 0x5060_7081
    duplicate.scale.header.id = 0x90a0_b0c1
    Object.assign(duplicate.location.default, { x: 10, y: 20, z: 30 })
    Object.assign(duplicate.rotation.default, { x: 0, y: 0, z: 0, w: 1 })
    Object.assign(duplicate.scale.default, { x: 1, y: 1, z: 1 })
    bones.push(duplicate)
  }

  const sd3v = sd3vDesc.instance()
  stc.concurrent = options.concurrent ? 1 : 0
  sd3v.fend = options.wrapMs ?? end
  Object.assign(sd3v.frames, { entries: frameTicks.length, index: 16, flags: 0 })
  Object.assign(sd3v.keys, { entries: keyValues.length, index: 17, flags: 0 })

  const vectorKeys = keyValues.map(value => {
    const key = vec3Desc.instance()
    key.x = value[0]
    key.y = value[1]
    key.z = value[2]
    return key
  })

  const stcRecords = [stc]
  const stsRecords = [sts]
  const extraSections = []
  if (options.firstStsEmpty) sts.anim_ids.entries = 0
  if (options.secondStcValues !== undefined) {
    const second = stcDesc.instance()
    Object.assign(second.name, { entries: stcName.byteLength, index: 5, flags: 0 })
    Object.assign(second.anim_ids, { entries: 1, index: 6, flags: 0 })
    Object.assign(second.anim_refs, { entries: 1, index: 7, flags: 0 })
    Object.assign(second.sd3v, { entries: 1, index: 19, flags: 0 })
    second.sts_index = 1
    second.priority = 100
    stcRecords.push(second)
    const secondSts = stsDesc.instance()
    Object.assign(secondSts.anim_ids, { entries: 1, index: 13, flags: 0 })
    stsRecords.push(secondSts)
    const secondSd = sd3vDesc.instance()
    secondSd.fend = end
    Object.assign(secondSd.frames, { entries: frameTicks.length, index: 16, flags: 0 })
    Object.assign(secondSd.keys, { entries: options.secondStcValues.length, index: 20, flags: 0 })
    const secondKeys = options.secondStcValues.map(value =>
      Object.assign(vec3Desc.instance(), { x: value[0], y: value[1], z: value[2] }),
    )
    extraSections.push(
      { tag: 'SD3V', version: 0, repetitions: 1, bytes: recordsBytes(sd3vDesc, [secondSd]) },
      {
        tag: 'VEC3',
        version: 0,
        repetitions: secondKeys.length,
        bytes: recordsBytes(vec3Desc, secondKeys),
      },
    )
    model.sequence_transformation_collections.entries = 2
    model.sts.entries = 2
    stg.stc_indices.entries = 2
  }
  if (options.residualFlagValues !== undefined) {
    const sdfgSectionIndex = 19 + extraSections.length
    const flagSectionIndex = sdfgSectionIndex + 1
    stc.anim_ids.entries = 2
    stc.anim_refs.entries = 2
    stc.ref_count = 2
    sts.anim_ids.entries = 2
    Object.assign(stc.sdfg, { entries: 1, index: sdfgSectionIndex, flags: 0 })
    const sdfg = sdfgDesc.instance()
    sdfg.fend = options.wrapMs ?? end
    Object.assign(sdfg.frames, { entries: frameTicks.length, index: 16, flags: 0 })
    Object.assign(sdfg.keys, {
      entries: options.residualFlagValues.length,
      index: flagSectionIndex,
      flags: 0,
    })
    extraSections.push(
      { tag: 'SDFG', version: 0, repetitions: 1, bytes: recordsBytes(sdfgDesc, [sdfg]) },
      {
        tag: 'FLAG',
        version: 0,
        repetitions: options.residualFlagValues.length,
        bytes: numberRecords(flagDesc, options.residualFlagValues),
      },
    )
  }

  const stcAnimIds =
    options.residualFlagValues === undefined ? [stcAnimId] : [stcAnimId, residualFlagAnimId]
  const stcAnimRefs =
    options.residualFlagValues === undefined
      ? [(2 << 16) | 0]
      : [(2 << 16) | 0, (11 << 16) | 0]
  const boneRests = bones.map(() => {
    const rest = boneRestDesc.instance()
    for (const [rowIndex, rowName] of ['x', 'y', 'z', 'w'].entries()) {
      const row = rest.matrix[rowName]
      row.x = rowIndex === 0 ? 1 : 0
      row.y = rowIndex === 1 ? 1 : 0
      row.z = rowIndex === 2 ? 1 : 0
      row.w = rowIndex === 3 ? 1 : 0
    }
    return rest
  })

  const sections = [
    { tag: 'MD34', version: 11, repetitions: 1, bytes: new Uint8Array(headerDesc.size) },
    { tag: 'MODL', version: 20, repetitions: 1, bytes: recordsBytes(modelDesc, [model]) },
    { tag: 'SEQS', version: 2, repetitions: 1, bytes: recordsBytes(sequenceDesc, [sequence]) },
    { tag: 'CHAR', version: 0, repetitions: sequenceName.byteLength, bytes: sequenceName },
    {
      tag: 'STC_',
      version: 4,
      repetitions: stcRecords.length,
      bytes: recordsBytes(stcDesc, stcRecords),
    },
    { tag: 'CHAR', version: 0, repetitions: stcName.byteLength, bytes: stcName },
    {
      tag: 'U32_',
      version: 0,
      repetitions: stcAnimIds.length,
      bytes: numberRecords(u32Desc, stcAnimIds),
    },
    {
      tag: 'U32_',
      version: 0,
      repetitions: stcAnimRefs.length,
      bytes: numberRecords(u32Desc, stcAnimRefs),
    },
    { tag: 'SD3V', version: 0, repetitions: 1, bytes: recordsBytes(sd3vDesc, [sd3v]) },
    { tag: 'STG_', version: 0, repetitions: 1, bytes: recordsBytes(stgDesc, [stg]) },
    { tag: 'CHAR', version: 0, repetitions: stgName.byteLength, bytes: stgName },
    {
      tag: 'U32_',
      version: 0,
      repetitions: stcRecords.length,
      bytes: numberRecords(
        u32Desc,
        stcRecords.map((_, index) => index),
      ),
    },
    {
      tag: 'STS_',
      version: 0,
      repetitions: stsRecords.length,
      bytes: recordsBytes(stsDesc, stsRecords),
    },
    {
      tag: 'U32_',
      version: 0,
      repetitions: stcAnimIds.length,
      bytes: numberRecords(u32Desc, stcAnimIds),
    },
    { tag: 'BONE', version: 1, repetitions: bones.length, bytes: recordsBytes(boneDesc, bones) },
    { tag: 'CHAR', version: 0, repetitions: boneName.byteLength, bytes: boneName },
    {
      tag: 'I32_',
      version: 0,
      repetitions: frameTicks.length,
      bytes: numberRecords(i32Desc, frameTicks),
    },
    {
      tag: 'VEC3',
      version: 0,
      repetitions: keyValues.length,
      bytes: recordsBytes(vec3Desc, vectorKeys),
    },
    {
      tag: 'IREF',
      version: 0,
      repetitions: boneRests.length,
      bytes: recordsBytes(boneRestDesc, boneRests),
    },
  ]
  sections.push(...extraSections)
  let cursor = 0
  const offsets = sections.map(section => {
    const offset = cursor
    cursor += section.bytes.byteLength
    return offset
  })
  const indexOffset = cursor
  const bytes = new Uint8Array(indexOffset + sections.length * 16)
  for (const [index, section] of sections.entries()) bytes.set(section.bytes, offsets[index])
  const view = new DataView(bytes.buffer)
  for (const [index, section] of sections.entries()) {
    const offset = indexOffset + index * 16
    writeTag(bytes, offset, section.tag)
    view.setUint32(offset + 4, offsets[index], true)
    view.setUint32(offset + 8, section.repetitions, true)
    view.setUint32(offset + 12, section.version, true)
  }
  const header = headerDesc.instance()
  header.tag = 0x4d443334
  header.index_offset = indexOffset
  header.index_size = sections.length
  Object.assign(header.model, { entries: 1, index: 1, flags: 0 })
  header.toBuffer(bytes.buffer, 0)
  return bytes
}
