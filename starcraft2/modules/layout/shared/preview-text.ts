/**
 * The words a layout preview draws, in the colours the mod's style sheet gives them.
 *
 * A frame writes `<Text val="@UI/Key"/>` and `<Style val="@StandardLabel"/>`; neither means
 * anything to a viewer. This resolves both against exactly the documents the host put in the
 * snapshot — GameStrings for the key, FontStyles for the style — and hands back runs a generic
 * template viewer can draw. Nothing is fetched: a key or style the snapshot does not hold stays as
 * written, which is what the preview then shows.
 */
import {
  createTextStyleSheet,
  mergeTextStyleSheetsInto,
  parseFontStyles,
  resolveTextConstant,
  resolveTextStyle,
} from '../../style/shared/font-styles.js'
import {
  resolveStringValue,
  type ResolvedSegment,
  type TextStyleInfo,
} from '../../strings/shared/core/resolve.js'
import { catalogResolverFromSnapshot } from '../../../shared/language/catalog-resolver.js'
import { parseColor } from './format/rendering/model/color.js'

export interface PreviewTextRun {
  readonly text: string
  readonly color?: string
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly size?: number
  /** An inline image, by the path the markup names; such a run has empty `text`. */
  readonly asset?: string
  /** Why this run shows `text` in place of a value the resolver could not supply. */
  readonly unresolved?: string
}

export interface PreviewText {
  /** The string the key names, when the snapshot holds it. */
  readonly resolved?: string
  readonly runs: readonly PreviewTextRun[]
}

type Look = Omit<PreviewTextRun, 'text' | 'asset' | 'unresolved'>

/** What a host snapshot document presents. */
export interface WorkspaceDocumentLike {
  readonly uri: string
  readonly languageId: string
  readonly text: string
}

const STYLE_DOCUMENT = /\.sc2style$/iu
const STRINGS_DOCUMENT = /\.txt$/iu

export const isStyleDocument = (document: WorkspaceDocumentLike): boolean =>
  document.languageId === 'sc2-style' || STYLE_DOCUMENT.test(document.uri)

export const isStringsDocument = (document: WorkspaceDocumentLike): boolean =>
  document.languageId === 'sc2-strings' || STRINGS_DOCUMENT.test(document.uri)

/** `#rrggbb` (`#rrggbbaa` when translucent): the one spelling a card and a table draw (ui text-runs). */
function cssColor(raw: string | undefined): string | undefined {
  const color = parseColor(raw)
  if (color === undefined) return undefined
  const hex = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}${color.a < 1 ? hex(color.a * 255) : ''}`
}

function attribute(attrs: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  return Object.entries(attrs).find(([key]) => key.toLowerCase() === wanted)?.[1]
}

function withStyle(base: Look, style: TextStyleInfo | undefined): Look {
  if (style === undefined) return base
  const flags = new Set(
    (attribute(style.attrs, 'styleflags') ?? '')
      .split('|')
      .map(flag => flag.trim().toLowerCase())
      .filter(Boolean),
  )
  const color = cssColor(attribute(style.attrs, 'textcolor'))
  const size = Number.parseFloat(attribute(style.attrs, 'height') ?? '')
  return {
    ...base,
    ...(color === undefined ? {} : { color }),
    ...(flags.has('bold') ? { bold: true } : {}),
    ...(flags.has('italic') ? { italic: true } : {}),
    ...(flags.has('underline') ? { underline: true } : {}),
    ...(Number.isFinite(size) && size > 0 ? { size } : {}),
  }
}

function collectRuns(
  segments: readonly ResolvedSegment[],
  look: Look,
  out: PreviewTextRun[],
): void {
  const push = (text: string) => {
    if (text === '') return
    const previous = out.at(-1)
    const same =
      previous !== undefined &&
      previous.asset === undefined &&
      previous.unresolved === undefined &&
      previous.color === look.color &&
      previous.bold === look.bold &&
      previous.italic === look.italic &&
      previous.underline === look.underline &&
      previous.size === look.size
    if (same) out[out.length - 1] = { ...previous, text: previous.text + text }
    else out.push({ text, ...look })
  }
  for (const segment of segments) {
    switch (segment.kind) {
      case 'newline':
        push('\n')
        break
      case 'color': {
        const color = cssColor(segment.color)
        collectRuns(segment.children, color === undefined ? look : { ...look, color }, out)
        break
      }
      case 'style':
        collectRuns(segment.children, withStyle(look, segment.textStyle), out)
        break
      case 'list':
      case 'container':
        collectRuns(segment.children, look, out)
        break
      case 'img':
        out.push({ text: '', asset: segment.path })
        break
      case 'unknown':
        break
      default:
        if ('error' in segment && segment.error !== undefined) {
          out.push({ text: segment.text, ...look, unresolved: segment.error })
        } else push(segment.text)
    }
  }
}

/** Resolved string markup as drawable runs, starting from a text style when one applies. */
export function textRunsOf(
  segments: readonly ResolvedSegment[],
  style?: TextStyleInfo,
): PreviewTextRun[] {
  const runs: PreviewTextRun[] = []
  collectRuns(segments, withStyle({}, style), runs)
  return runs
}

/** A resolver over one snapshot; build it once per preview, call it per frame. */
export function createPreviewTextResolver(documents: readonly WorkspaceDocumentLike[]) {
  const sheet = createTextStyleSheet()
  for (const document of documents.filter(isStyleDocument)) {
    mergeTextStyleSheetsInto(sheet, parseFontStyles(document.text))
  }
  // `Key=Value` per line; catalog-free on purpose, a layout preview needs no GameData schema.
  const localizedStrings = documents.filter(isStringsDocument).flatMap(document =>
    document.text.split(/\r?\n/u).flatMap(line => {
      const separator = line.indexOf('=')
      return separator <= 0
        ? []
        : [
            {
              key: line.slice(0, separator).trim(),
              value: line.slice(separator + 1),
              resolvedLocale: 'workspace',
            },
          ]
    }),
  )
  const resolver = {
    ...catalogResolverFromSnapshot({ localizedStrings }).resolver,
    getTextConstant: (name: string) => resolveTextConstant(sheet, name),
    getTextStyle: (name: string) => resolveTextStyle(sheet, name),
  }
  return (text: string | undefined, style: string | undefined): PreviewText => {
    const named = style === undefined ? undefined : style.replace(/^[@#]+/u, '')
    const base = withStyle({}, named === undefined ? undefined : resolver.getTextStyle(named))
    if (text === undefined) return { runs: [] }
    const key = text.startsWith('@') ? text.replace(/^@+/u, '') : undefined
    const value = key === undefined ? text : resolver.getString?.(key)
    const runs: PreviewTextRun[] = []
    collectRuns(resolveStringValue(value ?? text, resolver).segments, base, runs)
    return { ...(value === undefined || key === undefined ? {} : { resolved: value }), runs }
  }
}
