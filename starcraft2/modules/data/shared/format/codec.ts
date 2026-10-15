/**
 * The compatibility `sc2-data` format facade.
 *
 * Detection reuses this codec's GameData language scanner and
 * `@modkitx/data-processing/sc2-catalog`'s class knowledge, loading delegates to `@modkitx/xml` + `TypedCatalog`,
 * and the operation handlers below delegate to the same free domain functions used by the native
 * MK3 codec. The class remains for direct format consumers and oracle tests; production routing
 * does not create its operation session.
 */

import type { Issue } from './language/diagnostics.js'
import { collectAllRefs, type RefMatch } from './language/references.js'
import {
  readSourceHeader,
  collectDiagnosticsById,
  createArtifactOperationSession,
  type ArtifactContext,
  type ArtifactOperationSession,
  type ArtifactOperationSessionOptions,
  type AssetDescriptor,
  type AssetDiagnostic,
  type AssetOperationDescriptor,
  type AssetOutput,
  type AssetSource,
  type AssetSourceKind,
  type DetectionResult,
  type GameArtifactCodec,
  type GameArtifactKind,
} from '@modkit/codec-kit/legacy/assets'
import { ModkitError } from '@modkit/codec-kit/legacy/core'
import { DATA_OPERATION_IDS } from '../catalog-engine/operations.js'
import {
  SC2_DATA_OPERATIONS,
  describeSc2Data,
  sc2DataHandlerId,
  type Sc2DataArtifactDocument,
} from './describe.js'
import { detectSc2DataBytes, SC2_DATA_MAX_SNIFF_BYTES } from './detect.js'
import {
  catalogFileFromBytes,
  loadCatalogDocument,
  UnsupportedDataSourceError,
  type LoadedCatalogFile,
} from './document.js'
import {
  exportSc2DataCatalog,
  findSc2DataReferences,
  querySc2Data,
  resolveSc2DataInheritance,
  validateSc2Data,
  type CatalogEntitySummary,
  type CatalogQuery,
  type ResolvedEntity,
} from './queries.js'
import { SC2_DATA_CODEC_ID, SC2_GAME_ID } from './identity.js'
import {
  createSc2DataEntityRenameEditTransaction,
  parseSc2DataEntityRenameInput,
  type Sc2DataEntityRenameEditPlan,
  type Sc2DataEntityRenameEditTransaction,
  type Sc2DataEntityRenameInput,
} from './edit.js'
import { parseSc2DataExportInput, type Sc2DataExportInput } from './export.js'

export {
  exportSc2DataCatalog,
  findSc2DataReferences,
  querySc2Data,
  resolveSc2DataInheritance,
  validateSc2Data,
  type CatalogEntitySummary,
  type CatalogQuery,
  type ResolvedEntity,
} from './queries.js'

/**
 * Source kinds a GameData document can be presented as. Verbatim from the canonical `sc2-data`
 * manifest's `sourceKinds`, plus `file` for a loose `.xml` on disk.
 *
 * `directory`/`installation-root` are absent on purpose: a directory is a mod, and `sc2-mod` owns
 * it. This codec always describes one already-resolved catalog document.
 */
export const SC2_DATA_SOURCE_KINDS: readonly AssetSourceKind[] = [
  'file',
  'archive-entry',
  'vfs-root',
]

/** Compatibility source-handle wrapper around the canonical bounded-bytes detector. */
export async function detectSc2Data(
  source: AssetSource,
  context: ArtifactContext = {},
): Promise<DetectionResult> {
  const header = await readSourceHeader(source, SC2_DATA_MAX_SNIFF_BYTES, context.cancellation)
  return detectSc2DataBytes(header, source.descriptor, context) as DetectionResult
}

