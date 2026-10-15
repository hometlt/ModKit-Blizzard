/**
 * Protocol-neutral language services for `.SC2Cutscene` and `.StormCutscene`.
 *
 * The codec owns the lossless XML model. This provider deliberately consumes that model instead of
 * maintaining a second parser: diagnostics, symbols, GUID navigation and the timeline hover all
 * therefore agree with `view.inspect` and `asset.validate`. The small lexical scanner here exists
 * only to provide source ranges for XML tags and attributes, which the byte-preserving codec does
 * not need to retain as separate attribute offsets.
 */
import type {
  LanguageAnalysis,
  LanguageAnalysisRequest,
  LanguageCodeActionsRequest,
  LanguageColor,
  LanguageColorPresentationList,
  LanguageCompletionItem,
  LanguageCompletionList,
  LanguageDiagnostic,
  LanguageDiagnosticList,
  LanguageDocument,
  LanguageDocumentSymbolList,
  LanguageFeatureRequest,
  LanguageFormattingRequest,
  LanguageHover,
  LanguageLocation,
  LanguageLocationList,
  LanguagePosition,
  LanguagePositionRequest,
  LanguageProvider,
  LanguageRange,
  LanguageReferencesRequest,
  LanguageRenamePreparation,
  LanguageRenameRequest,
  LanguageSignatureHelp,
  LanguageSymbol,
  LanguageToken,
  LanguageWorkspaceEdit,
  LanguageWorkspaceSymbolList,
  LanguageWorkspaceSymbolsRequest,
} from '@modkit/sdk'
import { finalNewlineCodeActions, finalNewlineFormatting } from '../../../../../shared/language/code-actions.js'

import {
  CutsceneParseError,
  decodeCutsceneText,
  decodeEntities,
} from '../../../codecs/cutscene/src/decode.js'
import {
  guidOf,
  valueOf,
  walk,
  type CutsceneDocument,
  type CutsceneElement,
} from '../../../codecs/cutscene/src/model.js'
import {
  CUTSCENE_ROOT_TAG,
  CUTSCENE_TAGS,
  kindOf,
  roleOf,
  tagEntry,
} from '../../../codecs/cutscene/src/registry.js'
import {
  REFERENCE_ATTRIBUTES,
  findingsOf,
  validateCutscene,
} from '../../../codecs/cutscene/src/validate.js'
import { resolveTimeline } from '../../../codecs/cutscene/src/timeline.js'

export const CUTSCENE_LANGUAGE_IDS = Object.freeze(['sc2-cutscene', 'storm-cutscene'] as const)

const CUTSCENE_LANGUAGE_ID_SET = new Set<string>(CUTSCENE_LANGUAGE_IDS)
const XML_NAME = /[A-Za-z_:]/u
const XML_NAME_PART = /[-A-Za-z0-9_:.]/u
const XML_SPACE = /[ \t\r\n]/u
const DECIMAL = /^\d+$/u
const MAX_COMPLETION_VALUES = 5_000

type CutsceneLanguageId = (typeof CUTSCENE_LANGUAGE_IDS)[number]

interface XmlAttributeToken {
  readonly name: string
  readonly nameStart: number
  readonly nameEnd: number
  readonly valueStart: number | undefined
  readonly valueEnd: number | undefined
  readonly value: string | undefined
  readonly quote: '"' | "'" | undefined
}

interface XmlStartTag {
  readonly tag: string
  readonly start: number
  readonly tagStart: number
  readonly tagEnd: number
  readonly closeStart: number
  readonly end: number
  readonly selfClosing: boolean
  readonly attributes: readonly XmlAttributeToken[]
}

interface XmlScan {
  readonly startTags: readonly XmlStartTag[]
  readonly tokens: readonly LanguageToken[]
}

interface ParsedCutscene {
  readonly source: LanguageDocument
  readonly index: LineIndex
  readonly scan: XmlScan
  readonly document: CutsceneDocument | undefined
  readonly error: CutsceneParseError | undefined
  readonly bomOffset: number
  readonly elementBySourceStart: ReadonlyMap<number, CutsceneElement>
  readonly startTagBySourceStart: ReadonlyMap<number, XmlStartTag>
}

/** UTF-16 positions, exactly as LSP and the SDK define them. */
class LineIndex {
  readonly #starts: number[] = [0]

  constructor(readonly text: string) {
    for (let offset = 0; offset < text.length; offset += 1) {
      if (text.charCodeAt(offset) === 10) this.#starts.push(offset + 1)
    }
  }

