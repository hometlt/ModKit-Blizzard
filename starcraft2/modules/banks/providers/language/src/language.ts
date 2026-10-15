/**
 * Language services for `sc2-bank`, over `common.language/document-analysis@1`.
 *
 * MK2 had no language services for banks — its `sc2-bank` codec has no `language` directory at all,
 * unlike sc2-data, sc2-layout, galaxy and sc2-strings. So this is new work rather than a port. What
 * *is* ported, unchanged, is the schema it checks against: the vocabulary of value types, the shape
 * each type accepts and the structural rules all come from MK2's `sc2-bank/src/core/validate.ts`,
 * so a document this provider calls valid is one the MK2 validator called valid.
 *
 * Two facts about the format drive the design.
 *
 * The value's type is the attribute *name*, not an attribute value: a bank writes
 * `<Value int="9999999"/>`, never `<Value type="int" .../>`. Completion therefore fires on the
 * attribute name position inside a `Value` element, which is also the only place the six types are
 * meaningful.
 *
 * Section and key names are the map's, not the format's. Nothing in a bank file declares which keys
 * a given map expects, so this provider completes names already present in the document and does
 * not invent a vocabulary it cannot know. Reading the real names out of a mod's Galaxy code is a
 * separate, larger piece of work and is deliberately not faked here.
 */
import { elementPathAt, scanXml, type ScannedElement as KitElement } from '@modkit/codec-kit'
import type {
  LanguageAnalysis,
  LanguageAnalysisRequest,
  LanguageDiagnostic,
  LanguageDiagnosticList,
  LanguageCodeActionsRequest,
  LanguageFeatureRequest,
  LanguageFormattingRequest,
  LanguagePosition,
  LanguagePositionRequest,
  LanguageProvider,
  LanguageCompletionList,
  LanguageRange,
  LanguageSymbol,
  LanguageToken,
  LanguageDocumentSymbolList,
  LanguageHover,
  LanguageLocation,
  LanguageLocationList,
  LanguageReferencesRequest,
  LanguageRenamePreparation,
  LanguageRenameRequest,
  LanguageTextEdit,
  LanguageTextEditList,
  LanguageWorkspaceEdit,
} from '@modkit/sdk'
import {
  finalNewlineCodeActions,
  finalNewlineFormatting,
} from '../../../../../shared/language/code-actions.js'

export const SC2_BANK_LANGUAGE_ID = 'sc2-bank'

/** Ported verbatim from MK2 `validate.ts`: the six types a bank value may declare. */
export const BANK_VALUE_TYPES = Object.freeze([
  'int',
  'fixed',
  'string',
  'flag',
  'text',
  'point',
] as const)

export type BankValueType = (typeof BANK_VALUE_TYPES)[number]

/**
 * The element vocabulary of a bank, and what each element may carry.
 *
 * A bank is a closed format, not free XML: five elements, each with a fixed parent and a fixed set
 * of attributes. Publishing that as data rather than scattering it through the checks means the
 * completion list and the diagnostics cannot drift apart — both read this table.
 *
 * `Value` is the exception in shape: its attribute *name* is the value's type, so its permitted
 * attributes are the six bank value types rather than a list of fixed names.
 */
export const BANK_ELEMENTS = Object.freeze({
  Bank: {
    parent: undefined,
    attributes: Object.freeze(['version']),
    required: Object.freeze([]),
    documentation: 'Root element of a bank file.',
  },
  Section: {
    parent: 'Bank',
    attributes: Object.freeze(['name']),
    required: Object.freeze(['name']),
    documentation: 'A named group of keys. Section names are unique within a bank.',
  },
  Key: {
    parent: 'Section',
    attributes: Object.freeze(['name']),
    required: Object.freeze(['name']),
    documentation: 'A named entry. Key names are unique within their section.',
  },
  Value: {
    parent: 'Key',
    attributes: BANK_VALUE_TYPES,
    required: Object.freeze([]),
    documentation: 'The stored value. Its attribute name is the value type.',
  },
  Signature: {
    parent: 'Bank',
    attributes: Object.freeze(['value']),
    required: Object.freeze(['value']),
    documentation: 'Author/player signature over the bank contents.',
  },
})

