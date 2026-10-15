/** Native M5 Galaxy codec adapter over the exact-pin parser, checker and AST lowering. */
import {
  createInspectionCodec,
  createSubjectFactsSource,
  createTableDataSource,
  createTreeDataSource,
  editPlanFromInput,
  fact,
  replaceBytes,
} from '@modkit/codec-kit'
import { TypeChecker } from '../../language-core/checker.js'
import { bindSourceFile } from '../../language-core/binder.js'
import { Parser } from '../../language-core/parser.js'
import type {
  Diagnostic,
  ITypeCheckerHost,
  Node,
  SourceFile,
} from '../../language-core/types.js'
import { forEachChild } from '../../language-core/utils.js'
import {
  analyzeGalaxyLanguage,
  formatGalaxySource,
  galaxyCompletionsAt,
  galaxyDefinitionAt,
  galaxyHoverAt,
  galaxyReferencesAt,
  galaxyRenameRangeAt,
  galaxySignatureAt,
  galaxyWordAt,
} from '@modkit/blizzard-starcraft2/galaxy/analysis/language-service.js'
import { parseGalaxySource, printGalaxySource } from '@modkit/blizzard-starcraft2/galaxy/analysis/source.js'
import { inventoryParsedGalaxyNativeSignatures } from '@modkit/blizzard-starcraft2/galaxy/analysis/native-signatures.js'
import { galaxySourceToEngineProgram } from '@modkit/blizzard-starcraft2/galaxy/analysis/to-engine.js'
import { detectGalaxyBytes } from '../../services/source-detection.js'
import { convertGalaxyToTriggers } from '../../../triggers/services/galaxy-conversion/index.js'

const ID = 'blizzard/galaxy'
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

export const GALAXY_OPERATION_MAP = Object.freeze({
  'view.inspect': 'inspect',
  'script.symbols': 'symbols',
  'blizzard/galaxy.native-signatures': 'native-signatures',
  'script.references': 'references',
  'asset.validate': 'validate',
  'script.completion': 'completion',
  'script.format': 'format',
  'edit.structure': 'rename',
  'export.convert': 'export-convert',
  'blizzard/galaxy.to-engine': 'to-engine',
  'blizzard/galaxy.to-triggers': 'to-triggers',
  'export.raw': 'export-raw',
} as const)

const read = Object.freeze(['read-source'])
const write = Object.freeze(['read-source', 'write-source'])
const operation = (
  id: keyof typeof GALAXY_OPERATION_MAP,
  outputKinds: readonly string[],
  mutatesSource = false,
) => Object.freeze({
  id,
  handlerId: GALAXY_OPERATION_MAP[id],
  mutatesSource,
  requiredPermissions: mutatesSource ? write : read,
  outputKinds: Object.freeze(outputKinds),
})

export const operations = Object.freeze([
  operation('view.inspect', ['json']),
  operation('script.symbols', ['json']),
  operation('blizzard/galaxy.native-signatures', ['json']),
  operation('script.references', ['json']),
  operation('asset.validate', ['json']),
  operation('script.completion', ['json']),
  operation('script.format', ['bytes']),
  operation('edit.structure', ['edit-plan'], true),
  operation('export.convert', ['bytes']),
  operation('blizzard/galaxy.to-engine', ['json']),
  operation('blizzard/galaxy.to-triggers', ['json']),
  operation('export.raw', ['bytes']),
])

type Budget = Readonly<{
  maxInputBytes: bigint
  maxDepth: number
  maxNodes: number
  maxScalarBytes: number
  maxDiagnostics: number
}>

type LanguageIndex = ReturnType<typeof analyzeGalaxyLanguage>

function fileName(uri: string): string {
  const normalized = uri.replaceAll('\\', '/')
  const value = normalized.slice(normalized.lastIndexOf('/') + 1)
  return value === '' ? 'Lib.galaxy' : value
}

function textOf(bytes: Uint8Array, budget: Budget): string {
  if (BigInt(bytes.byteLength) > budget.maxInputBytes) {
    throw new RangeError('Galaxy source exceeds maxInputBytes budget')
  }
  if (bytes.byteLength > budget.maxScalarBytes) {
    throw new RangeError('Galaxy source exceeds maxScalarBytes budget')
  }
  if (bytes.includes(0)) throw new TypeError('Galaxy source contains a NUL byte')
  return decoder.decode(bytes)
}

