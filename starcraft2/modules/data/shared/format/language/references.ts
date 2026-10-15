/**
 * Pure "find all references / usages" core — no vscode import, unit-testable.
 *
 * `referenceTargetAt` decides which entity the cursor is on (an entity id/tag, a
 * `parent="…"`, or an `isLink` field value). `collectAllRefs` walks a document and
 * records every entity definition, parent reference, and link reference with its
 * text range; `findReferences` filters those to a single (namespace, id) target.
 *
 * Reference classification is schema-driven (via `@modkitx/data-processing/sc2-catalog`), so it matches
 * what `buildRelations` considers a relation — but here with source positions, which
 * the catalog graph doesn't carry, so usages are navigable in the editor.
 * One synchronous collection shares derived class/field metadata; nothing is retained between
 * calls, so later schema changes remain visible without a second schema or global type cache.
 */

import {
  scanXml,
  elementPathAt,
  attrAt,
  getAttr,
  type ScannedElement,
  type ScannedAttr,
} from './xml-scan.js'
import {
  getClassFields,
  classifyField,
  lookupField,
  namespaceOfClass,
  type FieldInfo,
} from '../../catalog-engine/sc2-catalog/index.js'
import { schemaForPath, attrType } from './completion.js'
import { entityPath, catalogEntities } from './entity.js'

export type RefKind = 'definition' | 'parent' | 'link'

export interface RefMatch {
  namespace: string
  id: string
  start: number
  end: number
  kind: RefKind
}

export interface RefTarget {
  namespace: string
  id: string
}

const STRUCTURAL_ATTRS = new Set(['index', 'removed', 'id', 'parent', 'class', 'default', 'value'])
const MAX_DEPTH = 8

/** The entity (namespace, id) the cursor sits on, or undefined. */
export function referenceTargetAt(text: string, offset: number): RefTarget | undefined {
  const path = entityPath(elementPathAt(text, offset))
  if (path.length === 0) return undefined
  const entity = path[0]!
  const entityNs = namespaceOfClass(entity.tag)
  const entityId = getAttr(entity, 'id')?.value ?? ''

  for (let i = path.length - 1; i >= 0; i--) {
    const a = attrAt(path[i]!, offset)
    if (!a) continue
    if (a.name === 'id' && i === 0)
      return entityNs ? { namespace: entityNs, id: entityId } : undefined
    if (a.name === 'parent')
      return entityNs && a.value ? { namespace: entityNs, id: a.value } : undefined
    if (i >= 1 && (a.name === 'value' || a.name === 'Link') && a.value) {
      const parentSchema = schemaForPath(path.slice(0, i))
      const ft = parentSchema ? lookupField(parentSchema, path[i]!.tag) : undefined
      if (ft !== undefined) {
        const t = linkTargetOf(attrType(classifyField(ft), a.name), a.value)
        if (t) return t
      }
      return undefined
    }
    // Instruction scalars (actor `Send`/`Terms`, `Key`, …): resolve the specific arg token
    // under the cursor to its entity, so go-to-definition works from inside the value.
    if (a.value) {
      const elemSchema = schemaForPath(path.slice(0, i + 1))
      const ft = elemSchema ? lookupField(elemSchema, a.name) : undefined
      const info = ft !== undefined ? classifyField(ft) : undefined
      if (info?.kind === 'instructions' && info.instructions && info.instructionDelimiter === ' ') {
        return instructionTargetAt(info, a, offset)
      }
    }
    return undefined
  }

  // Not on an attribute — on the entity's tag name counts as the entity itself.
  if (offset > entity.tagStart - 1 && offset <= entity.tagEnd && entityNs) {
    return { namespace: entityNs, id: entityId }
  }
  return undefined
}

/** Turn a link/catalogRef FieldInfo + value into a navigable (namespace, id), or undefined. */
function linkTargetOf(info: FieldInfo | undefined, value: string): RefTarget | undefined {
  if (info?.kind === 'link' && info.linkNamespace && !info.isTextLink && !info.isFileLink)
    return { namespace: info.linkNamespace, id: value }
  if (info?.kind === 'catalogRef') {
    const parts = value.split(',')
    if (parts.length >= 2 && parts[0] && parts[1]) return { namespace: parts[0], id: parts[1] }
  }
  return undefined
}

/**
 * Resolve the instruction arg (or fallback link) under `offset` inside attr `a` to a
 * target. Shared by find-references (`referenceTargetAt`) and go-to-definition
 * (`definitionRequestAt`) so both navigate actor-message/term args identically.
 */
