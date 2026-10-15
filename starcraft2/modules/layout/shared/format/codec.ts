import {
  createArtifactOperationSession,
  type ArtifactContext,
  type ArtifactOpenOptions,
  type ArtifactOperationSession,
  type ArtifactOperationSessionOptions,
  type AssetDescriptor,
  type AssetOperationDescriptor,
  type AssetSource,
  type AssetSourceKind,
  type DetectionResult,
  type GameArtifactCodec,
  type GameArtifactKind,
  readSourceHeader,
} from '@modkit/codec-kit/legacy/assets'
import { ModkitError } from '@modkit/codec-kit/legacy/core'
import { LAYOUT_OPERATION_IDS } from '../layout-engine/operations.js'
import {
  inspectSc2Layout,
  parseSc2Layout,
  rawSc2LayoutOutput,
  sc2LayoutDiagnosticHtmlOutput,
  type Sc2LayoutDocument,
} from './document.js'
import { detectSc2LayoutBytes, SC2_LAYOUT_MAX_SNIFF_BYTES } from './detect.js'
import {
  describeSc2Layout,
  SC2_LAYOUT_OPERATIONS,
  sc2LayoutHandlerId,
  type Sc2LayoutArtifactDocument,
} from './describe.js'
import { SC2_GAME_ID, SC2_LAYOUT_CODEC_ID } from './identity.js'
import {
  createSc2LayoutReferenceRenameEditTransaction,
  type Sc2LayoutReferenceRenameEditTransaction,
} from './edit.js'
import type { Sc2LayoutRenameOptions } from './rename.js'

/*
 * Legacy `GameArtifactCodec` adapter. The native codec (codecs/layout/src/codec.ts) no longer uses
 * it; it stays as the parity oracle for the format-core tests and for the MK2 sc2-mod rename
 * coordinator, which still speaks legacy asset DTOs.
 */

export const SC2_LAYOUT_SOURCE_KINDS: readonly AssetSourceKind[] = ['file', 'archive-entry']

/** Compatibility source-handle wrapper around the canonical bounded-bytes detector. */
export async function detectSc2Layout(
  source: AssetSource,
  context: ArtifactContext = {},
): Promise<DetectionResult> {
  let header: Uint8Array
  try {
    header = await readSourceHeader(source, SC2_LAYOUT_MAX_SNIFF_BYTES, context.cancellation)
  } catch (error) {
    throw new ModkitError({
      code: 'VFS_SOURCE_UNAVAILABLE',
      message: `Could not read the bounded SC2Layout header from '${source.descriptor.path}'.`,
      context: {
        codecId: SC2_LAYOUT_CODEC_ID,
        operation: 'detect',
        sourceId: source.descriptor.id,
      },
      cause: error,
    })
  }
  return detectSc2LayoutBytes(header, source.descriptor, context) as DetectionResult
}

export async function readSc2Layout(
  source: AssetSource,
  detection: DetectionResult,
  context: ArtifactContext = {},
): Promise<Sc2LayoutArtifactDocument> {
  let bytes: Uint8Array
  try {
    bytes = await source.read(
      context.cancellation === undefined ? {} : { cancellation: context.cancellation },
    )
  } catch (error) {
    throw new ModkitError({
      code: 'VFS_SOURCE_UNAVAILABLE',
      message: `Could not read SC2Layout source '${source.descriptor.path}'.`,
      context: {
        codecId: SC2_LAYOUT_CODEC_ID,
        operation: 'open',
        sourceId: source.descriptor.id,
      },
      cause: error,
    })
  }
  return parseSc2Layout(source.descriptor, bytes, detection, context)
}

export class Sc2LayoutCodec implements GameArtifactCodec<Sc2LayoutArtifactDocument> {
  readonly id = SC2_LAYOUT_CODEC_ID
  readonly kind: GameArtifactKind = 'layout'
  readonly supportedGames: readonly string[] = [SC2_GAME_ID]
  readonly sourceKinds: readonly AssetSourceKind[] = SC2_LAYOUT_SOURCE_KINDS
  readonly operations: readonly AssetOperationDescriptor[] = SC2_LAYOUT_OPERATIONS

  detect(source: AssetSource, context: ArtifactContext = {}): Promise<DetectionResult> {
    return detectSc2Layout(source, context)
  }

  async open(
    source: AssetSource,
    context: ArtifactContext = {},
    _options: ArtifactOpenOptions = {},
  ): Promise<Sc2LayoutArtifactDocument> {
    const detection = await this.detect(source, context)
    return readSc2Layout(source, detection, context)
  }

  describe(document: Sc2LayoutArtifactDocument, context: ArtifactContext = {}): Promise<AssetDescriptor> {
    return Promise.resolve(describeSc2Layout(document, context))
  }

  createSession(
    document: Sc2LayoutArtifactDocument,
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
        [sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.parse)]: () => document.data,
        [sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.inspect)]: () => inspectSc2Layout(document),
        [sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.render)]: () =>
          sc2LayoutDiagnosticHtmlOutput(document),
        [sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.exportHtml)]: () =>
          sc2LayoutDiagnosticHtmlOutput(document),
        [sc2LayoutHandlerId(LAYOUT_OPERATION_IDS.raw)]: () => rawSc2LayoutOutput(document),
      },
    })
  }

  /** Codec-owned edit transaction used by sc2-mod's cross-codec rename coordinator. */
  createReferenceRenameEditTransaction(
    document: Sc2LayoutDocument,
    options: Sc2LayoutRenameOptions,
  ): Sc2LayoutReferenceRenameEditTransaction {
    return createSc2LayoutReferenceRenameEditTransaction(document, options)
  }
}

export function createSc2LayoutCodec(): Sc2LayoutCodec {
  return new Sc2LayoutCodec()
}