function countAst(source: SourceFile, maxNodes: number): number {
  let count = 0
  const visit = (node: Node): undefined => {
    count += 1
    if (count > maxNodes) throw new RangeError('Galaxy AST exceeds maxNodes budget')
    forEachChild(node, visit)
    return undefined
  }
  visit(source)
  return count
}

function diagnosticValue(value: Diagnostic, index: number) {
  const start = value.start ?? 0
  return Object.freeze({
    id: `galaxy.type-check.${index}.${start}`,
    category: 'syntax' as const,
    code: 'blizzard.galaxy/type-check',
    message: String(value.messageText),
    severity:
      value.category === 2 ? 'warning' : value.category === 3 ? 'information' : value.category === 4 ? 'hint' : 'error',
    data: Object.freeze({
      start,
      end: start + (value.length ?? 1),
      ...(value.line === undefined ? {} : { line: value.line }),
      ...(value.col === undefined ? {} : { column: value.col }),
    }),
  })
}

function fullDiagnostics(source: SourceFile, maxDiagnostics: number) {
  const host: ITypeCheckerHost = {
    documents: new Map(),
    qualifiedDocuments: new Map(),
    resolveGlobalSymbol: () => undefined,
  }
  bindSourceFile(source, host)
  const checker = new TypeChecker(host)
  const values = checker.checkSourceFile(source, true) ?? []
  return Object.freeze(values.slice(0, maxDiagnostics).map(diagnosticValue))
}

function inspectSource(text: string, name: string, budget: Budget) {
  const parsed = new Parser().parseFile(name, text)
  const nodes = countAst(parsed, budget.maxNodes)
  const index = analyzeGalaxyLanguage(text, name)
  const diagnostics = Object.freeze([
    ...index.diagnostics.map((item, diagnosticIndex) => Object.freeze({
      id: `galaxy.language.${diagnosticIndex}.${item.start}`,
      category: 'syntax' as const,
      code: 'blizzard.galaxy/language',
      message: item.message,
      severity: item.severity === 'info' ? 'information' as const : item.severity,
      data: Object.freeze({ start: item.start, end: item.end }),
    })),
    ...fullDiagnostics(parsed, budget.maxDiagnostics),
  ].slice(0, budget.maxDiagnostics))
  return { parsed, index, diagnostics, nodes }
}

function requireOffset(input: unknown, text: string): number {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Galaxy language operation requires an input object')
  }
  const offset = (input as { offset?: unknown }).offset
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > text.length) {
    throw new RangeError('Galaxy language operation requires an in-range integer offset')
  }
  return offset as number
}

function symbolNode(symbol: LanguageIndex['symbols'][number]): any {
  return {
    kind: `galaxy-${symbol.kind}`,
    label: symbol.name,
    ...(symbol.detail === undefined ? {} : { preview: symbol.detail }),
    semanticPath: Object.freeze(['symbols', symbol.kind, symbol.name]),
    ...(symbol.children?.length
      ? { children: Object.freeze(symbol.children.map(symbolNode)) }
      : {}),
  }
}

