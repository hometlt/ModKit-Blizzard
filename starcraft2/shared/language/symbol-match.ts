/**
 * Workspace symbol search as VS Code matches symbols itself: the query's characters in order
 * anywhere in the name, case aside (`mrn` finds `Marine`). One rule for every SC2 language
 * (Layout 3.26, GameData 1.15).
 */
export function fuzzyMatches(name: string, query: string): boolean {
  const wanted = query.toLowerCase()
  let at = 0
  for (const ch of name.toLowerCase()) if (ch === wanted[at]) at += 1
  return at === wanted.length
}
