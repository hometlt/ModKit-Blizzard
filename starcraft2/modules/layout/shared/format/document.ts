import { parseLayout, type SC2LayoutFile } from '../layout-engine/sc2-layout-core/simple-parse/index.js'
import { layoutToHtml } from '../layout-engine/sc2-layout-core/html.js'
import { inspectSc2LayoutStructure, type Sc2LayoutSource } from './detect.js'

/** What a document needs from detection; legacy `DetectionResult` values satisfy it too. */
export interface Sc2LayoutDetectionLike {
  readonly confidence: number
}
import { layoutBasename, SC2_LAYOUT_CODEC_ID, SC2_LAYOUT_EXTENSION } from './identity.js'

export interface Sc2LayoutStats {
  readonly frameCount: number
  readonly topLevelFrameCount: number
  readonly propertyCount: number
  readonly anchorCount: number
  readonly constantCount: number
  readonly includeCount: number
  readonly templateCount: number
  readonly referenceCount: number
  readonly animationCount: number
}

/** Parse failure; `code` keeps the historical value callers match on. */
export class Sc2LayoutParseError extends Error {
  override readonly name = 'Sc2LayoutParseError'
  readonly code = 'PARSE_FAILED'
  constructor(
    message: string,
    readonly context: { readonly codecId: string; readonly operation: string; readonly sourceId: string },
    options?: { readonly cause?: unknown; readonly hint?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    if (options?.hint !== undefined) this.hint = options.hint
  }
  readonly hint?: string
}

/** A file output of the layout (raw source, diagnostic HTML). */
export interface Sc2LayoutOutput {
  readonly path: string
  readonly data: Uint8Array
  readonly mediaType: string
  readonly role: string
}

export interface Sc2LayoutDocument<
  Source extends Sc2LayoutSource = Sc2LayoutSource,
  Detection extends Sc2LayoutDetectionLike = Sc2LayoutDetectionLike,
> {
  readonly source: Source
  readonly detection: Detection
  readonly context: { readonly gameId?: string }
  /** Original source bytes. These remain authoritative for raw-preserving future edits. */
  readonly bytes: Uint8Array
  readonly text: string
  readonly data: SC2LayoutFile
  readonly stats: Sc2LayoutStats
}

export interface CreateSc2LayoutDocumentFromParsedInit<
  Source extends Sc2LayoutSource = Sc2LayoutSource,
  Detection extends Sc2LayoutDetectionLike = Sc2LayoutDetectionLike,
> {
  readonly source: Source
  readonly detection: Detection
  readonly context?: { readonly gameId?: string }
  /** Original source bytes retained as the raw-preserving source of truth. */
  readonly bytes: Uint8Array
  /** An SC2Layout file already parsed by `@modkitx/layout-lang/parse`. */
  readonly data: SC2LayoutFile
}

function decodeLayout(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function frameStats(frames: SC2LayoutFile['frames']): {
  readonly frames: number
  readonly properties: number
  readonly anchors: number
  readonly animations: number
} {
  let frameCount = 0
  let propertyCount = 0
  let anchorCount = 0
  let animationCount = 0
  for (const frame of frames) {
    const children = frameStats(frame.children)
    frameCount += 1 + children.frames
    propertyCount += frame.properties.length + children.properties
    anchorCount += frame.anchors.length + children.anchors
    animationCount += frame.animations.length + children.animations
  }
  return {
    frames: frameCount,
    properties: propertyCount,
    anchors: anchorCount,
    animations: animationCount,
  }
}

function buildStats(data: SC2LayoutFile): Sc2LayoutStats {
  const nested = frameStats(data.frames)
  return {
    frameCount: nested.frames,
    topLevelFrameCount: data.frames.length,
    propertyCount: nested.properties,
    anchorCount: nested.anchors,
    constantCount: data.constants.length,
    includeCount: data.includes.length,
    templateCount: data.templates.length,
    referenceCount: data.references.length,
    animationCount: data.animations.length + nested.animations,
  }
}

/**
 * Adapts an already-parsed layout into the semantic facade document without parsing it again.
 *
 * The original bytes remain authoritative, while text and structural statistics use the same
 * construction path as `parseSc2Layout`.
 */
export function createSc2LayoutDocumentFromParsed<
  Source extends Sc2LayoutSource,
  Detection extends Sc2LayoutDetectionLike,
>(init: CreateSc2LayoutDocumentFromParsedInit<Source, Detection>): Sc2LayoutDocument<Source, Detection> {
  try {
    return {
      source: init.source,
      detection: init.detection,
      context: init.context ?? {},
      bytes: init.bytes,
      text: decodeLayout(init.bytes),
      data: init.data,
      stats: buildStats(init.data),
    }
  } catch (error) {
    throw new Sc2LayoutParseError(
      `Could not retain parsed SC2Layout source '${init.source.path}'.`,
      { codecId: SC2_LAYOUT_CODEC_ID, operation: 'parse', sourceId: init.source.id },
      { cause: error },
    )
  }
}

export function parseSc2Layout<Source extends Sc2LayoutSource, Detection extends Sc2LayoutDetectionLike>(
  source: Source,
  bytes: Uint8Array,
  detection: Detection,
  context: { readonly gameId?: string } = {},
): Sc2LayoutDocument<Source, Detection> {
  try {
    const structure = inspectSc2LayoutStructure(bytes)
    if (
      !structure.descRoot ||
      (source.extension.toLowerCase() !== SC2_LAYOUT_EXTENSION &&
        structure.sc2Declaration === undefined)
    ) {
      throw new Sc2LayoutParseError(
        `Source '${source.path}' is not an SC2Layout document.`,
        { codecId: SC2_LAYOUT_CODEC_ID, operation: 'parse', sourceId: source.id },
        { hint: 'Expected a .SC2Layout XML document with a Desc root.' },
      )
    }
    const text = decodeLayout(bytes)
    const data = parseLayout(text)
    return createSc2LayoutDocumentFromParsed({
      source,
      detection,
      context,
      bytes,
      data,
    })
  } catch (error) {
    if (error instanceof Sc2LayoutParseError) throw error
    throw new Sc2LayoutParseError(
      `Could not parse SC2Layout source '${source.path}'.`,
      { codecId: SC2_LAYOUT_CODEC_ID, operation: 'parse', sourceId: source.id },
      { cause: error },
    )
  }
}

export interface Sc2LayoutInspection {
  readonly format: 'sc2-layout'
  readonly stats: Sc2LayoutStats
  readonly includes: readonly string[]
  readonly templates: readonly string[]
  readonly topLevelFrames: readonly {
    readonly name: string
    readonly type: string
  }[]
}

export function inspectSc2Layout(document: Sc2LayoutDocument): Sc2LayoutInspection {
  return {
    format: 'sc2-layout',
    stats: document.stats,
    includes: [...document.data.includes],
    templates: [...document.data.templates],
    topLevelFrames: document.data.frames.map(frame => ({
      name: frame.name,
      type: frame.type,
    })),
  }
}

export function rawSc2LayoutOutput(document: Sc2LayoutDocument): Sc2LayoutOutput {
  return {
    path: document.source.path,
    data: document.bytes.slice(),
    mediaType: 'application/xml',
    role: 'sc2-layout-source',
  }
}

export function renderSc2LayoutDiagnosticHtml(document: Sc2LayoutDocument): string {
  return layoutToHtml(document.data, {
    title: layoutBasename(document.source.path),
    fileName: layoutBasename(document.source.path),
  })
}

export function sc2LayoutDiagnosticHtmlOutput(document: Sc2LayoutDocument): Sc2LayoutOutput {
  const name = layoutBasename(document.source.path)
  return {
    path: `${name}.html`,
    data: new TextEncoder().encode(renderSc2LayoutDiagnosticHtml(document)),
    mediaType: 'text/html',
    role: 'sc2-layout-diagnostic-html',
  }
}
