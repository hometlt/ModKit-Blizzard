import type { ResourceBudget } from '@modkit/sdk'
import type { M3StructureData, SectionResolver } from '../../dist/m3/native/types.js'

/** The MK3 boundary validates declared reference types and bounds access to the frozen decoder. */
export function createM3SectionResolver(
  sections: SectionResolver & { readonly model: M3StructureData },
  budget: Pick<ResourceBudget, 'maxDepth' | 'maxNodes'>,
  signal?: AbortSignal,
): SectionResolver {
  let recordsRead = 0
  const expectedTags = new WeakMap<object, string>()
  const inspected = new WeakSet<object>()
  const counted = new WeakSet<object>()
  const rememberReferences = (record: M3StructureData, depth = 0): void => {
    if (inspected.has(record)) return
    inspected.add(record)
    if (depth > budget.maxDepth) throw new RangeError('M3 section structure exceeds maxDepth')
    for (const field of Object.values(record.desc?.fields ?? {})) {
      const value = record[field.name]
      // A scalar field is part of the record already counted as a section entry, and its bytes are
      // bounded by maxScalarBytes; counting x, y, z and w of every animation key again as nodes
      // refused a 90-clip model four times over. Only a reference or a nested structure is a node.
      if (value === null || typeof value !== 'object') continue
      if (++recordsRead > budget.maxNodes) throw new RangeError('M3 section traversal exceeds maxNodes')
      if ('refTo' in field && typeof field.refTo === 'string' && field.refTo.length > 0) {
        expectedTags.set(value, field.refTo)
      } else if ('desc' in value) {
        rememberReferences(value as M3StructureData, depth + 1)
      }
    }
  }
  rememberReferences(sections.model)
  const resolver: SectionResolver = {
    getSectionByReference(reference) {
      if (signal?.aborted) throw new DOMException('operation cancelled', 'AbortError')
      if (reference == null || reference.entries === 0) return null
      if (!Number.isSafeInteger(reference.entries) || reference.entries < 0 ||
        !Number.isSafeInteger(reference.index) || reference.index < 0) {
        throw new TypeError('invalid M3 section reference')
      }
      const section = sections.getSectionByReference(reference)
      if (section == null || reference.entries > section.content.length) {
        throw new TypeError('M3 section reference exceeds its section')
      }
      const expectedTag = expectedTags.get(reference)
      if (expectedTag !== undefined && section.desc.history.name !== expectedTag) {
        throw new TypeError('M3 section reference does not address its declared type')
      }
      // A reference is data to traverse once. The animation projection asks for the same key and
      // frame arrays per channel and per sequence; counting every repeat charged a 90-clip model
      // for the same keys dozens of times.
      if (!counted.has(reference)) {
        counted.add(reference)
        recordsRead += 1 + reference.entries
        if (recordsRead > budget.maxNodes)
          throw new RangeError(
            `M3 section traversal exceeds maxNodes (${recordsRead} records, budget ${budget.maxNodes})`,
          )
        for (let index = 0; index < reference.entries; index++) {
          const record = section.content[index]
          if (record !== null && typeof record === 'object' && 'desc' in record) rememberReferences(record)
        }
      }
      return reference.entries === section.content.length ? section : {
        ...section, content: section.content.slice(0, reference.entries),
      }
    },
  }
  return resolver
}
