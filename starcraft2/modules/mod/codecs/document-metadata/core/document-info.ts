import { decodeXmlEntities, encodeXmlAttribute } from '@modkit/codec-kit'

export interface DocumentInfoNode {
  name: string
  values: string[]
  children: DocumentInfoNode[]
}

export interface DocumentInfoData {
  root: DocumentInfoNode
}

export function parseDocumentInfo(xml: string): DocumentInfoData {
  const stack: DocumentInfoNode[] = []
  let root: DocumentInfoNode | undefined
  const re = /<\s*(\/?)([A-Za-z_][A-Za-z0-9_]*)\s*>|([^<]+)/g
  let match: RegExpExecArray | null

  while ((match = re.exec(xml)) !== null) {
    if (match[3] !== undefined) {
      const text = decodeXmlEntities(match[3].trim())
      if (text && stack.at(-1)?.name === 'Value') stack.at(-1)!.values.push(text)
      continue
    }

    const closing = match[1] === '/'
    const name = match[2]!
    if (!closing) {
      const node: DocumentInfoNode = { name, values: [], children: [] }
      stack.at(-1)?.children.push(node)
      stack.push(node)
      if (!root) root = node
    } else {
      const current = stack.pop()
      if (!current || current.name !== name) throw new Error(`DocumentInfo XML tag mismatch: expected </${current?.name ?? 'none'}>, got </${name}>`)
    }
  }

  if (!root || root.name !== 'DocInfo') throw new Error('DocumentInfo is missing DocInfo root')
  if (stack.length > 0) throw new Error(`DocumentInfo XML has unclosed tag <${stack.at(-1)!.name}>`)
  return { root }
}

export function writeDocumentInfo(data: DocumentInfoData): string {
  if (data.root.name !== 'DocInfo') throw new Error('DocumentInfo root must be DocInfo')
  return `<?xml version="1.0" encoding="utf-8"?>\n${writeNode(data.root, 0)}`
}

export function documentInfoValues(data: DocumentInfoData, path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  let nodes = [data.root]
  for (const part of parts) nodes = nodes.flatMap(node => node.children.filter(child => child.name === part))
  return nodes.flatMap(node => node.name === 'Value' ? node.values : node.children.filter(child => child.name === 'Value').flatMap(child => child.values))
}

export function documentInfoDependencies(data: DocumentInfoData): string[] {
  return documentInfoValues(data, 'Dependencies')
}

export function documentInfoPreloads(data: DocumentInfoData): string[] {
  return documentInfoValues(data, 'Preload')
}

function writeNode(node: DocumentInfoNode, depth: number): string {
  const indent = '    '.repeat(depth)
  if (node.name === 'Value') return `${indent}<Value>${encodeXmlAttribute(node.values.join(''))}</Value>\n`
  let out = `${indent}<${node.name}>\n`
  for (const value of node.values) out += `${indent}    <Value>${encodeXmlAttribute(value)}</Value>\n`
  for (const child of node.children) out += writeNode(child, depth + 1)
  out += `${indent}</${node.name}>\n`
  return out
}