export function instructionTargetAt(
  info: FieldInfo,
  a: ScannedAttr,
  offset: number,
): RefTarget | undefined {
  if (info.instructionListDelimiter) {
    // Narrow to the single instruction segment the cursor is in, then resolve within it.
    const rel = offset - a.valueStart
    const seg = splitWithOffsets(a.value, info.instructionListDelimiter).find(
      s => rel >= s.start && rel <= s.start + s.text.length,
    )
    if (!seg) return undefined
    return instructionSegmentTargetAt(
      info,
      { ...a, value: seg.text, valueStart: a.valueStart + seg.start },
      offset,
    )
  }
  return instructionSegmentTargetAt(info, a, offset)
}

/** Resolve a target within a single (already list-split) instruction segment. */
function instructionSegmentTargetAt(
  info: FieldInfo,
  a: ScannedAttr,
  offset: number,
): RefTarget | undefined {
  const tokens = tokenizeInstruction(a.value)
  if (tokens.length === 0) return undefined
  const rel = offset - a.valueStart
  const idx = tokens.findIndex(t => rel >= t.start && rel <= t.start + t.text.length)
  if (idx < 0) return undefined
  const argInfos = info.instructions!.get(tokens[0]!.text)
  if (!argInfos) {
    // Unknown keyword → whole value is the fallback link (per-class), if any.
    const fb = info.instructionFallback
    return fb && !tokens[0]!.text.startsWith('::') ? linkTargetOf(fb, a.value) : undefined
  }
  if (idx === 0) return undefined // on the keyword itself
  const argInfo = argInfos[idx - 1]
  const tok = tokens[idx]!
  if (!argInfo || tok.text.startsWith('{') || tok.text.startsWith('::')) return undefined
  return linkTargetOf(argInfo, tok.text)
}

/** Every definition / parent / link reference in `text`, with source ranges. */
export function collectAllRefs(text: string): RefMatch[] {
  const out: RefMatch[] = []
  const classes = new Map<string, ReturnType<typeof getClassFields>>()
  const fields = new Map<unknown, FieldInfo>()
  const classify: typeof classifyField = type => {
    let info = fields.get(type)
    if (info === undefined) {
      info = classifyField(type)
      fields.set(type, info)
    }
    return info
  }
  for (const entity of catalogEntities(scanXml(text))) {
    const entityNs = namespaceOfClass(entity.tag)
    if (entityNs) {
      const idAttr = getAttr(entity, 'id')
      if (idAttr) {
        out.push({
          namespace: entityNs,
          id: idAttr.value,
          start: idAttr.valueStart,
          end: idAttr.valueEnd,
          kind: 'definition',
        })
      }
      const parentAttr = getAttr(entity, 'parent')
      if (parentAttr?.value) {
        out.push({
          namespace: entityNs,
          id: parentAttr.value,
          start: parentAttr.valueStart,
          end: parentAttr.valueEnd,
          kind: 'parent',
        })
      }
    }
    if (!classes.has(entity.tag)) classes.set(entity.tag, getClassFields(entity.tag))
    const schema = classes.get(entity.tag)
    if (schema) walk(entity, schema, out, 0, classify)
  }
  return out
}

/** References to a single (namespace, id) target; declarations included optionally. */
export function findReferences(
  text: string,
  target: RefTarget,
  includeDeclaration: boolean,
): RefMatch[] {
  return collectAllRefs(text).filter(
    m =>
      m.namespace === target.namespace &&
      m.id === target.id &&
      (includeDeclaration || m.kind !== 'definition'),
  )
}

/** Split on a delimiter, returning each non-empty segment with its start offset. */
function splitWithOffsets(value: string, delim: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = []
  let start = 0
  for (let i = 0; i <= value.length; i++) {
    if (i === value.length || value[i] === delim) {
      if (i > start) out.push({ text: value.slice(start, i), start })
      start = i + 1
    }
  }
  return out
}

/** Split a space-delimited instruction value into positioned tokens, keeping `{…}` groups. */
function tokenizeInstruction(value: string): Array<{ text: string; start: number }> {
  const tokens: Array<{ text: string; start: number }> = []
  let i = 0
  while (i < value.length) {
    while (i < value.length && value[i] === ' ') i++
    if (i >= value.length) break
    const start = i
    if (value[i] === '{') {
      let depth = 0
      do {
        if (value[i] === '{') depth++
        else if (value[i] === '}') depth--
        i++
      } while (i < value.length && depth > 0)
    } else {
      while (i < value.length && value[i] !== ' ') i++
    }
    tokens.push({ text: value.slice(start, i), start })
  }
  return tokens
}

