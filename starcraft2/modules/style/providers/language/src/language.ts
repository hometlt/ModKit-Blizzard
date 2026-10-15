/**
 * `FontStyles.SC2Style` as a language: what the file may contain, and whether what it contains
 * resolves.
 *
 * MK2 knew this format twice over and never joined the two halves. Its editor registered `sc2style`
 * with a TextMate grammar and a bracket configuration — colouring, and nothing else — while its mod
 * workspace parsed the same file into constants, font groups and styles so that *other* languages
 * could offer them: `<c val="…">` and `<s val="…">` in a localization file are answered from here.
 * So the file that declares the vocabulary was the one file with no checking of its own. This is
 * that half, built on the same ported parser the vocabulary already comes from, so a name this
 * provider accepts and a name the strings provider offers can never disagree.
 *
 * Three rules shape what it reports.
 *
 * A reference is checked, a value is not. `template="Foo"` names a style this file must declare, and
 * `textcolor="#ColorX"` names a constant — those are checkable and worth checking. Whether `height`
 * is a sensible number for a tooltip is the game's business, not the editor's.
 *
 * A later declaration wins, and saying so is the point. SC2 merges style sheets across dependencies
 * and the last definition of a name is the one in force, so a name declared twice *in one file* is
 * almost always an accident — reported, but as a warning, because the format permits it.
 *
 * Unknown is unknown. An attribute this table does not list is reported as unrecognised rather than
 * as an error: the table is drawn from a real corpus and Blizzard's own files, not from a schema
 * Blizzard published, so it is evidence, not law.
 */
import { servedLanguageFeature } from '@modkit/blizzard-starcraft2/language/served-feature'
import { servedRenameFeature } from '@modkit/blizzard-starcraft2/language/served-rename'
import { scanXml, type ScannedElement as KitElement } from '@modkit/codec-kit'
import { languageWorkspaceIsSemanticallyIncomplete } from '../../../../../shared/language/workspace-context.js'
import {
  createTextStyleSheet,
  mergeTextStyleSheetsInto,
  parseFontStyles,
  resolveTextStyle,
  textStyleSampleImage,
} from '../../../shared/font-styles.js'
import {
  COLOR_ATTRIBUTES,
  DECIMAL_COLOR,
  HEX_COLOR,
  Positions,
  SC2_LAYOUT_LANGUAGE_ID,
  SC2_STYLE_LANGUAGE_ID,
  attributeOf,
  colorTerms,
  inheritedNames,
  scanStyle,
  styleNameDefinition,
  styleNamePrepareRename,
  styleNameReferences,
  styleNameServedReferences,
  servedModContext,
  styleNameRename,
  styleOccurrences,
  styleReferenceOccurrenceBatches,
  styleWorkspace,
} from './style-names.js'
import { SC2_STRINGS_LANGUAGE_ID } from '../../../../strings/providers/language/src/language.js'
import {
  finalNewlineCodeActions,
  finalNewlineFormatting,
} from '../../../../../shared/language/code-actions.js'
import {
  decimalColor,
  hexColor,
  parseColorLiteral,
} from '../../../../../shared/language/sc2-colors.js'
import { servedProjectDiagnostics } from '@modkit/blizzard-starcraft2/language/served-project-diagnostics'
import type {
  LanguageAnalysis,
  LanguageAnalysisRequest,
  LanguageCodeActionList,
  LanguageCodeActionsRequest,
  LanguageColorInformation,
  LanguageColorList,
  LanguageColorPresentationList,
  LanguageColorPresentationRequest,
  LanguageFormattingRequest,
  LanguageRenamePreparation,
  LanguageRenameRequest,
  LanguageTextEditList,
  LanguageToken,
  LanguageWorkspaceEdit,
  LanguageWorkspaceSymbol,
  LanguageWorkspaceSymbolList,
  LanguageWorkspaceSymbolsRequest,
  LanguageCompletionItem,
  LanguageCompletionList,
  LanguageDiagnostic,
  LanguageDiagnosticList,
  LanguageDocumentSymbolList,
  LanguageFeatureRequest,
  LanguageHover,
  LanguageLocationList,
  LanguagePositionRequest,
  LanguageProvider,
  LanguageRange,
  LanguageReferencesRequest,
  LanguageSymbol,
} from '@modkit/sdk'

export { SC2_STYLE_LANGUAGE_ID, scanStyle }


const HJUSTIFY = Object.freeze(['Left', 'Center', 'Right'])
const VJUSTIFY = Object.freeze(['Top', 'Middle', 'Bottom'])
/*
 * Style and font flags, as they appear across 131 installed style sheets rather than as a guess.
 * `!Flag` turns an inherited flag off, and the spellings vary in case (`UpperCase`), so both the
 * check and the completion compare case-insensitively.
 */
