/**
 * Build a paint-ordered {@link DisplayList} from a resolved frame tree and its
 * solved rects. Frame-type → item-kind mapping and z-order/visibility follow
 * `docs/tasks-active/layout-rendering/SPEC_VISUAL_MAPPING.md` §2/§5.
 *
 * Paint order = pre-order DFS with siblings sorted by `RenderPriority` (higher
 * paints later/on-top, ties keep declaration order); pre-order gives
 * parent-before-child. Asset/string/style values are emitted as ids — the
 * host resolves them (L4/L5).
 */

import type { ResolvedFrame } from '../resolve/types.js'
import type { SolveResult, SolveDiagnostic } from '../solve/solver.js'
import type { Rect } from '../solve/rect.js'
import { parseColor } from './color.js'
import type {
  AssetRef, DisplayDiagnostic, DisplayItem, DisplayItemKind, ImageItem, TextItem, BoxItem, DisplayList,
} from './display.js'

export interface BuildDisplayOptions {
  /** Include frames whose effective visibility is false (dimmed), instead of skipping them. */
  includeHidden?: boolean
  /**
   * Resolve `#`-constants in colour/alpha/priority values. Default: identity
   * (already-literal values only). Wire to `resolvePropertyValue` for constants.
   */
  resolveValue?: (raw: string) => string | undefined
  /**
   * Computed text/tooltip per frame from `evaluateExpressions` (bindings +
   * TextFormatFrame `@Text` + string resolution). When present, overrides the
   * raw `Text`/`Tooltip` values on emitted items.
   */
  expressions?: Map<ResolvedFrame, { text?: string; tooltip?: string }>
}

const TEXT_TYPES = new Set(['label', 'editbox', 'textbutton'])
const IMAGE_TYPES = new Set(['image'])

export function buildDisplayList(root: ResolvedFrame, solve: SolveResult, options: BuildDisplayOptions = {}): DisplayList {
  const items: DisplayItem[] = []
  const rootRect = solve.rects.get(root)
  const canvas = { width: rootRect?.width ?? 0, height: rootRect?.height ?? 0 }

  // Root renders regardless of its own Visible (the caller chose it explicitly).
  walk(root, true, true, items, solve, options)

  return { items, canvas, diagnostics: solve.diagnostics.map(toDisplayDiag) }
}

function walk(
  frame: ResolvedFrame,
  parentVisible: boolean,
  isRoot: boolean,
  out: DisplayItem[],
  solve: SolveResult,
  options: BuildDisplayOptions,
): void {
  const ownVisible = isRoot ? true : readVisible(frame)
  const visible = parentVisible && ownVisible
  if (!visible && !options.includeHidden) return

  const rect = solve.rects.get(frame)
  if (rect) out.push(buildItem(frame, rect, visible, solve, options))

  for (const child of sortByPriority(frame.children, options)) {
    walk(child, visible, false, out, solve, options)
  }
}

function buildItem(
  frame: ResolvedFrame,
  rect: Rect,
  visible: boolean,
  solve: SolveResult,
  options: BuildDisplayOptions,
): DisplayItem {
  const kind = itemKind(frame)
  const computed = options.expressions?.get(frame)
  const base = {
    frameType: frame.type,
    descPath: frame.path,
    ...(frame.source !== undefined ? { source: frame.source } : {}),
    rect,
    visible,
    opacity: readAlpha(frame, options),
    ...(computed?.tooltip !== undefined ? { tooltip: computed.tooltip } : {}),
    diagnostics: collectItemDiagnostics(frame, solve),
  }

  if (kind === 'image') return { kind, ...base, ...imageVisuals(frame, options) }
  if (kind === 'text') return { kind, ...base, ...textVisuals(frame, computed) }
  return { kind: 'box', ...base, ...boxVisuals(frame, options) }
}

function itemKind(frame: ResolvedFrame): DisplayItemKind {
  const t = frame.type.toLowerCase()
  if (TEXT_TYPES.has(t) || frame.properties.has('text')) return 'text'
  if (IMAGE_TYPES.has(t) || frame.properties.has('texture') || frame.properties.has('layercolor')) return 'image'
  return 'box'
}

type ImageVisuals = Pick<ImageItem, 'asset' | 'tint' | 'textureType' | 'stateCount' | 'uv' | 'desaturated'>
type TextVisuals = Pick<TextItem, 'text' | 'styleRef'>
type BoxVisuals = Pick<BoxItem, 'background'>