/** Extract link/catalogRef edges from ONE instruction segment (keyword + args). */
function collectInstruction(attr: ScannedAttr, info: FieldInfo, out: RefMatch[]): void {
  const tokens = tokenizeInstruction(attr.value)
  if (tokens.length === 0) return
  const argInfos = info.instructions!.get(tokens[0]!.text)
  if (!argInfos) {
    // Unknown keyword but the class falls back to a plain link for the whole value
    // (e.g. `CActorKey → CActorLink`): record that edge so it's navigable.
    const fb = info.instructionFallback
    if (fb && (fb.kind === 'link' || fb.kind === 'catalogRef') && !tokens[0]!.text.startsWith('::'))
      collectLink(attr, fb, out)
    return
  }
  for (let a = 0; a < argInfos.length && a + 1 < tokens.length; a++) {
    const argInfo = argInfos[a]!
    const tok = tokens[a + 1]!
    if (tok.text.startsWith('{') || tok.text.startsWith('::')) continue
    if (argInfo.kind === 'link' || argInfo.kind === 'catalogRef') {
      collectLink(
        {
          ...attr,
          value: tok.text,
          valueStart: attr.valueStart + tok.start,
          valueEnd: attr.valueStart + tok.start + tok.text.length,
        },
        argInfo,
        out,
      )
    }
  }
}

function collectLink(attr: ScannedAttr, info: FieldInfo, out: RefMatch[]): void {
  if (!attr.value) return
  // Instruction scalars (actor messages/terms): extract the entity/catalog references
  // embedded in a KNOWN message's simple args, with per-token offsets, so relation-graph
  // and find-references see e.g. an actor's ModelSwap → Model edge. A list-delimited field
  // (e.g. `;`-separated actor terms) is split into segments first.
  if (info.kind === 'instructions' && info.instructions && info.instructionDelimiter === ' ') {
    if (info.instructionListDelimiter) {
      for (const seg of splitWithOffsets(attr.value, info.instructionListDelimiter)) {
        collectInstruction(
          {
            ...attr,
            value: seg.text,
            valueStart: attr.valueStart + seg.start,
            valueEnd: attr.valueStart + seg.start + seg.text.length,
          },
          info,
          out,
        )
      }
    } else {
      collectInstruction(attr, info, out)
    }
    return
  }
  if (info.kind === 'link') {
    if (info.isTextLink || info.isFileLink || !info.linkNamespace) return
    out.push({
      namespace: info.linkNamespace,
      id: attr.value,
      start: attr.valueStart,
      end: attr.valueEnd,
      kind: 'link',
    })
    return
  }
  if (info.kind === 'catalogRef') {
    // "Namespace,Entry[,Field]" — point the match at the Entry segment.
    const parts = attr.value.split(',')
    if (parts.length < 2 || !parts[0] || !parts[1]) return
    const entryStart = attr.valueStart + parts[0]!.length + 1
    out.push({
      namespace: parts[0]!,
      id: parts[1]!,
      start: entryStart,
      end: entryStart + parts[1]!.length,
      kind: 'link',
    })
  }
}

function walk(
  el: ScannedElement,
  schema: Record<string, unknown>,
  out: RefMatch[],
  depth: number,
  classify: typeof classifyField,
): void {
  if (depth > MAX_DEPTH) return
  for (const attr of el.attrs) {
    if (STRUCTURAL_ATTRS.has(attr.name)) continue
    const ft = lookupField(schema, attr.name)
    if (ft !== undefined) collectLink(attr, classify(ft), out)
  }
  for (const child of el.children) {
    const ft = lookupField(schema, child.tag)
    if (ft === undefined) continue
    descend(child, classify(ft), out, depth + 1, classify)
  }
}

function descend(
  el: ScannedElement,
  info: FieldInfo,
  out: RefMatch[],
  depth: number,
  classify: typeof classifyField,
): void {
  switch (info.kind) {
    case 'link':
    case 'catalogRef': {
      const va = el.attrs.find(a => a.name === 'value') ?? el.attrs.find(a => a.name === 'Link')
      if (va) collectLink(va, info, out)
      return
    }
    case 'struct':
      if (info.nested) walk(el, info.nested, out, depth, classify)
      return
    case 'array':
    case 'record': {
      const item = classify(info.itemType)
      if (item.kind === 'struct' && item.nested) walk(el, item.nested, out, depth, classify)
      else descend(el, item, out, depth, classify)
      return
    }
    default:
      return
  }
}
