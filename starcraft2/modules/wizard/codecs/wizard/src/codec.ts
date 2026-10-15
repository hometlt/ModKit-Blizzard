/**
 * `.BlizWiz` — StarCraft II Data Wizards — as a subject.
 *
 * A data wizard is an editor template: it defines the inputs a user fills in and the catalog
 * entries generated from them. The game never reads one. Maps and mods ship them so their own
 * authors get guided data entry, which is why the format matters here — a mod's wizards are part of
 * the mod, and until now opening one showed bytes.
 *
 * The format is documented by Blizzard, inside the game: `mods/core.sc2mod/base.sc2data/editordata/
 * wizardhelp/fileformat.rtf`. This codec is written against that document, not against a wiki. The
 * game ships the documentation and zero wizards; author-written wizards are checked by
 * `test/wizard-corpus.test.ts`, and their legacy forms are compatibility diagnostics, not grammar. MK2's `data-wizard.ts` took
 * the other route and modelled `DataWizard`/`Step`/`Field`, four elements the format does not have;
 * on a real file it returned an empty result and its writer would have emptied the file. None of it
 * is ported here.
 *
 * What the codec will not do without help is evaluate. Wizard text is a small language whose second
 * stage looks values up in loaded catalog data (`ref=Unit,Marine,ScoreKill`), and a codec reading
 * its own bytes has no catalog. `blizzard/sc2-wizard.evaluate` therefore refuses such a string
 * rather than guessing at it, and the same applies to the catalog-aware checks: they run when a
 * host passes a schema and stay silent when it does not.
 */
import {
  createInspectionCodec,
  createRelationGraphSource,
  createSubjectFactsSource,
  createTableDataSource,
  createTreeDataSource,
  editPlanFromInput,
  encodeXmlAttribute,
  encodeXmlText,
  fact,
  replaceBytes,
  subjectIdFor,
} from '@modkit/codec-kit'
import { operationId } from '@modkit/core'
import { analyzeWizardDocument } from './core/analyze.js'
import { locateWizardEditTarget } from './core/edit.js'
import { evaluateWizardText } from './core/evaluate.js'
import { looksLikeWizardFile, parseWizardDocument } from './core/parse.js'
import { outlineWizardDocument } from './core/outline.js'
import type { Wizard, WizardDiagnostic } from './core/types.js'
import type { WizardOutline } from './core/outline.js'

const ID = 'blizzard/sc2-wizard'
const OUTLINE_OPERATION = operationId('blizzard/sc2-wizard.outline', { contributionId: ID })
const EVALUATE_OPERATION = operationId('blizzard/sc2-wizard.evaluate', { contributionId: ID })
const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()
const COMPATIBILITY_PARSE_OPTIONS = Object.freeze({
  caseInsensitiveRoot: true,
  allowStandaloneWizard: true,
})

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
    id: OUTLINE_OPERATION,
    handlerId: 'outline',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: EVALUATE_OPERATION,
    handlerId: 'evaluate',
    mutatesSource: false,
    requiredPermissions: Object.freeze(['read-source']),
    outputKinds: Object.freeze(['json']),
  }),
  Object.freeze({
    id: operationId('edit.field', { contributionId: ID }),
    handlerId: 'edit-field',
    mutatesSource: true,
    requiredPermissions: Object.freeze(['read-source', 'write-source']),
    outputKinds: Object.freeze(['edit-plan']),
  }),
])

function basename(uri: string): string {
  const normalized = String(uri).replaceAll('\\', '/').replace(/\/$/u, '')
  const last = normalized.slice(normalized.lastIndexOf('/') + 1)
  return last === '' ? normalized : last
}

const TABLE_COLUMNS = Object.freeze([
  'wizard',
  'input',
  'type',
  'label',
  'page',
  'column',
  'writes data',
])

function inputRows(outlines: readonly WizardOutline[]): string[][] {
  return outlines.flatMap(outline =>
    outline.inputs.map(input => [
      outline.id,
      input.id,
      input.type,
      input.label,
      String(input.page),
      String(input.column),
      input.saves ? 'yes' : 'no',
    ]),
  )
}

