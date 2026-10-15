import type { SC2LayoutFile, LayoutFrame, LayoutAnchor, LayoutProperty } from './simple-parse/index.js'

export interface LayoutHtmlOptions {
  title?: string
  fileName?: string
  collapsed?: boolean
}

const ASSET_PROPS = new Set([
  'texture', 'file', 'image', 'backgroundimage', 'borderimage', 'hoverimage',
  'normalimage', 'pushedimage', 'disabledimage', 'checkedimage', 'uncheckedimage',
  'alphamask', 'alphalayer', 'iconimage',
])
const SOUND_PROPS = new Set([
  'clicksound', 'mousedownsound', 'mouseentersound', 'mouseexitsound', 'hoversound', 'sound',
])

type RefKind = 'string' | 'asset' | 'style' | 'sound'

function refKind(property: string): RefKind {
  const p = property.toLowerCase()
  if (p === 'style') return 'style'
  if (SOUND_PROPS.has(p) || p.endsWith('sound')) return 'sound'
  if (ASSET_PROPS.has(p) || p.endsWith('image')) return 'asset'
  return 'string'
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isRefValue(v: string): boolean {
  const after = v.startsWith('*') ? v.slice(1) : v
  return after.startsWith('@')
}

/**
 * Render a parsed SC2Layout file to a self-contained HTML document (inline styles,
 * no external assets/scripts) — the frame tree, constants, includes and reference
 * counts. Pure; safe to run anywhere (used by the VS Code layout preview webview).
 */
export function layoutToHtml(file: SC2LayoutFile, options: LayoutHtmlOptions = {}): string {
  const title = options.title ?? options.fileName ?? 'SC2Layout'
  const open = options.collapsed ? '' : ' open'

  const counts = {
    frames: countFrames(file.frames),
    constants: file.constants.length,
    includes: file.includes.length,
    references: file.references.length,
  }

  const parts: string[] = []
  parts.push(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`)
  parts.push(`<meta name="viewport" content="width=device-width, initial-scale=1">`)
  parts.push(`<title>${esc(title)}</title>`)
  parts.push(`<style>${STYLE}</style></head><body>`)

  parts.push(`<header class="lx-head"><h1>${esc(title)}</h1>`)
  if (options.fileName) parts.push(`<div class="lx-file">${esc(options.fileName)}</div>`)
  parts.push(`<div class="lx-counts">`)
  parts.push(stat('frames', counts.frames))
  parts.push(stat('constants', counts.constants))
  parts.push(stat('includes', counts.includes))
  parts.push(stat('references', counts.references))
  parts.push(`</div></header>`)

  if (file.includes.length > 0) {
    parts.push(`<section class="lx-sec"><h2>Includes</h2><ul class="lx-includes">`)
    for (const inc of file.includes) parts.push(`<li>${esc(inc)}</li>`)
    parts.push(`</ul></section>`)
  }

  if (file.constants.length > 0) {
    parts.push(`<section class="lx-sec"><h2>Constants</h2><table class="lx-table"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>`)
    for (const c of file.constants) {
      parts.push(`<tr><td class="lx-k">${esc(c.name)}</td><td class="lx-v">${esc(c.val)}</td></tr>`)
    }
    parts.push(`</tbody></table></section>`)
  }

  parts.push(`<section class="lx-sec"><h2>Frames</h2><div class="lx-tree">`)
  if (file.frames.length === 0) parts.push(`<p class="lx-empty">No frames.</p>`)
  for (const frame of file.frames) parts.push(renderFrame(frame, open))
  parts.push(`</div></section>`)

  parts.push(`</body></html>`)
  return parts.join('')
}

function renderFrame(frame: LayoutFrame, open: string): string {
  const badges: string[] = [`<span class="lx-type">${esc(frame.type)}</span>`]
  if (frame.template) badges.push(`<span class="lx-tmpl" title="template">▸ ${esc(frame.template)}</span>`)
  if (frame.file) badges.push(`<span class="lx-fileref" title="file override">file: ${esc(frame.file)}</span>`)

  const summary = `<summary><span class="lx-name">${esc(frame.name || '(unnamed)')}</span> ${badges.join(' ')}</summary>`

  const body: string[] = []
  if (frame.anchors.length > 0) body.push(renderAnchors(frame.anchors))
  if (frame.properties.length > 0) body.push(renderProps(frame.properties))
  if (frame.animations.length > 0) {
    body.push(`<div class="lx-anims"><span class="lx-lbl">animations:</span> ${frame.animations.map((a: { name: string }) => `<span class="lx-anim">${esc(a.name)}</span>`).join(' ')}</div>`)
  }
  for (const child of frame.children) body.push(renderFrame(child, open))

  return `<details class="lx-frame"${open}>${summary}<div class="lx-body">${body.join('')}</div></details>`
}

function renderAnchors(anchors: LayoutAnchor[]): string {
  const rows = anchors.map(a => {
    const side = a.side ?? 'All'
    const rel = a.relative ?? '—'
    const pos = a.pos ?? '—'
    const off = a.offset ?? '0'
    return `<tr><td>${esc(side)}</td><td class="lx-rel">${esc(rel)}</td><td>${esc(pos)}</td><td>${esc(off)}</td></tr>`
  })
  return `<table class="lx-table lx-anchors"><thead><tr><th>side</th><th>relative</th><th>pos</th><th>offset</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
}

function renderProps(props: LayoutProperty[]): string {
  const rows = props.map(p => {
    const val = p.val ?? ''
    const extra = Object.entries(p.attrs).filter(([k]) => k !== 'val')
    const extraStr = extra.length > 0
      ? ` <span class="lx-attrs">${extra.map(([k, v]) => `${esc(k)}=${esc(String(v))}`).join(' ')}</span>`
      : ''
    const valCell = isRefValue(val)
      ? `<span class="lx-ref lx-ref-${refKind(p.name)}">${esc(val)}</span>`
      : esc(val)
    return `<tr><td class="lx-k">${esc(p.name)}</td><td class="lx-v">${valCell}${extraStr}</td></tr>`
  })
  return `<table class="lx-table lx-props"><tbody>${rows.join('')}</tbody></table>`
}

function stat(label: string, n: number): string {
  return `<span class="lx-stat"><b>${n}</b> ${esc(label)}</span>`
}

function countFrames(frames: LayoutFrame[]): number {
  let n = 0
  for (const f of frames) n += 1 + countFrames(f.children)
  return n
}

const STYLE = `
:root{color-scheme:light dark;--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--fg:#d6dae3;--muted:#8b93a3;--accent:#5aa9e6;--type:#c792ea;--ref-string:#7bd88f;--ref-asset:#e6b450;--ref-style:#82aaff;--ref-sound:#f78c6c;}
*{box-sizing:border-box}
body{margin:0;padding:1.2rem;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
h1{font-size:1.1rem;margin:0}
h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:1.4rem 0 .5rem;border-bottom:1px solid var(--line);padding-bottom:.3rem}
.lx-head{border-bottom:1px solid var(--line);padding-bottom:.8rem}
.lx-file{color:var(--muted);margin-top:.2rem}
.lx-counts{display:flex;gap:1rem;margin-top:.6rem;flex-wrap:wrap}
.lx-stat{color:var(--muted)} .lx-stat b{color:var(--accent)}
.lx-sec{max-width:1100px}
.lx-includes{margin:0;padding-left:1.2rem} .lx-includes li{color:var(--accent)}
.lx-table{border-collapse:collapse;width:100%;margin:.3rem 0}
.lx-table th{text-align:left;color:var(--muted);font-weight:600;padding:.15rem .5rem;border-bottom:1px solid var(--line)}
.lx-table td{padding:.12rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
.lx-k{color:var(--accent);white-space:nowrap}
.lx-v{word-break:break-word}
.lx-rel{color:var(--muted)}
.lx-tree{margin-top:.4rem}
.lx-frame{margin:.15rem 0 .15rem .2rem;border-left:1px solid var(--line);padding-left:.6rem}
.lx-frame>summary{cursor:pointer;padding:.15rem 0;list-style:none}
.lx-frame>summary::-webkit-details-marker{display:none}
.lx-frame>summary::before{content:"▸";color:var(--muted);display:inline-block;width:1em}
.lx-frame[open]>summary::before{content:"▾"}
.lx-name{color:var(--fg);font-weight:700}
.lx-type{color:var(--type)}
.lx-tmpl{color:var(--muted)} .lx-fileref{color:var(--ref-asset)}
.lx-body{margin:.2rem 0 .4rem 1.1rem}
.lx-attrs{color:var(--muted)}
.lx-anims{margin:.2rem 0} .lx-lbl{color:var(--muted)} .lx-anim{color:var(--ref-sound)}
.lx-empty{color:var(--muted)}
.lx-ref{padding:0 .2em;border-radius:3px;background:rgba(255,255,255,.05)}
.lx-ref-string{color:var(--ref-string)} .lx-ref-asset{color:var(--ref-asset)}
.lx-ref-style{color:var(--ref-style)} .lx-ref-sound{color:var(--ref-sound)}
.lx-props .lx-k{font-weight:400}
`
