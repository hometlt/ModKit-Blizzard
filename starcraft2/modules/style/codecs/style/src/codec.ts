/**
 * `FontStyles.SC2Style` as a subject: constants, font groups and styles, readable and editable.
 *
 * MK2 never opened this file. Its mod workspace parsed it into a vocabulary for other languages and
 * its editor coloured it as XML, and between the two there was no view of the file itself — no tree
 * of what it declares, no card, and no way to change a colour without editing the markup by hand.
 * That gap is the reason this codec exists rather than a port: the parser is MK2's, carried across
 * unchanged, and what is new is only the surfaces on top of it.
 *
 * The edit path is worth stating. A style sheet is hand-maintained and full of comments and
 * deliberate ordering, so a write replaces exactly the bytes of one attribute value — the span the
 * scanner already knows — and touches nothing else. Rewriting the document from the parsed model
 * would be simpler and would silently reformat a file its author reads every day.
 */
import {
  createInspectionCodec,
  createRelationGraphSource,
  createSubjectFactsSource,
  createTableDataSource,
  createTreeDataSource,
  editPlanFromInput,
  encodeXmlAttribute,
  fact,
  replaceBytes,
  scanXml,
  subjectIdFor,
  type ScannedElement,
} from '@modkit/codec-kit'
import { operationId } from '@modkit/core'
import { parseFontStyles } from '../../../shared/font-styles.js'
import { createSc2StyleLanguageProvider, SC2_STYLE_LANGUAGE_ID } from '../../../providers/language/src/language.js'

const ID = 'blizzard/sc2-style'
const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()

export const operations = Object.freeze([
  Object.freeze({
    id: 'asset.validate',
    handlerId: 'validate',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: 'export.raw',
    handlerId: 'export-raw',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['bytes']),
  }),
  Object.freeze({
    id: operationId('edit.field', { contributionId: ID }),
    handlerId: 'edit-field',
    mutatesSource: true,
    requiredPermissions: Object.freeze(['read-source', 'write-source']),
    outputKinds: Object.freeze(['edit-plan']),
  }),
])

/** Elements of one kind, in document order. */
function elementsNamed(roots: readonly ScannedElement[], tag: string): ScannedElement[] {
  const found: ScannedElement[] = []
  const walk = (nodes: readonly ScannedElement[]): void => {
    for (const node of nodes) {
      if (node.tag === tag) found.push(node)
      walk(node.children)
    }
  }
  walk(roots)
  return found
}

function attributeOf(element: ScannedElement, name: string) {
  const wanted = name.toLowerCase()
  return element.attrs.find(item => item.name.toLowerCase() === wanted)
}

function nameOf(element: ScannedElement): string {
  return attributeOf(element, 'name')?.value ?? ''
}