function wizardTree(outline: WizardOutline) {
  const inputs = {
    kind: 'sc2-wizard-inputs',
    label: 'Inputs',
    preview: `${outline.inputs.length}`,
    semanticPath: [outline.id, 'inputs'],
    children: outline.inputs.map(input => ({
      kind: 'sc2-wizard-input',
      label: input.label,
      preview: `${input.id} : ${input.type}`,
      semanticPath: [outline.id, 'inputs', input.id],
    })),
  }
  const entries = {
    kind: 'sc2-wizard-entries',
    label: 'Creates',
    preview: `${outline.entries.length}`,
    semanticPath: [outline.id, 'entries'],
    children: outline.entries.map((entry, index) => ({
      kind: 'sc2-wizard-entry',
      label: `${entry.catalog} ${entry.type}`,
      preview: entry.id?.value ?? entry.id?.expression ?? (entry.useloaded ? 'loaded entry' : ''),
      semanticPath: [outline.id, 'entries', String(index)],
      children: entry.fields.map(field => ({
        kind: 'sc2-wizard-field',
        label: field.id,
        preview: field.value?.value ?? field.value?.expression ?? '',
        semanticPath: [outline.id, 'entries', String(index), field.id],
      })),
    })),
  }
  const macros = {
    kind: 'sc2-wizard-macros',
    label: 'Macros',
    preview: `${outline.macros.length}`,
    semanticPath: [outline.id, 'macros'],
    children: outline.macros.map(macro => ({
      kind: 'sc2-wizard-macro',
      label: macro,
      semanticPath: [outline.id, 'macros', macro],
    })),
  }
  const validations = {
    kind: 'sc2-wizard-validations',
    label: 'Validations',
    preview: `${outline.validations.length}`,
    semanticPath: [outline.id, 'validations'],
    children: outline.validations.map((validate, index) => ({
      kind: 'sc2-wizard-validation',
      label: validate.type,
      preview: validate.text ?? '',
      semanticPath: [outline.id, 'validations', String(index)],
    })),
  }
  return {
    kind: 'sc2-wizard',
    label: outline.name,
    preview: outline.category === undefined ? outline.id : `${outline.category} / ${outline.id}`,
    semanticPath: [outline.id],
    children: [inputs, entries, macros, validations].filter(
      group => group.children.length > 0,
    ),
  }
}

function diagnosticDescriptors(diagnostics: readonly WizardDiagnostic[]) {
  return diagnostics.map((item, ordinal) =>
    Object.freeze({
      id: `sc2-wizard.${ordinal}.${item.code}`,
      category: 'structure' as const,
      code: `blizzard.sc2-wizard/${item.code.replace(/^sc2-wizard-/u, '')}`,
      message: item.message,
      severity:
        item.severity === 'error'
          ? ('error' as const)
          : item.severity === 'warning'
            ? ('warning' as const)
            : ('information' as const),
      data: Object.freeze({
        line: item.start.line + 1,
        character: item.start.character + 1,
        ...(item.wizardId === undefined ? {} : { wizard: item.wizardId }),
      }),
    }),
  )
}

/** The graph a single file can honestly draw: what it declares, and what those declarations name. */
function graphOf(wizards: readonly Wizard[], outlines: readonly WizardOutline[]) {
  const nodes = [
    ...outlines.map(outline => ({
      id: subjectIdFor(ID, ['wizard', outline.id]),
      label: outline.name,
      type: 'Wizard',
      kind: 'sc2-wizard',
    })),
    ...outlines.flatMap(outline =>
      outline.inputs.map(input => ({
        id: subjectIdFor(ID, ['wizard', outline.id, 'input', input.id]),
        label: input.label,
        type: 'Input',
        kind: 'sc2-wizard-input',
      })),
    ),
    ...wizards.flatMap(wizard =>
      wizard.macros.map(macro => ({
        id: subjectIdFor(ID, ['wizard', wizard.id, 'macro', macro.id]),
        label: macro.id,
        type: 'Macro',
        kind: 'sc2-wizard-macro',
      })),
    ),
  ].filter(node => node.label !== '')

  const edges = new Map<string, { from: string; to: string; role: string }>()
  const add = (from: string, to: string, role: string) => {
    edges.set(`${from} ${to} ${role}`, { from, to, role })
  }
  for (const outline of outlines) {
    const wizardNode = subjectIdFor(ID, ['wizard', outline.id])
    for (const input of outline.inputs) {
      add(wizardNode, subjectIdFor(ID, ['wizard', outline.id, 'input', input.id]), 'asks')
      if (input.embedded !== undefined) {
        add(wizardNode, subjectIdFor(ID, ['wizard', input.embedded]), 'embeds')
      }
    }
    for (const macro of outline.macros) {
      add(wizardNode, subjectIdFor(ID, ['wizard', outline.id, 'macro', macro]), 'computes')
    }
  }
  return { nodes, edges: [...edges.values()] }
}

