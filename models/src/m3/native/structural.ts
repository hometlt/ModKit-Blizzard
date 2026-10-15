import { M3Section, M3SectionList } from './binary/sections.js'
import type { M3StructureData } from './binary/structures.js'
import type { M3Reference } from './types.js'

export type M3SectionValue = M3StructureData | number | bigint | string

export interface M3SectionGraphWriteOptions {
  /** M3 sections and the index table are conventionally 16-byte aligned. */
  alignment?: number
  /** Byte used in alignment gaps. Blizzard-authored M3 containers use 0xaa. */
  paddingByte?: number
}

/**
 * Relocating typed writer for an existing M3/M3A section graph.
 *
 * Unlike the lossless serializer, this rebuilds every known section, updates
 * section offsets/repetition counts, and emits a new index table. Unknown
 * sections remain byte-preserved through their synthetic raw-byte structure.
 */
export function serializeM3SectionGraph(
  sections: M3SectionList,
  options: M3SectionGraphWriteOptions = {},
): Uint8Array {
  if (sections.length === 0 || sections[0]?.desc.history.name !== `MD${sections.mdVersion}`) {
    throw new Error('M3 structural serialization requires the MD header as section zero.')
  }
  const alignment = checkedAlignment(options.alignment ?? 16)
  const paddingByte = checkedPaddingByte(options.paddingByte ?? 0xaa)
  const indexHistory = sections.structureHistories['MDIndexEntry']
  if (!indexHistory) throw new Error('M3 structural serialization requires MDIndexEntry schema.')
  const indexDescription = indexHistory.getVersion(
    sections.mdVersion,
    sections.mdVersion,
    sections.structureHistories,
  )

  const payloads: Uint8Array[] = []
  const offsets = new Uint32Array(sections.length)
  let cursor = 0
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!
    cursor = index === 0 ? 0 : alignTo(cursor, alignment)
    if (cursor > 0xffffffff) throw new Error('M3 section offset exceeds uint32 storage.')
    offsets[index] = cursor
    const payload = serializeM3SectionContent(section)
    payloads.push(payload)
    cursor += payload.byteLength
  }

  const indexOffset = alignTo(cursor, alignment)
  const totalLength = indexOffset + sections.length * indexDescription.size
  if (totalLength > 0xffffffff) throw new Error('M3 structural output exceeds uint32 storage.')

  const header = sections[0]!.content[0] as M3StructureData | undefined
  if (!header || typeof header.toBuffer !== 'function') {
    throw new Error('M3 structural serialization requires a typed MD header record.')
  }
  header.index_offset = indexOffset
  header.index_size = sections.length

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!
    section.indexEntry.offset = offsets[index]!
    if (sections.structureHistories[section.desc.history.name]) {
      section.indexEntry.repetitions = section.content.length
    }
  }
  // The header mutation above must be reflected in its already-sized payload.
  payloads[0] = serializeM3SectionContent(sections[0]!)

  const output = new Uint8Array(totalLength)
  output.fill(paddingByte)
  for (let index = 0; index < payloads.length; index += 1) {
    output.set(payloads[index]!, offsets[index]!)
  }
  for (let index = 0; index < sections.length; index += 1) {
    sections[index]!.indexEntry.toBuffer(output.buffer, indexOffset + index * indexDescription.size)
  }
  return output
}

export function serializeM3SectionContent(section: M3Section): Uint8Array {
  if (section.desc.history.primitive) {
    const output = new Uint8Array(section.desc.size * section.content.length)
    for (let index = 0; index < section.content.length; index += 1) {
      const value = section.content[index]
      if (typeof value !== 'number' && typeof value !== 'bigint') {
        throw new Error(`M3 primitive ${section.desc.history.name} requires numeric records.`)
      }
      const record = section.desc.instance()
      record.value = value
      record.toBuffer(output.buffer, index * section.desc.size)
    }
    return output
  }

  const output = new Uint8Array(section.desc.size * section.content.length)
  for (let index = 0; index < section.content.length; index += 1) {
    const record = section.content[index]
    if (!isStructureData(record)) {
      throw new Error(`M3 section ${section.desc.history.name} requires typed structure records.`)
    }
    if (record.desc.size !== section.desc.size) {
      throw new Error(`M3 section ${section.desc.history.name} contains an incompatible record.`)
    }
    record.toBuffer(output.buffer, index * section.desc.size)
  }
  return output
}

