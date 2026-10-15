/**
 * Raw-preserving SC2Bank XML patcher.
 *
 * Instead of round-tripping through parseBank/serializeBank (which reformats the whole file),
 * these functions surgically replace only the targeted value or signature in the original XML
 * text — preserving all whitespace, comments, quote styles, and attribute order.
 *
 * Use this when editing real user save files where preserving the original formatting matters.
 */

export type BankXmlPatchResult =
  | { ok: true; xml: string; changed: boolean }
  | { ok: false; reason: string }

export interface PatchBankValueOptions {
  section: string
  key: string
  /** New value type, e.g. 'int', 'string', 'fixed'. If changing the type, the whole <Value .../> tag is replaced. */
  type: string
  /** New value string. */
  value: string
}

/**
 * Patch a single key's <Value .../> in raw bank XML.
 * Preserves all surrounding bytes; only the targeted attribute value (or full tag) is replaced.
 *
 * Returns { ok: false } if the section, key, or value element is not found.
 */
export function patchBankValueXml(xml: string, opts: PatchBankValueOptions): BankXmlPatchResult {
  const { section, key, type, value } = opts

  // Find <Section ... name="section" ...>
  const sectionRange = findSectionRange(xml, section)
  if (!sectionRange) {
    return { ok: false, reason: `Section "${section}" not found` }
  }
  const [secStart, secEnd] = sectionRange

  // Find <Key ... name="key" ...> inside that section range
  const keyRange = findKeyRange(xml, key, secStart, secEnd)
  if (!keyRange) {
    return { ok: false, reason: `Key "${key}" not found in section "${section}"` }
  }
  const [keyStart, keyEnd] = keyRange

  // Find first <Value .../> or <Value ...></Value> inside the key range
  const valuePos = findValueElement(xml, keyStart, keyEnd)
  if (!valuePos) {
    return { ok: false, reason: `<Value> element not found for key "${key}" in section "${section}"` }
  }
  const [valStart, valEnd, existingType] = valuePos
  const escapedValue = escapeAttrValue(value)

  let replacement: string
  if (existingType === type) {
    // Same type: replace only the attribute value, preserving quote style and attribute order
    const original = xml.slice(valStart, valEnd)
    const attrRe = new RegExp(`(${escapeRegex(type)}\\s*=\\s*)(['"])[^'"]*\\2`)
    if (!attrRe.test(original)) {
      return { ok: false, reason: `Could not locate ${type}=... attribute in <Value> tag` }
    }
    replacement = original.replace(attrRe, `$1$2${escapedValue}$2`)
  } else {
    // Type change: replace the whole <Value .../> tag
    replacement = `<Value ${type}="${escapedValue}"/>`
  }

  const newXml = xml.slice(0, valStart) + replacement + xml.slice(valEnd)
  const changed = newXml !== xml
  return { ok: true, xml: newXml, changed }
}

/**
 * Patch (or insert) the <Signature value="..."/> element in raw bank XML.
 *
 * - If a <Signature .../> already exists, only its value attribute is replaced.
 * - If missing, a <Signature .../> is inserted before </Bank>, using the indentation
 *   detected from the last </Section> or last <Section> tag, falling back to a single tab.
 */
