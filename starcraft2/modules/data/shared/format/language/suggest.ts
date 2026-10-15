/**
 * "Did you mean": the names closest to a wrong one, by edit distance ignoring case (parity plan 1.21).
 *
 * A name further than a third of its length from every candidate gets no suggestion — a fix that
 * replaces `Foo` with an unrelated field is worse than none.
 */
export function nearestNames(name: string, candidates: Iterable<string>, limit = 3): string[] {
  const wanted = name.toLowerCase()
  const ceiling = Math.max(1, Math.floor(wanted.length / 3))
  const scored: Array<readonly [number, string]> = []
  for (const candidate of candidates) {
    if (candidate === name) continue
    const score = distance(wanted, candidate.toLowerCase(), ceiling)
    if (score <= ceiling) scored.push([score, candidate])
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
    .slice(0, limit)
    .map(([, candidate]) => candidate)
}

/** Levenshtein distance, or anything above `ceiling` once it is certain to exceed it. */
function distance(a: string, b: string, ceiling: number): number {
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      current.push(value)
      if (value < best) best = value
    }
    if (best > ceiling) return ceiling + 1
    previous = current
  }
  return previous[b.length]!
}
