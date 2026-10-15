import { scanGalaxySource } from '@modkit/blizzard-starcraft2/galaxy/analysis/runtime-summary.js'

export function plausibleGalaxy(text) {
  const source = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '')
  return /\b(?:include\s+"[^"]+"|(?:void|bool|byte|char|fixed|int|string|text|unit|[A-Za-z_]\w*)\s+[A-Za-z_]\w*\s*\([^;{}]*\)\s*\{)/u.test(
    source,
  )
}

export function scanGalaxy(text, budget) {
  return scanGalaxySource(text, budget)
}