const STYLE_FLAGS = Object.freeze([
  'Shadow',
  'Glow',
  'Outline',
  'Uppercase',
  'InlineJustification',
  'TightGradient',
  'HintStyleLight',
  'HintStyleNormal',
  'HintingOff',
  'HintingAuto',
])
const FONT_FLAGS = Object.freeze(['Bold', 'Italic', 'Outline'])

/**
 * The element table. Every rule below reads it, so the completion list and the diagnostics cannot
 * drift apart — the same failure the bank language avoids the same way.
 */
export const STYLE_ELEMENTS = Object.freeze({
  StyleFile: {
    parent: undefined as string | undefined,
    attributes: Object.freeze([] as readonly string[]),
    required: Object.freeze([] as readonly string[]),
    documentation: 'Root element of a style sheet.',
  },
  Constant: {
    parent: 'StyleFile',
    attributes: Object.freeze(['name', 'val']),
    required: Object.freeze(['name', 'val']),
    documentation:
      'A named value other declarations refer to as `#Name` — a colour, a font group, or another constant.',
  },
  FontGroup: {
    parent: 'StyleFile',
    attributes: Object.freeze(['name', 'requiredtoload']),
    required: Object.freeze(['name']),
    documentation: 'A set of fonts, chosen per codepoint range, that a style can be drawn with.',
  },
  CodepointRange: {
    parent: 'FontGroup',
    attributes: Object.freeze(['font', 'min', 'max', 'comment']),
    required: Object.freeze(['font']),
    documentation: 'One font, used for the codepoints in this range.',
  },
  Style: {
    parent: 'StyleFile',
    attributes: Object.freeze([
      'name',
      'template',
      'font',
      'height',
      'styleflags',
      'fontflags',
      'hjustify',
      'vjustify',
      'shadowoffset',
      'outlinewidth',
      'linespacing',
      'characterspacing',
      'requiredtoload',
      ...COLOR_ATTRIBUTES,
    ]),
    required: Object.freeze(['name']),
    documentation: 'A named text style. `template` inherits every attribute of another style.',
  },
})

export type StyleElementName = keyof typeof STYLE_ELEMENTS

const ELEMENT_NAMES = Object.freeze(Object.keys(STYLE_ELEMENTS) as StyleElementName[])

function isStyleElement(name: string): name is StyleElementName {
  return Object.hasOwn(STYLE_ELEMENTS, name)
}

const NUMBER = /^-?(?:\d+|\d*\.\d+)$/u

/** A font file a hover names for the host to draw a sample of, as the game spells its path. */
const FONT_PATH = /\.(?:otf|ttf)$/iu
const fontAsset = (path: string | undefined) =>
  path !== undefined && FONT_PATH.test(path.trim()) ? { assets: [{ path: path.trim() }] } : {}

const ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  hjustify: HJUSTIFY,
  vjustify: VJUSTIFY,
})

const FLAG_SETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  styleflags: STYLE_FLAGS,
  fontflags: FONT_FLAGS,
})


/** One side of a colour: a hex literal, a decimal triple or quad, or a constant reference. */
function isColorTerm(value: string): boolean {
  const term = value.trim()
  return term.startsWith('#') || HEX_COLOR.test(term) || DECIMAL_COLOR.test(term)
}

/**
 * Whether a colour value is one this format accepts, ignoring whether a constant it names exists.
 *
 * A gradient is two colours separated by a dash. Splitting on the dash has to keep the decimal form
 * intact, so the split is on a dash that is not inside a term — in practice `a - b` and `a-b` where
 * neither side contains a comma-separated triple straddling it.
 */
export function styleColorProblem(value: string): string | undefined {
  if (isColorTerm(value)) return undefined
  const gradient = value.split(/\s*-\s*/u)
  if (gradient.length === 2 && gradient.every(isColorTerm)) return undefined
  return `Not a colour: expected RRGGBB[AA], "R,G,B[,A]", #Constant or a gradient "a - b", got "${value}"`
}

/*
 * The two flag sets are checked as one union, because the game accepts them as one: `Bold` is a
 * font flag by name and appears in `styleflags` throughout Blizzard's sheets. Completion still
 * offers the set that belongs to the attribute — that is guidance — but refusing the other set here
 * would be reporting a defect the game does not have.
 */
const ALL_FLAGS = Object.freeze([...new Set([...STYLE_FLAGS, ...FONT_FLAGS])])

function flagProblem(attribute: string, value: string): string | undefined {
  if (FLAG_SETS[attribute] === undefined) return undefined
  for (const raw of value.split('|')) {
    const flag = raw.trim().replace(/^!/u, '')
    if (flag === '') continue
    if (!ALL_FLAGS.some(item => item.toLowerCase() === flag.toLowerCase())) {
      return `Unknown ${attribute} value "${flag}"`
    }
  }
  return undefined
}


