/**
 * Reading a `.BlizWiz` file.
 *
 * The grammar here is Blizzard's, taken from `mods/core.sc2mod/base.sc2data/editordata/wizardhelp/
 * fileformat.rtf` — the format specification the game ships with itself. Nothing in this file is
 * inferred from a corpus: the game contains the documentation and not one wizard, and the
 * author-written wizards in `test/fixtures/corpus.json` confirm the grammar rather than define it.
 *
 * Element and attribute names are matched exactly as documented by default. An explicit
 * compatibility option can recognize observed root variants, but it never rewrites the source
 * spelling and the analyzer still reports the non-canonical form.
 */
import { decodeXmlEntities, scanXml, type ScannedElement } from '@modkit/codec-kit'
import type {
  Wizard,
  WizardAttribute,
  WizardCondition,
  WizardDocument,
  WizardEntry,
  WizardEntryField,
  WizardEntryToken,
  WizardFile,
  WizardInput,
  WizardInputItem,
  WizardInstructions,
  WizardLayout,
  WizardMacro,
  WizardNode,
  WizardObjectTypes,
  WizardParseOptions,
  WizardValidate,
} from './types.js'

/** The root element the specification requires. Compatibility roots are opt-in. */
export const WIZARD_ROOT_TAG = 'wizardfile'

/** Cheap enough for a 4 KB probe, and it answers the only question detection asks. */
export function looksLikeWizardFile(
  text: string,
  options: WizardParseOptions = {},
): boolean {
  const flags = options.caseInsensitiveRoot ? 'iu' : 'u'
  const root = new RegExp('<wizardfile(?:\\s|>|\\/)', flags)
  if (root.test(text)) return true
  if (!options.allowStandaloneWizard) return false
  return new RegExp('<wizard(?:\\s|>|\\/)', flags).test(text)
}

function attributesOf(text: string, element: ScannedElement): WizardAttribute[] {
  const attributes: WizardAttribute[] = []
  let cursor = element.tagEnd
  for (const attribute of element.attrs) {
    const quoteIndex = attribute.valueStart - 1
    attributes.push({
      lead: text.slice(cursor, attribute.nameStart),
      name: attribute.name,
      separator: text.slice(attribute.nameEnd, quoteIndex),
      quote: text.slice(quoteIndex, attribute.valueStart),
      raw: text.slice(attribute.valueStart, attribute.valueEnd),
      value: attribute.value,
      nameStart: attribute.nameStart,
      valueStart: attribute.valueStart,
      valueEnd: attribute.valueEnd,
    })
    cursor = attribute.valueEnd + 1
  }
  return attributes
}

function buildNode(text: string, element: ScannedElement, gapStart: number): WizardNode {
  const attributes = attributesOf(text, element)
  const selfClosing = element.openEnd === element.end
  const lastAttributeEnd =
    attributes.length === 0 ? element.tagEnd : (attributes.at(-1) as WizardAttribute).valueEnd + 1
  const children: WizardNode[] = []
  let cursor = element.openEnd
  for (const child of element.children) {
    children.push(buildNode(text, child, cursor))
    cursor = child.end
  }
  /*
   * The scanner reports where an element ends but not where its closing tag begins, and the body
   * text between the two is exactly what this format puts its evaluated expressions in. XML forbids
   * a literal `<` in text, so the last `</` before the end is the closing tag and nothing else can
   * be. An unclosed element — the scanner recovers from those rather than refusing — has no such
   * tag, and is treated as having an empty body rather than swallowing its parent's text.
   *
   * The search starts two characters back from the end, not at it: `String.lastIndexOf` will match
   * at the position it is given, and `</value></field>` ends exactly where `</field>` begins. That
   * off-by-two put a closing tag inside the text of the element before it — invisible to a
   * round-trip check, which reassembles the same bytes either way, and immediately visible to
   * anything that reads the text.
   */
  const closeStart = selfClosing ? element.end : text.lastIndexOf('</', element.end - 2)
  const bodyEnd = closeStart >= cursor ? closeStart : element.end
  return {
    tag: element.tag,
    attributes,
    children,
    gapBefore: text.slice(gapStart, element.start),
    openTrailing: text.slice(lastAttributeEnd, element.openEnd - (selfClosing ? 2 : 1)),
    selfClosing,
    innerTail: selfClosing ? '' : text.slice(cursor, bodyEnd),
    closeRaw: selfClosing ? '' : text.slice(bodyEnd, element.end),
    start: element.start,
    openEnd: element.openEnd,
    end: element.end,
  }
}

