/** Minimal XML node type — used only for toXML() serialization methods. */
export interface JSONXMLNode {
  tag?: string
  value?: string | JSONXMLNodeValue[]
  attributes?: Record<string, string>
  children?: JSONXMLNode[]
}

export type JSONXMLNodeValue = JSONXMLNode | string

export function isValidNumber(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  if (typeof value === 'number') return isFinite(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return false
    const n = Number(trimmed)
    return !isNaN(n) && isFinite(n)
  }
  return false
}

export function isInteger(value: number | string): boolean {
  if (typeof value === 'number') return Number.isInteger(value)
  const trimmed = value.trim()
  if (trimmed === '') return false
  const n = Number(trimmed)
  return !isNaN(n) && Number.isInteger(n)
}

export function isNumeric(str: string): boolean {
  if (typeof str !== 'string') return false
  const trimmed = str.trim()
  if (trimmed === '') return false
  return !isNaN(Number(trimmed)) && isFinite(Number(trimmed))
}