function diagnosticsFor(
  text: string,
  inherited: {
    constants: Set<string>
    fontGroups: Set<string>
    styles: Set<string>
  } = { constants: new Set(), fontGroups: new Set(), styles: new Set() },
): readonly LanguageDiagnostic[] {
  const index = new Positions(text)
  const scan = scanStyle(text)
  const found: LanguageDiagnostic[] = []
  const say = (
    range: LanguageRange,
    severity: LanguageDiagnostic['severity'],
    code: string,
    message: string,
  ): void => {
    found.push({ range, severity, code, source: SC2_STYLE_LANGUAGE_ID, message })
  }

  const declared = {
    constants: new Set<string>(),
    fontGroups: new Set<string>(),
    styles: new Set<string>(),
  }
  for (const { element } of scan) {
    const name = attributeOf(element, 'name')?.value
    if (name === undefined || name === '') continue
    if (element.tag === 'Constant') declared.constants.add(name)
    if (element.tag === 'FontGroup') declared.fontGroups.add(name)
    if (element.tag === 'Style') declared.styles.add(name)
  }

  const seen = new Map<string, Set<string>>()

  for (const { element, parent } of scan) {
    if (!isStyleElement(element.tag)) {
      say(
        index.range(element.tagStart, element.tagEnd),
        'warning',
        'sc2-style-unknown-element',
        `Unknown style element <${element.tag}>`,
      )
      continue
    }
    const schema = STYLE_ELEMENTS[element.tag]
    if (schema.parent !== parent) {
      say(
        index.range(element.tagStart, element.tagEnd),
        'error',
        'sc2-style-misplaced-element',
        schema.parent === undefined
          ? `<${element.tag}> is the root element and cannot appear inside <${String(parent)}>`
          : `<${element.tag}> belongs in <${schema.parent}>, not ${
              parent === undefined ? 'at the top level' : `in <${parent}>`
            }`,
      )
    }

    for (const required of schema.required) {
      if (attributeOf(element, required) === undefined) {
        say(
          index.range(element.tagStart, element.tagEnd),
          'error',
          'sc2-style-missing-attribute',
          `<${element.tag}> requires a ${required} attribute`,
        )
      }
    }

    const usedHere = new Set<string>()
    for (const attribute of element.attrs) {
      const attributeName = attribute.name.toLowerCase()
      if (!schema.attributes.includes(attributeName)) {
        say(
          index.range(attribute.nameStart, attribute.nameEnd),
          'warning',
          'sc2-style-unknown-attribute',
          `<${element.tag}> has no known attribute "${attribute.name}"`,
        )
        continue
      }
      if (usedHere.has(attributeName)) {
        say(
          index.range(attribute.nameStart, attribute.nameEnd),
          'warning',
          'sc2-style-duplicate-attribute',
          `"${attribute.name}" is set twice on this <${element.tag}>`,
        )
      }
      usedHere.add(attributeName)

      const value = attribute.value
      const span = index.range(attribute.valueStart, attribute.valueEnd)

      /*
       * A `#Name` is a reference into this sheet. Blizzard's own files also merge across mods, so a
       * name this file does not declare may still resolve at load time — hence a warning, not an
       * error, and one that says which it is.
       */
      if (value.startsWith('#')) {
        const target = value.slice(1)
        const resolves =
          declared.constants.has(target) ||
          declared.fontGroups.has(target) ||
          inherited.constants.has(target) ||
          inherited.fontGroups.has(target)
        if (!resolves) {
          say(
            span,
            'warning',
            'sc2-style-unresolved-constant',
            `"${target}" is not declared in this file; it must come from a dependency`,
          )
        }
        continue
      }

      if (attributeName === 'template') {
        if (!declared.styles.has(value) && !inherited.styles.has(value)) {
          say(
            span,
            'warning',
            'sc2-style-unresolved-template',
            `Template "${value}" is not declared in this file; it must come from a dependency`,
          )
        }
        continue
      }

      if (COLOR_ATTRIBUTES.includes(attributeName)) {
        const problem = styleColorProblem(value)
        if (problem !== undefined) say(span, 'error', 'sc2-style-invalid-color', problem)
        continue
      }

      const enumeration = ENUMS[attributeName]
      if (enumeration !== undefined) {
        if (!enumeration.some(item => item.toLowerCase() === value.toLowerCase())) {
          say(
            span,
            'error',
            'sc2-style-invalid-enum',
            `${attributeName} must be one of ${enumeration.join(', ')}, got "${value}"`,
          )
        }
        continue
      }

      const flags = flagProblem(attributeName, value)
      if (flags !== undefined) {
        say(span, 'error', 'sc2-style-invalid-flags', flags)
        continue
      }

      if (
        (attributeName === 'height' ||
          attributeName === 'shadowoffset' ||
          attributeName === 'outlinewidth') &&
        !NUMBER.test(value)
      ) {
        say(
          span,
          'error',
          'sc2-style-invalid-number',
          `${attributeName} must be a number, got "${value}"`,
        )
      }
    }

    /*
     * Duplicate names. A style sheet is merged by name and the last one wins, so a name declared
     * twice in one file silently discards the first declaration.
     */
    const name = attributeOf(element, 'name')
    if (name !== undefined && name.value !== '') {
      const kind = element.tag
      let names = seen.get(kind)
      if (names === undefined) {
        names = new Set<string>()
        seen.set(kind, names)
      }
      if (names.has(name.value)) {
        say(
          index.range(name.valueStart, name.valueEnd),
          'warning',
          'sc2-style-duplicate-name',
          `<${kind} name="${name.value}"> is declared more than once; the last one wins`,
        )
      }
      names.add(name.value)
    }
  }

  return Object.freeze(found)
}


