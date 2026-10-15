/**
 * A loaded mod's server for sc2-data provider tests over crafted canonical data (owner decision
 * 07.10: the provider reads only its mod's server). A stand-in for the chain's Data session answers
 * from the entities a test names what the session would; the server's own answer code
 * (`languageAnswer`) shapes it into `data.language` answers, and the port completes each document
 * the answer names with the URI the snapshot uses, as the host's registry does.
 *
 * Crafted data says what no catalog document could (a value the open text does not have, an entity
 * whose declaration no snapshot document holds). A test about the real session over documents
 * builds it with `openStarcraft2DataSession` instead.
 */
import type { JsonValue } from '@modkit/sdk'
import type { DataEntitySource, ResolvedDataAuthoringIndex } from '@modkit/sdk/data'
import { languageAnswer } from '../../mod/shared/workspace/language-answer.js'
import type { DataEntityKey, DataEntitySummary, Starcraft2DataSession } from '../services/catalog/data-session.js'
import { fuzzyMatches } from '../../../shared/language/symbol-match.js'

/** Where a crafted entity is declared: a file of a layer, and optionally its place in the file. */
export interface CraftedSource {
  readonly rootId: string
  readonly path: string
  readonly range?: { readonly utf16Offset: number; readonly utf16Length: number; readonly line: number; readonly column: number }
}

/** One canonical entity: its class, parent, effective fields and where it is declared. */
export interface CraftedEntity {
  readonly namespace: string
  readonly typeId: string
  readonly entityId: string
  readonly parentEntityId?: string
  /** Effective values the entity itself sets (inherited ones come from its parent's row). */
  readonly fields?: Readonly<Record<string, unknown>>
  /** The entity a field's value comes from, when not this one. */
  readonly fieldOrigins?: Readonly<Record<string, string>>
  readonly defaultTemplate?: true
  readonly tokens?: readonly { readonly id: string; readonly type?: string; readonly value?: string }[]
  /** Without one the entity is declared in a file no layer holds. */
  readonly source?: CraftedSource
}

export interface CraftedModServerOptions {
  readonly entities: readonly CraftedEntity[]
  /** The session's own completeness (a document that does not parse, a missing parent). */
  readonly complete?: boolean
  /** What `data.strings` answers, in the chain's locale order. */
  readonly strings?: readonly Readonly<Record<string, JsonValue>>[]
  readonly metadata?: JsonValue
  /** The URI the snapshot gives a layer's file; `undefined` for one the host cannot name. */
  readonly uriOf?: (layerId: string, path: string) => string | undefined
  readonly scope?: string
  readonly revision?: string
  /** Catalog documents the session holds (a source's file), by layer and path. */
  readonly documents?: readonly { readonly rootId: string; readonly path: string; readonly text: string }[]
}

let serial = 0
const NUL = String.fromCharCode(0)
/** A file no layer of the crafted chain holds. */
const NOWHERE: CraftedSource = { rootId: 'nowhere', path: 'Base.SC2Data/GameData/Nowhere.xml' }

