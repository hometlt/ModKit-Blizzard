/**
 * bytes → `CutsceneDocument`, keeping everything the writer will need to put back.
 *
 * This is a dedicated reader rather than the shared `scanXml`, and the reason is a contract
 * difference rather than a preference. `scanXml` exists to recover from mid-edit markup and it
 * says so: it never throws, it decodes entities into the value it hands back, and it ignores text
 * content entirely. All three are right for an editor and wrong here. A codec whose acceptance
 * gate is a byte-identical round trip has to know the raw spelling of every value, has to keep the
 * `/>`-versus-`</Tag>` choice and the whitespace before it, and has to *refuse* a construct it
 * cannot reproduce instead of dropping it. Silently discarding a comment would turn a defect into
 * a passing test.
 *
 * What it accepts is exactly what the corpus contains, checked over 2233 files: an optional BOM, one
 * XML declaration, then a tree of elements with attributes and no text content, no comments, no
 * CDATA and no processing instructions. Anything else is an error naming the offset.
 */
import { CUTSCENE_ROOT_TAG, SCENE_ROOT_TAG } from './registry.js'
import type { CutsceneAttribute, CutsceneDocument, CutsceneElement } from './model.js'

/*
 * `ignoreBOM` keeps the byte order mark in the decoded string instead of eating it. Four shipped
 * files begin with one — `Zerg09.SC2Cutscene` among them — and a decoder that silently removed it
 * would hand the writer a document three bytes shorter than the one it read, for the life of the
 * codec.
 */
const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