/** The element's own text, entity-decoded. Elements with children carry no meaningful text here. */
export function nodeText(node: WizardNode): string {
  return node.children.length === 0 ? decodeXmlEntities(node.innerTail) : ''
}

function attribute(node: WizardNode, name: string): string | undefined {
  return node.attributes.find(item => item.name === name)?.value
}

function childrenNamed(node: WizardNode, tag: string): WizardNode[] {
  return node.children.filter(child => child.tag === tag)
}

function childNamed(node: WizardNode, tag: string): WizardNode | undefined {
  return node.children.find(child => child.tag === tag)
}

function childText(node: WizardNode, tag: string): string | undefined {
  const child = childNamed(node, tag)
  return child === undefined ? undefined : nodeText(child)
}

/** A `value=` attribute on a child element — the shape `default`, `minimum` and friends use. */
function childValue(node: WizardNode, tag: string): string | undefined {
  const child = childNamed(node, tag)
  return child === undefined ? undefined : (attribute(child, 'value') ?? nodeText(child))
}

function flagPresent(node: WizardNode, tag: string): boolean {
  return childNamed(node, tag) !== undefined
}

function semicolonList(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(';')
    .map(item => item.trim())
    .filter(item => item !== '')
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Remove the indentation the author used to keep the element readable.
 *
 * The specification states this for `instructions`: the text "is expected to be indented within the
 * element" and "this indenting will be removed when parsing the file". Reproducing it matters
 * because the dedented text is what the dialog shows, and a surface here that showed the indented
 * form would be showing something the editor never does.
 */
export function dedentInstructions(value: string): string {
  const lines = value.replace(/\r\n/gu, '\n').split('\n')
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift()
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
  const indents = lines
    .filter(line => line.trim() !== '')
    .map(line => (/^[ \t]*/u.exec(line)?.[0] ?? '').length)
  const common = indents.length === 0 ? 0 : Math.min(...indents)
  return lines.map(line => line.slice(common)).join('\n')
}

function readCondition(node: WizardNode): WizardCondition {
  return {
    node,
    ...(attribute(node, 'id') === undefined ? {} : { id: attribute(node, 'id') }),
    ...(attribute(node, 'input') === undefined ? {} : { input: attribute(node, 'input') }),
    ...(attribute(node, 'value') === undefined ? {} : { value: attribute(node, 'value') }),
    ...(attribute(node, 'match') === undefined ? {} : { match: attribute(node, 'match') }),
    ...(attribute(node, 'operator') === undefined ? {} : { operator: attribute(node, 'operator') }),
    ...(attribute(node, 'nocase') === undefined ? {} : { nocase: attribute(node, 'nocase') }),
    ...(attribute(node, 'empty') === undefined ? {} : { empty: attribute(node, 'empty') }),
    ...(attribute(node, 'visible') === undefined ? {} : { visible: attribute(node, 'visible') }),
    logic: attribute(node, 'logic') ?? 'and',
    children: childrenNamed(node, 'condition').map(readCondition),
  }
}

const INPUT_CHILD_TAGS = new Set([
  'name',
  'tooltip',
  'item',
  'sorted',
  'simpletext',
  'color',
  'default',
  'minimum',
  'maximum',
  'increment',
  'loadvalue',
  'reloadfrom',
  'nosave',
  'nopreview',
  'layout',
  'condition',
])

function readLayout(node: WizardNode | undefined): WizardLayout {
  if (node === undefined) return { page: 1, column: 1 }
  const minheight = attribute(node, 'minheight')
  const minwidth = attribute(node, 'minwidth')
  return {
    page: positiveInteger(attribute(node, 'page'), 1),
    column: positiveInteger(attribute(node, 'column'), 1),
    ...(minheight === undefined ? {} : { minheight }),
    ...(minwidth === undefined ? {} : { minwidth }),
  }
}

function readItem(node: WizardNode): WizardInputItem {
  const value = attribute(node, 'value')
  const text = attribute(node, 'text')
  const count = attribute(node, 'count')
  return {
    node,
    ...(value === undefined ? {} : { value }),
    ...(text === undefined ? {} : { text }),
    ...(count === undefined ? {} : { count }),
  }
}

function readInput(node: WizardNode): WizardInput {
  const optional = {
    name: childText(node, 'name'),
    tooltip: childText(node, 'tooltip'),
    color: childValue(node, 'color'),
    default: childValue(node, 'default'),
    minimum: childValue(node, 'minimum'),
    maximum: childValue(node, 'maximum'),
    increment: childValue(node, 'increment'),
    loadvalue: childText(node, 'loadvalue'),
  }
  return {
    node,
    id: attribute(node, 'id') ?? '',
    type: attribute(node, 'type') ?? '',
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    items: childrenNamed(node, 'item').map(readItem),
    sorted: flagPresent(node, 'sorted'),
    simpletext: flagPresent(node, 'simpletext'),
    reloadfrom: semicolonList(childText(node, 'reloadfrom')),
    nosave: flagPresent(node, 'nosave'),
    nopreview: flagPresent(node, 'nopreview'),
    layout: readLayout(childNamed(node, 'layout')),
    conditions: childrenNamed(node, 'condition').map(readCondition),
    unknown: node.children.filter(child => !INPUT_CHILD_TAGS.has(child.tag)),
  } as WizardInput
}

function readValidate(node: WizardNode): WizardValidate {
  const text = childText(node, 'text')
  return {
    node,
    type: attribute(node, 'type') ?? '',
    conditions: childrenNamed(node, 'condition').map(readCondition),
    ...(text === undefined ? {} : { text }),
  }
}

function readMacro(node: WizardNode): WizardMacro {
  const replaceSrc = attribute(node, 'replaceSrc')
  const replaceDst = attribute(node, 'replaceDst')
  return {
    node,
    id: attribute(node, 'id') ?? '',
    text: nodeText(node),
    ...(replaceSrc === undefined ? {} : { replaceSrc }),
    ...(replaceDst === undefined ? {} : { replaceDst }),
    truncate: Number.parseInt(attribute(node, 'truncate') ?? '0', 10) || 0,
  }
}

const FIELD_CHILD_TAGS = new Set([
  'value',
  'stringid',
  'count',
  'index',
  'loadinput',
  'cache',
  'condition',
])

function readField(node: WizardNode): WizardEntryField {
  const optional = {
    value: childText(node, 'value'),
    stringid: childText(node, 'stringid'),
    count: childText(node, 'count'),
    index: childText(node, 'index'),
    loadinput: childText(node, 'loadinput'),
  }
  return {
    node,
    id: attribute(node, 'id') ?? '',
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    cache: flagPresent(node, 'cache'),
    conditions: childrenNamed(node, 'condition').map(readCondition),
    unknown: node.children.filter(child => !FIELD_CHILD_TAGS.has(child.tag)),
  } as WizardEntryField
}

function readToken(node: WizardNode): WizardEntryToken {
  const value = childText(node, 'value')
  const loadinput = childText(node, 'loadinput')
  return {
    node,
    id: attribute(node, 'id') ?? '',
    ...(value === undefined ? {} : { value }),
    ...(loadinput === undefined ? {} : { loadinput }),
    conditions: childrenNamed(node, 'condition').map(readCondition),
  }
}

const ENTRY_CHILD_TAGS = new Set([
  'id',
  'useloaded',
  'allowmodify',
  'parentid',
  'count',
  'condition',
  'field',
  'token',
])

function readEntry(node: WizardNode): WizardEntry {
  const optional = {
    id: childText(node, 'id'),
    parentid: childText(node, 'parentid'),
    count: childText(node, 'count'),
  }
  return {
    node,
    catalog: attribute(node, 'catalog') ?? '',
    type: attribute(node, 'type') ?? '',
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    useloaded: flagPresent(node, 'useloaded'),
    allowmodify: flagPresent(node, 'allowmodify'),
    conditions: childrenNamed(node, 'condition').map(readCondition),
    fields: childrenNamed(node, 'field').map(readField),
    tokens: childrenNamed(node, 'token').map(readToken),
    unknown: node.children.filter(child => !ENTRY_CHILD_TAGS.has(child.tag)),
  } as WizardEntry
}

function readObjectTypes(node: WizardNode): WizardObjectTypes {
  return {
    node,
    create: semicolonList(attribute(node, 'create')),
    load: semicolonList(attribute(node, 'load')),
    view: semicolonList(attribute(node, 'view')),
  }
}

function readInstructions(node: WizardNode): WizardInstructions {
  return {
    node,
    page: positiveInteger(attribute(node, 'page'), 1),
    text: dedentInstructions(nodeText(node)),
  }
}

const WIZARD_CHILD_TAGS = new Set([
  'name',
  'description',
  'category',
  'hidden',
  'objecttypes',
  'instructions',
  'condition',
  'input',
  'validate',
  'macro',
  'entry',
])

function readWizard(node: WizardNode): Wizard {
  const objecttypes = childNamed(node, 'objecttypes')
  const optional = {
    name: childText(node, 'name'),
    description: childText(node, 'description'),
    category: childText(node, 'category'),
  }
  return {
    node,
    id: attribute(node, 'id') ?? '',
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    hidden: flagPresent(node, 'hidden'),
    ...(objecttypes === undefined ? {} : { objecttypes: readObjectTypes(objecttypes) }),
    instructions: childrenNamed(node, 'instructions').map(readInstructions),
    conditions: childrenNamed(node, 'condition').map(readCondition),
    inputs: childrenNamed(node, 'input').map(readInput),
    validates: childrenNamed(node, 'validate').map(readValidate),
    macros: childrenNamed(node, 'macro').map(readMacro),
    entries: childrenNamed(node, 'entry').map(readEntry),
    unknown: node.children.filter(child => !WIZARD_CHILD_TAGS.has(child.tag)),
  } as Wizard
}

function readFile(roots: readonly WizardNode[], options: WizardParseOptions): WizardFile {
  const matches = (node: WizardNode, tag: string): boolean =>
    options.caseInsensitiveRoot ? node.tag.toLowerCase() === tag : node.tag === tag
  const root = roots.find(node => matches(node, WIZARD_ROOT_TAG))
  if (root !== undefined) {
    return {
      root,
      rootKind: 'wizardfile',
      wizards: childrenNamed(root, 'wizard').map(readWizard),
      unknown: root.children.filter(child => child.tag !== 'wizard'),
    }
  }
  if (!options.allowStandaloneWizard) return { wizards: [], unknown: [...roots] }
  const standalone = roots.filter(node => matches(node, 'wizard'))
  if (standalone.length === 0) return { wizards: [], unknown: [...roots] }
  return {
    root: standalone[0],
    rootKind: 'standalone-wizard',
    wizards: standalone.map(readWizard),
    unknown: roots.filter(node => !matches(node, 'wizard')),
  }
}

/**
 * Parse a wizard file into both layers of the model.
 *
 * This never throws. A truncated or half-written file still produces a document, because the
 * surfaces above — the tree, the checker, the editor — are most useful exactly when the file is
 * wrong, and a parser that refuses one has nothing to say at that moment. Compatibility root
 * handling is opt-in so the default remains the documented grammar.
 */
export function parseWizardDocument(
  text: string,
  options: WizardParseOptions = {},
): WizardDocument {
  const scanned = scanXml(text)
  const roots: WizardNode[] = []
  let cursor = 0
  for (const element of scanned) {
    roots.push(buildNode(text, element, cursor))
    cursor = element.end
  }
  return { text, roots, epilogue: text.slice(cursor), file: readFile(roots, options) }
}
