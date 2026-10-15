/**
 * Warcraft III resolved data (`common.data/resolved-workspace@1`): the host plans the documents of
 * every workspace root (`tables.ts` names them), reads them, and this provider turns them into
 * entity patches for the one resolver. The facets over the resolved snapshots are codec-kit's
 * `createSnapshotDataWorkspace`. The plan includes map/skin/campaign binary changes and their
 * map/campaign WTS scopes; v3 opaque headers beyond empty/single-zero compatibility are
 * diagnosed instead of inventing semantics or partially applying their document.
 * AbilityBuffData/AbilityBuffMetaData supply a distinct buff namespace; shared profiles route by
 * declarations, and ambiguous ability/buff IDs are diagnosed rather than guessed.
 * Optional UnitEditorData supplies qualified unitRace/moveType enum IDs in the existing schema type;
 * field values remain authored strings. Numeric annotations qualify only the supplied projection's
 * scalar metadata/value domain; they do not prove complete native context or enable numeric edits.
 * Labels/localization, units, defaults and editor bounds are not inferred.
 * Expanded schema JSON is bounded by the caller's text-byte allowance before resolver cloning;
 * the shared JSON snapshot owner supplies byte/node checks and cancellation.
 */
import type { Lease } from '@modkit/sdk'
import type {
  DataWorkspaceDocumentRequirement,
  DataWorkspacePlan,
  DataWorkspacePlanRequest,
  ResolvedDataWorkspace,
  ResolvedDataWorkspaceAnalysisRequest,
  ResolvedDataWorkspaceSnapshot,
} from '@modkit/sdk/data'
import { RESOLVED_DATA_WORKSPACE_CONTRACT, resolveDataCatalog, revisionId } from '@modkit/sdk'
import { createSnapshotDataWorkspace } from '@modkit/codec-kit'
import { sha256Hex } from '@modkit/codec-kit/crypto/digest'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import { decodeInput } from '@modkit/codec-kit/text'
import { WAR3_DATA_DOCUMENTS, WAR3_DATA_STRING_DOCUMENTS, WAR3_OBJECT_MOD_DOCUMENTS, war3DataPatches } from './tables.js'

export const WAR3_DATA_ANALYZER = 'blizzard.warcraft3.data'
export const WAR3_GAME_ID = 'blizzard/warcraft-3'

const lease = <T>(value: T): Lease<T> => ({ value, release: async () => undefined })

export async function planWar3DataWorkspace(request: DataWorkspacePlanRequest): Promise<DataWorkspacePlan> {
  request.signal?.throwIfAborted()
  // A requirement path lies under its root's logical path.
  const under = (root: { readonly sourcePath: string }, path: string) => (root.sourcePath === '' ? path : `${root.sourcePath}/${path}`)
  const requirements: DataWorkspaceDocumentRequirement[] = request.workspace.loadOrder.flatMap(root => [
    ...[...WAR3_DATA_DOCUMENTS, ...WAR3_DATA_STRING_DOCUMENTS].map(path => ({
      requirementId: `catalog:${root.rootId}:${path}`,
      rootId: root.rootId,
      path: under(root, path),
      kind: 'catalog' as const,
      required: false,
    })),
    // A map's object-editor changes: binary, decoded by the object-mods reading.
    ...WAR3_OBJECT_MOD_DOCUMENTS.map(path => ({
      requirementId: `object-mods:${root.rootId}:${path}`,
      rootId: root.rootId,
      path: under(root, path),
      kind: 'catalog' as const,
      required: false,
      encoding: 'binary' as const,
    })),
  ])
  const complete = requirements.length <= request.maxRequirements
  return {
    schemaVersion: 1,
    workspaceId: request.workspace.workspaceId,
    gameId: request.workspace.gameId,
    analyzerId: WAR3_DATA_ANALYZER,
    requirements: requirements.slice(0, request.maxRequirements),
    diagnostics: complete
      ? []
      : [{ severity: 'error', code: 'blizzard.warcraft3/data-plan-truncated', message: `the plan needs ${String(requirements.length)} reads but maxRequirements is ${String(request.maxRequirements)}` }],
    complete,
  }
}