/** Thrown for a document this reader will not claim to understand. Carries where it gave up. */
export class CutsceneParseError extends Error {
  readonly offset: number

  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`)
    this.name = 'CutsceneParseError'
    this.offset = offset
  }
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])

/**
 * `&quot;` and friends back into the characters they stand for.
 *
 * The five named entities and numeric references are all the corpus uses — 347 occurrences, almost
 * all of them quoted speech inside conversation text. An entity this does not recognise is left
 * exactly as written rather than replaced with a guess, and it survives regardless because the raw
 * spelling is what the writer emits.
 */
export function decodeEntities(source: string): string {
  if (!source.includes('&')) return source
  return source.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES.get(body) ?? whole
  })
}

const NAME_START = /[A-Za-z_:]/u
const NAME_PART = /[-A-Za-z0-9_:.]/u
const SPACE = /[ \t\r\n]/u

class Reader {
  private at = 0

  constructor(private readonly text: string) {}

  get offset(): number {
    return this.at
  }

  atEnd(): boolean {
    return this.at >= this.text.length
  }

  peek(count = 1): string {
    return this.text.slice(this.at, this.at + count)
  }

  take(count: number): string {
    const taken = this.text.slice(this.at, this.at + count)
    this.at += count
    return taken
  }

  expect(literal: string, what: string): void {
    if (this.peek(literal.length) !== literal) throw new CutsceneParseError(`expected ${what}`, this.at)
    this.at += literal.length
  }

  /** Consume whitespace and return exactly what was consumed; the writer needs the spelling. */
  space(): string {
    const start = this.at
    while (this.at < this.text.length && SPACE.test(this.text[this.at] as string)) this.at += 1
    return this.text.slice(start, this.at)
  }

  name(): string {
    const start = this.at
    if (this.atEnd() || !NAME_START.test(this.text[this.at] as string)) {
      throw new CutsceneParseError('expected an element or attribute name', this.at)
    }
    this.at += 1
    while (this.at < this.text.length && NAME_PART.test(this.text[this.at] as string)) this.at += 1
    return this.text.slice(start, this.at)
  }

  until(literal: string, what: string): string {
    const found = this.text.indexOf(literal, this.at)
    if (found < 0) throw new CutsceneParseError(`unterminated ${what}`, this.at)
    const taken = this.text.slice(this.at, found)
    this.at = found + literal.length
    return taken
  }
}

function readAttributes(reader: Reader): { attributes: CutsceneAttribute[]; gap: string } {
  const attributes: CutsceneAttribute[] = []
  let gap = reader.space()
  while (!reader.atEnd() && reader.peek() !== '>' && reader.peek(2) !== '/>') {
    if (gap === '') throw new CutsceneParseError('attributes must be separated by whitespace', reader.offset)
    const name = reader.name()
    reader.expect('=', `'=' after attribute ${name}`)
    const quote = reader.peek()
    if (quote !== '"' && quote !== "'") {
      throw new CutsceneParseError(`attribute ${name} is not quoted`, reader.offset)
    }
    reader.take(1)
    const raw = reader.until(quote, `value of attribute ${name}`)
    if (raw.includes('<')) {
      throw new CutsceneParseError(`attribute ${name} contains an unescaped '<'`, reader.offset)
    }
    attributes.push(Object.freeze({ name, raw, value: decodeEntities(raw), quote, lead: gap }))
    gap = reader.space()
  }
  return { attributes, gap }
}

function readElement(reader: Reader, lead: string): CutsceneElement {
  const start = reader.offset
  reader.expect('<', 'an element')
  if (reader.peek() === '!' || reader.peek() === '?') {
    /*
     * Comments, CDATA and processing instructions do not occur in any of the 2233 measured files,
     * and this reader has nowhere to put one. Refusing is the honest answer: a reader that skipped
     * it would hand the writer a document that cannot reproduce its own bytes, and the round-trip
     * gate — the only real proof the reader kept everything — would pass while being wrong.
     */
    throw new CutsceneParseError('comments, CDATA and processing instructions are not part of this format', start)
  }
  const tag = reader.name()
  const { attributes, gap } = readAttributes(reader)

  if (reader.peek(2) === '/>') {
    reader.take(2)
    return Object.freeze({
      tag,
      attributes: Object.freeze(attributes),
      children: Object.freeze([]),
      selfClosing: true,
      gap,
      lead,
      closeGap: undefined,
      start,
      end: reader.offset,
    })
  }
  reader.expect('>', `'>' closing the <${tag}> open tag`)

  const children: CutsceneElement[] = []
  let closeGap = ''
  for (;;) {
    const between = reader.space()
    if (reader.atEnd()) throw new CutsceneParseError(`<${tag}> is never closed`, reader.offset)
    if (reader.peek(2) === '</') {
      closeGap = between
      reader.take(2)
      const closing = reader.name()
      if (closing !== tag) {
        throw new CutsceneParseError(`</${closing}> closes <${tag}>`, reader.offset)
      }
      reader.space()
      reader.expect('>', `'>' closing </${tag}>`)
      break
    }
    if (reader.peek() !== '<') {
      throw new CutsceneParseError(`text content inside <${tag}>, which this format does not have`, reader.offset)
    }
    children.push(readElement(reader, between))
  }

  return Object.freeze({
    tag,
    attributes: Object.freeze(attributes),
    children: Object.freeze(children),
    selfClosing: false,
    gap,
    lead,
    closeGap,
    start,
    end: reader.offset,
  })
}

/** Recognize CutsceneState or legacy ActorState; the same lossless XML reader owns both. */
export function looksLikeCutscene(text: string): boolean {
  return /^﻿?\s*(?:<\?xml\b[^>]*\?>\s*)?<(?:CutsceneState|ActorState)(?:\s|>|\/)/u.test(text)
}

/** Parse the document text. Throws `CutsceneParseError` on anything it cannot reproduce. */
export function decodeCutsceneText(text: string): CutsceneDocument {
  const byteOrderMark = text.startsWith('﻿')
  const body = byteOrderMark ? text.slice(1) : text
  const reader = new Reader(body)
  reader.space()

  let declaration = ''
  if (reader.peek(5) === '<?xml') {
    const from = reader.offset
    reader.until('?>', 'XML declaration')
    declaration = body.slice(from, reader.offset)
  }
  const beforeRoot = reader.space()

  const root = readElement(reader, beforeRoot)
  if (root.tag !== CUTSCENE_ROOT_TAG && root.tag !== SCENE_ROOT_TAG) {
    throw new CutsceneParseError(`root element is <${root.tag}>, not <${CUTSCENE_ROOT_TAG}>`, root.start)
  }
  reader.space()
  if (!reader.atEnd()) {
    throw new CutsceneParseError('content after the root element', reader.offset)
  }

  const version = root.attributes.find(item => item.name === 'cutsceneVersion')?.value

  return Object.freeze({
    declaration,
    byteOrderMark,
    root,
    version,
    text: body,
  })
}

/** Parse from bytes. UTF-8 is what the declaration says, including the `us-ascii` variant. */
export function decodeCutscene(bytes: Uint8Array): CutsceneDocument {
  return decodeCutsceneText(decoder.decode(bytes))
}