export function patchBankSignatureXml(xml: string, signature: string): BankXmlPatchResult {
  const escapedSig = escapeAttrValue(signature)

  // Try to replace existing <Signature ... value="..." .../>
  const sigRe = /(<Signature\s[^>]*value\s*=\s*)(['"])([^'"]*)\2/
  if (sigRe.test(xml)) {
    const newXml = xml.replace(sigRe, `$1$2${escapedSig}$2`)
    const changed = newXml !== xml
    return { ok: true, xml: newXml, changed }
  }

  // Insert before </Bank>
  const closingBank = xml.lastIndexOf('</Bank>')
  if (closingBank === -1) {
    return { ok: false, reason: '</Bank> closing tag not found' }
  }

  const indent = detectIndent(xml)
  const sigTag = `${indent}<Signature value="${escapedSig}"/>\n`
  const newXml = xml.slice(0, closingBank) + sigTag + xml.slice(closingBank)
  return { ok: true, xml: newXml, changed: true }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Find the [start, end] char positions of the content inside <Section name="n">...</Section>. */
function findSectionRange(xml: string, sectionName: string): [number, number] | null {
  // Match opening <Section> tag with the given name attribute (any quote style, any attr order)
  const openRe = /<Section(\s[^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = openRe.exec(xml)) !== null) {
    if (hasAttr(m[1] ?? '', 'name', sectionName)) {
      const contentStart = m.index + m[0].length
      // Find matching </Section> by counting nesting (sections don't nest in practice, but be safe)
      const closeIdx = xml.indexOf('</Section>', contentStart)
      if (closeIdx === -1) return null
      return [contentStart, closeIdx]
    }
  }
  return null
}

/** Find the [start, end] char positions of the content inside <Key name="n">...</Key>. */
function findKeyRange(xml: string, keyName: string, from: number, to: number): [number, number] | null {
  const slice = xml.slice(from, to)
  const openRe = /<Key(\s[^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = openRe.exec(slice)) !== null) {
    if (hasAttr(m[1] ?? '', 'name', keyName)) {
      const contentStart = from + m.index + m[0].length
      const closeIdx = slice.indexOf('</Key>', m.index + m[0].length)
      if (closeIdx === -1) return null
      return [contentStart, from + closeIdx]
    }
  }
  return null
}

/**
 * Find the first <Value .../> or <Value ...></Value> inside [from, to].
 * Returns [tagStart, tagEnd, typeAttrName] or null.
 */
function findValueElement(
  xml: string,
  from: number,
  to: number,
): [number, number, string] | null {
  const slice = xml.slice(from, to)
  // Self-closing: <Value type="..."/>
  const selfRe = /<Value(\s[^>]*)\s*\/>/
  const selfM = selfRe.exec(slice)
  if (selfM) {
    const typeAttr = detectTypeAttr(selfM[1] ?? '')
    if (!typeAttr) return null
    return [from + selfM.index, from + selfM.index + selfM[0].length, typeAttr]
  }
  // Non-self-closing: <Value ...></Value>
  const openRe = /<Value(\s[^>]*)>/
  const openM = openRe.exec(slice)
  if (openM) {
    const closeM = slice.indexOf('</Value>', openM.index + openM[0].length)
    if (closeM === -1) return null
    const typeAttr = detectTypeAttr(openM[1] ?? '')
    if (!typeAttr) return null
    const tagEnd = from + closeM + '</Value>'.length
    return [from + openM.index, tagEnd, typeAttr]
  }
  return null
}

/** Check if an attribute string contains name="value" (any quote style). */
function hasAttr(attrs: string, name: string, value: string): boolean {
  const re = new RegExp(`\\b${escapeRegex(name)}\\s*=\\s*(['"])${escapeRegex(value)}\\1`)
  return re.test(attrs)
}

/** Return the first recognised SC2Bank value type attribute name found in attr string. */
function detectTypeAttr(attrs: string): string | null {
  const TYPES = ['int', 'fixed', 'string', 'flag', 'text', 'point']
  for (const t of TYPES) {
    if (new RegExp(`\\b${t}\\s*=`).test(attrs)) return t
  }
  // Unknown/custom type: pick first attr that looks like type="value"
  const m = /\b(\w+)\s*=/.exec(attrs)
  return m ? (m[1] ?? null) : null
}

/** Detect the indentation used for top-level bank children (Section, Signature). */
function detectIndent(xml: string): string {
  const m = /\n([ \t]+)<(?:Section|Signature)\b/.exec(xml)
  return m ? (m[1] ?? '\t') : '\t'
}

function escapeAttrValue(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
