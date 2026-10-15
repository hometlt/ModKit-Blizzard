/**
 * Where a small wizard edit lands, in source characters.
 *
 * A wizard is written by hand and by SC2Editor, and the two disagree about everything cosmetic:
 * the editor reorders children, re-indents, adds empty `<layout/>` and drops comments when it saves
 * (see fixtures/editor-saved-export.BlizWiz). A Modkit edit therefore replaces exactly one value —
 * an attribute between its quotes, or the text of a leaf element — and never re-serializes, so a
 * file differs only where the user edited. Anything that would need a new element or attribute is
 * refused rather than guessed at: there is no shared insertion helper, and indentation is the
 * author's.
 *
 * Paths are semantic, not positional, so they survive the editor's reordering:
 *
 * - `['wizard', W, 'input', I, 'default']`              — `<default value>`
 * - `['wizard', W, 'input', I, 'item', N, 'value'|'text']` — the Nth `<item>` attribute
 * - `['wizard', W, 'macro', M]`                          — macro text
 * - `['wizard', W, 'condition', C, 'value']`             — a named condition's `value`
 * - `['wizard', W, 'entry', N, 'field', F, 'value']`     — the `<value>` text of field F in entry N
 */
import type { Wizard, WizardDocument, WizardNode } from './types.js'

export interface WizardEditTarget {
  /** Source character offsets of the value, excluding quotes and tags. */
  readonly start: number
  readonly end: number
  /** How the new value must be escaped: inside the given quote, or as element text. */
  readonly encoding: { readonly kind: 'attribute'; readonly quote: '"' | "'" } | { readonly kind: 'text' }
  readonly label: string
}

function only<T>(items: readonly T[], what: string): T {
  if (items.length === 0) throw new TypeError(`no ${what} in this wizard file`)
  if (items.length > 1) throw new TypeError(`${what} is declared ${items.length} times; the edit is ambiguous`)
  return items[0] as T
}

function attributeTarget(node: WizardNode, name: string, label: string): WizardEditTarget {
  const attribute = node.attributes.find(item => item.name === name)
  if (attribute === undefined) {
    throw new TypeError(`<${node.tag}> has no ${name} attribute to write; adding one is not supported`)
  }
  const quote = attribute.quote === "'" ? "'" : '"'
  return { start: attribute.valueStart, end: attribute.valueEnd, encoding: { kind: 'attribute', quote }, label }
}

function textTarget(node: WizardNode, label: string): WizardEditTarget {
  if (node.children.length > 0) throw new TypeError(`<${node.tag}> contains elements; only leaf text can be written`)
  if (node.selfClosing) throw new TypeError(`<${node.tag}/> has no text to write; adding a body is not supported`)
  return { start: node.openEnd, end: node.end - node.closeRaw.length, encoding: { kind: 'text' }, label }
}

function index(value: string | undefined, what: string): number {
  const parsed = Number(value)
  if (value === undefined || !Number.isInteger(parsed) || parsed < 0) throw new TypeError(`${what} needs a zero-based index`)
  return parsed
}

/**
 * Every path `locateWizardEditTarget` can write in this document, in document order. Paths whose
 * target would be refused — an ambiguous id, a missing attribute, a self-closing element — are left
 * out, so a caller offering edits never offers one that fails.
 */
export function listWizardEditPaths(document: WizardDocument): string[][] {
  const candidates: string[][] = []
  for (const wizard of document.file.wizards) {
    const base = ['wizard', wizard.id]
    for (const input of wizard.inputs) {
      candidates.push([...base, 'input', input.id, 'default'])
      input.items.forEach((_item, position) => {
        candidates.push([...base, 'input', input.id, 'item', String(position), 'value'])
        candidates.push([...base, 'input', input.id, 'item', String(position), 'text'])
      })
    }
    for (const macro of wizard.macros) candidates.push([...base, 'macro', macro.id])
    for (const condition of wizard.conditions) {
      if (condition.id !== undefined) candidates.push([...base, 'condition', condition.id, 'value'])
    }
    wizard.entries.forEach((entry, position) => {
      for (const field of entry.fields) candidates.push([...base, 'entry', String(position), 'field', field.id, 'value'])
    })
  }
  const seen = new Set<string>()
  return candidates.filter(path => {
    const key = JSON.stringify(path)
    if (seen.has(key)) return false
    seen.add(key)
    try {
      locateWizardEditTarget(document, path)
      return true
    } catch {
      return false
    }
  })
}

export function locateWizardEditTarget(document: WizardDocument, path: readonly string[]): WizardEditTarget {
  const [root, wizardId, kind, ...rest] = path
  if (root !== 'wizard' || wizardId === undefined || kind === undefined) {
    throw new TypeError('an edit path starts with wizard, <wizard id>, then input, macro, condition or entry')
  }
  const wizard: Wizard = only(document.file.wizards.filter(item => item.id === wizardId), `wizard ${wizardId}`)
  const label = path.join('/')

  if (kind === 'input') {
    const [inputId, part, position, attribute] = rest
    const input = only(wizard.inputs.filter(item => item.id === inputId), `input ${inputId ?? ''}`)
    if (part === 'default' && rest.length === 2) {
      return attributeTarget(only(input.node.children.filter(child => child.tag === 'default'), `<default> in input ${input.id}`), 'value', label)
    }
    if (part === 'item' && rest.length === 4 && (attribute === 'value' || attribute === 'text')) {
      const item = input.items[index(position, 'item')]
      if (item === undefined) throw new TypeError(`input ${input.id} has no item ${position}`)
      return attributeTarget(item.node, attribute, label)
    }
  }
  if (kind === 'macro' && rest.length === 1) {
    return textTarget(only(wizard.macros.filter(item => item.id === rest[0]), `macro ${rest[0] ?? ''}`).node, label)
  }
  if (kind === 'condition' && rest.length === 2 && rest[1] === 'value') {
    return attributeTarget(only(wizard.conditions.filter(item => item.id === rest[0]), `condition ${rest[0] ?? ''}`).node, 'value', label)
  }
  if (kind === 'entry' && rest.length === 4 && rest[1] === 'field' && rest[3] === 'value') {
    const entry = wizard.entries[index(rest[0], 'entry')]
    if (entry === undefined) throw new TypeError(`wizard ${wizard.id} has no entry ${rest[0]}`)
    const field = only(entry.fields.filter(item => item.id === rest[2]), `field ${rest[2] ?? ''} in entry ${rest[0]}`)
    return textTarget(only(field.node.children.filter(child => child.tag === 'value'), `<value> in field ${field.id}`), label)
  }
  throw new TypeError(`unsupported edit path ${label}`)
}
