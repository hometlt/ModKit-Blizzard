/**
 * Catalog entity → SC2 GameData XML serialization (Phase D item 3, moved here verbatim from
 * `@modkitx/export`'s `xml-write.ts`).
 *
 * This is entity-level, not mod-level: it turns one `CatalogEntity`'s raw fields back into the
 * `<CUnit id="…">…</CUnit>` element the catalog parser produced them from, and knows nothing
 * about mod layout, `ComponentList.SC2Components`, locales, or opaque files. `sc2-mod` owns
 * that composition; `@modkitx/export` remains a compatibility facade.
 *
 * Round-trip rules (inverse of parseCatalogXml):
 *   - scalar string → attribute value="X" when the field name is a known attribute,
 *     otherwise a child element <Field value="X"/>
 *   - scalar that came from a sole value="" attribute → <Field value="X"/>
 *   - object → child element with attributes + nested children
 *   - array → repeated child elements, one per entry
 *
 * SC2 conventions preserved:
 *   - index arrays: <Field index="N" ...attributes/>
 *   - named arrays: <Field id="name" .../>
 *   - plain arrays: <Field value="X"/> repeated
 */

import type { RawFields, RawValue, RawObject, RawArray } from '../catalog-engine/xml/index.js'

const INLINE_ATTRS = new Set(['index', 'id', 'value', 'Link', 'Type', 'Base'])

/**
 * Serialise a <const> catalog entry in SC2 format:
 * <const id="$Token" type="CType" value="..."/>
 * Used for the Const namespace — const entries use lowercase tag with attrs, not child elements.
 */
export function constEntryToXml(id: string, type: string, value: string, indent: string): string {
  return `${indent}<const id="${escapeAttr(id)}" type="${escapeAttr(type)}" value="${escapeAttr(value)}"/>`
}

export interface XmlWriteOptions {
  indent: string
  writeDefaultAttr: boolean
}

export function entityToXml(
  className: string,
  id: string,
  parent: string | undefined,
  data: RawFields,
  isDefault: boolean,
  opts: XmlWriteOptions,
): string {
  const { indent } = opts
  const lines: string[] = []

  // Opening tag attributes
  const tagAttrs: string[] = []
  if (isDefault && opts.writeDefaultAttr) tagAttrs.push('default="1"')
  tagAttrs.push(`id="${escapeAttr(id)}"`)
  if (parent !== undefined) tagAttrs.push(`parent="${escapeAttr(parent)}"`)

  const childIndent = indent + indent
  const children = fieldsToXml(data, indent, childIndent)

  if (children.length === 0) {
    lines.push(`${indent}<${className} ${tagAttrs.join(' ')}/>`)
  } else {
    lines.push(`${indent}<${className} ${tagAttrs.join(' ')}>`)
    lines.push(...children)
    lines.push(`${indent}</${className}>`)
  }

  return lines.join('\n')
}

function fieldsToXml(fields: RawFields, baseIndent: string, indent: string): string[] {
  const lines: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    lines.push(...fieldToXml(key, value, baseIndent, indent))
  }
  return lines
}

function fieldToXml(key: string, value: RawValue, baseIndent: string, indent: string): string[] {
  if (Array.isArray(value)) {
    return arrayFieldToXml(key, value as RawArray, baseIndent, indent)
  }
  if (typeof value === 'object' && value !== null) {
    return objectFieldToXml(key, value as RawObject, baseIndent, indent)
  }
  // Scalar
  return [`${indent}<${key} value="${escapeAttr(value as string)}"/>`]
}

function arrayFieldToXml(key: string, arr: RawArray, baseIndent: string, indent: string): string[] {
  const lines: string[] = []
  for (const item of arr) {
    if (typeof item === 'string') {
      lines.push(`${indent}<${key} value="${escapeAttr(item)}"/>`)
    } else if (Array.isArray(item)) {
      // Nested array — unusual, treat as repeated element
      for (const inner of item as RawArray) {
        lines.push(...fieldToXml(key, inner, baseIndent, indent))
      }
    } else {
      lines.push(...objectFieldToXml(key, item as RawObject, baseIndent, indent))
    }
  }
  return lines
}

function objectFieldToXml(
  key: string,
  obj: RawObject,
  baseIndent: string,
  indent: string,
): string[] {
  // Separate inline attributes (index, id, value, Link, etc.) from nested children
  const attrs: string[] = []
  const nested: Record<string, RawValue> = {}

  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && isInlineAttr(k)) {
      attrs.push(`${k}="${escapeAttr(v)}"`)
    } else {
      nested[k] = v
    }
  }

  const hasNested = Object.keys(nested).length > 0
  const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : ''
  const childIndent = indent + baseIndent

  if (!hasNested) {
    return [`${indent}<${key}${attrStr}/>`]
  }

  const lines: string[] = []
  lines.push(`${indent}<${key}${attrStr}>`)
  lines.push(...fieldsToXml(nested, baseIndent, childIndent))
  lines.push(`${indent}</${key}>`)
  return lines
}

function isInlineAttr(key: string): boolean {
  // Lower-case first char is almost certainly an attribute in SC2 XML
  // (SC2 uses PascalCase for child elements, camelCase/lowercase for attributes)
  if (INLINE_ATTRS.has(key)) return true
  if (key.length > 0 && key[0] === key[0]!.toLowerCase()) return true
  return false
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