export type BankElementName = keyof typeof BANK_ELEMENTS

const ELEMENT_NAMES = Object.freeze(Object.keys(BANK_ELEMENTS) as BankElementName[])

function isBankElement(name: string): name is BankElementName {
  return Object.hasOwn(BANK_ELEMENTS, name)
}

const INT_RE = /^-?\d+$/u
const FIXED_RE = /^-?(?:\d+|\d*\.\d+)$/u
const FLAG_VALUES = Object.freeze(['0', '1', 'true', 'false'])

const TYPE_DOCUMENTATION: Readonly<Record<BankValueType, string>> = Object.freeze({
  int: 'Whole number, optionally signed. Written by `BankValueSetFromInt`.',
  fixed: 'Fixed-point number, optionally signed, with an optional fractional part.',
  string: 'Raw string, stored as written.',
  flag: 'Boolean, written as `0`, `1`, `true` or `false`.',
  text: 'Localised text handle rather than a literal.',
  point: 'Two fixed-point numbers separated by a comma, for example `12.5,-3`.',
})

/** Why one value is not acceptable for its declared type, or `undefined` when it is. */
export function bankValueProblem(type: string, value: string): string | undefined {
  if (type === 'int' && !INT_RE.test(value)) return `Invalid int value "${value}"`
  if (type === 'fixed' && !FIXED_RE.test(value)) return `Invalid fixed value "${value}"`
  if (type === 'flag' && !FLAG_VALUES.includes(value.toLowerCase())) {
    return `Invalid flag value "${value}"`
  }
  if (type === 'point') {
    const parts = value.split(',')
    if (parts.length !== 2 || !FIXED_RE.test(parts[0] ?? '') || !FIXED_RE.test(parts[1] ?? '')) {
      return `Invalid point value "${value}"`
    }
  }
  return undefined
}

/** Offsets to line/character, computed once per document rather than per finding. */
class LineIndex {
  readonly #starts: number[] = [0]
  constructor(text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) this.#starts.push(index + 1)
    }
  }

  positionAt(offset: number): LanguagePosition {
    let low = 0
    let high = this.#starts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((this.#starts[middle] ?? 0) <= offset) low = middle
      else high = middle - 1
    }
    return { line: low, character: offset - (this.#starts[low] ?? 0) }
  }

  range(from: number, to: number): LanguageRange {
    return { start: this.positionAt(from), end: this.positionAt(to) }
  }

  offsetAt(position: LanguagePosition): number {
    const start = this.#starts[position.line] ?? 0
    return start + position.character
  }
}

interface ScannedAttribute {
  readonly name: string
  readonly value: string
  readonly nameFrom: number
  readonly nameTo: number
  readonly valueFrom: number
  readonly valueTo: number
}

interface ScannedElement {
  readonly name: string
  readonly from: number
  readonly to: number
  readonly parent: string | undefined
  readonly attributes: readonly ScannedAttribute[]
}

export interface BankScan {
  readonly elements: readonly ScannedElement[]
}

/**
 * Flatten the shared scanner's element tree into the document-ordered list this provider works in.
 *
 * The scanner is `codec-kit`'s — the one ported from MK2's sc2-data, where it was written and
 * proven. This file used to carry its own regular-expression scanner; two scanners of the same
 * grammar disagree eventually, and the disagreement surfaces as a diagnostic that fires in one
 * editor and not another. The flat shape is kept because a bank is checked by walking elements in
 * order, and every rule below reads `parent` rather than descending a tree.
 */
export function scanBank(text: string): BankScan {
  const elements: ScannedElement[] = []
  const walk = (nodes: readonly KitElement[], parent: string | undefined): void => {
    for (const node of nodes) {
      elements.push({
        name: node.tag,
        from: node.tagStart,
        to: node.tagEnd,
        parent,
        attributes: Object.freeze(
          node.attrs.map(attribute => ({
            name: attribute.name,
            value: attribute.value,
            nameFrom: attribute.nameStart,
            nameTo: attribute.nameEnd,
            valueFrom: attribute.valueStart,
            valueTo: attribute.valueEnd,
          })),
        ),
      })
      walk(node.children, node.tag)
    }
  }
  walk(scanXml(text), undefined)
  // The scanner returns roots in order but nests children, so document order is restored here.
  return { elements: Object.freeze([...elements].sort((left, right) => left.from - right.from)) }
}