/** Read and parse one compatibility `AssetSource` into a {@link LoadedCatalogFile}. */
export async function readCatalogFile(source: AssetSource): Promise<LoadedCatalogFile> {
  let bytes: Uint8Array
  try {
    bytes = await source.read()
  } catch (error) {
    throw new UnsupportedDataSourceError(
      `Could not read '${source.descriptor.path}' as a GameData document: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  return catalogFileFromBytes(source.descriptor, bytes)
}

export interface Sc2DataCodecInit {
  /** Game build/version when the host knows it. Reported on the descriptor's context. */
  readonly build?: string
}

export class Sc2DataCodec implements GameArtifactCodec<Sc2DataArtifactDocument> {
  readonly id = SC2_DATA_CODEC_ID
  readonly kind: GameArtifactKind = 'data'
  readonly supportedGames: readonly string[] = [SC2_GAME_ID]
  readonly sourceKinds: readonly AssetSourceKind[] = SC2_DATA_SOURCE_KINDS
  readonly operations: readonly AssetOperationDescriptor[] = SC2_DATA_OPERATIONS

  private readonly build?: string

  constructor(init: Sc2DataCodecInit = {}) {
    if (init.build !== undefined) this.build = init.build
  }

  detect(source: AssetSource, context: ArtifactContext = {}): Promise<DetectionResult> {
    return detectSc2Data(source, context)
  }

  /**
   * Open one already-resolved GameData source.
   *
   * Detection runs first and is retained on the document so `describe()` reports real evidence
   * and confidence instead of a hardcoded 1.0. A low-confidence detection does not block the
   * open: choosing a route is the registry's (or the user's, through Open With) job.
   *
   * A mod's whole GameData chain comes from the one mod loader; a host that holds its files in
   * load order opens them with {@link openCatalogFiles}.
   */
  async open(
    source: AssetSource,
    context: ArtifactContext = {},
  ): Promise<Sc2DataArtifactDocument> {
    const detection = await this.detect(source, context)
    const file = await readCatalogFile(source)
    return loadCatalogDocument({
      files: [file],
      source: source.descriptor,
      detection,
      context: this.withBuild(context),
    })
  }

  /**
   * Open a pre-resolved set of catalog files as one document, in dependency-chain load order.
   *
   * The seam for hosts that already hold ordered sources (a mod context's layers). The primary
   * source stays the document's identity; the rest are context.
   */
  async openCatalogFiles(
    sources: readonly AssetSource[],
    context: ArtifactContext = {},
    identitySource: AssetSource | undefined = sources[0],
  ): Promise<Sc2DataArtifactDocument> {
    const primary = sources[0]
    if (!primary) {
      throw new ModkitError({
        code: 'ARTIFACT_SOURCE_REQUIRED',
        message: 'Opening a catalog file set requires at least one artifact source.',
        context: { codecId: this.id, operation: 'openCatalogFiles' },
      })
    }
    const identity = identitySource ?? primary
    const detection = await this.detect(identity, context)
    const files: LoadedCatalogFile[] = []
    for (const source of sources) files.push(await readCatalogFile(source))
    return loadCatalogDocument({
      files,
      source: identity.descriptor,
      detection,
      context: this.withBuild(context),
    })
  }

  async describe(
    document: Sc2DataArtifactDocument,
    context: ArtifactContext = {},
  ): Promise<AssetDescriptor> {
    return describeSc2Data(document, context)
  }

  createSession(
    document: Sc2DataArtifactDocument,
    context: ArtifactContext,
    descriptor: AssetDescriptor,
    options: ArtifactOperationSessionOptions = {},
  ): ArtifactOperationSession {
    return createArtifactOperationSession({
      codecId: this.id,
      document,
      context,
      descriptor,
      ...options,
      handlers: {
        [sc2DataHandlerId(DATA_OPERATION_IDS.inspect)]: ({ descriptor: current }) =>
          current.metadata,
        [sc2DataHandlerId(DATA_OPERATION_IDS.query)]: ({ input }) =>
          this.query(document, (input ?? {}) as CatalogQuery),
        [sc2DataHandlerId(DATA_OPERATION_IDS.resolveInheritance)]: ({ input }) => {
          const request = input as unknown as { namespace: string; id: string }
          return this.resolveInheritance(document, request.namespace, request.id)
        },
        [sc2DataHandlerId(DATA_OPERATION_IDS.references)]: ({ input }) => {
          const request = input as unknown as {
            namespace: string
            id: string
            includeDeclaration?: boolean
          }
          return this.references(
            document,
            request.namespace,
            request.id,
            request.includeDeclaration,
          )
        },
        [sc2DataHandlerId(DATA_OPERATION_IDS.diagnostics)]: () => this.validate(document),
        [sc2DataHandlerId(DATA_OPERATION_IDS.edit)]: ({ input }) =>
          this.createEntityRenameEditTransaction(document, parseSc2DataEntityRenameInput(input))
            .plans[0] as Sc2DataEntityRenameEditPlan,
        [sc2DataHandlerId(DATA_OPERATION_IDS.export)]: ({ input }) =>
          this.exportCatalog(document, parseSc2DataExportInput(input)),
      },
    })
  }

  private withBuild(context: ArtifactContext): ArtifactContext {
    return this.build === undefined ? context : { ...context, build: this.build }
  }

  // --- registered operation handlers ------------------------------------------------------
  // Each maps 1:1 onto an operation ID declared in `describe()`; a host resolves them through
  // `operationHandlerId()` and never reaches for a concrete parser.

  /** `asset.search` — browse/query, delegated to `TypedCatalog`'s own store. */
  query(document: Sc2DataArtifactDocument, query: CatalogQuery = {}): readonly CatalogEntitySummary[] {
    return querySc2Data(document, query)
  }

  /**
   * `sc2-data.resolve-inheritance` — `TypedCatalog.getResolved` plus an honest `partial` flag.
   *
   * `buildChain` stops silently at a dangling parent, so the chain is re-walked here to report
   * whether the merge was complete rather than letting a caller assume it was.
   */
  resolveInheritance(
    document: Sc2DataArtifactDocument,
    namespace: string,
    id: string,
  ): ResolvedEntity | undefined {
    return resolveSc2DataInheritance(document, namespace, id)
  }

  /**
   * `sc2-data.references` — positional references delegated to the codec's language core.
   *
   * Scoped to the loaded document set: the same limitation the descriptor's
   * `sc2-data.context.single-source` diagnostic declares.
   */
  references(
    document: Sc2DataArtifactDocument,
    namespace: string,
    id: string,
    includeDeclaration = true,
  ): readonly RefMatch[] {
    return findSc2DataReferences(document, namespace, id, includeDeclaration)
  }

  /** Every definition/parent/link reference in the loaded set, unfiltered. */
  allReferences(document: Sc2DataArtifactDocument): readonly RefMatch[] {
    const matches: RefMatch[] = []
    for (const file of document.files) matches.push(...collectAllRefs(file.text))
    return matches
  }

  /**
   * `asset.validate` — schema and reference validation, delegated to `collectIssues`.
   *
   * `catalogHas` is backed by the loaded store, so reference existence is checked against
   * whatever chain the caller supplied and no further.
   */
  validate(document: Sc2DataArtifactDocument): readonly Issue[] {
    return validateSc2Data(document)
  }

  /**
   * `edit.content` — the schema-driven catalog entity rename, as a validated
   * `AssetEditTransaction` (Phase D item 3, consolidated from `@modkitx/ops`'s `renameEntities`).
   *
   * Named to match `sc2-mod`'s `createAddLocaleEditTransaction` and
   * `sc2-document-metadata`'s `createSc2DocumentMetadataEditTransaction` conventions.
   */
  createEntityRenameEditTransaction(
    document: Sc2DataArtifactDocument,
    input: Sc2DataEntityRenameInput,
  ): Sc2DataEntityRenameEditTransaction {
    return createSc2DataEntityRenameEditTransaction(document, input)
  }

  /** `export.convert` — catalog JSON or per-namespace GameData XML, as `AssetOutput`s. */
  exportCatalog(document: Sc2DataArtifactDocument, input: Sc2DataExportInput = {}): readonly AssetOutput[] {
    return exportSc2DataCatalog(document, input)
  }

  /** Diagnostics referenced by one operation of a descriptor, resolved for display. */
  static operationDiagnostics(
    descriptor: AssetDescriptor,
    operation: AssetOperationDescriptor,
  ): readonly AssetDiagnostic[] {
    return collectDiagnosticsById(descriptor.diagnostics, operation.diagnosticIds)
  }
}

/** Convenience factory mirroring the other `<domain>-processing` packages' style. */
export function createSc2DataCodec(init: Sc2DataCodecInit = {}): Sc2DataCodec {
  return new Sc2DataCodec(init)
}