  positionAt(offset: number): LanguagePosition {
    const target = Math.max(0, Math.min(this.text.length, offset))
    let low = 0
    let high = this.#starts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((this.#starts[middle] ?? 0) <= target) low = middle
      else high = middle - 1
    }
    return { line: low, character: target - (this.#starts[low] ?? 0) }
  }

  offsetAt(position: LanguagePosition): number {
    const line = Math.max(0, Math.min(this.#starts.length - 1, position.line))
    return Math.max(0, Math.min(this.text.length, (this.#starts[line] ?? 0) + position.character))
  }

  range(start: number, end: number): LanguageRange {
    return { start: this.positionAt(start), end: this.positionAt(end) }
  }
}

function isNameStart(value: string | undefined): boolean {
  return value !== undefined && XML_NAME.test(value)
}

function isNamePart(value: string | undefined): boolean {
  return value !== undefined && XML_NAME_PART.test(value)
}

function isSpace(value: string | undefined): boolean {
  return value !== undefined && XML_SPACE.test(value)
}

/** Scan opening tags and attributes without changing or normalising the source text. */
function scanStartTags(text: string): readonly XmlStartTag[] {
  const tags: XmlStartTag[] = []
  let offset = 0
  while (offset < text.length) {
    const start = text.indexOf('<', offset)
    if (start < 0) break
    const next = text[start + 1]
    if (next === '/' || next === '!' || next === '?') {
      const end = text.indexOf('>', start + 1)
      offset = end < 0 ? text.length : end + 1
      continue
    }

    let cursor = start + 1
    if (!isNameStart(text[cursor])) {
      offset = start + 1
      continue
    }
    const tagStart = cursor
    cursor += 1
    while (isNamePart(text[cursor])) cursor += 1
    const tagEnd = cursor

    let quote: '"' | "'" | undefined
    let closeStart = text.length
    for (let probe = cursor; probe < text.length; probe += 1) {
      const character = text[probe]
      if (quote !== undefined) {
        if (character === quote) quote = undefined
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '>') {
        closeStart = probe
        break
      }
    }

    const innerEnd = closeStart === text.length ? text.length : closeStart
    const beforeClose = text.slice(cursor, innerEnd)
    const selfClosing = /\/\s*$/u.test(beforeClose)
    const attributeEnd = selfClosing ? innerEnd - beforeClose.match(/\s*$/u)?.[0].length! - 1 : innerEnd
    const attributes: XmlAttributeToken[] = []
    let attributeOffset = cursor
    while (attributeOffset < attributeEnd) {
      while (attributeOffset < attributeEnd && isSpace(text[attributeOffset])) attributeOffset += 1
      if (attributeOffset >= attributeEnd || text[attributeOffset] === '/') break
      if (!isNameStart(text[attributeOffset])) break
      const nameStart = attributeOffset
      attributeOffset += 1
      while (attributeOffset < attributeEnd && isNamePart(text[attributeOffset])) attributeOffset += 1
      const nameEnd = attributeOffset
      while (attributeOffset < attributeEnd && isSpace(text[attributeOffset])) attributeOffset += 1

      let valueStart: number | undefined
      let valueEnd: number | undefined
      let value: string | undefined
      let attributeQuote: '"' | "'" | undefined
      if (text[attributeOffset] === '=') {
        attributeOffset += 1
        while (attributeOffset < attributeEnd && isSpace(text[attributeOffset])) attributeOffset += 1
        const delimiter = text[attributeOffset]
        if (delimiter === '"' || delimiter === "'") {
          attributeQuote = delimiter
          attributeOffset += 1
          valueStart = attributeOffset
          const found = text.indexOf(delimiter, attributeOffset)
          valueEnd = found < 0 || found > attributeEnd ? attributeEnd : found
          value = decodeEntities(text.slice(valueStart, valueEnd))
          attributeOffset = found < 0 || found > attributeEnd ? attributeEnd : found + 1
        }
      }
      attributes.push({
        name: text.slice(nameStart, nameEnd),
        nameStart,
        nameEnd,
        valueStart,
        valueEnd,
        value,
        quote: attributeQuote,
      })
    }

    tags.push({
      tag: text.slice(tagStart, tagEnd),
      start,
      tagStart,
      tagEnd,
      closeStart,
      end: closeStart === text.length ? text.length : closeStart + 1,
      selfClosing,
      attributes,
    })
    offset = closeStart === text.length ? text.length : closeStart + 1
  }
  return tags
}

function token(
  index: LineIndex,
  kind: LanguageToken['kind'],
  start: number,
  end: number,
): LanguageToken {
  return { kind, range: index.range(start, end) }
}

function scanXml(text: string, index: LineIndex): XmlScan {
  const startTags = scanStartTags(text)
  const tokens: LanguageToken[] = []
  for (const startTag of startTags) {
    tokens.push(token(index, 'operator', startTag.start, startTag.start + 1))
    tokens.push(token(index, 'keyword', startTag.tagStart, startTag.tagEnd))
    for (const attribute of startTag.attributes) {
      tokens.push(token(index, 'property', attribute.nameStart, attribute.nameEnd))
      const equals = text.indexOf('=', attribute.nameEnd)
      if (equals >= attribute.nameEnd && equals < (attribute.valueStart ?? startTag.closeStart)) {
        tokens.push(token(index, 'operator', equals, equals + 1))
      }
      if (attribute.valueStart !== undefined && attribute.valueEnd !== undefined) {
        const from = Math.max(attribute.nameEnd, attribute.valueStart - 1)
        const to = attribute.quote === undefined ? attribute.valueEnd : attribute.valueEnd + 1
        tokens.push(token(index, 'string', from, to))
      }
    }
    if (startTag.closeStart < text.length) {
      const slash = startTag.selfClosing ? text.lastIndexOf('/', startTag.closeStart) : -1
      if (slash >= startTag.tagEnd) tokens.push(token(index, 'operator', slash, slash + 1))
      tokens.push(token(index, 'operator', startTag.closeStart, startTag.closeStart + 1))
    }
  }

  const closing = /<\/([A-Za-z_:][-A-Za-z0-9_:.]*)/gu
  for (const match of text.matchAll(closing)) {
    const full = match[0]
    const name = match[1] ?? ''
    const start = match.index ?? 0
    tokens.push(token(index, 'operator', start, start + 2))
    tokens.push(token(index, 'keyword', start + full.length - name.length, start + full.length))
  }
  return { startTags, tokens }
}

function parseDocument(source: LanguageDocument): ParsedCutscene {
  const index = new LineIndex(source.text)
  const scan = scanXml(source.text, index)
  const bomOffset = source.text.startsWith('\uFEFF') ? 1 : 0
  const startTagBySourceStart = new Map(scan.startTags.map(tag => [tag.start, tag] as const))
  try {
    const document = decodeCutsceneText(source.text)
    const elementBySourceStart = new Map<number, CutsceneElement>()
    for (const element of walk(document.root)) {
      elementBySourceStart.set(element.start + bomOffset, element)
    }
    return { source, index, scan, document, error: undefined, bomOffset, elementBySourceStart, startTagBySourceStart }
  } catch (error) {
    return {
      source,
      index,
      scan,
      document: undefined,
      error: error instanceof CutsceneParseError ? error : undefined,
      bomOffset,
      elementBySourceStart: new Map(),
      startTagBySourceStart,
    }
  }
}

function assertCutsceneLanguage(document: LanguageDocument): asserts document is LanguageDocument & {
  readonly languageId: CutsceneLanguageId
} {
  if (!CUTSCENE_LANGUAGE_ID_SET.has(document.languageId)) {
    throw new TypeError(`Cutscene provider cannot analyze ${document.languageId}`)
  }
}

function documentsOf(request: LanguageFeatureRequest): readonly LanguageDocument[] {
  const result: LanguageDocument[] = []
  const seen = new Set<string>()
  for (const document of [request.document, ...request.workspaceDocuments]) {
    if (!CUTSCENE_LANGUAGE_ID_SET.has(document.languageId) || seen.has(document.uri)) continue
    seen.add(document.uri)
    result.push(document)
  }
  return result
}

function sourceStart(element: CutsceneElement, parsed: ParsedCutscene): number {
  return element.start + parsed.bomOffset
}

function sourceEnd(element: CutsceneElement, parsed: ParsedCutscene): number {
  return element.end + parsed.bomOffset
}

function startTagFor(element: CutsceneElement, parsed: ParsedCutscene): XmlStartTag | undefined {
  return parsed.startTagBySourceStart.get(sourceStart(element, parsed))
}

function elementAt(parsed: ParsedCutscene, offset: number): CutsceneElement | undefined {
  if (parsed.document === undefined) return undefined
  let found: CutsceneElement | undefined
  for (const element of walk(parsed.document.root)) {
    if (sourceStart(element, parsed) <= offset && offset <= sourceEnd(element, parsed)) {
      if (found === undefined || sourceEnd(element, parsed) - sourceStart(element, parsed) < sourceEnd(found, parsed) - sourceStart(found, parsed)) {
        found = element
      }
    }
  }
  return found
}

function startTagAt(parsed: ParsedCutscene, offset: number): XmlStartTag | undefined {
  return parsed.scan.startTags.find(item => item.start <= offset && offset <= item.end)
}

function attributeAt(
  parsed: ParsedCutscene,
  offset: number,
): { readonly tag: XmlStartTag; readonly attribute: XmlAttributeToken } | undefined {
  for (const tag of parsed.scan.startTags) {
    for (const attribute of tag.attributes) {
      const end = attribute.valueEnd ?? attribute.nameEnd
      if (attribute.nameStart <= offset && offset <= end) return { tag, attribute }
    }
  }
  return undefined
}

function rangeForAttribute(parsed: ParsedCutscene, attribute: XmlAttributeToken): LanguageRange {
  return parsed.index.range(
    attribute.valueStart ?? attribute.nameStart,
    attribute.valueEnd ?? attribute.nameEnd,
  )
}

function rangeForTag(parsed: ParsedCutscene, tag: XmlStartTag): LanguageRange {
  return parsed.index.range(tag.tagStart, tag.tagEnd)
}

function tagElement(parsed: ParsedCutscene, tag: XmlStartTag): CutsceneElement | undefined {
  return parsed.elementBySourceStart.get(tag.start)
}

const ATTRIBUTE_DOCS: Readonly<Record<string, string>> = Object.freeze({
  guid: 'Opaque decimal identifier. Keep it as text; values may exceed uint64.',
  name: 'Human-readable track, camera, actor or marker name.',
  sortIndex: 'Editor ordering index for a scene track.',
  start: 'Absolute or derived clip start in the file time unit.',
  duration: 'Clip duration in the file time unit.',
  time: 'Curve-key time in the file time unit.',
  lockedToEnd: 'Keeps a clip attached to the end of its track or scene.',
  startLinkGuid: 'GUID of the element used as the start anchor.',
  endLinkGuid: 'GUID of the element used as the end anchor.',
  startLinkDistance: 'Offset from the selected start-anchor point.',
  endLinkDistance: 'Offset from the selected end-anchor point.',
  startLinkAttachToPoint: 'Which point of the start anchor to attach to: 1 = its start, 2 = its end.',
  endLinkAttachToPoint: 'Which point of the end anchor to attach to: 1 = its start, 2 = its end.',
  curveInType: 'How the incoming control point was built: 3 linear, 4 flat, 5 smooth, 6 custom, 7 auto; 0 and 2 are unmeasured.',
  curveOutType: 'How the outgoing control point was built: 3 linear, 4 flat, 5 smooth, 6 custom, 7 auto; 0 and 2 are unmeasured.',
  curveInValue: 'Incoming cubic Bézier control point as time,value.',
  curveOutValue: 'Outgoing cubic Bézier control point as time,value.',
  propertyName: 'Animated property channel, for example positionX or fov.',
  modelLink: 'Catalog model link resolved through SC2 GameData.',
  unitLink: 'Catalog unit link resolved through SC2 GameData.',
  actorAlias: 'Catalog actor alias used by the cutscene actor.',
  soundLink: 'Sound asset or catalog link used by this sound/conversation.',
  conversationLink: 'Conversation catalog link.',
  conversationLine: 'Conversation line identifier.',
  lineId: 'Conversation line identifier.',
  alternateLineId: 'Alternate conversation line identifier.',
  modelPath: 'Model path referenced by the scene.',
  filePath: 'External M3A animation path when carried by an M3A node.',
  referenceFile: 'Another cutscene file included by this scene.',
  referenceGuid: 'GUID in the referenced cutscene when referenceFile is present.',
  pathGuid: 'GUID of the path followed by this clip.',
  cameraGUID: 'GUID of the camera used by this activation or shot.',
  objectGuid: 'GUID of the object used by this activation.',
  lightGUID: 'GUID of the light used by this activation.',
  lookAtGUID: 'GUID of the look-at target.',
  attachGuid: 'GUID of the attachment target.',
  attachName: 'Model attachment point name.',
  facialGroup: 'Facial animation group name.',
  facialAnim: 'Facial animation name.',
  fxaOverride: 'Facial animation override.',
  filter: 'Runtime cutscene filter controlling node visibility.',
})

const REFERENCE_ROLE_BY_ATTRIBUTE: Readonly<Record<string, string>> = Object.freeze({
  modelLink: 'catalog',
  debugModelLink: 'catalog',
  unitLink: 'catalog',
  actorAlias: 'catalog',
  speakerTag: 'catalog',
  finderTag: 'catalog',
  soundLink: 'sound',
  conversationLink: 'conversation',
  conversationLine: 'conversation',
  lineId: 'conversation',
  alternateLineId: 'conversation',
  modelPath: 'model',
  filePath: 'model-animation',
  facialGroup: 'facial-animation',
  facialAnim: 'facial-animation',
  fxaOverride: 'facial-animation',
  referenceFile: 'cutscene',
  filter: 'filter',
  anim: 'animation-name',
  animId: 'animation-name',
})

const COMMON_ATTRIBUTES = Object.freeze([
  'guid',
  'name',
  'sortIndex',
  'start',
  'duration',
  'lockedToEnd',
  'startLinkGuid',
  'startLinkDistance',
  'startLinkAttachToPoint',
  'endLinkGuid',
  'endLinkDistance',
  'endLinkAttachToPoint',
  'enabled',
  'filter',
])

const KIND_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Actor: ['modelLink', 'debugModelLink', 'unitLink', 'actorAlias', 'speakerTag', 'finderTag', 'teamColorDiffuse', 'teamColorEmissive'],
  Anim: ['anim', 'animId', 'priority', 'originalDuration', 'looping', 'blendTime', 'blendOutTime', 'timeScale', 'weight'],
  PropertyValue: ['propertyName'],
  PropertyCurve: ['time', 'value', 'curveInValue', 'curveOutValue', 'curveInType', 'curveOutType'],
  PathMarker: ['time', 'value', 'curveInType', 'curveOutType'],
  Conversation: ['conversationLink', 'conversationLine', 'lineId', 'alternateLineId', 'soundLink', 'facialGroup', 'facialAnim', 'fxaOverride'],
  M3A: ['filePath', 'name'],
  FollowPath: ['pathGuid', 'rotationOffset', 'alwaysPointUp'],
  LookAt: ['lookAtGUID', 'lookAtType', 'attachGuid', 'attachName'],
  Attachment: ['attachGuid', 'attachName', 'offset', 'rotation'],
  ActiveCamera: ['objectGuid', 'cameraGUID', 'cameraIndex', 'cameraName', 'blend'],
  ActiveLight: ['lightGUID', 'lightID', 'lightIndex', 'blend'],
  RTTChannel: ['objectGUID', 'cameraIndex', 'aspectRatio'],
  Folder: ['referenceFile', 'referenceGuid'],
  Sound: ['soundLink', 'mode', 'pitch', 'volume'],
})

function candidateAttributes(parsed: ParsedCutscene, tag: XmlStartTag): readonly string[] {
  const kind = kindOf(tag.tag)
  const values = new Set<string>([
    ...COMMON_ATTRIBUTES,
    ...(KIND_ATTRIBUTES[kind] ?? []),
    ...Object.keys(ATTRIBUTE_DOCS),
  ])
  for (const candidate of parsed.scan.startTags) {
    if (kindOf(candidate.tag) !== kind) continue
    for (const attribute of candidate.attributes) values.add(attribute.name)
  }
  return [...values].sort()
}

function diagnosticsFor(parsed: ParsedCutscene): readonly LanguageDiagnostic[] {
  if (parsed.error !== undefined) {
    const start = parsed.error.offset + parsed.bomOffset
    return [{
      range: parsed.index.range(start, Math.min(parsed.source.text.length, start + 1)),
      severity: 'error',
      message: parsed.error.message,
      code: 'blizzard.sc2-cutscene/parse',
      source: 'sc2-cutscene',
    }]
  }
  if (parsed.document === undefined) return []
  const report = validateCutscene(parsed.document)
  const diagnostics: LanguageDiagnostic[] = []
  const root = startTagFor(parsed.document.root, parsed)
  const documentRange = root === undefined ? parsed.index.range(0, Math.min(1, parsed.source.text.length)) : rangeForTag(parsed, root)

  for (const finding of findingsOf(report)) {
    // The validator names the element; a finding without one is about the whole document.
    let range = documentRange
    const tag = finding.location === undefined ? undefined : parsed.startTagBySourceStart.get(finding.location.start + parsed.bomOffset)
    if (tag !== undefined) {
      const attribute = tag.attributes.find(item => item.name === finding.location?.attribute)
      range = attribute === undefined ? rangeForTag(parsed, tag) : rangeForAttribute(parsed, attribute)
    }
    diagnostics.push({
      range,
      severity: finding.severity === 'info' ? 'information' : finding.severity,
      message: finding.message,
      code: `blizzard.sc2-cutscene/${finding.code}`,
      source: 'sc2-cutscene',
    })
  }
  return diagnostics
}

function symbolKind(element: CutsceneElement): LanguageSymbol['kind'] {
  const role = roleOf(element.tag)
  if (role === 'root') return 'module'
  if (role === 'node') return 'class'
  return 'property'
}

function symbolName(element: CutsceneElement): string {
  return valueOf(element, 'name') ?? valueOf(element, 'propertyName') ?? guidOf(element) ?? kindOf(element.tag)
}

function symbolsFor(parsed: ParsedCutscene, maxResults: number): readonly LanguageSymbol[] {
  if (parsed.document === undefined) return []
  let remaining = Math.max(0, maxResults)
  const build = (element: CutsceneElement): LanguageSymbol | undefined => {
    if (remaining <= 0) return undefined
    remaining -= 1
    const startTag = startTagFor(element, parsed)
    const selectionRange = startTag === undefined
      ? parsed.index.range(sourceStart(element, parsed), sourceStart(element, parsed) + element.tag.length)
      : rangeForTag(parsed, startTag)
    const children: LanguageSymbol[] = []
    for (const child of element.children) {
      const symbol = build(child)
      if (symbol !== undefined) children.push(symbol)
      if (remaining <= 0) break
    }
    return {
      name: symbolName(element),
      kind: symbolKind(element),
      detail: element.tag,
      range: parsed.index.range(sourceStart(element, parsed), sourceEnd(element, parsed)),
      selectionRange,
      ...(children.length === 0 ? {} : { children }),
    }
  }
  const root = build(parsed.document.root)
  return root === undefined ? [] : [root]
}

function flattenSymbols(
  symbols: readonly LanguageSymbol[],
  containerName: string | undefined = undefined,
): readonly { readonly symbol: LanguageSymbol; readonly containerName: string | undefined }[] {
  const result: { symbol: LanguageSymbol; containerName: string | undefined }[] = []
  for (const symbol of symbols) {
    result.push({ symbol, containerName })
    result.push(...flattenSymbols(symbol.children ?? [], symbol.name))
  }
  return result
}

function safeMarkdown(value: string): string {
  return value.replaceAll('`', '\\`')
}

function hoverFor(parsed: ParsedCutscene, position: LanguagePosition): LanguageHover | undefined {
  const offset = parsed.index.offsetAt(position)
  const found = attributeAt(parsed, offset)
  if (found !== undefined) {
    const { attribute, tag } = found
    const doc = ATTRIBUTE_DOCS[attribute.name] ?? `Attribute on <${tag.tag}>.`
    const role = REFERENCE_ROLE_BY_ATTRIBUTE[attribute.name]
    const lines = [`**${attribute.name}** — ${doc}`, `Tag: \`${tag.tag}\``]
    if (attribute.value !== undefined) lines.push(`Value: \`${safeMarkdown(attribute.value)}\``)
    if (role !== undefined) lines.push(`Reference role: \`${role}\``)
    if (attribute.name === 'guid') lines.push('GUIDs are opaque decimal strings, not numeric values.')
    return {
      markdown: lines.join('\n\n'),
      range: rangeForAttribute(parsed, attribute),
      provenance: 'blizzard/sc2-cutscene-language',
    }
  }

  const tag = startTagAt(parsed, offset)
  if (tag !== undefined) {
    const entry = tagEntry(tag.tag)
    const element = tagElement(parsed, tag)
    const lines = [
      `**<${tag.tag}>**`,
      entry?.summary ?? 'Unknown cutscene tag. It is preserved by the lossless codec.',
    ]
    if (entry !== undefined) lines.push(`Role: \`${entry.role}\`; origin: \`${entry.origin}\``)
    const guid = element === undefined ? undefined : guidOf(element)
    if (guid !== undefined) lines.push(`GUID: \`${safeMarkdown(guid)}\``)
    return {
      markdown: lines.join('\n\n'),
      range: rangeForTag(parsed, tag),
      provenance: 'blizzard/sc2-cutscene-language',
    }
  }

  const element = elementAt(parsed, offset)
  if (element === undefined) return undefined
  const timeline = parsed.document === undefined ? undefined : resolveTimeline(parsed.document)
  const clip = timeline?.clips.find(item => item.guid === guidOf(element))
  if (clip === undefined) return undefined
  return {
    markdown: `**Timeline clip**\n\nStart: \`${clip.start}\`\n\nEnd: \`${clip.end}\`\n\n${clip.approximate ? 'Time is approximate: an anchor uses an unmeasured attach point or forms a cycle.' : 'Time is resolved from the document.'}`,
    range: parsed.index.range(sourceStart(element, parsed), sourceEnd(element, parsed)),
    provenance: 'blizzard/sc2-cutscene-language',
  }
}

function localOrExternalTarget(
  parsed: ParsedCutscene,
  position: LanguagePosition,
): { readonly kind: 'guid' | 'file'; readonly value: string; readonly attribute: XmlAttributeToken; readonly referenceFile?: string } | undefined {
  const found = attributeAt(parsed, parsed.index.offsetAt(position))
  if (found === undefined || found.attribute.value === undefined || found.attribute.value === '') return undefined
  const { attribute, tag } = found
  const value = attribute.value!
  if (attribute.name === 'referenceFile') return { kind: 'file', value, attribute }
  if ((attribute.name === 'guid' || REFERENCE_ATTRIBUTES.includes(attribute.name)) && DECIMAL.test(value)) {
    const referenceFile = attribute.name === 'referenceGuid' ? includedFile(tag) : undefined
    return referenceFile === undefined ? { kind: 'guid', value, attribute } : { kind: 'guid', value, attribute, referenceFile }
  }
  return undefined
}

/** The cutscene a tag includes, when it includes one. Same rule as the validator: empty is none. */
function includedFile(tag: XmlStartTag): string | undefined {
  const value = tag.attributes.find(attribute => attribute.name === 'referenceFile')?.value
  return value === undefined || value === '' ? undefined : value
}

/**
 * Identifiers are scoped to their document. The only way one file names a GUID of another is
 * `referenceGuid` beside a `referenceFile`, so the owner of a target is the current document unless
 * the target is such an include.
 */
function guidOwners(
  current: ParsedCutscene,
  parsedDocuments: readonly ParsedCutscene[],
  referenceFile: string | undefined,
): readonly ParsedCutscene[] {
  if (referenceFile === undefined) return [current]
  return parsedDocuments.filter(item => item.document !== undefined && cutscenePathMatches(referenceFile, item.source))
}

function guidDeclarations(parsed: ParsedCutscene, guid: string): readonly XmlAttributeToken[] {
  return parsed.scan.startTags.flatMap(tag => tag.attributes.filter(attribute => attribute.name === 'guid' && attribute.value === guid))
}

/** The declaration and same-document references of `guid` inside its owner. */
function localGuidLocations(
  parsed: ParsedCutscene,
  guid: string,
  includeDeclaration: boolean,
): readonly LanguageLocation[] {
  const locations: LanguageLocation[] = []
  for (const tag of parsed.scan.startTags) {
    const external = includedFile(tag) !== undefined
    for (const attribute of tag.attributes) {
      if (attribute.value !== guid) continue
      const matches = attribute.name === 'guid'
        ? includeDeclaration
        : REFERENCE_ATTRIBUTES.includes(attribute.name) && !(external && attribute.name === 'referenceGuid')
      if (matches) locations.push({ uri: parsed.source.uri, range: rangeForAttribute(parsed, attribute) })
    }
  }
  return locations
}

/** `referenceGuid` attributes in any document that include `owner` and name `guid` in it. */
function incomingGuidLocations(
  parsedDocuments: readonly ParsedCutscene[],
  owner: ParsedCutscene,
  guid: string,
): readonly LanguageLocation[] {
  const locations: LanguageLocation[] = []
  for (const parsed of parsedDocuments) {
    for (const tag of parsed.scan.startTags) {
      const referenceFile = includedFile(tag)
      if (referenceFile === undefined || !cutscenePathMatches(referenceFile, owner.source)) continue
      for (const attribute of tag.attributes) {
        if (attribute.name === 'referenceGuid' && attribute.value === guid) {
          locations.push({ uri: parsed.source.uri, range: rangeForAttribute(parsed, attribute) })
        }
      }
    }
  }
  return locations
}

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/^\/+/u, '').toLocaleLowerCase()
}

function basename(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function cutscenePathMatches(reference: string, document: LanguageDocument): boolean {
  const wanted = normalizedPath(reference)
  const uriPath = normalizedPath(document.uri)
  const file = normalizedPath(basename(document.uri))
  return wanted === uriPath || wanted === file || uriPath.endsWith(`/${wanted}`) || wanted.endsWith(`/${file}`)
}

function rootLocation(parsed: ParsedCutscene): LanguageLocation | undefined {
  if (parsed.document === undefined) return undefined
  const root = startTagFor(parsed.document.root, parsed)
  if (root === undefined) return undefined
  return { uri: parsed.source.uri, range: rangeForTag(parsed, root) }
}

function boundedLocations(
  locations: readonly LanguageLocation[],
  request: LanguageFeatureRequest,
): LanguageLocationList {
  const items = locations.slice(0, request.maxResults)
  return { locations: items, isIncomplete: items.length < locations.length || request.workspaceIncomplete }
}

function definitionFor(
  request: LanguagePositionRequest,
): LanguageLocationList {
  assertCutsceneLanguage(request.document)
  const current = parseDocument(request.document)
  const target = localOrExternalTarget(current, request.position)
  if (target === undefined) return { locations: [], isIncomplete: false }
  const parsedDocuments = documentsOf(request).map(parseDocument)
  if (target.kind === 'file') {
    const locations = parsedDocuments
      .filter(item => item.document !== undefined && cutscenePathMatches(target.value, item.source))
      .map(rootLocation)
      .filter((item): item is LanguageLocation => item !== undefined)
    return boundedLocations(locations, request)
  }

  const locations = guidOwners(current, parsedDocuments, target.referenceFile).flatMap(owner =>
    guidDeclarations(owner, target.value).map(declaration => ({ uri: owner.source.uri, range: rangeForAttribute(owner, declaration) })),
  )
  return boundedLocations(locations, request)
}

function referencesFor(request: LanguageReferencesRequest): LanguageLocationList {
  assertCutsceneLanguage(request.document)
  const current = parseDocument(request.document)
  const target = localOrExternalTarget(current, request.position)
  if (target === undefined) return { locations: [], isIncomplete: false }
  const parsedDocuments = documentsOf(request).map(parseDocument)
  const locations: LanguageLocation[] = []
  if (target.kind === 'file') {
    for (const parsed of parsedDocuments) {
      for (const tag of parsed.scan.startTags) {
        for (const attribute of tag.attributes) {
          if (attribute.name === 'referenceFile' && attribute.value !== undefined && normalizedPath(attribute.value) === normalizedPath(target.value)) {
            locations.push({ uri: parsed.source.uri, range: rangeForAttribute(parsed, attribute) })
          }
        }
      }
    }
  } else {
    for (const owner of guidOwners(current, parsedDocuments, target.referenceFile)) {
      locations.push(
        ...localGuidLocations(owner, target.value, request.includeDeclaration === true),
        ...incomingGuidLocations(parsedDocuments, owner, target.value),
      )
    }
  }
  return boundedLocations(locations, request)
}

/**
 * Every edit a GUID rename needs, or `undefined` when it cannot be made safely: the owner is
 * ambiguous, the identifier is declared other than once, or the new one is already taken there.
 *
 * With an incomplete workspace the host accepts an edit of the primary document only, as for SC2
 * Bank keys. That is sound for a GUID because identifiers are document-scoped — except for
 * includes: when a visible document includes this GUID through `referenceFile`, the rename would
 * knowingly break it, so it is refused instead.
 */
function guidRenameEdits(request: LanguagePositionRequest, newName?: string): readonly LanguageLocation[] | undefined {
  const current = parseDocument(request.document)
  const target = localOrExternalTarget(current, request.position)
  if (target?.kind !== 'guid') return undefined
  const parsedDocuments = documentsOf(request).map(parseDocument)
  const owners = guidOwners(current, parsedDocuments, target.referenceFile)
  const owner = owners[0]
  if (owners.length !== 1 || owner === undefined || guidDeclarations(owner, target.value).length !== 1) return undefined
  if (newName !== undefined && guidDeclarations(owner, newName).length > 0) return undefined
  const edits = [
    ...localGuidLocations(owner, target.value, true),
    ...incomingGuidLocations(parsedDocuments, owner, target.value),
  ]
  if (request.workspaceIncomplete && edits.some(edit => edit.uri !== request.document.uri)) return undefined
  return edits
}

function prepareRenameFor(request: LanguagePositionRequest): LanguageRenamePreparation | undefined {
  assertCutsceneLanguage(request.document)
  const parsed = parseDocument(request.document)
  const target = localOrExternalTarget(parsed, request.position)
  if (target?.kind !== 'guid' || guidRenameEdits(request) === undefined) return undefined
  return { range: rangeForAttribute(parsed, target.attribute), placeholder: target.value }
}

function renameFor(request: LanguageRenameRequest): LanguageWorkspaceEdit | undefined {
  assertCutsceneLanguage(request.document)
  if (!DECIMAL.test(request.newName) || request.newName.length > 64) return undefined
  const edits = guidRenameEdits(request, request.newName)
  if (edits === undefined || edits.length === 0 || edits.length > request.maxEdits) return undefined
  const versions = new Map(documentsOf(request).map(document => [document.uri, document.version]))
  const grouped = new Map<string, { range: LanguageRange; newText: string }[]>()
  for (const edit of edits) {
    const bucket = grouped.get(edit.uri) ?? []
    bucket.push({ range: edit.range, newText: request.newName })
    grouped.set(edit.uri, bucket)
  }
  return {
    documentChanges: [...grouped].map(([uri, changes]) => ({
      uri,
      documentVersion: versions.get(uri) ?? request.document.version,
      edits: changes,
    })),
    isComplete: true,
  }
}

function workspaceValues(
  request: LanguageFeatureRequest,
  attributeName: string,
): readonly string[] {
  const values = new Set<string>()
  for (const document of documentsOf(request)) {
    const parsed = parseDocument(document)
    for (const tag of parsed.scan.startTags) {
      for (const attribute of tag.attributes) {
        if (attribute.name === attributeName && attribute.value !== undefined && attribute.value !== '') values.add(attribute.value)
      }
    }
  }
  if (attributeName === 'referenceFile') {
    for (const document of documentsOf(request)) values.add(basename(document.uri))
  }
  return [...values].sort()
}

function completionItemsForValues(
  parsed: ParsedCutscene,
  attribute: XmlAttributeToken,
  offset: number,
  values: readonly string[],
  maxResults: number,
): LanguageCompletionList {
  const from = attribute.valueStart ?? attribute.nameEnd
  const cursor = Math.max(from, Math.min(offset, attribute.valueEnd ?? offset))
  const prefix = parsed.source.text.slice(from, cursor).match(/[A-Za-z0-9_./\\-]*$/u)?.[0] ?? ''
  const start = cursor - prefix.length
  const items = values
    .filter(value => prefix === '' || value.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()))
    .slice(0, MAX_COMPLETION_VALUES)
    .map((value): LanguageCompletionItem => ({
      label: value,
      kind: 'text',
      replacementRange: parsed.index.range(start, cursor),
    }))
  return { items: items.slice(0, maxResults), isIncomplete: items.length > maxResults }
}

function completionFor(request: LanguagePositionRequest): LanguageCompletionList {
  assertCutsceneLanguage(request.document)
  const parsed = parseDocument(request.document)
  const offset = parsed.index.offsetAt(request.position)
  const found = attributeAt(parsed, offset)
  if (found?.attribute.valueStart !== undefined && offset >= found.attribute.valueStart) {
    const name = found.attribute.name
    if (REFERENCE_ATTRIBUTES.includes(name)) {
      // Offer the identifiers of the document the reference resolves in, not of the whole workspace.
      const referenceFile = name === 'referenceGuid' ? includedFile(found.tag) : undefined
      const owners = guidOwners(parsed, referenceFile === undefined ? [] : documentsOf(request).map(parseDocument), referenceFile)
      const guids = new Set(owners.flatMap(owner => owner.scan.startTags.flatMap(tag =>
        tag.attributes.filter(attribute => attribute.name === 'guid' && attribute.value !== undefined).map(attribute => attribute.value!),
      )))
      return completionItemsForValues(parsed, found.attribute, offset, [...guids].sort(), request.maxResults)
    }
    if (name === 'referenceFile') return completionItemsForValues(parsed, found.attribute, offset, workspaceValues(request, 'referenceFile'), request.maxResults)
    if (name === 'propertyName' || name === 'anim' || name === 'animId') return completionItemsForValues(parsed, found.attribute, offset, workspaceValues(request, name), request.maxResults)
    if (name === 'curveInType' || name === 'curveOutType') return completionItemsForValues(parsed, found.attribute, offset, ['0', '2', '3', '4', '5', '6', '7'], request.maxResults)
    if (name === 'enabled' || name === 'looping' || name === 'lockedToEnd' || name === 'alwaysPointUp') return completionItemsForValues(parsed, found.attribute, offset, ['0', '1'], request.maxResults)
    if (name === 'startLinkAttachToPoint' || name === 'endLinkAttachToPoint') return completionItemsForValues(parsed, found.attribute, offset, ['1', '2'], request.maxResults)
    if (name === 'direction') return completionItemsForValues(parsed, found.attribute, offset, ['in', 'out'], request.maxResults)
    return { items: [], isIncomplete: false }
  }

  const open = startTagAt(parsed, offset)
  if (open !== undefined) {
    const before = parsed.source.text.slice(open.tagEnd, Math.min(offset, open.closeStart))
    if (before.trim() === '' || /[ \t\r\n][A-Za-z_:][-A-Za-z0-9_:.]*$/u.test(before)) {
      const used = new Set(open.attributes.map(attribute => attribute.name))
      const prefix = before.match(/[A-Za-z_:][-A-Za-z0-9_:.]*$/u)?.[0]?.toLocaleLowerCase() ?? ''
      const items = candidateAttributes(parsed, open)
        .filter(name => !used.has(name) && (prefix === '' || name.toLocaleLowerCase().startsWith(prefix)))
        .map((name): LanguageCompletionItem => ({
          label: name,
          kind: 'property',
          detail: ATTRIBUTE_DOCS[name],
          insertText: `${name}=""`,
        }))
      return { items: items.slice(0, request.maxResults), isIncomplete: items.length > request.maxResults }
    }
  }

  const lastOpen = parsed.source.text.lastIndexOf('<', offset)
  const lastClose = parsed.source.text.lastIndexOf('>', Math.max(0, offset - 1))
  if (lastOpen > lastClose) {
    const prefix = parsed.source.text.slice(lastOpen + 1, offset)
    if (!prefix.includes('/') && !/\s/u.test(prefix)) {
      const items = [CUTSCENE_ROOT_TAG, ...CUTSCENE_TAGS.filter(item => item.tag !== CUTSCENE_ROOT_TAG).map(item => item.tag)]
        .filter((value, index, all) => all.indexOf(value) === index)
        .filter(value => value.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()))
        .map((label): LanguageCompletionItem => ({ label, kind: 'class', insertText: label }))
      return { items: items.slice(0, request.maxResults), isIncomplete: items.length > request.maxResults }
    }
  }
  return { items: [], isIncomplete: false }
}

function parseColor(value: string): LanguageColor | undefined {
  const parts = value.split(',').map(item => Number(item.trim()))
  if (parts.length !== 3 && parts.length !== 4) return undefined
  if (parts.some(item => !Number.isFinite(item) || item < 0 || item > 1)) return undefined
  return { red: parts[0] ?? 0, green: parts[1] ?? 0, blue: parts[2] ?? 0, alpha: parts[3] ?? 1 }
}

function isColorAttribute(name: string): boolean {
  return /(?:color|diffuse|emissive)$/iu.test(name)
}

function colorPresentationsFor(document: LanguageDocument, color: LanguageColor, range: LanguageRange): LanguageColorPresentationList {
  const index = new LineIndex(document.text)
  // Keep the attribute's own arity: an RGB value must not silently gain an alpha component.
  const current = document.text.slice(index.offsetAt(range.start), index.offsetAt(range.end))
  const channels = current.split(',').length === 3
    ? [color.red, color.green, color.blue]
    : [color.red, color.green, color.blue, color.alpha]
  const label = channels.map(value => Math.max(0, Math.min(1, value)).toFixed(6)).join(',')
  return { presentations: [{ label, textEdit: { range, newText: label } }], isIncomplete: false }
}

export function createCutsceneLanguageProvider(): LanguageProvider {
  const provider: LanguageProvider = {
    contract: 'common.language/document-analysis',
    languageIds: CUTSCENE_LANGUAGE_IDS,

    async analyze(request: LanguageAnalysisRequest): Promise<LanguageAnalysis> {
      assertCutsceneLanguage(request.document)
      request.signal?.throwIfAborted()
      const parsed = parseDocument(request.document)
      const include = request.include
      const diagnostics = include?.diagnostics === false ? [] : diagnosticsFor(parsed)
      const symbols = include?.symbols === false ? [] : symbolsFor(parsed, 100_000)
      request.signal?.throwIfAborted()
      return {
        documentUri: request.document.uri,
        documentVersion: request.document.version,
        tokens: include?.tokens === false ? [] : parsed.scan.tokens,
        diagnostics,
        symbols,
      }
    },

    async diagnostics(request: LanguageFeatureRequest): Promise<LanguageDiagnosticList> {
      assertCutsceneLanguage(request.document)
      const all = diagnosticsFor(parseDocument(request.document))
      const diagnostics = all.slice(0, request.maxResults)
      return { diagnostics, isIncomplete: diagnostics.length < all.length }
    },

    async documentSymbols(request: LanguageFeatureRequest): Promise<LanguageDocumentSymbolList> {
      assertCutsceneLanguage(request.document)
      const symbols = symbolsFor(parseDocument(request.document), request.maxResults)
      return { symbols, isIncomplete: false }
    },

    async workspaceSymbols(request: LanguageWorkspaceSymbolsRequest): Promise<LanguageWorkspaceSymbolList> {
      assertCutsceneLanguage(request.document)
      const query = request.query.trim().toLocaleLowerCase()
      const all = []
      for (const document of documentsOf(request)) {
        const parsed = parseDocument(document)
        for (const { symbol, containerName } of flattenSymbols(symbolsFor(parsed, 100_000))) {
          if (query !== '' && !symbol.name.toLocaleLowerCase().includes(query)) continue
          all.push({
            name: symbol.name,
            kind: symbol.kind,
            location: { uri: document.uri, range: symbol.selectionRange },
            ...(containerName === undefined ? {} : { containerName }),
            ...(symbol.detail === undefined ? {} : { detail: symbol.detail }),
          })
        }
      }
      all.sort((left, right) => left.name.localeCompare(right.name) || left.location.uri.localeCompare(right.location.uri))
      const symbols = all.slice(0, request.maxResults)
      return { symbols, isIncomplete: symbols.length < all.length || request.workspaceIncomplete }
    },

    async completion(request: LanguagePositionRequest): Promise<LanguageCompletionList> {
      return completionFor(request)
    },

    async hover(request: LanguagePositionRequest): Promise<LanguageHover | undefined> {
      assertCutsceneLanguage(request.document)
      return hoverFor(parseDocument(request.document), request.position)
    },

    async definition(request: LanguagePositionRequest): Promise<LanguageLocationList> {
      return definitionFor(request)
    },

    async references(request: LanguageReferencesRequest): Promise<LanguageLocationList> {
      return referencesFor(request)
    },

    async prepareRename(request: LanguagePositionRequest): Promise<LanguageRenamePreparation | undefined> {
      return prepareRenameFor(request)
    },

    async rename(request: LanguageRenameRequest): Promise<LanguageWorkspaceEdit | undefined> {
      return renameFor(request)
    },

    async formatting(request: LanguageFormattingRequest) {
      assertCutsceneLanguage(request.document)
      // Indentation is part of the lossless representation; only the final newline may change.
      return finalNewlineFormatting(request)
    },

    async documentColors(request: LanguageFeatureRequest) {
      assertCutsceneLanguage(request.document)
      const parsed = parseDocument(request.document)
      const colors = []
      for (const tag of parsed.scan.startTags) {
        for (const attribute of tag.attributes) {
          if (!isColorAttribute(attribute.name) || attribute.valueStart === undefined || attribute.valueEnd === undefined || attribute.value === undefined) continue
          const color = parseColor(attribute.value)
          if (color === undefined) continue
          colors.push({ range: rangeForAttribute(parsed, attribute), color })
        }
      }
      const items = colors.slice(0, request.maxResults)
      return { colors: items, isIncomplete: items.length < colors.length }
    },

    async colorPresentations(request) {
      assertCutsceneLanguage(request.document)
      return colorPresentationsFor(request.document, request.color, request.range)
    },

    async signatureHelp(_request): Promise<LanguageSignatureHelp | undefined> {
      // Cutscene XML has no callable syntax. The method is intentionally present so the provider
      // surface is explicit, while the LSP adapter does not advertise an inapplicable capability.
      return undefined
    },

    async codeActions(request: LanguageCodeActionsRequest) {
      assertCutsceneLanguage(request.document)
      return finalNewlineCodeActions(request)
    },
  }
  return Object.freeze(provider)
}

export const cutsceneLanguageProvider = createCutsceneLanguageProvider()
