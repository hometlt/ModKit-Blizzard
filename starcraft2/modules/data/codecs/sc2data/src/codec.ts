import { createCatalogRelationGraphSource } from './relation-graph.js'
import { entityCard, entitySubjects, modOfCatalog } from './entity-cards.js'
import { entitySubjectId } from './entity-facts.js'
import { resolvedEntityViewXml } from './resolved-view.js'
import { writeEntityField } from '../../../services/editing/entity-field-write.js'
import { Filter } from '../../../shared/format/filter.js'
import { extractSubtree } from '../../../shared/format/extract.js'
import { entityDeclarationSpans } from '../../../shared/format/declarations.js'
import { buildCatalogRelations } from '../../../shared/format/relations.js'
import {
  createSubjectFactsSource,
  createTableDataSource,
  createTreeDataSource,
  createInspectionCodec,
  editPlanFromInput,
  fact,
  replaceBytes,
} from '@modkit/codec-kit'
import { diagnostic, errorCode, operationId, type Diagnostic } from '@modkit/core'
import type {
  InspectionContext,
  InspectionOperationState,
  InspectionResult,
} from '@modkit/codec-kit'
import { isJsonSerializable } from '@modkit/codec-kit'
import type {
  AssetDiagnostic,
  Codec,
  ContributionContext,
  JsonValue,
  OperationDecl,
  OperationOutput,
  SubjectCatalogPort,
  SubjectFactProvenance,
} from '@modkit/sdk'
import {
  exportSc2DataCatalog,
  findSc2DataReferences,
  type CatalogQuery,
  querySc2Data,
  resolveSc2DataInheritance,
  validateSc2Data,
} from '../../../shared/format/queries.js'
import {
  catalogFileFromBytes,
  loadCatalogDocument,
  type Sc2DataDocument,
} from '../../../shared/format/document.js'
import { detectSc2DataBytes } from '../../../shared/format/detect.js'
import {
  SC2_DATA_OPERATION_ORDER,
  sc2DataFindings,
  sc2DataMetadata,
  sc2DataOperationState,
  sc2DataTraits,
  sc2DataUnsupportedFeatures,
} from '../../../shared/format/summary.js'
import {
  createSc2DataEntityRenameEditPlan,
  parseSc2DataEntityRenameInput,
} from '../../../shared/format/edit.js'
import { parseSc2DataExportInput } from '../../../shared/format/export.js'
import { byteDocumentSourceDescriptor } from '../../../../../shared/inspection/byte-source.js'

/** The file's own name, which is what a card should be titled rather than a full URI. */
function sourceLabel(uri: string): string {
  const normalized = String(uri).replaceAll('\\', '/').replace(/\/$/u, '')
  const last = normalized.slice(normalized.lastIndexOf('/') + 1)
  return last === '' ? normalized : last
}

const ID = 'blizzard/sc2-data'
const OPERATION_OWNER = { contributionId: ID } as const

/**
 * Versioned MK2 operation → executable MK3 handler mapping.
 *
 * The two disabled legacy operations remain declared so per-document operation state can explain
 * their absence. Provisioning is a Node service operation and deliberately stays outside this
 * portable byte codec.
 */
export const SC2_DATA_OPERATION_MAP = Object.freeze({
  'view.inspect': { id: 'view.inspect', handlerId: 'inspect', outputKinds: ['json'] },
  'asset.search': { id: 'asset.search', handlerId: 'search', outputKinds: ['json'] },
  'sc2-data.resolve-inheritance': {
    id: 'blizzard/sc2-data.resolve-inheritance',
    handlerId: 'resolve-inheritance',
    outputKinds: ['json'],
  },
  'sc2-data.references': {
    id: 'blizzard/sc2-data.references',
    handlerId: 'references',
    outputKinds: ['json'],
  },
  'asset.validate': { id: 'asset.validate', handlerId: 'validate', outputKinds: ['json'] },
  'asset.compare': { id: 'asset.compare', handlerId: 'compare', outputKinds: ['json'] },
  'edit.content': { id: 'edit.content', handlerId: 'rename-entity', outputKinds: ['edit-plan'] },
  'export.convert': {
    id: 'export.convert',
    handlerId: 'export-catalog',
    outputKinds: ['bytes', 'json'],
  },
  'sc2-data.entity-cards': {
    id: 'blizzard/sc2-data.entity-cards',
    handlerId: 'entity-cards',
    outputKinds: ['json'],
  },
  /*
   * The entity as the game sees it: own fields and inherited ones in one declaration.
   *
   * A modder reads a catalog to answer "what is this unit actually", and the file only ever shows
   * the difference from its parent. MK2 opened this beside the source as a read-only document; the
   * codec renders it, and any surface that can show text can show it.
   */
  'sc2-data.resolved-view': {
    id: 'blizzard/sc2-data.resolved-view',
    handlerId: 'resolved-view',
    outputKinds: ['json'],
  },
} as const)