/** Elements of one kind, in document order, with the section each belongs to. */
function elementsNamed(scan: BankScan, name: string): readonly ScannedElement[] {
  return scan.elements.filter(element => element.name === name)
}

function attributeNamed(element: ScannedElement, name: string): ScannedAttribute | undefined {
  return element.attributes.find(attribute => attribute.name === name)
}

function diagnosticsFor(text: string): readonly LanguageDiagnostic[] {
  const index = new LineIndex(text)
  const scan = scanBank(text)
  const found: LanguageDiagnostic[] = []
  const say = (
    range: LanguageRange,
    severity: LanguageDiagnostic['severity'],
    code: string,
    message: string,
  ): void => {
    found.push({ range, severity, code, source: SC2_BANK_LANGUAGE_ID, message })
  }

  const sectionNames = new Set<string>()
  const keyNames = new Map<string, Set<string>>()

  for (const element of scan.elements) {
    if (!isBankElement(element.name)) {
      say(
        index.range(element.from, element.to),
        'warning',
        'unknown-element',
        `A bank has no «${element.name}» element. Known elements: ${ELEMENT_NAMES.join(', ')}.`,
      )
      continue
    }
    const schema = BANK_ELEMENTS[element.name]

    /*
     * Nesting is checked against the declared parent, and only when a parent was actually seen. A
     * document being typed top-down has elements with no parent yet, and reporting those would put
     * an error on every line the moment a reader starts a file.
     */
    if (
      schema.parent !== undefined &&
      element.parent !== undefined &&
      element.parent !== schema.parent
    ) {
      say(
        index.range(element.from, element.to),
        'error',
        'misplaced-element',
        `«${element.name}» belongs in «${schema.parent}», not in «${element.parent}».`,
      )
    }

    for (const attribute of element.attributes) {
      if (!(schema.attributes as readonly string[]).includes(attribute.name)) {
        say(
          index.range(attribute.nameFrom, attribute.nameTo),
          element.name === 'Value' ? 'warning' : 'error',
          element.name === 'Value' ? 'unknown-value-type' : 'unknown-attribute',
          element.name === 'Value'
            ? `Unknown bank value type "${attribute.name}". Known types: ${BANK_VALUE_TYPES.join(', ')}.`
            : `«${element.name}» has no «${attribute.name}» attribute. It accepts: ${schema.attributes.join(', ')}.`,
        )
        continue
      }
      if (element.name === 'Value') {
        const problem = bankValueProblem(attribute.name, attribute.value)
        if (problem !== undefined) {
          say(
            index.range(attribute.valueFrom, attribute.valueTo),
            'error',
            `invalid-${attribute.name}`,
            problem,
          )
        }
      }
    }

    for (const required of schema.required) {
      if (attributeNamed(element, required) === undefined) {
        say(
          index.range(element.from, element.to),
          'error',
          'missing-attribute',
          `«${element.name}» requires a «${required}» attribute.`,
        )
      }
    }

    /*
     * Duplicates are reported on the second and later occurrences, never on the first: flagging the
     * original as well doubles the noise and gives no clue which one to remove. Key names are
     * unique within their section, not across the file, so they are tracked per section.
     */
    if (element.name === 'Section') {
      const name = attributeNamed(element, 'name')
      if (name !== undefined) {
        if (name.value.length === 0) {
          say(
            index.range(name.valueFrom, name.valueTo),
            'error',
            'empty-section-name',
            'Section name is empty',
          )
        } else if (sectionNames.has(name.value)) {
          say(
            index.range(name.valueFrom, name.valueTo),
            'error',
            'duplicate-section',
            `Duplicate section "${name.value}"`,
          )
        }
        sectionNames.add(name.value)
      }
    }
    if (element.name === 'Key') {
      const name = attributeNamed(element, 'name')
      const section = sectionOf(scan, element)
      if (name !== undefined) {
        if (name.value.length === 0) {
          say(
            index.range(name.valueFrom, name.valueTo),
            'error',
            'empty-key-name',
            'Key name is empty',
          )
        } else {
          const seen = keyNames.get(section) ?? new Set<string>()
          if (seen.has(name.value)) {
            say(
              index.range(name.valueFrom, name.valueTo),
              'error',
              'duplicate-key',
              `Duplicate key "${name.value}" in section "${section}"`,
            )
          }
          seen.add(name.value)
          keyNames.set(section, seen)
        }
      }
    }
  }

  if (!scan.elements.some(element => element.name === 'Signature')) {
    say(index.range(0, 0), 'warning', 'missing-signature', 'Bank has no Signature element')
  }
  return found
}