function replaceIdentifier(text: string, offset: number, nextName: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(nextName)) {
    throw new TypeError('Galaxy rename requires a valid ASCII identifier')
  }
  const range = galaxyRenameRangeAt(text, offset)
  if (range === undefined) throw new TypeError('Galaxy rename offset is not an identifier')
  const references = galaxyReferencesAt(text, offset)
  let output = text
  for (const reference of [...references].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, reference.start)}${nextName}${output.slice(reference.end)}`
  }
  return { output, previousName: text.slice(range.start, range.end), references }
}

function fidelityOf(value: unknown) {
  let rawNodes = 0
  const seen = new Set<object>()
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || seen.has(item)) return
    seen.add(item)
    const record = item as Record<string, unknown>
    if (record['kind'] === 'EngineRawStatement' || record['kind'] === 'EngineRawExpression') rawNodes += 1
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit)
      else visit(child)
    }
  }
  visit(value)
  return Object.freeze({
    preserved: rawNodes === 0 ? 1 : 0,
    rewritten: 0,
    dropped: 0,
    unsupported: rawNodes,
    notes: Object.freeze(rawNodes === 0 ? [] : ['Unsupported Galaxy nodes are preserved as EngineRaw AST nodes.']),
  })
}

const definition: any = Object.freeze({
  id: ID,
  format: Object.freeze({
    id: 'galaxy',
    label: 'StarCraft II Galaxy Script',
    mediaType: 'text/x-galaxy',
  }),
  operations,
  async detect(prefix: Uint8Array, uri: string) {
    const result = detectGalaxyBytes(prefix, { uri })
    const evidence = result.evidence.find(item => item.kind === 'structure' && item.weight > 0)
      ?? result.evidence.at(-1)
    return {
      confidence: result.confidence,
      kind: evidence?.kind ?? 'structure',
      note: evidence?.note ?? 'no-galaxy-evidence',
    }
  },
  async inspect(bytes: Uint8Array, context: any) {
    const text = textOf(bytes, context.budget as Budget)
    const name = fileName(context.primary.source.uri)
    const analysis = inspectSource(text, name, context.budget as Budget)
    let nativeInventory: ReturnType<typeof inventoryParsedGalaxyNativeSignatures> | undefined
    const tree = createTreeDataSource({
      kind: 'galaxy-source',
      label: name,
      preview: `${analysis.index.symbols.length} symbols`,
      children: analysis.index.symbols.map(symbolNode),
    })
    return {
      summary: Object.freeze({
        format: 'galaxy',
        fileName: name,
        bytes: bytes.byteLength,
        nodes: analysis.nodes,
        symbols: analysis.index.symbols.length,
        diagnostics: analysis.diagnostics.length,
      }),
      metadata: [Object.freeze({
        id: 'script',
        label: 'Galaxy script',
        entries: Object.freeze([
          { key: 'fileName', value: name },
          { key: 'symbols', value: analysis.index.symbols.length },
          { key: 'diagnostics', value: analysis.diagnostics.length },
          { key: 'nodes', value: analysis.nodes },
        ]),
      })],
      traits: [
        Object.freeze({ id: 'content.text', parameters: { language: 'galaxy', encoding: 'utf-8' } }),
        Object.freeze({ id: 'code.source', parameters: { language: 'galaxy', authority: 'native' } }),
        Object.freeze({ id: 'structure.hierarchy', parameters: { kind: 'ast' } }),
      ],
      text,
      dataSources: {
        'common.view/tree-data-source': tree,
        /*
         * The declarations as a table. The tree shows nesting, which is what a reader wants inside
         * one function; a table answers the other question — what this file declares, sorted and
         * searchable — and carries the signature, which is the part a caller actually needs.
         */
        'common.view/table-data-source': createTableDataSource({
          header: ['Kind', 'Name', 'Signature', 'Parameters'],
          rows: analysis.index.symbols.map(symbol => [
            symbol.kind,
            symbol.name,
            symbol.detail ?? '',
            (symbol.parameters ?? []).map(item => `${item.type} ${item.name}`).join(', '),
          ]),
        }),
        /*
         * The card for a script: what it declares, broken down by symbol kind, and whether the
         * checker had anything to say about it. A count of diagnostics belongs on the card because
         * it is the one fact that decides whether the rest of it can be trusted.
         */
        'common.view/subject-facts-source': createSubjectFactsSource({
          snapshotId: String(context.input.revisions.revision),
          subjectId: context.primary.source.id,
          label: name,
          kind: 'galaxy-script',
          type: 'StarCraft II Galaxy script',
          source: context.primary.source,
          groups: [
            {
              id: 'identity',
              label: 'Script',
              facts: [
                fact(context.primary.source, 'bytes', 'Bytes', bytes.byteLength),
                fact(context.primary.source, 'nodes', 'Syntax nodes', analysis.nodes),
                fact(context.primary.source, 'symbols', 'Symbols', analysis.index.symbols.length),
              ],
            },
            {
              id: 'symbols',
              label: 'Symbols by kind',
              facts: [
                ...new Set(analysis.index.symbols.map(symbol => symbol.kind)),
              ]
                .sort()
                .map(kind =>
                  fact(
                    context.primary.source,
                    `symbol-kind-${kind}`,
                    kind,
                    analysis.index.symbols.filter(symbol => symbol.kind === kind).length,
                    ['symbols', kind],
                  ),
                ),
            },
            {
              id: 'integrity',
              label: 'Checker',
              facts: [
                fact(
                  context.primary.source,
                  'diagnostics',
                  'Diagnostics',
                  analysis.diagnostics.length,
                ),
              ],
            },
          ],
        }),
      },
      diagnostics: analysis.diagnostics,
      unsupportedFeatures: Object.freeze([
        'runtime execution is owned by the sc2-runtime codec',
        'cross-document Trigger metadata is supplied by the language provider contract',
      ]),
      handlers: {
        symbols: async () => ({ kind: 'json', value: analysis.index.symbols }),
        'native-signatures': async (input: unknown) => {
          const page = input && typeof input === 'object' && !Array.isArray(input)
            ? input as { offset?: unknown; limit?: unknown } : {}
          const offset = page.offset ?? 0
          const limit = page.limit ?? 100
          if (!Number.isSafeInteger(offset) || (offset as number) < 0 ||
              !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 256)
            throw new RangeError('Galaxy native-signatures requires offset >= 0 and limit 1..256')
          nativeInventory ??= inventoryParsedGalaxyNativeSignatures(analysis.parsed, text)
          const items = nativeInventory.signatures.slice(offset as number, (offset as number) + (limit as number))
          return { kind: 'json', value: {
            file: nativeInventory.file, total: nativeInventory.signatures.length,
            functionDeclarations: nativeInventory.functionDeclarations,
            items, ...((offset as number) + items.length < nativeInventory.signatures.length
              ? { nextOffset: (offset as number) + items.length } : {}),
          } }
        },
        references: async (input: unknown) => ({
          kind: 'json',
          value: galaxyReferencesAt(text, requireOffset(input, text)),
        }),
        validate: async () => ({ kind: 'json', value: analysis.diagnostics }),
        completion: async (input: unknown) => ({
          kind: 'json',
          value: galaxyCompletionsAt(text, requireOffset(input, text), name),
        }),
        format: async (input: any) => ({
          kind: 'bytes',
          value: encoder.encode(formatGalaxySource(text, {
            insertSpaces: input?.insertSpaces === true,
            tabSize: typeof input?.tabSize === 'number' ? input.tabSize : undefined,
            finalNewline: typeof input?.finalNewline === 'boolean' ? input.finalNewline : undefined,
          })),
        }),
        rename: async (input: any) => {
          const offset = requireOffset(input, text)
          if (typeof input?.newName !== 'string') throw new TypeError('Galaxy rename requires newName')
          const renamed = replaceIdentifier(text, offset, input.newName)
          const output = encoder.encode(renamed.output)
          return {
            kind: 'edit-plan',
            plan: editPlanFromInput(context.input, {
              planId: `${ID}:${context.input.revisions.revision}:rename:${renamed.previousName}:${input.newName}`,
              edits: [replaceBytes(0, bytes.byteLength, output, `rename ${renamed.previousName} to ${input.newName}`)],
              fidelity: {
                roundTrip: 'semantic',
                preservesUnknownData: true,
                notes: [`Renamed ${renamed.references.length} exact identifier occurrence(s); all other bytes are preserved.`],
              },
            }),
          }
        },
        'export-convert': async () => ({
          kind: 'bytes',
          value: encoder.encode(printGalaxySource(parseGalaxySource(text, name))),
        }),
        'to-triggers': async (input: any) => ({
          kind: 'json',
          value: await convertGalaxyToTriggers({ ...input, script: text, header: input?.header ?? '' }, undefined),
        }),
        'to-engine': async (input: any) => {
          const program = galaxySourceToEngineProgram(parseGalaxySource(text, name), {
            moduleId: typeof input?.moduleId === 'string' ? input.moduleId : name,
            moduleName: typeof input?.moduleName === 'string' ? input.moduleName : undefined,
            includeRawFallbacks: input?.includeRawFallbacks !== false,
          })
          return { kind: 'json', value: Object.freeze({ program, fidelity: fidelityOf(program) }) }
        },
        'export-raw': async () => ({ kind: 'bytes', value: bytes.slice() }),
        definition: async (input: unknown) => ({
          kind: 'json',
          value: galaxyDefinitionAt(text, requireOffset(input, text), name) ?? null,
        }),
        hover: async (input: unknown) => ({
          kind: 'json',
          value: galaxyHoverAt(text, requireOffset(input, text), name) ?? null,
        }),
        signature: async (input: unknown) => ({
          kind: 'json',
          value: galaxySignatureAt(text, requireOffset(input, text), name) ?? null,
        }),
        word: async (input: unknown) => ({
          kind: 'json',
          value: galaxyWordAt(text, requireOffset(input, text)) ?? null,
        }),
      },
    }
  },
})

export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