export async function analyzeWar3ResolvedData(request: ResolvedDataWorkspaceAnalysisRequest): Promise<ResolvedDataWorkspaceSnapshot> {
  request.signal?.throwIfAborted()
  // Host already bounds actual reads. Direct provider callers must not certify an oversized input;
  // bound the actually parsed text even if optional binary bytes disagree, reusing the text owner's
  // UTF-8 bytes rather than a second encoder/counting algorithm. Plan counts and
  // unresolved external documents are NOT evidence of complete native game/map coverage.
  const suppliedDomainWithinBudget = request.documents.length <= request.maxDocuments &&
    request.documents.reduce((used, document) => used + Math.max(document.bytes?.byteLength ?? 0, decodeInput({ text: document.text }).bytes.byteLength), 0) <= request.maxTextBytes
  const { patches, schemas, diagnostics } = war3DataPatches(request.documents, suppliedDomainWithinBudget)
  if (patches.length > request.maxEntities * 8)
    throw new RangeError(`the object tables hold ${String(patches.length)} rows, past the entity budget`)
  // Flat fields with enum members have a fixed structural depth, unrelated to inheritance depth.
  const boundedSchemas = schemas.some(schema => schema.fields.some(field => field.type?.kind === 'enum')) ? snapshotJson(schemas, {
    maxDepth: 8, maxNodes: request.maxTextBytes, maxBytes: request.maxTextBytes,
  }, request.signal) as unknown as typeof schemas : schemas
  const identity = JSON.stringify([
    request.workspaceId,
    request.documents.map(document => [document.rootId, document.path, document.revision ?? '', document.bytes?.byteLength ?? document.text.length]),
    request.unresolvedRequirementIds,
  ])
  const snapshotId = `provider-token:war3-data-${(await sha256Hex(new TextEncoder().encode(identity))).slice(0, 32)}`
  const adapter = { id: WAR3_DATA_ANALYZER, version: '1.0.0' }
  const subjectRevision = revisionId(snapshotId)
  const facets = ['common.view/tree-data-source', 'common.view/table-data-source', 'common.view/relation-graph-source'] as const
  return resolveDataCatalog({
    workspaceId: request.workspaceId,
    gameId: request.gameId,
    analyzerId: WAR3_DATA_ANALYZER,
    schemas: boundedSchemas,
    patches,
    queries: request.queries,
    localizationPatches: [],
    localePreferences: [],
    localizationKeys: [],
    diagnostics,
    snapshotId,
    projectionPlan: { adapter, subjectRevision, facets: facets.map(contract => ({ ref: { contract, major: 1 }, state: 'published' as const })) },
    projectionReceipt: {
      form: 'local',
      adapter,
      subjectRevision,
      companions: [],
      basis: { handedness: 'right', upAxis: 'z', forwardAxis: '+y', unit: 'source-unit', sourceUnit: 'warcraft3-table-value' },
      planes: [
        { planeId: 'effective-definitions', state: request.documents.length === 0 ? 'lost' : 'normalized', note: `${String(request.documents.length)} object table, profile and object-editor document(s); ${String(request.unresolvedRequirementIds.length)} planned document(s) absent` },
        { planeId: 'localization', state: 'normalized', note: 'profiles retain the installed language; binary string changes resolve TRIGSTR through map/campaign WTS in their root scope; unresolved keys remain authored and are diagnosed' },
        { planeId: 'relations', state: 'normalized', note: 'list fields the metadata types as units, items, abilities, buffs or upgrades are relation edges; requirements (techList, units and upgrades in one list) and per-level ability columns (their kind differs by ability, metadata useSpecific) are not: a schema field links to one namespace' },
      ],
      evidence: [{ kind: 'observed', statement: `${String(request.documents.length)} revision-pinned Warcraft III object-data document(s) parsed` }],
      confidence: 'partial',
    },
    includeWorkspaceFacets: true,
    includeFieldSources: true,
    maxEntities: request.maxEntities,
    maxDepth: request.maxDepth,
  }) as ResolvedDataWorkspaceSnapshot
}

export const abiVersion = 1
export const provides = [RESOLVED_DATA_WORKSPACE_CONTRACT] as const
export function createProvider(selection: { readonly contract: string }): Lease<ResolvedDataWorkspace> {
  if (selection.contract !== RESOLVED_DATA_WORKSPACE_CONTRACT)
    throw new TypeError(`the Warcraft III data provider does not implement ${selection.contract}`)
  return lease(
    createSnapshotDataWorkspace({
      providerId: WAR3_DATA_ANALYZER,
      gameIds: [WAR3_GAME_ID],
      label: 'Warcraft III data',
      plan: planWar3DataWorkspace,
      analyze: analyzeWar3ResolvedData,
      relations: { completeness: 'partial', reason: 'requirements (techList) mix units and upgrades and per-level ability columns change kind by ability; a schema field links to one namespace' },
    }),
  )
}
