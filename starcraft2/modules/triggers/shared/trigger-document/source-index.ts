/**
 * Position-preserving companion scanner for Triggers / TriggerLib XML.
 *
 * `sax@1.6` reports `startTagPosition` one UTF-16 code unit after `<` and
 * `position` one code unit after `>`. Those offsets are usable after subtracting
 * one from the start, but `sax-reader.ts` normalises NativeLib's `<Standard/>`
 * form before parsing and therefore shifts every later offset. SAX also counts
 * only LF as a new line, leaving CR in its column count. This scanner reads the
 * original decoded text instead, retains half-open UTF-16/LSP offsets, and
 * computes LF, CRLF, and lone-CR positions without modifying the input.
 *
 * It is intentionally not a second semantic parser. It only indexes stable
 * declaration/reference tokens needed by navigation, diagnostics, and rename.
 */

export interface TriggerSourcePosition {
  line: number
  character: number
}

/** Half-open range into the original, unmodified source text. */
export interface TriggerSourceRange {
  start: TriggerSourcePosition
  end: TriggerSourcePosition
  startOffset: number
  endOffset: number
}

export interface TriggerSourceText {
  value: string
  range: TriggerSourceRange
}

export interface TriggerElementKey {
  library?: string
  type: string
  id: string
}

export interface TriggerLibrarySource {
  syntax: 'Library' | 'Standard'
  id: string
  range: TriggerSourceRange
  idRange: TriggerSourceRange
}

export interface TriggerLibraryReferenceSource {
  kind: 'shared-library'
  sourceLibrary?: string
  targetLibrary: string
  /** Exact target library ID. */
  range: TriggerSourceRange
  tagRange: TriggerSourceRange
  complete: boolean
}

export interface TriggerElementSource {
  library?: string
  type: string
  id: string
  /** Opening `<Element ...>` tag, including `>` when present. */
  range: TriggerSourceRange
  idRange: TriggerSourceRange
  typeRange?: TriggerSourceRange
  /** XML `<Identifier>` value; localized TriggerStrings names stay separate. */
  identifier?: TriggerSourceText
  /** False for an opening declaration retained from an incomplete/mismatched edit. */
  complete: boolean
}

export interface TriggerElementReferenceSource {
  kind: 'element'
  /** XML tag/semantic role; target type alone does not distinguish calls, lists, and metadata. */
  role: string
  source?: TriggerElementKey
  target: TriggerElementKey
  /** Exact target `Id` attribute value. */
  range: TriggerSourceRange
  tagRange: TriggerSourceRange
  typeRange: TriggerSourceRange
  libraryRange?: TriggerSourceRange
  /** Whether the reference opening tag reached its closing `>`. */
  complete: boolean
}

export interface TriggerParamValueSource {
  source: TriggerElementKey
  value?: TriggerSourceText
  valueType?: TriggerSourceText
  gameType?: TriggerSourceText
  complete: boolean
}

export interface TriggerGameLinkSource {
  source: TriggerElementKey
  catalog: string
  entry: string
  /** Exact GameData ID, excluding an abil-command suffix when present. */
  range: TriggerSourceRange
}

export type TriggerStringKeyKind = 'library-name' | 'element-name' | 'param-value'

export interface TriggerStringKeySource {
  kind: TriggerStringKeyKind
  table: 'TriggerStrings' | 'GameStrings'
  key: string
  library?: string
  elementType?: string
  elementId?: string
  /** Source token that determines the generated TriggerStrings key. */
  range: TriggerSourceRange
}

export interface TriggerScriptSource {
  source: TriggerElementKey
  code: string
  /** Exact non-whitespace ScriptCode content in the original XML. */
  range: TriggerSourceRange
  complete: boolean
}

export interface TriggerSourceIndex {
  sourcePath?: string
  libraries: TriggerLibrarySource[]
  libraryReferences: TriggerLibraryReferenceSource[]
  /** Source-order list; valid cross-type and same-type duplicate IDs are retained. */
  elements: TriggerElementSource[]
  references: TriggerElementReferenceSource[]
  paramValues: TriggerParamValueSource[]
  gameLinks: TriggerGameLinkSource[]
  stringKeys: TriggerStringKeySource[]
  scripts: TriggerScriptSource[]
}

export interface ScanTriggerSourceOptions {
  /** Optional archive-relative path retained as document provenance. */
  sourcePath?: string
}

interface AttributeToken {
  name: string
  value: string
  valueStart: number
  valueEnd: number
}

interface TagToken {
  name: string
  nameLower: string
  start: number
  end: number
  closing: boolean
  selfClosing: boolean
  attributes: AttributeToken[]
}

interface PendingElement {
  source: TriggerElementSource
  value?: TriggerSourceText
  valueType?: TriggerSourceText
  gameType?: TriggerSourceText
  openingTagComplete: boolean
  finalized: boolean
}