/*
 * `edit.field` is what the tree, the table and the properties panel invoke for one value. It is not
 * a second writer: it resolves the entity and hands the change to the ported raw-preserving field
 * patcher, so a surface edit and a scripted one rewrite the same bytes the same way.
 */
/*
 * `asset.filter` and `asset.extract` expose two ported catalog transforms that had no way in.
 * Both are read-only projections, so they answer with JSON rather than an edit plan: a caller that
 * wants the subset written out asks `export.convert` with what these return.
 */
export const SC2_DATA_FILTER = Object.freeze({
  id: operationId('blizzard/sc2-data.filter', { contributionId: ID }),
  handlerId: 'filter-entities',
  mutatesSource: false,
  requiredPermissions: Object.freeze(['read-source']),
  outputKinds: Object.freeze(['json']),
})

export const SC2_DATA_EXTRACT = Object.freeze({
  id: operationId('blizzard/sc2-data.extract', { contributionId: ID }),
  handlerId: 'extract-subtree',
  mutatesSource: false,
  requiredPermissions: Object.freeze(['read-source']),
  outputKinds: Object.freeze(['json']),
})

export const SC2_DATA_FIELD_EDIT = Object.freeze({
  id: operationId('edit.field', { contributionId: ID }),
  handlerId: 'edit-field',
  mutatesSource: true,
  requiredPermissions: Object.freeze(['read-source', 'write-source']),
  outputKinds: Object.freeze(['edit-plan']),
})
export const SC2_DATA_OPERATION_MAP_VERSION = 1

type LegacyOperationId = keyof typeof SC2_DATA_OPERATION_MAP

/** The catalog's entity table, on the kit's shared table source. */
function tableDataSource(header: readonly string[], values: readonly (readonly unknown[])[]) {
  return createTableDataSource({ header, rows: values.map(row => row.map(String)) })
}

function mappingFor(legacyId: string) {
  const mapping = SC2_DATA_OPERATION_MAP[legacyId as LegacyOperationId]
  if (mapping === undefined) throw new TypeError(`Unmapped sc2-data operation ${legacyId}`)
  return mapping
}

function nativeOperationId(legacyId: string) {
  return operationId(mappingFor(legacyId).id, OPERATION_OWNER)
}

export const operations: readonly OperationDecl[] = Object.freeze(
  Object.entries(SC2_DATA_OPERATION_MAP).map(([legacyId, mapping]): OperationDecl => {
    const mutatesSource = legacyId === 'edit.content'
    return {
      id: operationId(mapping.id, OPERATION_OWNER),
      handlerId: mapping.handlerId,
      mutatesSource,
      requiredPermissions: mutatesSource ? ['read-source', 'write-source'] : ['read-source'],
      outputKinds: mapping.outputKinds,
    }
  }),
)

/** The mapped legacy operations plus the native field write the surfaces invoke. */
export const allOperations: readonly OperationDecl[] = Object.freeze([
  ...operations,
  SC2_DATA_FIELD_EDIT as unknown as OperationDecl,
  SC2_DATA_FILTER as unknown as OperationDecl,
  SC2_DATA_EXTRACT as unknown as OperationDecl,
])

function json(value: unknown): OperationOutput {
  const normalized = value === undefined ? null : value
  if (!isJsonSerializable(normalized)) {
    throw new TypeError('sc2-data operation produced a non-JSON result')
  }
  return { kind: 'json', value: normalized as JsonValue }
}

