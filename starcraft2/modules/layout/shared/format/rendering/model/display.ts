/**
 * Display list: the renderer-agnostic intermediate representation between the
 * solved frame tree and any output target (HTML, static export, canvas). It is
 * a flat, **back-to-front paint-ordered** array of items so emitters render in
 * array order without computing z-index.
 *
 * Design contract (the reason this layer exists):
 *  - **Assets and strings are referenced by logical id, never resolved bytes.**
 *    L4 (textures) and L5 (text/styles) become "resolve the ids the display
 *    list already emitted"; the model has no filesystem/CASC dependency.
 *  - Every item carries `descPath` + `source` so the editor (L7) hit-tests
 *    back to XML, and `diagnostics` so the preview badges gaps (spec §6).
 *  - Pure and serialisable — the whole list can cross the webview boundary.
 */

import type { Rect } from '../solve/rect.js'
import type { SourceRef } from '../resolve/types.js'
import type { Rgba } from './color.js'

export type DisplayItemKind = 'box' | 'image' | 'text'

/** A texture reference the host resolves (literal `Assets/…` path or `@…` alias). */
export interface AssetRef {
  kind: 'literal' | 'alias'
  /** The value as written (alias including its `@`/`@@` prefix stripped by the parser). */
  value: string
}

export interface DisplayDiagnostic {
  code: string
  message: string
}

export interface DisplayItemBase {
  kind: DisplayItemKind
  /** SC2 frame type (e.g. `Image`, `Label`, `CommandButton`). */
  frameType: string
  /** Frame-name path from the render root — `data-desc-path` / click-to-source key. */
  descPath: string[]
  /** Editable declaration range of the frame (uri + XML offsets), when known. */
  source?: SourceRef
  rect: Rect
  /** Effective visibility (own `Visible` AND all ancestors'); hidden items may still be emitted dimmed. */
  visible: boolean
  /** From `Alpha` (0–1), default 1. */
  opacity: number
  /** Computed tooltip text (bindings/strings resolved by the expression stage), if any. */
  tooltip?: string
  diagnostics: DisplayDiagnostic[]
}

export interface BoxItem extends DisplayItemBase {
  kind: 'box'
  /** From `Color` (solid background), if any. */
  background?: Rgba
}

export interface ImageItem extends DisplayItemBase {
  kind: 'image'
  /** Undefined for pure-tint images (e.g. the connector lines: `LayerColor` only). */
  asset?: AssetRef
  /** From `LayerColor` — tint over the texture, or the fill when `asset` is absent. */
  tint?: Rgba
  /** `TextureType`: stretch/tile behaviour. `Border`/`NineSlice` = 9-slice; `Horizontal`/`Vertical` = 3-slice on one axis. */
  textureType?: 'Normal' | 'Tiled' | 'Border' | 'NineSlice' | 'Horizontal' | 'Vertical' | 'None'
  /** `StateCount`: the texture is a vertical N-state atlas; render only state 0 (top 1/N). */
  stateCount?: number
  /** `TextureCoords` "left,top,right,bottom" (0–1) UV sub-rect, when present. */
  uv?: { left: number; top: number; right: number; bottom: number }
  desaturated?: boolean
}

export interface TextItem extends DisplayItemBase {
  kind: 'text'
  /** Raw `Text` value — may be an `@Key` (resolved by the host at L5). */
  text?: string
  /** `Style` value — resolved by the host to font/size/colour/alignment. */
  styleRef?: string
}

export type DisplayItem = BoxItem | ImageItem | TextItem

export interface DisplayList {
  /** Back-to-front paint order. */
  items: DisplayItem[]
  canvas: { width: number; height: number }
  /** Solver-level diagnostics carried through (anchor cycles, unresolved refs). */
  diagnostics: DisplayDiagnostic[]
}
