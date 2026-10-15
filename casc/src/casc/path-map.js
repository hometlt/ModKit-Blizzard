function isReadonlyMap(value) {
  return typeof value === 'object' && value !== null && typeof value.entries === 'function'
}
export function normalizeCascPath(path) {
  return path
    .toLowerCase()
    .replace(/[/:\\]+/g, '\\')
    .replace(/^\\+|\\+$/g, '')
}
export function normalizeCascPrefix(prefix) {
  return normalizeCascPath(prefix)
}
export function createCascPathMap(input) {
  const entries = isReadonlyMap(input) || Array.isArray(input) ? input : Object.entries(input)
  const out = new Map()
  for (const [path, fileDataId] of entries) {
    if (!Number.isInteger(fileDataId) || fileDataId < 0)
      throw new Error(`Invalid CASC file-data-id for '${path}'`)
    out.set(normalizeCascPath(path), fileDataId)
  }
  return out
}
export function createCascPathAliases(input) {
  const entries = isReadonlyMap(input) || Array.isArray(input) ? input : Object.entries(input)
  const out = new Map()
  for (const [source, target] of entries)
    out.set(normalizeCascPath(source), normalizeCascPath(target))
  return out
}
export function parseCascListfile(text) {
  const entries = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const parts = splitListfileLine(line)
    if (parts.length < 2) continue
    const first = parts[0]
    const last = parts[parts.length - 1]
    if (/^\d+$/.test(first)) {
      const firstId = Number.parseInt(first, 10)
      entries.push([parts.slice(1).join(';'), firstId])
    } else if (/^\d+$/.test(last)) {
      const lastId = Number.parseInt(last, 10)
      entries.push([parts.slice(0, -1).join(';'), lastId])
    }
  }
  return createCascPathMap(entries)
}
function splitListfileLine(line) {
  const delimiter = [';', ',', '\t'].find(candidate => line.includes(candidate))
  if (!delimiter) return [line]
  return line
    .split(delimiter)
    .map(part => trimCsvField(part))
    .filter(Boolean)
}
function trimCsvField(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"').trim()
  }
  return trimmed
}