/**
 * Semantic tokens for one sheet.
 *
 * The analysis request carries one document, so a bare `font` or `val` is a FontGroup only when this
 * sheet declares it; everything else — `#Name`, `template`, declarations — types without the
 * workspace.
 */
function tokensFor(text: string): readonly LanguageToken[] {
  const index = new Positions(text)
  const declared = inheritedNames([{ text }])
  const names = styleOccurrences(text, declared)
  const tokens: { start: number; token: LanguageToken }[] = []
  const add = (from: number, to: number, kind: LanguageToken['kind']): void => {
    if (to > from) tokens.push({ start: from, token: { range: index.range(from, to), kind } })
  }
  for (const { element } of scanStyle(text)) {
    add(element.tagStart, element.tagEnd, 'type')
    for (const attribute of element.attrs) {
      add(attribute.nameStart, attribute.nameEnd, 'property')
      const from = attribute.valueStart
      const to = attribute.valueEnd
      const inside = names.filter(item => item.start >= from && item.end <= to)
      if (inside.length > 0) {
        for (const item of inside) add(item.start, item.end, item.kind === 'style' ? 'type' : 'variable')
        continue
      }
      const name = attribute.name.toLowerCase()
      if (COLOR_ATTRIBUTES.includes(name) || (element.tag === 'Constant' && name === 'val')) {
        const terms = colorTerms(attribute.value, from).filter(term => parseColorLiteral(term.text))
        if (terms.length > 0) {
          for (const term of terms) add(term.start, term.start + term.text.length, 'number')
          continue
        }
      }
      if (ENUMS[name] !== undefined || FLAG_SETS[name] !== undefined) add(from, to, 'keyword')
      else if (NUMBER.test(attribute.value)) add(from, to, 'number')
      else add(from, to, 'string')
    }
  }
  return Object.freeze(tokens.sort((left, right) => left.start - right.start).map(item => item.token))
}

/**
 * Literal colours, each with the span of exactly one colour.
 *
 * A gradient yields two swatches, one per term, because each term is one colour. A `#Constant` yields
 * none: a picker edit on it would replace the reference with a literal and quietly detach the style
 * from the constant it was written against.
 */
function colorsFor(text: string): readonly LanguageColorInformation[] {
  const index = new Positions(text)
  const colors: LanguageColorInformation[] = []
  for (const { element } of scanStyle(text)) {
    for (const attribute of element.attrs) {
      const name = attribute.name.toLowerCase()
      const colourful =
        (element.tag === 'Style' && COLOR_ATTRIBUTES.includes(name)) ||
        (element.tag === 'Constant' && name === 'val')
      if (!colourful) continue
      for (const term of colorTerms(attribute.value, attribute.valueStart)) {
        const parsed = parseColorLiteral(term.text)
        if (parsed === undefined) continue
        colors.push({ range: index.range(term.start, term.start + term.text.length), color: parsed.color })
      }
    }
  }
  return colors
}

function symbolsFor(text: string): readonly LanguageSymbol[] {
  const index = new Positions(text)
  const symbols: LanguageSymbol[] = []
  for (const { element } of scanStyle(text)) {
    if (element.tag !== 'Constant' && element.tag !== 'Style' && element.tag !== 'FontGroup') {
      continue
    }
    const name = attributeOf(element, 'name')
    if (name === undefined) continue
    symbols.push({
      name: name.value,
      kind: element.tag === 'Constant' ? 'constant' : element.tag === 'Style' ? 'class' : 'namespace',
      ...(element.tag === 'Style' && attributeOf(element, 'template') !== undefined
        ? { detail: `: ${attributeOf(element, 'template')?.value ?? ''}` }
        : {}),
      range: index.range(element.start, element.end),
      selectionRange: index.range(name.valueStart, name.valueEnd),
    })
  }
  return Object.freeze(symbols)
}

