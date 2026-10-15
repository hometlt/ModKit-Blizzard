export interface PreloadAssetDbEntry {
  id: string
  fields: Record<string, string[]>
  order: string[]
}

export interface PreloadAssetDbSection {
  name: string
  entries: PreloadAssetDbEntry[]
}

export interface PreloadAssetDbResult {
  sections: PreloadAssetDbSection[]
}

export function readPreloadAssetDb(text: string): PreloadAssetDbResult {
  const sections: PreloadAssetDbSection[] = []
  let section: PreloadAssetDbSection | undefined
  let entry: PreloadAssetDbEntry | undefined

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line)
    if (sectionMatch) {
      section = { name: sectionMatch[1]!, entries: [] }
      sections.push(section)
      entry = undefined
      continue
    }

    const eq = line.indexOf('=')
    if (eq < 0 || !section) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'id') {
      entry = { id: value, fields: {}, order: [] }
      section.entries.push(entry)
      continue
    }
    if (!entry) continue
    entry.fields[key] = value ? value.split(',').map(part => part.trim()).filter(Boolean) : []
    if (!entry.order.includes(key)) entry.order.push(key)
  }

  return { sections }
}

export function writePreloadAssetDb(data: PreloadAssetDbResult): string {
  const lines: string[] = []
  for (const section of data.sections) {
    if (lines.length > 0) lines.push('')
    lines.push(`[${section.name}]`)
    for (const entry of section.entries) {
      lines.push(`id=${entry.id}`)
      for (const key of entry.order) lines.push(`${key}=${(entry.fields[key] ?? []).join(',')}`)
      for (const key of Object.keys(entry.fields).sort()) {
        if (entry.order.includes(key)) continue
        lines.push(`${key}=${entry.fields[key]!.join(',')}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

export function resolvePreloadAssetPaths(entry: PreloadAssetDbEntry): string[] {
  const assets = entry.fields['asset'] ?? []
  const path = entry.fields['path']?.[0]
  if (!path) return assets.map(value => value.replace(/\\/g, '/'))

  const normalized = path.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  const dot = normalized.lastIndexOf('.')
  const prefix = slash >= 0 ? normalized.slice(0, slash + 1) : ''
  const suffix = dot > slash ? normalized.slice(dot) : ''
  return assets.map(asset => `${prefix}${asset}${suffix}`)
}

export function preloadAssetDbEntries(data: PreloadAssetDbResult): PreloadAssetDbEntry[] {
  return data.sections.flatMap(section => section.entries)
}
