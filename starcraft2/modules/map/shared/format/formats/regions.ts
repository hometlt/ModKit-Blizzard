/**
 * Parser and writer for the `Regions` file (also `mapRegions`) embedded in
 * `.SC2Map` archives. Format: XML root `<Regions>`.
 *
 * Contains named trigger regions — circles, rectangles, and diamonds.
 *
 * Browser-safe: pure regex / string scanning, zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CircleShape {
  type: 'circle'
  center: string   // "x,y"
  radius: string   // float string
}

export interface RectShape {
  type: 'rect'
  min?: string     // "x,y" top-left
  max?: string     // "x,y" bottom-right
  /** Any other child element values captured from the shape body. */
  extra: Record<string, string>
}

export interface DiamondShape {
  type: 'diamond'
  min?: string
  max?: string
  extra: Record<string, string>
}

export interface UnknownShape {
  type: string
  extra: Record<string, string>
}

export type RegionShape = CircleShape | RectShape | DiamondShape | UnknownShape

export interface MapRegion {
  id: number
  name: string
  color?: string
  shapes: RegionShape[]
}

export interface RegionsResult {
  regions: MapRegion[]
  byId: Map<number, MapRegion>
  byName: Map<string, MapRegion>
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function xmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function parseAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /\b(\w+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrStr)) !== null) {
    out[m[1]!] = xmlUnescape(m[2]!)
  }
  return out
}

/**
 * Find the value of a single-attribute child element:
 *   `<tagName value="..."/>`
 */
function childValue(body: string, tagName: string): string | undefined {
  const re = new RegExp(`<${tagName}\\s[^>]*\\bvalue="([^"]*)"`)
  const m = re.exec(body)
  return m ? xmlUnescape(m[1]!) : undefined
}

/**
 * Iterate over `<tagName …>…</tagName>` or `<tagName …/>` blocks in `xml`.
 */
interface Block {
  attrs: Record<string, string>
  body: string
}

function* scanBlocks(xml: string, tagName: string): Generator<Block> {
  // Non-greedy [^>]*? prevents '/' in '/>' being consumed by the attribute class.
  const openPat = new RegExp(`<${tagName}((?:\\s[^>]*?)?)(/?)>`, 'g')
  let m: RegExpExecArray | null
  while ((m = openPat.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1] ?? '')
    if (m[2] === '/') {
      yield { attrs, body: '' }
    } else {
      const closeTag = `</${tagName}>`
      const bodyStart = m.index + m[0].length
      const bodyEnd = xml.indexOf(closeTag, bodyStart)
      if (bodyEnd === -1) continue
      yield { attrs, body: xml.slice(bodyStart, bodyEnd) }
      openPat.lastIndex = bodyEnd + closeTag.length
    }
  }
}

// ---------------------------------------------------------------------------
// Shape parsing
// ---------------------------------------------------------------------------

function parseShape(shapeAttrs: Record<string, string>, body: string): RegionShape {
  const type = shapeAttrs['type'] ?? 'unknown'

  if (type === 'circle') {
    return {
      type: 'circle',
      center: childValue(body, 'center') ?? '0,0',
      radius: childValue(body, 'radius') ?? '0',
    }
  }

  if (type === 'rect' || type === 'diamond') {
    const extra: Record<string, string> = {}
    // capture any child elements as key→value
    const childRe = /<(\w+)\s[^>]*\bvalue="([^"]*)"\s*\/>/g
    let cm: RegExpExecArray | null
    const knownChildren = new Set(['min', 'max'])
    while ((cm = childRe.exec(body)) !== null) {
      if (!knownChildren.has(cm[1]!)) extra[cm[1]!] = xmlUnescape(cm[2]!)
    }
    const shape: RectShape | DiamondShape = {
      type: type as 'rect' | 'diamond',
      extra,
    }
    const minVal = childValue(body, 'min')
    const maxVal = childValue(body, 'max')
    if (minVal !== undefined) shape.min = minVal
    if (maxVal !== undefined) shape.max = maxVal
    return shape
  }

  // Unknown shape type: capture all children
  const extra: Record<string, string> = {}
  const childRe = /<(\w+)\s[^>]*\bvalue="([^"]*)"\s*\/>/g
  let cm: RegExpExecArray | null
  while ((cm = childRe.exec(body)) !== null) {
    extra[cm[1]!] = xmlUnescape(cm[2]!)
  }
  return { type, extra }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a `<Regions>` XML string. */
export function readRegions(xml: string): RegionsResult {
  const regions: MapRegion[] = []
  const byId = new Map<number, MapRegion>()
  const byName = new Map<string, MapRegion>()

  for (const regionBlock of scanBlocks(xml, 'region')) {
    const id = Number(regionBlock.attrs['id'] ?? 0)
    const name = childValue(regionBlock.body, 'name') ?? ''
    const color = childValue(regionBlock.body, 'color')

    const shapes: RegionShape[] = []
    for (const shapeBlock of scanBlocks(regionBlock.body, 'shape')) {
      shapes.push(parseShape(shapeBlock.attrs, shapeBlock.body))
    }

    const region: MapRegion = { id, name, shapes }
    if (color !== undefined) region.color = color
    regions.push(region)
    byId.set(id, region)
    byName.set(name, region)
  }

  return { regions, byId, byName }
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function writeShape(s: RegionShape): string {
  if (s.type === 'circle') {
    const c = s as CircleShape
    return (
      `        <shape type="circle">` +
      `<center value="${xmlEscape(c.center)}"/>` +
      `<radius value="${xmlEscape(c.radius)}"/>` +
      `</shape>\n`
    )
  }
  if (s.type === 'rect' || s.type === 'diamond') {
    const r = s as RectShape | DiamondShape
    let inner = ''
    if (r.min !== undefined) inner += `<min value="${xmlEscape(r.min)}"/>`
    if (r.max !== undefined) inner += `<max value="${xmlEscape(r.max)}"/>`
    for (const [k, v] of Object.entries(r.extra)) {
      inner += `<${k} value="${xmlEscape(v)}"/>`
    }
    return `        <shape type="${s.type}">${inner}</shape>\n`
  }
  // Unknown
  const u = s as UnknownShape
  let inner = ''
  for (const [k, v] of Object.entries(u.extra)) {
    inner += `<${k} value="${xmlEscape(v)}"/>`
  }
  return `        <shape type="${xmlEscape(u.type)}">${inner}</shape>\n`
}

/** Serialize a `RegionsResult` back to XML. */
export function writeRegions(data: RegionsResult): string {
  let out = `<?xml version="1.0" encoding="utf-8"?>\n<Regions>\n`
  for (const r of data.regions) {
    out += `    <region id="${r.id}">\n`
    out += `        <name value="${xmlEscape(r.name)}"/>\n`
    if (r.color !== undefined) {
      out += `        <color value="${xmlEscape(r.color)}"/>\n`
    }
    for (const s of r.shapes) out += writeShape(s)
    out += `    </region>\n`
  }
  out += `</Regions>\n`
  return out
}