type CompletionContext =
  | { readonly kind: 'element'; readonly parent?: string }
  | { readonly kind: 'attribute'; readonly element: string }
  | { readonly kind: 'attribute-value'; readonly element: string; readonly attribute?: string }

/** Where the caret is, in the terms the format cares about. Same shape as the bank's. */
function completionContext(text: string, offset: number): CompletionContext | undefined {
  const before = text.slice(0, offset)
  const open = before.lastIndexOf('<')
  if (open < 0) return undefined
  if (before.indexOf('>', open) >= 0) return undefined
  const inside = before.slice(open + 1)
  if (inside.startsWith('/') || inside.startsWith('?') || inside.startsWith('!')) return undefined

  const name = /^([A-Za-z_][\w:.-]*)?/u.exec(inside)?.[1] ?? ''
  if (!/\s/u.test(inside)) {
    const parent = elementAt(text, open)
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

/** The innermost element still open at `offset` — containment, not "the last tag scanned". */
function elementAt(text: string, offset: number): string | undefined {
  let deepest: KitElement | undefined
  const walk = (nodes: readonly KitElement[]): void => {
    for (const node of nodes) {
      if (offset > node.start && offset < node.end) {
        deepest = node
        walk(node.children)
        return
      }
    }
  }
  walk(scanXml(text))
  return deepest?.tag
}

function snippetFor(name: StyleElementName): string {
  if (name === 'StyleFile') return 'StyleFile>$0</StyleFile>'
  if (name === 'Constant') return 'Constant name="$1" val="$2"/>'
  if (name === 'FontGroup') return 'FontGroup name="$1">$0</FontGroup>'
  if (name === 'CodepointRange') return 'CodepointRange font="$1"/>'
  return 'Style name="$1" template="$2"/>'
}

/**
 * Every style, font group and constant the snapshot's style sheets declare, with the file that
 * declares it (`undefined` for this document, which comes last and wins), as `template=` and `#Name`
 * resolve across sheets (parity plan 4.2).
 */
function snapshotNames(request: LanguagePositionRequest): {
  styles: Map<string, string | undefined>
  fontGroups: Map<string, string | undefined>
  constants: Map<string, { value: string; file: string | undefined }>
} {
  const styles = new Map<string, string | undefined>()
  const fontGroups = new Map<string, string | undefined>()
  const constants = new Map<string, { value: string; file: string | undefined }>()
  const sheets = [
    ...request.workspaceDocuments.filter(item => item.languageId === 'sc2-style' && item.uri !== request.document.uri),
    request.document,
  ]
  for (const sheet of sheets) {
    const file = sheet === request.document ? undefined : decodeURIComponent(sheet.uri).split(/[\\/]/u).slice(-2).join('/')
    const parsed = parseFontStyles(sheet.text)
    for (const name of parsed.styles.keys()) styles.set(name, file)
    for (const name of parsed.fontGroups.keys()) fontGroups.set(name, file)
    for (const [name, value] of parsed.constants) constants.set(name, { value, file })
  }
  return { styles, fontGroups, constants }
}

/**
 * A style's sample line as hover markdown (parity plan 4.1), resolved over the snapshot's sheets with
 * this document last; `''` when no sheet declares the style.
 */
/** A style across every sheet of the snapshot, this one last, its templates and constants merged. */
function resolvedStyleOf(request: LanguagePositionRequest, name: string) {
  const sheets = [
    ...request.workspaceDocuments.filter(item => item.languageId === 'sc2-style' && item.uri !== request.document.uri),
    request.document,
  ]
  const merged = createTextStyleSheet()
  for (const sheet of sheets) mergeTextStyleSheetsInto(merged, parseFontStyles(sheet.text))
  return resolveTextStyle(merged, name)
}

function sampleOf(request: LanguagePositionRequest, name: string): string {
  const style = resolvedStyleOf(request, name)
  return style === undefined ? '' : `\n\n![${name}](${textStyleSampleImage(style)})`
}

/** The attributes a style ends up with, through its template chain (parity plan 4.3). */
function mergedAttributesOf(request: LanguagePositionRequest, name: string): string | undefined {
  const style = resolvedStyleOf(request, name)
  if (style === undefined) return undefined
  return Object.entries(style.attrs)
    .filter(([key]) => !['name', 'template'].includes(key.toLowerCase()))
    .map(([key, item]) => `\`${key}="${item}"\``)
    .join(', ')
}

function completionFor(request: LanguagePositionRequest): LanguageCompletionList {
      const text = request.document.text
      const offset = new Positions(text).offset(request.position)
      const context = completionContext(text, offset)
      if (context === undefined) return { items: [], isIncomplete: false }

      if (context.kind === 'element') {
        const allowed = ELEMENT_NAMES.filter(name => {
          const parent = STYLE_ELEMENTS[name].parent
          if (parent === undefined) return context.parent === undefined
          return context.parent === undefined || context.parent === parent
        })
        return {
          items: allowed.map(
            (name): LanguageCompletionItem => ({
              label: name,
              kind: 'class',
              detail: `style element${
                STYLE_ELEMENTS[name].parent === undefined
                  ? ''
                  : ` in ${STYLE_ELEMENTS[name].parent}`
              }`,
              documentation: STYLE_ELEMENTS[name].documentation,
              insertText: snippetFor(name),
              insertTextFormat: 'snippet',
            }),
          ),
          isIncomplete: false,
        }
      }

      if (context.kind === 'attribute') {
        if (!isStyleElement(context.element)) return { items: [], isIncomplete: false }
        const schema = STYLE_ELEMENTS[context.element]
        const already = new Set(
          scanStyle(text.slice(0, offset))
            .at(-1)
            ?.element.attrs.map(item => item.name.toLowerCase()) ?? [],
        )
        return {
          items: schema.attributes
            .filter(name => !already.has(name))
            .map(
              (name): LanguageCompletionItem => ({
                label: name,
                kind: 'property',
                detail: `${context.element} attribute`,
                insertText: `${name}="$1"`,
                insertTextFormat: 'snippet',
              }),
            ),
          isIncomplete: false,
        }
      }

      const attribute = (context.attribute ?? '').toLowerCase()
      const names = snapshotNames(request)
      // The whole value is replaced, so a `#` already typed is not doubled (parity plan 4.2).
      const valueStart = text.lastIndexOf('"', offset - 1) + 1
      const closing = text.indexOf('"', offset)
      const replacementRange = new Positions(text).range(valueStart, closing < 0 ? offset : closing)
      const where = (file: string | undefined) => (file === undefined ? 'this file' : file)

      if (attribute === 'name') return { items: [], isIncomplete: false }

      if (attribute === 'template') {
        return {
          items: [...names.styles].sort(([left], [right]) => left.localeCompare(right)).map(
            ([name, file]): LanguageCompletionItem => ({
              label: name,
              kind: 'class',
              detail: `style in ${where(file)}`,
              replacementRange,
            }),
          ),
          isIncomplete: false,
        }
      }

      if (attribute === 'font') {
        return {
          items: [
            ...[...names.fontGroups].map(([name, file]) => ({ name, detail: `font group in ${where(file)}` })),
            ...[...names.constants].map(([name, constant]) => ({ name, detail: `${constant.value} (${where(constant.file)})` })),
          ]
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(
              (item): LanguageCompletionItem => ({
                label: `#${item.name}`,
                kind: 'constant',
                detail: item.detail,
                insertText: `#${item.name}`,
                replacementRange,
              }),
            ),
          isIncomplete: false,
        }
      }

      if (COLOR_ATTRIBUTES.includes(attribute)) {
        return {
          items: [...names.constants].sort(([left], [right]) => left.localeCompare(right)).map(
            ([name, constant]): LanguageCompletionItem => ({
              label: `#${name}`,
              kind: 'constant',
              detail: `${constant.value} (${where(constant.file)})`,
              insertText: `#${name}`,
              replacementRange,
            }),
          ),
          isIncomplete: false,
        }
      }

      const enumeration = ENUMS[attribute] ?? FLAG_SETS[attribute]
      if (enumeration !== undefined) {
        return {
          items: enumeration.map(
            (value): LanguageCompletionItem => ({
              label: value,
              kind: 'enum',
              detail: FLAG_SETS[attribute] === undefined ? attribute : `${attribute} flag`,
            }),
          ),
          isIncomplete: false,
        }
      }

      return { items: [], isIncomplete: false }
    }

export function createSc2StyleLanguageProvider(options: { readonly modContexts?: Parameters<typeof styleNameServedReferences>[1] } = {}): LanguageProvider {
  return {
    contract: 'common.language/document-analysis',
    languageIds: [SC2_STYLE_LANGUAGE_ID],
    documentLocalFeatures: ['documentSymbols' as const, 'formatting' as const, 'codeActions' as const, 'documentColors' as const, 'colorPresentations' as const],
    semanticInputs: [
      { kind: 'format-spec', id: 'blizzard/sc2-style@1', revision: 'mk3-language-2' },
      { kind: 'provider', id: 'blizzard/sc2-style-language', revision: '2' },
    ],
    /*
     * Localization catalogs and layouts are read, never analysed. `references` and a complete
     * `rename` need every `.txt` and `.SC2Layout` that applies a style — a rename that skipped the
     * layouts would leave them pointing at a name that no longer exists — and this is the
     * contract's explicit way to ask for them. A provider that
     * silently expected them would get style sheets and report the wrong answer confidently.
     * The opt-in must name this language too: the host treats a list without the primary route as
     * invalid and falls back to a sheets-only snapshot, which is exactly that silent failure.
     */
    workspaceLanguageIds: [SC2_STYLE_LANGUAGE_ID, SC2_STRINGS_LANGUAGE_ID, SC2_LAYOUT_LANGUAGE_ID],
    ...(options.modContexts === undefined ? {} : {
      semanticContextRequirements: [{ kind: 'mod-context' as const, gameId: 'blizzard/starcraft-2' }],
      modContextFeatures: ['definition' as const, 'diagnostics' as const, 'completion' as const, 'hover' as const, 'workspaceSymbols' as const, 'references' as const, 'rename' as const, 'prepareRename' as const, 'projectDiagnostics' as const],
      projectDiagnostics: (request: LanguageFeatureRequest) => servedProjectDiagnostics(request, options.modContexts!),
    }),

    async analyze(request: LanguageAnalysisRequest): Promise<LanguageAnalysis> {
      const text = request.document.text
      const include = request.include
      return {
        documentUri: request.document.uri,
        documentVersion: request.document.version,
        tokens: include?.tokens === false ? [] : tokensFor(text),
        // `analyze` sees one document by contract, so inherited names are not resolvable here;
        // `diagnostics` is the request that carries a workspace, and it resolves them there.
        diagnostics: include?.diagnostics === false ? [] : diagnosticsFor(text),
        symbols: include?.symbols === false ? [] : symbolsFor(text),
      }
    },

    async diagnostics(request: LanguageFeatureRequest): Promise<LanguageDiagnosticList> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'diagnostics')
      const all = diagnosticsFor(
        request.document.text,
        inheritedNames(request.workspaceDocuments.filter(item => item.uri !== request.document.uri)),
      )
      const items = all.slice(0, request.maxResults)
      return {
        diagnostics: items,
        isIncomplete: items.length < all.length || languageWorkspaceIsSemanticallyIncomplete(request),
      }
    },

    async referenceOccurrences(request: LanguageFeatureRequest) {
      return styleReferenceOccurrenceBatches(request)
    },


    async definition(request: LanguagePositionRequest): Promise<LanguageLocationList> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'definition')
      return styleNameDefinition(request)
    },

    /**
     * The other half of the style-string relation, asked from the sheet. A style sheet does not
     * know its own users; the workspace snapshot the host sends with each request does.
     */
    async references(request: LanguageReferencesRequest): Promise<LanguageLocationList> {
      const served = options.modContexts === undefined ? undefined : servedModContext(request)
      return served === undefined ? styleNameReferences(request) : styleNameServedReferences(request, options.modContexts!, served)
    },

    async prepareRename(
      request: LanguagePositionRequest,
    ): Promise<LanguageRenamePreparation | undefined> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedRenameFeature(request, options.modContexts, 'prepareRename')
      return styleNamePrepareRename(request)
    },

    async rename(request: LanguageRenameRequest): Promise<LanguageWorkspaceEdit | undefined> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedRenameFeature(request, options.modContexts, 'rename')
      return styleNameRename(request)
    },

    async documentColors(request: LanguageFeatureRequest): Promise<LanguageColorList> {
      const all = colorsFor(request.document.text)
      const colors = all.slice(0, request.maxResults)
      return { colors, isIncomplete: colors.length < all.length }
    },

    /** The picked colour in the notation the span already uses, then the other one. */
    async colorPresentations(
      request: LanguageColorPresentationRequest,
    ): Promise<LanguageColorPresentationList> {
      const index = new Positions(request.document.text)
      const authored = request.document.text
        .slice(index.offset(request.range.start), index.offset(request.range.end))
        .trim()
      const parsed = parseColorLiteral(authored)
      if (parsed === undefined) return { presentations: [], isIncomplete: false }
      const hex = hexColor(request.color, parsed.includesAlpha)
      const decimal = decimalColor(request.color, parsed.includesAlpha)
      const labels = parsed.decimal ? [decimal, hex] : [hex, decimal]
      const presentations = labels
        .slice(0, request.maxResults)
        .map(label => ({ label, textEdit: { range: request.range, newText: label } }))
      return { presentations, isIncomplete: presentations.length < labels.length }
    },

    async workspaceSymbols(
      request: LanguageWorkspaceSymbolsRequest,
    ): Promise<LanguageWorkspaceSymbolList> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'workspaceSymbols')
      const query = request.query.toLowerCase()
      const all: LanguageWorkspaceSymbol[] = styleWorkspace(request).sheets.flatMap(document => {
        const index = new Positions(document.text)
        return document.occurrences
          .filter(item => item.declaration && item.name.toLowerCase().includes(query))
          .map(item => ({
            name: item.name,
            kind:
              item.kind === 'constant'
                ? ('constant' as const)
                : item.kind === 'style'
                  ? ('class' as const)
                  : ('namespace' as const),
            detail: item.kind,
            location: { uri: document.uri, range: index.range(item.start, item.end) },
          }))
      })
      const symbols = all.slice(0, request.maxResults)
      return {
        symbols,
        isIncomplete:
          symbols.length < all.length || languageWorkspaceIsSemanticallyIncomplete(request),
      }
    },

    async formatting(request: LanguageFormattingRequest): Promise<LanguageTextEditList> {
      return finalNewlineFormatting(request)
    },

    async codeActions(request: LanguageCodeActionsRequest): Promise<LanguageCodeActionList> {
      return finalNewlineCodeActions(request)
    },

    async documentSymbols(request: LanguageFeatureRequest): Promise<LanguageDocumentSymbolList> {
      const all = symbolsFor(request.document.text)
      const items = all.slice(0, request.maxResults)
      return { symbols: items, isIncomplete: items.length < all.length }
    },

    /** Every list is bounded by the request: a style sheet holds thousands of names. */
    async completion(request: LanguagePositionRequest): Promise<LanguageCompletionList> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'completion')
      const all = completionFor(request)
      const items = all.items.slice(0, request.maxResults)
      return {
        items,
        isIncomplete:
          all.isIncomplete ||
          items.length < all.items.length ||
          languageWorkspaceIsSemanticallyIncomplete(request),
      }
    },

    async hover(request: LanguagePositionRequest): Promise<LanguageHover | undefined> {
      if (options.modContexts !== undefined && servedModContext(request) !== undefined) return servedLanguageFeature(request, options.modContexts, 'hover')
      const text = request.document.text
      const index = new Positions(text)
      const offset = index.offset(request.position)
      const sheet = parseFontStyles(text)

      for (const { element } of scanStyle(text)) {
        if (offset < element.start || offset > element.end) continue
        for (const attribute of element.attrs) {
          if (offset < attribute.valueStart || offset > attribute.valueEnd) continue
          const value = attribute.value
          if (value.startsWith('#')) {
            const target = value.slice(1)
            const constant = sheet.constants.get(target)
            const group = sheet.fontGroups.get(target)
            if (constant === undefined && group === undefined) return undefined
            return {
              markdown:
                constant === undefined
                  ? `**${target}** — font group`
                  : `**${target}** = \`${constant}\``,
              range: index.range(attribute.valueStart, attribute.valueEnd),
              provenance: 'blizzard/sc2-style',
              ...fontAsset(constant),
            }
          }
          if (FONT_PATH.test(value.trim()))
            return {
              markdown: `\`${value.trim()}\` — font file`,
              range: index.range(attribute.valueStart, attribute.valueEnd),
              provenance: 'blizzard/sc2-style',
              ...fontAsset(value),
            }
          // A template, from any sheet of the snapshot: what it gives, merged along its own chain (4.3).
          if (attribute.name.toLowerCase() === 'template') {
            const attrs = mergedAttributesOf(request, value)
            if (attrs === undefined) return undefined
            return {
              markdown: `**${value}** — ${attrs === '' ? 'style with no attributes' : attrs}${sampleOf(request, value)}`,
              range: index.range(attribute.valueStart, attribute.valueEnd),
              provenance: 'blizzard/sc2-style',
            }
          }
          // A style's own name: what the style ends up with and looks like (4.1, 4.3).
          if (element.tag === 'Style' && attribute.name.toLowerCase() === 'name' && value !== '') {
            const attrs = mergedAttributesOf(request, value)
            if (attrs === undefined) return undefined
            return {
              markdown: `**${value}** — style${attrs === '' ? '' : `\n\n${attrs}`}${sampleOf(request, value)}`,
              range: index.range(attribute.valueStart, attribute.valueEnd),
              provenance: 'blizzard/sc2-style',
            }
          }
          return undefined
        }
        if (offset >= element.tagStart && offset <= element.tagEnd && isStyleElement(element.tag)) {
          return {
            markdown: `**<${element.tag}>** — ${STYLE_ELEMENTS[element.tag].documentation}`,
            range: index.range(element.tagStart, element.tagEnd),
            provenance: 'blizzard/sc2-style',
          }
        }
      }
      return undefined
    },
  } as LanguageProvider
}

export const sc2StyleLanguageProvider: LanguageProvider = createSc2StyleLanguageProvider()