/** The name of the section a key sits in, by document order — '' when it sits outside one. */
function sectionOf(scan: BankScan, key: ScannedElement): string {
  let current = ''
  for (const element of scan.elements) {
    if (element === key) break
    if (element.name === 'Section') current = attributeNamed(element, 'name')?.value ?? ''
  }
  return current
}

function symbolsFor(text: string): readonly LanguageSymbol[] {
  const index = new LineIndex(text)
  const scan = scanBank(text)
  return scan.elements
    .filter(element => element.name === 'Section' || element.name === 'Key')
    .map((element): LanguageSymbol => {
      const name = attributeNamed(element, 'name')
      const range = index.range(element.from, name?.valueTo ?? element.to)
      return {
        name: name?.value ?? element.name,
        kind: element.name === 'Section' ? 'namespace' : 'field',
        range,
        selectionRange:
          name === undefined
            ? index.range(element.from, element.to)
            : index.range(name.valueFrom, name.valueTo),
      }
    })
}

function tokensFor(text: string): readonly LanguageToken[] {
  const index = new LineIndex(text)
  const tokens: LanguageToken[] = []
  for (const element of scanBank(text).elements) {
    tokens.push({ range: index.range(element.from, element.to), kind: 'type' })
    for (const attribute of element.attributes) {
      tokens.push({
        range: index.range(attribute.nameFrom, attribute.nameTo),
        kind: element.name === 'Value' ? 'type' : 'property',
      })
      const valueKind =
        element.name === 'Value' && ['int', 'fixed', 'point'].includes(attribute.name)
          ? 'number'
          : element.name === 'Value' && attribute.name === 'flag'
            ? 'keyword'
            : 'string'
      tokens.push({
        range: index.range(attribute.valueFrom, attribute.valueTo),
        kind: valueKind,
      })
    }
  }
  return tokens
}

interface BankNameTarget {
  readonly kind: 'section' | 'key'
  readonly name: string
  readonly section?: string
}

interface BankNameOccurrence {
  readonly target: BankNameTarget
  readonly range: LanguageRange
}

function namedOccurrences(text: string): readonly BankNameOccurrence[] {
  const index = new LineIndex(text)
  const scan = scanBank(text)
  return scan.elements.flatMap(element => {
    if (element.name !== 'Section' && element.name !== 'Key') return []
    const name = attributeNamed(element, 'name')
    if (name === undefined || name.value.length === 0) return []
    return [
      {
        target:
          element.name === 'Section'
            ? { kind: 'section' as const, name: name.value }
            : { kind: 'key' as const, section: sectionOf(scan, element), name: name.value },
        range: index.range(name.valueFrom, name.valueTo),
      },
    ]
  })
}

function sameTarget(left: BankNameTarget, right: BankNameTarget): boolean {
  return left.kind === right.kind && left.name === right.name && left.section === right.section
}

function targetAt(text: string, position: LanguagePosition): BankNameOccurrence | undefined {
  const offset = new LineIndex(text).offsetAt(position)
  return namedOccurrences(text).find(occurrence => {
    const index = new LineIndex(text)
    const from = index.offsetAt(occurrence.range.start)
    const to = index.offsetAt(occurrence.range.end)
    return offset >= from && offset <= to
  })
}

