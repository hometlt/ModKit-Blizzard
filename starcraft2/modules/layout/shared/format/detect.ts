import { SC2_GAME_ID, SC2_LAYOUT_CODEC_ID, SC2_LAYOUT_EXTENSION } from './identity.js'

/** The part of a source identity detection and parsing read. */
export interface Sc2LayoutSource {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly extension: string
  readonly context?: { readonly gameId?: string }
}

export interface Sc2LayoutDetectionEvidence {
  readonly kind: 'structure' | 'extension' | 'context'
  readonly detail: string
  readonly polarity?: 'negative'
  readonly range?: { readonly offset: number; readonly length: number }
}

export interface Sc2LayoutDetection {
  readonly pluginId: string
  readonly confidence: number
  readonly evidence: readonly Sc2LayoutDetectionEvidence[]
  readonly requiredRanges: readonly { readonly offset: number; readonly length: number }[]
}

/** Large enough for the XML prelude and first declaration without reading a whole layout. */
export const SC2_LAYOUT_MAX_SNIFF_BYTES = 4 * 1024

export interface Sc2LayoutStructure {
  readonly descRoot: boolean
  readonly sc2Declaration?: string
}

function decodeHeader(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Inspect bounded XML text for the SC2Layout `<Desc>` root and known declaration elements. */
export function inspectSc2LayoutStructure(bytes: Uint8Array): Sc2LayoutStructure {
  const text = decodeHeader(bytes)
  const descRoot = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<Desc(?:\s|\/?>)/i.test(text)
  if (!descRoot) return { descRoot: false }
  const declaration = /<(Frame|Constant|Include|Animation|StateGroup)\b/i.exec(text)
  return {
    descRoot: true,
    ...(declaration?.[1] === undefined ? {} : { sc2Declaration: declaration[1] }),
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(0.98, Number(value.toFixed(4))))
}

/**
 * Bounded SC2Layout detection.
 *
 * The extension is never sufficient. A candidate must expose a `<Desc>` root in the bounded
 * header; extensionless candidates additionally need a known SC2 layout declaration.
 */
export function detectSc2LayoutBytes(
  bytes: Uint8Array,
  descriptor: Pick<Sc2LayoutSource, 'name' | 'extension' | 'context'>,
  context: { readonly gameId?: string } = {},
): Sc2LayoutDetection {
  const header = bytes.subarray(0, SC2_LAYOUT_MAX_SNIFF_BYTES)
  const range = { offset: 0, length: header.byteLength }
  const evidence: Sc2LayoutDetectionEvidence[] = []
  const structure = inspectSc2LayoutStructure(header)
  const extension = descriptor.extension.toLowerCase()
  const canonicalExtension = extension === SC2_LAYOUT_EXTENSION

  if (!structure.descRoot || (!canonicalExtension && structure.sc2Declaration === undefined)) {
    if (canonicalExtension) {
      evidence.push({ kind: 'extension', detail: `root name ${descriptor.name}` })
    }
    evidence.push({
      kind: 'structure',
      polarity: 'negative',
      detail: structure.descRoot
        ? 'Desc XML root has no recognized SC2Layout declaration'
        : 'no Desc XML root in the bounded source header',
      range,
    })
    return {
      pluginId: SC2_LAYOUT_CODEC_ID,
      confidence: 0,
      evidence,
      requiredRanges: [range],
    }
  }

  let confidence = 0.5
  evidence.push({ kind: 'structure', detail: 'SC2Layout Desc XML root', range })
  if (structure.sc2Declaration !== undefined) {
    evidence.push({
      kind: 'structure',
      detail: `SC2Layout ${structure.sc2Declaration} declaration`,
      range,
    })
    confidence += 0.3
  }
  if (canonicalExtension) {
    evidence.push({ kind: 'extension', detail: `canonical ${SC2_LAYOUT_EXTENSION} extension` })
    confidence += 0.15
  }
  if (context.gameId === SC2_GAME_ID || descriptor.context?.gameId === SC2_GAME_ID) {
    evidence.push({ kind: 'context', detail: `declared game ${SC2_GAME_ID}` })
    confidence += 0.03
  }

  return {
    pluginId: SC2_LAYOUT_CODEC_ID,
    confidence: clamp(confidence),
    evidence,
    requiredRanges: [range],
  }
}