function exportOutput(value: unknown): OperationOutput {
  if (!Array.isArray(value)) throw new TypeError('sc2-data export did not return outputs')
  const outputs = value.map(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError('sc2-data export returned a malformed output')
    }
    const candidate = item as {
      readonly path?: unknown
      readonly data?: unknown
      readonly mediaType?: unknown
      readonly role?: unknown
    }
    if (typeof candidate.path !== 'string' || !(candidate.data instanceof Uint8Array)) {
      throw new TypeError('sc2-data export output requires a path and bytes')
    }
    return {
      path: candidate.path,
      bytes: [...candidate.data],
      ...(typeof candidate.mediaType === 'string' ? { mediaType: candidate.mediaType } : {}),
      ...(typeof candidate.role === 'string' ? { role: candidate.role } : {}),
    }
  })
  if (outputs.length === 1) return { kind: 'bytes', value: Uint8Array.from(outputs[0]!.bytes) }
  return json({ encoding: 'uint8-array', outputs })
}

function operationStates(document: Sc2DataDocument): readonly InspectionOperationState[] {
  return SC2_DATA_OPERATION_ORDER.map(legacyId => {
    const id = nativeOperationId(legacyId)
    /*
     * Entity cards were `disabled` in MK2 with the reason "absorbed into sc2-data in Phase D".
     * That is now done — the assembler runs here against this session's catalog — so the state the
     * legacy table carries is stale, and forwarding it would refuse an operation that works.
     */
    if (legacyId === 'sc2-data.entity-cards') return { id, state: 'available' as const }
    const current = sc2DataOperationState(document, legacyId)
    if (current.state === 'available') return { id, state: 'available' as const }
    return {
      id,
      state: current.state,
      reason: current.reason?.message ?? 'SC2 GameData operation unavailable',
    }
  })
}

const FINDING_CATEGORIES = { 'partial-support': 'fidelity', 'missing-companion': 'dependency', malformed: 'syntax' } as const

function nativeDiagnostics(document: Sc2DataDocument): AssetDiagnostic[] {
  return sc2DataFindings(document).map(finding => ({
    id: finding.id,
    code: errorCode<string>(`blizzard/${finding.code.replace('.', '-')}`),
    severity: finding.severity === 'info' ? 'information' : finding.severity,
    message: finding.message,
    category: FINDING_CATEGORIES[finding.category],
    source: { contributionId: ID },
    ...(finding.detail === undefined ? {} : { data: finding.detail as JsonValue }),
  }))
}

const DATA_RENAME_DIAGNOSTIC_CODES = Object.freeze({
  'sc2-data.edit.entity-rename.unknown-entity': 'blizzard/sc2-data-rename-unknown-entity',
  'sc2-data.edit.entity-rename.id-collision': 'blizzard/sc2-data-rename-id-collision',
  'sc2-data.edit.entity-rename.multi-file-entity': 'blizzard/sc2-data-rename-multi-file-entity',
  'sc2-data.edit.entity-rename.reserialized': 'blizzard/sc2-data-rename-reserialized',
  'sc2-data.edit.entity-rename.chain-incomplete': 'blizzard/sc2-data-rename-chain-incomplete',
  'sc2-data.edit.entity-rename.no-op': 'blizzard/sc2-data-rename-no-op',
} as const)

function nativeRenameDiagnostic(value: {
  readonly id: string
  readonly code?: string
  readonly severity: 'error' | 'warning' | 'info'
  readonly message: string
  readonly category?: string
  readonly source?: string
  readonly path?: string
  readonly detail?: unknown
}): Diagnostic {
  const legacyCode = value.code ?? value.id
  const code = DATA_RENAME_DIAGNOSTIC_CODES[
    legacyCode as keyof typeof DATA_RENAME_DIAGNOSTIC_CODES
  ] ?? 'blizzard/sc2-data-rename-diagnostic'
  return diagnostic(
    value.severity === 'info' ? 'information' : value.severity,
    code,
    value.message,
    undefined,
    {
      legacyId: value.id,
      legacyCode,
      ...(value.category === undefined ? {} : { category: value.category }),
      ...(value.source === undefined ? {} : { source: value.source }),
      ...(value.path === undefined ? {} : { sourcePath: value.path }),
      ...(value.detail === undefined ? {} : { detail: value.detail }),
    },
  )
}

/**
 * A fact this document supplies opens the entity's declaration in it: its provenance (this source,
 * `[namespace, id, …]`) gains the span of the entity's opening tag, scanned once on first use.
 */
