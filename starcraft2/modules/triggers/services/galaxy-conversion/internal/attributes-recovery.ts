/**
 * The document's own lobby attributes (`Attributes`, model in the map module) read from its Galaxy
 * when the document itself is missing: `GameAttributeGameValue("<Id>")` is a global attribute,
 * `GameAttributePlayerValue("<Id>", player)` a player one, and a comparison with a four-digit string
 * names one of its values. An id with a dependency prefix (`[bnet:…]1`) belongs to that dependency.
 *
 * What scripts do not say is written as the editor's default and listed in `inferred`: who may set
 * the attribute, where it is shown, its per-slot defaults and the variants. Names are GameStrings
 * keys (`Attribute<NNN>/Name`), kept when the GameStrings given have them.
 */
import type { AttributeDefinition, AttributesResult } from '../../../../map/shared/format/formats/attributes.js'
import { SyntaxKind } from '@modkit/blizzard-starcraft2/galaxy/language-core'

export interface RecoveredAttributes {
  document: AttributesResult
  /** `<attribute id>/<field>` of every value written without evidence. */
  inferred: string[]
}

interface AttributeEvidence {
  type: 'Global' | 'Player'
  values: Set<string>
}

type Node = { kind: number; [key: string]: unknown }

const stringOf = (node: unknown): string | undefined => {
  const item = node as { kind?: number; value?: string; text?: string } | undefined
  if (item?.kind !== SyntaxKind.StringLiteral) return undefined
  const raw = item.value ?? item.text
  return raw === undefined ? undefined : raw.replace(/^"(.*)"$/su, '$1')
}

const unwrap = (node: unknown): unknown => {
  let item = node as Node | undefined
  while (item?.kind === SyntaxKind.ParenthesizedExpression) item = item['expression'] as Node
  return item
}

type AttributeCall = { id: string; type: 'Global' | 'Player' }

/** The attribute a call reads, or the one a variable was set from (a GUI switch stores it first). */
function attributeCall(node: unknown, bound?: ReadonlyMap<string, AttributeCall>): AttributeCall | undefined {
  const call = unwrap(node) as Node | undefined
  if (call?.kind === SyntaxKind.Identifier) return bound?.get(String(call['name']))
  if (call?.kind !== SyntaxKind.CallExpression) return undefined
  const name = (call['expression'] as { name?: string } | undefined)?.name
  const type = name === 'GameAttributeGameValue' ? 'Global' : name === 'GameAttributePlayerValue' ? 'Player' : undefined
  const id = stringOf((call['arguments'] as unknown[] | undefined)?.[0])
  if (type === undefined || id === undefined || !/^\d+$/u.test(id)) return undefined
  return { id, type }
}

/** First pass (`bound` being filled): variables set from an attribute; second: the reads and comparisons. */
function collect(node: unknown, found: Map<string, AttributeEvidence>, seen: Set<unknown>, bound: Map<string, AttributeCall>, binding: boolean): void {
  if (node === null || typeof node !== 'object' || seen.has(node)) return
  seen.add(node)
  const item = node as Node
  if (binding) {
    const assigned = item.kind === SyntaxKind.BinaryExpression && (item['operatorToken'] as { kind?: number } | undefined)?.kind === SyntaxKind.EqualsToken
      ? [item['left'], item['right']] : item.kind === SyntaxKind.VariableDeclaration ? [item['name'], item['initializer']] : undefined
    const target = assigned === undefined ? undefined : unwrap(assigned[0]) as Node | undefined
    const call = assigned === undefined ? undefined : attributeCall(assigned[1])
    if (call && target?.kind === SyntaxKind.Identifier) bound.set(String(target['name']), call)
  }
  const note = (call: { id: string; type: 'Global' | 'Player' }, value?: string): void => {
    const evidence = found.get(call.id) ?? { type: call.type, values: new Set<string>() }
    found.set(call.id, evidence)
    if (value !== undefined && /^\d{1,4}$/u.test(value)) evidence.values.add(String(Number(value)))
  }
  if (!binding && item.kind === SyntaxKind.CallExpression) {
    const call = attributeCall(item)
    if (call) note(call)
  }
  if (!binding && item.kind === SyntaxKind.BinaryExpression) {
    const operator = (item['operatorToken'] as { kind?: number } | undefined)?.kind
    if (operator === SyntaxKind.EqualsEqualsToken || operator === SyntaxKind.ExclamationEqualsToken) {
      for (const [side, other] of [[item['left'], item['right']], [item['right'], item['left']]] as const) {
        const call = attributeCall(side, bound)
        const value = stringOf(unwrap(other))
        if (call && value !== undefined) note(call, value)
      }
    }
  }
  for (const [key, value] of Object.entries(item)) {
    if (key === 'parent' || key === 'symbol' || key === 'original') continue
    if (Array.isArray(value)) for (const child of value) collect(child, found, seen, bound, binding)
    else if (value !== null && typeof value === 'object' && typeof (value as Node).kind === 'number') collect(value, found, seen, bound, binding)
  }
}

const key = (id: string): string => `Attribute${id.padStart(3, '0')}`

/** The attributes the given files read, or undefined when they read none of the document's own. */
export function recoverAttributes(sources: readonly { statements: readonly unknown[] }[], gameStrings = ''): RecoveredAttributes | undefined {
  const found = new Map<string, AttributeEvidence>()
  const bound = new Map<string, AttributeCall>()
  for (const binding of [true, false]) {
    const seen = new Set<unknown>()
    for (const source of sources) for (const statement of source.statements) collect(statement, found, seen, bound, binding)
  }
  if (found.size === 0) return undefined
  const strings = new Set(gameStrings.split(/\r?\n/u).map(line => (line.charCodeAt(0) === 0xfeff ? line.slice(1) : line).split('=')[0]))
  const inferred: string[] = []
  const attributes: AttributeDefinition[] = [...found]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([id, evidence]) => {
      const name = `${key(id)}/Name`
      const access = evidence.type === 'Global' ? 'Host' : 'Self'
      inferred.push(`${id}/Availability`, `${id}/Visibility`, `${id}/Access`, `${id}/Default`)
      if (evidence.values.size === 0) inferred.push(`${id}/Value`)
      return {
        id,
        type: evidence.type,
        ...(strings.has(name) ? { name } : {}),
        availability: 'All',
        visibility: 'All',
        access,
        values: [...evidence.values].sort((left, right) => Number(left) - Number(right)).map(value => {
          const valueName = `${key(id)}/Value${value.padStart(3, '0')}/Name`
          return { id: value, ...(strings.has(valueName) ? { name: valueName } : {}) }
        }),
        defaults: [],
      }
    })
  inferred.push('DefaultVariants')
  return { document: { attributes, defaultVariants: 0, variants: [] }, inferred }
}