/** Append a schema-backed section without renumbering any existing reference. */
export function appendM3Section(
  sections: M3SectionList,
  tag: string,
  version: number,
  content: readonly M3SectionValue[] = [],
): M3Section {
  const history = sections.structureHistories[tag]
  if (!history) throw new Error(`Cannot append unknown M3 section ${tag}.`)
  const description = history.getVersion(version, sections.mdVersion, sections.structureHistories)
  const indexHistory = sections.structureHistories['MDIndexEntry']
  if (!indexHistory) throw new Error('M3 section append requires MDIndexEntry schema.')
  const indexEntry = indexHistory
    .getVersion(sections.mdVersion, sections.mdVersion, sections.structureHistories)
    .instance()
  indexEntry.tag = m3TagToUint32(tag)
  indexEntry.offset = 0
  indexEntry.repetitions = content.length
  indexEntry.version = version
  const section = new M3Section(description, indexEntry, [], [...content])
  sections.push(section)
  return section
}

/** Replace all records owned by a reference and keep its entry count coherent. */
export function replaceM3ReferencedRecords(
  sections: M3SectionList,
  reference: M3Reference,
  records: readonly M3SectionValue[],
): void {
  const section = referencedSectionForWrite(sections, reference)
  section.content = [...records]
  reference.entries = records.length
  section.indexEntry.repetitions = records.length
}

export function appendM3ReferencedRecord(
  sections: M3SectionList,
  reference: M3Reference,
  record: M3SectionValue,
): number {
  const section = referencedSectionForWrite(sections, reference)
  const index = section.content.length
  section.content.push(record)
  reference.entries = section.content.length
  section.indexEntry.repetitions = section.content.length
  return index
}

export function removeM3ReferencedRecord(
  sections: M3SectionList,
  reference: M3Reference,
  recordIndex: number,
): M3SectionValue {
  const section = referencedSectionForWrite(sections, reference)
  if (!Number.isInteger(recordIndex) || recordIndex < 0 || recordIndex >= section.content.length) {
    throw new RangeError(`Invalid M3 section record index ${recordIndex}.`)
  }
  const [removed] = section.content.splice(recordIndex, 1)
  reference.entries = section.content.length
  section.indexEntry.repetitions = section.content.length
  return removed!
}

export function pointM3ReferenceAtSection(
  sections: M3SectionList,
  reference: M3Reference,
  section: M3Section,
): void {
  const index = sections.indexOf(section)
  if (index < 0) throw new Error('M3 reference target is not part of this section graph.')
  reference.index = index
  reference.entries = section.content.length
}

function referencedSectionForWrite(sections: M3SectionList, reference: M3Reference): M3Section {
  if (
    !Number.isInteger(reference.index) ||
    reference.index < 0 ||
    reference.index >= sections.length
  ) {
    throw new RangeError(`Invalid M3 reference section index ${reference.index}.`)
  }
  return sections[reference.index]!
}

function isStructureData(value: unknown): value is M3StructureData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'desc' in value &&
    typeof (value as { toBuffer?: unknown }).toBuffer === 'function'
  )
}

function m3TagToUint32(tag: string): number {
  if (!/^[\x20-\x7e]{1,4}$/.test(tag)) throw new Error(`Invalid M3 section tag ${tag}.`)
  const bytes = tag
    .padEnd(4, '\0')
    .split('')
    .reverse()
    .map(value => value.charCodeAt(0))
  return (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0
}

function checkedAlignment(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || (value & (value - 1)) !== 0) {
    throw new RangeError(`M3 alignment ${value} must be a positive power of two.`)
  }
  return value
}

function checkedPaddingByte(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`M3 padding byte ${value} must be an integer within [0, 255].`)
  }
  return value
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment
}
