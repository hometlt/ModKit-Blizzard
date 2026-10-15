/**
 * MK3 language services for `.BlizWiz` documents.
 *
 * The provider deliberately consumes the wizard codec's parser and analyzer. A wizard is XML on
 * the outside, but its useful identifiers live in inputs, macros, embedded wizards and evaluated
 * `^token^` expressions. Keeping navigation here on top of the lossless codec model means that
 * diagnostics, symbols and edits all point at the bytes the codec will write back.
 */
import { servedLanguageFeature } from '@modkit/blizzard-starcraft2/language/served-feature'
import { servedModContext } from '../../../../style/providers/language/src/style-names.js'
import { servedRenameFeature } from '@modkit/blizzard-starcraft2/language/served-rename'
import { servedProjectDiagnostics } from '@modkit/blizzard-starcraft2/language/served-project-diagnostics'
import type {
  LanguageAnalysis,
  LanguageAnalysisRequest,
  LanguageCodeActionsRequest,
  LanguageCompletionItem,
  LanguageCompletionList,
  LanguageDiagnostic,
  LanguageDiagnosticList,
  LanguageDocument,
  LanguageDocumentSymbolList,
  LanguageFeatureRequest,
  LanguageFormattingRequest,
  LanguageHover,
  LanguageLocation,
  LanguageLocationList,
  LanguagePosition,
  LanguagePositionRequest,
  LanguageProvider,
  LanguageRange,
  LanguageReferencesRequest,
  LanguageRenamePreparation,
  LanguageRenameRequest,
  LanguageSymbol,
  LanguageTextEditList,
  LanguageToken,
  LanguageWorkspaceEdit,
  LanguageWorkspaceSymbol,
  LanguageWorkspaceSymbolList,
  LanguageWorkspaceSymbolsRequest,
  ReferenceOccurrence,
} from '@modkit/sdk'
import { finalNewlineCodeActions } from '../../../../../shared/language/code-actions.js'
import {
  analyzeWizardDocument,
  catalogReferencesIn,
  evaluateWizardMacro,
  looksLikeWizardFile,
  nodeText,
  parseWizardDocument,
  BUILT_IN_INPUT_TYPES,
  INDEX_TOKENS,
  KNOWN_ATTRIBUTES,
  KNOWN_CHILDREN,
  LOGIC_VALUES,
  MATCH_VALUES,
  OPERATOR_VALUES,
  VALIDATE_VALUES,
  WIZARD_ROOT_TAG,
  wizardEvaluatedStrings,
  type Wizard,
  type WizardDocument,
  type WizardNode,
} from '../../../codecs/wizard/src/core/index.js'
import { createStarcraft2WizardSchema } from '../../../codecs/wizard/src/schema.js'
import {
  resolveStarcraft2SchemaFields,
  STARCRAFT2_DATA_NAMESPACES,
  STARCRAFT2_TYPE_NAMESPACES,
} from '../../../../data/services/schema/full-data-schema.js'

export const SC2_WIZARD_LANGUAGE_ID = 'sc2-wizard'

const PARSE_OPTIONS = Object.freeze({
  caseInsensitiveRoot: true,
  allowStandaloneWizard: true,
})

const WIZARD_SCHEMA = createStarcraft2WizardSchema()

/*
 * Every feature request carries the whole snapshot again, and every one used to parse all of it.
 * Keyed by text rather than URI and version: identical text is an identical document, whichever
 * buffer it came from, and a stale entry cannot be served for changed text.
 */
const PARSED = new Map<string, WizardDocument>()
const PARSED_LIMIT = 64

function parse(text: string): WizardDocument {
  const cached = PARSED.get(text)
  if (cached !== undefined) return cached
  const document = parseWizardDocument(text, PARSE_OPTIONS)
  // ponytail: FIFO eviction, an LRU if large workspaces thrash it.
  if (PARSED.size >= PARSED_LIMIT) PARSED.delete(PARSED.keys().next().value as string)
  PARSED.set(text, document)
  return document
}

/*
 * The vocabulary is the analyzer's: completion must offer exactly what the checker accepts.
 */
const BUILT_IN_TOKENS = INDEX_TOKENS
const INPUT_TYPES = Object.freeze([...BUILT_IN_INPUT_TYPES])
const ELEMENTS = Object.freeze([
  WIZARD_ROOT_TAG,
  ...new Set([...KNOWN_CHILDREN.values()].flatMap(children => [...children])),
])

interface SchemaFieldForCompletion {
  readonly fieldId: string
  readonly fields?: readonly SchemaFieldForCompletion[]
}

class LineIndex {
  readonly #starts: number[] = [0]

