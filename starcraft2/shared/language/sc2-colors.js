/**
 * SC2 UI colour literals, shared by every authored format that writes them.
 *
 * Layouts and style sheets spell colours the same way and the channel order is not the obvious one:
 * eight hex digits are `AARRGGBB` and four decimals are `A,R,G,B`. Blizzard's own FontStyles proves
 * it — `ColorStoryModePanelLabelDim="807de5e9"` is the half-transparent `ff7de5e9`, and every
 * `Color*Tooltip` constant opens with the same `190`. Two copies of this parser would eventually
 * disagree about that order, and a swatch in the wrong colour is worse than none.
 */

/**
 * @param {string} value
 * @returns {{ color: import('@modkit/sdk/language').LanguageColor, decimal: boolean, includesAlpha: boolean } | undefined}
 */
export function parseColorLiteral(value) {
  const decimal = value.includes(',')
  const parts = decimal ? value.split(',').map(item => item.trim()) : undefined
  let channels
  let includesAlpha = false
  if (parts !== undefined) {
    if (parts.length !== 3 && parts.length !== 4) return undefined
    if (parts.some(item => !/^\d{1,3}$/u.test(item))) return undefined
    const numbers = parts.map(Number)
    if (numbers.some(item => item < 0 || item > 255)) return undefined
    includesAlpha = numbers.length === 4
    channels = includesAlpha
      ? [numbers[1], numbers[2], numbers[3], numbers[0]]
      : [numbers[0], numbers[1], numbers[2], 255]
  } else {
    if (!/^(?:[a-f\d]{6}|[a-f\d]{8})$/iu.test(value)) return undefined
    includesAlpha = value.length === 8
    const offset = includesAlpha ? 2 : 0
    channels = [
      Number.parseInt(value.slice(offset, offset + 2), 16),
      Number.parseInt(value.slice(offset + 2, offset + 4), 16),
      Number.parseInt(value.slice(offset + 4, offset + 6), 16),
      includesAlpha ? Number.parseInt(value.slice(0, 2), 16) : 255,
    ]
  }
  return Object.freeze({
    color: Object.freeze({
      red: channels[0] / 255,
      green: channels[1] / 255,
      blue: channels[2] / 255,
      alpha: channels[3] / 255,
    }),
    decimal,
    includesAlpha,
  })
}

/** @param {number} channel */
function byte(channel) {
  return Math.round(Math.max(0, Math.min(1, channel)) * 255)
}

/**
 * @param {import('@modkit/sdk/language').LanguageColor} color
 * @param {boolean} includeAlpha
 */
export function decimalColor(color, includeAlpha) {
  const rgb = [byte(color.red), byte(color.green), byte(color.blue)]
  return (includeAlpha || color.alpha !== 1 ? [byte(color.alpha), ...rgb] : rgb).join(',')
}

/**
 * @param {import('@modkit/sdk/language').LanguageColor} color
 * @param {boolean} includeAlpha
 */
export function hexColor(color, includeAlpha) {
  /** @param {number} channel */
  const component = channel => byte(channel).toString(16).padStart(2, '0')
  return `${includeAlpha || color.alpha !== 1 ? component(color.alpha) : ''}${component(color.red)}${component(color.green)}${component(color.blue)}`
}