function isStyleSheet(text: string): boolean {
  return /^\s*(?:<\?xml\b[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<StyleFile(?:\s|>|\/)/u.test(text)
}

function basename(uri: string): string {
  const normalized = String(uri).replaceAll('\\', '/').replace(/\/$/u, '')
  const last = normalized.slice(normalized.lastIndexOf('/') + 1)
  return last === '' ? normalized : last
}

/**
 * The subject scope the localization codec already points at.
 *
 * It is written out rather than derived from `ID` because the two must match exactly for the edges
 * to meet, and a rename on one side that silently stops matching is the failure this guards.
 */
const STYLE_SUBJECT_SCOPE = 'blizzard/sc2-style'

/** Attributes whose value names another declaration in the same sheet. */
const REFERRING_ATTRIBUTES = Object.freeze([
  { attribute: 'template', role: 'inherits', type: 'Style' as const },
  { attribute: 'textcolor', role: 'colour', type: 'Constant' as const },
  { attribute: 'shadowcolor', role: 'colour', type: 'Constant' as const },
  { attribute: 'glowcolor', role: 'colour', type: 'Constant' as const },
  { attribute: 'hoverColor', role: 'colour', type: 'Constant' as const },
  { attribute: 'font', role: 'font', type: 'FontGroup' as const },
])

/**
 * The references one style element makes, kept to names the sheet actually declares.
 *
 * A colour attribute holds either a literal (`ffcc00`) or a constant's name, and there is no syntax
 * that tells them apart — so membership in the declared set is the test. An edge to a name nothing
 * declares would assert a relation that does not exist.
 */
function sheetEdgesOf(
  element: ScannedElement,
  declared: ReadonlyMap<string, ReadonlySet<string>>,
): { name: string; role: string; type: 'Style' | 'Constant' | 'FontGroup' }[] {
  const edges: { name: string; role: string; type: 'Style' | 'Constant' | 'FontGroup' }[] = []
  for (const rule of REFERRING_ATTRIBUTES) {
    const value = attributeOf(element, rule.attribute)?.value ?? ''
    if (value === '' || declared.get(rule.type)?.has(value) !== true) continue
    edges.push({ name: value, role: rule.role, type: rule.type })
  }
  return edges
}

/** The attributes a table of styles is worth showing; the rest are on the node itself. */
const TABLE_COLUMNS = Object.freeze([
  'name',
  'template',
  'font',
  'height',
  'textcolor',
  'styleflags',
  'hjustify',
  'vjustify',
])

const definition = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'sc2-style', label: 'StarCraft II Style Sheet' }),
  operations,

  async detect(prefix: Uint8Array, uri: string) {
    const text = decoder.decode(prefix)
    if (isStyleSheet(text)) {
      return { confidence: 0.99, kind: 'structure' as const, note: 'sc2-style-root-element' }
    }
    /*
     * The extension alone is weak evidence: a file named `.SC2Style` that does not start with
     * `<StyleFile>` is either truncated or something else, and claiming it confidently would take
     * it away from a codec that can actually read it.
     */
    if (/\.sc2style$/iu.test(uri)) {
      return { confidence: 0.4, kind: 'context' as const, note: 'sc2-style-path-evidence' }
    }
    return { confidence: 0, kind: 'structure' as const, note: 'sc2-style-root-missing' }
  },

  async inspect(bytes: Uint8Array, context: any) {
    const text = decoder.decode(bytes)
    if (!isStyleSheet(text)) throw new TypeError('source is not a StarCraft II style sheet')

    const roots = scanXml(text)
    const sheet = parseFontStyles(text)
    const constants = elementsNamed(roots, 'Constant')
    const fontGroups = elementsNamed(roots, 'FontGroup')
    const styles = elementsNamed(roots, 'Style')
    const declaredNames: ReadonlyMap<string, ReadonlySet<string>> = new Map([
      ['Style', new Set(styles.map(nameOf).filter(item => item !== ''))],
      ['Constant', new Set(constants.map(nameOf).filter(item => item !== ''))],
      ['FontGroup', new Set(fontGroups.map(nameOf).filter(item => item !== ''))],
    ])
    const source = context.primary.source
    const name = basename(source.uri)

    const language = createSc2StyleLanguageProvider()
    const analysis = await language.diagnostics!({
      document: { uri: String(source.uri), languageId: SC2_STYLE_LANGUAGE_ID, version: 1, text },
      workspaceDocuments: [],
      workspaceIncomplete: true,
      maxResults: context.budget.maxDiagnostics,
      maxDocuments: 1,
    })

    /*
     * Every attribute is an editable field, addressed by the element's name and the attribute's.
     * That is the identity a reader sees, and it is the one the writer resolves against the file as
     * it is when the edit lands — an offset captured now would be stale by then.
     */
    const write = {
      write: { operation: operationId('edit.field', { contributionId: ID }) },
      editor: 'scalar' as const,
    }

    const attributeNodes = (element: ScannedElement, kind: string) =>
      element.attrs.map(attribute => ({
        kind,
        label: attribute.name,
        value: attribute.value,
        type: { kind: 'text' as const },
        editable: write,
        semanticPath: [element.tag, nameOf(element), attribute.name],
      }))

    const group = (label: string, kind: string, elements: readonly ScannedElement[]) => ({
      kind: `${kind}-group`,
      label,
      preview: `${elements.length}`,
      semanticPath: [label],
      children: elements.map(element => ({
        kind,
        label: nameOf(element) === '' ? `<${element.tag}>` : nameOf(element),
        ...(attributeOf(element, 'template') === undefined
          ? {}
          : { preview: `: ${attributeOf(element, 'template')?.value ?? ''}` }),
        semanticPath: [element.tag, nameOf(element)],
        children: [
          ...attributeNodes(element, `${kind}-attribute`),
          ...element.children.map(child => ({
            kind: `${kind}-child`,
            label: child.tag,
            semanticPath: [element.tag, nameOf(element), child.tag],
            children: attributeNodes(child, `${kind}-attribute`),
          })),
        ],
      })),
    })

    const rows = styles.map(element =>
      TABLE_COLUMNS.map(column => attributeOf(element, column)?.value ?? ''),
    )

    return {
      summary: Object.freeze({
        format: 'sc2-style',
        constants: constants.length,
        fontGroups: fontGroups.length,
        styles: styles.length,
        diagnostics: analysis.diagnostics.length,
      }),
      metadata: [
        Object.freeze({
          id: 'style-sheet',
          label: 'SC2 style sheet',
          entries: Object.freeze([
            { key: 'constants', value: constants.length },
            { key: 'fontGroups', value: fontGroups.length },
            { key: 'styles', value: styles.length },
          ]),
        }),
      ],
      traits: [
        /*
         * Coloured as XML, understood as `sc2-style`. Both are stated: an editor that only knew the
         * second would show an uncoloured buffer, and one that only knew the first would send the
         * document to whatever provider claims XML.
         */
        Object.freeze({ id: 'content.text', parameters: { language: 'xml', encoding: 'utf-8' } }),
        Object.freeze({
          id: 'code.source',
          parameters: { language: SC2_STYLE_LANGUAGE_ID, authority: 'native' },
        }),
        Object.freeze({ id: 'structure.hierarchy', parameters: { kind: 'style-sheet' } }),
      ],
      text,
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'sc2-style-sheet',
          label: name,
          preview: `${styles.length} styles, ${constants.length} constants`,
          children: [
            group('Constants', 'sc2-style-constant', constants),
            group('Font groups', 'sc2-style-font-group', fontGroups),
            group('Styles', 'sc2-style-style', styles),
          ],
        }),
        'common.view/table-data-source': createTableDataSource({
          header: TABLE_COLUMNS,
          rows,
        }),
        /*
         * The style end of the style-string relation.
         *
         * A localization catalog already publishes edges from each key to the styles and constants
         * it applies, addressed by `subjectIdFor('blizzard/sc2-style', ...)`. Until now nothing
         * declared those ids, so every one of those edges pointed at a subject that did not exist
         * and a host following one arrived nowhere. This is the same relation seen from the sheet:
         * the declarations, with the ids the other side already names.
         *
         * The edges here are the ones a sheet can see on its own — `template=` inheritance between
         * styles, and a style's use of a declared constant for its colour or font. Which strings
         * use a style is not among them: an inspection codec reads its own bytes, and answering
         * that would mean inventing a workspace it does not have. The language provider answers it
         * instead, from the snapshot the host passes with each request.
         */
        'common.view/relation-graph-source': createRelationGraphSource({
          snapshotId: String(context.input.revisions.revision),
          nodes: [
            ...constants.map(element => ({
              id: subjectIdFor(STYLE_SUBJECT_SCOPE, ['Constant', nameOf(element)]),
              label: nameOf(element),
              type: 'Constant',
              kind: 'sc2-style-constant',
            })),
            ...fontGroups.map(element => ({
              id: subjectIdFor(STYLE_SUBJECT_SCOPE, ['FontGroup', nameOf(element)]),
              label: nameOf(element),
              type: 'FontGroup',
              kind: 'sc2-style-font-group',
            })),
            ...styles.map(element => ({
              id: subjectIdFor(STYLE_SUBJECT_SCOPE, ['Style', nameOf(element)]),
              label: nameOf(element),
              type: 'Style',
              kind: 'sc2-style-style',
            })),
          ].filter(node => node.label !== ''),
          edges: [
            ...new Map(
              styles.flatMap(element => {
                const from = subjectIdFor(STYLE_SUBJECT_SCOPE, ['Style', nameOf(element)])
                if (nameOf(element) === '') return []
                return sheetEdgesOf(element, declaredNames).map(edge => {
                  const to = subjectIdFor(STYLE_SUBJECT_SCOPE, [edge.type, edge.name])
                  return [`${from} ${to} ${edge.role}`, { from, to, role: edge.role }] as const
                })
              }),
            ).values(),
          ],
          /*
           * Partial for the mirror-image reason the catalog's graph is: this sheet knows what it
           * declares and what those declarations refer to, and nothing about who applies them.
           */
          completeness: 'partial',
          reason: 'the strings that apply these styles live in catalogs this session does not hold',
        }),
        'common.view/subject-facts-source': createSubjectFactsSource({
          snapshotId: String(context.input.revisions.revision),
          subjectId: source.id,
          label: name,
          kind: 'sc2-style-sheet',
          type: 'StarCraft II style sheet',
          source,
          groups: [
            {
              id: 'declares',
              label: 'Declares',
              facts: [
                fact(source, 'constants', 'Constants', constants.length),
                fact(source, 'font-groups', 'Font groups', fontGroups.length),
                fact(source, 'styles', 'Styles', styles.length),
              ],
            },
            {
              id: 'inheritance',
              label: 'Inheritance',
              facts: [
                fact(
                  source,
                  'templated',
                  'Styles built on a template',
                  styles.filter(element => attributeOf(element, 'template') !== undefined).length,
                ),
                fact(
                  source,
                  'roots',
                  'Styles with no template',
                  styles.filter(element => attributeOf(element, 'template') === undefined).length,
                ),
              ],
            },
            {
              id: 'integrity',
              label: 'Integrity',
              facts: [fact(source, 'diagnostics', 'Findings', analysis.diagnostics.length)],
            },
          ],
        }),
      },
      /*
       * The language checker's findings, republished on the descriptor so a surface that never
       * opens an editor still sees them. The line number travels in `data`: a descriptor diagnostic
       * is about the subject, and a reader who wants to jump to it needs to be told where.
       */
      diagnostics: analysis.diagnostics.map((item, ordinal) =>
        Object.freeze({
          id: `sc2-style.${ordinal}.${item.code ?? 'finding'}`,
          category: 'structure' as const,
          // The contract's code shape is `namespace/name`; the language's own codes carry the
          // format as a prefix, which becomes the namespace rather than being repeated in both.
          code: `blizzard.sc2-style/${(item.code ?? 'finding').replace(/^sc2-style-/u, '')}`,
          message: item.message,
          severity: item.severity === 'error' ? ('error' as const) : ('warning' as const),
          data: Object.freeze({
            line: item.range.start.line + 1,
            character: item.range.start.character + 1,
          }),
        }),
      ),
      unsupportedFeatures: Object.freeze(['source.save is owned by the host']),
      handlers: {
        validate: async () => ({ kind: 'json' as const, value: analysis.diagnostics }),
        'export-raw': async () => ({ kind: 'bytes' as const, value: bytes.slice() }),
        'edit-field': async (input: unknown) => {
          const request = (input ?? {}) as Record<string, unknown>
          const path = Array.isArray(request['path']) ? request['path'].map(String) : []
          if (path.length < 3) {
            throw new TypeError('edit.field needs a path of element, name and attribute')
          }
          const value = request['value']
          if (typeof value !== 'string') throw new TypeError('edit.field needs a string value')
          const [tag, declaredName, attributeName] = path.slice(-3) as [string, string, string]

          const element = elementsNamed(roots, tag).find(item => nameOf(item) === declaredName)
          if (element === undefined) {
            throw new TypeError(`no <${tag} name="${declaredName}"> in this style sheet`)
          }
          const attribute = attributeOf(element, attributeName)
          if (attribute === undefined) {
            throw new TypeError(
              `<${tag} name="${declaredName}"> has no ${attributeName} attribute to write`,
            )
          }
          /*
           * The value is written between the quotes the scanner located, so the quoting, the
           * attribute order and every byte around it survive. Escaping is the one thing that must
           * be handled here: a raw `"` or `&` would end the attribute or start an entity. It is
           * the shared encoder rather than a local one so that what this writes is exactly what
           * the shared scanner reads back.
           */
          const escaped = encodeXmlAttribute(value)
          /*
           * `TextDecoder` drops a UTF-8 byte order mark, so offsets measured in the decoded text are
           * three bytes short of the file for a sheet that starts with one; count it back in.
           */
          const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
          return {
            kind: 'edit-plan' as const,
            plan: editPlanFromInput(context.input, {
              planId: `${ID}:${context.input.revisions.revision}:${tag}/${declaredName}/${attributeName}`,
              edits: [
                replaceBytes(
                  bom + encoder.encode(text.slice(0, attribute.valueStart)).byteLength,
                  encoder.encode(text.slice(attribute.valueStart, attribute.valueEnd)).byteLength,
                  encoder.encode(escaped),
                  `set ${tag} ${declaredName} ${attributeName}`,
                ),
              ],
              fidelity: { roundTrip: 'byte-identical', preservesUnknownData: true },
            }),
          }
        },
      },
    }
  },
})

export const abiVersion = 1
export const allOperations = operations
export const createCodec = (context?: unknown) =>
  createInspectionCodec(definition as never, context as never)
export { sheetSummary }

/** A parsed sheet, for callers that want the vocabulary rather than the surfaces. */
function sheetSummary(text: string) {
  const sheet = parseFontStyles(text)
  return {
    constants: [...sheet.constants.keys()],
    fontGroups: [...sheet.fontGroups.keys()],
    styles: [...sheet.styles.keys()],
  }
}