function bankDocuments(request: LanguageFeatureRequest) {
  const documents = new Map(
    [request.document, ...request.workspaceDocuments]
      .filter(document => document.languageId === SC2_BANK_LANGUAGE_ID)
      .map(document => [document.uri, document]),
  )
  return [...documents.values()].sort((left, right) => left.uri.localeCompare(right.uri))
}

/**
 * What the caret is positioned to complete, if anything.
 *
 * Three positions are meaningful in a bank and no others: the element name just after `<`, an
 * attribute name inside an open tag, and the text inside an attribute's quotes. Offering a list
 * anywhere else would put suggestions where nothing can legally be typed.
 */
interface CompletionContext {
  readonly kind: 'element' | 'attribute' | 'attribute-value'
  readonly element?: string
  readonly attribute?: string
  readonly parent?: string
}

function completionContext(text: string, offset: number): CompletionContext | undefined {
  const before = text.slice(0, offset)
  // Inside a tag? Find the last `<` that has no `>` after it.
  const open = before.lastIndexOf('<')
  if (open < 0) return undefined
  if (before.indexOf('>', open) >= 0) return undefined
  const inside = before.slice(open + 1)
  if (inside.startsWith('/') || inside.startsWith('?') || inside.startsWith('!')) return undefined

  const named = /^([A-Za-z_][\w:.-]*)?/u.exec(inside)
  const name = named?.[1] ?? ''
  // Still typing the element name: no whitespace has been entered yet.
  if (!/\s/u.test(inside)) {
    const parent = openElementAt(text, open)
    return { kind: 'element', ...(parent === undefined ? {} : { parent }) }
  }
  const rest = inside.slice(name.length)
  const quotes = rest.match(/"/gu)?.length ?? 0
  if (quotes % 2 === 1) {
    const attribute = /([A-Za-z_][\w:.-]*)\s*=\s*"[^"]*$/u.exec(rest)?.[1]
    return {
      kind: 'attribute-value',
      element: name,
      ...(attribute === undefined ? {} : { attribute }),
    }
  }
  return { kind: 'attribute', element: name }
}

/**
 * The innermost element still open at `offset`, so element completion can respect nesting.
 *
 * This is containment, not "the last tag seen". Scanning the prefix and taking the last element
 * answers a different question and answers it wrongly: after `<Value string="Hero"/></Key></Section>`
 * the last tag is `Value`, so completion would look for elements permitted inside a `Value` — there
 * are none, and the reader gets an empty list at exactly the place a new `Section` belongs. The
 * scanner already tracks closing tags, so the enclosing element is the deepest one whose span
 * contains the cursor.
 */
function openElementAt(text: string, offset: number): string | undefined {
  return elementPathAt(text, offset).at(-1)?.tag
}

/** What inserting an element should actually type, so the reader gets a usable skeleton. */
function snippetFor(name: BankElementName): string {
  if (name === 'Bank') return 'Bank version="$1">$0</Bank>'
  if (name === 'Section') return 'Section name="$1">$0</Section>'
  if (name === 'Key') return 'Key name="$1">$0</Key>'
  if (name === 'Value') return 'Value ${1|int,fixed,string,flag,text,point|}="$2"/>'
  return 'Signature value="$1"/>'
}