interface OpenFrame {
  nameLower: string
  contentStart: number
  libraryId?: string
  element?: PendingElement
  owner?: PendingElement
}

function makeLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 13) {
      if (text.charCodeAt(i + 1) === 10) i++
      starts.push(i + 1)
    } else if (code === 10) {
      starts.push(i + 1)
    }
  }
  return starts
}

function positionAt(lineStarts: readonly number[], offset: number): TriggerSourcePosition {
  let low = 0
  let high = lineStarts.length
  while (low + 1 < high) {
    const middle = (low + high) >>> 1
    const middleStart = lineStarts[middle]
    if (middleStart !== undefined && middleStart <= offset) low = middle
    else high = middle
  }
  return { line: low, character: offset - (lineStarts[low] ?? 0) }
}

function sourceRange(
  lineStarts: readonly number[],
  startOffset: number,
  endOffset: number,
): TriggerSourceRange {
  return {
    start: positionAt(lineStarts, startOffset),
    end: positionAt(lineStarts, endOffset),
    startOffset,
    endOffset,
  }
}

function isNameStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_:]/.test(ch)
}

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_.:-]/.test(ch)
}

/** Find a tolerant opening/closing-tag boundary without accepting raw `<` in an attribute. */
function tagEnd(text: string, start: number): number {
  let quote: '"' | "'" | undefined
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '<') return i
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') return i + 1
  }
  return text.length
}

function parseAttributes(text: string, start: number, end: number): AttributeToken[] {
  const out: AttributeToken[] = []
  const contentEnd = text[end - 1] === '>' ? end - 1 : end
  let cursor = start

  while (cursor < contentEnd) {
    while (cursor < contentEnd && /\s|\//.test(text[cursor] ?? '')) cursor++
    if (!isNameStart(text[cursor])) {
      cursor++
      continue
    }

    const nameStart = cursor++
    while (cursor < contentEnd && isNameChar(text[cursor])) cursor++
    const name = text.slice(nameStart, cursor)
    while (cursor < contentEnd && /\s/.test(text[cursor] ?? '')) cursor++
    if (text[cursor] !== '=') continue
    cursor++
    while (cursor < contentEnd && /\s/.test(text[cursor] ?? '')) cursor++

    const quote = text[cursor]
    let valueStart: number
    let valueEnd: number
    if (quote === '"' || quote === "'") {
      valueStart = ++cursor
      while (cursor < contentEnd && text[cursor] !== quote && text[cursor] !== '<') cursor++
      valueEnd = cursor
      if (text[cursor] === quote) cursor++
    } else {
      valueStart = cursor
      while (cursor < contentEnd && !/[\s/>]/.test(text[cursor] ?? '') && text[cursor] !== '<') {
        cursor++
      }
      valueEnd = cursor
    }
    out.push({ name, value: decodeXmlText(text.slice(valueStart, valueEnd)), valueStart, valueEnd })
  }

  return out
}

function readTag(text: string, start: number): TagToken | undefined {
  let cursor = start + 1
  let closing = false
  if (text[cursor] === '/') {
    closing = true
    cursor++
  }
  while (/\s/.test(text[cursor] ?? '')) cursor++
  if (!isNameStart(text[cursor])) return undefined

  const nameStart = cursor++
  while (isNameChar(text[cursor])) cursor++
  const name = text.slice(nameStart, cursor)
  const end = tagEnd(text, cursor)
  const contentEnd = text[end - 1] === '>' ? end - 1 : end
  let tail = contentEnd - 1
  while (tail >= cursor && /\s/.test(text[tail] ?? '')) tail--

  return {
    name,
    nameLower: name.toLowerCase(),
    start,
    end,
    closing,
    selfClosing: !closing && text[tail] === '/',
    attributes: closing ? [] : parseAttributes(text, cursor, end),
  }
}

function attribute(tag: TagToken, name: string): AttributeToken | undefined {
  const lower = name.toLowerCase()
  return tag.attributes.find(candidate => candidate.name.toLowerCase() === lower)
}

function locatedAttribute(
  lineStarts: readonly number[],
  token: AttributeToken,
): TriggerSourceText {
  return {
    value: token.value,
    range: sourceRange(lineStarts, token.valueStart, token.valueEnd),
  }
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|(lt|gt|amp|quot|apos));/gi,
    (whole, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16))
      if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10))
      const entities: Record<string, string> = {
        lt: '<',
        gt: '>',
        amp: '&',
        quot: '"',
        apos: "'",
      }
      return entities[named?.toLowerCase() ?? ''] ?? whole
    },
  )
}