/** The crafted server: its port for the provider, the context naming it, and the questions asked. */
export function craftedModServer(options: CraftedModServerOptions) {
  serial += 1
  const scope = options.scope ?? `mod-context:crafted:${serial}`
  const revision = options.revision ?? `crafted-${serial}`
  const entities = options.entities
  const keyOf = (namespace: string, entityId: string) => `${namespace}${NUL}${entityId}`
  const byKey = new Map(entities.map(entity => [keyOf(entity.namespace, entity.entityId), entity]))
  // Every root a source names is a layer whose files sit under its own folder in the session.
  const roots = [...new Set([...entities.map(entity => (entity.source ?? NOWHERE).rootId), NOWHERE.rootId])]
  const layers = roots.map(rootId => ({ id: rootId, rootId, sourcePath: `layers/${rootId}` }))
  const sessionPathOf = (source: CraftedSource) => `layers/${source.rootId}/${source.path}`
  const sourceOf = (entity: CraftedEntity): DataEntitySource => {
    const source = entity.source ?? NOWHERE
    return {
      rootId: source.rootId,
      path: sessionPathOf(source),
      ...(source.range === undefined ? {} : { range: source.range }),
    } as unknown as DataEntitySource
  }
  const summaryOf = (entity: CraftedEntity): DataEntitySummary => ({
    namespace: entity.namespace,
    entityId: entity.entityId,
    typeId: entity.typeId,
    source: sourceOf(entity),
  })
  const inNamespace = (namespace: string) => entities.filter(entity => entity.namespace === namespace)
  const complete = options.complete ?? true

  const session = {
    revision: 1,
    documents: (options.documents ?? []).map(document => ({
      rootId: document.rootId,
      path: sessionPathOf(document),
      text: document.text,
    })),
    update() {
      throw new Error('a crafted session does not take documents')
    },
    complete: () => complete,
    authoring(refs: readonly DataEntityKey[], authoringOptions?: { readonly chains?: boolean }) {
      const wanted = new Map<string, CraftedEntity>()
      for (const ref of refs) {
        const entity = byKey.get(keyOf(ref.namespace, ref.entityId))
        if (entity === undefined) continue
        if (authoringOptions?.chains === true) {
          const seen = new Set<string>()
          for (let parent = entity.parentEntityId; parent !== undefined && !seen.has(parent); ) {
            seen.add(parent)
            const ancestor = byKey.get(keyOf(entity.namespace, parent))
            if (ancestor === undefined) break
            wanted.set(keyOf(ancestor.namespace, ancestor.entityId), ancestor)
            parent = ancestor.parentEntityId
          }
        }
        wanted.set(keyOf(entity.namespace, entity.entityId), entity)
      }
      const documents: { rootId: string; path: string; documentIndex: number }[] = []
      const documentIndexes = new Map<string, number>()
      const table: number[][] = []
      const tableIndexOf = (entity: CraftedEntity): number => {
        const source = entity.source ?? NOWHERE
        const path = sessionPathOf(source)
        let document = documentIndexes.get(`${source.rootId}${NUL}${path}`)
        if (document === undefined) {
          document = documents.push({ rootId: source.rootId, path, documentIndex: documents.length }) - 1
          documentIndexes.set(`${source.rootId}${NUL}${path}`, document)
        }
        const range = source.range ?? { utf16Offset: 0, utf16Length: 0, line: 0, column: 0 }
        return table.push([document, range.utf16Offset, range.utf16Length, range.line, range.column]) - 1
      }
      const rows = [...wanted.values()].map(entity => {
        const source = tableIndexOf(entity)
        return {
          identity: keyOf(entity.namespace, entity.entityId),
          namespace: entity.namespace,
          typeId: entity.typeId,
          entityId: entity.entityId,
          ...(entity.parentEntityId === undefined ? {} : { parentEntityId: entity.parentEntityId }),
          source,
          complete: true,
          fields: Object.entries(entity.fields ?? {}).map(([fieldId, value]) => ({
            fieldId,
            value,
            source,
            originEntityId: entity.fieldOrigins?.[fieldId] ?? entity.entityId,
          })),
          tombstones: [],
          ...(entity.defaultTemplate === true ? { defaultTemplate: true } : {}),
          ...(entity.tokens === undefined ? {} : { tokens: entity.tokens }),
        }
      })
      return {
        schemaVersion: 2,
        kind: 'resolved-data-authoring-index',
        workspaceId: 'crafted',
        gameId: 'blizzard/starcraft-2',
        analyzerId: 'crafted',
        snapshotId: `crafted@${revision}`,
        sourceDocuments: documents,
        sourceTable: table,
        namespaces: [...new Set(rows.map(row => row.namespace))].map(namespace => ({
          namespace,
          entityCount: rows.filter(row => row.namespace === namespace).length,
        })),
        entityCount: rows.length,
        patchCount: rows.length,
        entities: rows,
        ...(options.metadata === undefined ? {} : { ownerMetadata: options.metadata }),
        diagnostics: { errorCount: 0, warningCount: 0, informationCount: 0, items: [], truncated: false },
        complete,
        valuesComplete: true,
      } as unknown as ResolvedDataAuthoringIndex
    },
    ids: (namespace: string) => inNamespace(namespace).map(entity => entity.entityId),
    summaries: (namespace: string) => inNamespace(namespace).map(summaryOf),
    defaults: (namespace: string) =>
      inNamespace(namespace).filter(entity => entity.defaultTemplate === true).map(entity => entity.entityId),
    search(needle: string, limit: number) {
      const namespaces = [...new Set(entities.map(entity => entity.namespace))].sort((left, right) => left.localeCompare(right))
      return namespaces
        .flatMap(namespace => inNamespace(namespace).filter(entity => fuzzyMatches(entity.entityId, needle)))
        .slice(0, limit)
        .map(summaryOf)
    },
    exists: (refs: readonly DataEntityKey[]) =>
      refs.map(ref => {
        const entity = byKey.get(keyOf(ref.namespace, ref.entityId))
        return entity === undefined
          ? { known: false }
          : { known: true, ...(entity.defaultTemplate === true ? { defaultTemplate: true as const } : {}) }
      }),
    heirs: (refs: readonly DataEntityKey[]) =>
      refs.map(ref => inNamespace(ref.namespace).filter(entity => entity.parentEntityId === ref.entityId).length),
    metadata: () => options.metadata,
    catalog() {
      throw new Error('a crafted session has no catalog')
    },
    definitions() {
      throw new Error('a crafted session has no resolved definitions')
    },
    entityCount: () => entities.length,
  } as unknown as Starcraft2DataSession

  const questions: unknown[] = []
  const port = {
    async query(asked: string, question: unknown) {
      if (asked !== scope) throw new Error(`asked ${asked}, the crafted server is ${scope}`)
      questions.push(question)
      const answer = (await languageAnswer(question, {
        session,
        revision,
        layers,
        strings: async keys => (options.strings ?? []).filter(entry => keys.includes(String(entry['key']))),
      })) as { readonly documents: readonly { readonly layerId: string; readonly path: string }[] }
      return {
        ...answer,
        documents: answer.documents.map(document => {
          const uri = options.uriOf?.(document.layerId, document.path)
          return uri === undefined ? document : { ...document, uri }
        }),
      }
    },
  }
  return Object.freeze({
    port,
    questions,
    /** The context of a request that reads this server; `extra` adds origins, completeness and the like. */
    context(extra: Readonly<Record<string, unknown>> = {}) {
      return {
        id: `crafted-context-${serial}`,
        revision,
        semanticComplete: true,
        documentOrigins: [],
        semanticInputs: [],
        modContext: { scope, gameId: 'blizzard/starcraft-2', revision, complete: true },
        ...extra,
      }
    },
  })
}