export function createSc2BankLanguageProvider(): LanguageProvider {
  return {
    contract: 'common.language/document-analysis',
    languageIds: [SC2_BANK_LANGUAGE_ID],

    async analyze(request: LanguageAnalysisRequest): Promise<LanguageAnalysis> {
      const text = request.document.text
      const include = request.include
      return {
        documentUri: request.document.uri,
        documentVersion: request.document.version,
        tokens: tokensFor(text),
        diagnostics: include?.diagnostics === false ? [] : diagnosticsFor(text),
        symbols: include?.symbols === false ? [] : symbolsFor(text),
      }
    },

    async diagnostics(request: LanguageFeatureRequest): Promise<LanguageDiagnosticList> {
      const all = diagnosticsFor(request.document.text)
      const items = all.slice(0, request.maxResults)
      return { diagnostics: items, isIncomplete: items.length < all.length }
    },

    async documentSymbols(request: LanguageFeatureRequest): Promise<LanguageDocumentSymbolList> {
      const all = symbolsFor(request.document.text)
      const items = all.slice(0, request.maxResults)
      return { symbols: items, isIncomplete: items.length < all.length }
    },

    async completion(request: LanguagePositionRequest): Promise<LanguageCompletionList> {
      const text = request.document.text
      const offset = new LineIndex(text).offsetAt(request.position)
      const context = completionContext(text, offset)
      if (context === undefined) return { items: [], isIncomplete: false }

      if (context.kind === 'element') {
        /*
         * Only elements the format allows here. `Section` inside a `Key` is not a thing a bank can
         * contain, so offering it would be offering a mistake.
         */
        const allowed = ELEMENT_NAMES.filter(name => {
          const parent = BANK_ELEMENTS[name].parent
          if (parent === undefined) return context.parent === undefined
          return context.parent === undefined || context.parent === parent
        })
        return {
          items: allowed.map(name => ({
            label: name,
            kind: 'class' as const,
            detail: `bank element${BANK_ELEMENTS[name].parent === undefined ? '' : ` in ${BANK_ELEMENTS[name].parent}`}`,
            documentation: BANK_ELEMENTS[name].documentation,
            insertText: snippetFor(name),
            insertTextFormat: 'snippet' as const,
          })),
          isIncomplete: false,
        }
      }

      if (context.kind === 'attribute') {
        const element = context.element ?? ''
        if (!isBankElement(element)) return { items: [], isIncomplete: false }
        const schema = BANK_ELEMENTS[element]
        const already = new Set(
          scanBank(text.slice(0, offset))
            .elements.at(-1)
            ?.attributes.map(a => a.name) ?? [],
        )
        return {
          items: schema.attributes
            .filter(name => !already.has(name))
            .map(name => ({
              label: name,
              kind: element === 'Value' ? ('type' as const) : ('property' as const),
              detail: element === 'Value' ? 'bank value type' : `${element} attribute`,
              ...(element === 'Value'
                ? { documentation: TYPE_DOCUMENTATION[name as BankValueType] }
                : {}),
              insertText: `${name}="$1"`,
              insertTextFormat: 'snippet' as const,
            })),
          isIncomplete: false,
        }
      }

      /*
       * Inside an attribute's quotes. Nothing in a bank declares the vocabulary a map expects, so
       * the only names this provider can honestly offer are the ones already in the file.
       */
      if (context.attribute !== 'name') return { items: [], isIncomplete: false }
      const wanted = context.element === 'Section' ? 'Section' : 'Key'
      const used = [
        ...new Set(
          elementsNamed(scanBank(text), wanted)
            .map(element => attributeNamed(element, 'name')?.value ?? '')
            .filter(name => name.length > 0),
        ),
      ]
      return {
        items: used.slice(0, request.maxResults).map(name => ({
          label: name,
          kind: wanted === 'Section' ? ('namespace' as const) : ('field' as const),
          detail: 'already used in this file',
        })),
        isIncomplete: used.length > request.maxResults,
      }
    },

    async definition(request: LanguagePositionRequest): Promise<LanguageLocationList> {
      const selected = targetAt(request.document.text, request.position)
      if (selected === undefined) return { locations: [], isIncomplete: false }
      const locations: LanguageLocation[] = []
      for (const document of bankDocuments(request)) {
        for (const occurrence of namedOccurrences(document.text)) {
          if (!sameTarget(occurrence.target, selected.target)) continue
          locations.push({ uri: document.uri, range: occurrence.range })
          if (locations.length >= request.maxResults) {
            return { locations, isIncomplete: true }
          }
        }
      }
      return { locations, isIncomplete: request.workspaceIncomplete }
    },

    async references(request: LanguageReferencesRequest): Promise<LanguageLocationList> {
      const selected = targetAt(request.document.text, request.position)
      if (selected === undefined) return { locations: [], isIncomplete: false }
      if (request.includeDeclaration === false) {
        return { locations: [], isIncomplete: request.workspaceIncomplete }
      }
      const locations: LanguageLocation[] = []
      for (const document of bankDocuments(request)) {
        for (const occurrence of namedOccurrences(document.text)) {
          if (!sameTarget(occurrence.target, selected.target)) continue
          locations.push({ uri: document.uri, range: occurrence.range })
          if (locations.length >= request.maxResults) {
            return { locations, isIncomplete: true }
          }
        }
      }
      return { locations, isIncomplete: request.workspaceIncomplete }
    },

    async prepareRename(
      request: LanguagePositionRequest,
    ): Promise<LanguageRenamePreparation | undefined> {
      const selected = targetAt(request.document.text, request.position)
      return selected === undefined
        ? undefined
        : { range: selected.range, placeholder: selected.target.name }
    },

    async rename(request: LanguageRenameRequest): Promise<LanguageWorkspaceEdit | undefined> {
      const selected = targetAt(request.document.text, request.position)
      if (selected === undefined) return undefined
      const documents = request.workspaceIncomplete ? [request.document] : bankDocuments(request)
      const documentChanges = []
      let editCount = 0
      for (const document of documents) {
        const edits: LanguageTextEdit[] = namedOccurrences(document.text)
          .filter(occurrence => sameTarget(occurrence.target, selected.target))
          .map(occurrence => ({ range: occurrence.range, newText: request.newName }))
        if (edits.length === 0) continue
        editCount += edits.length
        if (editCount > request.maxEdits) return undefined
        documentChanges.push({ uri: document.uri, documentVersion: document.version, edits })
      }
      return documentChanges.length === 0 ? undefined : { documentChanges, isComplete: true }
    },

    /** Preserve signed authored XML; only the explicitly requested final newline may change. */
    async formatting(request: LanguageFormattingRequest): Promise<LanguageTextEditList> {
      return finalNewlineFormatting(request)
    },

    async codeActions(request: LanguageCodeActionsRequest) {
      return finalNewlineCodeActions(request)
    },

    async hover(request: LanguagePositionRequest): Promise<LanguageHover | undefined> {
      const text = request.document.text
      const index = new LineIndex(text)
      const offset = index.offsetAt(request.position)
      const scan = scanBank(text)
      for (const element of scan.elements) {
        if (offset >= element.from && offset <= element.to && isBankElement(element.name)) {
          return {
            markdown: `**${element.name}** — ${BANK_ELEMENTS[element.name].documentation}`,
            range: index.range(element.from, element.to),
            provenance: 'blizzard/sc2-bank',
          }
        }
        if (element.name !== 'Value') {
          // The name of a section or a key is what a reader points at; the tag is rarely the question.
          if (!isBankElement(element.name)) continue
          const named = element.attributes.find(
            item => item.name === 'name' && offset >= item.nameFrom && offset <= item.valueTo,
          )
          if (named === undefined) continue
          return {
            markdown: `**${element.name}** \`${named.value}\` — ${BANK_ELEMENTS[element.name].documentation}`,
            range: index.range(named.nameFrom, named.valueTo),
            provenance: 'blizzard/sc2-bank',
          }
        }
        for (const attribute of element.attributes) {
          if (offset < attribute.nameFrom || offset > attribute.valueTo) continue
          const known = (BANK_VALUE_TYPES as readonly string[]).includes(attribute.name)
          const documentation = known
            ? TYPE_DOCUMENTATION[attribute.name as BankValueType]
            : `Unknown bank value type. Known types: ${BANK_VALUE_TYPES.join(', ')}.`
          const problem = known ? bankValueProblem(attribute.name, attribute.value) : undefined
          return {
            markdown: `**${attribute.name}** — ${documentation}${
              problem === undefined
                ? ''
                : `

⚠ ${problem}`
            }`,
            range: index.range(attribute.nameFrom, attribute.valueTo),
            provenance: 'blizzard/sc2-bank',
          }
        }
      }
      return undefined
    },
  }
}

export const sc2BankLanguageProvider: LanguageProvider = createSc2BankLanguageProvider()
