/**
 * Pure hover/codelens cores for GameData XML — no vscode import, unit-testable.
 *
 * On a field: the **resolved (calculated)** value from the merged parent chain and
 * which ancestor it came from. On an entity: its parent (inheritance) chain. All
 * catalog access goes through the injected `HoverCatalog` (backed by `@modkitx/data-processing/sc2-catalog`
 * `getResolved`/`buildChain` in the extension).
 */

import { scanXml, elementPathAt, getAttr } from './xml-scan.js'
import { entityPath, catalogEntities } from './entity.js'
import { getClassFields, lookupField, classifyField } from '../../catalog-engine/sc2-catalog/index.js'
import { fieldDoc } from './docs.js'

export interface HoverCatalog {
  /** Catalog namespace holding entity `id` declared with class `classTag`. */
  namespaceOf(classTag: string, id: string): string | undefined
  /** Resolved (calculated) value of a top-level field, or undefined. */
  resolvedField(namespace: string, id: string, field: string): unknown
  /** Id of the deepest ancestor (incl. self) whose raw data defines `field`. */
  fieldOrigin(namespace: string, id: string, field: string): string | undefined
  /** Parent chain ids, root → leaf (includes the entity itself). */
  parentChain(namespace: string, id: string): string[]
  /** Count of fields inherited from ancestors (resolved fields not set on the entity). */
  inheritedFieldCount(namespace: string, id: string): number
  /** Provider-owned default/template marker from the canonical entity. */
  defaultTemplate?(namespace: string, id: string): boolean
  /** Effective inherited token declarations from the canonical entity. */
  entityTokens?(
    namespace: string,
    id: string,
  ): readonly { readonly id: string; readonly type?: string; readonly value?: string }[]
}

/** Markdown hover text for the symbol at `offset`, or undefined. */
export function computeHover(
  text: string,
  offset: number,
  cat: HoverCatalog,
  docsBase?: string,
): string | undefined {
  const path = entityPath(elementPathAt(text, offset))
  if (path.length === 0) return undefined

  const entity = path[0]!
  const id = getAttr(entity, 'id')?.value ?? ''
  const ns = cat.namespaceOf(entity.tag, id)
  if (ns === undefined) return undefined // entity not in the loaded catalog

  // Field hover: cursor inside one of the entity's direct fields.
  if (path.length >= 2) {
    const field = path[1]!.tag
    const value = cat.resolvedField(ns, id, field)
    const schema = getClassFields(entity.tag)
    const ft = schema ? lookupField(schema, field) : undefined
    const typeDoc =
      ft !== undefined ? fieldDoc(classifyField(ft), entity.tag, field, docsBase) : undefined
    let head: string
    if (value === undefined) {
      head = `**${field}** — no resolved value`
    } else {
      const origin = cat.fieldOrigin(ns, id, field)
      const from =
        origin && origin !== id
          ? `inherited from \`${origin || '(default)'}\``
          : '_set on this entity_'
      head = `**${field}** = ${formatValue(value)}\n\n${from}`
    }
    return typeDoc ? `${head}\n\n${typeDoc}` : head
  }

  // Entity hover: only on the class tag or the id attribute.
  const onTag = offset > entity.tagStart - 1 && offset <= entity.tagEnd
  const idAttr = getAttr(entity, 'id')
  const onId = idAttr ? offset >= idAttr.valueStart && offset <= idAttr.valueEnd : false
  if (!onTag && !onId) return undefined

  const chain = cat.parentChain(ns, id)
  const label = `**${entity.tag}** \`${id || '(default)'}\` — _${ns}_`
  const details: string[] = []
  if (chain.length > 1) {
    details.push(`Parent chain: ${chain.map(c => `\`${c || '(default)'}\``).join(' → ')}`)
  }
  if (cat.defaultTemplate?.(ns, id) === true) details.push('Default template')
  const tokens = cat.entityTokens?.(ns, id) ?? []
  if (tokens.length > 0) {
    details.push(`Tokens: ${tokens.map(token => `\`${token.id}\``).join(', ')}`)
  }
  return details.length === 0 ? label : `${label}\n\n${details.join('\n\n')}`
}

const MAX_VALUE_LEN = 400

function formatValue(value: unknown): string {
  if (typeof value === 'string') return `\`${value}\``
  const json = JSON.stringify(value)
  const body = json.length > MAX_VALUE_LEN ? `${json.slice(0, MAX_VALUE_LEN)}…` : json
  return `\n\`\`\`json\n${body}\n\`\`\``
}

/** One codelens per top-level entity that has a parent chain (id + chain string). */
export interface EntityLens {
  /** Offset of the entity's opening `<` (where the lens anchors). */
  start: number
  id: string
  namespace: string
  classTag: string
  /** Parent chain ids root → leaf (length ≥ 2 only). */
  chain: string[]
  /** Immediate parent id (chain[-2]). */
  parent: string
  /** Number of fields inherited from ancestors. */
  inherited: number
}

export function computeEntityLenses(text: string, cat: HoverCatalog): EntityLens[] {
  const out: EntityLens[] = []
  for (const el of catalogEntities(scanXml(text))) {
    const id = getAttr(el, 'id')?.value ?? ''
    const ns = cat.namespaceOf(el.tag, id)
    if (ns === undefined) continue
    const chain = cat.parentChain(ns, id)
    if (chain.length <= 1) continue
    out.push({
      start: el.start,
      id,
      namespace: ns,
      classTag: el.tag,
      chain,
      parent: chain[chain.length - 2] ?? '',
      inherited: cat.inheritedFieldCount(ns, id),
    })
  }
  return out
}
