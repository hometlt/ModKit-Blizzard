/**
 * Parser and writer for the `BankList` file embedded in `.SC2Map` archives.
 *
 * Format: simple XML root `<BankList>` with `<Bank>` child elements.
 *
 * ```xml
 * <?xml version="1.0" encoding="utf-8"?>
 * <BankList>
 *     <Bank Name="PArchive" Player="1"/>
 *     <Bank Name="Shared"/>
 * </BankList>
 * ```
 *
 * Each `<Bank>` declares that the map may read or write a `.SC2Bank` file of
 * that name. `Player` is optional (absent → shared bank, no per-player scope).
 *
 * Browser-safe: pure regex / string scanning, zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BankEntry {
  /** Bank file name without extension (e.g. `"PArchive"`). */
  name: string
  /**
   * Optional player slot (1-based).  Absent when the bank is not player-scoped.
   */
  player?: number
  /** Any additional attributes for round-trip fidelity. */
  extra: Record<string, string>
}

export interface BankListResult {
  banks: BankEntry[]
}

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a `<BankList>` XML string. */
export function readBankList(xml: string): BankListResult {
  const banks: BankEntry[] = []
  // Self-closing <Bank .../> elements
  const re = /<Bank((?:\s[^>]*?)?)\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1] ?? '')
    const name = attrs['Name'] ?? ''
    const playerRaw = attrs['Player']
    const bank: BankEntry = {
      name,
      extra: {},
    }
    if (playerRaw !== undefined) bank.player = Number(playerRaw)
    // collect any unknown attrs
    for (const [k, v] of Object.entries(attrs)) {
      if (k !== 'Name' && k !== 'Player') bank.extra[k] = v
    }
    banks.push(bank)
  }
  return { banks }
}

/** Serialize a `BankListResult` back to XML. */
export function writeBankList(data: BankListResult): string {
  let out = `<?xml version="1.0" encoding="utf-8"?>\n<BankList>\n`
  for (const b of data.banks) {
    let tag = `    <Bank Name="${xmlEscape(b.name)}"`
    if (b.player !== undefined) tag += ` Player="${b.player}"`
    for (const [k, v] of Object.entries(b.extra)) {
      tag += ` ${k}="${xmlEscape(v)}"`
    }
    out += `${tag}/>\n`
  }
  out += `</BankList>\n`
  return out
}
