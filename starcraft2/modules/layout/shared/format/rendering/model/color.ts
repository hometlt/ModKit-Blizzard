/**
 * SC2 layout colour parsing. Values appear as byte lists (`r,g,b` or
 * `a,r,g,b`) or hex (`RRGGBB` / `AARRGGBB`, optional leading `#`). Constants
 * (`#Name` / `##Name`) are resolved upstream before this sees the string.
 * Returns rgb in 0–255 and alpha in 0–1.
 */

export interface Rgba {
  r: number
  g: number
  b: number
  /** 0–1. */
  a: number
}

const clamp255 = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n))

export function parseColor(raw: string | undefined): Rgba | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim()
  if (value.length === 0) return undefined

  if (value.includes(',')) return parseByteList(value)
  return parseHex(value)
}

function parseByteList(value: string): Rgba | undefined {
  const parts = value.split(',').map((p) => Number.parseFloat(p.trim()))
  if (parts.some((n) => Number.isNaN(n))) return undefined
  if (parts.length === 3) {
    return { r: clamp255(parts[0]!), g: clamp255(parts[1]!), b: clamp255(parts[2]!), a: 1 }
  }
  if (parts.length === 4) {
    // SC2 orders the leading channel as alpha: a,r,g,b.
    return { a: clampAlpha(parts[0]!), r: clamp255(parts[1]!), g: clamp255(parts[2]!), b: clamp255(parts[3]!) }
  }
  return undefined
}

function parseHex(value: string): Rgba | undefined {
  const hex = value.startsWith('#') ? value.slice(1) : value
  if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined
  if (hex.length === 6) {
    return { r: byte(hex, 0), g: byte(hex, 2), b: byte(hex, 4), a: 1 }
  }
  if (hex.length === 8) {
    // AARRGGBB
    return { a: byte(hex, 0) / 255, r: byte(hex, 2), g: byte(hex, 4), b: byte(hex, 6) }
  }
  return undefined
}

function byte(hex: string, at: number): number {
  return Number.parseInt(hex.slice(at, at + 2), 16)
}

function clampAlpha(n: number): number {
  // Accept either 0–1 fractions or 0–255 bytes for the alpha channel.
  if (n <= 1) return n < 0 ? 0 : n
  return Math.min(n, 255) / 255
}

/** CSS `rgba()` string for a parsed colour. */
export function toCssRgba(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${round(c.a)})`
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
