import type { M3Section as IM3Section, M3StructureData, M3Reference } from '../types.js'
import { M3StructureDescription, M3StructureHistory } from './structures.js'
import { M3FieldBytes } from './fields.js'
import { loadM3StructuresXml } from './parser.js'
import { getConfig } from '../config.js'
import { getFs, getPath, getDirname } from '../platform.js'

export class M3Section implements IM3Section {
  desc: M3StructureDescription
  indexEntry: M3StructureData
  references: M3Section[]
  content: (M3StructureData | number | bigint | string)[]
  rawBytes: ArrayBuffer | null
  model: M3StructureData | null;
  [index: number]: M3Section

  constructor(
    desc: M3StructureDescription,
    indexEntry: M3StructureData,
    references: M3Section[],
    content: (M3StructureData | number | bigint | string)[],
    rawBytes: ArrayBuffer | null = null,
  ) {
    this.desc = desc
    this.indexEntry = indexEntry
    this.references = references
    this.content = content
    this.rawBytes = rawBytes
    this.model = null
  }

  getSectionByReference(
    reference: import('../types.js').M3Reference | null | undefined,
  ): M3Section | null {
    if (!reference) return null
    const index = reference.index
    const entries = reference.entries
    if (typeof index !== 'number' || !entries) return null
    return this[index] || null
  }
}

export class M3SectionList extends Array<M3Section> {
  fileBuffer: ArrayBuffer | null = null
  /** Exact schema text used for this parse, retained for deterministic snapshots. */
  structuresXmlSource: string | null = null
  /** Parse-local schema registry; do not consult the mutable compatibility registry. */
  structureHistories: Record<string, M3StructureHistory> = {}
  mdVersion = 34
  model: import('../types.js').M3StructureData | null = null

  constructor() {
    super()
  }