  constructor(readonly text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) this.#starts.push(index + 1)
    }
  }

  positionAt(offset: number): LanguagePosition {
    const bounded = Math.max(0, Math.min(offset, this.text.length))
    let low = 0
    let high = this.#starts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((this.#starts[middle] ?? 0) <= bounded) low = middle
      else high = middle - 1
    }
    return { line: low, character: bounded - (this.#starts[low] ?? 0) }
  }

  offsetAt(position: LanguagePosition): number {
    return Math.max(0, Math.min(this.text.length, (this.#starts[position.line] ?? 0) + position.character))
  }

  range(from: number, to: number): LanguageRange {
    return { start: this.positionAt(from), end: this.positionAt(to) }
  }
}

function nodesOf(node: WizardNode): readonly WizardNode[] {
  return [node, ...node.children.flatMap(nodesOf)]
}

function documentNodes(document: WizardDocument): readonly WizardNode[] {
  return document.roots.flatMap(nodesOf)
}

function attribute(node: WizardNode, name: string) {
  return node.attributes.find(item => item.name === name)
}

function textRange(node: WizardNode, index: LineIndex): LanguageRange {
  const end = node.end - node.closeRaw.length
  return index.range(node.openEnd, Math.max(node.openEnd, end))
}

function selectionRange(node: WizardNode, index: LineIndex, attributeName = 'id'): LanguageRange {
  const found = attribute(node, attributeName)
  if (found !== undefined) return index.range(found.valueStart, found.valueEnd)
  return index.range(node.start + 1, node.start + 1 + node.tag.length)
}

function nodeRange(node: WizardNode, index: LineIndex): LanguageRange {
  return index.range(node.start, node.end)
}

function symbolsForWizard(wizard: Wizard, index: LineIndex): LanguageSymbol {
  const children: LanguageSymbol[] = []
  for (const input of wizard.inputs) {
    children.push({
      name: input.id || '<input>',
      kind: 'variable',
      detail: input.type || 'input',
      range: nodeRange(input.node, index),
      selectionRange: selectionRange(input.node, index),
    })
  }
  for (const macro of wizard.macros) {
    children.push({
      name: macro.id || '<macro>',
      kind: 'function',
      detail: 'wizard macro',
      range: nodeRange(macro.node, index),
      selectionRange: selectionRange(macro.node, index),
    })
  }
  for (const entry of wizard.entries) {
    const entryName = [entry.catalog, entry.type, entry.id].filter(Boolean).join('.') || '<entry>'
    const entryChildren: LanguageSymbol[] = [
      ...entry.fields.map(field => ({
        name: field.id || '<field>',
        kind: 'property' as const,
        detail: 'catalog field',
        range: nodeRange(field.node, index),
        selectionRange: selectionRange(field.node, index),
      })),
      ...entry.tokens.map(token => ({
        name: token.id || '<token>',
        kind: 'property' as const,
        detail: 'entry token',
        range: nodeRange(token.node, index),
        selectionRange: selectionRange(token.node, index),
      })),
    ]
    children.push({
      name: entryName,
      kind: 'class',
      detail: `${entry.catalog}.${entry.type}`,
      range: nodeRange(entry.node, index),
      selectionRange: selectionRange(entry.node, index, 'catalog'),
      ...(entryChildren.length === 0 ? {} : { children: entryChildren }),
    })
  }
  return {
    name: wizard.id || '<wizard>',
    kind: 'class',
    detail: wizard.name === undefined ? 'wizard' : `wizard: ${wizard.name}`,
    range: nodeRange(wizard.node, index),
    selectionRange: selectionRange(wizard.node, index),
    ...(children.length === 0 ? {} : { children }),
  }
}

function symbolsOf(document: WizardDocument, index: LineIndex): readonly LanguageSymbol[] {
  return document.file.wizards.map(wizard => symbolsForWizard(wizard, index))
}

function tokensOf(document: WizardDocument, index: LineIndex): readonly LanguageToken[] {
  const tokens: LanguageToken[] = []
  for (const node of documentNodes(document)) {
    const tagStart = node.start + 1
    tokens.push({ range: index.range(tagStart, tagStart + node.tag.length), kind: 'type' })
    for (const item of node.attributes) {
      tokens.push({ range: index.range(item.nameStart, item.nameStart + item.name.length), kind: 'property' })
      tokens.push({ range: index.range(item.valueStart, item.valueEnd), kind: 'string' })
    }
  }
  return tokens
}

interface Declaration {
  readonly key: string
  readonly name: string
  readonly kind: LanguageSymbol['kind']
  readonly uri: string
  readonly range: LanguageRange
  readonly declaration: true
  readonly detail: string
}

interface Occurrence {
  readonly key: string
  readonly uri: string
  readonly range: LanguageRange
  readonly declaration: boolean
  /** The same source span could mean another symbol too; rename refuses to touch it. */
  readonly ambiguous?: true
}

interface WizardIndex {
  readonly declarations: readonly Declaration[]
  readonly occurrences: readonly Occurrence[]
}

function keyForInput(wizardId: string, inputId: string): string {
  return `input:${wizardId}:${inputId}`
}

function keyForMacro(wizardId: string, macroId: string): string {
  return `macro:${wizardId}:${macroId}`
}

function keyForWizard(wizardId: string): string {
  return `wizard:${wizardId}`
}

function keyForCondition(wizardId: string, conditionId: string): string {
  return `condition:${wizardId}:${conditionId}`
}

function addOccurrence(
  occurrences: Occurrence[],
  key: string | undefined,
  uri: string,
  range: LanguageRange,
  declaration = false,
  ambiguous = false,
): void {
  if (key === undefined) return
  occurrences.push({ key, uri, range, declaration, ...(ambiguous ? { ambiguous: true as const } : {}) })
}

/**
 * Record an input name at `start`. A qualified `Owner:Nested` name records both segments: the owner
 * is a wizard id or a `Wizard:`-typed input of this wizard, and renaming either must reach it.
 */
function addInputName(
  name: string,
  start: number,
  wizard: Wizard,
  wizardIds: ReadonlySet<string>,
  occurrences: Occurrence[],
  uri: string,
  index: LineIndex,
): void {
  const colon = name.indexOf(':')
  if (colon <= 0) {
    addOccurrence(occurrences, keyForInput(wizard.id, name), uri, index.range(start, start + name.length))
    return
  }
  const owner = name.slice(0, colon)
  const nested = name.slice(colon + 1)
  if (nested === '') return
  /*
   * The owner is a wizard id (what the corpus writes) or a `Wizard:`-typed input of this wizard.
   * When both exist the span is recorded under every reading and marked ambiguous, so navigation
   * still finds it and rename refuses rather than guessing which symbol the author meant.
   */
  const input = wizard.inputs.find(item => item.id === owner && item.type.startsWith('Wizard:'))
  const readings = [
    ...(wizardIds.has(owner) ? [{ ownerKey: keyForWizard(owner), embedded: owner }] : []),
    ...(input === undefined ? [] : [{ ownerKey: keyForInput(wizard.id, owner), embedded: input.type.slice('Wizard:'.length) }]),
  ]
  const ambiguous = readings.length > 1
  const nestedStart = start + colon + 1
  const nestedKeys = new Set(readings.map(reading => keyForInput(reading.embedded, nested)))
  for (const reading of readings) {
    addOccurrence(occurrences, reading.ownerKey, uri, index.range(start, start + owner.length), false, ambiguous)
  }
  for (const key of nestedKeys) {
    addOccurrence(occurrences, key, uri, index.range(nestedStart, nestedStart + nested.length), false, nestedKeys.size > 1)
  }
}

function addTextReferences(
  node: WizardNode,
  wizard: Wizard,
  wizardIds: ReadonlySet<string>,
  occurrences: Occurrence[],
  uri: string,
  index: LineIndex,
): void {
  const macros = new Set(wizard.macros.map(item => item.id).filter(Boolean))
  const inputs = new Set(wizard.inputs.map(item => item.id).filter(Boolean))
  /*
   * Scan the raw source, not the entity-decoded value: edit ranges are source offsets, and a
   * `&amp;` ahead of a token would otherwise shift every range after it.
   */
  const scan = (raw: string, rawStart: number): void => {
    for (const match of raw.matchAll(/\^([^\^]+)\^/gu)) {
      const name = match[1]
      if (name === undefined || BUILT_IN_TOKENS.has(name)) continue
      const tokenStart = rawStart + (match.index ?? 0) + 1
      if (name.includes(':')) addInputName(name, tokenStart, wizard, wizardIds, occurrences, uri, index)
      else if (macros.has(name)) {
        addOccurrence(occurrences, keyForMacro(wizard.id, name), uri, index.range(tokenStart, tokenStart + name.length))
      } else if (inputs.has(name)) {
        addOccurrence(occurrences, keyForInput(wizard.id, name), uri, index.range(tokenStart, tokenStart + name.length))
      }
    }
  }
  if (node.children.length === 0) scan(node.innerTail, node.openEnd)
  for (const item of node.attributes) scan(item.raw, item.valueStart)
}

function textReference(
  node: WizardNode | undefined,
  expected: string | undefined,
  wizard: Wizard,
  wizardIds: ReadonlySet<string>,
  index: LineIndex,
  uri: string,
  occurrences: Occurrence[],
): void {
  if (node === undefined || expected === undefined || expected === '') return
  const start = node.innerTail.indexOf(expected)
  if (start < 0) return
  addInputName(expected, node.openEnd + start, wizard, wizardIds, occurrences, uri, index)
}

function wizardIndex(
  document: WizardDocument,
  uri: string,
  index: LineIndex,
  knownWizardIds = new Set(document.file.wizards.map(item => item.id).filter(Boolean)),
): WizardIndex {
  const declarations: Declaration[] = []
  const occurrences: Occurrence[] = []
  const wizardIds = knownWizardIds
  for (const wizard of document.file.wizards) {
    const wizardAttribute = attribute(wizard.node, 'id')
    if (wizard.id !== '' && wizardAttribute !== undefined) {
      const range = index.range(wizardAttribute.valueStart, wizardAttribute.valueEnd)
      declarations.push({ key: keyForWizard(wizard.id), name: wizard.id, kind: 'class', uri, range, declaration: true, detail: 'wizard' })
      occurrences.push({ key: keyForWizard(wizard.id), uri, range, declaration: true })
    }
    for (const input of wizard.inputs) {
      const inputAttribute = attribute(input.node, 'id')
      if (input.id === '' || inputAttribute === undefined) continue
      const range = index.range(inputAttribute.valueStart, inputAttribute.valueEnd)
      const key = keyForInput(wizard.id, input.id)
      declarations.push({ key, name: input.id, kind: 'variable', uri, range, declaration: true, detail: input.type })
      occurrences.push({ key, uri, range, declaration: true })
      const typeAttribute = attribute(input.node, 'type')
      if (input.type.startsWith('Wizard:') && typeAttribute !== undefined) {
        const target = input.type.slice('Wizard:'.length)
        const start = typeAttribute.valueStart + 'Wizard:'.length
        addOccurrence(occurrences, keyForWizard(target), uri, index.range(start, start + target.length))
      }
      for (const reload of input.node.children.filter(child => child.tag === 'reloadfrom')) {
        for (const name of nodeText(reload).split(';').map(item => item.trim()).filter(Boolean)) {
          textReference(reload, name, wizard, wizardIds, index, uri, occurrences)
        }
      }
    }
    for (const macro of wizard.macros) {
      const macroAttribute = attribute(macro.node, 'id')
      if (macro.id !== '' && macroAttribute !== undefined) {
        const range = index.range(macroAttribute.valueStart, macroAttribute.valueEnd)
        const key = keyForMacro(wizard.id, macro.id)
        declarations.push({ key, name: macro.id, kind: 'function', uri, range, declaration: true, detail: 'wizard macro' })
        occurrences.push({ key, uri, range, declaration: true })
      }
    }
    const visitConditions = (conditions: readonly { readonly node: WizardNode; readonly id?: string; readonly input?: string; readonly children: readonly any[] }[], topLevel: boolean): void => {
      for (const condition of conditions) {
        if (topLevel && condition.id !== undefined) {
          const conditionAttribute = attribute(condition.node, 'id')
          if (conditionAttribute !== undefined) {
            const range = index.range(conditionAttribute.valueStart, conditionAttribute.valueEnd)
            const key = keyForCondition(wizard.id, condition.id)
            declarations.push({ key, name: condition.id, kind: 'constant', uri, range, declaration: true, detail: 'named condition' })
            occurrences.push({ key, uri, range, declaration: true })
          }
        } else if (!topLevel && condition.id !== undefined) {
          const conditionAttribute = attribute(condition.node, 'id')
          if (conditionAttribute !== undefined) addOccurrence(occurrences, keyForCondition(wizard.id, condition.id), uri, index.range(conditionAttribute.valueStart, conditionAttribute.valueEnd))
        }
        const inputAttribute = attribute(condition.node, 'input')
        if (condition.input !== undefined && inputAttribute !== undefined) addInputName(inputAttribute.raw, inputAttribute.valueStart, wizard, wizardIds, occurrences, uri, index)
        visitConditions(condition.children, false)
      }
    }
    visitConditions(wizard.conditions, true)
    for (const input of wizard.inputs) visitConditions(input.conditions, false)
    for (const validate of wizard.validates) visitConditions(validate.conditions, false)
    for (const entry of wizard.entries) {
      visitConditions(entry.conditions, false)
      for (const field of entry.fields) {
        visitConditions(field.conditions, false)
        textReference(field.node.children.find(child => child.tag === 'loadinput'), field.loadinput, wizard, wizardIds, index, uri, occurrences)
      }
      for (const token of entry.tokens) {
        visitConditions(token.conditions, false)
        textReference(token.node.children.find(child => child.tag === 'loadinput'), token.loadinput, wizard, wizardIds, index, uri, occurrences)
      }
    }
    for (const node of nodesOf(wizard.node)) addTextReferences(node, wizard, wizardIds, occurrences, uri, index)
    // A nested token may refer to another wizard's input; the local wizard id is still the scope for
    // unqualified tokens, while the embedded target is resolved in addTextReferences above.
  }
  return { declarations, occurrences }
}

function documentsOf(request: LanguageFeatureRequest): readonly LanguageDocument[] {
  const documents: LanguageDocument[] = []
  const seen = new Set<string>()
  for (const document of [request.document, ...request.workspaceDocuments]) {
    if (document.languageId !== SC2_WIZARD_LANGUAGE_ID || seen.has(document.uri)) continue
    seen.add(document.uri)
    documents.push(document)
  }
  return documents
}

function indexOf(request: LanguageFeatureRequest): readonly WizardIndex[] {
  const documents = documentsOf(request)
  const parsed = documents.map(document => parse(document.text))
  const knownWizardIds = new Set(parsed.flatMap(item => item.file.wizards.map(wizard => wizard.id).filter(Boolean)))
  return documents.map((document, index) => wizardIndex(parsed[index] as WizardDocument, document.uri, new LineIndex(document.text), knownWizardIds))
}

function wizardReferenceOccurrenceBatches(request: LanguageFeatureRequest) {
  const context = (request as LanguageFeatureRequest & {
    readonly workspaceContext?: {
      readonly id: string
      readonly revision: string
      readonly semanticComplete: boolean
      readonly documentOrigins: readonly {
        readonly uri: string
        readonly sourceRevision: string
        readonly [key: string]: unknown
      }[]
    }
  }).workspaceContext
  if (context === undefined) return Object.freeze([])
  const documents = documentsOf(request)
  const indexes = indexOf(request)
  const parsed = documents.map(document => parse(document.text))
  const origins = new Map(context.documentOrigins.map(origin => [origin.uri, origin]))
  return Object.freeze(documents.flatMap((document, documentIndex) => {
    const origin = origins.get(document.uri)
    if (origin === undefined) return []
    const line = new LineIndex(document.text)
    const occurrences: ReferenceOccurrence[] = (indexes[documentIndex]?.occurrences ?? []).map(item => {
      const [kind, owner, name] = item.key.split(':')
      const start = line.offsetAt(item.range.start)
      const end = line.offsetAt(item.range.end)
      const identity = `${owner ?? ''}/${name ?? owner ?? ''}`
      const target = Object.freeze({
        owner: 'blizzard/sc2-wizard',
        kind: `wizard-${kind}`,
        id: identity,
        workspace: context.id,
      })
      return Object.freeze({
        target,
        source: Object.freeze({
          uri: document.uri,
          sourceRevision: origin.sourceRevision,
          span: Object.freeze({
            utf16Offset: start,
            utf16Length: end - start,
            line: item.range.start.line,
            column: item.range.start.character,
          }),
          origin,
        }),
        semanticPath: Object.freeze([kind, owner, name].filter(Boolean)),
        role: item.declaration ? 'declaration' : 'reference',
        form: 'literal',
        provenance: 'blizzard/sc2-wizard',
        ...(item.declaration
          ? {
              subject: Object.freeze({
                workspace: context.id,
                source: Object.freeze({ id: document.uri }),
                identity: Object.freeze({ kind: `blizzard/sc2-wizard-${kind}`, key: identity }),
              }),
            }
          : {}),
      })
    })
    for (const wizard of parsed[documentIndex]?.file.wizards ?? []) {
      for (const value of wizardEvaluatedStrings(wizard)) {
        for (const reference of catalogReferencesIn(value.text)) {
          const start = value.start + reference.start + 'ref='.length + reference.type.length + 1
          const at = line.positionAt(start)
          occurrences.push(Object.freeze({
            target: Object.freeze({
              owner: 'blizzard/sc2-data',
              kind: 'catalog-entity',
              namespace: reference.type,
              id: reference.entryId,
              workspace: context.id,
            }),
            source: Object.freeze({
              uri: document.uri,
              sourceRevision: origin.sourceRevision,
              span: Object.freeze({ utf16Offset: start, utf16Length: reference.entryId.length, line: at.line, column: at.character }),
              origin,
            }),
            semanticPath: Object.freeze([reference.type, reference.entryId, reference.fieldPath]),
            role: 'reference',
            form: 'literal',
            provenance: 'blizzard/sc2-wizard',
          }))
        }
      }
      for (const field of wizard.entries.flatMap(entry => entry.fields)) {
        const stringIdNode = field.node.children.find(child => child.tag === 'stringid')
        const key = field.stringid?.trim()
        if (stringIdNode === undefined || key === undefined || key === '') continue
        const sourceText = document.text.slice(stringIdNode.openEnd, stringIdNode.end - stringIdNode.closeRaw.length)
        const literalText = sourceText.trim()
        const start = stringIdNode.openEnd + (sourceText.length - sourceText.trimStart().length)
        const at = line.positionAt(start)
        occurrences.push(Object.freeze({
          target: Object.freeze({ owner: 'blizzard/sc2-strings', kind: 'string-key', id: key, workspace: context.id }),
          source: Object.freeze({
            uri: document.uri,
            sourceRevision: origin.sourceRevision,
            span: Object.freeze({ utf16Offset: start, utf16Length: literalText.length, line: at.line, column: at.character }),
            origin,
          }),
          semanticPath: Object.freeze([key]),
          role: 'reference',
          form: key.includes('^') ? 'dynamic' : 'literal',
          provenance: 'blizzard/sc2-wizard',
        }))
      }
    }
    return [Object.freeze({
      contextId: context.id,
      contextRevision: context.revision,
      semanticComplete: context.semanticComplete && !request.workspaceIncomplete,
      sourceUri: document.uri,
      sourceRevision: origin.sourceRevision,
      occurrences: Object.freeze(occurrences),
    })]
  }))
}

function offsetOf(request: LanguagePositionRequest): number {
  return new LineIndex(request.document.text).offsetAt(request.position)
}

function targetAt(index: WizardIndex, uri: string, position: LanguagePosition, text: string): Occurrence | undefined {
  const line = new LineIndex(text)
  const offset = line.offsetAt(position)
  return index.occurrences.find(item => item.uri === uri && item.range.start.line === line.positionAt(offset).line && offset >= line.offsetAt(item.range.start) && offset <= line.offsetAt(item.range.end))
}

function allSymbols(symbols: readonly LanguageSymbol[]): readonly LanguageSymbol[] {
  return symbols.flatMap(symbol => [symbol, ...allSymbols(symbol.children ?? [])])
}

function symbolsForRequest(document: LanguageDocument): readonly LanguageSymbol[] {
  const parsed = parse(document.text)
  return symbolsOf(parsed, new LineIndex(document.text))
}

function diagnosticsFor(
  document: LanguageDocument,
  workspace: readonly LanguageDocument[] = [],
): readonly LanguageDiagnostic[] {
  const parsed = parse(document.text)
  const result = analyzeWizardDocument(parsed, {
    externalWizards: workspace
      .filter(other => other.uri !== document.uri)
      .flatMap(other => parse(other.text).file.wizards.map(wizard => ({ source: other.uri, wizard }))),
    schema: WIZARD_SCHEMA,
    compatibilityMode: 'editor-compatible',
    maxDiagnostics: 1000,
  })
  const source = new LineIndex(document.text)
  return result.diagnostics.map(item => ({
    range: source.range(item.start.offset, item.end.offset),
    severity: item.severity === 'error' ? 'error' : item.severity === 'warning' ? 'warning' : 'information',
    message: item.message,
    code: item.code,
    source: SC2_WIZARD_LANGUAGE_ID,
  }))
}

function currentNode(document: WizardDocument, offset: number): WizardNode | undefined {
  return documentNodes(document)
    .filter(node => node.start <= offset && offset <= node.end)
    .sort((left, right) => right.start - left.start)[0]
}

function completionItem(label: string, kind: LanguageCompletionItem['kind'], detail?: string): LanguageCompletionItem {
  return { label, kind, ...(detail === undefined ? {} : { detail }) }
}

function fieldPaths(
  fields: readonly SchemaFieldForCompletion[],
  prefix = '',
): readonly string[] {
  return fields.flatMap(field => {
    const path = prefix === '' ? field.fieldId : `${prefix}_${field.fieldId}`
    return [path, ...(field.fields === undefined ? [] : fieldPaths(field.fields, path))]
  })
}

function wizardContaining(parsed: WizardDocument, offset: number): Wizard | undefined {
  return parsed.file.wizards.find(item => item.node.start <= offset && offset <= item.node.end)
}

function entryContaining(wizard: Wizard | undefined, offset: number) {
  return wizard?.entries.find(item => item.node.start <= offset && offset <= item.node.end)
}

function completionItems(request: LanguagePositionRequest): readonly LanguageCompletionItem[] {
  const parsed = parse(request.document.text)
  const offset = offsetOf(request)
  const node = currentNode(parsed, offset)
  const before = request.document.text.slice(Math.max(0, offset - 160), offset)
  const tagMatch = /<([A-Za-z]*)$/u.exec(before)
  if (tagMatch !== null) return ELEMENTS.filter(item => item.startsWith(tagMatch[1] ?? '')).map(item => completionItem(item, 'keyword', 'wizard element'))
  const openTag = /<([A-Za-z][A-Za-z0-9:_-]*)[^>]*$/u.exec(before)
  if (openTag !== null && node !== undefined) {
    const quote = /\b([A-Za-z][A-Za-z0-9]*)\s*=\s*["'][^"']*$/u.exec(before)
    if (quote !== null) {
      const attrName = quote[1] ?? ''
      if (attrName === 'type' && node.tag === 'validate') return [...VALIDATE_VALUES].map(item => completionItem(item, 'enum'))
      if (attrName === 'type' && node.tag === 'input') {
        const wizards = parsed.file.wizards.map(item => item.id).filter(Boolean)
        return [...INPUT_TYPES.map(item => completionItem(item, 'type', 'built-in wizard control')), ...wizards.map(item => completionItem(`Wizard:${item}`, 'class', 'embedded wizard'))]
      }
      if (node.tag === 'entry' && attrName === 'catalog') {
        return STARCRAFT2_DATA_NAMESPACES.map(item => completionItem(item, 'namespace', 'SC2 catalog'))
      }
      if (node.tag === 'entry' && attrName === 'type') {
        const catalog = attribute(node, 'catalog')?.value
        const types = Object.entries(STARCRAFT2_TYPE_NAMESPACES)
          .filter(([, namespace]) => catalog === undefined || catalog === '' || namespace === catalog)
          .map(([type]) => type)
        return types.map(item => completionItem(item, 'type', catalog === undefined ? 'SC2 catalog entry type' : catalog))
      }
      if (node.tag === 'field' && attrName === 'id') {
        const entry = entryContaining(wizardContaining(parsed, offset), offset)
        if (entry?.type === undefined || entry.type.includes('^')) return []
        const fields = resolveStarcraft2SchemaFields(entry.type) as readonly SchemaFieldForCompletion[]
        return fieldPaths(fields).map(item => completionItem(item, 'property', `${entry.type} field`))
      }
      if (attrName === 'match') return [...MATCH_VALUES].map(item => completionItem(item, 'enum'))
      if (attrName === 'operator') return [...OPERATOR_VALUES].map(item => completionItem(item, 'enum'))
      if (attrName === 'logic') return [...LOGIC_VALUES].map(item => completionItem(item, 'enum'))
      if (attrName === 'input' || attrName === 'loadinput' || attrName === 'reloadfrom') {
        const wizard = parsed.file.wizards.find(item => item.node.start <= node.start && node.start <= item.node.end)
        return (wizard?.inputs ?? []).map(item => completionItem(item.id, 'variable', item.type))
      }
    }
    const attrPrefix = /(?:\s|^)#?([A-Za-z]*)$/u.exec(before)
    if (attrPrefix !== null) {
      const allowed = [...(KNOWN_ATTRIBUTES.get(node.tag) ?? [])]
      return allowed.filter(item => item.startsWith(attrPrefix[1] ?? '')).map(item => completionItem(item, 'property', `attribute of <${node.tag}>`))
    }
  }
  const tokenStart = request.document.text.lastIndexOf('^', offset - 1)
  const caretsBefore = request.document.text.slice(0, offset).match(/\^/gu)?.length ?? 0
  if (tokenStart >= 0 && caretsBefore % 2 === 1) {
    const wizard = parsed.file.wizards.find(item => item.node.start <= offset && offset <= item.node.end)
    if (wizard !== undefined) {
      return [
        ...wizard.inputs.map(item => completionItem(item.id, 'variable', item.type)),
        ...wizard.macros.map(item => completionItem(item.id, 'function', 'wizard macro')),
        ...[...BUILT_IN_TOKENS].map(item => completionItem(item, 'keyword', 'wizard index token')),
      ]
    }
  }
  return []
}

function formatFinalNewline(request: LanguageFormattingRequest): LanguageTextEditList {
  request.signal?.throwIfAborted()
  const desired = request.options.finalNewline
  if (desired === undefined) return { edits: [], isComplete: true }
  const index = new LineIndex(request.document.text)
  const hasNewline = /(?:\r?\n)$/u.test(request.document.text)
  if (desired === hasNewline) return { edits: [], isComplete: true }
  if (desired) return { edits: [{ range: index.range(request.document.text.length, request.document.text.length), newText: '\n' }], isComplete: true }
  const start = request.document.text.replace(/(?:\r?\n)+$/u, '').length
  return { edits: [{ range: index.range(start, request.document.text.length), newText: '' }], isComplete: true }
}

function hoverFor(request: LanguagePositionRequest, occurrence: Occurrence | undefined, indexes: readonly WizardIndex[]): LanguageHover | undefined {
  if (occurrence === undefined) return undefined
  const declaration = indexes.flatMap(item => item.declarations).find(item => item.key === occurrence.key)
  if (declaration === undefined) return undefined
  const macroId = declaration.key.startsWith('macro:')
  let markdown = `**${declaration.name}** — ${declaration.detail}.`
  if (macroId) {
    const wizard = parse(request.document.text).file.wizards.find(item => item.id === declaration.key.split(':')[1])
    const macro = wizard?.macros.find(item => item.id === declaration.name)
    if (macro !== undefined && wizard !== undefined) markdown += `\n\n\`${evaluateWizardMacro(macro.id, { wizard }).text}\``
  }
  return { markdown, range: occurrence.range, provenance: 'blizzard/sc2-wizard' }
}

export function createSc2WizardLanguageProvider(options: { readonly modContexts?: Parameters<typeof servedProjectDiagnostics>[1] } = {}): LanguageProvider {
  return {
    contract: 'common.language/document-analysis',
    ...(options.modContexts === undefined ? {} : {
      semanticContextRequirements: [{ kind: 'mod-context' as const, gameId: 'blizzard/starcraft-2' }],
      modContextFeatures: ['definition' as const, 'references' as const, 'diagnostics' as const, 'completion' as const, 'hover' as const, 'workspaceSymbols' as const, 'rename' as const, 'prepareRename' as const, 'projectDiagnostics' as const],
      projectDiagnostics: (request: LanguageFeatureRequest) => servedProjectDiagnostics(request, options.modContexts!),
    }),
    languageIds: [SC2_WIZARD_LANGUAGE_ID],
    documentLocalFeatures: ['documentSymbols' as const, 'formatting' as const, 'codeActions' as const],
    workspaceLanguageIds: [SC2_WIZARD_LANGUAGE_ID],

    async analyze(request: LanguageAnalysisRequest): Promise<LanguageAnalysis> {
      const parsed = parse(request.document.text)
      const index = new LineIndex(request.document.text)
      const include = request.include
      return {
        documentUri: request.document.uri,
        documentVersion: request.document.version,
        tokens: include?.tokens === false ? [] : tokensOf(parsed, index),
        diagnostics: include?.diagnostics === false ? [] : diagnosticsFor(request.document),
        symbols: include?.symbols === false ? [] : symbolsOf(parsed, index),
      }
    },

    async diagnostics(request: LanguageFeatureRequest): Promise<LanguageDiagnosticList> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'diagnostics')
      const all = diagnosticsFor(request.document, documentsOf(request))
      const items = all.slice(0, request.maxResults)
      return { diagnostics: items, isIncomplete: items.length < all.length }
    },

    async referenceOccurrences(request: LanguageFeatureRequest) {
      return wizardReferenceOccurrenceBatches(request)
    },

    async documentSymbols(request: LanguageFeatureRequest): Promise<LanguageDocumentSymbolList> {
      const all = symbolsForRequest(request.document)
      const items = all.slice(0, request.maxResults)
      return { symbols: items, isIncomplete: items.length < all.length }
    },

    async completion(request: LanguagePositionRequest): Promise<LanguageCompletionList> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'completion')
      const all = completionItems(request)
      const items = all.slice(0, request.maxResults)
      return { items, isIncomplete: items.length < all.length }
    },

    async definition(request: LanguagePositionRequest): Promise<LanguageLocationList> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'definition')
      const indexes = indexOf(request)
      const occurrence = targetAt(indexes[0] ?? { declarations: [], occurrences: [] }, request.document.uri, request.position, request.document.text)
      if (occurrence === undefined) return { locations: [], isIncomplete: false }
      const locations: LanguageLocation[] = indexes.flatMap(item => item.declarations.filter(declaration => declaration.key === occurrence.key).map(declaration => ({ uri: declaration.uri, range: declaration.range })))
      return { locations: locations.slice(0, request.maxResults), isIncomplete: locations.length > request.maxResults || request.workspaceIncomplete }
    },

    async references(request: LanguageReferencesRequest): Promise<LanguageLocationList> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'references')
      const indexes = indexOf(request)
      const occurrence = targetAt(indexes[0] ?? { declarations: [], occurrences: [] }, request.document.uri, request.position, request.document.text)
      if (occurrence === undefined) return { locations: [], isIncomplete: false }
      const includeDeclaration = request.includeDeclaration === true
      const locations = indexes.flatMap(item => item.occurrences.filter(found => found.key === occurrence.key && (includeDeclaration || !found.declaration)).map(found => ({ uri: found.uri, range: found.range })))
      const limited = locations.slice(0, request.maxResults)
      return { locations: limited, isIncomplete: locations.length > limited.length || request.workspaceIncomplete }
    },

    async prepareRename(request: LanguagePositionRequest): Promise<LanguageRenamePreparation | undefined> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedRenameFeature(request, options.modContexts, 'prepareRename')
      const indexes = indexOf(request)
      const occurrence = targetAt(indexes[0] ?? { declarations: [], occurrences: [] }, request.document.uri, request.position, request.document.text)
      if (occurrence === undefined) return undefined
      const name = occurrence.key.split(':').at(-1)
      return name === undefined ? undefined : { range: occurrence.range, placeholder: name }
    },

    async rename(request: LanguageRenameRequest): Promise<LanguageWorkspaceEdit | undefined> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedRenameFeature(request, options.modContexts, 'rename')
      // No `:` — it would turn a plain `^Name^` token into a qualified `^Owner:Input^` one.
      if (request.workspaceIncomplete || !/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(request.newName)) return undefined
      const indexes = indexOf(request)
      const occurrence = targetAt(indexes[0] ?? { declarations: [], occurrences: [] }, request.document.uri, request.position, request.document.text)
      if (occurrence === undefined) return undefined
      // Declared in more than one document: which one the editor loads is not this provider's call.
      if (indexes.flatMap(item => item.declarations).filter(item => item.key === occurrence.key).length > 1) return undefined
      const documentChanges = []
      let count = 0
      for (const document of documentsOf(request)) {
        const documentIndex = indexes.find((item, index) => documentsOf(request)[index]?.uri === document.uri)
        const matches = (documentIndex?.occurrences ?? []).filter(item => item.key === occurrence.key)
        if (matches.some(item => item.ambiguous)) return undefined
        const edits = matches.map(item => ({ range: item.range, newText: request.newName }))
        if (edits.length === 0) continue
        count += edits.length
        if (count > request.maxEdits) return undefined
        documentChanges.push({ uri: document.uri, documentVersion: document.version, edits })
      }
      return documentChanges.length === 0 ? undefined : { documentChanges, isComplete: true }
    },

    async formatting(request: LanguageFormattingRequest): Promise<LanguageTextEditList> {
      return formatFinalNewline(request)
    },

    async codeActions(request: LanguageCodeActionsRequest) {
      return finalNewlineCodeActions(request)
    },

    async hover(request: LanguagePositionRequest): Promise<LanguageHover | undefined> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'hover')
      const indexes = indexOf(request)
      const occurrence = targetAt(indexes[0] ?? { declarations: [], occurrences: [] }, request.document.uri, request.position, request.document.text)
      return hoverFor(request, occurrence, indexes)
    },

    async workspaceSymbols(request: LanguageWorkspaceSymbolsRequest): Promise<LanguageWorkspaceSymbolList> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'workspaceSymbols')
      const query = request.query.toLocaleLowerCase()
      const found: LanguageWorkspaceSymbol[] = []
      for (const document of documentsOf(request)) {
        for (const symbol of allSymbols(symbolsForRequest(document))) {
          if (!symbol.name.toLocaleLowerCase().includes(query)) continue
          found.push({ name: symbol.name, kind: symbol.kind, detail: symbol.detail, location: { uri: document.uri, range: symbol.selectionRange } })
          if (found.length >= request.maxResults) return { symbols: found, isIncomplete: true }
        }
      }
      return { symbols: found, isIncomplete: request.workspaceIncomplete }
    },
  } as LanguageProvider
}

export const sc2WizardLanguageProvider = createSc2WizardLanguageProvider()

export function isSc2WizardDocument(text: string): boolean {
  return looksLikeWizardFile(text, PARSE_OPTIONS)
}