function imageVisuals(frame: ResolvedFrame, options: BuildDisplayOptions): ImageVisuals {
  const out: ImageVisuals = {}
  const texture = frame.properties.get('texture')?.val
  const asset = texture !== undefined ? assetRef(texture) : undefined
  if (asset) out.asset = asset
  const tint = parseColor(resolve(frame.properties.get('layercolor')?.val, options))
  if (tint) out.tint = tint
  const norm = normalizeTextureType(frame.properties.get('texturetype')?.val)
  if (norm) out.textureType = norm
  // `Tiled val="true"` alongside a Border texture keeps the 9-slice; a bare
  // Tiled flag with no explicit TextureType means repeat.
  if (!norm && isTrue(frame.properties.get('tiled')?.val)) out.textureType = 'Tiled'
  const sc = Number.parseInt(frame.properties.get('statecount')?.val ?? '', 10)
  if (Number.isFinite(sc) && sc > 1) out.stateCount = sc
  const uv = parseCoords(frame.properties.get('texturecoords')?.val)
  if (uv) out.uv = uv
  if (isTrue(frame.properties.get('desaturated')?.val)) out.desaturated = true
  return out
}

function parseCoords(raw: string | undefined): ImageItem['uv'] | undefined {
  if (!raw) return undefined
  const p = raw.split(',').map((s) => Number.parseFloat(s.trim()))
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return undefined
  return { left: p[0]!, top: p[1]!, right: p[2]!, bottom: p[3]! }
}

function textVisuals(frame: ResolvedFrame, computed?: { text?: string }): TextVisuals {
  const out: TextVisuals = {}
  const text = computed?.text ?? frame.properties.get('text')?.val
  if (text !== undefined) out.text = text
  const style = frame.properties.get('style')?.val
  if (style !== undefined) out.styleRef = style
  return out
}

function boxVisuals(frame: ResolvedFrame, options: BuildDisplayOptions): BoxVisuals {
  const bg = parseColor(resolve(frame.properties.get('color')?.val, options))
  return bg ? { background: bg } : {}
}

function assetRef(raw: string): AssetRef | undefined {
  const value = raw.trim()
  if (value.length === 0) return undefined
  // `@Alias` / `@@Alias` → alias; strip the leading `@`s (and optional `*` ptr).
  const noPtr = value.startsWith('*') ? value.slice(1) : value
  if (noPtr.startsWith('@')) {
    return { kind: 'alias', value: noPtr.replace(/^@+/, '') }
  }
  return { kind: 'literal', value }
}

function normalizeTextureType(tt: string | undefined): ImageItem['textureType'] | undefined {
  if (!tt) return undefined
  switch (tt.toLowerCase()) {
    case 'normal': return 'Normal'
    case 'tiled': return 'Tiled'
    case 'border': return 'Border'
    case 'nineslice': return 'NineSlice'
    case 'horizontal': return 'Horizontal'
    case 'vertical': return 'Vertical'
    case 'none': return 'None'
    default: return undefined
  }
}

function readVisible(frame: ResolvedFrame): boolean {
  const v = frame.properties.get('visible')?.val
  if (v === undefined) return true
  return !isFalse(v)
}

function readAlpha(frame: ResolvedFrame, options: BuildDisplayOptions): number {
  const raw = resolve(frame.properties.get('alpha')?.val, options)
  if (raw === undefined) return 1
  const n = Number.parseFloat(raw)
  if (Number.isNaN(n)) return 1
  // SC2 `Alpha` is a 0–255 byte; accept 0–1 fractions too. [verify]
  const a = n <= 1 ? n : n / 255
  return a < 0 ? 0 : a > 1 ? 1 : a
}

function sortByPriority(children: readonly ResolvedFrame[], options: BuildDisplayOptions): ResolvedFrame[] {
  return children
    .map((frame, i) => ({ frame, i, p: readPriority(frame, options) }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.frame)
}

function readPriority(frame: ResolvedFrame, options: BuildDisplayOptions): number {
  const raw = resolve(frame.properties.get('renderpriority')?.val, options)
  if (raw === undefined) return 0
  const n = Number.parseFloat(raw)
  return Number.isNaN(n) ? 0 : n
}

function collectItemDiagnostics(frame: ResolvedFrame, solve: SolveResult): DisplayDiagnostic[] {
  const out: DisplayDiagnostic[] = frame.diagnostics.map((d) => ({ code: d.code, message: d.message }))
  const p = pathKey(frame.path)
  for (const d of solve.diagnostics) {
    if (pathKey(d.framePath) === p) out.push(toDisplayDiag(d))
  }
  return out
}

function toDisplayDiag(d: SolveDiagnostic): DisplayDiagnostic {
  return { code: d.code, message: d.message }
}

function pathKey(path: readonly string[]): string {
  return path.join('/').toLowerCase()
}

function resolve(raw: string | undefined, options: BuildDisplayOptions): string | undefined {
  if (raw === undefined) return undefined
  if (!options.resolveValue) return raw
  return options.resolveValue(raw) ?? raw
}

function isTrue(v: string | undefined): boolean {
  if (v === undefined) return false
  const s = v.toLowerCase()
  return s === 'true' || s === '1'
}

function isFalse(v: string): boolean {
  const s = v.toLowerCase()
  return s === 'false' || s === '0'
}