function declarationsIn(sourceId: string, text: string) {
  let spans: ReturnType<typeof entityDeclarationSpans> | undefined
  return (provenance: SubjectFactProvenance): SubjectFactProvenance => {
    const id = provenance.semanticPath?.[1]
    if (provenance.source?.id !== sourceId || id === undefined || provenance.range !== undefined) return provenance
    const range = (spans ??= entityDeclarationSpans(text)).get(id)
    return range === undefined ? provenance : { ...provenance, range }
  }
}

async function project(
  document: Sc2DataDocument,
  context: InspectionContext,
  catalog?: SubjectCatalogPort,
): Promise<InspectionResult> {
  const entities = querySc2Data(document)
  const handlers: Record<string, (input: JsonValue) => Promise<OperationOutput>> = {
    inspect: async () => json(sc2DataMetadata(document)),
    search: async input => json(querySc2Data(document, (input ?? {}) as CatalogQuery)),
    'resolve-inheritance': async input => {
      const request = input as unknown as { readonly namespace: string; readonly id: string }
      return json(resolveSc2DataInheritance(document, request.namespace, request.id))
    },
    'resolved-view': async input => {
      const request = input as unknown as { readonly namespace: string; readonly id: string }
      const resolved = resolveSc2DataInheritance(document, request.namespace, request.id)
      if (resolved === undefined) {
        throw new TypeError(`no ${request.namespace} «${request.id}» in this catalog`)
      }
      const entity = document.catalog.get(request.namespace, request.id)
      return json({
        namespace: resolved.namespace,
        id: resolved.id,
        chain: resolved.chain,
        partial: resolved.partial,
        mediaType: 'application/xml',
        text: resolvedEntityViewXml(entity?.class ?? request.namespace, resolved, entity?.parent),
      })
    },
    references: async input => {
      const request = input as unknown as {
        readonly namespace: string
        readonly id: string
        readonly includeDeclaration?: boolean
      }
      return json(
        findSc2DataReferences(
          document,
          request.namespace,
          request.id,
          request.includeDeclaration,
        ),
      )
    },
    validate: async () => json(validateSc2Data(document)),
    'export-catalog': async input =>
      exportOutput(exportSc2DataCatalog(document, parseSc2DataExportInput(input))),
  }

  handlers['rename-entity'] = async input => {
    const legacyPlan = createSc2DataEntityRenameEditPlan(
      document,
      parseSc2DataEntityRenameInput(input),
    )
    const diagnostics = legacyPlan.diagnostics.map(nativeRenameDiagnostic)
    const edits = legacyPlan.edits.map(edit => {
      if (
        edit.sourceId !== document.source.id ||
        edit.operation !== 'replace' ||
        edit.range === undefined
      ) {
        throw new TypeError(
          'SC2 Data entity rename requires a range replacement on the selected source',
        )
      }
      return replaceBytes(
        edit.range.offset,
        edit.range.length,
        edit.bytes ?? new TextEncoder().encode(edit.text),
        edit.label,
      )
    })
    const blocked = diagnostics.some(item => item.severity === 'error')
    if (edits.length === 0 && !blocked) {
      const size = await context.byteSource.size()
      if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError('SC2 Data source is too large for an inline no-op edit')
      }
      const sourceBytes = await context.byteSource.read(0n, Number(size), context.signal)
      edits.push(replaceBytes(
        0,
        sourceBytes.byteLength,
        sourceBytes,
        'SC2 Data entity rename no-op',
      ))
    }
    return {
      kind: 'edit-plan',
      plan: editPlanFromInput(context.input, {
        planId: `${ID}:${context.input.revisions.revision}:entity-rename`,
        edits,
        fidelity: {
          roundTrip: 'semantic',
          preservesUnknownData: false,
          notes: ['Catalog rename normalizes GameData XML formatting and comments.'],
        },
        diagnostics,
      }),
    }
  }

  /*
   * Entity cards, from the ported wiki assembler.
   *
   * The operation was declared and skipped, which is worse than absent: a caller saw it in the
   * table and got a refusal. It is answered by this native handler because
   * MK2 built cards from a loaded mod and this codec has a catalog — see `entity-cards.ts` for what
   * that costs and what it does not.
   */
  handlers['entity-cards'] = async input => {
    const request = (input ?? {}) as Record<string, JsonValue>
    const namespace = typeof request['namespace'] === 'string' ? request['namespace'] : undefined
    const entityId = typeof request['entityId'] === 'string' ? request['entityId'] : undefined
    if (namespace === undefined || entityId === undefined) {
      throw new TypeError('entity-cards requires namespace and entityId')
    }
    const locale = typeof request['locale'] === 'string' ? request['locale'] : undefined
    return json(
      entityCard(document.catalog as never, namespace, entityId, {
        ...(locale === undefined ? {} : { locale }),
      }) as unknown as JsonValue,
    )
  }

  /**
   * Apply one field write through the ported patcher.
   *
   * The path is `[namespace, entityId, ...field]` — the same shape the tree publishes — and the
   * class comes from the catalog rather than the request: a caller edits a value, not an entity's
   * type, and accepting a class here would let a stray field rewrite what the entity is.
   */
  handlers['edit-field'] = async input => {
    const request =
      input !== null && typeof input === 'object' && !Array.isArray(input)
        ? (input as Readonly<Record<string, JsonValue>>)
        : {}
    const path = Array.isArray(request['path']) ? request['path'].map(String) : []
    const [namespace, entityId, ...field] = path
    if (namespace === undefined || entityId === undefined || field.length === 0) {
      throw new TypeError('a catalog field write needs [namespace, entityId, ...field]')
    }
    const entity = document.catalog.get(namespace, entityId)
    if (entity === undefined) throw new TypeError(`no entity ${namespace}/${entityId}`)
    /*
     * One file at a time. A multi-file catalog has one source descriptor per file, and an edit plan
     * that replaced the primary source would write the change into the wrong document — silently,
     * because the bytes would still parse. Refusing is the only honest answer until the plan can
     * address a binding by id.
     */
    if (document.files.length !== 1) {
      throw new TypeError(
        'field edits need a single-file catalog: this document holds ' +
          `${document.files.length} files and the plan cannot yet address one of them`,
      )
    }
    const file = document.files[0]!
    const patched = writeEntityField(file.text, entity.class, entityId, field, request['value'])
    return {
      kind: 'edit-plan',
      plan: editPlanFromInput(context.input, {
        planId: `${ID}:${context.input.revisions.revision}:field:${namespace}/${entityId}`,
        edits: [
          replaceBytes(
            0,
            new TextEncoder().encode(file.text).byteLength,
            new TextEncoder().encode(patched),
            'raw-preserving catalog field patch',
          ),
        ],
        fidelity: {
          roundTrip: 'byte-identical',
          preservesUnknownData: true,
          notes: [
            'Only the targeted attribute or element is rewritten; the rest of the file is untouched.',
          ],
        },
      }),
    }
  }

  const entitySummary = (entity: {
    namespace: string
    id: string
    class: string
    parent?: string
  }) => ({
    namespace: entity.namespace,
    id: entity.id,
    class: entity.class,
    ...(entity.parent === undefined ? {} : { parent: entity.parent }),
  })

  /**
   * `blizzard/sc2-data.filter` — the ported predicate helpers, reachable at last.
   *
   * `nonDefault` is worth naming: every SC2 namespace carries an implicit entity with an empty id
   * that everything else inherits from, and a caller listing "the units in this mod" almost never
   * means that one.
   */
  handlers['filter-entities'] = async input => {
    const request =
      input !== null && typeof input === 'object' && !Array.isArray(input)
        ? (input as Readonly<Record<string, JsonValue>>)
        : {}
    const namespace = typeof request['namespace'] === 'string' ? request['namespace'] : undefined
    if (namespace === undefined) throw new TypeError('filter needs a namespace')
    const mode = request['mode'] === 'all' ? 'all' : 'non-default'
    const entities =
      mode === 'all'
        ? Filter.byNamespace(document.catalog, namespace)
        : Filter.nonDefault(document.catalog, namespace)
    const needle = typeof request['id'] === 'string' ? request['id'].toLowerCase() : undefined
    const matched =
      needle === undefined
        ? entities
        : entities.filter(entity => entity.id.toLowerCase().includes(needle))
    return json({ namespace, mode, total: matched.length, entities: matched.map(entitySummary) })
  }

  /**
   * `blizzard/sc2-data.extract` — the minimal dependency subtree for a set of seeds.
   *
   * It walks the same relation graph the codec publishes, so what a reader sees in the graph view
   * and what an extraction pulls out cannot disagree.
   */
  handlers['extract-subtree'] = async input => {
    const request =
      input !== null && typeof input === 'object' && !Array.isArray(input)
        ? (input as Readonly<Record<string, JsonValue>>)
        : {}
    const rawSeeds = Array.isArray(request['seeds']) ? request['seeds'] : []
    const seeds = rawSeeds.flatMap(seed => {
      if (seed === null || typeof seed !== 'object' || Array.isArray(seed)) return []
      const record = seed as Record<string, JsonValue>
      if (typeof record['namespace'] !== 'string' || typeof record['id'] !== 'string') return []
      const entity = document.catalog.get(record['namespace'], record['id'])
      return entity === undefined ? [] : [entity]
    })
    if (seeds.length === 0) throw new TypeError('extract needs at least one seed that exists')
    const graph = buildCatalogRelations(document.catalog)
    const exclude = Array.isArray(request['excludeNamespaces'])
      ? request['excludeNamespaces'].map(String)
      : undefined
    const found = extractSubtree(document.catalog, graph, seeds, {
      ...(request['includeIncoming'] === true ? { includeIncoming: true } : {}),
      ...(exclude === undefined ? {} : { excludeNamespaces: exclude }),
    })
    return json({
      seeds: seeds.map(entitySummary),
      total: found.length,
      entities: found.map(entitySummary),
    })
  }

  return {
    summary: {
      format: 'sc2-data',
      files: document.files.length,
      entities: document.stats.entityCount,
      namespaces: [...document.stats.namespaces],
      unresolvedParents: document.stats.unresolvedParents.length,
    },
    metadata: sc2DataMetadata(document).map(group => ({
      id: group.id,
      label: group.label,
      entries: group.entries.map(entry => ({ key: entry.id, value: entry.value as JsonValue })),
    })),
    traits: [
      ...sc2DataTraits(document).map(trait => ({
        id: trait.id,
        parameters: trait.parameters as JsonValue,
      })),
      /*
       * GameData is XML, and saying so is what lets an editor colour it without core keeping a
       * table of every format an extension will ever add. The legacy descriptor does not carry
       * this trait, so it is added here rather than left for a host to guess from the extension.
       */
      { id: 'content.text', parameters: { language: 'xml', encoding: 'utf-8' } },
    ],
    text: document.files.length === 1 ? document.files[0]!.text : true,
    dataSources: {
      'common.view/table-data-source': tableDataSource(
        ['Namespace', 'Class', 'Id', 'Parent', 'Source'],
        entities.map(entity => [
          entity.namespace,
          entity.class,
          entity.id,
          entity.parent ?? '',
          entity.sources[0]?.file ?? '',
        ]),
      ),
      /*
       * The relation graph, from the ported walker rather than a second traversal. It is marked
       * partial whenever the codec did not resolve the whole dependency chain, because "no
       * references" and "cannot see the references" must not look alike to a reader.
       */
      'common.view/relation-graph-source': createCatalogRelationGraphSource(document.catalog, {
        snapshotId: String(context.input.revisions.revision),
        complete: document.stats.unresolvedParents.length === 0,
        ...(document.stats.unresolvedParents.length === 0
          ? {}
          : { reason: 'the dependency chain is not fully resolved in this session' }),
      }),
      /*
       * The card. A catalog's identity is what it holds — how many entities, in which namespaces,
       * out of how many files — and whether the codec could resolve the inheritance chain, because
       * an unresolved parent is the difference between a value a reader can trust and one that is
       * merely present. Every fact names the path it came from, so the card can lead back into the
       * tree rather than being a dead end.
       */
      /*
       * Each entity is a subject of its own, lent from this session: the card of the file lists
       * them, and opening one shows its own card (names, stats, weapons, links) in place.
       */
      'common.view/subject-selector-source': entitySubjects(
        modOfCatalog(document.catalog) as Parameters<typeof entitySubjects>[0],
        {
          snapshotId: String(context.input.revisions.revision),
          source: context.primary.source,
          editOperation: 'edit.field',
          // The mod context the host placed this document in: cards carry the whole chain (5.7).
          ...(catalog === undefined ? {} : { catalog }),
          // A fact of this document opens the entity's declaration in it (5.2).
          ...(document.files.length === 1 ? { declare: declarationsIn(context.primary.source.id, document.files[0]!.text) } : {}),
        },
      ),
      'common.view/subject-facts-source': createSubjectFactsSource({
        snapshotId: String(context.input.revisions.revision),
        subjectId: context.primary.source.id,
        label: sourceLabel(context.primary.source.uri),
        kind: 'sc2-data-catalog',
        type: 'StarCraft II GameData catalog',
        source: context.primary.source,
        groups: [
          {
            id: 'identity',
            label: 'Catalog',
            facts: [
              fact(context.primary.source, 'files', 'Files', document.files.length),
              fact(context.primary.source, 'entities', 'Entities', document.stats.entityCount),
              fact(
                context.primary.source,
                'namespaces',
                'Namespaces',
                document.stats.namespaces.length,
              ),
            ],
          },
          {
            id: 'namespaces',
            label: 'Entities by namespace',
            facts: document.stats.namespaces.map(namespace =>
              fact(
                context.primary.source,
                `namespace-${namespace}`,
                namespace,
                entities.filter(entity => entity.namespace === namespace).length,
                [namespace],
              ),
            ),
          },
          {
            id: 'integrity',
            label: 'Integrity',
            facts: [
              fact(
                context.primary.source,
                'unresolved-parents',
                'Unresolved parents',
                document.stats.unresolvedParents.length,
              ),
              ...(document.stats.unresolvedParents.length === 0
                ? []
                : [
                    fact(
                      context.primary.source,
                      'unresolved-parent-names',
                      'Missing parents',
                      document.stats.unresolvedParents
                        .slice(0, 20)
                        .map(item => `${item.namespace}/${item.id} → ${item.parent}`),
                    ),
                  ]),
            ],
          },
        ],
        relations: entities
          .filter(entity => entity.id !== '')
          .map(entity => ({
            role: entity.namespace,
            subjectId: entitySubjectId(entity.namespace, entity.id),
            label: entity.id,
            kind: entity.class,
          })),
      }),
      'common.view/tree-data-source': createTreeDataSource({
        kind: 'catalog',
        label: 'SC2 GameData Catalog',
        preview: `${entities.length} entities in ${document.stats.namespaces.length} namespaces`,
        children: document.stats.namespaces.map(namespace => ({
          kind: 'catalog-namespace',
          label: namespace,
          semanticPath: [namespace],
          children: entities
            .filter(entity => entity.namespace === namespace)
            .map(entity => ({
              kind: 'catalog-entity',
              label: entity.id || '(default)',
              preview: entity.class,
              semanticPath: [namespace, entity.id],
              /*
               * The entity node carries no editable value on purpose. Its id is entity metadata,
               * which the ported patcher refuses to touch — renaming an entity is `edit.content`,
               * a different operation with different semantics (every reference has to move with
               * it). Field values are edited where their path is known: the properties surface.
               */
            })),
        })),
      }),
    },
    /*
     * The native field write is as available as the source is writable; the legacy states cover the
     * mapped operations only, so it is appended rather than inferred from them.
     */
    operationStates: [
      ...operationStates(document),
      { id: SC2_DATA_FIELD_EDIT.id, state: 'available' as const },
      { id: SC2_DATA_FILTER.id, state: 'available' as const },
      { id: SC2_DATA_EXTRACT.id, state: 'available' as const },
    ],
    handlers,
    unsupportedFeatures: sc2DataUnsupportedFeatures(document),
    diagnostics: nativeDiagnostics(document),
  }
}

export const abiVersion = 1

export function createCodec(_context?: ContributionContext): Codec {
  return createInspectionCodec({
    id: ID,
    format: {
      id: 'sc2-data',
      label: 'StarCraft II GameData',
      mediaType: 'application/x-sc2-gamedata+xml',
    },
    operations: allOperations,
    async detect(prefix, uri) {
      const source = byteDocumentSourceDescriptor(prefix, { path: uri, id: uri })
      const detected = detectSc2DataBytes(prefix, source)
      return {
        confidence: detected.confidence,
        kind: 'structure' as const,
        note: JSON.stringify({
          evidence: detected.evidence,
          requiredRanges: detected.requiredRanges,
        }),
      }
    },
    async inspect(bytes, context) {
      context.signal?.throwIfAborted()
      const source = byteDocumentSourceDescriptor(bytes, {
        path: context.primary.source.uri,
        id: context.primary.source.id,
      })
      const document = loadCatalogDocument({
        files: [catalogFileFromBytes(source, bytes)],
        source,
        detection: detectSc2DataBytes(bytes, source),
      })
      context.signal?.throwIfAborted()
      return project(document, context, _context?.catalog)
    },
  }, _context)
}
