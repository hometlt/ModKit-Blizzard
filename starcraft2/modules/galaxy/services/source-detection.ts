/**
 * `galaxy` structural detection.
 *
 * Detection is deliberately **bounded** (pipeline rule 2): it decodes at most
 * {@link MAX_SNIFF_BYTES} of the head of the source and matches cheap declaration markers. The
 * real parser (`parseGalaxySource` from `@modkitx/galaxy`) is only run by `open()`, because
 * parsing a whole `natives.galaxy` to answer "is this Galaxy?" would violate the sniff budget.
 *
 * The markers below are the Galaxy grammar's own top-level statement forms as `@modkitx/galaxy`'s
 * parser accepts them (`include`, `native`, `struct`, `typedef`, `static`/`const` globals, and
 * typed function declarations); no new dialect rule is invented here.
 */

import { uint64 } from '@modkit/core'
import type { ArtifactByteSource, DetectionEvidence, DetectionResult } from '@modkit/sdk'
import {
  GALAXY_EXTENSION,
  SC2_GAME_ID,
} from '../../../shared/scripts/identity.js'

const GALAXY_CODEC_ID = 'blizzard/galaxy'

/** A Galaxy script is always one addressable text payload. */
export const GALAXY_SOURCE_KINDS = ['file', 'archive-entry'] as const

/** Head budget for the structural sniff. Enough for a header comment plus several declarations. */
export const MAX_SNIFF_BYTES = 32 * 1024

interface Marker {
  readonly id: string
  readonly weight: number
  readonly pattern: RegExp
}

export interface GalaxyDetectionOptions {
  readonly uri?: string
  readonly gameId?: string
  readonly signal?: AbortSignal
}

/**
 * Top-level Galaxy statement forms. All are anchored to line starts (`m` flag) so a match inside
 * a string literal or a comment tail cannot fabricate structural evidence on its own.
 */
const MARKERS: readonly Marker[] = [
  // SC2 writes `include "TriggerLibs/NativeLib"` with no terminator; the semicolon is optional.
  { id: 'galaxy:include', weight: 0.2, pattern: /^\s*include\s+"[^"\r\n]+"\s*;?\s*$/m },
  {
    id: 'galaxy:native',
    weight: 0.2,
    pattern: /^\s*native\s+[A-Za-z_][\w]*\s+[A-Za-z_][\w]*\s*\(/m,
  },
  { id: 'galaxy:struct', weight: 0.15, pattern: /^\s*struct\s+[A-Za-z_][\w]*\s*\{/m },
  { id: 'galaxy:typedef', weight: 0.15, pattern: /^\s*typedef\s+/m },
  {
    id: 'galaxy:global',
    weight: 0.15,
    pattern: /^\s*(?:static\s+|const\s+)+[A-Za-z_][\w]*(?:\[\])?\s+[A-Za-z_][\w]*\s*(?:=|;)/m,
  },
  {
    id: 'galaxy:function',
    weight: 0.2,
    pattern:
      /^\s*(?:static\s+)?(?:void|bool|int|fixed|string|text|byte|char|[a-z][\w]*)\s+[A-Za-z_][\w]*\s*\([^;{]*\)\s*\{/m,
  },
]

/** Markup that positively proves the payload is *not* a Galaxy script. */
const MARKUP_HEAD_RE = /^\s*(?:\uFEFF)?(?:<\?xml\b|<!DOCTYPE\b|<[A-Za-z][\w:.-]*[\s>/])/

/** A NUL byte in the head means binary, and Galaxy sources are text. */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024)
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true
  return false
}

function clamp(value: number): number {
  return Math.max(0, Math.min(0.98, Number(value.toFixed(4))))
}

/**
 * Bounded structural detection of a Galaxy script source.
 *
 * Confidence composition:
 *
 * - `.galaxy` extension: +0.35 (`extension` evidence — "only selects candidates");
 * - each matched top-level declaration marker: +0.15..+0.2 (`structure` evidence);
 * - declared StarCraft II context: +0.05 (`context` evidence, never sufficient alone);
 * - XML/markup or binary head: negative `structure`/`magic` evidence, which
 *   `rankDetectionCandidates` treats as an outright rejection even when the extension matched.
 *
 * A `.galaxy` file whose head contains no recognizable declaration keeps only its extension
 * evidence, so it stays a low-confidence candidate rather than a confident match.
 */
export function detectGalaxyBytes(
  header: Uint8Array,
  options: GalaxyDetectionOptions = {},
): DetectionResult {
  options.signal?.throwIfAborted()
  const evidence: DetectionEvidence[] = []
  let confidence = 0
  const uri = options.uri ?? ''
  const name = uri.replaceAll('\\', '/').split('/').at(-1) ?? ''
  const extension = /(?:^|\/)([^/?#]+)$/u.exec(uri)?.[1]?.match(/(\.[^.]+)$/u)?.[1] ?? ''
  const range = { byteOffset: uint64(0n), byteLength: uint64(BigInt(header.byteLength)) }

  if (extension.toLowerCase() === GALAXY_EXTENSION) {
    evidence.push({ kind: 'extension', weight: 0.35, note: `name ${name}` })
    confidence += 0.35
  }

  if (options.gameId === SC2_GAME_ID) {
    evidence.push({ kind: 'context', weight: 0.05, note: `declared game ${SC2_GAME_ID}` })
    confidence += 0.05
  }

  if (looksBinary(header)) {
    return {
      codecId: GALAXY_CODEC_ID,
      confidence: 0,
      evidence: [
        ...evidence,
        {
          kind: 'magic',
          weight: -1,
          note: 'NUL byte in head; not a text source',
        },
      ],
      requiredRanges: [range],
    }
  }

  const head = new TextDecoder('utf-8', { fatal: false }).decode(header)

  if (MARKUP_HEAD_RE.test(head)) {
    return {
      codecId: GALAXY_CODEC_ID,
      confidence: 0,
      evidence: [
        ...evidence,
        {
          kind: 'structure',
          weight: -1,
          note: 'head is XML/markup, not Galaxy source',
        },
      ],
      requiredRanges: [range],
    }
  }

  for (const marker of MARKERS) {
    if (!marker.pattern.test(head)) continue
    evidence.push({ kind: 'structure', weight: marker.weight, note: marker.id })
    confidence += marker.weight
  }

  return {
    codecId: GALAXY_CODEC_ID,
    confidence: clamp(confidence),
    evidence,
    requiredRanges: [range],
  }
}

/** Read only the bounded prefix allowed by this detector from an MK3 byte source. */
export async function detectGalaxySource(
  source: ArtifactByteSource,
  options: Omit<GalaxyDetectionOptions, 'uri'> = {},
): Promise<DetectionResult> {
  options.signal?.throwIfAborted()
  const length = source.size === undefined
    ? MAX_SNIFF_BYTES
    : Number(source.size < BigInt(MAX_SNIFF_BYTES) ? source.size : BigInt(MAX_SNIFF_BYTES))
  const header = await source.read(0n, length, options.signal)
  if (header.byteLength > length) throw new RangeError('Galaxy source returned bytes beyond the requested probe range')
  return detectGalaxyBytes(header, { ...options, uri: source.ref.uri })
}
