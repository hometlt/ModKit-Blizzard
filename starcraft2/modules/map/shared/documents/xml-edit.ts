function escapedAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/** Replace named attributes on the first matching element while preserving every other byte. */
export function replaceXmlElementAttributes(xml: string, element: string, values: Readonly<Record<string, string>>): string {
  const pattern = new RegExp(`<${element}\\b[^>]*>`, 'u')
  const match = pattern.exec(xml)
  if (match === null) throw new RangeError(`XML has no <${element}> element`)
  let tag = match[0]
  for (const [name, value] of Object.entries(values)) {
    const attribute = new RegExp(`(\\s${name}\\s*=\\s*")[^"]*(")`, 'u')
    if (!attribute.test(tag)) throw new RangeError(`<${element}> has no ${name} attribute`)
    tag = tag.replace(attribute, `$1${escapedAttribute(value)}$2`)
  }
  return xml.slice(0, match.index) + tag + xml.slice(match.index + match[0].length)
}