function trimmedContent(text: string, start: number, end: number): { start: number; end: number } {
  while (start < end && /\s/.test(text[start] ?? '')) start++
  while (end > start && /\s/.test(text[end - 1] ?? '')) end--

  if (text.startsWith('<![CDATA[', start) && text.slice(start, end).endsWith(']]>')) {
    start += '<![CDATA['.length
    end -= ']]>'.length
    while (start < end && /\s/.test(text[start] ?? '')) start++
    while (end > start && /\s/.test(text[end - 1] ?? '')) end--
  }
  return { start, end }
}

function elementKey(element: TriggerElementSource): TriggerElementKey {
  return {
    ...(element.library === undefined ? {} : { library: element.library }),
    type: element.type,
    id: element.id,
  }
}

function elementNameKey(element: TriggerElementSource): string {
  return element.library
    ? `${element.type}/Name/lib_${element.library}_${element.id}`
    : `${element.type}/Name/${element.id}`
}

function paramValueKey(element: TriggerElementSource): string {
  return element.library
    ? `Param/Value/lib_${element.library}_${element.id}`
    : `Param/Value/${element.id}`
}

/**
 * Scan declarations and cross-document reference anchors from original Trigger XML.
 * The result is useful even when the document is incomplete and the semantic SAX
 * parser cannot yet produce a `TriggerLibraryJson`.
 */
