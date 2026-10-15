/**
 * Warcraft III trigger strings (`war3map.wts`, `.wts`): numbered texts a map's script, info and
 * object data name as `TRIGSTR_<n>`.
 *
 *   STRING 12
 *   // optional comment lines (the World Editor writes what the string belongs to)
 *   {
 *   The text, over any number of lines, with |cAARRGGBB colour, |r reset and |n newline codes.
 *   }
 */

export interface WtsSpan {
  readonly start: number
  readonly end: number
}

export interface WtsEntry extends WtsSpan {
  readonly id: number
  /** The `STRING <n>` line, and the number in it. */
  readonly header: WtsSpan
  readonly idSpan: WtsSpan
  /** The `//` lines between the header and the opening brace, without their slashes. */
  readonly comment: string
  /** The text between the brace lines, line breaks as written. */
  readonly text: string
  readonly textSpan: WtsSpan
}

export interface WtsError extends WtsSpan {
  readonly message: string
  readonly code: 'wts/syntax' | 'wts/duplicate'
}

export interface WtsFile {
  readonly entries: readonly WtsEntry[]
  readonly errors: readonly WtsError[]
}

/** `TRIGSTR_<n>` as the script and the map files write it (any number of leading zeros). */
export const TRIGSTR = /TRIGSTR_(\d+)/gu

export function parseWts(text: string): WtsFile {
  const lines: { text: string; start: number; end: number }[] = []
  for (let start = 0; start <= text.length; ) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    const raw = text.slice(start, end)
    lines.push({ text: raw.replace(/\r$/u, '').replace(/^﻿/u, ''), start, end: start + raw.replace(/\r$/u, '').length })
    start = end + 1
    if (end === text.length) break
  }
  const entries: WtsEntry[] = []
  const errors: WtsError[] = []
  const seen = new Map<number, WtsEntry>()
  let at = 0
  const error = (line: { start: number; end: number }, message: string) =>
    errors.push({ start: line.start, end: Math.max(line.end, line.start + 1), message, code: 'wts/syntax' })
  while (at < lines.length) {
    const line = lines[at]!
    const trimmed = line.text.trim()
    if (trimmed === '' || trimmed.startsWith('//')) {
      at += 1
      continue
    }
    const header = /^(\s*STRING\s+)(\d+)\s*$/u.exec(line.text)
    if (header === null) {
      error(line, `expected «STRING <number>», found «${trimmed.slice(0, 40)}»`)
      at += 1
      continue
    }
    const idStart = line.start + header[1]!.length
    const comments: string[] = []
    at += 1
    while (at < lines.length && lines[at]!.text.trim().startsWith('//')) {
      comments.push(lines[at]!.text.trim().replace(/^\/\/+\s?/u, ''))
      at += 1
    }
    const open = lines[at]
    if (open === undefined) {
      error(line, `STRING ${header[2]!} has no text`)
      break
    }
    // Without braces the text runs to the next blank line or header — a shipped campaign map
    // (OrcX01, Russian 1.24e) writes one entry so.
    const braced = open.text.trim() === '{'
    if (braced) at += 1
    const first = at
    const ends = (text: string) =>
      braced ? text.trim() === '}' : text.trim() === '' || /^\s*STRING\s+\d+\s*$/u.test(text)
    while (at < lines.length && !ends(lines[at]!.text)) at += 1
    const close = braced ? lines[at] : (lines[at - 1] ?? open)
    if (close === undefined) {
      error(open, `STRING ${header[2]!} has no closing «}» line`)
      break
    }
    const textStart = lines[first]?.start ?? close.start
    const textEnd = first < at ? lines[at - 1]!.end : textStart
    const entry: WtsEntry = {
      id: Number(header[2]),
      header: { start: line.start, end: line.end },
      idSpan: { start: idStart, end: idStart + header[2]!.length },
      comment: comments.join('\n'),
      text: lines
        .slice(first, at)
        .map(item => item.text)
        .join('\n'),
      textSpan: { start: textStart, end: textEnd },
      start: line.start,
      end: close.end,
    }
    const earlier = seen.get(entry.id)
    if (earlier === undefined) seen.set(entry.id, entry)
    else
      errors.push({
        ...entry.idSpan,
        message: `STRING ${String(entry.id)} is defined twice`,
        code: 'wts/duplicate',
      })
    entries.push(entry)
    // Past the closing brace; a bare entry already stopped before the next line to read.
    if (braced) at += 1
  }
  return { entries, errors }
}
