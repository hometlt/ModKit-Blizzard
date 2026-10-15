/**
 * Reference HTML emitter for a {@link DisplayList}: absolutely-positioned divs
 * on a virtual canvas, one per item in paint order. Self-contained and
 * host-agnostic — the VS Code webview host (L3 step 3) wraps this with a CSP,
 * pan/zoom, the asset request protocol, and click-to-source messaging; it does
 * not reimplement the emit.
 *
 * Assets/strings/styles are referenced by id in the display list; this emitter
 * renders what it can without resolving them (tints, boxes, raw text) and
 * leaves `data-asset` / `data-style` hooks for the host to fill in (L4/L5).
 */

import type { DisplayItem, DisplayList } from '../model/display.js'
import { toCssRgba } from '../model/color.js'

export interface EmitHtmlOptions {
  /** Wrap in a full document (default true). When false, only the canvas markup. */
  document?: boolean
  title?: string
  /** Outline every frame box for debugging (default false). */
  debugOutline?: boolean
}

export function emitHtml(list: DisplayList, options: EmitHtmlOptions = {}): string {
  const canvas =
    `<div class="lr-canvas" style="width:${list.canvas.width}px;height:${list.canvas.height}px">` +
    list.items.map(it => emitItem(it, options)).join('') +
    `</div>`

  if (options.document === false) return canvas

  const title = esc(options.title ?? 'Layout Preview')
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>` +
    `<style>${STYLE}${options.debugOutline ? DEBUG_STYLE : ''}</style></head>` +
    `<body><div class="lr-viewport">${canvas}</div></body></html>`
  )
}

function emitItem(item: DisplayItem, options: EmitHtmlOptions): string {
  const { rect } = item
  const style: string[] = [
    `left:${round(rect.x)}px`,
    `top:${round(rect.y)}px`,
    `width:${round(rect.width)}px`,
    `height:${round(rect.height)}px`,
  ]
  if (item.opacity !== 1) style.push(`opacity:${round(item.opacity)}`)
  if (!item.visible) style.push('display:none')

  const attrs: string[] = [
    `class="lr-item lr-${item.kind}"`,
    `data-desc-path="${esc(item.descPath.join('/'))}"`,
    `data-frame-type="${esc(item.frameType)}"`,
  ]
  if (item.source)
    attrs.push(`data-src="${esc(item.source.uri)}#${item.source.start}-${item.source.end}"`)
  if (item.tooltip) attrs.push(`title="${esc(item.tooltip)}"`)
  if (item.diagnostics.length)
    attrs.push(`data-diag="${esc(item.diagnostics.map(d => d.code).join(','))}"`)

  let inner = ''
  switch (item.kind) {
    case 'image':
      if (item.asset) attrs.push(`data-asset="${esc(item.asset.kind)}:${esc(item.asset.value)}"`)
      // `LayerColor` is a MULTIPLY over the texture when the image has one, and only the
      // fill when it has none (the tech-tree connector lines are exactly that: LayerColor
      // + a 2px size and no Texture). Painting it as a background colour under a texture
      // too fills the texture's transparent margins — every arrow gained a solid
      // rectangle behind it. The host bakes the multiply when it resolves the pixels.
      if (item.tint && !item.asset) style.push(`background-color:${toCssRgba(item.tint)}`)
      if (item.desaturated) style.push('filter:saturate(0)')
      break
    case 'text':
      if (item.styleRef) attrs.push(`data-style="${esc(item.styleRef)}"`)
      inner = esc(item.text ?? '')
      break
    case 'box':
      if (item.background) style.push(`background-color:${toCssRgba(item.background)}`)
      break
  }

  return `<div ${attrs.join(' ')} style="${style.join(';')}">${inner}</div>`
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0d12}
.lr-viewport{position:relative;overflow:auto}
.lr-canvas{position:relative;transform-origin:0 0}
.lr-item{position:absolute;overflow:hidden}
.lr-text{color:#d6dae3;font:13px/1.2 ui-sans-serif,system-ui,sans-serif;display:flex;align-items:center;white-space:pre}
`

const DEBUG_STYLE = `
.lr-box{outline:1px solid rgba(120,160,255,.35)}
.lr-image{outline:1px solid rgba(230,180,80,.35)}
.lr-text{outline:1px solid rgba(120,220,150,.35)}
`