const definition = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'sc2-wizard', label: 'StarCraft II Data Wizard' }),
  operations,

  async detect(prefix: Uint8Array, uri: string) {
    const text = decoder.decode(prefix)
    if (looksLikeWizardFile(text, { caseInsensitiveRoot: true })) {
      return { confidence: 0.99, kind: 'structure' as const, note: 'sc2-wizard-root-element' }
    }
    if (/\.blizwiz$/iu.test(uri) && looksLikeWizardFile(text, COMPATIBILITY_PARSE_OPTIONS)) {
      return {
        confidence: 0.85,
        kind: 'structure' as const,
        note: 'sc2-wizard-compatibility-root-element',
      }
    }
    /*
     * The extension on its own is weak evidence and deliberately not enough. A wizard file lives
     * anywhere inside a map or mod, among a great deal of other XML, and claiming a `.BlizWiz`
     * that does not start with `<wizardfile>` would take a truncated or misnamed file away from a
     * codec that could actually read it.
     */
    if (/\.blizwiz$/iu.test(uri)) {
      return { confidence: 0.4, kind: 'context' as const, note: 'sc2-wizard-path-evidence' }
    }
    return { confidence: 0, kind: 'structure' as const, note: 'sc2-wizard-root-missing' }
  },

  async inspect(bytes: Uint8Array, context: any) {
    const text = decoder.decode(bytes)
    if (!looksLikeWizardFile(text, COMPATIBILITY_PARSE_OPTIONS)) {
      throw new TypeError('source is not a StarCraft II data wizard')
    }

    const document = parseWizardDocument(text, COMPATIBILITY_PARSE_OPTIONS)
    const analysis = analyzeWizardDocument(document, {
      maxDiagnostics: context.budget.maxDiagnostics,
      compatibilityMode: 'editor-compatible',
    })
    const outlines = outlineWizardDocument(document, { wizards: analysis.wizards })
    const source = context.primary.source
    const name = basename(source.uri)
    const graph = graphOf(document.file.wizards, outlines)
    const entryCount = outlines.reduce((total, outline) => total + outline.entries.length, 0)
    const inputCount = outlines.reduce((total, outline) => total + outline.inputs.length, 0)

    const summary = Object.freeze({
      format: 'sc2-wizard',
      wizards: outlines.length,
      inputs: inputCount,
      entries: entryCount,
      hidden: outlines.filter(outline => outline.hidden).length,
      diagnostics: analysis.diagnostics.length,
      /*
       * Said here because the language provider runs the same analyzer with the schema and reports
       * more: the two counts differ by exactly the catalog, entry-type, field and object-type rules.
       */
      catalogChecks: 'not-run' as const,
    })

    return {
      summary,
      metadata: [
        Object.freeze({
          id: 'wizard-file',
          label: 'SC2 data wizard file',
          entries: Object.freeze([
            { key: 'wizards', value: outlines.length },
            { key: 'inputs', value: inputCount },
            { key: 'entries', value: entryCount },
            {
              key: 'categories',
              value: [
                ...new Set(
                  outlines
                    .map(outline => outline.category)
                    .filter((value): value is string => value !== undefined),
                ),
              ].join(', '),
            },
          ]),
        }),
      ],
      traits: [
        Object.freeze({ id: 'content.text', parameters: { language: 'xml', encoding: 'utf-8' } }),
        Object.freeze({ id: 'structure.hierarchy', parameters: { kind: 'wizard-file' } }),
        Object.freeze({
          id: 'content.metadata',
          parameters: { format: 'sc2-wizard', wizards: outlines.length },
        }),
      ],
      text,
      dataSources: {
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'sc2-wizard-file',
          label: name,
          preview: `${outlines.length} wizards, ${entryCount} generated entries`,
          children: outlines.map(outline => wizardTree(outline)),
        }),
        'common.view/table-data-source': createTableDataSource({
          header: TABLE_COLUMNS,
          rows: inputRows(outlines),
        }),
        'common.view/relation-graph-source': createRelationGraphSource({
          snapshotId: String(context.input.revisions.revision),
          nodes: graph.nodes,
          edges: graph.edges,
          /*
           * Partial, and not by omission: a wizard embedded from another file, and every catalog
           * entry type it writes, live outside these bytes. The graph draws what the file declares
           * and stops there.
           */
          completeness: 'partial' as const,
          reason: 'embedded wizards and catalog entries live outside this file',
        }),
        'common.view/subject-facts-source': createSubjectFactsSource({
          snapshotId: String(context.input.revisions.revision),
          subjectId: source.id,
          label: name,
          kind: 'sc2-wizard-file',
          type: 'StarCraft II data wizard',
          source,
          groups: [
            {
              id: 'declares',
              label: 'Declares',
              facts: [
                fact(source, 'wizards', 'Wizards', outlines.length),
                fact(source, 'inputs', 'Input controls', inputCount),
                fact(source, 'macros', 'Macros', outlines.reduce((total, outline) => total + outline.macros.length, 0)),
              ],
            },
            {
              id: 'generates',
              label: 'Generates',
              facts: [
                fact(source, 'entries', 'Catalog entries', entryCount),
                fact(
                  source,
                  'fields',
                  'Catalog fields written',
                  new Set(outlines.flatMap(outline => outline.touchedFields)).size,
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
      diagnostics: diagnosticDescriptors(analysis.diagnostics),
      /*
       * The catalog dependency is per string, not per document: `^TestMath1^` evaluates from these
       * bytes and `ref=Unit,Marine,ScoreKill` cannot. Marking the whole operation
       * dependency-required would be the tidier-looking claim and would make it uninvocable — the
       * host refuses a call to an operation in that state — so the refusal lives where the
       * dependency actually is, in the one call that hits a reference.
       */
      unsupportedFeatures: Object.freeze([
        'source.save is owned by the host',
        'structural editing: edit.field replaces one existing value and never adds or removes elements',
        'evaluation of ref= catalog references, which needs loaded StarCraft II data',
        'catalog, entry-type, field-path and object-type checks, which need the StarCraft II schema; the sc2-wizard language provider runs them',
      ]),
      handlers: {
        validate: async () => ({ kind: 'json' as const, value: analysis.diagnostics }),
        'export-raw': async () => ({ kind: 'bytes' as const, value: bytes.slice() }),
        'edit-field': async (input: unknown) => {
          const request = (input ?? {}) as Record<string, unknown>
          const path = Array.isArray(request['path']) ? request['path'].map(String) : []
          const value = request['value']
          if (typeof value !== 'string') throw new TypeError('edit.field needs a string value')
          const target = locateWizardEditTarget(document, path)
          const escaped =
            target.encoding.kind === 'attribute'
              ? encodeXmlAttribute(value, target.encoding.quote)
              : encodeXmlText(value)
          /*
           * Offsets are source characters of the decoded text, and the decoder drops a UTF-8 byte
           * order mark; counting it back in keeps the edit on the value in a file that has one.
           */
          const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
          const offset = bom + encoder.encode(text.slice(0, target.start)).byteLength
          const length = encoder.encode(text.slice(target.start, target.end)).byteLength
          return {
            kind: 'edit-plan' as const,
            plan: editPlanFromInput(context.input, {
              planId: `${ID}:${context.input.revisions.revision}:${target.label}`,
              edits: [replaceBytes(offset, length, encoder.encode(escaped), `set ${target.label}`)],
              fidelity: { roundTrip: 'byte-identical', preservesUnknownData: true },
            }),
          }
        },
        outline: async (input: unknown) => {
          const request = (input ?? {}) as Record<string, unknown>
          const wanted = typeof request['wizardId'] === 'string' ? request['wizardId'] : undefined
          const chosen =
            wanted === undefined ? outlines : outlines.filter(outline => outline.id === wanted)
          if (wanted !== undefined && chosen.length === 0) {
            throw new TypeError(`no wizard ${wanted} in this file`)
          }
          return { kind: 'json' as const, value: chosen }
        },
        evaluate: async (input: unknown) => {
          const request = (input ?? {}) as Record<string, unknown>
          const wizardId = String(request['wizardId'] ?? '')
          const wizard = analysis.wizards.get(wizardId)
          if (wizard === undefined) throw new TypeError(`no wizard ${wizardId} in this file`)
          if (typeof request['text'] !== 'string') {
            throw new TypeError('evaluate needs the text to evaluate')
          }
          const values = request['inputs']
          const inputs =
            values !== null && typeof values === 'object' && !Array.isArray(values)
              ? new Map(Object.entries(values as Record<string, unknown>).map(([key, item]) => [key, String(item)]))
              : new Map<string, string>()
          const evaluation = evaluateWizardText(request['text'], {
            wizard,
            wizards: analysis.wizards,
            inputs,
            ...(typeof request['loadId'] === 'string' ? { loadId: request['loadId'] } : {}),
          })
          const reference = evaluation.unresolved.find(item => item.kind === 'reference')
          if (reference !== undefined) {
            throw new TypeError(
              `${reference.name} needs loaded StarCraft II catalog data, which this session does not have`,
            )
          }
          return { kind: 'json' as const, value: evaluation }
        },
      },
    }
  },
})

export const abiVersion = 1
export const allOperations = operations
export const createCodec = (context?: unknown) =>
  createInspectionCodec(definition as never, context as never)