  static async load(arrayBuffer: ArrayBuffer, xmlPathOrText?: string): Promise<M3SectionList> {
    const config = getConfig()
    let xmlText: string

    if (xmlPathOrText) {
      if (xmlPathOrText.trimStart().startsWith('<')) {
        xmlText = xmlPathOrText
      } else if (config.isNode) {
        xmlText = getFs().readFileSync(xmlPathOrText, 'utf8')
      } else {
        const response = await fetch(xmlPathOrText)
        if (!response.ok) throw new Error(`Failed to fetch structures.xml from ${xmlPathOrText}`)
        xmlText = await response.text()
      }
    } else if (config.isNode) {
      xmlText = getFs().readFileSync(getPath().join(getDirname(), './structures.xml'), 'utf8')
    } else if (config.embeddedStructuresXml) {
      xmlText = config.embeddedStructuresXml
    } else {
      throw new Error(
        'No structures.xml source provided. Set embeddedStructuresXml or pass xmlPathOrText.',
      )
    }

    // Keep this locally returned registry. Another parse can legitimately load a
    // different schema while this async call is yielding and replace the legacy
    // global registry used by getStructures().
    const structs = await loadM3StructuresXml(xmlText)

    if (arrayBuffer.byteLength < 4) {
      throw new Error(
        `Invalid M3 header: expected at least 4 bytes, got ${arrayBuffer.byteLength}.`,
      )
    }

    const list = new M3SectionList()
    list.fileBuffer = arrayBuffer
    list.structuresXmlSource = xmlText
    list.structureHistories = structs

    const tagValue = new DataView(arrayBuffer, 0, 4).getUint32(0, true)
    const mdTag = bytesToTag(tagValue)
    list.mdVersion = parseInt(mdTag.slice(2), 10)

    const headerHistory = structs[mdTag]
    if (!headerHistory || !Number.isInteger(list.mdVersion)) {
      throw new Error(`Invalid M3 header: unsupported tag "${mdTag}".`)
    }
    const headerDesc = headerHistory.getVersion(11, list.mdVersion, structs)
    if (arrayBuffer.byteLength < headerDesc.size) {
      throw new Error(
        `Invalid M3 header: expected at least ${headerDesc.size} bytes, got ${arrayBuffer.byteLength}.`,
      )
    }
    const header = headerDesc.instance(arrayBuffer, 0)
    const indexOffset = (header.index_offset as number) ?? 0
    const indexSize = (header.index_size as number) ?? 0
    const indexDesc = structs['MDIndexEntry'].getVersion(list.mdVersion, list.mdVersion, structs)
    const indexByteLength = indexSize * indexDesc.size
    if (
      !Number.isSafeInteger(indexOffset) ||
      !Number.isSafeInteger(indexSize) ||
      indexOffset < 0 ||
      indexSize < 0 ||
      indexOffset > arrayBuffer.byteLength ||
      indexByteLength > arrayBuffer.byteLength - indexOffset
    ) {
      throw new Error(
        `Invalid M3 section index: offset ${indexOffset}, entries ${indexSize}, file size ${arrayBuffer.byteLength}.`,
      )
    }

    const indexEntries: M3StructureData[] = []
    for (let i = 0; i < indexSize; i += 1) {
      const entryOffset = indexOffset + i * indexDesc.size
      indexEntries.push(indexDesc.instance(arrayBuffer, entryOffset) as M3StructureData)
    }

    for (const entry of indexEntries) {
      const tagStr = bytesToTag((entry.tag as number) ?? 0)
      const sectionOffset = (entry.offset as number) ?? 0
      const repetitions = (entry.repetitions as number) ?? 0
      const knownStructure = structs[tagStr]
      const sectionDesc =
        knownStructure?.getVersion((entry.version as number) ?? 0, list.mdVersion, structs) ??
        createUnknownSectionDescription(
          tagStr,
          (entry.version as number) ?? 0,
          inferSectionByteLength(indexEntries, sectionOffset, arrayBuffer.byteLength, indexOffset),
        )
      const sectionSize = knownStructure ? sectionDesc.size * repetitions : sectionDesc.size
      const sectionBuffer = arrayBuffer.slice(sectionOffset, sectionOffset + sectionSize)
      const sectionContent = sectionDesc.instances(
        sectionBuffer,
        knownStructure ? repetitions : sectionSize > 0 ? 1 : 0,
      )
      list.push(new M3Section(sectionDesc, entry, [], sectionContent, sectionBuffer))
    }

    const headerSection = list[0]
    if (!headerSection?.content[0]) {
      throw new Error('Invalid M3 section index: missing header section.')
    }
    const modelRef = (headerSection.content[0] as M3StructureData).model as M3Reference | undefined
    list.model =
      (list.getSectionByReference(modelRef)?.content[0] as M3StructureData | null) ?? null
    return list
  }

  getSectionByReference(reference: M3Reference | null | undefined): M3Section | null {
    if (!reference) return null
    const index = reference.index
    const entries = reference.entries
    if (typeof index !== 'number' || !entries) return null
    return this[index] || null
  }

  getSectionsByTag(tag: string): M3Section[] {
    return this.filter(section => section.desc.history.name === tag)
  }
}

function createUnknownSectionDescription(
  tag: string,
  version: number,
  byteLength: number,
): M3StructureDescription {
  const history = new M3StructureHistory(tag || 'UNKN', new Map(), [])
  const fields = {
    raw: new M3FieldBytes('raw', byteLength, new Uint8Array(byteLength)),
  }
  return new M3StructureDescription(history, version, fields, byteLength)
}

function inferSectionByteLength(
  entries: M3StructureData[],
  offset: number,
  fileLength: number,
  indexOffset: number,
): number {
  let end = indexOffset > offset ? indexOffset : fileLength
  for (const entry of entries) {
    const candidate = (entry.offset as number) ?? 0
    if (candidate > offset && candidate < end) end = candidate
  }
  return Math.max(0, end - offset)
}

function bytesToTag(tagValue: number): string {
  const bytes = [
    tagValue & 0xff,
    (tagValue >> 8) & 0xff,
    (tagValue >> 16) & 0xff,
    (tagValue >> 24) & 0xff,
  ]
  return String.fromCharCode(...bytes)
    .replace(/\0/g, '')
    .split('')
    .reverse()
    .join('')
}