export function scanTriggerSource(
  text: string,
  options: ScanTriggerSourceOptions = {},
): TriggerSourceIndex {
  const lineStarts = makeLineStarts(text)
  const index: TriggerSourceIndex = {
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
    libraries: [],
    libraryReferences: [],
    elements: [],
    references: [],
    paramValues: [],
    gameLinks: [],
    stringKeys: [],
    scripts: [],
  }
  const stack: OpenFrame[] = []
  let standardLibrary: string | undefined

  const activeLibrary = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const libraryId = stack[i]?.libraryId
      if (libraryId !== undefined) return libraryId
    }
    return standardLibrary
  }

  const activeElement = (): PendingElement | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const element = stack[i]?.element
      if (element !== undefined) return element
    }
    return undefined
  }

  const finishElement = (element: PendingElement, complete: boolean): void => {
    if (element.finalized) return
    element.finalized = true
    element.source.complete = element.openingTagComplete && complete
    const value = element.value
    const valueType = element.valueType?.value.toLowerCase()

    if (element.source.type.toLowerCase() === 'param') {
      index.paramValues.push({
        source: elementKey(element.source),
        ...(value === undefined ? {} : { value }),
        ...(element.valueType === undefined ? {} : { valueType: element.valueType }),
        ...(element.gameType === undefined ? {} : { gameType: element.gameType }),
        complete: element.source.complete,
      })
    }

    if (element.source.type.toLowerCase() === 'param' && valueType === 'text') {
      index.stringKeys.push({
        kind: 'param-value',
        table: 'GameStrings',
        key: paramValueKey(element.source),
        library: element.source.library,
        elementType: element.source.type,
        elementId: element.source.id,
        range: element.source.idRange,
      })
    }

    if (value === undefined) return
    if (valueType === 'gamelink' || valueType === 'anygamelink') {
      index.gameLinks.push({
        source: elementKey(element.source),
        catalog: element.gameType?.value ?? 'unknown',
        entry: value.value,
        range: value.range,
      })
    }
  }

  const finishFrame = (frame: OpenFrame, contentEnd: number, complete: boolean): void => {
    const owner = frame.owner
    if (owner !== undefined) {
      const content = trimmedContent(text, frame.contentStart, contentEnd)
      const value = decodeXmlText(text.slice(content.start, content.end))
      const located: TriggerSourceText = {
        value,
        range: sourceRange(lineStarts, content.start, content.end),
      }
      if (frame.nameLower === 'identifier') owner.source.identifier = located
      else if (frame.nameLower === 'value') owner.value = located
      else if (frame.nameLower === 'scriptcode') {
        index.scripts.push({
          source: elementKey(owner.source),
          code: value,
          range: located.range,
          complete,
        })
      }
    }
    if (frame.element !== undefined) finishElement(frame.element, complete)
  }

  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor)
    if (start < 0) break

    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4)
      cursor = end < 0 ? text.length : end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', start)) {
      const end = text.indexOf(']]>', start + 9)
      cursor = end < 0 ? text.length : end + 3
      continue
    }
    if (text.startsWith('<?', start)) {
      const end = text.indexOf('?>', start + 2)
      cursor = end < 0 ? text.length : end + 2
      continue
    }
    if (text.startsWith('<!', start)) {
      const end = tagEnd(text, start + 2)
      cursor = Math.max(start + 1, end)
      continue
    }

    const tag = readTag(text, start)
    if (tag === undefined) {
      cursor = start + 1
      continue
    }

    if (tag.closing) {
      let match = -1
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]?.nameLower === tag.nameLower) {
          match = i
          break
        }
      }
      if (match >= 0) {
        const nestedFramesWereIncomplete = match !== stack.length - 1
        for (let i = stack.length - 1; i >= match; i--) {
          const frame = stack.pop()
          if (frame !== undefined) {
            finishFrame(frame, tag.start, i === match && !nestedFramesWereIncomplete)
          }
        }
      }
      cursor = Math.max(tag.end, start + 1)
      continue
    }

    const id = attribute(tag, 'Id')
    const type = attribute(tag, 'Type')
    const library = attribute(tag, 'Library')
    const owner = activeElement()
    let element: PendingElement | undefined
    let libraryId: string | undefined

    if ((tag.nameLower === 'library' || tag.nameLower === 'standard') && id !== undefined) {
      const syntax = tag.nameLower === 'library' ? 'Library' : 'Standard'
      index.libraries.push({
        syntax,
        id: id.value,
        range: sourceRange(lineStarts, tag.start, tag.end),
        idRange: sourceRange(lineStarts, id.valueStart, id.valueEnd),
      })
      index.stringKeys.push({
        kind: 'library-name',
        table: 'TriggerStrings',
        key: `Library/Name/${id.value}`,
        library: id.value,
        range: sourceRange(lineStarts, id.valueStart, id.valueEnd),
      })
      if (syntax === 'Standard') standardLibrary = id.value
      else libraryId = id.value
    } else if (tag.nameLower === 'element' && id !== undefined) {
      const elementSource: TriggerElementSource = {
        library: activeLibrary(),
        type: type?.value ?? 'Unknown',
        id: id.value,
        complete: false,
        range: sourceRange(lineStarts, tag.start, tag.end),
        idRange: sourceRange(lineStarts, id.valueStart, id.valueEnd),
        ...(type === undefined
          ? {}
          : { typeRange: sourceRange(lineStarts, type.valueStart, type.valueEnd) }),
      }
      element = {
        source: elementSource,
        openingTagComplete: text[tag.end - 1] === '>',
        finalized: false,
      }
      index.elements.push(elementSource)
      index.stringKeys.push({
        kind: 'element-name',
        table: 'TriggerStrings',
        key: elementNameKey(elementSource),
        library: elementSource.library,
        elementType: elementSource.type,
        elementId: elementSource.id,
        range: elementSource.idRange,
      })
    } else if (tag.nameLower === 'sharedlib' && id !== undefined) {
      index.libraryReferences.push({
        kind: 'shared-library',
        sourceLibrary: activeLibrary(),
        targetLibrary: id.value,
        range: sourceRange(lineStarts, id.valueStart, id.valueEnd),
        tagRange: sourceRange(lineStarts, tag.start, tag.end),
        complete: text[tag.end - 1] === '>',
      })
    } else if (id !== undefined && type !== undefined) {
      const source = owner === undefined ? undefined : elementKey(owner.source)
      const targetLibrary = library?.value ?? activeLibrary()
      index.references.push({
        kind: 'element',
        role: tag.name,
        ...(source === undefined ? {} : { source }),
        target: {
          ...(targetLibrary === undefined ? {} : { library: targetLibrary }),
          type: type.value,
          id: id.value,
        },
        range: sourceRange(lineStarts, id.valueStart, id.valueEnd),
        tagRange: sourceRange(lineStarts, tag.start, tag.end),
        typeRange: sourceRange(lineStarts, type.valueStart, type.valueEnd),
        ...(library === undefined
          ? {}
          : {
              libraryRange: sourceRange(
                lineStarts,
                library.valueStart,
                library.valueEnd,
              ),
            }),
        complete: text[tag.end - 1] === '>',
      })
    }

    if (owner !== undefined) {
      if (tag.nameLower === 'valuetype' && type !== undefined) {
        owner.valueType = locatedAttribute(lineStarts, type)
      } else if (tag.nameLower === 'valuegametype' && type !== undefined) {
        owner.gameType = locatedAttribute(lineStarts, type)
      }
    }

    const textOwner =
      owner !== undefined &&
      (tag.nameLower === 'identifier' ||
        tag.nameLower === 'value' ||
        tag.nameLower === 'scriptcode')
        ? owner
        : undefined

    if (tag.selfClosing) {
      if (element !== undefined) finishElement(element, text[tag.end - 1] === '>')
    } else {
      stack.push({
        nameLower: tag.nameLower,
        contentStart: tag.end,
        ...(libraryId === undefined ? {} : { libraryId }),
        ...(element === undefined ? {} : { element }),
        ...(textOwner === undefined ? {} : { owner: textOwner }),
      })
    }
    cursor = Math.max(tag.end, start + 1)
  }

  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame !== undefined) finishFrame(frame, text.length, false)
  }
  return index
}
